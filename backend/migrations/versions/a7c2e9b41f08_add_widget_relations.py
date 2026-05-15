"""add widget_relations + seed builtins

Revision ID: a7c2e9b41f08
Revises: 1eb745bfd049
Create Date: 2026-05-14 00:00:00.000000

"""
import json
from datetime import datetime
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "a7c2e9b41f08"
down_revision: Union[str, None] = "1eb745bfd049"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


BUILTIN_RELATIONS = [
    # (slug, name, description, hint_keywords, sort_order)
    (
        "detail",
        "상세",
        "부모 항목을 부연·세분화하는 기본 관계 (별도 라벨이 표시되지 않음)",
        [],
        10,
    ),
    (
        "cause",
        "원인",
        "부모의 발생 원인·이유",
        ["왜냐하면", "때문에", "이유는", "원인은", "탓에"],
        20,
    ),
    (
        "effect",
        "결과",
        "부모로 인한 결과·귀결",
        ["따라서", "그 결과", "결국", "그래서", "이로 인해"],
        30,
    ),
    (
        "evidence",
        "근거",
        "부모 주장을 뒷받침하는 데이터·사실",
        ["근거로", "증거로", "수치로", "데이터로", "통계상"],
        40,
    ),
    (
        "example",
        "예시",
        "부모의 구체적 사례",
        ["예를 들어", "예:", "이를테면", "가령", "사례로"],
        50,
    ),
    (
        "counter",
        "반례",
        "부모와 상반되는 사례·예외",
        ["반면", "그러나", "예외적으로", "다만", "단,"],
        60,
    ),
    (
        "compare",
        "비교",
        "부모와의 대조·비교 항목",
        ["대비", "비교하면", "vs", "와는 달리", "에 비해"],
        70,
    ),
]


def upgrade() -> None:
    op.create_table(
        "widget_relations",
        sa.Column("slug", sa.String(length=32), nullable=False),
        sa.Column("name", sa.String(length=64), nullable=False),
        sa.Column("description", sa.String(length=256), nullable=True),
        sa.Column(
            "hint_keywords",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
        ),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.Column("is_builtin", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("slug"),
    )

    now = datetime.utcnow()
    bind = op.get_bind()
    for slug, name, description, hints, sort_order in BUILTIN_RELATIONS:
        bind.execute(
            sa.text(
                """
                INSERT INTO widget_relations
                    (slug, name, description, hint_keywords, sort_order,
                     is_builtin, created_at, updated_at)
                VALUES
                    (:slug, :name, :description, CAST(:hints AS JSONB),
                     :sort_order, TRUE, :now, :now)
                """
            ),
            {
                "slug": slug,
                "name": name,
                "description": description,
                "hints": json.dumps(hints, ensure_ascii=False),
                "sort_order": sort_order,
                "now": now,
            },
        )


def downgrade() -> None:
    op.drop_table("widget_relations")
