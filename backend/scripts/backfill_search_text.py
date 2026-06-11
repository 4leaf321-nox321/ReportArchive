"""보고서 본문 전문검색 — 기존 행 search_text 백필.

마이그레이션 p37(reports.search_text 컬럼 + pg_trgm GIN) 적용 후 1회 실행한다.
평문 추출은 Python(app.widgets.text_extraction)이 하므로 SQL 백필이 불가 —
모든(또는 아직 NULL 인) 보고서를 돌며 search_text 를 계산해 채운다.

재실행 안전(idempotent): 같은 본문이면 같은 평문을 다시 쓸 뿐이다. 기본은
search_text IS NULL 인 행만; --all 로 전체 재색인.

사용:
    python scripts/backfill_search_text.py            # NULL 인 것만
    python scripts/backfill_search_text.py --all      # 전체 재색인
    python scripts/backfill_search_text.py --batch 1000
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from sqlalchemy import select

from app.database import SessionLocal
from app.modules.reports.models import Report
from app.widgets.text_extraction import extract_searchable_text_for_report


def main() -> int:
    parser = argparse.ArgumentParser(description="보고서 search_text 백필")
    parser.add_argument(
        "--all",
        action="store_true",
        help="search_text 가 있어도 전부 재색인(기본: NULL 인 것만)",
    )
    parser.add_argument(
        "--batch",
        type=int,
        default=500,
        help="이 건수마다 commit (기본 500)",
    )
    args = parser.parse_args()

    db = SessionLocal()
    updated = 0
    scanned = 0
    try:
        stmt = select(Report).order_by(Report.id)
        if not args.all:
            stmt = stmt.where(Report.search_text.is_(None))
        # 대량이라도 메모리 폭주 방지 — yield_per 로 스트리밍.
        for report in db.execute(stmt).scalars().yield_per(args.batch):
            scanned += 1
            text = extract_searchable_text_for_report(report) or None
            if text != report.search_text:
                report.search_text = text
                updated += 1
            if updated and updated % args.batch == 0:
                db.commit()
                print(f"  ... {scanned} 스캔 / {updated} 갱신 (commit)")
        db.commit()
        print(f"완료: {scanned} 스캔, {updated} 갱신.")
        return 0
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        print(f"실패: {exc}", file=sys.stderr)
        return 1
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
