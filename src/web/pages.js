/**
 * 브라우저 화면 (로그인·가입·OAuth 동의·계정·관리자).
 *
 * 자체완결 HTML 만 쓴다 — 외부 CDN·폰트·스크립트를 불러오지 않는다. 로그인 화면이
 * 서드파티에 의존하면 그쪽이 죽을 때 아무도 로그인할 수 없고, 자격증명 입력 페이지에
 * 남의 스크립트를 들이는 것도 좋지 않다.
 */

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
:root{--bg:#f6f7f9;--fg:#1b1f24;--muted:#6b7480;--card:#fff;--line:#e3e6ea;
      --accent:#2f6f4f;--accent-fg:#fff;--danger:#b3261e;--ok:#1e7a45;--warn:#8a6100}
@media (prefers-color-scheme:dark){
  :root{--bg:#14171a;--fg:#e8eaed;--muted:#9aa3ad;--card:#1d2125;--line:#2c3238;
        --accent:#4c9c72;--accent-fg:#0d1210;--danger:#f2b8b5;--ok:#7bd4a0;--warn:#e5c07b}
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,"Segoe UI",
     "Noto Sans KR",sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:460px;margin:0 auto;padding:48px 20px 64px}
.wrap.wide{max-width:900px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px}
h1{font-size:1.3rem;margin:0 0 6px;letter-spacing:-.01em}
h2{font-size:1.05rem;margin:28px 0 10px}
.sub{color:var(--muted);font-size:.9rem;margin:0 0 22px}
label{display:block;font-size:.85rem;color:var(--muted);margin:14px 0 5px}
input[type=text],input[type=email],input[type=password]{width:100%;padding:10px 12px;font-size:1rem;
  font-family:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:8px}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
button{width:100%;margin-top:20px;padding:11px;font-size:1rem;font-family:inherit;font-weight:600;
  color:var(--accent-fg);background:var(--accent);border:0;border-radius:8px;cursor:pointer}
button:hover{filter:brightness(1.08)}
button.ghost{background:transparent;color:var(--muted);border:1px solid var(--line);font-weight:500}
.row{display:flex;gap:10px}.row button{margin-top:0}
.alert{margin:16px 0 0;padding:10px 12px;border-radius:8px;font-size:.88rem;
  background:color-mix(in srgb,var(--danger) 12%,transparent);color:var(--danger)}
.alert.ok{background:color-mix(in srgb,var(--ok) 14%,transparent);color:var(--ok)}
.alert.info{background:color-mix(in srgb,var(--warn) 14%,transparent);color:var(--warn)}
.foot{margin-top:22px;font-size:.85rem;color:var(--muted);text-align:center}
a{color:var(--accent)}
.brand{display:flex;align-items:center;gap:9px;margin-bottom:20px;font-weight:700;letter-spacing:-.02em}
.brand .dot{width:9px;height:9px;border-radius:50%;background:var(--accent)}
table{width:100%;border-collapse:collapse;font-size:.88rem;margin-top:6px}
th,td{text-align:left;padding:9px 8px;border-bottom:1px solid var(--line);vertical-align:middle}
th{color:var(--muted);font-weight:600;font-size:.78rem;text-transform:uppercase;letter-spacing:.04em}
.tag{display:inline-block;padding:2px 8px;border-radius:99px;font-size:.75rem;font-weight:600}
.tag.active{background:color-mix(in srgb,var(--ok) 18%,transparent);color:var(--ok)}
.tag.pending{background:color-mix(in srgb,var(--warn) 18%,transparent);color:var(--warn)}
.tag.disabled{background:color-mix(in srgb,var(--muted) 18%,transparent);color:var(--muted)}
.inline{display:inline}.inline button{width:auto;margin:0;padding:5px 11px;font-size:.8rem}
.scroll{overflow-x:auto}
.scope{margin:18px 0;padding:14px 16px;border-radius:10px;border:1px solid var(--line);background:var(--bg)}
.scope li{margin:3px 0;font-size:.88rem}
.scope ul{margin:8px 0 0;padding-left:20px}
`;

function layout(title, body, { wide = false } = {}) {
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style></head>
<body><div class="wrap${wide ? ' wide' : ''}">
<div class="brand"><span class="dot"></span>jw-mcp</div>
${body}
</div></body></html>`;
}

const alert = (msg, kind = '') => (msg ? `<div class="alert ${kind}">${escapeHtml(msg)}</div>` : '');

export function loginPage({ base, error = '', notice = '', next = '' } = {}) {
  return layout(
    'jw-mcp 로그인',
    `<div class="card">
  <h1>로그인</h1>
  <p class="sub">JW.org 콘텐츠 MCP 서비스</p>
  <form method="post" action="${base}/login">
    ${next ? `<input type="hidden" name="next" value="${escapeHtml(next)}">` : ''}
    <label for="email">이메일</label>
    <input id="email" type="email" name="email" autocomplete="username" required autofocus>
    <label for="password">비밀번호</label>
    <input id="password" type="password" name="password" autocomplete="current-password" required>
    <button type="submit">로그인</button>
  </form>
  ${alert(error)}${alert(notice, 'ok')}
  <div class="foot">계정이 없으신가요? <a href="${base}/signup">가입하기</a></div>
</div>`,
  );
}

export function signupPage({ base, error = '', inviteEnabled = false } = {}) {
  return layout(
    'jw-mcp 가입',
    `<div class="card">
  <h1>가입</h1>
  <p class="sub">가입 후 관리자 승인을 받으면 커넥터를 연결할 수 있습니다.</p>
  <form method="post" action="${base}/signup">
    <label for="name">이름</label>
    <input id="name" type="text" name="display_name" autocomplete="name" maxlength="80">
    <label for="email">이메일</label>
    <input id="email" type="email" name="email" autocomplete="username" required>
    <label for="password">비밀번호 (10자 이상)</label>
    <input id="password" type="password" name="password" autocomplete="new-password" required minlength="10">
    ${
      inviteEnabled
        ? `<label for="invite">초대 코드 <span style="font-weight:400">(있으면 즉시 사용 가능)</span></label>
    <input id="invite" type="text" name="invite_code" autocomplete="off">`
        : ''
    }
    <button type="submit">가입</button>
  </form>
  ${alert(error)}
  <div class="foot">이미 계정이 있으신가요? <a href="${base}/login">로그인</a></div>
</div>`,
  );
}

export function pendingPage({ base, user } = {}) {
  return layout(
    '승인 대기 중',
    `<div class="card">
  <h1>승인 대기 중</h1>
  <p class="sub">${escapeHtml(user?.email || '')}</p>
  <div class="alert info">가입이 접수되었습니다. 관리자가 승인하면 커넥터를 연결할 수 있습니다.</div>
  <div class="foot"><a href="${base}/login">로그인 화면으로</a></div>
</div>`,
  );
}

/** OAuth 동의 화면 — 이미 로그인한 사용자에게 연결 대상을 확인시킨다. */
export function consentPage({ base, user, clientName, hidden, toolCount } = {}) {
  return layout(
    'jw-mcp 연결 승인',
    `<div class="card">
  <h1>연결 승인</h1>
  <p class="sub"><strong>${escapeHtml(clientName || '알 수 없는 앱')}</strong> 이(가) jw-mcp 에 연결하려고 합니다.</p>
  <div class="scope">
    <strong style="font-size:.9rem">허용되는 작업</strong>
    <ul>
      <li>성경 구절·연구 노트 조회</li>
      <li>파수대·집회 워크북 기사 조회</li>
      <li>영상 자막·교과 내용 조회</li>
    </ul>
    <div style="margin-top:10px;font-size:.82rem;color:var(--muted)">
      도구 ${toolCount}종 · 읽기 전용 · JW.org 공개 자료만 사용합니다.
    </div>
  </div>
  <form method="post" action="${base}/authorize">
    ${hidden}
    <input type="hidden" name="decision" value="allow">
    <button type="submit">승인하고 연결</button>
  </form>
  <form method="post" action="${base}/authorize" style="margin-top:10px">
    ${hidden}
    <input type="hidden" name="decision" value="deny">
    <button type="submit" class="ghost">거부</button>
  </form>
  <div class="foot">${escapeHtml(user.display_name || user.email)} 계정으로 연결됩니다 ·
    <a href="${base}/logout">다른 계정</a></div>
</div>`,
  );
}

/** OAuth 흐름 안에서의 로그인 — 성공하면 곧바로 동의 화면으로 이어진다. */
export function authorizeLoginPage({ base, clientName, hidden, error = '' } = {}) {
  return layout(
    'jw-mcp 연결 승인',
    `<div class="card">
  <h1>로그인</h1>
  <p class="sub"><strong>${escapeHtml(clientName || '알 수 없는 앱')}</strong> 이(가) 연결을 요청했습니다.
     계속하려면 로그인하세요.</p>
  <form method="post" action="${base}/authorize">
    ${hidden}
    <input type="hidden" name="decision" value="login">
    <label for="email">이메일</label>
    <input id="email" type="email" name="email" autocomplete="username" required autofocus>
    <label for="password">비밀번호</label>
    <input id="password" type="password" name="password" autocomplete="current-password" required>
    <button type="submit">로그인하고 계속</button>
  </form>
  ${alert(error)}
  <div class="foot">계정이 없으신가요? <a href="${base}/signup">가입하기</a></div>
</div>`,
  );
}

const fmtDate = (ts) =>
  ts ? new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ') : '—';

export function accountPage({ base, user, connections = [], notice = '' } = {}) {
  const rows = connections.length
    ? connections
        .map(
          (c) => `<tr>
      <td>${escapeHtml(c.client_name || c.client_id)}</td>
      <td>${fmtDate(c.created_at)}</td>
      <td>${fmtDate(c.expires_at)}</td>
      <td style="text-align:right">
        <form class="inline" method="post" action="${base}/account/revoke">
          <input type="hidden" name="client_id" value="${escapeHtml(c.client_id)}">
          <button type="submit" class="ghost">연결 해제</button>
        </form>
      </td></tr>`,
        )
        .join('')
    : '<tr><td colspan="4" style="color:var(--muted)">연결된 앱이 없습니다.</td></tr>';

  return layout(
    '내 계정',
    `<div class="card">
  <h1>내 계정</h1>
  <p class="sub">${escapeHtml(user.display_name || '')} · ${escapeHtml(user.email)}
     · <span class="tag ${user.status}">${user.status}</span>${user.role === 'admin' ? ' · 관리자' : ''}</p>
  ${alert(notice, 'ok')}
  <h2>연결된 앱</h2>
  <div class="scroll"><table>
    <thead><tr><th>앱</th><th>연결일</th><th>만료</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
  <div class="foot">
    ${user.role === 'admin' ? `<a href="${base}/admin">관리자</a> · ` : ''}<a href="${base}/logout">로그아웃</a>
  </div>
</div>`,
    { wide: true },
  );
}

export function adminPage({ base, users = [], notice = '' } = {}) {
  const rows = users
    .map(
      (u) => `<tr>
    <td>${escapeHtml(u.display_name || '—')}<div style="color:var(--muted);font-size:.8rem">${escapeHtml(u.email)}</div></td>
    <td><span class="tag ${u.status}">${u.status}</span>${u.role === 'admin' ? ' <span class="tag">admin</span>' : ''}</td>
    <td>${u.call_count}</td>
    <td>${fmtDate(u.last_call_at)}</td>
    <td style="text-align:right">
      ${
        u.status === 'active'
          ? `<form class="inline" method="post" action="${base}/admin/status">
               <input type="hidden" name="user_id" value="${escapeHtml(u.user_id)}">
               <input type="hidden" name="status" value="disabled">
               <button type="submit" class="ghost">비활성화</button></form>`
          : `<form class="inline" method="post" action="${base}/admin/status">
               <input type="hidden" name="user_id" value="${escapeHtml(u.user_id)}">
               <input type="hidden" name="status" value="active">
               <button type="submit">승인</button></form>`
      }
    </td></tr>`,
    )
    .join('');

  return layout(
    '관리자',
    `<div class="card">
  <h1>사용자 관리</h1>
  <p class="sub">승인 대기 중인 계정이 위에 표시됩니다.</p>
  ${alert(notice, 'ok')}
  <div class="scroll"><table>
    <thead><tr><th>사용자</th><th>상태</th><th>호출</th><th>마지막 활동</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5" style="color:var(--muted)">사용자가 없습니다.</td></tr>'}</tbody>
  </table></div>
  <div class="foot"><a href="${base}/account">내 계정</a> · <a href="${base}/logout">로그아웃</a></div>
</div>`,
    { wide: true },
  );
}

export function errorPage(title, message, { base = '/jw' } = {}) {
  return layout(
    title,
    `<div class="card">
  <h1>${escapeHtml(title)}</h1>
  <div class="alert">${escapeHtml(message)}</div>
  <div class="foot"><a href="${base}/login">로그인 화면으로</a></div>
</div>`,
  );
}
