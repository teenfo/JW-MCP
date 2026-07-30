/**
 * 사용자 계정 — 가입·로그인·승인.
 *
 * 다중 사용자 서비스이므로 "누가 쓸 수 있는가"를 서버가 통제해야 한다. 기본 정책:
 *
 *   가입 → status='pending' → 관리자 승인 → status='active' → OAuth 로 커넥터 연결
 *
 * JW_INVITE_CODE 를 설정해 두면 코드를 아는 사람은 승인 없이 바로 active 가 된다
 * (회중 단위로 한 번에 나눠줄 때 편하다). 코드가 비어 있으면 초대 기능은 꺼진다.
 *
 * 비밀번호는 scrypt(내장 crypto) + 사용자별 salt 로만 저장한다. 외부 의존성 0.
 */

import crypto from 'node:crypto';

const SCRYPT_KEYLEN = 64;
// N=2^15. 로그인 1회당 ~100ms 수준으로, 홈서버에서 감당되면서 무차별 대입은 비싸다.
const SCRYPT_OPTS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export const MIN_PASSWORD_LENGTH = 10;

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTS, (err, key) =>
      err ? reject(err) : resolve(key.toString('hex')),
    );
  });
}

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

export class UserStore {
  /**
   * @param {import('better-sqlite3').Database} db
   * @param {{adminEmails?: string[], inviteCode?: string}} opts
   */
  constructor(db, { adminEmails = [], inviteCode = '' } = {}) {
    this.db = db;
    this.adminEmails = new Set(adminEmails.map(normalizeEmail).filter(Boolean));
    this.inviteCode = inviteCode || '';
  }

  count() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  }

  findByEmail(email) {
    return this.db
      .prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE')
      .get(normalizeEmail(email));
  }

  findById(userId) {
    return this.db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
  }

  list() {
    return this.db
      .prepare(
        `SELECT u.user_id, u.email, u.display_name, u.status, u.role,
                u.created_at, u.last_login_at,
                (SELECT COUNT(*) FROM tool_calls c WHERE c.user_id = u.user_id) AS call_count,
                (SELECT MAX(created_at) FROM tool_calls c WHERE c.user_id = u.user_id) AS last_call_at,
                (SELECT COUNT(*) FROM oauth_tokens t
                   WHERE t.user_id = u.user_id AND t.kind = 'access'
                     AND t.revoked_at IS NULL AND t.expires_at > unixepoch()) AS active_tokens
           FROM users u
          ORDER BY CASE u.status WHEN 'pending' THEN 0 ELSE 1 END, u.created_at DESC`,
      )
      .all();
  }

  statusCounts() {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM users GROUP BY status').all();
    const out = { total: 0, active: 0, pending: 0, disabled: 0 };
    for (const r of rows) {
      out[r.status] = r.n;
      out.total += r.n;
    }
    return out;
  }

  /**
   * 계정을 만든다.
   *
   * 최초 가입자는 자동으로 관리자 겸 활성 사용자가 된다 — 그러지 않으면 아무도
   * 아무를 승인할 수 없는 교착에 빠진다(부트스트랩).
   *
   * @returns {Promise<{ok: true, user: object} | {ok: false, error: string}>}
   */
  async create({ email, password, displayName = '', inviteCode = '' }) {
    const normalized = normalizeEmail(email);
    if (!validateEmail(normalized)) return { ok: false, error: '이메일 형식이 올바르지 않습니다.' };
    if (String(password || '').length < MIN_PASSWORD_LENGTH) {
      return { ok: false, error: `비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다.` };
    }
    if (this.findByEmail(normalized)) return { ok: false, error: '이미 가입된 이메일입니다.' };

    const isFirstUser = this.count() === 0;
    const isNamedAdmin = this.adminEmails.has(normalized);
    const invited =
      this.inviteCode.length > 0 &&
      String(inviteCode).length === this.inviteCode.length &&
      crypto.timingSafeEqual(Buffer.from(String(inviteCode)), Buffer.from(this.inviteCode));

    const role = isFirstUser || isNamedAdmin ? 'admin' : 'user';
    const status = isFirstUser || isNamedAdmin || invited ? 'active' : 'pending';

    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await scrypt(password, salt);
    const userId = 'u_' + crypto.randomBytes(12).toString('hex');

    this.db
      .prepare(
        `INSERT INTO users (user_id, email, display_name, pw_salt, pw_hash, status, role, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(userId, normalized, String(displayName).slice(0, 80), salt, hash, status, role, Date.now() / 1000);

    return { ok: true, user: this.findById(userId) };
  }

  /**
   * 비밀번호를 검증한다.
   *
   * 계정이 없어도 더미 해시로 scrypt 를 한 번 돌린다. 그러지 않으면 응답 시간만으로
   * "가입된 이메일인지"가 새어 나간다(사용자 열거 공격).
   */
  async verifyPassword(email, password) {
    const user = this.findByEmail(email);
    if (!user) {
      await scrypt(String(password || ''), 'decoy-salt-not-a-real-user');
      return null;
    }
    const candidate = await scrypt(String(password || ''), user.pw_salt);
    const a = Buffer.from(candidate, 'hex');
    const b = Buffer.from(user.pw_hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return user;
  }

  touchLogin(userId) {
    this.db.prepare('UPDATE users SET last_login_at = ? WHERE user_id = ?').run(Date.now() / 1000, userId);
  }

  /**
   * 계정 상태를 바꾼다.
   *
   * 'active' 가 아니게 되는 순간 해당 사용자의 토큰을 전부 폐기한다. 상태 확인은
   * Bearer 검증 때마다 조인으로도 이뤄지므로 이중 방어이지만, 여기서 지워두면
   * 대시보드의 "유효 토큰 수"가 즉시 정확해진다.
   */
  setStatus(userId, status) {
    if (!['pending', 'active', 'disabled'].includes(status)) {
      return { ok: false, error: '알 수 없는 상태입니다.' };
    }
    const user = this.findById(userId);
    if (!user) return { ok: false, error: '사용자를 찾을 수 없습니다.' };

    // 마지막 관리자를 잠가버리면 아무도 되돌릴 수 없다.
    if (user.role === 'admin' && status !== 'active') {
      const activeAdmins = this.db
        .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'")
        .get().n;
      if (activeAdmins <= 1) return { ok: false, error: '마지막 활성 관리자는 비활성화할 수 없습니다.' };
    }

    this.db.prepare('UPDATE users SET status = ? WHERE user_id = ?').run(status, userId);
    if (status !== 'active') {
      this.db
        .prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
        .run(Date.now() / 1000, userId);
    }
    return { ok: true, user: this.findById(userId) };
  }
}
