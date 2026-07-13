"""phase 81 — 미발행 경보에서 개인(미게시) 보고서 제외

시드(p78)가 '미발행 보고서' 규칙을 mounted_only=false 로 넣어, 게시되지 않고 개인
공간에만 있는 보고서까지 발화 대상이 됐다. 미태깅 규칙(mounted_only=true)과 달라
개인 초안이 계속 잡히는 문제 → 게시된(mount 된) 보고서만 보도록 true 로 바꾼다.

시드 규칙(name='미발행 보고서', probe_key='stale_unpublished')만 대상으로 해서,
사용자가 일부러 개인 포함으로 만든 다른 규칙은 건드리지 않는다.
"""
from typing import Sequence, Union

from alembic import op


revision: str = "p81_alert_unpublished_mounted"
down_revision: Union[str, None] = "p80_alert_notification_type"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1) 규칙 파라미터를 게시된 것만 보도록.
    op.execute(
        """
        UPDATE alert_rules
           SET params = jsonb_set(params, '{mounted_only}', 'true'::jsonb)
         WHERE probe_key = 'stale_unpublished'
           AND name = '미발행 보고서'
        """
    )
    # 2) 이미 저장된 발화 상태 정리 — 발화 목록(list_firing)은 저장된 상태를 읽으므로,
    #    파라미터만 바꾸면 다음 실행 전까지 개인(미게시) 보고서 발화가 그대로 남는다.
    #    재실행이 하는 것과 동일하게(state='resolved'), 게시판이 없는 개인 보고서
    #    발화를 지금 해소해 즉시 목록에서 빠지게 한다.
    op.execute(
        """
        UPDATE alert_rule_state s
           SET state = 'resolved'
          FROM alert_rules r
         WHERE s.rule_id = r.id
           AND r.probe_key = 'stale_unpublished'
           AND r.name = '미발행 보고서'
           AND s.state = 'firing'
           AND s.target_type = 'report'
           AND s.target_id ~ '^[0-9]+$'
           AND NOT EXISTS (
             SELECT 1 FROM report_mounts m WHERE m.report_id = s.target_id::int
           )
        """
    )


def downgrade() -> None:
    op.execute(
        """
        UPDATE alert_rules
           SET params = jsonb_set(params, '{mounted_only}', 'false'::jsonb)
         WHERE probe_key = 'stale_unpublished'
           AND name = '미발행 보고서'
        """
    )
