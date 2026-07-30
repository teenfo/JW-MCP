#!/usr/bin/env bash
#
# jw-mcp pull 기반 자동 배포.
#
# 추적 브랜치(JW_MCP_BRANCH, 기본 main)에 새 커밋이 있을 때만 pull + 의존성 설치 +
# 재시작한다. 변경이 없으면 아무것도 하지 않고 조용히 끝난다 — 5분마다 도는 타이머가
# 매번 서비스를 흔들면 안 되기 때문이다.
#
set -euo pipefail

REPO_DIR="${JW_MCP_DIR:-/opt/jw-mcp}"
BRANCH="${JW_MCP_BRANCH:-main}"
UNIT="jw-mcp.service"

cd "$REPO_DIR"

log() { echo "[jw-mcp-update] $*"; }

# 로컬 수정이 있으면 pull 이 깨지므로 손대지 않고 물러난다(사람이 판단할 몫).
if ! git diff --quiet || ! git diff --cached --quiet; then
  log "작업 트리에 커밋되지 않은 변경이 있습니다 — 배포를 건너뜁니다."
  exit 0
fi

git fetch --quiet origin "$BRANCH"

LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"

if [ "$LOCAL" = "$REMOTE" ]; then
  exit 0
fi

log "새 커밋 감지: ${LOCAL:0:8} → ${REMOTE:0:8}"
git merge --ff-only "origin/$BRANCH"

# package-lock.json 이 바뀐 경우에만 설치한다 — npm ci 는 node_modules 를 통째로
# 지우고 다시 만들어서 몇십 초가 걸린다.
if ! git diff --quiet "$LOCAL" "$REMOTE" -- package-lock.json package.json; then
  log "의존성 변경 감지 — npm ci 실행"
  npm ci --omit=dev --no-audit --no-fund
fi

log "서비스 재시작"
sudo -n systemctl restart "$UNIT"

# 재시작이 실제로 살아났는지 확인한다. 실패하면 타이머 로그에 남아 추적할 수 있다.
sleep 2
if ! systemctl is-active --quiet "$UNIT"; then
  log "❌ 재시작 후 $UNIT 가 active 가 아닙니다 — journalctl -u $UNIT 확인 필요"
  exit 1
fi

log "✅ ${REMOTE:0:8} 배포 완료"
