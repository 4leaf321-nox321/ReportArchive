#!/usr/bin/env bash
# First-time install of the Report Archive backend on a prepared server.
#
# Prerequisites (do these first):
#   - prepare_server.sh has been run (apt packages, user, dirs)
#   - PostgreSQL user + database exist (see README §3)
#   - .env has been copied from .env.example and filled in with prod values
#
# This script is idempotent — re-running it is safe.

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
    echo "ERR: run as root (use sudo)"; exit 1
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="/opt/reportarchive"
SERVICE_USER="reportarchive"

# --- Sanity checks ---
[[ -f "$HERE/app.sif" ]]               || { echo "ERR: app.sif not found in $HERE"; exit 1; }
[[ -f "$HERE/.env"    ]]               || { echo "ERR: .env not found. Copy .env.example to .env and fill in values first."; exit 1; }
command -v apptainer >/dev/null        || { echo "ERR: apptainer not installed. Run prepare_server.sh first."; exit 1; }
id "$SERVICE_USER" >/dev/null 2>&1     || { echo "ERR: user '$SERVICE_USER' missing. Run prepare_server.sh first."; exit 1; }

echo "==> [1/4] Placing files under ${INSTALL_DIR}"
install -o "$SERVICE_USER" -g "$SERVICE_USER" -m 644 "$HERE/app.sif" "$INSTALL_DIR/app.sif"
install -o "$SERVICE_USER" -g "$SERVICE_USER" -m 600 "$HERE/.env"    "$INSTALL_DIR/.env"

echo "==> [2/4] Applying database migrations (idempotent)"
sudo -u "$SERVICE_USER" apptainer exec \
    --bind "$INSTALL_DIR/.env:/opt/app/backend/.env:ro" \
    "$INSTALL_DIR/app.sif" \
    /opt/app/venv/bin/python /opt/app/backend/scripts/setup_and_upgrade_db.py

echo "==> [3/4] Installing systemd unit"
install -m 644 "$HERE/reportarchive.service" /etc/systemd/system/reportarchive.service
systemctl daemon-reload
systemctl enable reportarchive

echo "==> [4/4] Starting service"
systemctl restart reportarchive
sleep 2
systemctl --no-pager --lines=5 status reportarchive || true

echo
echo "[OK] Install complete."
echo "  Logs:    journalctl -u reportarchive -f"
echo "  Health:  curl http://localhost:5174/api/health"
