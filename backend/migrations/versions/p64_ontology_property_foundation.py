"""phase 64 — 온톨로지 강화 A0.1 (속성 기반, 순수 추가)

엔티티를 통제어휘→객체로 승격하기 위한 첫 스키마 층. **전부 additive**라 기존
동작 무영향(온톨로지강화_설계.md §3):
  1. property_defs (신규 테이블) — 축/관계타입의 속성 정의 스키마.
  2. entities.properties (JSONB DEFAULT '{}') — 객체 속성 값.
  3. entity_types.kind_class (enum DEFAULT 'reference') — 객체 분류.

검증·API·UI 는 다음 스텝. 이 마이그레이션은 스키마만 추가하고 되돌리기(downgrade)도
깨끗하게 되돌아간다.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "p64_ontology_property_foundation"
down_revision: Union[str, None] = "p63_password_reset_tokens"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_KIND_ENUM = postgresql.ENUM(
    "reference", "record", "system",
    name="entity_kind_class_enum",
    create_type=False,
)


def upgrade() -> None:
    # 1. entity_types.kind_class — 기존 행은 전부 'reference'
    _KIND_ENUM.create(op.get_bind(), checkfirst=True)
    op.add_column(
        "entity_types",
        sa.Column(
            "kind_class",
            _KIND_ENUM,
            nullable=False,
            server_default="reference",
        ),
    )

    # 2. entities.properties — 기존 행은 전부 '{}'
    op.add_column(
        "entities",
        sa.Column(
            "properties",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )

    # 3. property_defs (신규 테이블)
    op.create_table(
        "property_defs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("owner_kind", sa.String(length=16), nullable=False),
        sa.Column("owner_id", sa.Integer(), nullable=False),
        sa.Column("key", sa.String(length=48), nullable=False),
        sa.Column("label", sa.String(length=64), nullable=False),
        sa.Column("data_type", sa.String(length=16), nullable=False),
        sa.Column("unit", sa.String(length=24), nullable=True),
        sa.Column("required", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("multi", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("enum_options", postgresql.JSONB(), nullable=True),
        sa.Column("ref_type_slug", sa.String(length=32), nullable=True),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("help", sa.String(length=255), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint(
            "owner_kind", "owner_id", "key", name="uq_property_defs_owner_key"
        ),
    )
    op.create_index(
        "ix_property_defs_owner", "property_defs", ["owner_kind", "owner_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_property_defs_owner", table_name="property_defs")
    op.drop_table("property_defs")
    op.drop_column("entities", "properties")
    op.drop_column("entity_types", "kind_class")
    _KIND_ENUM.drop(op.get_bind(), checkfirst=True)
