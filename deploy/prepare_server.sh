#!/usr/bin/env bash
# One-time server preparation. Run with sudo on a fresh Ubuntu 24.04 host.
#
# Installs OS packages, creates a service user, prepares /opt/reportarchive.
# Does NOT touch the database — that's a manual step (see README.md §3)
# because the password lives in your operator-controlled .env.

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
    echo "ERR: run as root (use sudo)"; exit 1
fi

SERVICE_USER="reportarchive"
INSTALL_DIR="/opt/reportarchive"

echo "==> [1/3] Installing OS packages (apptainer, postgresql)"
apt-get update
apt-get install -y --no-install-recommends \
    apptainer \
    postgresql \
    postgresql-contrib \
    ca-certificates

echo "==> [2/3] Creating service user '${SERVICE_USER}'"
if id "$SERVICE_USER" >/dev/null 2>&1; then
    echo "    (user already exists, skipping)"
else
    useradd --system --shell /usr/sbin/nologin --home "$INSTALL_DIR" \
            --create-home "$SERVICE_USER"
fi

echo "==> [3/3] Creating directories under ${INSTALL_DIR}"
mkdir -p "$INSTALL_DIR"/{uploads,logs}
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

systemctl enable postgresql
systemctl start postgresql

echo
echo "[OK] Server prepared."
echo
echo "Next steps:"
echo "  1) Set up the database (see README §3) — one-time."
echo "  2) Copy .env.example to .env and fill in production values."
echo "  3) Run ./install.sh"
