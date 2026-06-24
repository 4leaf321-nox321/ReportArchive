"""phase 53 — 엔티티 입력 거버넌스(정책·패턴·별칭)

자유 입력으로 쌓이는 노이즈(오타·표기흔들림·중복)를 **입력 시점**에 차단한다.
세 장치(엔티티관리개선_설계.md §3.1):

  * entity_types.entry_policy  open|closed — closed면 admin만 값 등록(사용자는 선택만)
  * entity_types.value_pattern (정규식) — 값 형식 강제(예: BOM `^[0-9]{8}$`)
  * entity_aliases — 같은 대상의 다른 표기를 canonical 로 자동 흡수(사후 merge 소멸)

완전 additive — 기존 7축은 entry_policy='open'·value_pattern=NULL 로 시작해 현행
동작(누구나 자유 추가) 그대로 유지. 별칭 테이블은 비어서 시작.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "p53_entity_governance"
down_revision: Union[str, None] = "p52_template_entity_types"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# create_type=False — 아래 upgrade 에서 한 번만 명시적으로 만든다(add_column 이
# 중복 생성하지 않도록).
entry_policy_enum = postgresql.ENUM(
    "open", "closed", name="entity_entry_policy_enum", create_type=False
)


def upgrade() -> None:
    bind = op.get_bind()
    entry_policy_enum.create(bind, checkfirst=True)

    op.add_column(
        "entity_types",
        sa.Column(
            "entry_policy",
            entry_policy_enum,
            nullable=False,
            server_default="open",
        ),
    )
    op.add_column(
        "entity_types",
        sa.Column("value_pattern", sa.String(length=255), nullable=True),
    )

    op.create_table(
        "entity_aliases",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("entity_id", sa.Integer(), nullable=False),
        # type_id 를 비정규화로 들고 있다(=entity 의 축). (type_id, normalized)
        # 유니크로 "한 축 안에서 같은 표기가 두 값에 매핑" 을 막고, resolve 도
        # 빨라진다.
        sa.Column("type_id", sa.Integer(), nullable=False),
        sa.Column("alias", sa.String(length=255), nullable=False),
        sa.Column("normalized", sa.String(length=255), nullable=False),
        sa.Column("created_by_user_id", sa.Integer(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(
            ["entity_id"], ["entities.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["type_id"], ["entity_types.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["created_by_user_id"], ["users.id"], ondelete="SET NULL"
        ),
        sa.UniqueConstraint(
            "type_id", "normalized", name="uq_entity_aliases_type_norm"
        ),
    )
    op.create_index(
        "ix_entity_aliases_entity", "entity_aliases", ["entity_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_entity_aliases_entity", table_name="entity_aliases")
    op.drop_table("entity_aliases")
    op.drop_column("entity_types", "value_pattern")
    op.drop_column("entity_types", "entry_policy")
    entry_policy_enum.drop(op.get_bind(), checkfirst=True)
