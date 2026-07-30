# jw-mcp 대시보드 연동 API 스펙

jw-mcp 가 외부(hosub 대시보드)에 게시하는 조회용 API 의 계약. **소비자 구현은 이
문서 범위 밖이다** — 여기 적힌 것은 엔드포인트·스키마·인증·오류 동작뿐이다.

이 문서에 실린 응답은 전부 실제 서버에서 뽑은 것이다.

---

## 1. 접속

| 항목 | 값 |
|---|---|
| 베이스 URL | `http://127.0.0.1:8604/api/dash` |
| 인증 | `X-Internal-Token: <JW_INTERNAL_TOKEN>` (모든 요청 필수) |
| 형식 | 요청/응답 모두 JSON (`POST` 는 `Content-Type: application/json`) |
| CORS | 열지 않음 — 브라우저에서 직접 부르지 말 것 |

### 노출 경계

이 API 는 **루프백에서만 보인다.** 서비스는 `127.0.0.1:8604` 에 바인딩되고,
Caddy 는 `/jw/*` 와 `/.well-known/oauth-*/jw*` 만 라우팅한다 — `/api/dash/*` 는
의도적으로 라우팅 대상이 아니다.

```
공인 인터넷 ──▶ Caddy ──▶ /jw/*  만 통과            (공개)
                          /api/dash/*  라우팅 없음   (비공개)

같은 호스트 프로세스 ──▶ http://127.0.0.1:8604/api/dash/*   ← 소비자는 여기로
```

따라서 소비자는 **같은 서버 안에서 서버사이드로** 호출해야 한다. Caddyfile 에
`/api/dash` 경로를 추가하면 이 경계가 무너진다.

토큰 비교는 타이밍 안전 비교를 쓴다. 토큰이 틀리거나 없으면:

```json
{ "ok": false, "error": "unauthorized" }
```
→ `401`

### 소비자 쪽 환경변수 (권장 이름)

```bash
HOSUB_JW_URL=http://127.0.0.1:8604
HOSUB_JW_TOKEN=<jw-mcp .env 의 JW_INTERNAL_TOKEN 과 같은 값>
```

값은 서버에서 확인한다: `sudo grep '^JW_INTERNAL_TOKEN=' /opt/jw-mcp/.env`

---

## 2. 엔드포인트 요약

| 메서드 | 경로 | 용도 |
|---|---|---|
| GET | `/summary` | 전체 요약 (+ 렌더용 `sections`) |
| GET | `/users` | 사용자 목록 |
| GET | `/usage?days=N` | 일자별·도구별 사용량 |
| GET | `/calls?limit=N` | 최근 도구 호출 로그 |
| POST | `/users/{user_id}/status` | 사용자 승인 / 비활성화 |

`user_id` 형식은 `u_` + 24자리 소문자 hex → 정규식 `^u_[0-9a-f]{24}$`

---

## 3. `GET /summary`

화면 하나를 채우는 데 필요한 모든 값. 소비자가 다른 엔드포인트를 부르지 않아도
되도록 설계했다.

### 3.1 `sections` — 렌더용 구조 ★

응답의 `sections` 는 **표시 순서대로 정렬된, 그대로 그릴 수 있는 카드 목록**이다.

```
sections: [
  {
    title: string,          // 카드 제목
    icon:  string,          // Bootstrap Icons 클래스명 (예: "bi-people")
    items: [
      { label: string, value: string|number, tone?: Tone }
    ]
  }
]

Tone = "ok" | "warn" | "danger" | "muted"   // 없으면 기본색
```

**이 구조를 쓰면 소비자는 지표를 알 필요가 없다.** `sections` 를 순회하며 카드를
그리고 `tone` 으로 색만 정하면, 이후 jw-mcp 가 지표를 추가·삭제·재정렬해도
소비자 코드는 그대로다.

> `sections` 는 **추가 전용**으로 관리한다. 새 섹션·항목은 늘어날 수 있지만
> 위 세 필드(`title`/`icon`/`items`)와 `Tone` 값 집합은 바꾸지 않는다.
> 원시 값을 직접 다루고 싶으면 같은 응답의 `users`·`tokens`·`calls` 등을 쓴다.

현재 나가는 섹션(예시일 뿐, 여기에 의존하지 말 것): 서비스 · 사용자 · OAuth ·
사용량 · 이번 연구 자료 · 많이 쓰는 도구(7일) · 최근 오류.
뒤 두 개는 **데이터가 있을 때만** 나타난다.

### 3.2 원시 필드

| 필드 | 타입 | 설명 |
|---|---|---|
| `ok` | bool | 항상 `true` (정상 응답 표식) |
| `service` | string | `"jw-mcp"` |
| `version` | string | 서비스 버전 |
| `uptime_s` | int | 프로세스 가동 초 |
| `tools` | int | 노출 중인 MCP 도구 수 |
| `users` | object | `{total, active, pending, disabled}` |
| `tokens` | object | `{access, refresh}` — 폐기·만료를 뺀 **유효** 토큰 수 |
| `clients` | int | 등록된 OAuth 클라이언트 수 |
| `calls` | object | `{today, week, errors_week, total}` |
| `top_tools` | array | `[{tool, n, avg_ms}]` 7일, 최대 5개 |
| `current.watchtower_issue` | string | 연구용 파수대 호 `YYYYMM00` |
| `current.workbook_issue` | string | 이번 달 워크북 호 `YYYYMM00` |
| `sections` | array | 위 3.1 |

시간 단위는 **초**, 타임스탬프는 **Unix epoch 초(소수 포함)** 다. 밀리초가 아니다.

### 3.3 실제 응답

```json
{
  "ok": true,
  "service": "jw-mcp",
  "version": "2.0.0",
  "uptime_s": 0,
  "tools": 11,
  "users":  { "total": 3, "active": 2, "pending": 1, "disabled": 0 },
  "tokens": { "access": 2, "refresh": 2 },
  "clients": 1,
  "calls":  { "today": 9, "week": 9, "errors_week": 1, "total": 9 },
  "top_tools": [
    { "tool": "search_bible_books",  "n": 7, "avg_ms": 5 },
    { "tool": "get_bible_verse_url", "n": 1, "avg_ms": 0 }
  ],
  "current": { "watchtower_issue": "20260500", "workbook_issue": "20260700" },
  "sections": [
    { "title": "서비스", "icon": "bi-hdd-network", "items": [
        { "label": "상태",      "value": "정상", "tone": "ok" },
        { "label": "버전",      "value": "2.0.0" },
        { "label": "가동 시간", "value": "0분" },
        { "label": "도구",      "value": "11종" } ] },
    { "title": "사용자", "icon": "bi-people", "items": [
        { "label": "활성",      "value": 2, "tone": "ok" },
        { "label": "승인 대기", "value": 1, "tone": "warn" },
        { "label": "비활성",    "value": 0, "tone": "muted" },
        { "label": "전체",      "value": 3 } ] },
    { "title": "OAuth", "icon": "bi-key", "items": [
        { "label": "유효 액세스 토큰",   "value": 2 },
        { "label": "유효 리프레시 토큰", "value": 2 },
        { "label": "등록 클라이언트",    "value": 1 } ] },
    { "title": "사용량", "icon": "bi-graph-up", "items": [
        { "label": "오늘 호출",     "value": 9 },
        { "label": "7일 호출",      "value": 9 },
        { "label": "7일 오류",      "value": 1, "tone": "warn" },
        { "label": "마지막 활동",   "value": "방금", "tone": "muted" } ] },
    { "title": "이번 연구 자료", "icon": "bi-book", "items": [
        { "label": "파수대",      "value": "2026년 5월호" },
        { "label": "집회 워크북", "value": "2026년 7월호" } ] },
    { "title": "많이 쓰는 도구 (7일)", "icon": "bi-tools", "items": [
        { "label": "search_bible_books", "value": "7회 · 5ms" } ] },
    { "title": "최근 오류", "icon": "bi-exclamation-triangle", "items": [
        { "label": "no_such_tool · 방금", "value": "Unknown tool: no_such_tool", "tone": "danger" } ] }
  ]
}
```

---

## 4. `GET /users`

`pending` 이 먼저, 그다음 가입 역순으로 정렬된다 — 승인 대기가 위로 온다.

| 필드 | 타입 | 설명 |
|---|---|---|
| `user_id` | string | `u_` + hex 24 |
| `email` | string | 로그인 이메일 |
| `display_name` | string | 표시 이름 (빈 문자열일 수 있음) |
| `status` | string | `pending` \| `active` \| `disabled` |
| `role` | string | `user` \| `admin` |
| `created_at` | float | 가입 시각 (epoch 초) |
| `last_login_at` | float\|null | 마지막 **브라우저** 로그인. 커넥터만 쓰면 `null` 이다 |
| `call_count` | int | 누적 도구 호출 수 |
| `last_call_at` | float\|null | 마지막 도구 호출 시각 |
| `active_tokens` | int | 유효 액세스 토큰 수 (= 연결된 앱 수) |

비밀번호 해시·salt 는 **어떤 응답에도 실리지 않는다.**

```json
{
  "ok": true,
  "users": [
    { "user_id": "u_4196f60425d3fcb8eb59f26b", "email": "sister@example.com",
      "display_name": "이자매", "status": "pending", "role": "user",
      "created_at": 1785421558.871, "last_login_at": null,
      "call_count": 0, "last_call_at": null, "active_tokens": 0 },
    { "user_id": "u_f6e7306d536ed43d4fc0e822", "email": "brother@example.com",
      "display_name": "김형제", "status": "active", "role": "user",
      "created_at": 1785421558.772, "last_login_at": 1785421559.087,
      "call_count": 3, "last_call_at": 1785421559.19, "active_tokens": 1 },
    { "user_id": "u_63b327579fba0b8d39dc9d7c", "email": "haeun@example.com",
      "display_name": "하은", "status": "active", "role": "admin",
      "created_at": 1785421558.651, "last_login_at": null,
      "call_count": 6, "last_call_at": 1785421559.185, "active_tokens": 1 }
  ]
}
```

---

## 5. `GET /usage?days=N`

`days` 기본 7, 범위 1–90 (벗어나면 잘려서 적용된다). `daily` 는 **호출이 있었던
날만** 나온다 — 빈 날은 소비자가 채워야 한다. `day` 는 서버 로컬 시간 기준
`YYYY-MM-DD` 다.

```json
{
  "ok": true,
  "days": 7,
  "daily": [
    { "day": "2026-07-30", "calls": 9, "errors": 1, "users": 2 }
  ],
  "top_tools": [
    { "tool": "search_bible_books",  "n": 7, "avg_ms": 5 },
    { "tool": "get_bible_verse_url", "n": 1, "avg_ms": 0 }
  ]
}
```

`daily[].users` 는 그날 호출한 **고유 사용자 수**, `top_tools` 는 최대 10개.

---

## 6. `GET /calls?limit=N`

최근 호출부터 내림차순. `limit` 기본 50, 범위 1–500.

| 필드 | 타입 | 설명 |
|---|---|---|
| `id` | int | 증가하는 호출 일련번호 |
| `tool` | string | 도구 이름 |
| `ok` | int | `1` 성공 / `0` 실패 (**boolean 이 아니라 정수**) |
| `duration_ms` | int | 소요 시간 |
| `error` | string\|null | 실패 사유 (최대 300자) |
| `created_at` | float | epoch 초 |
| `email` / `display_name` | string\|null | 호출자. 계정이 삭제되면 `null` |

**도구 인자는 기록하지 않는다** — 누가 어떤 구절을 찾아봤는지까지 남길 이유가
없다. 따라서 이 API 로 그 정보를 얻을 수 없다.

```json
{
  "ok": true,
  "calls": [
    { "id": 9, "tool": "no_such_tool", "ok": 0, "duration_ms": 1,
      "error": "Unknown tool: no_such_tool", "created_at": 1785421559.19,
      "email": "brother@example.com", "display_name": "김형제" },
    { "id": 8, "tool": "get_bible_verse_url", "ok": 1, "duration_ms": 0,
      "error": null, "created_at": 1785421559.185,
      "email": "haeun@example.com", "display_name": "하은" }
  ]
}
```

---

## 7. `POST /users/{user_id}/status`

사용자 승인·비활성화. 이 API 의 **유일한 변경 작업**이다.

```http
POST /api/dash/users/u_f6e7306d536ed43d4fc0e822/status
X-Internal-Token: <토큰>
Content-Type: application/json

{ "status": "active" }
```

`status` 는 `pending` | `active` | `disabled`.

성공 `200` — 변경된 사용자 객체를 돌려준다:

```json
{ "ok": true,
  "user": { "user_id": "u_f6e7306d536ed43d4fc0e822", "email": "brother@example.com",
            "display_name": "김형제", "status": "active", "role": "user",
            "created_at": 1785421558.772, "last_login_at": 1785421559.087 } }
```

실패 `400`:

```json
{ "ok": false, "error": "마지막 활성 관리자는 비활성화할 수 없습니다." }
```

### 부수 효과 (중요)

`active` 가 **아닌** 상태로 바꾸면 그 사용자의 **모든 OAuth 토큰이 즉시 폐기된다.**
연결돼 있던 Claude 커넥터는 다음 요청부터 `401` 을 받고, 리프레시로도 되살아나지
않는다. 되돌리려면 `active` 로 바꾼 뒤 **사용자가 커넥터를 다시 연결**해야 한다.

거부되는 경우:
- 마지막 활성 관리자를 `active` 아닌 값으로 바꾸려 할 때 (자기 잠금 방지)
- 없는 `user_id`
- 알 수 없는 `status` 값

---

## 8. 오류 동작

| 상황 | 상태 | 본문 |
|---|---|---|
| 토큰 없음/불일치 | `401` | `{"ok": false, "error": "unauthorized"}` |
| 잘못된 요청 | `400` | `{"ok": false, "error": "<사유>"}` |
| 서비스 중지 | — | TCP 연결 거부 |

**소비자는 jw-mcp 가 꺼져 있어도 깨지지 않아야 한다.** 별개 프로세스라 따로 죽거나
배포 중 잠깐 내려간다. 연결 실패는 잡아서 안내 문구로 처리할 것을 권한다.

성공 응답은 전부 `ok: true` 를 포함하므로, 이 값 하나로 정상/오류를 가를 수 있다.

폴링 주기는 **60초 이상**을 권한다. 모든 지표가 로컬 SQLite 조회라 가볍지만,
실시간성이 필요한 데이터가 아니다.

---

## 9. 스모크 테스트

```bash
JW_TOKEN=$(sudo grep '^JW_INTERNAL_TOKEN=' /opt/jw-mcp/.env | cut -d= -f2)

curl -s -H "X-Internal-Token: $JW_TOKEN" http://127.0.0.1:8604/api/dash/summary | jq '.sections[].title'
curl -s -H "X-Internal-Token: $JW_TOKEN" http://127.0.0.1:8604/api/dash/users   | jq '.users[] | {email, status}'
curl -s -H "X-Internal-Token: $JW_TOKEN" http://127.0.0.1:8604/api/dash/usage?days=7 | jq .daily
curl -s -H "X-Internal-Token: $JW_TOKEN" http://127.0.0.1:8604/api/dash/calls?limit=5 | jq '.calls[] | {tool, ok, email}'

# 토큰 없이 → 401
curl -s http://127.0.0.1:8604/api/dash/summary

# ★ 공인 인터넷에서는 닿지 않아야 한다
curl -s -o /dev/null -w '%{http_code}\n' https://hosub.duckdns.org/api/dash/summary   # 404
```

---

## 10. 서비스 등록 (선택)

hosub 의 `config/registry.yaml` 에 아래를 넣으면 기존 "서비스" 패널에 상태가 뜨고
`restart_service` · `read_service_logs` · `deploy_service` MCP 도구가 동작한다.
대시보드 페이지와는 별개이며, 이것만 해도 운영 관측은 된다.

```yaml
  jw-mcp:
    unit: jw-mcp.service
    description: "JW.org 콘텐츠 MCP (127.0.0.1:8604 — 자체 OAuth 2.1, /opt/jw-mcp 독립 클론)"
    deploy:
      workdir: /opt/jw-mcp
      steps:
        - ["git", "pull", "--ff-only"]
        - ["npm", "ci", "--omit=dev"]
      restart_after: true
      timeout_seconds: 600
```

---

## 11. 스펙 변경 정책

- `sections` 의 섹션·항목은 **예고 없이 늘거나 줄 수 있다.** 특정 `title` 의 존재를
  가정하지 말 것.
- 위 표에 적힌 **원시 필드는 제거·개명하지 않는다.** 추가는 가능하다.
- `Tone` 값 집합(`ok`/`warn`/`danger`/`muted`)과 `sections` 항목 구조는 고정이다.
- 호환을 깨는 변경이 필요하면 경로에 버전을 붙인다(`/api/dash/v2/...`).

서버 쪽 구현은 `src/dash/api.js` 한 파일이다. 새 지표는 그 안의 `summary()` 에만
추가하면 되고, 소비자 코드는 건드리지 않아도 된다.
