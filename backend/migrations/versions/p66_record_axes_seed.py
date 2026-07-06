"""phase 66 — 온톨로지 강화 A0.3 스텝1 (record 축 시드, 순수 추가)

팔란티어 벤치마킹 A0.3: "속성 갖는 객체(record)" 축을 온톨로지에 들인다. record 축도
`entities` 테이블에 살기에(kind_class=record) **새 링크 테이블 없이** 기존
entity_relations/속성 스키마로 즉시 동작한다(설계 [미구현] 온톨로지_A0.3_설계.md §3).

시드 내용(전부 additive, 이미 있으면 건너뜀 — 재실행/수동생성 안전):
  1. record 축 4종 — 과제(project)·공급사(supplier)·시험실행(test_run)·실패사례(incident).
     kind_class='record'. entry_policy 는 채우기 쉽게 'open'(기본) — 잠그려면 관리자
     거버넌스 UI 에서 축별로 closed 로 전환.
  2. 각 축의 property_defs(속성 스키마) — data_type 은 A0.1 검증 재사용.
  3. relation_types 카탈로그 확장 — supplied_by·tested·caused_by. 전부 entities 내부
     링크라 entity_relations 로 바로 동작. (system 끝=PL/부서/보고서 링크는 스텝2/3.)

속성/축 세부는 관리자 UI(속성 정의 다이얼로그)에서 언제든 추가/수정 가능(additive).
"""
import json
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "p66_record_axes_seed"
down_revision: Union[str, None] = "p65_link_properties_evidence"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# (slug, label, temporal_kind, [속성...])  속성: (key, label, data_type, unit, enum_values, help)
RECORD_AXES = [
    ("project", "과제", "yearly", [
        ("status", "상태", "enum", None, ["기획", "진행", "완료", "보류"], None),
        ("period_from", "시작일", "date", None, None, None),
        ("period_to", "종료일", "date", None, None, None),
        ("division", "사업부", "text", None, None, None),
        ("budget", "예산", "number", "백만원", None, None),
        ("pl_name", "PL", "text", None, None, "담당 PL 이름. 사용자 객체 연결은 A0.3 스텝2."),
    ]),
    ("supplier", "공급사", "evergreen", [
        ("country", "국가", "text", None, None, None),
        ("contact", "담당자", "text", None, None, None),
        ("phone", "연락처", "text", None, None, None),
    ]),
    ("test_run", "시험실행", "derived", [
        ("run_date", "시험일자", "date", None, None, None),
        ("result", "결과", "enum", None, ["합격", "불합격"], None),
        ("value", "측정값", "number", None, None, None),
        ("condition", "조건", "longtext", None, None, None),
    ]),
    ("incident", "실패사례", "derived", [
        ("occurred_on", "발생일", "date", None, None, None),
        ("impact", "영향도", "enum", None, ["경미", "중대", "치명"], None),
        ("action_status", "조치상태", "enum", None, ["미착수", "조치중", "완료"], None),
    ]),
]

# (slug, label, inverse_label, src_axis_slugs, dst_axis_slugs, description)
REL_TYPES = [
    ("supplied_by", "공급받음", "공급함", ["part"], ["supplier"],
     "부품이 공급사로부터 공급됨(부품 supplied_by 공급사)."),
    ("tested", "시험함", "시험됨", ["test_run"], ["part", "model"],
     "시험실행이 부품/모델을 시험함(시험실행 tested 부품)."),
    ("caused_by", "기인", "유발", ["incident"], ["part", "defect"],
     "실패사례가 부품/불량에 기인함(실패사례 caused_by 부품)."),
]


def upgrade() -> None:
    bind = op.get_bind()

    # 1·2. record 축 + 속성 정의
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

    # 3. relation_types 카탈로그 확장
    rel_base = bind.execute(
        sa.text("SELECT COALESCE(MAX(sort_order), 0) FROM relation_types")
    ).scalar() or 0
    for k, (slug, label, inv, src, dst, desc) in enumerate(REL_TYPES, start=1):
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
            {"slug": slug, "label": label, "inv": inv, "src": src, "dst": dst,
             "so": rel_base + k, "desc": desc},
        )


def downgrade() -> None:
    bind = op.get_bind()
    # 관계종류 → 속성정의 → 축 순으로 되돌린다. 축에 이미 값(entities)이 있으면
    # FK(RESTRICT)로 축 삭제가 막힌다 — 데이터가 생긴 뒤 downgrade 는 그 값을 먼저
    # 정리해야 한다(의도된 안전장치).
    for slug, *_ in REL_TYPES:
        bind.execute(
            sa.text("DELETE FROM relation_types WHERE slug = :s"), {"s": slug}
        )
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
        bind.execute(
            sa.text("DELETE FROM entity_types WHERE id = :oid"), {"oid": tid}
        )
