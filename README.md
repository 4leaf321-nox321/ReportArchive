# Report Archive

FastAPI 백엔드 + React (Vite) 프론트엔드 + PostgreSQL 데이터베이스.
크로스 플랫폼(Windows / Linux / macOS) 빌드와, 두 컴포넌트의 독립
배포(서로 다른 서버) / 결합 배포(백엔드가 React 빌드를 함께 서빙)를
모두 지원하는 기본 골격입니다.

## 폴더 구조

```
62_reportAutomation/
├── backend/                  # FastAPI + SQLAlchemy + Alembic
│   ├── app/                  # 모듈식 패키지 (modules/, shared/)
│   ├── migrations/           # Alembic
│   ├── scripts/              # setup_and_upgrade_db.py 등
│   ├── tests/                # pytest
│   ├── run.py                # uvicorn entry point
│   ├── requirements.txt
│   ├── alembic.ini
│   ├── .env.example
│   ├── setup_venv.bat / .sh  # 크로스플랫폼 부트스트랩
│   └── README.md
├── frontend/                 # React 18 + Vite 5
│   ├── src/
│   │   ├── pages/            # 페이지 단위 컴포넌트
│   │   ├── modules/          # 기능별 모듈
│   │   ├── shared/           # api/client, components, hooks, utils
│   │   ├── App.jsx           # 라우팅
│   │   └── main.jsx
│   ├── public/
│   ├── index.html
│   ├── vite.config.js
│   ├── .env.example / .env.development / .env.production
│   ├── package.json
│   └── README.md
├── nginx/
│   └── nginx.conf.example    # 단일/분리 호스트 리버스 프록시 예시
└── README.md
```

## 핵심 설계 원칙

### 1. 독립 배포가 기본, 결합 배포는 옵션

- **독립**: `frontend`와 `backend`는 서로 다른 서버에 떠 있을 수 있다.
  프론트는 `VITE_API_BASE_URL`로 백엔드 호스트를 가리키고, 백엔드는
  `CORS_ORIGINS`로 프론트 출처를 허용한다.
- **결합**: 백엔드 `.env`에 `SERVE_FRONTEND_DIST=../frontend/dist`만
  지정하면, FastAPI가 `index.html`과 `/assets/*`를 같이 서빙하고
  `/api/*` 외 경로는 SPA 폴백으로 `index.html`을 돌려준다. 이 모드에서
  프론트엔드는 같은 origin이므로 CORS도 필요 없다.

### 2. API 표준 envelope

모든 API 응답은 다음 형태를 따른다:

```json
{ "success": true, "data": ..., "message": "...", "errors": [...] }
```

`shared/responses.py`(backend)와 `shared/api/client.js`(frontend)에
helper가 들어 있다.

### 3. 크로스 플랫폼 호환성

- 경로는 `pathlib.Path`로 처리, `os.path.sep` 가정 없음.
- 부트스트랩 스크립트를 `.bat`/`.sh` 양쪽으로 제공.
- 프론트는 Vite 빌드 산출물(`dist/`)이므로 어디서든 정적으로 서빙 가능.

## 빠른 실행

### 1) PostgreSQL 서버만 준비

PostgreSQL 인스턴스가 떠 있고 `backend/.env`의 `DATABASE_URL`이 가리키는
계정으로 접속만 가능하면 됩니다. **DB 자체는 `setup_and_upgrade_db.py`가
없으면 만들어줍니다** (idempotent).

기본 접속 문자열:
`postgresql+psycopg://postgres:postgres@localhost:5432/report_automation`

### 2) 백엔드

```bash
# Windows
cd backend
setup_venv.bat
venv\Scripts\activate
python scripts/setup_and_upgrade_db.py     # DB 생성 + 스키마 적용 (idempotent)
python run.py

# Linux / macOS
cd backend
./setup_venv.sh
source venv/bin/activate
python scripts/setup_and_upgrade_db.py     # DB 생성 + 스키마 적용 (idempotent)
python run.py
```

`scripts/setup_and_upgrade_db.py`는 운영 배포에서 매번 그대로 실행해도 됩니다.
상황에 따라 `CREATE DATABASE`, `Base.metadata.create_all`, 또는
`alembic upgrade head`를 자동으로 선택합니다 (자세한 분기는
`backend/README.md` 참고).

모델을 변경했을 때만 개발자가 마이그레이션을 한 번 생성합니다:

```bash
alembic revision --autogenerate -m "add author column"
git commit -am "schema: add author column"
```

이 후 운영 배포 명령어는 동일하게 `python scripts/setup_and_upgrade_db.py`
한 줄입니다.

- API : http://localhost:3000/api
- 헬스: http://localhost:3000/api/health
- 문서: http://localhost:3000/api/docs

### 3) 프론트엔드

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173
```

`/api/*` 호출은 Vite가 백엔드(`:3000`)로 프록시한다.

## 배포 시나리오

### A. 백엔드와 프론트엔드를 **다른 서버**에 두는 경우

```
backend/.env
  CORS_ORIGINS=https://app.example.com
  SERVE_FRONTEND_DIST=          # 비워둠

frontend/.env.production
  VITE_API_BASE_URL=https://api.example.com
```

- 백엔드 서버: `python run.py` (또는 systemd 등으로 uvicorn 다중 워커)
- 프론트엔드 서버: `npm run build` → `dist/`를 nginx/CloudFront/S3 등으로 서빙

### B. **같은 서버**에서 백엔드가 프론트 빌드를 함께 서빙

```
backend/.env
  SERVE_FRONTEND_DIST=../frontend/dist
  CORS_ORIGINS=                 # 같은 origin이므로 필요 없음

frontend/.env.production
  VITE_API_BASE_URL=            # 비워둠 → 상대 경로 /api/*
```

빌드 절차:

```bash
cd frontend && npm run build
cd ../backend && APP_ENV=production python run.py
```

### C. nginx 리버스 프록시

`nginx/nginx.conf.example`을 참고. 한 호스트에서 정적 파일 + `/api/*`
프록시를 모두 처리하는 표준 패턴이다.

## 새 기능 모듈 추가하기

### 백엔드

```
app/modules/<your_module>/
  __init__.py
  routes.py     # APIRouter 정의
  schemas.py    # Pydantic
  services.py   # 비즈니스 로직
  models.py     # SQLAlchemy ORM
```

`app/modules/__init__.py`에서 `include_router(...)`로 등록.

### 프론트엔드

```
src/modules/<your-module>/
  api.js              # backend 호출
  <YourModule>Page.jsx
```

`src/App.jsx`에 라우트 추가.
