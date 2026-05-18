# Report Archive — 운영 배포 가이드

폐쇄망 운영 서버에 반입한 릴리스 번들 안에서 실행하는 절차.

대상 환경: **Ubuntu 24.04 LTS**, sudo 가능한 운영 계정.

---

## 0. 반입된 번들 풀기

```bash
tar xzf reportarchive-<version>.tar.gz
cd reportarchive-<version>
ls
#  app.sif  install.sh  prepare_server.sh  update.sh
#  reportarchive.service  .env.example  README.md  VERSION
```

---

## 1. (최초 1회) 서버 준비

OS 패키지 설치, 서비스 계정 생성, 디렉터리 셋업. **이미 준비된 서버라면 건너뛰기.**

```bash
sudo ./prepare_server.sh
```

설치되는 것:
- `apptainer` (컨테이너 런타임)
- `postgresql`, `postgresql-contrib` (DB)
- 시스템 사용자 `reportarchive` (`/opt/reportarchive` 홈)

> 폐쇄망 정책상 apt가 차단돼 있으면, 운영팀에 위 3개 패키지를 사내 미러
> 또는 .deb 반입으로 설치 요청 후, `prepare_server.sh`의 첫 단계만
> 건너뛰고 나머지(useradd, mkdir)를 수동으로 실행.

---

## 2. (최초 1회) 데이터베이스 사용자·DB 생성

`.env`에 들어갈 비밀번호를 정한 다음, 그 값을 그대로 사용:

```bash
# 비밀번호는 .env의 DATABASE_URL과 반드시 일치시켜야 함
DB_PASSWORD='<여기를 강한 무작위로>'

sudo -u postgres psql <<SQL
CREATE USER reportarchive WITH PASSWORD '${DB_PASSWORD}';
CREATE DATABASE report_automation OWNER reportarchive;
SQL
```

> 이미 존재하면 `already exists` 에러가 떠도 무시. `ALTER USER ... WITH PASSWORD '...'`로 비번만 갱신해도 됨.

---

## 3. (최초 1회) `.env` 작성

```bash
cp .env.example .env
nano .env   # 또는 vi
```

**반드시 채워야 하는 값** (`.env.example` 주석 참고):
- `SECRET_KEY`, `JWT_SECRET_KEY` — 각각 다른 무작위 48자 이상
- `DATABASE_URL` — 2번 단계에서 정한 DB 비번을 그대로 박기
- `CORS_ORIGINS` — 실제 프론트엔드 호스트(들). 결합 배포면 빈 값도 OK.

비밀값 생성 팁:
```bash
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
```

---

## 4. 설치 (최초)

```bash
sudo ./install.sh
```

자동 처리:
- `app.sif` → `/opt/reportarchive/app.sif`
- `.env` → `/opt/reportarchive/.env` (퍼미션 600)
- 마이그레이션 (`setup_and_upgrade_db.py`, idempotent)
- systemd unit 설치·활성화·시작

검증:
```bash
sudo systemctl status reportarchive
curl http://localhost:3000/api/health
sudo journalctl -u reportarchive -f
```

---

## 5. 업데이트 (다음 릴리스부터 매번)

새 번들을 받아 압축 풀고, 그 디렉터리에서:

```bash
sudo ./update.sh
```

자동 처리:
- 서비스 중지
- 이전 SIF → `app.sif.prev` 백업
- 새 SIF 배치
- 마이그레이션 (새 항목만 적용)
- 서비스 재시작

**롤백** (직전 버전으로):
```bash
sudo systemctl stop reportarchive
sudo mv /opt/reportarchive/app.sif.prev /opt/reportarchive/app.sif
sudo systemctl start reportarchive
```

---

## 운영 메모

- **로그**: `sudo journalctl -u reportarchive -f` (uvicorn stdout/stderr가 journald로)
- **업로드 파일**: 호스트의 `/opt/reportarchive/uploads/` — 백업 대상
- **DB 백업**: `sudo -u postgres pg_dump report_automation > backup.sql`
- **`.env` 수정 후**: `sudo systemctl restart reportarchive`
- **포트 변경**: `.env`의 `APP_PORT`만 수정 후 재시작. Apptainer는 호스트 네트워크라 추가 매핑 불필요.
- **HTTPS / 도메인**: nginx를 앞단에 두는 패턴 권장 — 레포의 `nginx/nginx.conf.example` 참고.

---

## 트러블슈팅

| 증상 | 확인 |
|---|---|
| `apptainer: command not found` | `sudo apt install apptainer` |
| `systemctl status` → `failed` | `journalctl -u reportarchive -n 50` |
| `connection refused :5432` | `sudo systemctl status postgresql` |
| 로그인은 되는데 화면 빈 페이지 | `.env`의 `SERVE_FRONTEND_DIST` 확인 |
| 파일 업로드 시 `Permission denied` | `sudo chown -R reportarchive:reportarchive /opt/reportarchive/uploads` |
