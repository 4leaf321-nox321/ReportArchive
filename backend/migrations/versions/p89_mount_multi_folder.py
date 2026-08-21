"""phase 89 — 한 게시판의 여러 폴더에 게시(다중 폴더 배치)

지금까지 게시 위치는 `report_mounts.folder_id` 단일 컬럼이라, 여러 부서에는
게시할 수 있어도 **한 부서 게시판 안에서는 폴더 하나**만 고를 수 있었다.
같은 보고서를 '2026년 정기보고'와 'NVH 해석' 두 폴더에 동시에 걸어두는
실제 요구를 못 받아준다.

배치를 자식 테이블 `report_mount_folders` 로 분리한다:

  - PK (report_id, workspace_slug, folder_id) — 한 게시판에서 폴더당 1행.
  - (report_id, workspace_slug) 복합 FK → report_mounts CASCADE.
    게시취소하면 배치도 함께 사라진다(별도 정리 코드 불필요).
  - folder_id FK → folders CASCADE. 폴더를 지우면 그 배치만 사라지고,
    남은 배치가 없으면 미분류로 떨어진다(옛 ondelete=SET NULL 과 동일 결과).
  - **행이 0개 = 미분류**. 옛 folder_id IS NULL 의 자리.

기존 folder_id 값을 그대로 복사한 뒤 컬럼을 떨군다. 이관은 무손실이며,
downgrade 는 게시판당 폴더 하나(가장 작은 folder_id)만 남기는 손실 복원이다.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "p89_mount_multi_folder"
down_revision: Union[str, None] = "p88_failure_mode_axis"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "report_mount_folders",
        sa.Column("report_id", sa.Integer(), nullable=False),
        sa.Column("workspace_slug", sa.String(length=64), nullable=False),
        sa.Column("folder_id", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(
            ["report_id", "workspace_slug"],
            ["report_mounts.report_id", "report_mounts.workspace_slug"],
            name="fk_report_mount_folders_mount",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["folder_id"], ["folders.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("report_id", "workspace_slug", "folder_id"),
    )
    op.create_index(
        "ix_report_mount_folders_folder",
        "report_mount_folders",
        ["folder_id"],
    )
    op.create_index(
        "ix_report_mount_folders_board",
        "report_mount_folders",
        ["workspace_slug", "folder_id"],
    )

    # 기존 단일 배치 이관 — 미분류(NULL)는 행을 만들지 않는다.
    op.execute(
        """
        INSERT INTO report_mount_folders (report_id, workspace_slug, folder_id)
        SELECT report_id, workspace_slug, folder_id
          FROM report_mounts
         WHERE folder_id IS NOT NULL
        ON CONFLICT DO NOTHING
        """
    )

    op.drop_constraint(
        "fk_report_mounts_folder", "report_mounts", type_="foreignkey"
    )
    op.drop_index("ix_report_mounts_folder_id", table_name="report_mounts")
    op.drop_column("report_mounts", "folder_id")


def downgrade() -> None:
    op.add_column(
        "report_mounts", sa.Column("folder_id", sa.Integer(), nullable=True)
    )
    op.create_index(
        "ix_report_mounts_folder_id", "report_mounts", ["folder_id"]
    )
    op.create_foreign_key(
        "fk_report_mounts_folder",
        "report_mounts",
        "folders",
        ["folder_id"],
        ["id"],
        ondelete="SET NULL",
    )
    # 손실 복원 — 게시판당 폴더는 하나만 남길 수 있으므로 가장 작은 id 채택.
    op.execute(
        """
        UPDATE report_mounts m
           SET folder_id = sub.folder_id
          FROM (
                SELECT report_id, workspace_slug, MIN(folder_id) AS folder_id
                  FROM report_mount_folders
                 GROUP BY report_id, workspace_slug
               ) sub
         WHERE m.report_id = sub.report_id
           AND m.workspace_slug = sub.workspace_slug
        """
    )
    op.drop_index(
        "ix_report_mount_folders_board", table_name="report_mount_folders"
    )
    op.drop_index(
        "ix_report_mount_folders_folder", table_name="report_mount_folders"
    )
    op.drop_table("report_mount_folders")
