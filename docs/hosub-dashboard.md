# hosub 대시보드 연동

jw-mcp 는 **별도 저장소·별도 프로세스**다. 대시보드에 정보를 띄우려면 `teenfo/hosub-mcp`
쪽에도 최소한의 변경이 필요하다. 이 문서는 그 변경 내용을 담는다 (별도 PR).

## 설계 원칙 — hosub 은 "단순 게시"만 한다

지표를 무엇으로 잡을지, 어떻게 표현할지는 **전부 jw-mcp 가 정한다.**
`/api/dash/summary` 가 렌더 즉시 가능한 `sections` 배열을 돌려주기 때문이다:

```json
{
  "sections": [
    { "title": "사용자", "icon": "bi-people",
      "items": [
        { "label": "활성",      "value": 3, "tone": "ok" },
        { "label": "승인 대기", "value": 1, "tone": "warn" }
      ] }
  ]
}
```

hosub 쪽 페이지는 이 배열을 카드로 그리는 **범용 렌더러**이기만 하면 된다.
그래서 나중에 jw-mcp 가 지표를 더하거나 빼도 **hosub 저장소를 다시 건드릴 필요가 없다.**

`tone` 은 `ok` / `warn` / `danger` / `muted` 네 가지이며, 없으면 기본 색으로 그린다.

## 변경 1 — `config/registry.yaml`

`services:` 아래에 추가. 이것만으로 기존 "서비스" 패널에 상태가 뜨고
`restart_service` · `read_service_logs` · `deploy_service` MCP 도구가 동작한다.

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

## 변경 2 — `src/dashboard.py` 프록시

기존 `api_tnm` 과 같은 패턴(allowlist 정규식 + `X-Internal-Token`). 모듈 상단:

```python
# jw-mcp(JW.org 콘텐츠 MCP) 프록시 — trading·tnm 과 동일 패턴.
# 자체 OAuth 를 가진 완전히 별도의 서비스라, 대시보드는 조회용 API 만 게시한다.
JW_URL = os.environ.get("HOSUB_JW_URL", "http://127.0.0.1:8604")
JW_TOKEN = os.environ.get("HOSUB_JW_TOKEN", "")

_JW_GET_RE = re.compile(r"^(summary|users|usage|calls)$")
# 사용자 승인/비활성화만 허용한다 — 그 외 변경은 jw-mcp 자체 관리자 화면의 몫.
_JW_POST_RE = re.compile(r"^users/u_[0-9a-f]{24}/status$")
```

`build_routes` 안에 핸들러 추가:

```python
    async def api_jw(request):
        if (d := _require_auth_json(request)):
            return d
        path = request.path_params["path"]
        allowed = (
            _JW_GET_RE.match(path)
            if request.method == "GET"
            else _JW_POST_RE.match(path)
        )
        if not allowed:
            return JSONResponse({"error": "not allowed"}, status_code=404)
        try:
            body = await request.body()
            headers = {"X-Internal-Token": JW_TOKEN}
            if body:
                headers["Content-Type"] = request.headers.get(
                    "content-type", "application/json"
                )
            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.request(
                    request.method,
                    f"{JW_URL}/api/dash/{path}",
                    params=dict(request.query_params),
                    content=body,
                    headers=headers,
                )
            return JSONResponse(resp.json(), status_code=resp.status_code)
        except Exception as exc:  # 서비스 다운 시 graceful
            return JSONResponse({"error": f"jw-mcp 서비스 연결 실패: {exc}"}, status_code=502)
```

라우트 목록에 한 줄:

```python
        Route("/api/jw/{path:path}", api_jw, methods=["GET", "POST"]),
```

## 변경 3 — `static/pages/jw.js` (신규) + `index.js` 한 줄

`sections` 를 그대로 카드로 그리는 범용 렌더러. 전체 소스는 이 저장소의
[`docs/snippets/hosub-jw-page.js`](snippets/hosub-jw-page.js) 에 있다.

`static/pages/index.js`:

```js
import jw from "./jw.js";
// ...
export const PAGES = [dashboard, trading, /* ... */, briefing, weather, jw, docker];
```

## 변경 4 — `.env` (서버에서 직접)

```bash
HOSUB_JW_URL=http://127.0.0.1:8604
HOSUB_JW_TOKEN=<jw-mcp 의 JW_INTERNAL_TOKEN 과 같은 값>
```

`.env.example` 에도 같은 항목을 주석과 함께 추가한다.

## 확인

```bash
sudo systemctl restart hosub-dash
# 대시보드 로그인 후 사이드바 "JW" 페이지
curl -s -H "X-Internal-Token: $JW_TOKEN" http://127.0.0.1:8604/api/dash/summary | jq .sections
```

jw-mcp 가 꺼져 있어도 대시보드는 502 를 받아 안내 문구를 띄울 뿐 깨지지 않는다.
