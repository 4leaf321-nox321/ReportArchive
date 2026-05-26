"""phase 0 collab foundation

Single migration that lays the schema for the entire 협업개선_설계.md
roadmap:

  * Workspace.kind (personal/org/virtual) + personal_owner_user_id
  * ReportStatus → ReportPhase (drafting/reviewing/finalized)
  * Report extra columns: folder_id, lifecycle, closed_at,
    author_lock_*, forked_from_*
  * CompositeReport.series_id + CompositeReportItem.snapshot_*
  * New tables: folders, notifications, comment_threads, comments,
    report_editors, report_mounts

Data migration:
  * Every existing user gets a `personal-{user_id}` workspace (kind=personal)
  * Every existing report moves to its owner's personal workspace
  * For each moved report, a ReportMount row is created pointing back to
    the original org workspace — preserving visibility on org boards

Pre-production assumption: ReportStatus values are dropped without
mapping (everyone lands in drafting). If the app ever goes live before
this ships, a value mapping needs to land alongside.

Revision ID: 3a37db1362ff
Revises: d7c4f29a8b35
Create Date: 2026-05-24 21:17:58.987186

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "3a37db1362ff"
down_revision: Union[str, None] = "d7c4f29a8b35"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ────────────────────────────────────────────────────────────────
    # 1. New tables (independent of existing schema, safe to create first)
    # ────────────────────────────────────────────────────────────────
    op.create_table(
        "folders",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("parent_id", sa.Integer(), nullable=True),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["parent_id"], ["folders.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_folders_user_id"), "folders", ["user_id"], unique=False)
    op.create_index(
        "ix_folders_user_parent", "folders", ["user_id", "parent_id"], unique=False
    )

    op.create_table(
        "notifications",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("recipient_user_id", sa.Integer(), nullable=False),
        sa.Column("actor_user_id", sa.Integer(), nullable=True),
        sa.Column(
            "type",
            sa.Enum(
                "comment_new",
                "comment_reply",
                "comment_mention",
                "comment_resolved",
                "mount_new_to_me",
                "mount_new_in_board",
                "composite_included",
                "composite_cited_upward",
                "composite_published",
                "report_locked",
                "report_lock_force_unset",
                "report_edited_by_other",
                "editor_added",
                "report_ongoing_reminder",
                "report_phase_to_reviewing",
                "report_phase_to_finalized",
                name="notification_type_enum",
            ),
            nullable=False,
        ),
        sa.Column("ref_table", sa.String(length=64), nullable=True),
        sa.Column("ref_id", sa.Integer(), nullable=True),
        sa.Column("workspace_slug", sa.String(length=64), nullable=True),
        sa.Column(
            "payload",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("read_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["actor_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["recipient_user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["workspace_slug"], ["workspaces.slug"], ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_notifications_recipient_created",
        "notifications",
        ["recipient_user_id", "created_at"],
        unique=False,
    )
    op.create_index(
        "ix_notifications_recipient_unread",
        "notifications",
        ["recipient_user_id", "created_at"],
        unique=False,
        postgresql_where=sa.text("read_at IS NULL"),
    )
    op.create_index(
        "ix_notifications_type", "notifications", ["type"], unique=False
    )

    op.create_table(
        "comment_threads",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("report_id", sa.Integer(), nullable=False),
        sa.Column("page_index", sa.Integer(), nullable=False),
        sa.Column("block_id", sa.String(length=64), nullable=False),
        sa.Column("origin_workspace_slug", sa.String(length=64), nullable=True),
        sa.Column("author_user_id", sa.Integer(), nullable=False),
        sa.Column(
            "author_role_at_creation",
            sa.Enum(
                "admin",
                "lead",
                "member",
                name="comment_author_role_snapshot_enum",
            ),
            nullable=False,
        ),
        sa.Column(
            "status",
            sa.Enum("open", "resolved", name="comment_thread_status_enum"),
            server_default="open",
            nullable=False,
        ),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("resolved_at", sa.DateTime(), nullable=True),
        sa.Column("resolved_by_user_id", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(
            ["author_user_id"], ["users.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["origin_workspace_slug"], ["workspaces.slug"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(["report_id"], ["reports.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["resolved_by_user_id"], ["users.id"], ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_comment_threads_author",
        "comment_threads",
        ["author_user_id"],
        unique=False,
    )
    op.create_index(
        "ix_comment_threads_block",
        "comment_threads",
        ["report_id", "page_index", "block_id"],
        unique=False,
    )
    op.create_index(
        "ix_comment_threads_report",
        "comment_threads",
        ["report_id", "status"],
        unique=False,
    )

    op.create_table(
        "comments",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("thread_id", sa.Integer(), nullable=False),
        sa.Column("author_user_id", sa.Integer(), nullable=False),
        sa.Column("body", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["author_user_id"], ["users.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["thread_id"], ["comment_threads.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_comments_author", "comments", ["author_user_id"], unique=False
    )
    op.create_index(
        "ix_comments_thread", "comments", ["thread_id", "created_at"], unique=False
    )

    op.create_table(
        "report_editors",
        sa.Column("report_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("added_by_user_id", sa.Integer(), nullable=True),
        sa.Column("added_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["added_by_user_id"], ["users.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(["report_id"], ["reports.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("report_id", "user_id"),
    )
    op.create_index(
        "ix_report_editors_user", "report_editors", ["user_id"], unique=False
    )

    op.create_table(
        "report_mounts",
        sa.Column("report_id", sa.Integer(), nullable=False),
        sa.Column("workspace_slug", sa.String(length=64), nullable=False),
        sa.Column(
            "edit_policy",
            sa.Enum(
                "default", "owner_only", "coauthor", name="mount_edit_policy_enum"
            ),
            server_default="default",
            nullable=False,
        ),
        sa.Column("mounted_by_user_id", sa.Integer(), nullable=True),
        sa.Column("mounted_at", sa.DateTime(), nullable=False),
        sa.Column("note", sa.Text(), nullable=False, server_default=""),
        sa.ForeignKeyConstraint(
            ["mounted_by_user_id"], ["users.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(["report_id"], ["reports.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["workspace_slug"], ["workspaces.slug"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("report_id", "workspace_slug"),
    )
    op.create_index(
        "ix_report_mounts_mounted_by",
        "report_mounts",
        ["mounted_by_user_id"],
        unique=False,
    )
    op.create_index(
        "ix_report_mounts_workspace",
        "report_mounts",
        ["workspace_slug"],
        unique=False,
    )

    # ────────────────────────────────────────────────────────────────
    # 2. Workspace columns (kind + personal_owner_user_id)
    # ────────────────────────────────────────────────────────────────
    # Enums used in standalone add_column calls must be CREATEd
    # explicitly first — Postgres does not auto-register the type
    # outside the context of a CREATE TABLE (autogenerate misses this).
    workspace_kind_enum = postgresql.ENUM(
        "org", "personal", "virtual", name="workspace_kind_enum"
    )
    workspace_kind_enum.create(op.get_bind(), checkfirst=True)
    op.add_column(
        "workspaces",
        sa.Column(
            "kind",
            workspace_kind_enum,
            server_default="org",
            nullable=False,
        ),
    )
    # Backfill `kind=virtual` for the legacy aggregate rows that set the
    # boolean `virtual` column to true. New rows should branch on `kind`.
    op.execute("UPDATE workspaces SET kind = 'virtual' WHERE virtual = true")

    op.add_column(
        "workspaces",
        sa.Column("personal_owner_user_id", sa.Integer(), nullable=True),
    )
    op.create_index(
        op.f("ix_workspaces_personal_owner_user_id"),
        "workspaces",
        ["personal_owner_user_id"],
        unique=True,
    )
    op.create_foreign_key(
        "fk_workspaces_personal_owner",
        "workspaces",
        "users",
        ["personal_owner_user_id"],
        ["id"],
        ondelete="CASCADE",
    )

    # ────────────────────────────────────────────────────────────────
    # 3. Report columns (phase, lifecycle, lock, fork, folder)
    # ────────────────────────────────────────────────────────────────
    report_phase_enum = postgresql.ENUM(
        "drafting", "reviewing", "finalized", name="report_phase_enum"
    )
    report_phase_enum.create(op.get_bind(), checkfirst=True)
    report_lifecycle_enum = postgresql.ENUM(
        "single_shot", "ongoing", name="report_lifecycle_enum"
    )
    report_lifecycle_enum.create(op.get_bind(), checkfirst=True)

    op.add_column(
        "reports",
        sa.Column(
            "phase",
            report_phase_enum,
            server_default="drafting",
            nullable=False,
        ),
    )
    op.add_column("reports", sa.Column("folder_id", sa.Integer(), nullable=True))
    op.add_column(
        "reports",
        sa.Column(
            "lifecycle",
            report_lifecycle_enum,
            server_default="single_shot",
            nullable=False,
        ),
    )
    op.add_column("reports", sa.Column("closed_at", sa.Date(), nullable=True))
    op.add_column(
        "reports",
        sa.Column(
            "author_lock_enabled",
            sa.Boolean(),
            server_default="false",
            nullable=False,
        ),
    )
    op.add_column(
        "reports",
        sa.Column(
            "author_lock_reason",
            sa.Text(),
            server_default="",
            nullable=False,
        ),
    )
    op.add_column(
        "reports", sa.Column("author_lock_set_at", sa.DateTime(), nullable=True)
    )
    op.add_column(
        "reports", sa.Column("forked_from_report_id", sa.Integer(), nullable=True)
    )
    op.add_column(
        "reports", sa.Column("forked_at_revision", sa.Integer(), nullable=True)
    )
    op.create_index("ix_reports_folder", "reports", ["folder_id"], unique=False)
    op.create_index("ix_reports_phase", "reports", ["phase"], unique=False)
    op.create_foreign_key(
        "fk_reports_forked_from",
        "reports",
        "reports",
        ["forked_from_report_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_foreign_key(
        "fk_reports_folder",
        "reports",
        "folders",
        ["folder_id"],
        ["id"],
        ondelete="SET NULL",
    )

    # ────────────────────────────────────────────────────────────────
    # 4. Composite columns (series_id, snapshot_*)
    # ────────────────────────────────────────────────────────────────
    op.add_column(
        "composite_reports", sa.Column("series_id", sa.Integer(), nullable=True)
    )
    op.create_index(
        op.f("ix_composite_reports_series_id"),
        "composite_reports",
        ["series_id"],
        unique=False,
    )
    op.add_column(
        "composite_report_items",
        sa.Column(
            "snapshot_content",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
    )
    op.add_column(
        "composite_report_items",
        sa.Column("snapshot_taken_at", sa.DateTime(), nullable=True),
    )

    # ────────────────────────────────────────────────────────────────
    # 5. Data migration — personal workspaces + report relocation
    # ────────────────────────────────────────────────────────────────
    # 5a. Create a `personal-{user_id}` workspace for every user. Name
    #     defaults to the user's name (or email-local-part fallback);
    #     admins can rename later from the workspace settings page.
    op.execute(
        """
        INSERT INTO workspaces (slug, name, description, kind,
                                personal_owner_user_id, virtual,
                                sort_order, color, created_at)
        SELECT
            'personal-' || u.id,
            COALESCE(NULLIF(u.name, ''), split_part(u.email, '@', 1)) || ' (개인)',
            '개인 작업공간',
            'personal',
            u.id,
            false,
            0,
            '#64748b',
            NOW()
        FROM users u
        WHERE NOT EXISTS (
            SELECT 1 FROM workspaces w WHERE w.personal_owner_user_id = u.id
        )
        """
    )

    # 5a-bis. Grant the owner admin membership on their own personal
    #         workspace — without this row the API's workspace-permission
    #         check rejects the owner trying to read/edit their own
    #         reports. admin role is the natural fit (full control in
    #         their own scope; the role table's 'admin' grants read +
    #         write + member management).
    op.execute(
        """
        INSERT INTO workspace_members (user_id, workspace_slug, role, created_at)
        SELECT u.id, 'personal-' || u.id, 'admin', NOW()
        FROM users u
        WHERE NOT EXISTS (
            SELECT 1 FROM workspace_members m
            WHERE m.user_id = u.id AND m.workspace_slug = 'personal-' || u.id
        )
        """
    )

    # 5b. Move every existing report to its owner's personal workspace.
    #     Reports without an owner_user_id are left where they are
    #     (workspace admin will adopt them post-migration via a future
    #     /api/admin/orphan-reports flow).
    #
    # 5c. For each moved report, create a ReportMount pointing back to
    #     the original org workspace so it stays visible on the same
    #     board(s) it was on before.
    op.execute(
        """
        WITH moved AS (
            SELECT r.id AS report_id,
                   r.workspace_slug AS original_workspace_slug,
                   r.owner_user_id,
                   'personal-' || r.owner_user_id AS personal_slug
            FROM reports r
            WHERE r.owner_user_id IS NOT NULL
        ),
        mount_rows AS (
            INSERT INTO report_mounts (report_id, workspace_slug,
                                       edit_policy, mounted_by_user_id,
                                       mounted_at, note)
            SELECT m.report_id, m.original_workspace_slug,
                   'default', m.owner_user_id, NOW(),
                   'Phase 0 마이그레이션: 원본 워크스페이스에서 자동 게시'
            FROM moved m
            ON CONFLICT (report_id, workspace_slug) DO NOTHING
            RETURNING report_id
        )
        UPDATE reports r
        SET workspace_slug = m.personal_slug
        FROM moved m
        WHERE r.id = m.report_id;
        """
    )

    # ────────────────────────────────────────────────────────────────
    # 6. Drop ReportStatus (after all data movement is done — column
    #    is unrelated to workspace_slug, but ordering keeps the
    #    migration easy to read top-to-bottom)
    # ────────────────────────────────────────────────────────────────
    op.drop_column("reports", "status")
    op.execute("DROP TYPE report_status_enum")


def downgrade() -> None:
    # Recreate the legacy ReportStatus column. Existing rows get 'draft'
    # via the server default; downstream code that filtered on
    # in_progress / completed has to be revived separately.
    report_status_enum = postgresql.ENUM(
        "draft", "in_progress", "completed", name="report_status_enum"
    )
    report_status_enum.create(op.get_bind())
    op.add_column(
        "reports",
        sa.Column(
            "status",
            report_status_enum,
            server_default="draft",
            nullable=False,
        ),
    )

    # Undo data migration: move reports back to their first mount's
    # workspace, then drop the personal-* workspaces. Best effort —
    # reports created post-Phase-0 in personal space that were never
    # mounted will be stranded; the downgrade is for emergencies and
    # not expected to be lossless after real usage.
    op.execute(
        """
        UPDATE reports r
        SET workspace_slug = m.workspace_slug
        FROM report_mounts m
        WHERE m.report_id = r.id
          AND r.workspace_slug LIKE 'personal-%'
        """
    )
    op.execute(
        "DELETE FROM workspaces WHERE kind = 'personal'"
    )

    # Drop everything else (reverse order of upgrade)
    op.drop_column("composite_report_items", "snapshot_taken_at")
    op.drop_column("composite_report_items", "snapshot_content")
    op.drop_index(
        op.f("ix_composite_reports_series_id"), table_name="composite_reports"
    )
    op.drop_column("composite_reports", "series_id")

    op.drop_constraint("fk_reports_folder", "reports", type_="foreignkey")
    op.drop_constraint("fk_reports_forked_from", "reports", type_="foreignkey")
    op.drop_index("ix_reports_phase", table_name="reports")
    op.drop_index("ix_reports_folder", table_name="reports")
    op.drop_column("reports", "forked_at_revision")
    op.drop_column("reports", "forked_from_report_id")
    op.drop_column("reports", "author_lock_set_at")
    op.drop_column("reports", "author_lock_reason")
    op.drop_column("reports", "author_lock_enabled")
    op.drop_column("reports", "closed_at")
    op.drop_column("reports", "lifecycle")
    op.drop_column("reports", "folder_id")
    op.drop_column("reports", "phase")
    op.execute("DROP TYPE report_phase_enum")
    op.execute("DROP TYPE report_lifecycle_enum")

    op.drop_constraint(
        "fk_workspaces_personal_owner", "workspaces", type_="foreignkey"
    )
    op.drop_index(
        op.f("ix_workspaces_personal_owner_user_id"), table_name="workspaces"
    )
    op.drop_column("workspaces", "personal_owner_user_id")
    op.drop_column("workspaces", "kind")
    op.execute("DROP TYPE workspace_kind_enum")

    op.drop_index("ix_report_mounts_workspace", table_name="report_mounts")
    op.drop_index("ix_report_mounts_mounted_by", table_name="report_mounts")
    op.drop_table("report_mounts")
    op.execute("DROP TYPE mount_edit_policy_enum")

    op.drop_index("ix_report_editors_user", table_name="report_editors")
    op.drop_table("report_editors")

    op.drop_index("ix_comments_thread", table_name="comments")
    op.drop_index("ix_comments_author", table_name="comments")
    op.drop_table("comments")

    op.drop_index("ix_comment_threads_report", table_name="comment_threads")
    op.drop_index("ix_comment_threads_block", table_name="comment_threads")
    op.drop_index("ix_comment_threads_author", table_name="comment_threads")
    op.drop_table("comment_threads")
    op.execute("DROP TYPE comment_thread_status_enum")
    op.execute("DROP TYPE comment_author_role_snapshot_enum")

    op.drop_index("ix_notifications_type", table_name="notifications")
    op.drop_index(
        "ix_notifications_recipient_unread",
        table_name="notifications",
        postgresql_where=sa.text("read_at IS NULL"),
    )
    op.drop_index("ix_notifications_recipient_created", table_name="notifications")
    op.drop_table("notifications")
    op.execute("DROP TYPE notification_type_enum")

    op.drop_index("ix_folders_user_parent", table_name="folders")
    op.drop_index(op.f("ix_folders_user_id"), table_name="folders")
    op.drop_table("folders")
