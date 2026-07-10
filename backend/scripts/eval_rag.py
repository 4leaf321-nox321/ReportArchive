"""RAG 검색 평가 CLI — 골든셋으로 recall@k·precision@k·MRR 산출.

임계·설정을 바꾼 뒤 재실행해 점수를 비교(감 튜닝 종식). 임베딩/LLM 백엔드가 켜진
운영에서 유의미하다(dev mock 은 검색이 결정적이지 않음).

사용:
    python scripts/eval_rag.py --user 2 --k 5
    python scripts/eval_rag.py --user 2 --k 5 --graph --rerank   # 설정 조합 비교
    python scripts/eval_rag.py --set eval/golden_qa.json --json out.json

--user: 가시성 스코프 기준 사용자(그 사람이 볼 수 있는 보고서로 평가).
--set:  골든셋 경로(기본 eval/golden_qa.json). 없으면 example 안내.
--json: 결과를 JSON 으로 저장(전/후 비교용).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from types import SimpleNamespace

BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import app.all_models  # noqa: F401,E402  (모델 등록)
from app.ai import eval as rag_eval  # noqa: E402
from app.database import SessionLocal  # noqa: E402
from app.modules.users.models import User  # noqa: E402


def _actor(db, user_id: int):
    user = db.get(User, user_id)
    if user is None:
        raise SystemExit(f"user {user_id} 없음")
    return SimpleNamespace(
        user=SimpleNamespace(id=user.id),
        workspace=SimpleNamespace(virtual=False, slug="dx"),
        public_viewer=False,
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="RAG 검색 평가")
    ap.add_argument("--user", type=int, required=True, help="가시성 기준 사용자 id")
    ap.add_argument("--set", dest="path", default="eval/golden_qa.json")
    ap.add_argument("--k", type=int, default=5)
    ap.add_argument("--graph", action="store_true")
    ap.add_argument("--rerank", action="store_true")
    ap.add_argument("--hyde", action="store_true")
    ap.add_argument("--json", dest="out", default=None)
    args = ap.parse_args()

    path = Path(args.path)
    if not path.is_absolute():
        path = BACKEND_ROOT / path
    if not path.exists():
        print(f"골든셋 없음: {path}\n  → eval/golden_qa.example.json 를 복사해 "
              f"질문·기대 보고서 id 를 채우세요.", file=sys.stderr)
        return 2

    cases = rag_eval.load_golden(path)
    db = SessionLocal()
    try:
        actor = _actor(db, args.user)
        result = rag_eval.run_eval(
            db, actor, cases, k=args.k, graph=args.graph,
            rerank=args.rerank or None, hyde=args.hyde or None,
        )
    finally:
        db.close()

    agg = result["aggregate"]
    cfg = result["config"]
    print(f"\n=== RAG 평가 (n={agg['n_cases']}, k={cfg['k']}, "
          f"graph={cfg['graph']} rerank={cfg['rerank']} hyde={cfg['hyde']}) ===")
    for r in result["cases"]:
        rk = r.get(f"recall@{args.k}")
        pk = r.get(f"precision@{args.k}")
        print(f"  [{r['id']}] recall={_fmt(rk)} prec={_fmt(pk)} "
              f"mrr={_fmt(r['mrr'])} seed={_fmt(r['seed_recall'])}  {r['query'][:40]}")
    print(f"\n  평균: recall@{args.k}={_fmt(agg[f'recall@{args.k}'])} "
          f"precision@{args.k}={_fmt(agg[f'precision@{args.k}'])} "
          f"MRR={_fmt(agg['mrr'])} seed_recall={_fmt(agg['seed_recall'])}\n")

    if args.out:
        Path(args.out).write_text(
            json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"결과 저장: {args.out}")
    return 0


def _fmt(v) -> str:
    return "  -  " if v is None else f"{v:.3f}"


if __name__ == "__main__":
    raise SystemExit(main())
