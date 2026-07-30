/**
 * 대시보드용 내부 API.
 *
 * hosub 대시보드(:8701)가 이 엔드포인트를 프록시해 화면에 "단순 게시"한다.
 * 지표를 계산하고 표현까지 정하는 책임은 **전부 여기(jw-mcp)** 에 있다.
 *
 * ## 왜 sections 를 돌려주는가
 *
 * /api/dash/summary 는 원시 필드와 함께 **렌더 즉시 가능한 sections 배열**을 준다:
 *
 *   [{ title, icon, items: [{ label, value, tone }] }]
 *
 * hosub 쪽 페이지는 이 배열을 카드로 그리는 범용 렌더러이기만 하면 된다. 그래서
 * 나중에 jw-mcp 가 지표를 더하거나 빼도 **hosub 레포를 다시 건드릴 필요가 없다.**
 * 두 서비스가 별개 저장소·별개 배포 주기를 갖는다는 전제에서 이게 결합을 가장
 * 얇게 만든다.
 *
 * ## 노출 경계
 *
 * 이 라우터는 basePath(/jw) **바깥**에 마운트되고 Caddy 는 /api/dash/* 를 라우팅하지
 * 않는다. 즉 공인 인터넷에서는 닿을 수 없고, 같은 호스트의 127.0.0.1 에서만 보인다.
 * 그 위에 X-Internal-Token 을 한 겹 더 요구한다(trading·tnm 과 동일한 관례).
 */

import crypto from 'node:crypto';
import express from 'express';

import { getCurrentIssue, getCurrentWatchtowerIssue } from '../tools/rtf-utils.js';
import { allTools } from '../tools/registry.js';

const DAY = 24 * 3600;

function timingSafeEq(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** YYYYMM00 → "2026년 7월호" */
function prettyIssue(issue) {
  const m = /^(\d{4})(\d{2})/.exec(String(issue));
  return m ? `${m[1]}년 ${Number(m[2])}월호` : String(issue);
}

const ago = (ts) => {
  if (!ts) return '없음';
  const s = Date.now() / 1000 - ts;
  if (s < 60) return '방금';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < DAY) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / DAY)}일 전`;
};

function fmtUptime(seconds) {
  const d = Math.floor(seconds / DAY);
  const h = Math.floor((seconds % DAY) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d > 0 ? `${d}일 ${h}시간` : h > 0 ? `${h}시간 ${m}분` : `${m}분`;
}

export class DashStats {
  constructor(db, { users, oauth, version = '0.0.0', startedAt = Date.now() / 1000 }) {
    this.db = db;
    this.users = users;
    this.oauth = oauth;
    this.version = version;
    this.startedAt = startedAt;
  }

  callCounts() {
    const now = Date.now() / 1000;
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END) AS d1,
           SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END) AS d7,
           SUM(CASE WHEN created_at > ? AND ok = 0 THEN 1 ELSE 0 END) AS err7,
           COUNT(*) AS total
         FROM tool_calls`,
      )
      .get(now - DAY, now - 7 * DAY, now - 7 * DAY);
    return { today: row.d1 || 0, week: row.d7 || 0, errors_week: row.err7 || 0, total: row.total || 0 };
  }

  topTools(days = 7, limit = 5) {
    return this.db
      .prepare(
        `SELECT tool, COUNT(*) AS n, CAST(AVG(duration_ms) AS INTEGER) AS avg_ms
           FROM tool_calls WHERE created_at > ?
          GROUP BY tool ORDER BY n DESC LIMIT ?`,
      )
      .all(Date.now() / 1000 - days * DAY, limit);
  }

  dailyUsage(days = 7) {
    return this.db
      .prepare(
        `SELECT date(created_at, 'unixepoch', 'localtime') AS day,
                COUNT(*) AS calls,
                SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS errors,
                COUNT(DISTINCT user_id) AS users
           FROM tool_calls WHERE created_at > ?
          GROUP BY day ORDER BY day`,
      )
      .all(Date.now() / 1000 - days * DAY);
  }

  recentCalls(limit = 50) {
    return this.db
      .prepare(
        `SELECT c.id, c.tool, c.ok, c.duration_ms, c.error, c.created_at,
                u.email, u.display_name
           FROM tool_calls c LEFT JOIN users u ON u.user_id = c.user_id
          ORDER BY c.id DESC LIMIT ?`,
      )
      .all(limit);
  }

  recentErrors(limit = 5) {
    return this.db
      .prepare(
        `SELECT tool, error, created_at FROM tool_calls
          WHERE ok = 0 ORDER BY id DESC LIMIT ?`,
      )
      .all(limit);
  }

  lastActivity() {
    return this.db.prepare('SELECT MAX(created_at) AS ts FROM tool_calls').get().ts;
  }

  /** 화면에 그대로 그릴 수 있는 요약 — hosub 대시보드는 이 구조만 알면 된다. */
  summary() {
    const u = this.users.statusCounts();
    const t = this.oauth.tokenCounts();
    const c = this.callCounts();
    const top = this.topTools();
    const uptime = Date.now() / 1000 - this.startedAt;

    const sections = [
      {
        title: '서비스',
        icon: 'bi-hdd-network',
        items: [
          { label: '상태', value: '정상', tone: 'ok' },
          { label: '버전', value: this.version },
          { label: '가동 시간', value: fmtUptime(uptime) },
          { label: '도구', value: `${allTools.length}종` },
        ],
      },
      {
        title: '사용자',
        icon: 'bi-people',
        items: [
          { label: '활성', value: u.active, tone: 'ok' },
          { label: '승인 대기', value: u.pending, tone: u.pending > 0 ? 'warn' : 'muted' },
          { label: '비활성', value: u.disabled, tone: 'muted' },
          { label: '전체', value: u.total },
        ],
      },
      {
        title: 'OAuth',
        icon: 'bi-key',
        items: [
          { label: '유효 액세스 토큰', value: t.access },
          { label: '유효 리프레시 토큰', value: t.refresh },
          { label: '등록 클라이언트', value: this.oauth.clientCount() },
        ],
      },
      {
        title: '사용량',
        icon: 'bi-graph-up',
        items: [
          { label: '오늘 호출', value: c.today },
          { label: '7일 호출', value: c.week },
          { label: '7일 오류', value: c.errors_week, tone: c.errors_week > 0 ? 'warn' : 'muted' },
          { label: '마지막 활동', value: ago(this.lastActivity()), tone: 'muted' },
        ],
      },
      {
        title: '이번 연구 자료',
        icon: 'bi-book',
        items: [
          { label: '파수대', value: prettyIssue(getCurrentWatchtowerIssue()) },
          { label: '집회 워크북', value: prettyIssue(getCurrentIssue()) },
        ],
      },
    ];

    if (top.length) {
      sections.push({
        title: '많이 쓰는 도구 (7일)',
        icon: 'bi-tools',
        items: top.map((r) => ({ label: r.tool, value: `${r.n}회 · ${r.avg_ms ?? 0}ms` })),
      });
    }

    const errors = this.recentErrors();
    if (errors.length) {
      sections.push({
        title: '최근 오류',
        icon: 'bi-exclamation-triangle',
        items: errors.map((e) => ({
          label: `${e.tool} · ${ago(e.created_at)}`,
          value: String(e.error || '').slice(0, 80),
          tone: 'danger',
        })),
      });
    }

    return {
      ok: true,
      service: 'jw-mcp',
      version: this.version,
      uptime_s: Math.floor(uptime),
      tools: allTools.length,
      users: u,
      tokens: t,
      clients: this.oauth.clientCount(),
      calls: c,
      top_tools: top,
      current: {
        watchtower_issue: getCurrentWatchtowerIssue(),
        workbook_issue: getCurrentIssue(),
      },
      sections,
    };
  }
}

/**
 * 내부 API 라우터.
 *
 * @param {DashStats} stats
 * @param {import('../auth/users.js').UserStore} users
 * @param {string} internalToken  빈 값이면 라우터를 아예 마운트하지 않는다(호출부 책임)
 */
export function buildDashRouter({ stats, users, internalToken }) {
  const router = express.Router();

  router.use((req, res, next) => {
    if (!timingSafeEq(req.headers['x-internal-token'], internalToken)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    next();
  });

  /**
   * 정수 질의 파라미터를 범위 안으로 자른다.
   *
   * `parseInt(v) || fallback` 을 쓰면 안 된다 — 0 이 falsy 라 `days=0` 이 하한 1 로
   * 잘리지 않고 기본값 7 로 튄다. 값이 없거나 숫자가 아닐 때만 기본값을 쓴다.
   */
  const intParam = (raw, fallback, min, max) => {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(n, min), max);
  };

  router.get('/summary', (req, res) => res.json(stats.summary()));

  router.get('/users', (req, res) => res.json({ ok: true, users: users.list() }));

  router.get('/usage', (req, res) => {
    const days = intParam(req.query.days, 7, 1, 90);
    res.json({ ok: true, days, daily: stats.dailyUsage(days), top_tools: stats.topTools(days, 10) });
  });

  router.get('/calls', (req, res) => {
    const limit = intParam(req.query.limit, 50, 1, 500);
    res.json({ ok: true, calls: stats.recentCalls(limit) });
  });

  router.post('/users/:id/status', express.json({ limit: '8kb' }), (req, res) => {
    const result = users.setStatus(req.params.id, req.body?.status);
    if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
    res.json({ ok: true, user: result.user });
  });

  return router;
}
