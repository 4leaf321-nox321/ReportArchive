"""phase 31 — 발행 종합보고 안건의 스냅샷 보존(원본 영구삭제 시 분리)

보고서 삭제 재설계 3단계 보강. 발행된 종합보고 안건은 snapshot_content(동결
내용)을 갖는데, ref_report_id 가 CASCADE 라 원본 영구삭제 시 안건 행까지 통째로
사라졌다(발행 기록 손실). 발행 스냅샷이 독립 보존되도록:
  - ref_report_id FK: CASCADE → SET NULL (원본 삭제 시 분리만).
  - exactly-one-ref 제약 완화: 두 ref 가 모두 NULL 이라도 snapshot_content 가
    있으면 허용(= 원본 삭제된 발행 안건, 스냅샷으로 렌더).
스냅샷 없는(미발행/라이브) 안건은 서비스(delete_report)가 원본 삭제 전에 함께
제거한다 — 그래야 both-null-no-snapshot 위반이 안 생긴다.
"""
from typing import Sequence, Union

from alembic import op


revision: str = "p31_composite_detach_on_purge"
down_revision: Union[str, None] = "p30_report_takedown_requests"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_FK = "composite_report_items_ref_report_id_fkey"
_CK = "ck_composite_item_exactly_one_ref"
_CK_RELAXED = (
    "((ref_report_id IS NOT NULL)::int + (ref_composite_id IS NOT NULL)::int = 1) "
    "OR (ref_report_id IS NULL AND ref_composite_id IS NULL "
    "AND snapshot_content IS NOT NULL)"
)
_CK_STRICT = "(ref_report_id IS NOT NULL)::int + (ref_composite_id IS NOT NULL)::int = 1"


def upgrade() -> None:
    op.drop_constraint(_FK, "composite_report_items", type_="foreignkey")
    op.create_foreign_key(
        _FK,
        "composite_report_items",
        "reports",
        ["ref_report_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.drop_constraint(_CK, "composite_report_items", type_="check")
    op.create_check_constraint(_CK, "composite_report_items", _CK_RELAXED)


def downgrade() -> None:
    # strict 제약 복원 전, detached(두 ref 다 NULL) 행을 제거해야 위반이 안 난다.
    op.execute(
        "DELETE FROM composite_report_items "
        "WHERE ref_report_id IS NULL AND ref_composite_id IS NULL"
    )
    op.drop_constraint(_CK, "composite_report_items", type_="check")
    op.create_check_constraint(_CK, "composite_report_items", _CK_STRICT)
    op.drop_constraint(_FK, "composite_report_items", type_="foreignkey")
    op.create_foreign_key(
        _FK,
        "composite_report_items",
        "reports",
        ["ref_report_id"],
        ["id"],
        ondelete="CASCADE",
    )
