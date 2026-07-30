#!/usr/bin/env node
/**
 * OAuth 2.1 전 구간 통합 테스트.
 *
 * 실제로 서버를 띄우고 커넥터가 하는 일을 그대로 한다:
 *   가입 → (승인) → 동적 등록 → /authorize(PKCE) → /token → Bearer 로 tools/list·tools/call
 *   → refresh 회전 → 코드 재사용 차단 → 계정 비활성화 시 토큰 즉시 무효
 *
 * 마지막 항목이 이 서비스의 핵심 보안 계약이다 — 다중 사용자에서 "내보낸 사람의
 * 접근이 정말 끊기는가"를 회귀로 못 박아 둔다.
 *
 * 실행: node scripts/test-oauth-flow.js
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.TEST_PORT || 8699);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BASE = `${ORIGIN}/jw`;
const REDIRECT = 'http://localhost:9999/callback';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jw-oauth-'));
const internalToken = crypto.randomBytes(32).toString('hex');

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

/** 리다이렉트를 따라가지 않고 쿠키를 수동으로 나른다 — 브라우저 흉내. */
class Client {
  constructor() {
    this.cookie = '';
  }

  async fetch(url, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (this.cookie) headers.cookie = this.cookie;
    const res = await fetch(url, { ...opts, headers, redirect: 'manual' });
    const setCookie = res.headers.getSetCookie?.() || [];
    for (const c of setCookie) {
      const pair = c.split(';')[0];
      if (pair.startsWith('jw_sess=')) this.cookie = pair;
    }
    return res;
  }

  form(url, data) {
    return this.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(data).toString(),
    });
  }
}

async function rpc(token, method, params = {}) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  if (res.status !== 200) return { status: res.status, body: null };

  const text = await res.text();
  // Streamable HTTP 는 SSE 프레임으로 답할 수 있다.
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  const json = JSON.parse(line ? line.slice(6) : text);
  return { status: res.status, body: json };
}

async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return true;
    } catch {
      /* 아직 안 떴다 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

// ---------------------------------------------------------------------------

const child = spawn(process.execPath, ['src/http-server.js'], {
  env: {
    ...process.env,
    JW_PORT: String(PORT),
    JW_HOST: '127.0.0.1',
    JW_DB: path.join(tmpDir, 'test.db'),
    JW_SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
    JW_INTERNAL_TOKEN: internalToken,
    JW_SECURE_COOKIES: 'false', // 평문 http 테스트라 Secure 쿠키는 전송되지 않는다
    JW_PUBLIC_URL: ORIGIN,
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});

let serverLog = '';
child.stderr.on('data', (d) => {
  serverLog += d.toString();
});

function cleanup() {
  child.kill('SIGTERM');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

try {
  if (!(await waitForServer())) {
    console.error('서버가 뜨지 않았습니다:\n' + serverLog);
    cleanup();
    process.exit(1);
  }

  // --- 1. 메타데이터 ------------------------------------------------------
  section('1. 디스커버리 메타데이터');
  const as = await (await fetch(`${ORIGIN}/.well-known/oauth-authorization-server/jw`)).json();
  check('AS issuer 가 경로 프리픽스를 포함한다', as.issuer === `${ORIGIN}/jw`, `실제: ${as.issuer}`);
  check('PKCE S256 만 지원한다', JSON.stringify(as.code_challenge_methods_supported) === '["S256"]');
  check('revocation_endpoint 를 알린다', as.revocation_endpoint === `${ORIGIN}/jw/revoke`);

  const pr = await (await fetch(`${ORIGIN}/.well-known/oauth-protected-resource/jw/mcp`)).json();
  check('보호 리소스가 /jw/mcp 다', pr.resource === `${ORIGIN}/jw/mcp`);
  check('인증 서버로 자기 issuer 를 가리킨다', pr.authorization_servers[0] === as.issuer);

  // --- 2. 인증 없는 접근 --------------------------------------------------
  section('2. 인증 없는 MCP 접근');
  const anon = await fetch(`${BASE}/mcp`, { method: 'POST', body: '{}' });
  check('401 을 준다', anon.status === 401);
  const challenge = anon.headers.get('www-authenticate') || '';
  check(
    'WWW-Authenticate 가 정본 resource_metadata 를 가리킨다',
    challenge.includes(`${ORIGIN}/.well-known/oauth-protected-resource/jw/mcp`),
    `실제: ${challenge}`,
  );

  // --- 3. 계정 ------------------------------------------------------------
  section('3. 계정 (다중 사용자)');
  const admin = new Client();
  await admin.form(`${BASE}/signup`, {
    email: 'admin@example.com',
    password: 'admin-password-1',
    display_name: '관리자',
  });
  const adminSummary = await (
    await fetch(`${ORIGIN}/api/dash/summary`, { headers: { 'x-internal-token': internalToken } })
  ).json();
  check('첫 가입자가 자동으로 활성 상태다', adminSummary.users.active === 1);

  const member = new Client();
  await member.form(`${BASE}/signup`, {
    email: 'member@example.com',
    password: 'member-password-1',
    display_name: '형제',
  });
  const afterMember = await (
    await fetch(`${ORIGIN}/api/dash/summary`, { headers: { 'x-internal-token': internalToken } })
  ).json();
  check('두 번째 가입자는 승인 대기 상태다', afterMember.users.pending === 1);

  // --- 4. 미승인 사용자의 인가 차단 ---------------------------------------
  section('4. 동적 등록 + 미승인 사용자 차단');
  const reg = await (
    await fetch(`${BASE}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: '테스트 커넥터' }),
    })
  ).json();
  check('client_id 를 발급한다', typeof reg.client_id === 'string' && reg.client_id.startsWith('c_'));

  const badReg = await fetch(`${BASE}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['http://evil.example.com/cb'] }),
  });
  check('평문 http 외부 redirect_uri 는 거부한다', badReg.status === 400);

  const verifier = crypto.randomBytes(32).toString('base64url');
  const challengeS256 = crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
  const authParams = {
    response_type: 'code',
    client_id: reg.client_id,
    redirect_uri: REDIRECT,
    code_challenge: challengeS256,
    code_challenge_method: 'S256',
    state: 'xyz',
    scope: 'mcp',
    resource: `${ORIGIN}/jw/mcp`,
  };

  const memberAuth = await member.form(`${BASE}/authorize`, { ...authParams, decision: 'allow' });
  check('승인 대기 사용자는 인가받지 못한다 (403)', memberAuth.status === 403, `실제: ${memberAuth.status}`);

  // --- 5. PKCE / audience 검증 --------------------------------------------
  section('5. 파라미터 검증');
  const noPkce = await fetch(
    `${BASE}/authorize?` + new URLSearchParams({ ...authParams, code_challenge: '', code_challenge_method: '' }),
  );
  check('PKCE 없는 요청을 거부한다', noPkce.status === 400);

  const plainPkce = await fetch(
    `${BASE}/authorize?` + new URLSearchParams({ ...authParams, code_challenge_method: 'plain' }),
  );
  check('S256 이 아닌 PKCE 를 거부한다', plainPkce.status === 400);

  const wrongResource = await fetch(
    `${BASE}/authorize?` + new URLSearchParams({ ...authParams, resource: 'https://evil.example.com/mcp' }),
  );
  check('다른 resource(audience)를 거부한다', wrongResource.status === 400);

  const unknownClient = await fetch(
    `${BASE}/authorize?` + new URLSearchParams({ ...authParams, client_id: 'c_nonexistent' }),
  );
  check('등록되지 않은 client_id 를 거부한다', unknownClient.status === 400);

  // --- 6. 정상 인가 흐름 --------------------------------------------------
  section('6. 인가 코드 흐름');
  const authRes = await admin.form(`${BASE}/authorize`, { ...authParams, decision: 'allow' });
  check('승인 후 302 로 리다이렉트한다', authRes.status === 302, `실제: ${authRes.status}`);

  const location = new URL(authRes.headers.get('location'));
  const code = location.searchParams.get('code');
  check('state 를 그대로 되돌려준다', location.searchParams.get('state') === 'xyz');
  check('인가 코드를 발급한다', Boolean(code));

  const badVerifier = await fetch(`${BASE}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: reg.client_id,
      code_verifier: crypto.randomBytes(32).toString('base64url'),
    }).toString(),
  });
  check('틀린 code_verifier 로는 교환되지 않는다', badVerifier.status === 400);

  // 위 실패로 코드가 이미 소비됐다 — 새로 하나 받는다.
  const authRes2 = await admin.form(`${BASE}/authorize`, { ...authParams, decision: 'allow' });
  const code2 = new URL(authRes2.headers.get('location')).searchParams.get('code');

  const tokenRes = await fetch(`${BASE}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code2,
      redirect_uri: REDIRECT,
      client_id: reg.client_id,
      code_verifier: verifier,
    }).toString(),
  });
  const tokens = await tokenRes.json();
  check('액세스 토큰을 발급한다', typeof tokens.access_token === 'string', JSON.stringify(tokens));
  check('리프레시 토큰을 함께 준다', typeof tokens.refresh_token === 'string');
  check('Cache-Control: no-store 를 설정한다', tokenRes.headers.get('cache-control') === 'no-store');

  const reuse = await fetch(`${BASE}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code2,
      redirect_uri: REDIRECT,
      client_id: reg.client_id,
      code_verifier: verifier,
    }).toString(),
  });
  check('인가 코드 재사용을 거부한다', reuse.status === 400);

  // 코드 재사용은 탈취 신호이므로 서버가 그 사용자·클라이언트의 토큰을 전부 폐기한다
  // (OAuth 2.1 권고). 방금 그 방어가 발동했으니 위 tokens 는 이미 죽어 있다 —
  // 이후 구간은 새로 발급받은 토큰으로 진행한다.
  const revokedByReplay = await rpc(tokens.access_token, 'tools/list');
  check('★ 코드 재사용 탐지 시 해당 클라이언트 토큰이 폐기된다', revokedByReplay.status === 401);

  const authRes3 = await admin.form(`${BASE}/authorize`, { ...authParams, decision: 'allow' });
  const code3 = new URL(authRes3.headers.get('location')).searchParams.get('code');
  const live = await (
    await fetch(`${BASE}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code3,
        redirect_uri: REDIRECT,
        client_id: reg.client_id,
        code_verifier: verifier,
      }).toString(),
    })
  ).json();
  check('재발급이 정상 동작한다', typeof live.access_token === 'string');

  // --- 7. 인증된 MCP ------------------------------------------------------
  section('7. 인증된 MCP 호출');
  const list = await rpc(live.access_token, 'tools/list');
  check('tools/list 가 200 이다', list.status === 200, `상태: ${list.status}`);
  const toolNames = (list.body?.result?.tools || []).map((t) => t.name);
  check('도구 11종을 모두 노출한다', toolNames.length === 11, `실제: ${toolNames.length}종 — ${toolNames.join(', ')}`);
  check(
    'lesson 도구가 HTTP 서버에도 있다 (상류 누락 회귀)',
    toolNames.includes('get_lesson_content') && toolNames.includes('get_lesson_list'),
  );

  const call = await rpc(live.access_token, 'tools/call', {
    name: 'search_bible_books',
    arguments: { query: 'john' },
  });
  check('tools/call 이 동작한다 (네트워크 불필요한 도구)', call.status === 200 && !call.body?.error);

  const usage = await (
    await fetch(`${ORIGIN}/api/dash/calls?limit=5`, { headers: { 'x-internal-token': internalToken } })
  ).json();
  check('호출이 사용자와 함께 기록된다', usage.calls?.[0]?.email === 'admin@example.com', JSON.stringify(usage.calls?.[0]));

  const forged = await rpc('at_forged-token-value', 'tools/list');
  check('위조 토큰을 거부한다', forged.status === 401);

  // --- 8. 리프레시 회전 ---------------------------------------------------
  section('8. 리프레시 토큰');
  const refreshed = await (
    await fetch(`${BASE}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: live.refresh_token }).toString(),
    })
  ).json();
  check('새 액세스 토큰을 발급한다', typeof refreshed.access_token === 'string');
  check('새 토큰으로 MCP 가 동작한다', (await rpc(refreshed.access_token, 'tools/list')).status === 200);

  const reusedRefresh = await fetch(`${BASE}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: live.refresh_token }).toString(),
  });
  check('쓴 리프레시 토큰은 재사용할 수 없다 (회전)', reusedRefresh.status === 400);

  // --- 9. 핵심 계약: 계정 비활성화 = 즉시 접근 차단 -----------------------
  section('9. 계정 비활성화 시 토큰 즉시 무효 ★');
  const usersList = await (
    await fetch(`${ORIGIN}/api/dash/users`, { headers: { 'x-internal-token': internalToken } })
  ).json();
  const adminRow = usersList.users.find((u) => u.email === 'admin@example.com');
  check('대시보드 API 가 유효 토큰 수를 보고한다', adminRow.active_tokens >= 1, `실제: ${adminRow.active_tokens}`);

  const stillWorks = await rpc(refreshed.access_token, 'tools/list');
  check('비활성화 전에는 토큰이 동작한다', stillWorks.status === 200);

  // 마지막 관리자는 잠글 수 없어야 한다 — 자기 자신을 잠그는 사고 방지
  const lockout = await fetch(`${ORIGIN}/api/dash/users/${adminRow.user_id}/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': internalToken },
    body: JSON.stringify({ status: 'disabled' }),
  });
  check('마지막 활성 관리자는 비활성화할 수 없다', lockout.status === 400);

  // member 를 승인해 두 번째 관리 가능 계정을 만들고, 그 다음 admin 을 잠근다
  const memberRow = usersList.users.find((u) => u.email === 'member@example.com');
  await fetch(`${ORIGIN}/api/dash/users/${memberRow.user_id}/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': internalToken },
    body: JSON.stringify({ status: 'active' }),
  });

  // admin 은 마지막 관리자라 여전히 못 잠근다 → member(일반 사용자)로 검증한다.
  const memberClient = new Client();
  await memberClient.form(`${BASE}/login`, { email: 'member@example.com', password: 'member-password-1' });
  const mAuth = await memberClient.form(`${BASE}/authorize`, { ...authParams, decision: 'allow' });
  const mCode = new URL(mAuth.headers.get('location')).searchParams.get('code');
  const mVerifier = verifier; // 같은 challenge 를 쓰는 요청이므로 동일 verifier
  const mTokens = await (
    await fetch(`${BASE}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: mCode,
        redirect_uri: REDIRECT,
        client_id: reg.client_id,
        code_verifier: mVerifier,
      }).toString(),
    })
  ).json();
  check('승인된 사용자가 토큰을 받는다', typeof mTokens.access_token === 'string');
  check('그 토큰으로 MCP 가 동작한다', (await rpc(mTokens.access_token, 'tools/list')).status === 200);

  const disable = await fetch(`${ORIGIN}/api/dash/users/${memberRow.user_id}/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': internalToken },
    body: JSON.stringify({ status: 'disabled' }),
  });
  check('사용자를 비활성화한다', disable.status === 200);

  const afterDisable = await rpc(mTokens.access_token, 'tools/list');
  check('★ 비활성화 즉시 기존 토큰이 401 이 된다', afterDisable.status === 401, `실제: ${afterDisable.status}`);

  const refreshAfterDisable = await fetch(`${BASE}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: mTokens.refresh_token }).toString(),
  });
  check('★ 비활성 계정은 리프레시로도 되살아나지 못한다', refreshAfterDisable.status === 400);

  // --- 10. 폐기 -----------------------------------------------------------
  section('10. 토큰 폐기 (RFC 7009)');
  const revoke = await fetch(`${BASE}/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: refreshed.access_token }).toString(),
  });
  check('폐기 요청에 200 을 준다', revoke.status === 200);
  check('폐기된 토큰은 401 이다', (await rpc(refreshed.access_token, 'tools/list')).status === 401);
  check(
    '모르는 토큰에도 200 을 준다 (존재 여부 탐색 방지)',
    (
      await fetch(`${BASE}/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: 'at_nope' }).toString(),
      })
    ).status === 200,
  );
} catch (err) {
  failed++;
  console.error('\n\x1b[31m예외 발생:\x1b[0m', err);
  console.error('\n--- 서버 로그 ---\n' + serverLog);
} finally {
  cleanup();
}

console.log(`\n\x1b[1m결과: ${passed} 통과, ${failed} 실패\x1b[0m`);
process.exit(failed === 0 ? 0 : 1);
