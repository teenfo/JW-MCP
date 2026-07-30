# jw-mcp

JW.org 공개 자료(성경·파수대·집회 워크북·영상 자막·교과)를 Claude 에서 대화로 쓰기 위한
**원격 MCP 서버**. 자체 OAuth 2.1 인증(다중 사용자)을 갖추고 hosub 홈서버에서 독립
프로세스로 돈다.

상류 [`advenimus/jw-mcp`](https://github.com/advenimus/jw-mcp) 의 도구 구현을 이어받되,
Smithery 호스팅 전제를 걷어내고 **자체 호스팅 + 인증 + 운영 관측**을 붙였다.

## 특징

- **도구 11종** — 성경 구절·연구 노트, 파수대, 집회 워크북, 영상 자막, 교과
- **자체 OAuth 2.1** — hosub 의 인증과 코드·DB·issuer 를 전혀 공유하지 않는다
- **다중 사용자** — 가입 → 관리자 승인 → 커넥터 연결. 계정을 끄면 토큰이 즉시 죽는다
- **경로 분리 배치** — `hosub.duckdns.org/jw` 하나로 기존 서비스와 도메인을 공유
- **대시보드 API** — hosub 대시보드가 그대로 그릴 수 있는 형태로 지표를 내보낸다
- **이중 진입점** — 원격(HTTP+OAuth)과 로컬(stdio, 인증 없음)을 같은 도구 목록으로

## 도구

| 도구 | 설명 |
|---|---|
| `search_bible_books` | 성경 책 이름 검색 (한/영) |
| `get_bible_verse` | 구절 본문 조회 |
| `get_verse_with_study` | 구절 + 연구 노트 + 상호 참조 |
| `get_bible_verse_url` | jw.org finder 링크 생성 |
| `getWatchtowerLinks` | 연구용 파수대 기사 목록 (현재 호 자동 계산) |
| `getWatchtowerContent` | 파수대 기사 본문 (RTF → 평문) |
| `getWorkbookLinks` | 집회 워크북 주차 목록 |
| `getWorkbookContent` | 워크북 주차 본문 (RTF → 평문) |
| `get_lesson_list` | 교과 과 목록 |
| `get_lesson_content` | 교과 본문 |
| `get_jw_captions` | 영상 자막 (ID 또는 URL) |

성경 책 번호는 1–39(구약) / 40–66(신약). 파수대는 **현재 월 −2개월**이 연구용 호다
(2026년 7월 → 2026년 5월호). 언어는 `langwritten` 으로 바꾼다(`E` 기본, `K` 한국어).

## 아키텍처

```
[claude.ai / 모바일 앱]
      │ Custom Connector (OAuth 2.1 + PKCE)
      ▼
[Caddy · hosub.duckdns.org]
      ├─ /jw/*                          ──▶ jw-mcp  127.0.0.1:8604   ← 이 저장소
      ├─ /.well-known/oauth-*/jw...     ──▶ jw-mcp  127.0.0.1:8604
      ├─ / · /api/* · /static/*         ──▶ hosub 대시보드 :8701
      └─ (그 외)                         ──▶ hosub MCP :8700

[hosub 대시보드 :8701] ──▶ http://127.0.0.1:8604/api/dash/*   (Caddy 미라우팅 = 비공개)
```

jw-mcp 는 hosub 과 **호스트만 공유한다.** 프로세스·저장소·DB·OAuth issuer·실행 계정이
전부 분리되어 있어, 한쪽을 배포하거나 껐다 켜도 다른 쪽 세션이 끊기지 않는다.

### 인증 경계

| 경계 | 자격증명 | 쓰이는 곳 |
|---|---|---|
| MCP 도구 호출 | OAuth 2.1 Bearer (사용자 계정에 바인딩) | `POST /jw/mcp` |
| 브라우저 로그인 | 서명 세션 쿠키 (`Path=/jw`) | 계정·관리자 화면 |
| 대시보드 조회 | `X-Internal-Token` + 루프백 전용 | `/api/dash/*` |

셋은 서로를 대신하지 못한다. 특히 세션 쿠키로는 `/jw/mcp` 에 접근할 수 없다.

## 다중 사용자 정책

```
가입 → status=pending → 관리자 승인 → active → 커넥터 연결 가능
```

- **최초 가입자**는 자동으로 관리자 겸 활성 사용자가 된다(그러지 않으면 아무도 아무를
  승인할 수 없다). `JW_ADMIN_EMAILS` 로 추가 관리자를 지정할 수 있다.
- `JW_INVITE_CODE` 를 설정하면 코드를 아는 사람은 승인 없이 바로 쓴다.
- 계정을 `disabled` 로 바꾸면 **이미 발급된 토큰이 그 즉시 전부 무효**가 된다
  (Bearer 검증이 매 요청 계정 상태를 확인한다). 리프레시로도 되살아나지 않는다.
- 마지막 활성 관리자는 비활성화할 수 없다 — 자기 자신을 잠그는 사고 방지.

## 설치

서버 설치 절차는 **[`docs/SETUP.md`](docs/SETUP.md)** 를 따른다. 요약:

```bash
sudo git clone https://github.com/teenfo/JW-MCP.git /opt/jw-mcp
sudo bash /opt/jw-mcp/deploy/bootstrap.sh     # 유저·의존성·.env·systemd 자동 준비
# 출력되는 안내대로 Caddy 스니펫 반영 → /jw/signup 에서 첫 계정 생성
```

`main` 에 머지하면 `jw-mcp-update.timer` 가 5분 내 자동 배포한다(pull 기반).

## 로컬 개발

```bash
npm install
npm test                 # 도구 레지스트리 단위 테스트 (네트워크 불필요)
npm run test:oauth       # OAuth 전 구간 통합 테스트 (서버를 직접 띄운다)

JW_SESSION_SECRET=$(openssl rand -hex 32) \
JW_INTERNAL_TOKEN=$(openssl rand -hex 32) \
JW_SECURE_COOKIES=false \
npm run start:http       # http://127.0.0.1:8604/jw/signup
```

로컬 Claude Desktop 은 인증 없이 stdio 로 붙일 수 있다:

```json
{ "mcpServers": { "jw": { "command": "node", "args": ["/path/to/JW-MCP/src/index.js"] } } }
```

## 도구를 추가할 때

`src/tools/registry.js` **한 곳만** 고치면 stdio·HTTP 양쪽에 동시에 반영된다.
상류처럼 진입점마다 배열을 따로 들고 있지 않으므로 한쪽만 고쳐 누락되는 일이 없다.

1. `src/tools/<이름>.js` 에 도구 정의 + 구현 + 핸들러(자기 도구가 아니면 `null` 반환)
2. `src/tools/registry.js` 의 `allTools` 와 `toolHandlers` 에 추가
3. `tests/registry.test.js` 의 도구 개수 갱신

## 문서

- [`docs/SETUP.md`](docs/SETUP.md) — 서버 설치·Caddy 반영·대시보드 연동 런북
- [`docs/DASHBOARD-API.md`](docs/DASHBOARD-API.md) — 대시보드 연동 API 스펙 (소비자 구현용 계약)
- [`docs/UPSTREAM-README.md`](docs/UPSTREAM-README.md) — 상류 저장소 원문 (도구 상세)
- [`CLAUDE.md`](CLAUDE.md) — Claude Code 용 저장소 안내

## 라이선스

MIT. JW.org 공개 자료를 조회할 뿐이며 어떤 콘텐츠도 재배포하지 않는다.
이 저장소는 Watch Tower Bible and Tract Society 와 무관한 비공식 프로젝트다.
