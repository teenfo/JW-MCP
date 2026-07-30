/**
 * 브라우저 세션 — 무상태 서명 쿠키.
 *
 * 서버에 세션 테이블을 두지 않는다. 쿠키 자체가 `payload.signature` 형태로
 * 자기 자신을 증명하므로, 서비스가 재시작해도 로그인이 풀리지 않는다.
 * (hosub 대시보드는 starlette SessionMiddleware 를 쓰지만, 여기서는 의존성을
 *  늘리지 않으려 같은 개념을 직접 구현한다.)
 *
 * 이 쿠키는 **브라우저 로그인 전용**이다. MCP 접근은 오직 Bearer 토큰으로만
 * 이뤄지며, 쿠키는 /mcp 에서 일절 인정되지 않는다 — 인증 경계를 섞지 않는다.
 */

import crypto from 'node:crypto';

const COOKIE_NAME = 'jw_sess';
const SESSION_TTL = 14 * 24 * 3600; // 14일

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sign(payloadB64, secret) {
  return crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

/** 세션 쿠키 값을 만든다. */
export function serialize(userId, secret) {
  const payload = b64url(JSON.stringify({ uid: userId, exp: Date.now() / 1000 + SESSION_TTL }));
  return `${payload}.${sign(payload, secret)}`;
}

/** 쿠키 값을 검증해 user_id 를 돌려준다. 위조·만료면 null. */
export function verify(value, secret) {
  if (typeof value !== 'string') return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;

  const payloadB64 = value.slice(0, dot);
  const provided = Buffer.from(value.slice(dot + 1));
  const expected = Buffer.from(sign(payloadB64, secret));
  // 길이가 다르면 timingSafeEqual 이 던진다 — 먼저 거른다.
  if (provided.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(provided, expected)) return null;

  try {
    const data = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (!data.uid || typeof data.exp !== 'number' || data.exp < Date.now() / 1000) return null;
    return data.uid;
  } catch {
    return null;
  }
}

/** 요청 헤더에서 세션 쿠키를 꺼낸다(express 의 cookie-parser 없이). */
export function readCookie(req, name = COOKIE_NAME) {
  const header = req.headers?.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

/**
 * Set-Cookie 를 붙인다.
 *
 * Path 를 basePath 로 좁혀, 같은 호스트를 공유하는 hosub 대시보드(/, /api/*)에는
 * 이 쿠키가 아예 전송되지 않게 한다 — 경로 분리 배치에서 특히 중요하다.
 */
export function setCookie(res, userId, secret, { basePath = '/jw', secure = true } = {}) {
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(serialize(userId, secret))}`,
    `Path=${basePath || '/'}`,
    `Max-Age=${SESSION_TTL}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

export function clearCookie(res, { basePath = '/jw', secure = true } = {}) {
  const attrs = [`${COOKIE_NAME}=`, `Path=${basePath || '/'}`, 'Max-Age=0', 'HttpOnly', 'SameSite=Lax'];
  if (secure) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

export { COOKIE_NAME, SESSION_TTL };
