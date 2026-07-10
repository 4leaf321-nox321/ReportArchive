"""phase 72 — system 객체 확장 스텝2(수동 관계): led_by(과제 → 담당 PL user)

데이터에 없는 새 의미 = 과제의 담당자(PL). object_links 로 수동 지정한다(엔티티 src →
user system 객체). 관계 종류만 시드 — 링크는 사용자가 UI 로 건다.

(report↔report supersedes/cites 는 report 측 UI·system-src 링크 라우트가 필요해 후속.)
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "p72_led_by_relation"
down_revision: Union[str, None] = "p71_system_user_report"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
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
                ('led_by', '담당 PL', '담당 과제', true, false, false,
                 :src, :dst, :so, '과제의 담당자(PL). object_links 로 수동 지정.')
            ON CONFLICT (slug) DO NOTHING
            """
        ),
        {"src": ["project"], "dst": ["user"], "so": rso + 1},
    )


def downgrade() -> None:
    op.get_bind().execute(
        sa.text("DELETE FROM relation_types WHERE slug = 'led_by'")
    )
