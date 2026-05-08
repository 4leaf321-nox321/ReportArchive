"""
Alembic environment.

Reads DATABASE_URL from app.config.settings so the migration tool stays
in sync with the running application.
"""
from __future__ import annotations

from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from app.config import settings
from app.database import Base

# Import models so Alembic can autogenerate migrations against them.
from app.modules.workspaces import models as _workspaces_models  # noqa: F401
from app.modules.users import models as _users_models  # noqa: F401
from app.modules.template_categories import models as _categories_models  # noqa: F401
from app.modules.templates import models as _templates_models  # noqa: F401
from app.modules.reports import models as _reports_models  # noqa: F401
from app.modules.files import models as _files_models  # noqa: F401
# auth/members modules don't have their own models — they reuse users + workspace_members

config = context.config
config.set_main_option("sqlalchemy.url", settings.database_url)

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(
        url=settings.database_url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
