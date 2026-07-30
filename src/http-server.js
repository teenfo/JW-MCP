#!/usr/bin/env node
/**
 * jw-mcp HTTP 서버 — MCP(Streamable HTTP) + 자체 OAuth 2.1 + 대시보드 API.
 *
 * ## 배치
 *
 *   [claude.ai 커넥터]
 *        │ https://hosub.duckdns.org/jw/mcp   (OAuth 2.1 Bearer)
 *   [Caddy] ── /jw/... 와 /.well-known/oauth-... /jw ──▶ 127.0.0.1:8604 (이 프로세스)
 *        └──── 그 외 ──▶ 기존 hosub 서비스 (:8700 / :8701)
 *
 *   [hosub 대시보드 :8701] ── http://127.0.0.1:8604/api/dash/* ──▶ 이 프로세스
 *        (Caddy 가 라우팅하지 않으므로 공인 인터넷에서는 닿지 않는다)
 *
 * ## 경로 분리에서 신경 쓴 것
 *
 * hosub 과 호스트를 공유하므로 OAuth 디스커버리 문서가 서로 섞이면 안 된다. issuer 를
 * `https://<host>/jw` 로 잡고, RFC 8414/9728 이 정한 **정본 경로**를 루트에 마운트한다:
 *
 *   /.well-known/oauth-authorization-server/jw       → 이 서버
 *   /.well-known/oauth-protected-resource/jw/mcp     → 이 서버
 *   /.well-known/oauth-authorization-server          → (그대로 hosub 것)
 *
 * 그리고 /jw/mcp 의 401 에 WWW-Authenticate 로 정본 URL 을 명시해, 클라이언트가
 * 루트 폴백(= hosub AS)으로 새지 않게 한다.
 */

import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { allTools, callTool } from './tools/registry.js';
import { openDb, pruneExpired } from './auth/db.js';
import { UserStore } from './auth/users.js';
import { OAuthStore, buildAuthRouter, composeBaseUrl } from './auth/oauth.js';
import { DashStats, buildDashRouter } from './dash/api.js';

const VERSION = '2.0.0';

// --- 설정 -------------------------------------------------------------------

function required(name, { minLen = 0 } = {}) {
  const value = (process.env[name] || '').trim();
  if (!value) throw new Error(`환경변수 ${name} 가 설정되지 않았습니다.`);
  if (minLen && value.length < minLen) {
    throw new Error(`환경변수 ${name} 는 최소 ${minLen}자 이상이어야 합니다.`);
  }
  return value;
}

const config = {
  host: process.env.JW_HOST || '127.0.0.1',
  port: parseInt(process.env.JW_PORT || '8604', 10),
  // 프리픽스를 유지한 채 프록시된다(Caddy 의 handle, handle_path 아님).
  basePath: (process.env.JW_BASE_PATH ?? '/jw').replace(/\/+$/, ''),
  publicUrl: (process.env.JW_PUBLIC_URL || '').trim() || null,
  dbPath: process.env.JW_DB || 'data/jw.db',
  sessionSecret: required('JW_SESSION_SECRET', { minLen: 32 }),
  internalToken: (process.env.JW_INTERNAL_TOKEN || '').trim(),
  adminEmails: (process.env.JW_ADMIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  inviteCode: (process.env.JW_INVITE_CODE || '').trim(),
  // 로컬 평문 개발에서는 Secure 쿠키가 전송되지 않아 로그인이 안 된다.
  secureCookies: (process.env.JW_SECURE_COOKIES || 'true').toLowerCase() !== 'false',
};

// --- 조립 -------------------------------------------------------------------

const db = openDb(config.dbPath);
pruneExpired(db);
setInterval(() => pruneExpired(db), 6 * 3600 * 1000).unref();

const users = new UserStore(db, { adminEmails: config.adminEmails, inviteCode: config.inviteCode });
const oauth = new OAuthStore(db);
const stats = new DashStats(db, { users, oauth, version: VERSION });

const app = express();
// Caddy 뒤에 있으므로 X-Forwarded-* 를 신뢰해야 공개 URL 을 올바로 만든다.
app.set('trust proxy', true);
app.disable('x-powered-by');

const { router: authRouter, asMetadata, prMetadata, resourceUrl } = buildAuthRouter({
  store: oauth,
  users,
  basePath: config.basePath,
  publicUrl: config.publicUrl,
  sessionSecret: config.sessionSecret,
  secureCookies: config.secureCookies,
});

// --- MCP 인증 ---------------------------------------------------------------

const recordCall = db.prepare(
  `INSERT INTO tool_calls (user_id, client_id, tool, ok, duration_ms, error, created_at)
   VALUES (?,?,?,?,?,?,?)`,
);

/**
 * Bearer 인증.
 *
 * 401 에는 반드시 resource_metadata 를 실은 WWW-Authenticate 를 붙인다 (RFC 9728 §5.1,
 * MCP 인증 스펙). 이게 없으면 클라이언트가 루트 /.well-known 으로 폴백해 옆 서비스인
 * hosub 의 인증 서버를 찾아가버린다.
 */
function requireBearer(req, res, next) {
  const challenge = `Bearer resource_metadata="${composeBaseUrl(req, config.publicUrl)}/.well-known/oauth-protected-resource${config.basePath}/mcp"`;

  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) {
    return res
      .status(401)
      .set('WWW-Authenticate', challenge)
      .json({ error: 'unauthorized', error_description: 'Bearer 토큰이 필요합니다.' });
  }

  const principal = oauth.verifyAccess(match[1]);
  if (!principal) {
    return res
      .status(401)
      .set('WWW-Authenticate', `${challenge}, error="invalid_token"`)
      .json({ error: 'invalid_token', error_description: '토큰이 유효하지 않거나 만료되었거나 계정이 비활성입니다.' });
  }

  req.principal = principal;
  next();
}

/** 요청마다 새 Server 인스턴스 — 무상태 전송에 맞춘 상류의 방식을 유지한다. */
function createMcpServer(principal) {
  const server = new Server(
    { name: 'jw-mcp', version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allTools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const started = Date.now();
    let result;
    let failed = null;
    try {
      result = await callTool(request);
      if (result?.isError) {
        // 도구가 자체적으로 오류 응답을 만든 경우도 실패로 집계한다.
        failed = String(result.content?.[0]?.text || 'tool reported isError').slice(0, 300);
      }
    } catch (err) {
      failed = String(err?.message || err).slice(0, 300);
      result = { content: [{ type: 'text', text: `오류: ${failed}` }], isError: true };
    }

    // 사용량 기록은 부가 기능이다 — 여기서 실패해도 도구 응답을 잃어선 안 된다.
    // 인자 본문은 저장하지 않는다(어떤 구절을 찾아봤는지까지 남길 이유가 없다).
    try {
      recordCall.run(
        principal.user_id,
        principal.client_id,
        String(request.params?.name || 'unknown'),
        failed ? 0 : 1,
        Date.now() - started,
        failed,
        Date.now() / 1000,
      );
    } catch (err) {
      console.error('[jw-mcp] 사용량 기록 실패:', err.message);
    }

    return result;
  });

  return server;
}

// --- 라우트 -----------------------------------------------------------------

// RFC 8414 / RFC 9728 정본 경로. issuer 가 https://host/jw 이므로 메타데이터는
// 루트의 /.well-known/<타입>/jw... 에 있어야 한다 — basePath 라우터 안에 둘 수 없다.
const suffix = config.basePath.replace(/^\//, ''); // '/jw' → 'jw'
app.get(`/.well-known/oauth-authorization-server/${suffix}`, asMetadata);
app.get(`/.well-known/openid-configuration/${suffix}`, asMetadata);
app.get(`/.well-known/oauth-protected-resource/${suffix}`, prMetadata);
app.get(`/.well-known/oauth-protected-resource/${suffix}/mcp`, prMetadata);

// 대시보드용 내부 API. Caddy 가 라우팅하지 않으므로 127.0.0.1 에서만 닿는다.
if (config.internalToken) {
  app.use('/api/dash', buildDashRouter({ stats, users, internalToken: config.internalToken }));
} else {
  console.error('[jw-mcp] JW_INTERNAL_TOKEN 이 비어 있어 대시보드 API 를 마운트하지 않습니다.');
}

const jw = express.Router();

jw.get('/health', (req, res) =>
  res.json({ status: 'healthy', service: 'jw-mcp', version: VERSION, tools: allTools.length }),
);

// ⚠️ express.json() 을 /mcp 앞에 두면 안 된다. StreamableHTTPServerTransport 는 원본
//    요청 스트림을 직접 읽으므로, 미들웨어가 먼저 소비하면 "stream is not readable" 로 깨진다.
jw.post('/mcp', requireBearer, async (req, res) => {
  const server = createMcpServer(req.principal);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on('close', () => {
    try {
      transport.close?.();
      server.close?.();
    } catch (err) {
      console.error('[jw-mcp] 정리 중 오류:', err.message);
    }
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    console.error('[jw-mcp] MCP 요청 처리 실패:', err);
    if (!res.headersSent) res.status(500).json({ error: 'internal_error', error_description: err.message });
  }
});

// 무상태 모드에서는 서버가 먼저 말을 걸 수 없으므로 SSE 스트리밍을 지원하지 않는다.
jw.get('/mcp', requireBearer, (req, res) =>
  res.status(501).json({
    error: 'not_implemented',
    error_description: '무상태 모드에서는 GET(SSE)을 지원하지 않습니다. POST 를 사용하세요.',
  }),
);

jw.use(authRouter);
jw.get('/', (req, res) => res.redirect(302, config.basePath + '/account'));

app.use(config.basePath || '/', jw);

app.use((req, res) => res.status(404).json({ error: 'not_found', path: req.path }));

// --- 기동 -------------------------------------------------------------------

const server = app.listen(config.port, config.host, () => {
  const publicBase = (config.publicUrl || `http://${config.host}:${config.port}`) + config.basePath;
  console.error(`[jw-mcp] v${VERSION} · 도구 ${allTools.length}종 · 사용자 ${users.count()}명`);
  console.error(`[jw-mcp] 바인딩   : ${config.host}:${config.port}`);
  console.error(`[jw-mcp] MCP      : ${publicBase}/mcp`);
  console.error(`[jw-mcp] 계정     : ${publicBase}/login`);
  console.error(`[jw-mcp] 메타데이터: ${config.publicUrl || ''}/.well-known/oauth-protected-resource${config.basePath}/mcp`);
  console.error(`[jw-mcp] 대시보드 API: ${config.internalToken ? `http://${config.host}:${config.port}/api/dash/summary` : '(비활성)'}`);
  if (users.count() === 0) {
    console.error(`[jw-mcp] ⚠️  사용자가 없습니다 — ${publicBase}/signup 에서 첫 계정을 만드세요(자동으로 관리자가 됩니다).`);
  }
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.error(`[jw-mcp] ${signal} 수신 — 종료합니다.`);
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
