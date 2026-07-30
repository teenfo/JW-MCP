# CLAUDE.md

Claude Code 가 이 저장소에서 작업할 때 참고할 안내.

## 이 저장소가 무엇인가

JW.org 공개 자료를 조회하는 **원격 MCP 서버**. hosub 홈서버에서 독립 프로세스로 돌며
**자체 OAuth 2.1(다중 사용자)** 로 인증한다.

상류 `advenimus/jw-mcp` 의 도구 구현을 이어받되, Smithery 호스팅 전제를 걷어내고
인증·다중 사용자·운영 관측을 붙였다. 상류 문서는 `docs/UPSTREAM-README.md` 에 있다.

## 구조

```
src/
├── index.js              stdio 진입점 (로컬 Claude Desktop, 인증 없음)
├── http-server.js        HTTP 진입점 (원격, OAuth Bearer 강제) + 라우팅 조립
├── tools/
│   ├── registry.js       ★ 도구 목록·핸들러의 유일한 정의처
│   ├── scripture-tools.js  bible-books.js  wol-scraper.js
│   ├── watchtower-tools.js workbook-tools.js lesson-tools.js
│   ├── captions-tool.js
│   └── rtf-parser.js     rtf-utils.js
├── auth/
│   ├── db.js             SQLite 스키마 (사용자·클라이언트·코드·토큰·사용량)
│   ├── users.js          가입·비밀번호(scrypt)·승인·상태 전이
│   ├── session.js        브라우저 세션 (무상태 서명 쿠키)
│   └── oauth.js          OAuth 2.1 인증 서버 + 계정/관리자 라우트
├── dash/api.js           대시보드용 내부 API (/api/dash/*)
└── web/pages.js          로그인·가입·동의·계정·관리자 HTML
```

## 도구를 추가할 때

**`src/tools/registry.js` 한 곳만 고친다.** 두 진입점이 이 파일을 import 하므로
한쪽만 고쳐 누락되는 일이 구조적으로 없다.

> 상류는 `index.js` 와 `http-server.js` 가 각자 `allTools` 배열을 들고 있어서,
> 실제로 `lesson-tools` 2종이 HTTP 서버에서만 빠져 있었다. 그 사고를 막으려고
> 레지스트리를 분리했다. **진입점에 도구 배열을 다시 만들지 말 것.**

1. `src/tools/<이름>.js` — 도구 정의 + 구현 + 핸들러
   (핸들러는 자기 도구가 아니면 반드시 `null` 을 반환한다)
2. `src/tools/registry.js` 의 `allTools` / `toolHandlers` 에 추가
3. `tests/registry.test.js` 의 도구 개수 갱신

도구 응답 형식: `{ content: [{ type: 'text', text: '...' }], isError?: true }`

## 인증을 건드릴 때 지켜야 할 계약

이 셋은 회귀 테스트(`npm run test:oauth`)로 못 박혀 있다. 깨뜨리지 말 것.

1. **계정 비활성화 = 즉시 접근 차단.** Bearer 검증이 매 요청 `users.status='active'` 를
   조인 확인한다. 성능을 이유로 이 조인을 캐시하면 "내보낸 사람이 계속 쓰는" 구멍이 난다.
2. **401 에는 항상 `WWW-Authenticate: Bearer resource_metadata="..."`.**
   이게 없으면 클라이언트가 루트 `/.well-known` 으로 폴백해 **옆 서비스인 hosub 의
   인증 서버**를 찾아간다(같은 호스트를 공유하는 경로 분리 배치라서 그렇다).
3. **PKCE S256 강제 · 인가 코드 1회용.** 코드가 재사용되면 탈취로 보고 해당
   사용자·클라이언트의 토큰을 전부 폐기한다(OAuth 2.1 권고).

## 경로 분리 (`/jw`)

`hosub.duckdns.org` 를 hosub 과 공유하므로 OAuth 문서가 섞이면 안 된다.

| 문서 | 경로 | 마운트 위치 |
|---|---|---|
| AS 메타데이터 (RFC 8414) | `/.well-known/oauth-authorization-server/jw` | `http-server.js` 루트 |
| 보호 리소스 (RFC 9728) | `/.well-known/oauth-protected-resource/jw/mcp` | `http-server.js` 루트 |
| 폴백 | `/jw/.well-known/*` | `oauth.js` 라우터 |

정본 두 개는 **루트에 있어야 하므로** basePath 라우터 안에 넣을 수 없다.
Caddy 도 이 경로들을 따로 라우팅해야 한다 → `deploy/Caddyfile.snippet`.

`JW_BASE_PATH` 를 바꾸면 Caddy 스니펫도 함께 고쳐야 한다.

## 대시보드 API

`/api/dash/summary` 는 원시 필드와 함께 **렌더 즉시 가능한 `sections` 배열**을 준다.
hosub 대시보드는 그걸 그리는 범용 렌더러일 뿐이라, **지표를 추가해도 hosub 저장소를
건드릴 필요가 없다.** 새 지표는 `src/dash/api.js` 의 `summary()` 에만 추가한다.

이 라우터는 basePath 바깥에 마운트되고 Caddy 가 라우팅하지 않는다 —
공인 인터넷에서 닿지 않는 것이 설계다. `deploy/Caddyfile.snippet` 에 `/api/dash` 를
추가하지 말 것.

## 테스트

```bash
npm test           # 도구 레지스트리 (네트워크 불필요, 빠름)
npm run test:oauth # OAuth 전 구간 — 서버를 띄우고 커넥터 흐름을 그대로 재현
```

인증 코드를 고쳤으면 **반드시** `npm run test:oauth` 를 돌린다.

## 배포

`main` 머지 → `jw-mcp-update.timer` 가 5분 내 자동 반영(pull 기반).
서버 절차는 `docs/SETUP.md`.

대시보드 화면은 **이 저장소의 책임이 아니다.** jw-mcp 는 `/api/dash/*` 를 게시할
뿐이고 소비자(hosub 대시보드)는 별도 저장소에서 따로 구현한다. 그 경계의 계약이
`docs/DASHBOARD-API.md` 이며, 응답 형식을 바꿀 때는 그 문서의 11절(변경 정책)을
지킨다 — 원시 필드는 제거·개명하지 않고, `sections` 항목 구조와 `tone` 값 집합은
고정이다.

## 주의

- jw.org(wol.jw.org)는 10~15초까지 느릴 수 있다. `callTool` 이 20초 상한을 씌운다.
- 파수대 호수는 **현재 월 −2개월**이 연구용이다(`rtf-utils.js`의 `getCurrentWatchtowerIssue`).
- 사용량 기록에 **도구 인자를 저장하지 않는다** — 누가 어떤 구절을 찾아봤는지까지
  남길 이유가 없다. 도구 이름·성공여부·소요시간만 남긴다.
