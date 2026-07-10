"""phase 71 — system 객체 확장: user·report 축 + 파생 관계 카탈로그

dept(p67)에 이어 사용자·보고서를 1급 system 객체로 투영. 값 행은 안 만든다
(ObjectRef 가 users/reports 테이블을 투영). 파생 관계(FK로 온플라이 계산)는
relation_types 에 슬러그만 등록 — 엣지는 저장하지 않는다(설계 §2.2, 저장 0).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "p71_system_user_report"
down_revision: Union[str, None] = "p70_entity_provenance"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_AXES = [
    ("user", "사용자", "users 테이블 투영 — 값은 여기서 만들지 않습니다(이름만 노출)."),
    ("report", "보고서", "reports 테이블 투영 — 가시성 게이팅. 값은 여기서 만들지 않습니다."),
]

# 파생 관계(엣지 저장 안 함, 슬러그만): slug, label, inverse_label, src, dst, desc
_RELS = [
    ("authored_by", "작성자", "작성한 보고서", ["report"], ["user"],
     "보고서 작성자(reports.owner_user_id)."),
    ("edited_by", "편집자", "편집한 보고서", ["report"], ["user"],
     "보고서 최종 편집자(reports.last_edited_by_user_id)."),
    ("documents", "다룸", "다뤄진 보고서", ["report"], [],
     "보고서가 태깅/문서화한 객체(report_entities)."),
    ("published_in", "게시 부서", "게시된 보고서", ["report"], ["dept"],
     "보고서 소속/게시 부서(reports.workspace_slug)."),
    ("member_of", "소속 부서", "소속 사용자", ["user"], ["dept"],
     "사용자 소속 부서(home_workspace + memberships)."),
]


def upgrade() -> None:
    bind = op.get_bind()

    so = bind.execute(
        sa.text("SELECT COALESCE(MAX(sort_order), 0) FROM entity_types")
    ).scalar() or 0
    for slug, label, desc in _AXES:
        exists = bind.execute(
            sa.text("SELECT id FROM entity_types WHERE slug = :s"), {"s": slug}
        ).scalar()
        if exists is None:
            so += 1
            bind.execute(
                sa.text(
                    """
                    INSERT INTO entity_types
                        (slug, label, icon, multi, sort_order, description,
                         entry_policy, temporal_kind, kind_class)
                    VALUES
                        (:slug, :label, '', true, :so, :desc,
                         CAST('closed' AS entity_entry_policy_enum),
                         CAST('evergreen' AS entity_temporal_kind_enum),
                         CAST('system' AS entity_kind_class_enum))
                    """
                ),
                {"slug": slug, "label": label, "so": so, "desc": desc},
            )

    rso = bind.execute(
        sa.text("SELECT COALESCE(MAX(sort_order), 0) FROM relation_types")
    ).scalar() or 0
    for slug, label, inv, src, dst, desc in _RELS:
        rso += 1
        bind.execute(
            sa.text(
                """
                INSERT INTO relation_types
                    (slug, label, inverse_label, directed, transitive, acyclic,
                     src_axis_slugs, dst_axis_slugs, sort_order, description)
                VALUES
                    (:slug, :label, :inv, true, false, false,
                     :src, :dst, :so, :desc)
                ON CONFLICT (slug) DO NOTHING
                """
            ),
            {"slug": slug, "label": label, "inv": inv,
             "src": src, "dst": (dst or None), "so": rso, "desc": desc},
        )


def downgrade() -> None:
    bind = op.get_bind()
    for slug, *_ in _RELS:
        bind.execute(sa.text("DELETE FROM relation_types WHERE slug = :s"), {"s": slug})
    for slug, *_ in _AXES:
        bind.execute(sa.text("DELETE FROM entity_types WHERE slug = :s"), {"s": slug})
