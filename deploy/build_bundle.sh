#!/usr/bin/env bash
# Build a single-file release bundle for offline deployment.
#
# Runs on the developer's build machine (WSL Ubuntu 24.04 is fine).
# Output: release/reportarchive-<version>.tar.gz
#
# Transport that tarball to the production server, untar, run install.sh.

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
apptainer build --force "$STAGE/app.sif" deploy/apptainer.def

# --- 3. Stage scripts + docs ---
echo
echo "==> [3/4] Staging install scripts"
cp deploy/prepare_server.sh        "$STAGE/"
cp deploy/install.sh               "$STAGE/"
cp deploy/update.sh                "$STAGE/"
cp deploy/reportarchive.service    "$STAGE/"
cp deploy/.env.production.example  "$STAGE/.env.example"
cp deploy/README_OPERATOR.md       "$STAGE/README.md"
echo "$VERSION" > "$STAGE/VERSION"
chmod +x "$STAGE"/*.sh

# --- 4. Pack tarball ---
echo
echo "==> [4/4] Packing tarball"
tar czf "${OUT_DIR}/${RELEASE_NAME}.tar.gz" -C "$OUT_DIR" "$RELEASE_NAME"

SIZE=$(du -h "${OUT_DIR}/${RELEASE_NAME}.tar.gz" | cut -f1)
echo
echo "[OK] ${OUT_DIR}/${RELEASE_NAME}.tar.gz  (${SIZE})"
echo "     Transport this single file to the production server."
