#!/usr/bin/env bash
#
# jw-mcp 최초 설치. 서버에서 root 로 한 번 실행한다:
#
#   sudo bash /opt/jw-mcp/deploy/bootstrap.sh
#
# 하는 일: 전용 유저 생성 · Node 확인/설치 안내 · 의존성 설치 · .env 시크릿 자동 발급
#          · systemd 유닛 배치 · sudoers 한 줄(재시작 전용) · Caddy 스니펫 안내.
#
# Caddy 수정은 **자동으로 하지 않는다.** 운영 중인 hosub 라우팅을 건드리는 일이라
# 사람이 확인하고 반영해야 한다 — 마지막에 붙여넣을 블록을 출력한다.
#
set -euo pipefail

REPO_DIR="${JW_MCP_DIR:-/opt/jw-mcp}"
SERVICE_USER="jwmcp"
PORT="${JW_PORT:-8604}"
BASE_PATH="${JW_BASE_PATH:-/jw}"

if [ "$(id -u)" -ne 0 ]; then
  echo "root 로 실행하세요: sudo bash $0" >&2
  exit 1
fi

step() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }

step "Node 런타임 확인"
if ! command -v node >/dev/null 2>&1; then
  cat >&2 <<'EOF'
❌ node 가 없습니다. NodeSource LTS 를 먼저 설치하세요:

   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs

설치 후 이 스크립트를 다시 실행하세요.
EOF
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "❌ Node 20 이상이 필요합니다 (현재 $(node --version))." >&2
  exit 1
fi
echo "   node $(node --version) · npm $(npm --version)"

step "전용 유저 ${SERVICE_USER}"
if id "$SERVICE_USER" >/dev/null 2>&1; then
  echo "   이미 존재합니다."
else
  useradd --system --home-dir "$REPO_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
  echo "   생성했습니다."
fi

step "디렉터리 권한"
mkdir -p "$REPO_DIR/data"
chown -R "$SERVICE_USER:$SERVICE_USER" "$REPO_DIR"
chmod 750 "$REPO_DIR/data"

step "의존성 설치"
sudo -u "$SERVICE_USER" npm ci --omit=dev --no-audit --no-fund --prefix "$REPO_DIR"

step ".env 준비"
ENV_FILE="$REPO_DIR/.env"
if [ -f "$ENV_FILE" ]; then
  echo "   이미 있습니다 — 건드리지 않습니다."
else
  SESSION_SECRET="$(openssl rand -hex 32)"
  INTERNAL_TOKEN="$(openssl rand -hex 32)"
  cat > "$ENV_FILE" <<EOF
# jw-mcp 환경변수 (bootstrap.sh 가 생성). 시크릿이 들어 있으니 커밋 금지.
JW_HOST=127.0.0.1
JW_PORT=${PORT}
JW_BASE_PATH=${BASE_PATH}
JW_PUBLIC_URL=
JW_DB=data/jw.db
JW_SESSION_SECRET=${SESSION_SECRET}
JW_INTERNAL_TOKEN=${INTERNAL_TOKEN}
JW_ADMIN_EMAILS=
JW_INVITE_CODE=
JW_MCP_BRANCH=main
EOF
  chown "$SERVICE_USER:$SERVICE_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "   생성했습니다 (시크릿 자동 발급)."
fi

step "systemd 유닛 배치"
install -m 644 "$REPO_DIR/deploy/jw-mcp.service"        /etc/systemd/system/jw-mcp.service
install -m 644 "$REPO_DIR/deploy/jw-mcp-update.service" /etc/systemd/system/jw-mcp-update.service
install -m 644 "$REPO_DIR/deploy/jw-mcp-update.timer"   /etc/systemd/system/jw-mcp-update.timer
chmod +x "$REPO_DIR/deploy/update.sh"
systemctl daemon-reload

step "sudoers (자동 배포용 재시작 권한만)"
# update.sh 가 자기 서비스를 재시작할 수 있어야 한다. 딱 그 명령 하나만 허용한다 —
# 이 유저에게 그 이상의 sudo 권한은 주지 않는다.
cat > /etc/sudoers.d/jw-mcp <<EOF
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/bin/systemctl restart jw-mcp.service
EOF
chmod 440 /etc/sudoers.d/jw-mcp
visudo -cf /etc/sudoers.d/jw-mcp >/dev/null

step "서비스 기동"
systemctl enable --now jw-mcp.service
systemctl enable --now jw-mcp-update.timer
sleep 2
systemctl is-active --quiet jw-mcp.service \
  && echo "   ✅ jw-mcp.service active" \
  || { echo "   ❌ 기동 실패 — journalctl -u jw-mcp.service -n 50"; exit 1; }

echo
curl -fsS "http://127.0.0.1:${PORT}${BASE_PATH}/health" && echo

cat <<EOF

────────────────────────────────────────────────────────────────────
남은 수동 단계 (운영 중인 Caddy 를 건드리므로 사람이 확인해야 합니다)

1) /etc/caddy/Caddyfile 백업
     sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak.\$(date +%Y%m%d-%H%M%S)

2) hosub.duckdns.org 블록 안, '@dash' 줄 **앞**에 deploy/Caddyfile.snippet 내용 삽입

3) 검증 후 반영
     sudo caddy validate --config /etc/caddy/Caddyfile
     sudo systemctl reload caddy

4) .env 의 JW_PUBLIC_URL 을 https://hosub.duckdns.org 로 채우고 재시작
     sudo systemctl restart jw-mcp

5) 첫 계정 만들기 (최초 가입자가 자동으로 관리자가 됩니다)
     https://hosub.duckdns.org${BASE_PATH}/signup

6) hosub 대시보드 연동용 내부 토큰 — /opt/hosub-mcp/.env 에 아래를 추가
     HOSUB_JW_URL=http://127.0.0.1:${PORT}
     HOSUB_JW_TOKEN=\$(sudo grep JW_INTERNAL_TOKEN ${ENV_FILE} | cut -d= -f2)
────────────────────────────────────────────────────────────────────
EOF
