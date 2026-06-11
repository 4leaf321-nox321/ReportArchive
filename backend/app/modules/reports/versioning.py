"""보고서 본문 스냅샷(수정 이력) — 생성·dedup·보존(prune).

비용 설계(버전관리_설계.md §1):
  - 저장 한 번 = 복원점 하나(시간 병합 없음). 무엇이든(구조·내용) 최근 범위 내
    되돌리기 가능. 폭증은 아래 dedup + prune 으로 막는다.
  - (A) 버전 수 ↓ : 무변경 dedup(직전과 본문 sha256 같으면 새 버전 skip).
  - (B) 크기 ↓   : 본문을 gzip 한 JSON 으로 BYTEA 저장.
  - (C) 총량 상한: 보고서당 최근 RETAIN_N(20) 개만 보존(prune). 단 게시/되돌리기
        마커·핀·라벨 버전은 항상 보존.

되돌리기는 비파괴적(되돌리기 직전 현재 상태를 'save' 로 스냅샷 → 옛 본문을 새 저장
으로 적용 → 그 버전 source='restore'). 그 흐름은 서비스/라우트(Phase 4)에서 조립.
"""
from __future__ import annotations

import gzip
import hashlib
import json

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modules.reports.models import ReportVersion

# 보고서당 보존할 일반('save') 버전 최대 개수. 초과분은 오래된 것부터 삭제.
# 저장 한 번 = 복원점 하나(시간 병합 없음); 무변경은 dedup 으로 skip.
RETAIN_N = 20


def _build_body(report) -> dict:
    """되돌리기·미리보기에 필요한 '편집 본문' 일체."""
    return {
        "title": report.title,
        "pages": report.pages or [],
        "content": report.content or {},
        "layout_overrides": report.layout_overrides,
        "props_overrides": report.props_overrides,
    }


def _serialize(body: dict) -> tuple[bytes, str, int]:
    """(gzip_bytes, sha256_hex, 압축전_바이트수). sort_keys 로 키순서 무관 안정 해시."""
    raw = json.dumps(
        body, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode("utf-8")
    sha = hashlib.sha256(raw).hexdigest()
    gz = gzip.compress(raw, compresslevel=6)
    return gz, sha, len(raw)


def decode_body(version: ReportVersion) -> dict:
    """저장된 스냅샷을 다시 dict 로(미리보기·되돌리기용)."""
    return json.loads(gzip.decompress(version.body_gzip).decode("utf-8"))


def _latest(db: Session, report_id: int) -> ReportVersion | None:
    return (
        db.execute(
            select(ReportVersion)
            .where(ReportVersion.report_id == report_id)
            .order_by(ReportVersion.seq.desc())
            .limit(1)
        )
        .scalars()
        .first()
    )


def record_version(
    db: Session,
    report,
    *,
    source: str = "save",
    author_user_id: int | None = None,
) -> ReportVersion | None:
    """현재 report 본문을 스냅샷. 저장 한 번마다 새 버전을 만들되, 직전과 본문이
    같으면(무변경) dedup 으로 건너뛴다. 같은 트랜잭션 안에서 add/flush 만 한다
    (commit 은 호출부). 반환: 만든 버전(또는 dedup skip 이면 None)."""
    body = _build_body(report)
    gz, sha, nbytes = _serialize(body)
    latest = _latest(db, report.id)

    # 무변경 dedup — 직전과 같은 본문이면 새 버전 안 만듦.
    if latest is not None and latest.body_sha256 == sha:
        return None

    seq = (latest.seq + 1) if latest is not None else 1
    v = ReportVersion(
        report_id=report.id,
        seq=seq,
        revision=report.revision or 1,
        author_user_id=author_user_id,
        source=source,
        body_gzip=gz,
        body_sha256=sha,
        body_bytes=nbytes,
    )
    db.add(v)
    db.flush()
    prune_versions(db, report.id)
    return v


def prune_versions(db: Session, report_id: int, *, retain: int = RETAIN_N) -> int:
    """보고서당 일반('save') 버전을 최근 retain 개만 남기고 삭제. 게시/되돌리기
    마커(source!='save')·핀·라벨 버전은 항상 보존(개수에 안 셈). 삭제 개수 반환."""
    rows = (
        db.execute(
            select(ReportVersion)
            .where(ReportVersion.report_id == report_id)
            .order_by(ReportVersion.seq.desc())
        )
        .scalars()
        .all()
    )
    kept = 0
    deleted = 0
    for v in rows:
        if v.is_pinned or v.source != "save" or v.label:
            continue  # 항상 보존
        kept += 1
        if kept > retain:
            db.delete(v)
            deleted += 1
    if deleted:
        db.flush()
    return deleted
