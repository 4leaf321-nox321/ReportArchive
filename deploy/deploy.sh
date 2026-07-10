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

# Background worker (작업 큐 — 오펀 정리·AI 임베딩 등). 같은 app.sif 를 apptainer
# exec 로 실행하므로 별도 venv/의존성 없음. 0 으로 두면 워커 건너뜀.
WORKER_SERVICE_NAME="reportarchive-worker"
WORKER_SERVICE_UNIT="/etc/systemd/system/${WORKER_SERVICE_NAME}.service"
WORKER_ENABLED="${WORKER_ENABLED:-1}"

# 주기 스케줄러 (systemd 타이머, 매분) — due 한 데이터소스 동기화를 큐에 적재.
# 워커가 처리하므로 워커와 짝이며 기본값도 워커와 동일(워커 꺼지면 스케줄러도 무의미).
SCHEDULER_SERVICE_NAME="reportarchive-scheduler"
SCHEDULER_SERVICE_UNIT="/etc/systemd/system/${SCHEDULER_SERVICE_NAME}.service"
SCHEDULER_TIMER_UNIT="/etc/systemd/system/${SCHEDULER_SERVICE_NAME}.timer"
SCHEDULER_ENABLED="${SCHEDULER_ENABLED:-$WORKER_ENABLED}"

# MCP server (Claude 연동) — 선택. 별도 venv + 별도 systemd 유닛.
MCP_SERVICE_NAME="reportarchive-mcp"
MCP_SERVICE_UNIT="/etc/systemd/system/${MCP_SERVICE_NAME}.service"
# 설치된 systemd 유닛에서 Environment=KEY=VALUE 값을 읽는다(없으면 빈 문자열).
# → 한 번 배포한 MCP 설정을 다음 배포가 자동으로 기억하게 하는 장치.
unit_env() {  # $1=key
    [[ -f "$MCP_SERVICE_UNIT" ]] || return 0
    sed -n "s|^Environment=$1=||p" "$MCP_SERVICE_UNIT" | tail -n1
}

MCP_ENABLED="${MCP_ENABLED:-1}"                        # 0 으로 두면 MCP 전체 건너뜀
# 우선순위: 명시한 env > 설치된 유닛에 저장된 값 > 기본값.
# → 최초 한 번 'MCP_HOST=0.0.0.0 ./deploy.sh' 하면, 이후 './deploy.sh update' 가
#   매번 다시 지정하지 않아도 같은 값을 유지한다(되돌리려면 그때만 env 로 덮어쓰기).
MCP_HOST="${MCP_HOST:-$(unit_env MCP_HOST)}";  MCP_HOST="${MCP_HOST:-127.0.0.1}"
MCP_PORT="${MCP_PORT:-$(unit_env MCP_PORT)}";  MCP_PORT="${MCP_PORT:-3002}"
MCP_API_BASE="${MCP_API_BASE:-$(unit_env REPORTARCHIVE_API_BASE)}"; MCP_API_BASE="${MCP_API_BASE:-http://127.0.0.1:3000}"
# DNS rebinding 보호 허용 Host(쉼표구분). 비우면 server.py 가 비-localhost 바인딩 시
# 보호를 끈다(사내망). 외부 노출 시 도메인/IP 지정 권장. 이 값도 위처럼 기억된다.
MCP_ALLOWED_HOSTS="${MCP_ALLOWED_HOSTS:-$(unit_env MCP_ALLOWED_HOSTS)}"

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
        -e "s|@@MCP_ALLOWED_HOSTS@@|$MCP_ALLOWED_HOSTS|g" \
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

# ── Background worker (작업 큐) — 같은 app.sif 재사용, 별도 venv 없음. 비치명적. ──
render_worker_service_unit() {
    [[ -f "$HERE/reportarchive-worker.service.template" ]] \
        || { warn "reportarchive-worker.service.template 없음 — 워커 유닛 건너뜀"; return 1; }
    info "Rendering worker systemd unit → $WORKER_SERVICE_UNIT"
    sed -e "s|@@USER@@|$OPERATOR|g" \
        -e "s|@@INSTALL_DIR@@|$INSTALL_DIR|g" \
        "$HERE/reportarchive-worker.service.template" > "$WORKER_SERVICE_UNIT"
    chmod 644 "$WORKER_SERVICE_UNIT"
    systemctl daemon-reload
}

setup_worker() {
    [[ "$WORKER_ENABLED" == "1" ]] || { info "워커 비활성(WORKER_ENABLED=0) — 건너뜀"; return 0; }
    render_worker_service_unit || return 0
    systemctl enable "$WORKER_SERVICE_NAME" >/dev/null 2>&1 || true
    systemctl restart "$WORKER_SERVICE_NAME" \
        || warn "워커 서비스 기동 실패 — 'journalctl -u $WORKER_SERVICE_NAME' 확인"
    info "Worker: $WORKER_SERVICE_NAME (백그라운드 잡 처리 — 오펀 정리·AI 임베딩 등)"
}

# ── 주기 스케줄러 (systemd 타이머, 매분) — 워커와 짝. 비치명적. ──
render_scheduler_units() {
    [[ -f "$HERE/reportarchive-scheduler.service.template" \
       && -f "$HERE/reportarchive-scheduler.timer.template" ]] \
        || { warn "scheduler 템플릿 없음 — 스케줄러 건너뜀"; return 1; }
    info "Rendering scheduler systemd units → $SCHEDULER_SERVICE_UNIT (+ .timer)"
    sed -e "s|@@USER@@|$OPERATOR|g" \
        -e "s|@@INSTALL_DIR@@|$INSTALL_DIR|g" \
        "$HERE/reportarchive-scheduler.service.template" > "$SCHEDULER_SERVICE_UNIT"
    # 타이머 템플릿은 치환 자리표시자가 없어 그대로 복사.
    cp "$HERE/reportarchive-scheduler.timer.template" "$SCHEDULER_TIMER_UNIT"
    chmod 644 "$SCHEDULER_SERVICE_UNIT" "$SCHEDULER_TIMER_UNIT"
    systemctl daemon-reload
}

setup_scheduler() {
    [[ "$SCHEDULER_ENABLED" == "1" ]] || { info "스케줄러 비활성(SCHEDULER_ENABLED=0) — 건너뜀"; return 0; }
    render_scheduler_units || return 0
    # 활성화·기동은 .timer 로(oneshot .service 는 타이머가 매분 트리거).
    systemctl enable "${SCHEDULER_SERVICE_NAME}.timer" >/dev/null 2>&1 || true
    systemctl restart "${SCHEDULER_SERVICE_NAME}.timer" \
        || warn "스케줄러 타이머 기동 실패 — 'journalctl -u ${SCHEDULER_SERVICE_NAME}.timer' 확인"
    info "Scheduler: ${SCHEDULER_SERVICE_NAME}.timer (매분 — 데이터소스 주기 동기화 적재)"
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

    setup_worker || warn "워커 설정 건너뜀(비치명적)"
    setup_scheduler || warn "스케줄러 설정 건너뜀(비치명적)"
    setup_mcp || warn "MCP 설정 건너뜀(비치명적)"

    cat <<MSG

[OK] Install complete.
  Logs:    sudo journalctl -u $SERVICE_NAME -f
  Health:  curl http://localhost:3000/api/health
  Seed login: admin / 32167  (change immediately)
  Worker:  sudo systemctl status $WORKER_SERVICE_NAME   (백그라운드 잡)
  Scheduler: sudo systemctl status ${SCHEDULER_SERVICE_NAME}.timer  (주기 동기화)
  MCP:     sudo systemctl status $MCP_SERVICE_NAME   (Claude 연동, 선택)
MSG
}

cmd_update() {
    [[ -f "$HERE/app.sif" ]]        || err "app.sif missing in $HERE"
    [[ -f "$INSTALL_DIR/.env" ]]    || err "$INSTALL_DIR/.env missing — run './deploy.sh install' first"

    info "Stopping $SERVICE_NAME"
    systemctl stop "$SERVICE_NAME" || true
    # 워커도 같은 app.sif 를 쓰고 마이그레이션 중 잡을 돌리면 안 되므로 함께 중지.
    systemctl stop "$WORKER_SERVICE_NAME" 2>/dev/null || true
    systemctl stop "${SCHEDULER_SERVICE_NAME}.timer" 2>/dev/null || true

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

    # 워커 + MCP 도 함께 갱신(유닛 재렌더 + 새 SIF 로 재기동). 비치명적.
    setup_worker || warn "워커 설정 건너뜀(비치명적)"
    setup_scheduler || warn "스케줄러 설정 건너뜀(비치명적)"
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
    systemctl stop "$WORKER_SERVICE_NAME" 2>/dev/null || true
    systemctl stop "${SCHEDULER_SERVICE_NAME}.timer" 2>/dev/null || true

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

    setup_worker || warn "워커 설정 건너뜀(비치명적)"
    setup_scheduler || warn "스케줄러 설정 건너뜀(비치명적)"

    cat <<MSG

[OK] Factory reset complete.
  Seed login: admin / 32167  (change immediately)
MSG
}

cmd_status() {
    systemctl --no-pager --lines=10 status "$SERVICE_NAME" || true
    echo
    echo "--- worker (백그라운드 잡) ---"
    systemctl --no-pager --lines=5 status "$WORKER_SERVICE_NAME" 2>/dev/null || echo "(워커 유닛 없음 — WORKER_ENABLED=0 또는 미설치)"
    echo "--- scheduler (주기 동기화 타이머) ---"
    systemctl --no-pager --lines=5 status "${SCHEDULER_SERVICE_NAME}.timer" 2>/dev/null || echo "(스케줄러 타이머 없음 — SCHEDULER_ENABLED=0 또는 미설치)"
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
