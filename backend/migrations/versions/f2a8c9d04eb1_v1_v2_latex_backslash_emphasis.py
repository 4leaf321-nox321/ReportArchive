"""Reinforce LaTeX double-backslash rule in v1/v2 prompts

Revision ID: f2a8c9d04eb1
Revises: e1c5a8b3f72d
Create Date: 2026-05-22 22:30:00.000000

The original v1/v2 seed bodies tucked the "백슬래시 두 번" instruction
into the per-widget equation example block, which LLMs often fail to
respect — they regress to the LaTeX-native single-backslash style they
saw most often during training, and the resulting JSON either fails to
parse outright (`\\s` is an illegal escape) or silently mangles
form-feed-prefixed commands like `\\frac`.

This migration prepends a high-visibility warning right after the
"응답은 반드시 `{` 로 시작해" sentence in both seed bodies so the rule
lands while the model is still loading the role context. The text is
inserted via REPLACE, so admin-edited bodies that no longer contain
that anchor sentence are left alone; idempotency comes from the same
mechanism + a guard that skips bodies which already carry the marker.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "f2a8c9d04eb1"
down_revision: Union[str, None] = "e1c5a8b3f72d"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Marker substring used to detect bodies that already carry the warning
# (so re-running this migration on an environment that's already been
# patched is a safe no-op).
_MARKER = "[중요] equation 위젯의 latex"

# Anchor we insert the warning *after*. Present verbatim in both v1 and
# v2 seed bodies — if an admin has edited it out, we skip that row.
_ANCHOR = "응답은 반드시 `{` 로 시작해 `}` 로 끝나야 합니다."

# The actual warning. r-string so the backslashes survive without
# Python's string-escape layer eating them. The doubled backslashes
# are the desired *literal* output text — that's what the AI needs to
# see and reproduce in its JSON response.
_WARNING = (
    r"[중요] equation 위젯의 latex 은 JSON 안에서 반드시 백슬래시를 "
    r"두 개로 쓰세요 (예: \"\\sigma = \\frac{F}{A}\"). 단일 백슬래시는 "
    r"JSON 파싱 자체가 실패합니다."
)


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text(
            """
            UPDATE prompts
            SET body = REPLACE(
                  body,
                  :anchor,
                  :anchor || E'\n' || :warning
                ),
                updated_at = CURRENT_TIMESTAMP
            WHERE name IN ('빈 보고서 작성 (v1)', '템플릿 채우기 (v2)')
              AND body LIKE '%' || :anchor || '%'
              AND body NOT LIKE '%' || :marker || '%'
            """
        ),
        {"anchor": _ANCHOR, "warning": _WARNING, "marker": _MARKER},
    )


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text(
            """
            UPDATE prompts
            SET body = REPLACE(
                  body,
                  :anchor || E'\n' || :warning,
                  :anchor
                ),
                updated_at = CURRENT_TIMESTAMP
            WHERE name IN ('빈 보고서 작성 (v1)', '템플릿 채우기 (v2)')
              AND body LIKE '%' || :marker || '%'
            """
        ),
        {"anchor": _ANCHOR, "warning": _WARNING, "marker": _MARKER},
    )
