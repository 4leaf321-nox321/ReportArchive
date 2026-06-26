"""phase 55 — 관계 타입 레지스트리(relation_types)

엔티티 간 엣지의 *종류* 를 데이터로 정의한다. 지금까지 `part_of` 한 종류를
코드 상수(ALLOWED_RELATIONS)로 박아 썼는데, 이를 `entity_types`(축 레지스트리)와
대칭인 `relation_types`(엣지 레지스트리)로 승격한다. 각 타입은 방향성·이행성
(재귀 펼침/롤업 대상인지)·비순환 여부·허용 출발/도착 축을 메타로 가진다
(엔티티그래프_온톨로지_설계.md §3.1, D-1).

이 메타가 (a) add_relation 검증(허용 타입·축 제약·순환 가드)과 (b) 트래버설
(이행 타입만 재귀 펼침), (c) 향후 AI 스키마 인지/Cypher 생성의 토대가 된다.

무FK 결정(설계 §11.2): `entity_relations.relation` 은 이 테이블 slug 를 가리키되
FK 를 걸지 않고 서비스 레이어가 정합성 관리(owner_workspace_slugs 패턴). 타입
추가/삭제가 마이그레이션이 아니라 설정 변경이 되어 유연.

완전 additive. part_of 행 시드로 기존 동작 100% 보존, 나머지 6종은 타입만 시드
(엔티티 관계 데이터는 admin/태깅으로 점진 축적).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "p55_relation_types"
down_revision: Union[str, None] = "p54_entity_relations"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "relation_types",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("slug", sa.String(length=32), nullable=False),
        sa.Column("label", sa.String(length=64), nullable=False),
        # 역방향 표기(part_of ↔ "포함"). UI 가 양방향 라벨을 보여줄 때.
        sa.Column(
            "inverse_label", sa.String(length=64), nullable=False, server_default=""
        ),
        # 방향성 있나(false=무방향 동치).
        sa.Column(
            "directed", sa.Boolean(), nullable=False, server_default=sa.true()
        ),
        # 이행적인가 = 재귀 펼침(롤업/트래버설 재귀) 대상인가. part_of=true.
        sa.Column(
            "transitive", sa.Boolean(), nullable=False, server_default=sa.false()
        ),
        # 사이클 금지(part_of=true) — add 시 순환 가드 적용 여부.
        sa.Column(
            "acyclic", sa.Boolean(), nullable=False, server_default=sa.false()
        ),
        # 허용 출발/도착 축 slug 목록. NULL=제약 없음.
        sa.Column("src_axis_slugs", postgresql.ARRAY(sa.String(length=32)), nullable=True),
        sa.Column("dst_axis_slugs", postgresql.ARRAY(sa.String(length=32)), nullable=True),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint("slug", name="uq_relation_types_slug"),
    )

    rt = sa.table(
        "relation_types",
        sa.column("slug", sa.String),
        sa.column("label", sa.String),
        sa.column("inverse_label", sa.String),
        sa.column("directed", sa.Boolean),
        sa.column("transitive", sa.Boolean),
        sa.column("acyclic", sa.Boolean),
        sa.column("src_axis_slugs", postgresql.ARRAY(sa.String)),
        sa.column("dst_axis_slugs", postgresql.ARRAY(sa.String)),
        sa.column("sort_order", sa.Integer),
        sa.column("description", sa.Text),
    )
    # 설계 §11.1 확정 starter 세트. directed 는 전부 true(모두 방향 관계).
    op.bulk_insert(
        rt,
        [
            {
                "slug": "part_of", "label": "포함됨", "inverse_label": "포함",
                "directed": True, "transitive": True, "acyclic": True,
                "src_axis_slugs": ["part", "bom"], "dst_axis_slugs": ["model", "part"],
                "sort_order": 0, "description": "자식이 부모에 포함(부품 part_of 모델).",
            },
            {
                "slug": "tested_by", "label": "시험됨", "inverse_label": "시험 대상",
                "directed": True, "transitive": False, "acyclic": False,
                "src_axis_slugs": ["part", "model"], "dst_axis_slugs": ["rel_test"],
                "sort_order": 1, "description": "부품·모델이 특정 신뢰성 시험으로 시험됨.",
            },
            {
                "slug": "simulated_by", "label": "해석됨", "inverse_label": "해석 대상",
                "directed": True, "transitive": False, "acyclic": False,
                "src_axis_slugs": ["part", "model"], "dst_axis_slugs": ["sim_type"],
                "sort_order": 2, "description": "부품·모델이 특정 시뮬레이션 종류로 해석됨.",
            },
            {
                "slug": "has_defect", "label": "불량 보유", "inverse_label": "발생 위치",
                "directed": True, "transitive": False, "acyclic": False,
                "src_axis_slugs": ["part", "model"], "dst_axis_slugs": ["defect"],
                "sort_order": 3, "description": "부품·모델에서 특정 불량이 발생.",
            },
            {
                "slug": "occurs_at", "label": "발생 단계", "inverse_label": "단계 불량",
                "directed": True, "transitive": False, "acyclic": False,
                "src_axis_slugs": ["defect"], "dst_axis_slugs": ["phase"],
                "sort_order": 4, "description": "불량이 특정 개발 단계에서 발생.",
            },
            {
                "slug": "supersedes", "label": "대체함", "inverse_label": "이전 버전",
                "directed": True, "transitive": True, "acyclic": True,
                "src_axis_slugs": ["model"], "dst_axis_slugs": ["model"],
                "sort_order": 5, "description": "후속 모델이 이전 모델을 대체(버전 체인).",
            },
            {
                "slug": "variant_of", "label": "파생", "inverse_label": "원형",
                "directed": True, "transitive": False, "acyclic": True,
                "src_axis_slugs": ["model"], "dst_axis_slugs": ["model"],
                "sort_order": 6, "description": "파생/변형 모델이 원형 모델에서 갈라짐.",
            },
        ],
    )


def downgrade() -> None:
    op.drop_table("relation_types")
