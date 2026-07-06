"""phase 67 — 온톨로지 강화 A0.3 스텝2 (object_links, cross-kind 링크)

entity ↔ system 객체(부서=workspace) 링크를 담는 `object_links`(안 B). record 객체는
entities 에 살아 record↔record 는 entity_relations 로 이미 동작 — 이 테이블은 한쪽
끝이 entities 밖(system)인 링크만 담는다. 식별자가 정수·문자열 섞여 `*_id` 는 varchar.

시드(additive·idempotent):
  1. object_links 테이블.
  2. dept(부서) system 축 — kind_class='system'. 값 행은 안 만든다(ObjectRef 가
     workspaces 를 투영). entry_policy=closed(picker 로 값 추가 불가).
  3. relation_types 에 owned_by(과제 → 부서) 추가.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "p67_object_links"
down_revision: Union[str, None] = "p66_record_axes_seed"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "object_links",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("src_type", sa.String(length=32), nullable=False),
        sa.Column("src_id", sa.String(length=64), nullable=False),
        sa.Column("dst_type", sa.String(length=32), nullable=False),
        sa.Column("dst_id", sa.String(length=64), nullable=False),
        sa.Column("relation", sa.String(length=32), nullable=False),
        sa.Column(
            "properties", postgresql.JSONB(), nullable=False, server_default="{}"
        ),
        sa.Column(
            "evidence_report_id",
            sa.Integer(),
            sa.ForeignKey("reports.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("evidence_note", sa.String(length=500), nullable=True),
        sa.Column(
            "created_by_user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()
        ),
        sa.UniqueConstraint(
            "src_type", "src_id", "dst_type", "dst_id", "relation",
            name="uq_object_links",
        ),
    )
    op.create_index("ix_object_links_src", "object_links", ["src_type", "src_id"])
    op.create_index("ix_object_links_dst", "object_links", ["dst_type", "dst_id"])

    bind = op.get_bind()

    # dept(부서) system 축 — 값 행 없이 축만 등록(ObjectRef 가 workspaces 투영).
    exists = bind.execute(
        sa.text("SELECT id FROM entity_types WHERE slug = 'dept'")
    ).scalar()
    if exists is None:
        so = bind.execute(
            sa.text("SELECT COALESCE(MAX(sort_order), 0) FROM entity_types")
        ).scalar() or 0
        bind.execute(
            sa.text(
                """
                INSERT INTO entity_types
                    (slug, label, icon, multi, sort_order, description,
                     entry_policy, temporal_kind, kind_class)
                VALUES
                    ('dept', '부서', '', true, :so,
                     '조직(워크스페이스) 투영 — 값은 여기서 만들지 않습니다.',
                     CAST('closed' AS entity_entry_policy_enum),
                     CAST('evergreen' AS entity_temporal_kind_enum),
                     CAST('system' AS entity_kind_class_enum))
                """
            ),
            {"so": so + 1},
        )

    # owned_by(과제 → 부서) 관계 종류.
    rso = bind.execute(
        sa.text("SELECT COALESCE(MAX(sort_order), 0) FROM relation_types")
    ).scalar() or 0
    bind.execute(
        sa.text(
            """
            INSERT INTO relation_types
                (slug, label, inverse_label, directed, transitive, acyclic,
                 src_axis_slugs, dst_axis_slugs, sort_order, description)
            VALUES
                ('owned_by', '담당 부서', '담당 과제', true, false, false,
                 :src, :dst, :so, '과제를 담당하는 부서(과제 owned_by 부서).')
            ON CONFLICT (slug) DO NOTHING
            """
        ),
        {"src": ["project"], "dst": ["dept"], "so": rso + 1},
    )


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text("DELETE FROM relation_types WHERE slug = 'owned_by'"))
    bind.execute(sa.text("DELETE FROM entity_types WHERE slug = 'dept'"))
    op.drop_index("ix_object_links_dst", table_name="object_links")
    op.drop_index("ix_object_links_src", table_name="object_links")
    op.drop_table("object_links")
