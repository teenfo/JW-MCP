// hosub-mcp 저장소의 static/pages/jw.js 로 복사해 넣는다.
//
// jw-mcp(별도 서비스, 자체 OAuth)의 상태를 게시하는 페이지.
//
// ⚠️ 이 파일은 **지표를 알지 못한다.** /api/dash/summary 가 돌려주는 sections 배열을
//    그대로 카드로 그릴 뿐이다. 그래서 jw-mcp 가 지표를 추가·변경해도 이 파일은
//    고칠 필요가 없다 — 두 저장소의 결합을 얇게 유지하는 지점이다.
//
// sections: [{ title, icon, items: [{ label, value, tone }] }]
// tone: ok | warn | danger | muted | (없음)

import { fetchJSON, el } from "../app.js";

const TONE_CLASS = {
  ok: "text-success",
  warn: "text-warning",
  danger: "text-danger",
  muted: "text-secondary",
};

function sectionCard(section) {
  const rows = (section.items || []).map((item) =>
    el("div", { class: "d-flex justify-content-between align-items-baseline py-1" }, [
      el("span", { class: "text-secondary small" }, String(item.label ?? "")),
      el("span", { class: `fw-medium ${TONE_CLASS[item.tone] || ""}` }, String(item.value ?? "")),
    ]),
  );

  return el("div", { class: "col-12 col-md-6 col-xl-4" },
    el("div", { class: "card shadow-sm h-100" }, [
      el("div", { class: "card-header" },
        el("span", { html: `<i class="bi ${section.icon || "bi-dot"}"></i> ${section.title || ""}` })),
      el("div", { class: "card-body py-2" }, rows),
    ]),
  );
}

function usersTable(users) {
  const head = el("tr", {}, ["사용자", "상태", "유효 토큰", "호출", "마지막 활동"].map(
    (h) => el("th", { class: "small text-secondary" }, h)));

  const fmt = (ts) => (ts ? new Date(ts * 1000).toLocaleString("ko-KR") : "—");
  const badge = { active: "success", pending: "warning", disabled: "secondary" };

  const rows = users.map((u) =>
    el("tr", {}, [
      el("td", {}, [
        el("div", {}, u.display_name || u.email),
        el("div", { class: "small text-secondary" }, u.email),
      ]),
      el("td", {}, el("span", { class: `badge bg-${badge[u.status] || "secondary"}` }, u.status)),
      el("td", {}, String(u.active_tokens ?? 0)),
      el("td", {}, String(u.call_count ?? 0)),
      el("td", { class: "small text-secondary" }, fmt(u.last_call_at)),
    ]),
  );

  return el("div", { class: "col-12" },
    el("div", { class: "card shadow-sm" }, [
      el("div", { class: "card-header" },
        el("span", { html: '<i class="bi bi-person-check"></i> 사용자' })),
      el("div", { class: "card-body py-2" },
        // 좁은 화면에서 표가 페이지 전체를 가로로 밀지 않게 카드 안에서만 스크롤시킨다.
        el("div", { style: "overflow-x:auto" },
          el("table", { class: "table table-sm align-middle mb-0" }, [
            el("thead", {}, head),
            el("tbody", {}, rows.length ? rows
              : el("tr", {}, el("td", { colspan: "5", class: "text-secondary" }, "사용자가 없습니다."))),
          ]))),
    ]),
  );
}

export default {
  id: "jw",
  title: "JW",
  icon: "bi-book",

  async render(container, ctx) {
    const row = el("div", { class: "row g-3", id: "jw-row" });
    container.appendChild(row);

    const load = async () => {
      const [summary, users] = await Promise.all([
        fetchJSON("/api/jw/summary").catch((e) => ({ error: String(e) })),
        fetchJSON("/api/jw/users").catch(() => ({ users: [] })),
      ]);

      row.innerHTML = "";

      // jw-mcp 는 독립 서비스라 따로 죽을 수 있다 — 대시보드는 그걸 안내만 하고 살아 있는다.
      if (!summary || summary.error || summary.ok === false) {
        row.appendChild(
          el("div", { class: "col-12" },
            el("div", { class: "alert alert-warning mb-0" }, [
              el("strong", {}, "jw-mcp 서비스에 연결할 수 없습니다. "),
              el("span", { class: "small" }, summary?.error || "서비스가 꺼져 있거나 내부 토큰이 맞지 않습니다."),
              el("div", { class: "small mt-2 text-secondary" },
                "확인: systemctl status jw-mcp · /opt/hosub-mcp/.env 의 HOSUB_JW_TOKEN"),
            ])),
        );
        return;
      }

      for (const section of summary.sections || []) row.appendChild(sectionCard(section));
      row.appendChild(usersTable(users.users || []));
    };

    await load();
    ctx.addTimer(setInterval(load, 60000)); // 1분마다
  },
};
