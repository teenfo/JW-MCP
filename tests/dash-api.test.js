/**
 * 대시보드 API 계약 테스트.
 *
 * docs/DASHBOARD-API.md 가 소비자(hosub 대시보드)와의 계약이고, 그 문서는 별도
 * 저장소가 보고 구현한다. 여기서 검증하는 것은 "문서에 적힌 대로 실제로 동작하는가"다 —
 * 소비자가 이 저장소를 읽지 않고도 문서만 믿을 수 있어야 한다.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/auth/db.js';
import { UserStore } from '../src/auth/users.js';
import { OAuthStore } from '../src/auth/oauth.js';
import { DashStats, buildDashRouter } from '../src/dash/api.js';

const TONES = new Set(['ok', 'warn', 'danger', 'muted']);

/** 라우터를 임시 express 앱에 올려 실제 HTTP 로 두드린다. */
async function withServer(fn) {
  const { default: express } = await import('express');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jw-dash-'));
  const db = openDb(path.join(dir, 'test.db'));
  const users = new UserStore(db);
  const oauth = new OAuthStore(db);
  const stats = new DashStats(db, { users, oauth, version: '2.0.0' });
  const token = 'tok_' + crypto.randomBytes(16).toString('hex');

  const app = express();
  app.use('/api/dash', buildDashRouter({ stats, users, internalToken: token }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const get = (p, t = token) =>
    fetch(`${origin}/api/dash${p}`, { headers: { 'x-internal-token': t } });
  const post = (p, body, t = token) =>
    fetch(`${origin}/api/dash${p}`, {
      method: 'POST',
      headers: { 'x-internal-token': t, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  try {
    await fn({ get, post, users, db });
  } finally {
    server.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('토큰 없이/틀린 토큰으로는 401 (문서 1절)', async () => {
  await withServer(async ({ get }) => {
    assert.equal((await get('/summary', '')).status, 401);
    assert.equal((await get('/summary', 'wrong-token')).status, 401);
    const body = await (await get('/summary', 'wrong-token')).json();
    assert.deepEqual(body, { ok: false, error: 'unauthorized' });
  });
});

test('모든 성공 응답이 ok:true 를 포함한다 (문서 8절)', async () => {
  await withServer(async ({ get }) => {
    for (const p of ['/summary', '/users', '/usage', '/calls']) {
      const body = await (await get(p)).json();
      assert.equal(body.ok, true, `${p} 에 ok:true 없음`);
    }
  });
});

test('summary 의 원시 필드가 문서와 일치한다 (문서 3.2절)', async () => {
  await withServer(async ({ get }) => {
    const s = await (await get('/summary')).json();
    for (const key of ['service', 'version', 'uptime_s', 'tools', 'users', 'tokens',
                       'clients', 'calls', 'top_tools', 'current', 'sections']) {
      assert.ok(key in s, `누락된 필드: ${key}`);
    }
    assert.equal(s.service, 'jw-mcp');
    assert.deepEqual(Object.keys(s.users).sort(), ['active', 'disabled', 'pending', 'total']);
    assert.deepEqual(Object.keys(s.tokens).sort(), ['access', 'refresh']);
    assert.deepEqual(Object.keys(s.calls).sort(), ['errors_week', 'today', 'total', 'week']);
    assert.match(s.current.watchtower_issue, /^\d{6}00$/);
    assert.match(s.current.workbook_issue, /^\d{6}00$/);
  });
});

test('sections 구조와 tone 값 집합이 고정 계약을 지킨다 (문서 3.1절)', async () => {
  await withServer(async ({ get }) => {
    const { sections } = await (await get('/summary')).json();
    assert.ok(Array.isArray(sections) && sections.length > 0);
    for (const s of sections) {
      assert.equal(typeof s.title, 'string');
      assert.match(s.icon, /^bi-/, `Bootstrap Icons 클래스가 아님: ${s.icon}`);
      assert.ok(Array.isArray(s.items));
      for (const item of s.items) {
        assert.equal(typeof item.label, 'string');
        assert.ok(['string', 'number'].includes(typeof item.value), `value 타입 위반: ${typeof item.value}`);
        if ('tone' in item) assert.ok(TONES.has(item.tone), `알 수 없는 tone: ${item.tone}`);
      }
    }
  });
});

test('user_id 가 문서의 정규식 ^u_[0-9a-f]{24}$ 를 만족한다 (문서 2절)', async () => {
  await withServer(async ({ get, users }) => {
    await users.create({ email: 'a@example.com', password: 'password-1234' });
    const { users: list } = await (await get('/users')).json();
    assert.match(list[0].user_id, /^u_[0-9a-f]{24}$/);
  });
});

test('users 응답에 비밀번호 해시·salt 가 실리지 않는다 (문서 4절)', async () => {
  await withServer(async ({ get, users }) => {
    await users.create({ email: 'a@example.com', password: 'password-1234' });
    const raw = await (await get('/users')).text();
    assert.ok(!raw.includes('pw_hash'), 'pw_hash 가 노출됨');
    assert.ok(!raw.includes('pw_salt'), 'pw_salt 가 노출됨');
  });
});

test('users 는 pending 을 먼저 정렬한다 (문서 4절)', async () => {
  await withServer(async ({ get, users }) => {
    await users.create({ email: 'admin@example.com', password: 'password-1234' }); // 첫 가입 = active
    await users.create({ email: 'later@example.com', password: 'password-1234' }); // pending
    const { users: list } = await (await get('/users')).json();
    assert.equal(list[0].status, 'pending');
  });
});

test('usage 의 days 가 1–90 으로 잘린다 (문서 5절)', async () => {
  await withServer(async ({ get }) => {
    assert.equal((await (await get('/usage?days=999')).json()).days, 90);
    assert.equal((await (await get('/usage?days=0')).json()).days, 1);
    assert.equal((await (await get('/usage?days=abc')).json()).days, 7); // 기본값
    assert.equal((await (await get('/usage')).json()).days, 7);
  });
});

test('calls 의 limit 이 1–500 으로 잘린다 (문서 6절)', async () => {
  await withServer(async ({ get, db }) => {
    const insert = db.prepare(
      'INSERT INTO tool_calls (user_id, client_id, tool, ok, duration_ms, created_at) VALUES (?,?,?,?,?,?)',
    );
    for (let i = 0; i < 5; i++) insert.run(null, null, 'search_bible_books', 1, 3, Date.now() / 1000);

    const three = await (await get('/calls?limit=3')).json();
    assert.equal(three.calls.length, 3);
    // 상한을 넘겨도 오류가 아니라 잘린 값으로 동작해야 한다
    assert.equal((await (await get('/calls?limit=99999')).status), 200);
  });
});

test('calls 의 ok 는 boolean 이 아니라 0/1 정수다 (문서 6절)', async () => {
  await withServer(async ({ get, db }) => {
    db.prepare(
      'INSERT INTO tool_calls (user_id, tool, ok, duration_ms, error, created_at) VALUES (?,?,?,?,?,?)',
    ).run(null, 'no_such_tool', 0, 1, 'Unknown tool: no_such_tool', Date.now() / 1000);
    const { calls } = await (await get('/calls')).json();
    assert.equal(calls[0].ok, 0);
    assert.equal(typeof calls[0].ok, 'number');
    assert.equal(calls[0].error, 'Unknown tool: no_such_tool');
  });
});

test('calls 에 도구 인자가 남지 않는다 (문서 6절 · 프라이버시)', async () => {
  await withServer(async ({ get, db }) => {
    db.prepare('INSERT INTO tool_calls (tool, ok, created_at) VALUES (?,?,?)')
      .run('get_bible_verse', 1, Date.now() / 1000);
    const { calls } = await (await get('/calls')).json();
    // 스키마에 인자 컬럼 자체가 없다 — 응답에도 있을 수 없다.
    assert.ok(!('arguments' in calls[0]) && !('params' in calls[0]) && !('args' in calls[0]));
  });
});

test('상태 변경이 성공하면 변경된 사용자를 돌려준다 (문서 7절)', async () => {
  await withServer(async ({ get, post, users }) => {
    await users.create({ email: 'admin@example.com', password: 'password-1234' });
    const created = await users.create({ email: 'member@example.com', password: 'password-1234' });
    assert.equal(created.user.status, 'pending');

    const res = await post(`/users/${created.user.user_id}/status`, { status: 'active' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.user.status, 'active');
  });
});

test('비활성화가 토큰을 즉시 폐기한다 (문서 7절 부수 효과)', async () => {
  await withServer(async ({ post, users, db }) => {
    await users.create({ email: 'admin@example.com', password: 'password-1234' });
    const m = (await users.create({ email: 'member@example.com', password: 'password-1234' })).user;
    users.setStatus(m.user_id, 'active');

    const oauth = new OAuthStore(db);
    const clientId = oauth.registerClient(['https://example.com/cb'], 'test');
    const tokens = oauth.issueTokens(m.user_id, clientId, 'mcp');
    assert.ok(oauth.verifyAccess(tokens.access_token), '발급 직후에는 유효해야 한다');

    await post(`/users/${m.user_id}/status`, { status: 'disabled' });
    assert.equal(oauth.verifyAccess(tokens.access_token), null, '비활성화 후에도 토큰이 살아 있다');
    assert.equal(oauth.exchangeRefresh(tokens.refresh_token), null, '리프레시로 되살아난다');
  });
});

test('거부되는 상태 변경은 400 + 사유를 준다 (문서 7절)', async () => {
  await withServer(async ({ post, users }) => {
    const admin = (await users.create({ email: 'admin@example.com', password: 'password-1234' })).user;

    const lastAdmin = await post(`/users/${admin.user_id}/status`, { status: 'disabled' });
    assert.equal(lastAdmin.status, 400);
    assert.match((await lastAdmin.json()).error, /마지막 활성 관리자/);

    const unknownUser = await post('/users/u_000000000000000000000000/status', { status: 'active' });
    assert.equal(unknownUser.status, 400);

    const badStatus = await post(`/users/${admin.user_id}/status`, { status: 'superuser' });
    assert.equal(badStatus.status, 400);
    assert.equal((await badStatus.json()).ok, false);
  });
});
