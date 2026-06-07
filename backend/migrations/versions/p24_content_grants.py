"""phase 24 — 통합 공유(content_grants) + 기존 데이터 백필

보고서·종합보고 공유/권한 개편(계획: 보고서·종합보고 공유/권한 체계 개편).
단일 권한 출처 content_grants 를 만들고, 기존 mount/external_view/ReportEditor/
종합보고를 grant 로 백필한다. **상위 자동 열람은 이관하지 않는다**(새 정책).

레거시(mount.edit_policy, folder.external_view, workspace.external_view_default,
composite.external_view, report_editors)는 이번엔 보존 — 신코드 검증 후 p25 에서 제거.

백필 매핑:
  1. report_mounts        → grant(report, workspace=slug, coauthor?edit:view)
  2. effective-public 보고서 → grant(report, all_org, view)
  3. report_editors       → grant(report, user=user_id, edit)
  4. composite_reports    → grant(composite, workspace=home_slug, view)
     + external_view 면   → grant(composite, all_org, view)
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "p24_content_grants"
down_revision: Union[str, None] = "p23_composite_external_view"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "content_grants",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "content_type",
            sa.Enum("report", "composite", name="grant_content_type_enum"),
            nullable=False,
        ),
        sa.Column("content_id", sa.Integer(), nullable=False),
        sa.Column(
            "principal_type",
            sa.Enum(
                "workspace", "all_org", "user", name="grant_principal_type_enum"
            ),
            nullable=False,
        ),
        sa.Column("principal_ref", sa.String(length=64), nullable=True),
        sa.Column(
            "level",
            sa.Enum("view", "edit", name="grant_level_enum"),
            nullable=False,
        ),
        sa.Column("created_by_user_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(
            ["created_by_user_id"], ["users.id"], ondelete="SET NULL"
        ),
        sa.UniqueConstraint(
            "content_type",
            "content_id",
            "principal_type",
            "principal_ref",
            name="uq_content_grant_target",
        ),
    )
    op.create_index(
        "ix_content_grants_content",
        "content_grants",
        ["content_type", "content_id"],
    )
    op.create_index(
        "ix_content_grants_principal",
        "content_grants",
        ["principal_type", "principal_ref"],
    )
    # all_org(principal_ref NULL)은 일반 unique 가 안 묶어줌 → 부분 unique index.
    op.create_index(
        "uq_content_grant_all_org",
        "content_grants",
        ["content_type", "content_id"],
        unique=True,
        postgresql_where=sa.text("principal_type = 'all_org'"),
    )

    # ── 백필 ───────────────────────────────────────────────────────────────
    # enum 컬럼은 명시 캐스트 필요(DISTINCT/CASE 가 끼면 암묵 캐스트가 안 됨).
    ct = "::grant_content_type_enum"
    pt = "::grant_principal_type_enum"
    lv = "::grant_level_enum"

    # 1. mount → workspace grant (coauthor=edit, 그 외 view; lead 폐기)
    op.execute(
        f"""
        INSERT INTO content_grants
            (content_type, content_id, principal_type, principal_ref, level,
             created_by_user_id, created_at)
        SELECT 'report'{ct}, m.report_id, 'workspace'{pt}, m.workspace_slug,
               (CASE WHEN m.edit_policy = 'coauthor' THEN 'edit' ELSE 'view' END){lv},
               m.mounted_by_user_id, now()
        FROM report_mounts m
        ON CONFLICT ON CONSTRAINT uq_content_grant_target DO NOTHING
        """
    )

    # 2. effective-public 보고서 → all_org view
    op.execute(
        f"""
        INSERT INTO content_grants
            (content_type, content_id, principal_type, principal_ref, level, created_at)
        SELECT DISTINCT 'report'{ct}, m.report_id, 'all_org'{pt}, NULL, 'view'{lv}, now()
        FROM report_mounts m
        JOIN workspaces w ON w.slug = m.workspace_slug
        LEFT JOIN folders f ON f.id = m.folder_id
        WHERE w.kind = 'org'
          AND COALESCE(f.external_view, w.external_view_default) IS TRUE
        ON CONFLICT (content_type, content_id)
            WHERE principal_type = 'all_org' DO NOTHING
        """
    )

    # 3. report_editors → user edit grant
    op.execute(
        f"""
        INSERT INTO content_grants
            (content_type, content_id, principal_type, principal_ref, level,
             created_by_user_id, created_at)
        SELECT 'report'{ct}, e.report_id, 'user'{pt}, e.user_id::text, 'edit'{lv},
               e.added_by_user_id, e.added_at
        FROM report_editors e
        ON CONFLICT ON CONSTRAINT uq_content_grant_target DO NOTHING
        """
    )

    # 4a. 종합보고 → home workspace view grant (상위 미생성)
    op.execute(
        f"""
        INSERT INTO content_grants
            (content_type, content_id, principal_type, principal_ref, level,
             created_by_user_id, created_at)
        SELECT 'composite'{ct}, c.id, 'workspace'{pt}, c.workspace_slug, 'view'{lv},
               c.owner_user_id, now()
        FROM composite_reports c
        ON CONFLICT ON CONSTRAINT uq_content_grant_target DO NOTHING
        """
    )
    # 4b. external_view 종합보고 → all_org view
    op.execute(
        f"""
        INSERT INTO content_grants
            (content_type, content_id, principal_type, principal_ref, level,
             created_by_user_id, created_at)
        SELECT 'composite'{ct}, c.id, 'all_org'{pt}, NULL, 'view'{lv}, c.owner_user_id, now()
        FROM composite_reports c
        WHERE c.external_view IS TRUE
        ON CONFLICT (content_type, content_id)
            WHERE principal_type = 'all_org' DO NOTHING
        """
    )


def downgrade() -> None:
    op.drop_index("uq_content_grant_all_org", table_name="content_grants")
    op.drop_index("ix_content_grants_principal", table_name="content_grants")
    op.drop_index("ix_content_grants_content", table_name="content_grants")
    op.drop_table("content_grants")
    op.execute("DROP TYPE grant_level_enum")
    op.execute("DROP TYPE grant_principal_type_enum")
    op.execute("DROP TYPE grant_content_type_enum")
