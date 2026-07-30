/**
 * SQLite 저장소 — 사용자·OAuth·사용량.
 *
 * hosub-mcp 의 data/oauth.db 와 **완전히 분리된** 자체 DB(data/jw.db)다. 두 서비스는
 * 스키마도 프로세스도 공유하지 않는다.
 *
 * 토큰은 원문을 저장하지 않고 SHA-256 해시만 저장한다 — DB 가 유출돼도 그 자체로는
 * 남의 세션을 탈취할 수 없다.
 */

// node:sqlite 가 아니라 better-sqlite3 을 쓴다. 내장 모듈은 아직 experimental 이라
// "언제든 바뀔 수 있다"고 경고하는데, 로그인과 토큰이 걸린 저장소를 Node 마이너
// 업그레이드에 맡길 수는 없다.
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  user_id       TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL DEFAULT '',
  pw_salt       TEXT NOT NULL,
  pw_hash       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',   -- pending | active | disabled
  role          TEXT NOT NULL DEFAULT 'user',      -- user | admin
  created_at    REAL NOT NULL,
  last_login_at REAL
);

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id     TEXT PRIMARY KEY,
  redirect_uris TEXT NOT NULL,
  client_name   TEXT NOT NULL DEFAULT '',
  created_at    REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code           TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope          TEXT,
  resource       TEXT,
  expires_at     REAL NOT NULL,
  used           INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  client_id  TEXT,
  kind       TEXT NOT NULL,                        -- access | refresh
  scope      TEXT,
  expires_at REAL,
  created_at REAL NOT NULL,
  revoked_at REAL
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT,
  client_id   TEXT,
  tool        TEXT NOT NULL,
  ok          INTEGER NOT NULL,
  duration_ms INTEGER,
  error       TEXT,
  created_at  REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tokens_user    ON oauth_tokens(user_id, kind);
CREATE INDEX IF NOT EXISTS idx_calls_created  ON tool_calls(created_at);
CREATE INDEX IF NOT EXISTS idx_calls_user     ON tool_calls(user_id);
CREATE INDEX IF NOT EXISTS idx_codes_expires  ON oauth_codes(expires_at);
`;

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

export function openDb(dbPath) {
  const resolved = path.resolve(dbPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new Database(resolved);
  // WAL: 대시보드 API 의 읽기가 MCP 요청의 쓰기를 막지 않게 한다.
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

/**
 * 만료된 인가 코드와 토큰을 지운다. 코드는 5분짜리라 방치하면 계속 쌓인다.
 * 폐기(revoked)된 토큰은 감사 목적으로 30일 보관 후 삭제한다.
 */
export function pruneExpired(db) {
  const now = Date.now() / 1000;
  db.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').run(now);
  db.prepare(
    'DELETE FROM oauth_tokens WHERE (expires_at IS NOT NULL AND expires_at < ?) ' +
      'OR (revoked_at IS NOT NULL AND revoked_at < ?)',
  ).run(now, now - 30 * 24 * 3600);
}
