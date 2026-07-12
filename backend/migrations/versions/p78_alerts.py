"""phase 78 — alerts: 온톨로지 경보/트리거 (Phase D 1단계)

규칙(alert_rules) + 발화 상태(alert_rule_state). 1단계는 프로브 조건만 + 수동 실행
(워커·알림·이메일 없음). 기본 규칙 1개(미태깅 보고서)를 시드해 인박스가 첫날부터
동작한다. 설계: docs/[미구현] Phase D_경보_설계.md.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "p78_alerts"
down_revision: Union[str, None] = "p77_qa_feedback"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "alert_rules",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        # 조건 = 내장 프로브 키 + 파라미터(JSONB). 1단계는 프로브만
        # (object_search 조건은 Phase B 데이터 이후).
        sa.Column("probe_key", sa.String(64), nullable=False),
        sa.Column("params", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("severity", sa.String(16), nullable=False, server_default="info"),
        sa.Column("created_at", sa.DateTime(), nullable=False,
                  server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(), nullable=False,
                  server_default=sa.func.now()),
    )

    op.create_table(
        "alert_rule_state",
        sa.Column("rule_id", sa.Integer(),
                  sa.ForeignKey("alert_rules.id", ondelete="CASCADE"),
                  primary_key=True),
        sa.Column("target_type", sa.String(32), primary_key=True),
        sa.Column("target_id", sa.String(64), primary_key=True),
        sa.Column("state", sa.String(16), nullable=False),  # 'firing' | 'resolved'
        # 발화 시점 스냅샷(인박스 렌더용 — 제목·부서·생성일 등). 재조회 없이 표시.
        sa.Column("context", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("first_fired_at", sa.DateTime(), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(), nullable=False),
        sa.Column("last_notified_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_alert_rule_state_firing", "alert_rule_state",
                    ["rule_id", "state"])

    # 기본 규칙 시드.
    #  - 미태깅: 게시판에 게시된·생성 7일 경과·태그 0. mounted_only=게시된 것만
    #    (phase 무관 — 게시는 reviewing 이지 finalized 가 아님).
    #  - 미발행: finalized 아닌 채 마지막 수정 후 30일 방치. mounted 무관(개인 초안 포함).
    op.execute(
        """
        INSERT INTO alert_rules (name, enabled, probe_key, params, severity)
        VALUES
          ('미태깅 보고서', true, 'untagged_reports',
           '{"days": 7, "mounted_only": true}', 'info'),
          ('미발행 보고서', true, 'stale_unpublished',
           '{"days": 30, "mounted_only": false}', 'info')
        """
    )


def downgrade() -> None:
    op.drop_index("ix_alert_rule_state_firing", table_name="alert_rule_state")
    op.drop_table("alert_rule_state")
    op.drop_table("alert_rules")
