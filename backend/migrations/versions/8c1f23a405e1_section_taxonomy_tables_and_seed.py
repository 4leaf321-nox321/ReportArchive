"""section taxonomy tables + seed initial 6 categories / 40 items

Revision ID: 8c1f23a405e1
Revises: 704a740e85db
Create Date: 2026-05-18 21:00:00.000000

"""
from datetime import datetime
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "8c1f23a405e1"
down_revision: Union[str, None] = "704a740e85db"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Seed data — mirrors the frontend's previous hardcoded taxonomy. Admins
# can edit / delete these freely; they're not flagged as builtin.
SEED_CATEGORIES = [
    # (slug, name, color, sort_order, items[(code, label, en)])
    (
        "background_definition",
        "배경 및 정의",
        "#3b82f6",
        10,
        [
            ("background", "배경", "Background"),
            ("purpose", "보고 목적", "Purpose"),
            ("scope", "범위", "Scope"),
            ("current_state", "현황", "Current State"),
            ("summary", "현황 요약", "Summary"),
            ("problem", "문제점", "Problem Statement"),
            ("stakeholders", "이해관계자", "Stakeholders"),
            ("requirement", "요구 사항", "Requirement"),
            ("request", "요청 사항", "Request"),
            ("assumption", "전제 조건", "Assumption"),
            ("constraint", "제약 조건", "Constraint"),
            ("dependency", "의존 관계", "Dependency"),
        ],
    ),
    (
        "analysis_review",
        "분석 및 검토",
        "#10b981",
        20,
        [
            ("analysis", "분석 내용", "Analysis"),
            ("review_item", "검토 사항", "Review Item"),
            ("evaluation_criteria", "판단 기준", "Evaluation Criteria"),
            ("rationale", "판단 근거", "Rationale"),
            ("metric", "지표", "Metric"),
            ("cause", "원인", "Cause"),
            ("finding", "발견 사항", "Finding"),
            ("impact", "영향 분석", "Impact"),
            ("cost_benefit", "비용/효과", "Cost & Benefit"),
            ("risk", "리스크", "Risk"),
            ("alternatives", "대안", "Alternatives"),
        ],
    ),
    (
        "decision_improvement",
        "의사결정 및 개선",
        "#f59e0b",
        30,
        [
            ("decision", "의사 결정", "Decision"),
            ("approval", "승인사항", "Approval"),
            ("recommendation", "제안 사항", "Recommendation"),
            ("solution", "개선책", "Solution"),
            ("lesson_learned", "교훈", "Lesson Learned"),
            ("change", "변경 사항", "Change"),
        ],
    ),
    (
        "execution_management",
        "실행 및 관리",
        "#ef4444",
        40,
        [
            ("action_item", "실행 과제", "Action Item"),
            ("schedule", "일정", "Schedule"),
            ("milestone", "마일스톤", "Milestone"),
            ("resource_plan", "자원 계획", "Resource Plan"),
            ("future_plan", "향후 계획", "Future Plan"),
        ],
    ),
    (
        "issue_followup",
        "이슈 및 후속 관리",
        "#8b5cf6",
        50,
        [
            ("issue", "이슈", "Issue"),
            ("open_questions", "미해결 사항", "Open Questions"),
        ],
    ),
    (
        "reference_extra",
        "참고 및 부가 정보",
        "#64748b",
        60,
        [
            ("reference", "참고자료", "Reference"),
            ("appendix", "부록", "Appendix"),
            ("outcome", "결과", "Outcome"),
            ("others", "기타", "Others"),
        ],
    ),
]


def upgrade() -> None:
    op.create_table(
        "section_categories",
        sa.Column("slug", sa.String(length=48), nullable=False),
        sa.Column("name", sa.String(length=64), nullable=False),
        sa.Column("color", sa.String(length=9), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("slug"),
    )

    op.create_table(
        "section_items",
        sa.Column("code", sa.String(length=48), nullable=False),
        sa.Column("category_slug", sa.String(length=48), nullable=False),
        sa.Column("label", sa.String(length=64), nullable=False),
        sa.Column("en", sa.String(length=64), nullable=True),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["category_slug"],
            ["section_categories.slug"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("code"),
    )
    op.create_index(
        "ix_section_items_category_slug",
        "section_items",
        ["category_slug"],
    )

    now = datetime.utcnow()
    bind = op.get_bind()
    for cat_slug, cat_name, color, cat_sort, items in SEED_CATEGORIES:
        bind.execute(
            sa.text(
                """
                INSERT INTO section_categories
                    (slug, name, color, sort_order, created_at, updated_at)
                VALUES
                    (:slug, :name, :color, :sort_order, :now, :now)
                """
            ),
            {
                "slug": cat_slug,
                "name": cat_name,
                "color": color,
                "sort_order": cat_sort,
                "now": now,
            },
        )
        for idx, (code, label, en) in enumerate(items):
            bind.execute(
                sa.text(
                    """
                    INSERT INTO section_items
                        (code, category_slug, label, en, sort_order,
                         created_at, updated_at)
                    VALUES
                        (:code, :category_slug, :label, :en, :sort_order,
                         :now, :now)
                    """
                ),
                {
                    "code": code,
                    "category_slug": cat_slug,
                    "label": label,
                    "en": en,
                    "sort_order": (idx + 1) * 10,
                    "now": now,
                },
            )


def downgrade() -> None:
    op.drop_index("ix_section_items_category_slug", table_name="section_items")
    op.drop_table("section_items")
    op.drop_table("section_categories")
