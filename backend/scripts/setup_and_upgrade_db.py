"""
Idempotent database bootstrap for ops.

A single command that does the right thing on every deploy — both the
initial setup and ongoing upgrades go through this script:

    python scripts/setup_and_upgrade_db.py

Decision tree (each step is idempotent):
  1. CREATE DATABASE if it does not exist.
  2. Look at migrations/versions/ to decide schema strategy:
     a. Has any committed migration files
        -> Alembic is the source of truth.
        -> If the DB has tables but no `alembic_version` row, this is a
           legacy DB created by an older create_all run. Stamp it to
           `head` so Alembic won't try to re-create the same tables, then
           upgrade as usual.
        -> Run `alembic upgrade head`. New migrations get applied; ones
           already applied are skipped automatically.
     b. No migration files yet (early development before first revision)
        -> Fall back to `Base.metadata.create_all()` so the project boots
           with the current models. Once the first migration is generated,
           the next run flips automatically into branch (a).

Equivalent to Flask-Migrate's `flask db upgrade`, but with auto-creation
of the database and automatic bootstrap when no migrations exist.

What this does NOT do:
  - Drop or modify existing data.
  - Try to reverse-engineer schema differences. If you change a model,
    generate a migration first:
        alembic revision --autogenerate -m "msg"
"""
from __future__ import annotations

import sys
from pathlib import Path

# Allow `python scripts/setup_and_upgrade_db.py` invocation from the backend root.
BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine.url import URL, make_url

from app.config import settings
from app.database import Base, engine

# Importing each module's models registers them with Base.metadata so
# create_all (the bootstrap branch) knows what to build. Add a line here
# for every new module.
from app.modules.workspaces import models as _workspaces_models  # noqa: F401
from app.modules.users import models as _users_models  # noqa: F401
from app.modules.template_categories import models as _categories_models  # noqa: F401
from app.modules.templates import models as _templates_models  # noqa: F401
from app.modules.reports import models as _reports_models  # noqa: F401
from app.modules.files import models as _files_models  # noqa: F401


ADMIN_DB = "postgres"
ALEMBIC_INI = BACKEND_ROOT / "alembic.ini"
MIGRATIONS_VERSIONS = BACKEND_ROOT / "migrations" / "versions"


# --------------------------------------------------------------------------- #
# Step 1: database
# --------------------------------------------------------------------------- #
def ensure_database_exists(target_url: URL) -> bool:
    """Create the target database if missing. Returns True if newly created."""
    target_db = target_url.database
    if not target_db:
        raise RuntimeError(f"DATABASE_URL has no database name: {target_url}")

    admin_engine = create_engine(
        target_url.set(database=ADMIN_DB),
        isolation_level="AUTOCOMMIT",
    )
    try:
        with admin_engine.connect() as conn:
            exists = conn.execute(
                text("SELECT 1 FROM pg_database WHERE datname = :n"),
                {"n": target_db},
            ).scalar()
            if exists:
                print(f"[OK ] Database already exists: {target_db}")
                return False
            quoted = conn.dialect.identifier_preparer.quote(target_db)
            conn.execute(text(f"CREATE DATABASE {quoted}"))
            print(f"[NEW] Created database: {target_db}")
            return True
    finally:
        admin_engine.dispose()


# --------------------------------------------------------------------------- #
# Step 2: schema (Alembic if available, otherwise create_all bootstrap)
# --------------------------------------------------------------------------- #
def has_any_migration_files() -> bool:
    """True if migrations/versions/ contains at least one revision file."""
    if not MIGRATIONS_VERSIONS.exists():
        return False
    for entry in MIGRATIONS_VERSIONS.iterdir():
        if entry.is_file() and entry.suffix == ".py" and not entry.name.startswith("__"):
            return True
    return False


def _alembic_config():
    from alembic.config import Config

    cfg = Config(str(ALEMBIC_INI))
    # Prefer runtime DATABASE_URL over whatever is in alembic.ini, so the
    # script behaves consistently with the running app.
    cfg.set_main_option("sqlalchemy.url", settings.database_url)
    return cfg


def alembic_upgrade_head() -> None:
    from alembic import command

    command.upgrade(_alembic_config(), "head")


def alembic_stamp_head() -> None:
    from alembic import command

    command.stamp(_alembic_config(), "head")


def apply_schema() -> None:
    insp = inspect(engine)
    existing_tables = set(insp.get_table_names())
    has_alembic_table = "alembic_version" in existing_tables
    has_user_tables = any(t != "alembic_version" for t in existing_tables)

    if has_any_migration_files():
        # Branch (a): Alembic is in charge.
        if has_user_tables and not has_alembic_table:
            # Legacy DB created by an older create_all run. Mark it as
            # already-at-head so Alembic won't re-apply the create
            # migration. This trusts that the existing schema matches the
            # head migration, which holds when both came from the same
            # models in this repo.
            print("[..] Legacy schema detected (no alembic_version); stamping head")
            alembic_stamp_head()

        print("[..] Running alembic upgrade head")
        alembic_upgrade_head()
        print("[OK ] Migrations applied (already-applied ones are skipped)")
        return

    # Branch (b): no migrations committed yet. Bootstrap so the project
    # works before someone generates the first revision.
    print(f"[..] No Alembic migrations yet; bootstrapping with create_all on {engine.url}")
    Base.metadata.create_all(bind=engine)
    table_list = ", ".join(sorted(Base.metadata.tables)) or "(none)"
    print(f"[OK ] Tables ensured: {table_list}")
    print("     Tip: once you generate the first migration, this script will switch")
    print("          to alembic upgrade head automatically.")


# --------------------------------------------------------------------------- #
# Entrypoint
# --------------------------------------------------------------------------- #
def main() -> int:
    try:
        ensure_database_exists(make_url(settings.database_url))
        apply_schema()
    except Exception as exc:
        print(f"[ERR] {exc}", file=sys.stderr)
        return 1
    print("[DONE]")
    return 0


if __name__ == "__main__":
    sys.exit(main())
