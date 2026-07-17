"""phase 88 — 불량모드(failure_mode) record 축 시드 (FMEA 온톨로지 통합 P0)

FMEA 위젯의 '고장모드'를 자유 텍스트가 아니라 온톨로지 엔티티로 승격하기 위한 축.
kind_class='record' 라 기존 엔티티 인프라(속성·검색·태깅·파생링크)를 그대로 쓴다.
entry_policy='open' — 작성자가 FMEA 셀에 자유 입력하면 그 값으로 엔티티를 즉석
find-or-create(RecordNamePicker + upsert_record_entity). closed 면 그게 막히므로 open.

- 기존 incident(실패사례)와는 **별개 개념**: incident=발생한 사건, failure_mode=잠재
  고장형태 카탈로그(FMEA 재사용 어휘).
- 점수(S·O·D·RPN)는 이 엔티티 속성이 아니라 **위젯 JSON**에 둔다(같은 불량모드라도
  보고서·맥락마다 평가가 다름). 여기 속성은 재사용 가능한 분류(category)만.
- 관계 타입(occurs_in 부품 등)은 후속 — 축만 시드해도 report_entities 태깅으로
  get_object(failure_mode).documents 파생 링크는 즉시 작동한다.

전부 additive·멱등(이미 있으면 건너뜀). 속성은 관리자 UI 에서 언제든 추가 가능.
"""
import json
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "p88_failure_mode_axis"
down_revision: Union[str, None] = "p87_notices"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# (slug, label, temporal_kind, [속성...])  속성: (key, label, data_type, unit, enum_values, help)
RECORD_AXES = [
    ("failure_mode", "불량모드", "derived", [
        ("category", "분류", "text", None, None,
         "고장 유형 분류(구조·전기·열·기구·SW 등). 자유 입력."),
    ]),
]


def upgrade() -> None:
    bind = op.get_bind()

    axis_base = bind.execute(
        sa.text("SELECT COALESCE(MAX(sort_order), 0) FROM entity_types")
    ).scalar() or 0
    for i, (slug, label, temporal, props) in enumerate(RECORD_AXES, start=1):
        tid = bind.execute(
            sa.text("SELECT id FROM entity_types WHERE slug = :s"), {"s": slug}
        ).scalar()
        if tid is None:
            tid = bind.execute(
                sa.text(
                    """
                    INSERT INTO entity_types
                        (slug, label, icon, multi, sort_order, description,
                         entry_policy, temporal_kind, kind_class)
                    VALUES
                        (:slug, :label, '', true, :so, '',
                         CAST('open' AS entity_entry_policy_enum),
                         CAST(:tk AS entity_temporal_kind_enum),
                         CAST('record' AS entity_kind_class_enum))
                    RETURNING id
                    """
                ),
                {"slug": slug, "label": label, "so": axis_base + i, "tk": temporal},
            ).scalar()

        for j, (key, plabel, dt, unit, enum_vals, help_) in enumerate(props, start=1):
            opts = (
                json.dumps([{"value": v, "label": v} for v in enum_vals])
                if enum_vals
                else None
            )
            bind.execute(
                sa.text(
                    """
                    INSERT INTO property_defs
                        (owner_kind, owner_id, key, label, data_type, unit,
                         required, multi, enum_options, ref_type_slug, sort_order, help)
                    VALUES
                        ('entity_type', :oid, :key, :label, :dt, :unit,
                         false, false, CAST(:opts AS jsonb), NULL, :so, :help)
                    ON CONFLICT (owner_kind, owner_id, key) DO NOTHING
                    """
                ),
                {"oid": tid, "key": key, "label": plabel, "dt": dt, "unit": unit,
                 "opts": opts, "so": j, "help": help_},
            )


def downgrade() -> None:
    bind = op.get_bind()
    # 속성정의 → 축 순. 축에 이미 값(entities)이 있으면 FK(RESTRICT)로 막힘(의도된 안전).
    for slug, *_ in RECORD_AXES:
        tid = bind.execute(
            sa.text("SELECT id FROM entity_types WHERE slug = :s"), {"s": slug}
        ).scalar()
        if tid is None:
            continue
        bind.execute(
            sa.text(
                "DELETE FROM property_defs "
                "WHERE owner_kind = 'entity_type' AND owner_id = :oid"
            ),
            {"oid": tid},
        )
        bind.execute(sa.text("DELETE FROM entity_types WHERE id = :oid"), {"oid": tid})
