"""고아(미참조) 업로드 파일 정리 핸들러.

find_orphans 는 모든 보고서·종합보고·버전 본문 JSON 을 훑어 참조 file_id 를
수집하므로 데이터가 쌓일수록 무거워진다 — 관리자가 동기로 기다리는 대신
워커가 백그라운드에서 처리하기 좋은 대표 작업.

payload:
    grace_hours: int = 48   # 최근 업로드 보호(시간)
    delete: bool = False    # False=스캔만(dry-run), True=실제 삭제
    limit: int | None       # 삭제 시 한 번에 처리할 최대 개수(용량 큰 순)

result(Job.result):
    {scanned, scanned_bytes, grace_hours, deleted, freed_bytes, skipped, dry_run}
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.jobs.registry import handler
from app.modules.files import orphans
from app.modules.files.orphans import DEFAULT_GRACE_HOURS


@handler("orphan_cleanup")
def orphan_cleanup(session: Session, payload: dict) -> dict:
    grace_hours = int(payload.get("grace_hours", DEFAULT_GRACE_HOURS))
    do_delete = bool(payload.get("delete", False))
    limit = payload.get("limit")

    scan = orphans.find_orphans(session, grace_hours=grace_hours)
    result = {
        "scanned": scan["total_count"],
        "scanned_bytes": scan["total_size"],
        "grace_hours": grace_hours,
        "deleted": 0,
        "freed_bytes": 0,
        "skipped": 0,
        "dry_run": not do_delete,
    }

    if do_delete and scan["items"]:
        file_ids = [it["id"] for it in scan["items"]]
        if isinstance(limit, int) and limit > 0:
            file_ids = file_ids[:limit]
        deleted = orphans.delete_orphans(
            session, file_ids=file_ids, grace_hours=grace_hours
        )
        result["deleted"] = deleted["deleted"]
        result["freed_bytes"] = deleted["freed_bytes"]
        result["skipped"] = len(deleted["skipped"])

    return result
