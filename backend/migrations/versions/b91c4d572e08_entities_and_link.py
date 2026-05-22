"""Entity tagging tables + 7-axis seed

Revision ID: b91c4d572e08
Revises: a8e3f2b91c45
Create Date: 2026-05-23 14:00:00.000000

Adds the N-axis controlled-vocabulary tables agreed on in 개발계획 §1-2/§1-4:

- `entity_types`   — the axes (model/part/bom/phase/defect/rel_test/sim_type)
- `entities`       — the values within each axis (active/deprecated)
- `report_entities` — M:N link from Report ↔ Entity

Seven `entity_types` rows are seeded inline so the picker has something to
render immediately after the migration runs. The set is system-managed —
adding an 8th axis later means another migration, not an admin UI action.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "b91c4d572e08"
down_revision: Union[str, None] = "a8e3f2b91c45"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_STATUS_VALUES = ("active", "deprecated")

# Lucide icon names — kept as strings so the icon set can swap without
# a migration. Frontend resolves these via lucide-react.
_SEED_TYPES = [
    {"slug": "model",    "label": "모델명",        "icon": "tag",           "multi": True,  "sort_order": 10},
    {"slug": "part",     "label": "부품명",        "icon": "layers",        "multi": True,  "sort_order": 20},
    {"slug": "bom",      "label": "BOM Code",     "icon": "barcode",       "multi": True,  "sort_order": 30},
    {"slug": "phase",    "label": "개발 단계",     "icon": "git-branch",    "multi": False, "sort_order": 40},
    {"slug": "defect",   "label": "불량 종류",     "icon": "bug",           "multi": True,  "sort_order": 50},
    {"slug": "rel_test", "label": "신뢰성 시험",   "icon": "flask-conical", "multi": True,  "sort_order": 60},
    {"slug": "sim_type", "label": "시뮬레이션 종류","icon": "cpu",           "multi": True,  "sort_order": 70},
]


def upgrade() -> None:
    op.create_table(
        "entity_types",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("slug", sa.String(length=32), nullable=False),
        sa.Column("label", sa.String(length=64), nullable=False),
        sa.Column("icon", sa.String(length=32), nullable=False, server_default=""),
        sa.Column("multi", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
    )
    op.create_index("uq_entity_types_slug", "entity_types", ["slug"], unique=True)

    op.create_table(
        "entities",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "type_id",
            sa.Integer(),
            sa.ForeignKey("entity_types.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("value", sa.String(length=255), nullable=False),
        sa.Column("code", sa.String(length=64), nullable=True),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column(
            "status",
            sa.Enum(*_STATUS_VALUES, name="entity_status_enum"),
            nullable=False,
            server_default="active",
        ),
        sa.Column(
            "created_by_user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
    )
    op.create_index("ix_entities_type_status", "entities", ["type_id", "status"])
    op.create_index("ix_entities_type_value", "entities", ["type_id", "value"])
    op.create_index("ix_entities_created_by", "entities", ["created_by_user_id"])

    op.create_table(
        "report_entities",
        sa.Column(
            "report_id",
            sa.Integer(),
            sa.ForeignKey("reports.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "entity_id",
            sa.Integer(),
            sa.ForeignKey("entities.id", ondelete="RESTRICT"),
            primary_key=True,
        ),
    )
    op.create_index(
        "ix_report_entities_entity", "report_entities", ["entity_id"]
    )

    # Seed the 7 axes. Bulk-insert keeps the row order deterministic so
    # the `sort_order` column drives presentation rather than insert
    # timing. Idempotent enough: this migration only runs once.
    entity_types_table = sa.table(
        "entity_types",
        sa.column("slug", sa.String),
        sa.column("label", sa.String),
        sa.column("icon", sa.String),
        sa.column("multi", sa.Boolean),
        sa.column("sort_order", sa.Integer),
        sa.column("description", sa.Text),
    )
    op.bulk_insert(
        entity_types_table,
        [
            {
                "slug": row["slug"],
                "label": row["label"],
                "icon": row["icon"],
                "multi": row["multi"],
                "sort_order": row["sort_order"],
                "description": "",
            }
            for row in _SEED_TYPES
        ],
    )


def downgrade() -> None:
    op.drop_index("ix_report_entities_entity", table_name="report_entities")
    op.drop_table("report_entities")

    op.drop_index("ix_entities_created_by", table_name="entities")
    op.drop_index("ix_entities_type_value", table_name="entities")
    op.drop_index("ix_entities_type_status", table_name="entities")
    op.drop_table("entities")
    sa.Enum(name="entity_status_enum").drop(op.get_bind(), checkfirst=True)

    op.drop_index("uq_entity_types_slug", table_name="entity_types")
    op.drop_table("entity_types")
