#!/usr/bin/env bash
# ReportArchive — unified deploy entry point.
#
# Usage (run with sudo):
#   ./deploy.sh prepare    one-time: apt packages, postgres, DB role, install dir
#   ./deploy.sh install    place SIF + render systemd unit + migrate + seed + start
#   ./deploy.sh update     swap SIF + migrate + restart (no data loss)
#   ./deploy.sh reset      drop DB → recreate → migrate → seed (FACTORY RESET)
#   ./deploy.sh status     show service status + /api/health
#   ./deploy.sh            auto: install if not yet installed, else update
#
# Configuration (override via env, e.g. INSTALL_DIR=/foo ./deploy.sh):
#   OPERATOR     account that owns files and runs the service (default: $SUDO_USER)
#   INSTALL_DIR  where app.sif, .env, uploads/, logs/ live
#                (default: /home/$OPERATOR/Projects/ReportArchive)
#   DB_NAME      Postgres database         (default: report_automation)
#   DB_USER      Postgres role             (default: reportarchive)
#
# This script is location-independent — run it from /tmp, from ~, or wherever
# you extracted the release bundle. It finds its peer files (app.sif, .env.example,
# reportarchive.service.template) via its own directory.

set -euo pipefail

# ───────────────────────── helpers ──────────────────────────
err()  { echo "ERR: $*" >&2; exit 1; }
info() { echo "==> $*"; }
warn() { echo "⚠  $*"; }

# ───────────────────────── preflight ────────────────────────
[[ $EUID -eq 0 ]] || err "run as root (sudo)"

OPERATOR="${OPERATOR:-${SUDO_USER:-}}"
[[ -n "$OPERATOR" && "$OPERATOR" != "root" ]] \
    || err "cannot determine operator account; run via sudo from a regular user, or set OPERATOR=<name>"
id "$OPERATOR" >/dev/null 2>&1 || err "operator user '$OPERATOR' does not exist"

INSTALL_DIR="${INSTALL_DIR:-/home/$OPERATOR/Projects/ReportArchive}"
DB_NAME="${DB_NAME:-report_automation}"
DB_USER="${DB_USER:-reportarchive}"
SERVICE_NAME="reportarchive"
SERVICE_UNIT="/etc/systemd/system/${SERVICE_NAME}.service"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Shorthand: run a command as the operator account
as_op() { sudo -u "$OPERATOR" "$@"; }

# ───────────────────────── building blocks ──────────────────
ensure_dirs() {
    info "Ensuring install dir layout: $INSTALL_DIR"
    as_op mkdir -p "$INSTALL_DIR"/{uploads,logs}
}

generate_env_if_missing() {
    if [[ -f "$INSTALL_DIR/.env" ]]; then
        return 0  # leave existing file alone
    fi
    [[ -f "$HERE/.env.example" ]] || err ".env.example not found alongside script ($HERE)"

    local pw secret jwt
    pw="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
    secret="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
    jwt="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"

    info "Generating fresh $INSTALL_DIR/.env with random secrets + DB password"
    # Rotate the DB password so .env and Postgres role are guaranteed in sync.
    sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
ALTER USER $DB_USER WITH PASSWORD '$pw';
SQL

    # shellcheck disable=SC2016
    sed \
        -e "s|REPLACE_WITH_RANDOM_48_CHAR_SECRET|$secret|" \
        -e "s|REPLACE_WITH_DIFFERENT_RANDOM_48_CHAR_SECRET|$jwt|" \
        -e "s|reportarchive:CHANGE_ME@|${DB_USER}:${pw}@|" \
        "$HERE/.env.example" > "$INSTALL_DIR/.env"
    chown "$OPERATOR:$OPERATOR" "$INSTALL_DIR/.env"
    chmod 600 "$INSTALL_DIR/.env"

    warn "Wrote $INSTALL_DIR/.env — review CORS_ORIGINS and other settings before going live."
}

place_sif() {
    [[ -f "$HERE/app.sif" ]] || err "app.sif missing in $HERE (run from extracted release bundle)"
    info "Placing app.sif → $INSTALL_DIR/app.sif"
    install -o "$OPERATOR" -g "$OPERATOR" -m 644 "$HERE/app.sif" "$INSTALL_DIR/app.sif"
}

run_migrations() {
    info "Running database migrations (idempotent)"
    as_op apptainer exec \
        --bind "$INSTALL_DIR/.env:/opt/app/backend/.env:ro" \
        "$INSTALL_DIR/app.sif" \
        /opt/app/venv/bin/python /opt/app/backend/scripts/setup_and_upgrade_db.py
}

run_seed() {
    info "Seeding initial data (idempotent — existing rows skipped)"
    as_op apptainer exec \
        --bind "$INSTALL_DIR/.env:/opt/app/backend/.env:ro" \
        "$INSTALL_DIR/app.sif" \
        /opt/app/venv/bin/python /opt/app/backend/scripts/seed_initial_data.py
}

render_service_unit() {
    [[ -f "$HERE/reportarchive.service.template" ]] \
        || err "reportarchive.service.template missing in $HERE"
    info "Rendering systemd unit → $SERVICE_UNIT"
    sed -e "s|@@USER@@|$OPERATOR|g" \
        -e "s|@@INSTALL_DIR@@|$INSTALL_DIR|g" \
        "$HERE/reportarchive.service.template" > "$SERVICE_UNIT"
    chmod 644 "$SERVICE_UNIT"
    systemctl daemon-reload
}

# ───────────────────────── subcommands ──────────────────────
cmd_prepare() {
    info "Installing OS packages (apptainer, postgresql)"
    apt-get update
    apt-get install -y --no-install-recommends \
        apptainer postgresql postgresql-contrib ca-certificates python3

    info "Enabling postgresql"
    systemctl enable postgresql
    systemctl start postgresql

    ensure_dirs

    info "Checking DB role '$DB_USER'"
    if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1; then
        sudo -u postgres psql -c "CREATE USER $DB_USER WITH PASSWORD 'placeholder-will-be-rotated-on-env-creation';"
        info "DB role '$DB_USER' created (password will be set when .env is generated)"
    else
        info "DB role '$DB_USER' already exists"
    fi

    info "Checking database '$DB_NAME'"
    if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1; then
        sudo -u postgres psql -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;"
        info "Database '$DB_NAME' created"
    else
        info "Database '$DB_NAME' already exists"
    fi

    cat <<MSG

[OK] Server prepared.
  Next: sudo ./deploy.sh install
  (will auto-generate $INSTALL_DIR/.env on first run)
MSG
}

cmd_install() {
    [[ -f "$HERE/app.sif" ]] || err "app.sif missing — extract the release bundle and run from there"

    info "Operator: $OPERATOR   Install dir: $INSTALL_DIR"

    ensure_dirs
    generate_env_if_missing
    place_sif
    run_migrations
    run_seed
    render_service_unit

    systemctl enable "$SERVICE_NAME"
    systemctl restart "$SERVICE_NAME"
    sleep 2
    systemctl --no-pager --lines=5 status "$SERVICE_NAME" || true

    cat <<MSG

[OK] Install complete.
  Logs:    sudo journalctl -u $SERVICE_NAME -f
  Health:  curl http://localhost:3000/api/health
  Seed login: admin@example.com / admin1234  (change immediately)
MSG
}

cmd_update() {
    [[ -f "$HERE/app.sif" ]]        || err "app.sif missing in $HERE"
    [[ -f "$INSTALL_DIR/.env" ]]    || err "$INSTALL_DIR/.env missing — run './deploy.sh install' first"

    info "Stopping $SERVICE_NAME"
    systemctl stop "$SERVICE_NAME" || true

    if [[ -f "$INSTALL_DIR/app.sif" ]]; then
        info "Backing up previous SIF → app.sif.prev"
        mv "$INSTALL_DIR/app.sif" "$INSTALL_DIR/app.sif.prev"
    fi
    place_sif
    run_migrations
    render_service_unit  # in case the template (paths, hardening) changed

    systemctl start "$SERVICE_NAME"
    sleep 2
    systemctl --no-pager --lines=5 status "$SERVICE_NAME" || true

    cat <<MSG

[OK] Update complete.
  Rollback: sudo systemctl stop $SERVICE_NAME && sudo mv $INSTALL_DIR/app.sif.prev $INSTALL_DIR/app.sif && sudo systemctl start $SERVICE_NAME
MSG
}

cmd_reset() {
    cat <<MSG

  ⚠ FACTORY RESET — this destroys ALL data:
      DB:       DROP DATABASE $DB_NAME → recreate empty
      Uploads:  $INSTALL_DIR/uploads/* deleted
      Service:  $SERVICE_NAME restarted with fresh schema + seed only

  .env, DB role, systemd unit, postgres install — preserved.

MSG
    read -r -p "Type 'reset' to confirm: " ans
    [[ "$ans" == "reset" ]] || err "aborted"

    info "Stopping service"
    systemctl stop "$SERVICE_NAME" || true

    info "Dropping + recreating database '$DB_NAME'"
    sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DROP DATABASE IF EXISTS $DB_NAME;
CREATE DATABASE $DB_NAME OWNER $DB_USER;
SQL

    if [[ -d "$INSTALL_DIR/uploads" ]]; then
        info "Wiping $INSTALL_DIR/uploads/*"
        rm -rf "$INSTALL_DIR/uploads"/*
    fi

    # If a fresh bundle is present, swap the SIF too — saves a separate update.
    if [[ -f "$HERE/app.sif" ]]; then
        if [[ -f "$INSTALL_DIR/app.sif" ]]; then
            mv "$INSTALL_DIR/app.sif" "$INSTALL_DIR/app.sif.prev"
        fi
        place_sif
    fi

    run_migrations
    run_seed
    render_service_unit

    systemctl start "$SERVICE_NAME"
    sleep 2
    systemctl --no-pager --lines=5 status "$SERVICE_NAME" || true

    cat <<MSG

[OK] Factory reset complete.
  Seed login: admin@example.com / admin1234  (change immediately)
MSG
}

cmd_status() {
    systemctl --no-pager --lines=10 status "$SERVICE_NAME" || true
    echo
    echo "--- /api/health ---"
    curl -fsS http://localhost:3000/api/health 2>/dev/null || echo "(no response)"
    echo
}

cmd_auto() {
    if [[ -f "$INSTALL_DIR/app.sif" && -f "$INSTALL_DIR/.env" && -f "$SERVICE_UNIT" ]]; then
        info "Existing install detected → running update"
        cmd_update
    else
        info "Fresh install detected → running install"
        cmd_install
    fi
}

usage() {
    cat <<MSG
ReportArchive deploy script.

Usage (always with sudo):
  sudo ./deploy.sh [prepare|install|update|reset|status]

  prepare   one-time: apt packages, postgresql, DB role, install dir
  install   place SIF + .env + systemd, migrate, seed, start
  update    swap SIF + migrate + restart (preserves data)
  reset     wipe DB + uploads, re-migrate, re-seed (DESTRUCTIVE)
  status    service + health check
  (no arg)  auto: install on first run, update afterwards

Current settings (override via env vars):
  OPERATOR     = $OPERATOR
  INSTALL_DIR  = $INSTALL_DIR
  DB_NAME      = $DB_NAME
  DB_USER      = $DB_USER
MSG
}

# ───────────────────────── dispatch ─────────────────────────
case "${1:-}" in
    prepare)         cmd_prepare ;;
    install)         cmd_install ;;
    update)          cmd_update  ;;
    reset)           cmd_reset   ;;
    status)          cmd_status  ;;
    ""|auto)         cmd_auto    ;;
    -h|--help|help)  usage       ;;
    *)               usage; exit 1 ;;
esac
