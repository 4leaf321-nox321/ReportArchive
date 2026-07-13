"""업로드 오펀(미참조) 파일 탐지·삭제 — 공용 코어.

CLI 스크립트(scripts/cleanup_orphan_files.py)와 관리자 API(modules/admin)가
함께 쓰는 단일 출처. 보고서에서 파일을 빼도 디스크/DB 에 남는 파일을, *어느
보고서·종합보고에서도 참조하지 않는* 것만 골라낸다.

안전 원칙:
  - 참조 수집은 **보수적** — 모든 보고서(휴지통 포함)·종합보고 위젯·안건 스냅샷
    JSON 을 통째로 훑어, `file_id` 로 끝나는 모든 키(file_id, fileId, cover_file_id…)
    값을 수집. 과수집 = 덜 지움 = 안전.
  - **유예 기간** — 갓 올려 아직 보고서에 안 붙은 파일 보호.
  - **삭제 시 재검증** — 목록을 받아 지울 때, 그 사이 참조됐거나 유예 안인 파일은
    건너뛴다(stale 목록·경쟁 방지).
  - **버전 인터록** — report_versions(버전관리) 가 생기면 버전 참조까지 스캔해야
    안전 → 미구현 상태에선 삭제를 막는다.
"""
from __future__ import annotations

import gzip
import json
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.modules.composites.models import CompositeReport, CompositeReportItem
from app.modules.files.models import File
from app.modules.reports.models import Report, ReportVersion

DEFAULT_GRACE_HOURS = 48


class OrphanVersionGuardError(RuntimeError):
    """(레거시) 버전 스캔 미구현 시 삭제를 막던 가드. 이제 referenced_file_ids 가
    report_versions 본문까지 스캔(version-aware)하므로 더는 발생하지 않는다 —
    호환을 위해 클래스만 남겨둔다."""


def _is_file_ref_key(k: str) -> bool:
    """`files` 행을 가리키는 키인가 — 'file_id' 로 끝나는 모든 키를 보수적으로."""
    kl = k.lower()
    return kl == "file_id" or kl == "fileid" or kl.endswith("_file_id")


def _collect_file_ids(node, out: set[str]) -> None:
    if isinstance(node, dict):
        for k, v in node.items():
            if _is_file_ref_key(k):
                if isinstance(v, str) and v:
                    out.add(v)
                elif isinstance(v, list):
                    out.update(x for x in v if isinstance(x, str) and x)
            else:
                _collect_file_ids(v, out)
    elif isinstance(node, list):
        for v in node:
            _collect_file_ids(v, out)


def referenced_file_ids(db: Session) -> set[str]:
    """어디에서든 참조되는 file_id 전체(보수적)."""
    refs: set[str] = set()
    for content, pages in db.execute(
        select(Report.content, Report.pages)
    ).yield_per(200):
        _collect_file_ids(content, refs)
        _collect_file_ids(pages, refs)
    for (widgets,) in db.execute(
        select(CompositeReport.summary_widgets)
    ).yield_per(200):
        _collect_file_ids(widgets, refs)
    for (snap,) in db.execute(
        select(CompositeReportItem.snapshot_content)
    ).yield_per(200):
        _collect_file_ids(snap, refs)
    # 수정 이력(버전) 본문 — 옛 버전이 참조하는 파일을 오펀으로 오인·삭제하지
    # 않도록 gzip 스냅샷을 풀어 file_id 를 수집(version-aware).
    for (gz,) in db.execute(select(ReportVersion.body_gzip)).yield_per(200):
        if not gz:
            continue
        try:
            body = json.loads(gzip.decompress(gz).decode("utf-8"))
        except Exception:
            continue
        _collect_file_ids(body, refs)
    return refs


def references_for(db: Session, file_ids: set[str]) -> dict[str, list[dict]]:
    """대상 file_id 각각을 *참조하는* 소스(보고서·종합보고·버전) 목록.
    부서 파일 관리 화면이 "이 파일을 어느 보고서가 쓰는가"를 보여주는 데 쓴다.
    전체 스캔이지만 부서 삭제·정리라는 저빈도 관리 작업에서만 호출한다.

    각 항목: {"type": "report"|"composite"|"version", "id", "title", "deleted"}.
    - report.deleted = 휴지통(soft-delete) 여부. deleted=False 는 살아있는 참조라
      그 파일을 지우면 그 보고서의 이미지/첨부가 깨진다(위험 신호).
    - version 은 항상 deleted=True 취급(과거 이력 — 살아있는 참조 아님)."""
    if not file_ids:
        return {}
    out: dict[str, list[dict]] = {fid: [] for fid in file_ids}

    for rid, title, deleted_at, content, pages in db.execute(
        select(
            Report.id, Report.title, Report.deleted_at, Report.content, Report.pages
        )
    ).yield_per(200):
        hits: set[str] = set()
        _collect_file_ids(content, hits)
        _collect_file_ids(pages, hits)
        for fid in hits & file_ids:
            out[fid].append(
                {
                    "type": "report",
                    "id": rid,
                    "title": title,
                    "deleted": deleted_at is not None,
                }
            )

    for cid, title, widgets in db.execute(
        select(
            CompositeReport.id,
            CompositeReport.title,
            CompositeReport.summary_widgets,
        )
    ).yield_per(200):
        hits = set()
        _collect_file_ids(widgets, hits)
        for fid in hits & file_ids:
            out[fid].append(
                {"type": "composite", "id": cid, "title": title, "deleted": False}
            )

    for (rvid, gz) in db.execute(
        select(ReportVersion.id, ReportVersion.body_gzip)
    ).yield_per(200):
        if not gz:
            continue
        try:
            body = json.loads(gzip.decompress(gz).decode("utf-8"))
        except Exception:
            continue
        hits = set()
        _collect_file_ids(body, hits)
        for fid in hits & file_ids:
            out[fid].append(
                {"type": "version", "id": rvid, "title": None, "deleted": True}
            )

    return out


def _now_utc_naive() -> datetime:
    # File.uploaded_at 은 naive UTC(default datetime.utcnow).
    return datetime.now(timezone.utc).replace(tzinfo=None)


def find_orphans(db: Session, *, grace_hours: int = DEFAULT_GRACE_HOURS) -> dict:
    """오펀 목록 + 요약. items 는 용량 큰 순."""
    referenced = referenced_file_ids(db)
    cutoff = _now_utc_naive() - timedelta(hours=grace_hours)

    items: list[dict] = []
    grace_protected = 0
    total_size = 0
    for f in db.execute(select(File).order_by(File.size.desc())).scalars():
        if f.id in referenced:
            continue
        if f.uploaded_at and f.uploaded_at >= cutoff:
            grace_protected += 1
            continue
        items.append(
            {
                "id": f.id,
                "filename": f.filename,
                "mime_type": f.mime_type,
                "size": f.size,
                "owner_user_id": f.owner_user_id,
                "workspace_slug": f.workspace_slug,
                "uploaded_at": f.uploaded_at.isoformat() if f.uploaded_at else None,
            }
        )
        total_size += f.size or 0

    return {
        "items": items,
        "total_count": len(items),
        "total_size": total_size,
        "referenced_count": len(referenced),
        "grace_protected": grace_protected,
        "grace_hours": grace_hours,
    }


def delete_orphans(
    db: Session,
    *,
    file_ids: list[str],
    grace_hours: int = DEFAULT_GRACE_HOURS,
    ignore_versions: bool = False,  # (레거시 호환 — 더는 안 씀)
) -> dict:
    """주어진 file_id 들을 삭제 — 단, 삭제 직전 **다시 검증**해 그 사이 참조됐거나
    유예 안인 파일은 건너뛴다. 참조 수집은 버전 본문까지 포함(version-aware)이라
    옛 버전이 쓰는 파일은 애초에 후보에 안 든다. 디스크 unlink + DB 행 삭제."""
    referenced = referenced_file_ids(db)
    cutoff = _now_utc_naive() - timedelta(hours=grace_hours)

    deleted = 0
    freed = 0
    skipped: list[dict] = []
    for fid in dict.fromkeys(file_ids):  # 중복 제거(순서 유지)
        f = db.get(File, fid)
        if f is None:
            skipped.append({"id": fid, "reason": "not_found"})
            continue
        if f.id in referenced:
            skipped.append({"id": fid, "reason": "now_referenced"})
            continue
        if f.uploaded_at and f.uploaded_at >= cutoff:
            skipped.append({"id": fid, "reason": "within_grace"})
            continue
        abs_path = settings.upload_dir_path / f.storage_path
        try:
            if abs_path.exists():
                abs_path.unlink()
        except OSError:
            pass  # best-effort — 디스크에 없어도 DB 행은 정리
        freed += f.size or 0
        db.delete(f)
        deleted += 1
    db.commit()

    return {"deleted": deleted, "freed_bytes": freed, "skipped": skipped}
