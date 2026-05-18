# Report Archive — 운영 배포 가이드

폐쇄망 운영 서버에 반입한 릴리스 번들 안에서 실행하는 절차.
모든 작업은 단일 스크립트 `deploy.sh`의 서브커맨드로 한다.

대상 환경: **Ubuntu 24.04 LTS**, sudo 가능한 운영 계정.

---

## 0. 번들 풀기

서버 정책상 `/home`에서 스크립트 실행이 막힐 수 있으므로 **`/tmp`에 풀어 거기서 실행하는 걸 권장**한다.

```bash
tar xzf reportarchive-<version>.tar.gz -C /tmp/
cd /tmp/reportarchive-<version>
ls
#  app.sif  deploy.sh  reportarchive.service.template
#  .env.example  README.md  VERSION
```

`deploy.sh`는 자신이 풀린 위치에 의존하지 않으므로 다른 경로에서 실행해도 동작한다.

---

## 1. (최초 1회) 서버 준비

OS 패키지 + PostgreSQL + DB 사용자/DB + 설치 디렉터리 생성.
**이미 준비된 서버라면 건너뛰기.**

```bash
sudo ./deploy.sh prepare
```

자동 처리:
- `apptainer`, `postgresql`, `postgresql-contrib`, `python3` 설치
- `postgresql` enable + start
- 설치 디렉터리 `/home/<운영계정>/Projects/ReportArchive/{uploads,logs}` 생성
- DB 역할 `reportarchive` + DB `report_automation` 생성

> 폐쇄망 정책상 apt가 차단돼 있으면 운영팀에 위 4개 패키지 사내 미러/.deb 반입을 요청하고, 그 단계만 건너뛴 뒤 `prepare`를 다시 실행. 이미 패키지가 있으면 apt가 no-op로 끝남.

---

## 2. 설치 (최초)

```bash
sudo ./deploy.sh install
```

자동 처리:
- `app.sif` → `<INSTALL_DIR>/app.sif`
- `.env`가 없으면 자동 생성 — `.env.example`을 베이스로 **랜덤 SECRET_KEY/JWT_SECRET_KEY + 새 DB 비밀번호**를 채워 넣음 (Postgres 역할 비밀번호도 동시에 갱신)
- 마이그레이션 (`setup_and_upgrade_db.py`)
- 시드 (`seed_initial_data.py` — `dx` 부서 + `admin@example.com / admin1234`)
- systemd 유닛 렌더링 (`@@USER@@`, `@@INSTALL_DIR@@` 치환) → enable + start

검증:
```bash
sudo ./deploy.sh status
curl http://localhost:3000/api/health
sudo journalctl -u reportarchive -f
```

> **최초 로그인 후 즉시 admin1234 비밀번호 변경**.
> `.env`의 CORS_ORIGINS는 운영 도메인에 맞춰 한 번 손보고 `sudo systemctl restart reportarchive`.

---

## 3. 업데이트 (다음 릴리스부터)

새 번들을 받아 `/tmp`에 풀고, 그 디렉터리에서:

```bash
sudo ./deploy.sh update
```

자동 처리:
- 서비스 중지
- 이전 SIF → `app.sif.prev` 백업
- 새 SIF 배치
- 마이그레이션 (idempotent, 추가분만 적용)
- systemd 유닛 재렌더링 (템플릿이 바뀌었을 경우 반영)
- 서비스 재시작

`.env`, DB, uploads는 건드리지 않음.

**롤백** (이전 SIF로):
```bash
sudo systemctl stop reportarchive
sudo mv <INSTALL_DIR>/app.sif.prev <INSTALL_DIR>/app.sif
sudo systemctl start reportarchive
```

---

## 4. 팩토리 리셋 (DB · 업로드 통째로 초기화)

데이터가 깨졌거나 시드만 다시 깔고 싶을 때:

```bash
sudo ./deploy.sh reset
```

`reset` 입력으로 한 번 더 확인을 받고, 그 뒤:
- 서비스 중지
- `DROP DATABASE` → `CREATE DATABASE` (빈 스키마)
- `<INSTALL_DIR>/uploads/*` 삭제
- (현재 디렉터리에 새 `app.sif`이 있으면) SIF 교체
- 마이그레이션 + 시드 재실행
- 서비스 재시작

**보존되는 것:** `.env`, Postgres 역할, systemd 유닛, OS 패키지.

---

## 5. 한 명령으로 자동 분기

서브커맨드 없이 그냥 실행하면 알아서 install / update 중 하나를 고른다:

```bash
sudo ./deploy.sh
# → 설치된 흔적이 없으면 install, 있으면 update
```

판정 기준: `<INSTALL_DIR>/app.sif` + `<INSTALL_DIR>/.env` + 시스템 유닛이 모두 있으면 update, 하나라도 빠지면 install.

---

## 설정 오버라이드

| 환경변수 | 기본값 |
|---|---|
| `OPERATOR` | `$SUDO_USER` (sudo 호출한 계정) |
| `INSTALL_DIR` | `/home/$OPERATOR/Projects/ReportArchive` |
| `DB_NAME` | `report_automation` |
| `DB_USER` | `reportarchive` |

다른 경로에 설치하고 싶으면:
```bash
sudo INSTALL_DIR=/srv/reportarchive ./deploy.sh install
```

---

## 운영 메모

- **로그**: `sudo journalctl -u reportarchive -f`
- **업로드 파일**: `<INSTALL_DIR>/uploads/` — 백업 대상
- **DB 백업**: `sudo -u postgres pg_dump report_automation > backup.sql`
- **`.env` 수정 후**: `sudo systemctl restart reportarchive`
- **포트 변경**: `.env`의 `APP_PORT`만 수정 후 재시작. Apptainer는 호스트 네트워크라 추가 매핑 불필요.
- **HTTPS / 도메인**: nginx를 앞단에 두는 패턴 권장 — 레포의 `nginx/nginx.conf.example` 참고.

---

## 트러블슈팅

| 증상 | 확인 |
|---|---|
| `apptainer: command not found` | `sudo ./deploy.sh prepare` 또는 수동 `apt install apptainer` |
| `systemctl status` → `failed` | `journalctl -u reportarchive -n 50` |
| `connection refused :5432` | `sudo systemctl status postgresql` |
| 로그인 안 됨 / 비밀번호 모름 | `sudo ./deploy.sh reset` (DB 통째로 초기화 후 시드 admin 계정 복구) |
| 로그인은 되는데 화면 빈 페이지 | `.env`의 `SERVE_FRONTEND_DIST` 확인 |
| 파일 업로드 시 `Permission denied` | `sudo chown -R $OPERATOR:$OPERATOR <INSTALL_DIR>/uploads` |
| `/home`에서 스크립트 실행이 막힘 | `/tmp`에 풀어서 실행 (가이드 0번 항목) |
