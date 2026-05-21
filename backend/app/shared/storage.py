"""Disk-space helpers for the upload partition.

Centralized so the admin storage endpoint and the upload guard share one
notion of "is there room?" — the SAFETY_MARGIN reserved here is what
keeps the system from clipping its own logs / DB by trying to land an
upload that would land on the last block.
"""
from __future__ import annotations

import shutil

from fastapi import HTTPException, status

from app.config import settings


# Bytes left free on the upload partition before we reject new uploads.
# 500 MB is generous-ish for typical deployments — small enough that
# operators get a real warning before the partition is wedged, big
# enough that PostgreSQL / journald / SIF rebuild won't suffocate.
SAFETY_MARGIN_BYTES: int = 500 * 1024 * 1024


def disk_usage() -> tuple[int, int, int]:
    """`(total, used, free)` for the partition that backs upload_dir_path.

    `shutil.disk_usage` follows symlinks and reports the underlying
    partition, which is what we actually need to answer "can the next
    upload land?" — even if upload_dir is bind-mounted from the host.
    """
    u = shutil.disk_usage(settings.upload_dir_path)
    return u.total, u.used, u.free


def assert_space_for(incoming_size: int) -> None:
    """Pre-upload guard: raises 507 when the upload + safety margin
    wouldn't fit. Called from the file upload route after we know the
    incoming size but before we touch the disk."""
    _total, _used, free = disk_usage()
    needed = incoming_size + SAFETY_MARGIN_BYTES
    if free < needed:
        free_mb = free // (1024 * 1024)
        needed_mb = needed // (1024 * 1024)
        raise HTTPException(
            status.HTTP_507_INSUFFICIENT_STORAGE,
            (
                f"서버 저장 공간이 부족합니다 (잔여 {free_mb} MB, "
                f"이 업로드에 최소 {needed_mb} MB 필요)."
            ),
        )
