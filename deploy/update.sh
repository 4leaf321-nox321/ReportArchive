#!/usr/bin/env bash
# Replace app.sif with a newer build, run any new migrations, restart.
# Run from the unpacked release directory (the one with the new app.sif).

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
    echo "ERR: run as root (use sudo)"; exit 1
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="/opt/reportarchive"
SERVICE_USER="reportarchive"

[[ -f "$HERE/app.sif"             ]] || { echo "ERR: app.sif not found in $HERE"; exit 1; }
[[ -f "$INSTALL_DIR/.env"         ]] || { echo "ERR: $INSTALL_DIR/.env missing — has install.sh been run?"; exit 1; }
[[ -f "$INSTALL_DIR/app.sif"      ]] || { echo "ERR: $INSTALL_DIR/app.sif missing — has install.sh been run?"; exit 1; }

VERSION="$(cat "$HERE/VERSION" 2>/dev/null || echo unknown)"
echo "==> Update to version: ${VERSION}"

echo "==> [1/4] Stopping service"
systemctl stop reportarchive

echo "==> [2/4] Replacing app.sif (previous → app.sif.prev)"
mv "$INSTALL_DIR/app.sif" "$INSTALL_DIR/app.sif.prev"
install -o "$SERVICE_USER" -g "$SERVICE_USER" -m 644 "$HERE/app.sif" "$INSTALL_DIR/app.sif"

echo "==> [3/4] Applying database migrations (idempotent)"
sudo -u "$SERVICE_USER" apptainer exec \
    --bind "$INSTALL_DIR/.env:/opt/app/backend/.env:ro" \
    "$INSTALL_DIR/app.sif" \
    /opt/app/venv/bin/python /opt/app/backend/scripts/setup_and_upgrade_db.py

# Refresh systemd unit too — harmless if unchanged.
install -m 644 "$HERE/reportarchive.service" /etc/systemd/system/reportarchive.service
systemctl daemon-reload

echo "==> [4/4] Starting service"
systemctl start reportarchive
sleep 2
systemctl --no-pager --lines=5 status reportarchive || true

echo
echo "[OK] Update to ${VERSION} complete."
echo "  Rollback: sudo systemctl stop reportarchive && sudo mv $INSTALL_DIR/app.sif.prev $INSTALL_DIR/app.sif && sudo systemctl start reportarchive"
