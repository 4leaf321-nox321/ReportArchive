"""업로드 오펀(미참조) 파일 정리 CLI — 기본 dry-run.

핵심 로직은 app.modules.files.orphans 에 있고(관리자 UI 와 공용), 이 스크립트는
그걸 커맨드라인에서 돌리는 얇은 래퍼다. 관리자 메뉴(/admin/orphan-files)로도
같은 일을 할 수 있다.

사용:
    python scripts/cleanup_orphan_files.py                 # dry-run
    python scripts/cleanup_orphan_files.py --grace-hours 24
    python scripts/cleanup_orphan_files.py --delete        # 실제 삭제
    python scripts/cleanup_orphan_files.py --limit 100     # 목록 표시 개수
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.database import SessionLocal
from app.modules.files import orphans
from app.modules.files.orphans import OrphanVersionGuardError


def _human(n: int) -> str:
    f = float(n or 0)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if f < 1024 or unit == "TB":
            return f"{int(f)} B" if unit == "B" else f"{f:.1f} {unit}"
        f /= 1024
    return f"{f:.1f} TB"


def main() -> int:
    parser = argparse.ArgumentParser(description="업로드 오펀 파일 정리(기본 dry-run)")
    parser.add_argument("--delete", action="store_true", help="실제로 삭제(기본은 dry-run)")
    parser.add_argument("--grace-hours", type=int, default=48, help="최근 N시간 내 업로드는 건너뜀(기본 48)")
    parser.add_argument("--limit", type=int, default=40, help="목록 표시 최대 개수")
    parser.add_argument("--ignore-versions", action="store_true", help="report_versions 가 있어도 강행(주의)")
    args = parser.parse_args()

    db = SessionLocal()
    try:
        result = orphans.find_orphans(db, grace_hours=args.grace_hours)
        items = result["items"]

        print()
        print(f"참조되는 file_id:     {result['referenced_count']}")
        print(f"유예({args.grace_hours}h) 보호:    {result['grace_protected']}")
        print(f"오펀(미참조) 파일:    {result['total_count']}  합계 {_human(result['total_size'])}")
        print()

        if items:
            shown = min(args.limit, len(items))
            print(f"--- 오펀 목록 (상위 {shown}개, 용량순) ---")
            for it in items[: args.limit]:
                ua = (it["uploaded_at"] or "?")[:10]
                print(f"  {_human(it['size']):>10}  {ua}  {it['id']}  {it['filename']}")
            if len(items) > args.limit:
                print(f"  … 외 {len(items) - args.limit}개 더")
            print()

        if not args.delete:
            print("dry-run 입니다. 실제로 지우려면 --delete 를 붙이세요.")
            return 0
        if not items:
            print("지울 오펀이 없습니다.")
            return 0

        out = orphans.delete_orphans(
            db,
            file_ids=[it["id"] for it in items],
            grace_hours=args.grace_hours,
            ignore_versions=args.ignore_versions,
        )
        skipped = len(out["skipped"])
        print(
            f"완료: {out['deleted']}개 삭제, 약 {_human(out['freed_bytes'])} 정리"
            f"{f' (건너뜀 {skipped}개)' if skipped else ''}."
        )
        return 0
    except OrphanVersionGuardError as exc:
        print(f"중단: {exc} (강행하려면 --ignore-versions)", file=sys.stderr)
        return 2
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        print(f"실패: {exc}", file=sys.stderr)
        return 1
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
