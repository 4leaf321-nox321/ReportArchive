#!/usr/bin/env bash
# Build a single-file release bundle for offline deployment.
#
# Runs on the developer's build machine (WSL Ubuntu 24.04 is fine).
# Output: release/reportarchive-<version>.tar.gz
#
# Transport that tarball to the production server, untar, run ./deploy.sh.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

VERSION="$(git describe --tags --always --dirty 2>/dev/null || date +%Y%m%d-%H%M%S)"
RELEASE_NAME="reportarchive-${VERSION}"
OUT_DIR="release"
STAGE="${OUT_DIR}/${RELEASE_NAME}"

echo "==> Build version: ${VERSION}"
echo "==> Repo root:     ${REPO_ROOT}"

# --- Preflight ---
command -v apptainer >/dev/null || { echo "ERR: apptainer not installed"; exit 1; }
command -v npm       >/dev/null || { echo "ERR: npm not installed (needed for frontend build)"; exit 1; }

# --- 1. Frontend build ---
echo
echo "==> [1/4] Building frontend (dist/)"
(cd frontend && npm ci && npm run build)

# --- 2. Apptainer SIF ---
echo
echo "==> [2/4] Building Apptainer SIF (5-10 min on first build)"
rm -rf "$STAGE"
mkdir -p "$STAGE"
# GitHub Actions runners have no subuid/subgid mapping for the `runner`
# user, so unprivileged apptainer build fails there. Opt-in via env var
# so local dev keeps building without sudo.
APPTAINER_BUILD=(apptainer build --force)
if [[ "${USE_SUDO_APPTAINER:-0}" == "1" ]]; then
    APPTAINER_BUILD=(sudo apptainer build --force)
fi
"${APPTAINER_BUILD[@]}" "$STAGE/app.sif" deploy/apptainer.def

# --- 3. Stage scripts + docs ---
echo
echo "==> [3/4] Staging install scripts"
cp deploy/deploy.sh                             "$STAGE/"
cp deploy/reportarchive.service.template        "$STAGE/"
cp deploy/reportarchive-worker.service.template "$STAGE/"
cp deploy/reportarchive-mcp.service.template    "$STAGE/"
cp deploy/.env.production.example               "$STAGE/.env.example"
cp deploy/README_OPERATOR.md                 "$STAGE/README.md"
echo "$VERSION" > "$STAGE/VERSION"
chmod +x "$STAGE"/*.sh

# nginx HTTPS 리버스 프록시 설정 예시 (배포방법최종.md A-5 에서 참조)
mkdir -p "$STAGE/nginx"
cp nginx/reportarchive-ssl.conf.example "$STAGE/nginx/"

# --- 3b. MCP server (별도 venv 로 운영서버에서 돌아감) ---
# 백엔드 SIF 와 의존성이 충돌해 컨테이너에 못 넣는다. 소스 + 오프라인 설치용 휠을
# 동봉 → deploy.sh 가 운영 호스트에서 venv 만들고 `pip install --no-index` 로 설치.
echo "==> [3b/4] Staging MCP server + vendored wheels (offline install)"
mkdir -p "$STAGE/mcp_server"
cp mcp_server/server.py        "$STAGE/mcp_server/"
cp mcp_server/requirements.txt "$STAGE/mcp_server/"
[[ -f mcp_server/README.md ]] && cp mcp_server/README.md "$STAGE/mcp_server/" || true
# 작성 스킬(사용자가 ~/.claude/skills 로 설치) — 번들에 동봉
[[ -d mcp_server/skill ]] && cp -r mcp_server/skill "$STAGE/mcp_server/skill" || true
# 사용 가이드(get_guide 가 읽는 본문) — **서버가 쥔다.** 빠지면 get_guide 가
# 빈 응답을 주고 AI 는 도구 설명만으로 헤맨다.
[[ -d mcp_server/guide ]] && cp -r mcp_server/guide "$STAGE/mcp_server/guide" || true
# 빌드 머신(인터넷 O)에서 휠을 받아 둔다. 운영 호스트가 airgap 이어도 설치되게.
# 빌드/운영 아키텍처가 같다고 가정(둘 다 linux x86_64). 다르면 --platform 지정 필요.
if python3 -m pip download --only-binary=:all: \
        -r mcp_server/requirements.txt -d "$STAGE/mcp_server/wheels" >/dev/null 2>&1; then
    echo "    vendored $(ls "$STAGE/mcp_server/wheels" | wc -l) wheels"
else
    echo "    ⚠ pip download 실패 — 휠 미동봉. 운영 호스트에 인터넷/사내 PyPI 있어야 MCP 설치됨."
fi

# --- 4. Pack tarball ---
echo
echo "==> [4/4] Packing tarball"
tar czf "${OUT_DIR}/${RELEASE_NAME}.tar.gz" -C "$OUT_DIR" "$RELEASE_NAME"

SIZE=$(du -h "${OUT_DIR}/${RELEASE_NAME}.tar.gz" | cut -f1)
echo
echo "[OK] ${OUT_DIR}/${RELEASE_NAME}.tar.gz  (${SIZE})"
echo "     Transport this single file to the production server."
