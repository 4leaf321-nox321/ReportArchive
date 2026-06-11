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

# MCP server (Claude 연동) — 선택. 별도 venv + 별도 systemd 유닛.
MCP_SERVICE_NAME="reportarchive-mcp"
MCP_SERVICE_UNIT="/etc/systemd/system/${MCP_SERVICE_NAME}.service"
MCP_ENABLED="${MCP_ENABLED:-1}"                        # 0 으로 두면 MCP 전체 건너뜀
MCP_HOST="${MCP_HOST:-127.0.0.1}"                      # 외부 노출하려면 0.0.0.0 (또는 리버스프록시)
MCP_PORT="${MCP_PORT:-3002}"
MCP_API_BASE="${MCP_API_BASE:-http://127.0.0.1:3000}"  # MCP 가 호출할 백엔드 주소

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

# ── MCP server (선택) — 별도 venv + systemd. 실패는 전부 비치명적(백엔드 배포 무관). ──
render_mcp_service_unit() {
    [[ -f "$HERE/reportarchive-mcp.service.template" ]] \
        || { warn "reportarchive-mcp.service.template 없음 — MCP 유닛 건너뜀"; return 1; }
    info "Rendering MCP systemd unit → $MCP_SERVICE_UNIT"
    sed -e "s|@@USER@@|$OPERATOR|g" \
        -e "s|@@INSTALL_DIR@@|$INSTALL_DIR|g" \
        -e "s|@@API_BASE@@|$MCP_API_BASE|g" \
        -e "s|@@MCP_HOST@@|$MCP_HOST|g" \
        -e "s|@@MCP_PORT@@|$MCP_PORT|g" \
        "$HERE/reportarchive-mcp.service.template" > "$MCP_SERVICE_UNIT"
    chmod 644 "$MCP_SERVICE_UNIT"
    systemctl daemon-reload
}

setup_mcp() {
    [[ "$MCP_ENABLED" == "1" ]] || { info "MCP 비활성(MCP_ENABLED=0) — 건너뜀"; return 0; }
    [[ -d "$HERE/mcp_server" ]] || { warn "번들에 mcp_server/ 없음 — MCP 건너뜀"; return 0; }

    info "Setting up MCP server (별도 venv + systemd)"
    local md="$INSTALL_DIR/mcp_server"

    # 1) 소스 배치
    as_op mkdir -p "$md"
    install -o "$OPERATOR" -g "$OPERATOR" -m 644 "$HERE/mcp_server/server.py" "$md/server.py"
    install -o "$OPERATOR" -g "$OPERATOR" -m 644 "$HERE/mcp_server/requirements.txt" "$md/requirements.txt"
    [[ -f "$HERE/mcp_server/README.md" ]] \
        && install -o "$OPERATOR" -g "$OPERATOR" -m 644 "$HERE/mcp_server/README.md" "$md/README.md" || true

    # 2) venv 없으면 생성
    if [[ ! -x "$md/venv/bin/python" ]]; then
        info "Creating MCP venv: $md/venv"
        if ! as_op python3 -m venv "$md/venv"; then
            warn "python3 -m venv 실패('python3-venv' 설치 필요?) — MCP 미설치(백엔드 영향 없음)"; return 0
        fi
    fi

    # 3) 의존성 설치 — 동봉 휠 우선(오프라인), 없으면 온라인 시도
    local pip="$md/venv/bin/pip"
    if [[ -d "$HERE/mcp_server/wheels" ]]; then
        as_op rm -rf "$md/wheels"
        as_op cp -r "$HERE/mcp_server/wheels" "$md/wheels"   # 재실행 안전(중첩 방지)
        info "Installing MCP deps (오프라인 휠)"
        if ! as_op "$pip" install -q --no-index --find-links "$md/wheels" -r "$md/requirements.txt"; then
            warn "오프라인 휠 설치 실패 — MCP 미설치. 수동: cd $md && ./venv/bin/pip install --no-index --find-links wheels -r requirements.txt"; return 0
        fi
    else
        info "Installing MCP deps (온라인 pip — 휠 미동봉)"
        if ! as_op "$pip" install -q -r "$md/requirements.txt"; then
            warn "pip 설치 실패(airgap?). 백엔드 배포는 정상. 수동 설치 후 'systemctl restart $MCP_SERVICE_NAME'"; return 0
        fi
    fi

    # 4) 유닛 렌더 + 기동
    render_mcp_service_unit || return 0
    systemctl enable "$MCP_SERVICE_NAME" >/dev/null 2>&1 || true
    systemctl restart "$MCP_SERVICE_NAME" \
        || warn "MCP 서비스 기동 실패 — 'journalctl -u $MCP_SERVICE_NAME' 확인"
    info "MCP server: http://$MCP_HOST:$MCP_PORT/mcp  → backend $MCP_API_BASE"
}

# ───────────────────────── subcommands ──────────────────────
cmd_prepare() {
    info "Installing OS packages (apptainer, postgresql)"
    apt-get update
    apt-get install -y --no-install-recommends \
        apptainer postgresql postgresql-contrib ca-certificates \
        python3 python3-venv python3-pip

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

    setup_mcp || warn "MCP 설정 건너뜀(비치명적)"

    cat <<MSG

[OK] Install complete.
  Logs:    sudo journalctl -u $SERVICE_NAME -f
  Health:  curl http://localhost:3000/api/health
  Seed login: admin / 32167  (change immediately)
  MCP:     sudo systemctl status $MCP_SERVICE_NAME   (Claude 연동, 선택)
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

    # MCP 서버도 함께 갱신(venv 생성/의존성 설치/유닛 재기동까지). 비치명적.
    setup_mcp || warn "MCP 설정 건너뜀(비치명적)"

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
  Seed login: admin / 32167  (change immediately)
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
