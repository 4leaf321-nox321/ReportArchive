# Backend (FastAPI)

FastAPI + SQLAlchemy 2.0 + PostgreSQL. Designed to be deployed independently
from the frontend, or to optionally serve the React build itself.

## Layout

```
backend/
├── app/
│   ├── main.py               # FastAPI factory (CORS, routers, SPA fallback)
│   ├── config.py             # Settings (pydantic-settings, .env)
│   ├── database.py           # Engine, SessionLocal, Base, get_db
│   ├── shared/               # responses.py, errors.py
│   └── modules/
│       ├── __init__.py       # register_routers(app)
│       └── reports/          # example feature module
│           ├── routes.py     # APIRouter (/api/reports)
│           ├── schemas.py    # Pydantic
│           ├── services.py   # business logic
│           └── models.py     # SQLAlchemy ORM
├── migrations/               # Alembic
├── scripts/                  # setup_and_upgrade_db.py, etc.
├── tests/                    # pytest
├── uploads/  data/           # runtime working dirs
├── run.py                    # uvicorn entry point
├── requirements.txt
├── alembic.ini
├── .env.example
├── setup_venv.bat
└── setup_venv.sh
```

## Quick start

```bash
# Windows
setup_venv.bat
venv\Scripts\activate
python run.py

# Linux / macOS
./setup_venv.sh
source venv/bin/activate
python run.py
```

The dev server listens on `http://0.0.0.0:5174` and exposes:

- `GET  /api/health` — health probe
- `GET  /api/docs`   — Swagger UI
- `GET  /api/redoc`  — ReDoc
- `*    /api/reports` — example CRUD

## Database

One command for every deploy:

```bash
python scripts/setup_and_upgrade_db.py
```

It is idempotent and picks the right strategy automatically:

| State on this machine | What the script does |
|---|---|
| DB is missing | `CREATE DATABASE` |
| No migrations in `migrations/versions/` yet | `Base.metadata.create_all()` (bootstrap) |
| Migrations exist, fresh DB | `alembic upgrade head` (creates everything from history) |
| Migrations exist, DB already managed by Alembic | `alembic upgrade head` (skips ones already applied) |
| Migrations exist, DB has tables but no `alembic_version` (legacy from older create_all) | `alembic stamp head` then `alembic upgrade head` |

### Schema changes (developer flow)

When you change a model:

```bash
alembic revision --autogenerate -m "add author column"
# review the generated migrations/versions/<hash>_*.py
git commit -am "schema: add author column"
```

On every server, the deploy command stays the same:

```bash
git pull
python scripts/setup_and_upgrade_db.py
```

This is the equivalent of Flask-Migrate's `flask db migrate` + `flask db
upgrade`, just with the prefix changed from `flask db` to `alembic`.

`DATABASE_URL` defaults to
`postgresql+psycopg://postgres:postgres@localhost:5432/report_automation`.
The role in `DATABASE_URL` must be allowed to connect to the admin DB
(`postgres`) and to issue `CREATE DATABASE`. In hardened environments
where a DBA pre-creates the database, the `CREATE DATABASE` step is
skipped automatically.

## Adding a new module

1. Copy `app/modules/reports/` → `app/modules/<your_module>/`
2. Update `routes.py`, `schemas.py`, `services.py`, `models.py`
3. Register the router in `app/modules/__init__.py`:

```python
from app.modules.<your_module>.routes import router as your_router
app.include_router(your_router, prefix="/api/<your-module>", tags=["<your-module>"])
```

## Deployment shapes

### Independent (frontend hosted elsewhere)

Leave `SERVE_FRONTEND_DIST` empty. Configure `CORS_ORIGINS` to allow the
frontend host.

### Combined (this app serves the React build)

Build the frontend, then point the backend at it:

```bash
# from frontend/
npm run build

# in backend/.env
SERVE_FRONTEND_DIST=../frontend/dist
```

The backend will serve `index.html` and `/assets/*` and fall back to SPA
routing for any non-`/api/*` path.
