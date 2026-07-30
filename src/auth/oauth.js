/**
 * OAuth 2.1 인증 서버 (다중 사용자).
 *
 * hosub-mcp 의 OAuth 와 **코드를 공유하지 않는다.** 별도 프로세스·별도 DB·별도 issuer 로,
 * 한쪽의 토큰이 다른 쪽에서 통하지 않는다. 설계상 차이는 세 가지다:
 *
 *   1. 단일 비밀번호가 아니라 **사용자 계정**이 승인 주체다. 토큰이 user_id 에 묶인다.
 *   2. Bearer 검증이 매 요청 users.status 를 조인 확인한다 → 계정을 비활성화하면
 *      이미 발급된 토큰이 그 즉시 전부 죽는다.
 *   3. RFC 8707 resource 파라미터를 **저장만 하지 않고 검증**한다 — 우리 MCP
 *      엔드포인트가 아닌 audience 로는 코드를 발급하지 않는다.
 *
 * 구현하는 스펙:
 *   RFC 9728 (Protected Resource Metadata) · RFC 8414 (AS Metadata)
 *   RFC 7591 (Dynamic Client Registration) · RFC 7636 (PKCE, S256 강제)
 *   RFC 7009 (Token Revocation) · RFC 8707 (Resource Indicators)
 */

import crypto from 'node:crypto';
import express from 'express';

import { sha256 } from './db.js';
import * as session from './session.js';
import { allTools } from '../tools/registry.js';
import {
  loginPage,
  signupPage,
  pendingPage,
  consentPage,
  authorizeLoginPage,
  accountPage,
  adminPage,
  errorPage,
  escapeHtml,
} from '../web/pages.js';

const CODE_TTL = 300; // 인가 코드 5분
// hosub 는 액세스 토큰을 30일로 두지만, 다중 사용자에서는 노출 창을 좁히는 편이 낫다.
// refresh 로 조용히 갱신되므로 사용자가 체감하는 차이는 없다.
const ACCESS_TTL = 7 * 24 * 3600;
const REFRESH_TTL = 365 * 24 * 3600;

const OAUTH_PARAMS = [
  'response_type',
  'client_id',
  'redirect_uri',
  'code_challenge',
  'code_challenge_method',
  'state',
  'scope',
  'resource',
];

export function verifyPkceS256(verifier, challenge) {
  const computed = crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
  const a = Buffer.from(computed);
  const b = Buffer.from(String(challenge || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * 공개 base URL 을 정한다. 명시 설정이 우선이고, 없으면 프록시 헤더에서 유추한다.
 * 서버는 Caddy 뒤에서 평문 HTTP 로 뜨므로 스킴은 X-Forwarded-Proto 를 신뢰한다.
 */
export function composeBaseUrl(req, configured) {
  if (configured) return configured.replace(/\/+$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

function redirectWith(uri, params) {
  const sep = uri.includes('?') ? '&' : '?';
  return `${uri}${sep}${new URLSearchParams(params).toString()}`;
}

function hiddenFields(values) {
  return OAUTH_PARAMS.filter((k) => values[k])
    .map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(values[k])}">`)
    .join('\n    ');
}

function tokenError(res, error, description, status = 400) {
  return res
    .status(status)
    .set('Cache-Control', 'no-store')
    .json({ error, error_description: description });
}

// ---------------------------------------------------------------------------

export class OAuthStore {
  constructor(db) {
    this.db = db;
  }

  registerClient(redirectUris, clientName) {
    const clientId = 'c_' + crypto.randomBytes(18).toString('base64url');
    this.db
      .prepare(
        'INSERT INTO oauth_clients (client_id, redirect_uris, client_name, created_at) VALUES (?,?,?,?)',
      )
      .run(clientId, JSON.stringify(redirectUris), String(clientName || '').slice(0, 120), Date.now() / 1000);
    return clientId;
  }

  getClient(clientId) {
    const row = this.db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(clientId);
    if (!row) return null;
    return { ...row, redirect_uris: JSON.parse(row.redirect_uris) };
  }

  clientCount() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM oauth_clients').get().n;
  }

  createCode({ clientId, userId, redirectUri, codeChallenge, scope, resource }) {
    const code = crypto.randomBytes(24).toString('base64url');
    this.db
      .prepare(
        `INSERT INTO oauth_codes
           (code, client_id, user_id, redirect_uri, code_challenge, scope, resource, expires_at, used)
         VALUES (?,?,?,?,?,?,?,?,0)`,
      )
      .run(code, clientId, userId, redirectUri, codeChallenge, scope ?? null, resource ?? null,
           Date.now() / 1000 + CODE_TTL);
    return code;
  }

  /**
   * 인가 코드를 1회용으로 소비한다.
   *
   * 이미 쓰인 코드를 다시 들고 오면 그 코드로 발급된 토큰을 전부 폐기한다 —
   * 코드 재사용은 정상 클라이언트에서 일어나지 않으며 탈취 신호로 본다(OAuth 2.1 권고).
   */
  consumeCode(code) {
    const row = this.db.prepare('SELECT * FROM oauth_codes WHERE code = ?').get(code);
    if (!row) return null;

    if (row.used) {
      this.db
        .prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE user_id = ? AND client_id = ? AND revoked_at IS NULL')
        .run(Date.now() / 1000, row.user_id, row.client_id);
      return null;
    }
    if (row.expires_at < Date.now() / 1000) return null;

    this.db.prepare('UPDATE oauth_codes SET used = 1 WHERE code = ?').run(code);
    return row;
  }

  issueTokens(userId, clientId, scope) {
    const access = 'at_' + crypto.randomBytes(32).toString('base64url');
    const refresh = 'rt_' + crypto.randomBytes(32).toString('base64url');
    const now = Date.now() / 1000;
    const insert = this.db.prepare(
      `INSERT INTO oauth_tokens (token_hash, user_id, client_id, kind, scope, expires_at, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    );
    insert.run(sha256(access), userId, clientId, 'access', scope ?? null, now + ACCESS_TTL, now);
    insert.run(sha256(refresh), userId, clientId, 'refresh', scope ?? null, now + REFRESH_TTL, now);

    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL,
      refresh_token: refresh,
      scope: scope || 'mcp',
    };
  }

  /**
   * 액세스 토큰을 검증하고 사용자를 돌려준다.
   *
   * users 를 조인해 status='active' 를 확인하는 것이 핵심이다. 관리자가 계정을
   * 비활성화하면 이미 나가 있는 토큰까지 즉시 무력화된다.
   */
  verifyAccess(token) {
    return (
      this.db
        .prepare(
          `SELECT t.user_id, t.client_id, t.scope, u.email, u.display_name, u.role, u.status
             FROM oauth_tokens t
             JOIN users u ON u.user_id = t.user_id
            WHERE t.token_hash = ? AND t.kind = 'access'
              AND t.revoked_at IS NULL
              AND (t.expires_at IS NULL OR t.expires_at > ?)
              AND u.status = 'active'`,
        )
        .get(sha256(token), Date.now() / 1000) || null
    );
  }

  /** refresh 토큰 회전 — 쓴 refresh 는 폐기하고 새 쌍을 낸다(OAuth 2.1 권고). */
  exchangeRefresh(refreshToken) {
    const hash = sha256(refreshToken);
    const row = this.db
      .prepare(
        `SELECT t.user_id, t.client_id, t.scope
           FROM oauth_tokens t
           JOIN users u ON u.user_id = t.user_id
          WHERE t.token_hash = ? AND t.kind = 'refresh'
            AND t.revoked_at IS NULL
            AND (t.expires_at IS NULL OR t.expires_at > ?)
            AND u.status = 'active'`,
      )
      .get(hash, Date.now() / 1000);
    if (!row) return null;

    this.db.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE token_hash = ?').run(Date.now() / 1000, hash);
    return this.issueTokens(row.user_id, row.client_id, row.scope);
  }

  revokeToken(token) {
    const n = this.db
      .prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
      .run(Date.now() / 1000, sha256(token)).changes;
    return n > 0;
  }

  revokeClientForUser(userId, clientId) {
    return this.db
      .prepare(
        'UPDATE oauth_tokens SET revoked_at = ? WHERE user_id = ? AND client_id = ? AND revoked_at IS NULL',
      )
      .run(Date.now() / 1000, userId, clientId).changes;
  }

  /** 사용자의 활성 연결(앱) 목록 — 계정 화면에서 개별 해제에 쓴다. */
  connectionsFor(userId) {
    return this.db
      .prepare(
        `SELECT t.client_id, c.client_name, MIN(t.created_at) AS created_at, MAX(t.expires_at) AS expires_at
           FROM oauth_tokens t
           LEFT JOIN oauth_clients c ON c.client_id = t.client_id
          WHERE t.user_id = ? AND t.kind = 'access' AND t.revoked_at IS NULL AND t.expires_at > ?
          GROUP BY t.client_id
          ORDER BY created_at DESC`,
      )
      .all(userId, Date.now() / 1000);
  }

  tokenCounts() {
    const now = Date.now() / 1000;
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN kind='access'  AND revoked_at IS NULL AND expires_at > ? THEN 1 ELSE 0 END) AS access,
           SUM(CASE WHEN kind='refresh' AND revoked_at IS NULL AND expires_at > ? THEN 1 ELSE 0 END) AS refresh
         FROM oauth_tokens`,
      )
      .get(now, now);
    return { access: row.access || 0, refresh: row.refresh || 0 };
  }
}

// ---------------------------------------------------------------------------

/**
 * OAuth·계정 라우터를 만든다.
 *
 * @param {object} opts
 * @param {OAuthStore} opts.store
 * @param {import('./users.js').UserStore} opts.users
 * @param {string} opts.basePath      공개 경로 프리픽스 (예: '/jw')
 * @param {string|null} opts.publicUrl 명시 공개 URL (없으면 프록시 헤더에서 유추)
 * @param {string} opts.sessionSecret
 * @param {boolean} opts.secureCookies
 */
export function buildAuthRouter({ store, users, basePath, publicUrl, sessionSecret, secureCookies = true }) {
  const router = express.Router();
  const form = express.urlencoded({ extended: false });
  const json = express.json({ limit: '64kb' });

  const base = (req) => composeBaseUrl(req, publicUrl);
  /** issuer = 공개 URL + basePath. 경로 분리 배치에서 hosub issuer 와 구별되는 지점. */
  const issuer = (req) => base(req) + basePath;
  const resourceUrl = (req) => issuer(req) + '/mcp';
  const cookieOpts = { basePath, secure: secureCookies };

  const currentUser = (req) => {
    const uid = session.verify(session.readCookie(req), sessionSecret);
    return uid ? users.findById(uid) : null;
  };

  // --- 메타데이터 ---------------------------------------------------------

  const asMetadata = (req, res) =>
    res.json({
      issuer: issuer(req),
      authorization_endpoint: issuer(req) + '/authorize',
      token_endpoint: issuer(req) + '/token',
      registration_endpoint: issuer(req) + '/register',
      revocation_endpoint: issuer(req) + '/revoke',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp'],
      service_documentation: issuer(req) + '/account',
    });

  const prMetadata = (req, res) =>
    res.json({
      resource: resourceUrl(req),
      authorization_servers: [issuer(req)],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp'],
      resource_documentation: issuer(req) + '/account',
    });

  // 경로 뒤에 붙는 폴백 형태. basePath 라우팅에 자연히 포함되므로 Caddy 설정이 필요 없다.
  // 정본(RFC 8414/9728) 경로는 루트에 있어야 해서 http-server.js 가 따로 마운트한다.
  router.get('/.well-known/oauth-authorization-server', asMetadata);
  router.get('/.well-known/openid-configuration', asMetadata);
  router.get('/.well-known/oauth-protected-resource', prMetadata);

  // --- 동적 클라이언트 등록 (RFC 7591) -------------------------------------

  router.post('/register', json, (req, res) => {
    const uris = req.body?.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0) {
      return res
        .status(400)
        .json({ error: 'invalid_client_metadata', error_description: 'redirect_uris 가 필요합니다.' });
    }
    // 열린 등록 엔드포인트다(스펙상 커넥터가 사전 등록 없이 붙으려면 필요). 다만
    // redirect_uri 는 https 나 localhost 로 제한해, 등록된 클라이언트가 인가 코드를
    // 평문 외부 주소로 흘리지 못하게 한다.
    for (const uri of uris) {
      let parsed;
      try {
        parsed = new URL(uri);
      } catch {
        return res.status(400).json({ error: 'invalid_redirect_uri', error_description: `URL 형식 오류: ${uri}` });
      }
      const isLocal = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
      if (parsed.protocol !== 'https:' && !isLocal) {
        return res
          .status(400)
          .json({ error: 'invalid_redirect_uri', error_description: 'redirect_uri 는 https 또는 localhost 여야 합니다.' });
      }
    }

    const clientId = store.registerClient(uris, req.body?.client_name);
    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: uris,
      client_name: req.body?.client_name || '',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: req.body?.scope || 'mcp',
    });
  });

  // --- 인가 (/authorize) --------------------------------------------------

  /**
   * 요청 파라미터를 검증한다.
   *
   * redirect_uri 가 유효하기 전까지는 절대 리다이렉트로 오류를 돌려보내지 않는다
   * (열린 리다이렉터가 되어버린다). 그 단계의 오류는 화면에 직접 그린다.
   */
  function validateAuthorize(v, req) {
    if (v.response_type !== 'code') return { ok: false, msg: 'response_type 은 code 여야 합니다.' };
    if (!v.client_id || !v.redirect_uri) return { ok: false, msg: 'client_id 와 redirect_uri 가 필요합니다.' };

    const client = store.getClient(v.client_id);
    if (!client) return { ok: false, msg: '등록되지 않은 클라이언트입니다.' };
    if (!client.redirect_uris.includes(v.redirect_uri)) return { ok: false, msg: 'redirect_uri 가 일치하지 않습니다.' };
    if (!v.code_challenge || v.code_challenge_method !== 'S256') {
      return { ok: false, msg: 'PKCE(S256)가 필요합니다.' };
    }
    // RFC 8707: 넘어온 audience 가 우리 MCP 엔드포인트인지 확인한다. hosub 구현은
    // 이 값을 저장만 하지만, 여기서는 다른 리소스용 코드 발급을 막는다.
    if (v.resource) {
      const want = resourceUrl(req).replace(/\/+$/, '');
      const got = String(v.resource).replace(/\/+$/, '');
      if (got !== want) return { ok: false, msg: `resource 가 이 서버(${want})와 일치하지 않습니다.` };
    }
    return { ok: true, client };
  }

  router.get('/authorize', (req, res) => {
    const v = Object.fromEntries(OAUTH_PARAMS.map((k) => [k, req.query[k] ?? null]));
    const check = validateAuthorize(v, req);
    if (!check.ok) return res.status(400).type('html').send(errorPage('연결할 수 없습니다', check.msg, { base: basePath }));

    const user = currentUser(req);
    const hidden = hiddenFields(v);
    if (!user) {
      return res.type('html').send(authorizeLoginPage({ base: basePath, clientName: check.client.client_name, hidden }));
    }
    if (user.status !== 'active') {
      return res.status(403).type('html').send(pendingPage({ base: basePath, user }));
    }
    return res
      .type('html')
      .send(consentPage({ base: basePath, user, clientName: check.client.client_name, hidden, toolCount: allTools.length }));
  });

  router.post('/authorize', form, async (req, res) => {
    const v = Object.fromEntries(OAUTH_PARAMS.map((k) => [k, req.body[k] ?? null]));
    const check = validateAuthorize(v, req);
    if (!check.ok) return res.status(400).type('html').send(errorPage('연결할 수 없습니다', check.msg, { base: basePath }));

    const hidden = hiddenFields(v);
    const decision = req.body.decision;

    // 여기서부터는 redirect_uri 가 검증됐으므로 오류를 리다이렉트로 돌려보내도 안전하다.
    if (decision === 'deny') {
      const params = { error: 'access_denied', error_description: '사용자가 연결을 거부했습니다.' };
      if (v.state) params.state = v.state;
      return res.redirect(302, redirectWith(v.redirect_uri, params));
    }

    let user = currentUser(req);

    if (decision === 'login') {
      user = await users.verifyPassword(req.body.email, req.body.password);
      if (!user) {
        return res.status(401).type('html').send(
          authorizeLoginPage({
            base: basePath,
            clientName: check.client.client_name,
            hidden,
            error: '이메일 또는 비밀번호가 올바르지 않습니다.',
          }),
        );
      }
      if (user.status !== 'active') {
        return res.status(403).type('html').send(pendingPage({ base: basePath, user }));
      }
      users.touchLogin(user.user_id);
      session.setCookie(res, user.user_id, sessionSecret, cookieOpts);
      // 로그인만 끝났을 뿐 아직 동의하지 않았다 — 동의 화면을 한 번 더 보여준다.
      return res
        .type('html')
        .send(consentPage({ base: basePath, user, clientName: check.client.client_name, hidden, toolCount: allTools.length }));
    }

    if (!user) {
      return res
        .status(401)
        .type('html')
        .send(authorizeLoginPage({ base: basePath, clientName: check.client.client_name, hidden, error: '세션이 만료되었습니다. 다시 로그인해 주세요.' }));
    }
    if (user.status !== 'active') {
      return res.status(403).type('html').send(pendingPage({ base: basePath, user }));
    }

    const code = store.createCode({
      clientId: v.client_id,
      userId: user.user_id,
      redirectUri: v.redirect_uri,
      codeChallenge: v.code_challenge,
      scope: v.scope,
      resource: v.resource,
    });
    const params = { code };
    if (v.state) params.state = v.state;
    return res.redirect(302, redirectWith(v.redirect_uri, params));
  });

  // --- 토큰 (/token, /revoke) ---------------------------------------------

  router.post('/token', form, (req, res) => {
    const grantType = req.body.grant_type;

    if (grantType === 'authorization_code') {
      const { code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier } = req.body;
      if (!code || !redirectUri || !verifier) return tokenError(res, 'invalid_request', '필수 파라미터가 없습니다.');

      const row = store.consumeCode(code);
      if (!row) return tokenError(res, 'invalid_grant', '인가 코드가 유효하지 않거나 만료되었습니다.');
      if (clientId && row.client_id !== clientId) return tokenError(res, 'invalid_grant', 'client_id 가 일치하지 않습니다.');
      if (row.redirect_uri !== redirectUri) return tokenError(res, 'invalid_grant', 'redirect_uri 가 일치하지 않습니다.');
      if (!verifyPkceS256(verifier, row.code_challenge)) return tokenError(res, 'invalid_grant', 'PKCE 검증에 실패했습니다.');

      // 코드 발급과 교환 사이에 계정이 비활성화됐을 수 있다.
      const user = users.findById(row.user_id);
      if (!user || user.status !== 'active') return tokenError(res, 'invalid_grant', '계정이 활성 상태가 아닙니다.');

      return res
        .set('Cache-Control', 'no-store')
        .json(store.issueTokens(row.user_id, row.client_id, row.scope));
    }

    if (grantType === 'refresh_token') {
      const token = req.body.refresh_token;
      if (!token) return tokenError(res, 'invalid_request', 'refresh_token 이 없습니다.');
      const tokens = store.exchangeRefresh(token);
      if (!tokens) return tokenError(res, 'invalid_grant', 'refresh_token 이 유효하지 않거나 만료되었습니다.');
      return res.set('Cache-Control', 'no-store').json(tokens);
    }

    return tokenError(res, 'unsupported_grant_type', String(grantType ?? ''));
  });

  // RFC 7009: 성공·실패를 구분하지 않고 항상 200 을 준다(토큰 존재 여부 탐색 방지).
  router.post('/revoke', form, (req, res) => {
    if (req.body.token) store.revokeToken(req.body.token);
    res.set('Cache-Control', 'no-store').status(200).end();
  });

  // --- 계정 --------------------------------------------------------------

  router.get('/login', (req, res) =>
    res.type('html').send(loginPage({ base: basePath, notice: req.query.signup ? '가입이 완료되었습니다. 로그인하세요.' : '' })),
  );

  router.post('/login', form, async (req, res) => {
    const user = await users.verifyPassword(req.body.email, req.body.password);
    if (!user) {
      return res
        .status(401)
        .type('html')
        .send(loginPage({ base: basePath, error: '이메일 또는 비밀번호가 올바르지 않습니다.' }));
    }
    users.touchLogin(user.user_id);
    session.setCookie(res, user.user_id, sessionSecret, cookieOpts);
    if (user.status !== 'active') return res.type('html').send(pendingPage({ base: basePath, user }));
    return res.redirect(302, basePath + '/account');
  });

  router.get('/signup', (req, res) =>
    res.type('html').send(signupPage({ base: basePath, inviteEnabled: Boolean(users.inviteCode) })),
  );

  router.post('/signup', form, async (req, res) => {
    const result = await users.create({
      email: req.body.email,
      password: req.body.password,
      displayName: req.body.display_name,
      inviteCode: req.body.invite_code,
    });
    if (!result.ok) {
      return res
        .status(400)
        .type('html')
        .send(signupPage({ base: basePath, error: result.error, inviteEnabled: Boolean(users.inviteCode) }));
    }
    session.setCookie(res, result.user.user_id, sessionSecret, cookieOpts);
    if (result.user.status !== 'active') {
      return res.type('html').send(pendingPage({ base: basePath, user: result.user }));
    }
    return res.redirect(302, basePath + '/account');
  });

  router.get('/logout', (req, res) => {
    session.clearCookie(res, cookieOpts);
    res.redirect(302, basePath + '/login');
  });

  router.get('/account', (req, res) => {
    const user = currentUser(req);
    if (!user) return res.redirect(302, basePath + '/login');
    if (user.status !== 'active') return res.type('html').send(pendingPage({ base: basePath, user }));
    return res.type('html').send(
      accountPage({
        base: basePath,
        user,
        connections: store.connectionsFor(user.user_id),
        notice: req.query.revoked ? '연결을 해제했습니다.' : '',
      }),
    );
  });

  router.post('/account/revoke', form, (req, res) => {
    const user = currentUser(req);
    if (!user) return res.redirect(302, basePath + '/login');
    store.revokeClientForUser(user.user_id, req.body.client_id);
    res.redirect(302, basePath + '/account?revoked=1');
  });

  // --- 관리자 -------------------------------------------------------------

  const requireAdmin = (req, res, next) => {
    const user = currentUser(req);
    if (!user) return res.redirect(302, basePath + '/login');
    if (user.role !== 'admin' || user.status !== 'active') {
      return res.status(403).type('html').send(errorPage('접근 불가', '관리자만 볼 수 있는 화면입니다.', { base: basePath }));
    }
    req.jwUser = user;
    next();
  };

  router.get('/admin', requireAdmin, (req, res) =>
    res.type('html').send(adminPage({ base: basePath, users: users.list(), notice: req.query.done ? '변경했습니다.' : '' })),
  );

  router.post('/admin/status', requireAdmin, form, (req, res) => {
    const result = users.setStatus(req.body.user_id, req.body.status);
    if (!result.ok) {
      return res.status(400).type('html').send(errorPage('변경할 수 없습니다', result.error, { base: basePath }));
    }
    res.redirect(302, basePath + '/admin?done=1');
  });

  return { router, asMetadata, prMetadata, resourceUrl, issuer };
}

export { ACCESS_TTL, REFRESH_TTL, CODE_TTL, OAUTH_PARAMS };
