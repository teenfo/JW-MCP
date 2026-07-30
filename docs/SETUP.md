# jw-mcp 설치 런북

hosub 홈서버(Ubuntu, 192.168.0.3)에 jw-mcp 를 올리는 절차. **운영 중인 서비스가 도는
서버**이므로 각 단계에 회귀 확인이 붙어 있다.

전제: hosub-mcp(:8700)·대시보드(:8701)·trading(:8600)·tnm(:8602)·llm-gateway(:8603)가
이미 돌고 있고, Caddy 가 `hosub.duckdns.org` 로 TLS 종단을 맡고 있다.

---

## 0. 사전 확인

```bash
ss -ltnp | grep -E ':(86|87)[0-9]{2}'   # 8604 가 비어 있어야 한다
node --version                           # 없으면 아래 1단계
```

## 1. Node 런타임 (서버에 없으면)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # v22.x
```

> `better-sqlite3` 은 보통 prebuilt 바이너리를 받아 컴파일하지 않는다. 빌드로 떨어져도
> 서버에 `python3`·`make`·`g++` 가 이미 있어 그대로 성공한다.

## 2. 클론 + 부트스트랩

```bash
sudo git clone https://github.com/teenfo/JW-MCP.git /opt/jw-mcp
sudo bash /opt/jw-mcp/deploy/bootstrap.sh
```

부트스트랩이 하는 일: `jwmcp` 전용 유저 생성 · `npm ci` · 시크릿이 채워진 `.env` 생성 ·
systemd 유닛 3개 배치 · 재시작 전용 sudoers 한 줄 · 서비스 기동 · 헬스체크.

확인:

```bash
systemctl status jw-mcp --no-pager
curl -s http://127.0.0.1:8604/jw/health
# {"status":"healthy","service":"jw-mcp","version":"2.0.0","tools":11}
```

## 3. Caddy 반영 ⚠️ 운영 라우팅을 건드리는 단계

```bash
sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak.$(date +%Y%m%d-%H%M%S)
sudo nano /etc/caddy/Caddyfile
```

`hosub.duckdns.org { ... }` 블록 안, **`@dash path / /login ...` 줄 바로 앞**에
[`deploy/Caddyfile.snippet`](../deploy/Caddyfile.snippet) 내용을 붙여넣는다.
맨 끝 catch-all `handle`(:8700)보다 반드시 앞이어야 한다.

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

**회귀 확인 — 기존 서비스가 그대로인지 먼저 본다:**

```bash
# 대시보드 로그인 화면이 뜬다
curl -s -o /dev/null -w '%{http_code}\n' https://hosub.duckdns.org/login          # 200

# ★ 루트 OAuth 메타데이터는 여전히 hosub 것이어야 한다 (jw 가 가로채면 안 된다)
curl -s https://hosub.duckdns.org/.well-known/oauth-authorization-server | grep -o '"issuer":"[^"]*"'
# → "issuer":"https://hosub.duckdns.org"     (끝에 /jw 가 붙으면 라우팅이 잘못된 것)
```

**신규 경로 확인:**

```bash
curl -s https://hosub.duckdns.org/jw/health
curl -s https://hosub.duckdns.org/.well-known/oauth-protected-resource/jw/mcp
# → {"resource":"https://hosub.duckdns.org/jw/mcp","authorization_servers":["https://hosub.duckdns.org/jw"],...}

curl -s https://hosub.duckdns.org/.well-known/oauth-authorization-server/jw | grep -o '"issuer":"[^"]*"'
# → "issuer":"https://hosub.duckdns.org/jw"

# 인증 없는 MCP 는 401 + 정본 메타데이터 주소를 알려야 한다
curl -si -X POST https://hosub.duckdns.org/jw/mcp | grep -i www-authenticate
```

## 4. 공개 URL 확정

```bash
sudo sed -i 's|^JW_PUBLIC_URL=.*|JW_PUBLIC_URL=https://hosub.duckdns.org|' /opt/jw-mcp/.env
sudo systemctl restart jw-mcp
```

프록시 헤더 유추에 기대지 않고 못 박아 두는 편이 안전하다 — 헤더가 빠지면 issuer 가
흔들려 이미 연결된 커넥터가 깨진다.

## 5. 첫 계정 (= 관리자)

브라우저에서 `https://hosub.duckdns.org/jw/signup` 으로 가입한다.
**최초 가입자는 자동으로 관리자 겸 활성 사용자**가 된다.

이후 가입자는 `pending` 이 되며, 관리자가 `https://hosub.duckdns.org/jw/admin` 에서
승인해야 쓸 수 있다. 회중 형제자매에게 한 번에 나눠줄 때는 초대 코드를 쓴다:

```bash
sudo sed -i 's|^JW_INVITE_CODE=.*|JW_INVITE_CODE=원하는코드|' /opt/jw-mcp/.env
sudo systemctl restart jw-mcp
```

## 6. Claude 커넥터 연결

claude.ai → 설정 → 커넥터 → 커스텀 커넥터 추가:

```
https://hosub.duckdns.org/jw/mcp
```

OAuth 화면이 뜨면 5단계에서 만든 계정으로 로그인 → 승인. 도구 11종이 보이면 성공이다.

## 7. hosub 대시보드 연동

jw-mcp 의 내부 토큰을 hosub 쪽 `.env` 에 넣는다:

```bash
JW_TOKEN=$(sudo grep '^JW_INTERNAL_TOKEN=' /opt/jw-mcp/.env | cut -d= -f2)
sudo tee -a /opt/hosub-mcp/.env >/dev/null <<EOF

# --- jw-mcp 연동 (127.0.0.1:8604, 자체 OAuth 서비스) ---
HOSUB_JW_URL=http://127.0.0.1:8604
HOSUB_JW_TOKEN=${JW_TOKEN}
EOF
sudo systemctl restart hosub-dash
```

hosub-mcp 저장소 쪽 코드 변경은 [`hosub-dashboard.md`](hosub-dashboard.md) 참고
(별도 저장소·별도 PR).

연동 확인:

```bash
curl -s -H "X-Internal-Token: $JW_TOKEN" http://127.0.0.1:8604/api/dash/summary | head -c 200

# ★ 공인 인터넷에서는 닿지 않아야 한다
curl -s -o /dev/null -w '%{http_code}\n' https://hosub.duckdns.org/api/dash/summary   # 404 또는 401
```

## 8. 자동 배포 확인

```bash
systemctl list-timers jw-mcp-update.timer --no-pager
sudo -u jwmcp /opt/jw-mcp/deploy/update.sh     # 즉시 1회 실행
journalctl -u jw-mcp-update.service -n 20 --no-pager
```

`main` 에 머지하면 5분 내 자동 반영된다.

---

## 문제 해결

| 증상 | 확인 |
|---|---|
| 커넥터가 "인증됐지만 서버 접근 불가" | `WWW-Authenticate` 가 정본 메타데이터를 가리키는지(3단계). Caddy 의 `@jw_wellknown` 블록이 catch-all 앞에 있어야 한다 |
| OAuth 화면에서 hosub 비밀번호를 묻는다 | `/jw` well-known 요청이 :8700 으로 새고 있다 — Caddy 스니펫 위치 확인 |
| 로그인 후 곧바로 로그아웃된다 | `JW_SECURE_COOKIES=true` 인데 http 로 접속했거나, `JW_SESSION_SECRET` 이 재시작마다 바뀌는 경우 |
| `/jw/mcp` 가 계속 401 | 계정이 `pending`/`disabled` 일 수 있다 — `/jw/admin` 에서 상태 확인 |
| 대시보드에 데이터가 안 뜬다 | 양쪽 `.env` 의 토큰이 같은 값인지, `systemctl restart hosub-dash` 했는지 |

로그:

```bash
journalctl -u jw-mcp -f
journalctl -u jw-mcp-update -n 50 --no-pager
```

## 롤백

```bash
sudo systemctl disable --now jw-mcp jw-mcp-update.timer
sudo cp /etc/caddy/Caddyfile.bak.<타임스탬프> /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

jw-mcp 는 기존 서비스의 파일·DB·포트를 전혀 공유하지 않으므로, 이 두 줄이면 서버는
설치 이전 상태로 완전히 돌아간다.
