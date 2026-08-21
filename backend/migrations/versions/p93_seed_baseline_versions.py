"""phase 93 — 버전 이력이 없는 옛 보고서에 기준선(baseline) 스냅샷 시딩

`record_version` 은 저장 **뒤** 본문을 찍는다. 그래서 버전 기능이 생기기 전
(2026-05~06)에 만들어진 보고서는 이력이 0개인데, 이 상태에서 누군가(특히 AI가)
처음 수정하면:

  - 남는 버전은 **수정된 결과 하나뿐**
  - `restore_version` 으로 되돌리면 그 수정본으로 돌아간다
  - **원본은 복구 불가**

v0.149.0 에서 되돌리기에 미리보기·동시성 가드를 붙였는데, 되돌릴 지점 자체가
없으면 그 안전망이 성립하지 않는다. 여기서 현재 본문을 v1 으로 한 번 찍어
"손대기 전" 복원점을 만들어 준다.

**일회성으로 충분한 이유**: 최근 30일 생성분 854건은 전부 버전을 갖는다 —
지금 생성 경로는 항상 v1 을 시딩하므로 버전 없는 보고서는 더 생기지 않는다
(닫힌 집합 104건).

`source='baseline'` 은 `versioning.ORDINARY_SOURCES`('save','mcp')에 없으므로
`prune_versions` 가 건너뛴다 = **영구 보존**. 수정이 아무리 쌓여도 최초 상태로
돌아갈 길이 남는다(게시·되돌리기 마커와 같은 취급).
"""
import gzip
import hashlib
import json
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "p93_seed_baseline_versions"
down_revision: Union[str, None] = "p92_composite_request_via"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# versioning._build_body 와 **같은 필드·같은 직렬화**여야 한다. 여기서 모델을
# import 하지 않는 건 마이그레이션 관례(모델은 나중에 바뀐다) — 대신 형태를
# 고정해 두고, 어긋나면 decode 쪽에서 바로 드러난다.
_BODY_KEYS = ("title", "pages", "content", "layout_overrides", "props_overrides")


def _serialize(body: dict) -> tuple[bytes, str, int]:
    raw = json.dumps(
        body, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode("utf-8")
    return gzip.compress(raw, compresslevel=6), hashlib.sha256(raw).hexdigest(), len(raw)


def upgrade() -> None:
    bind = op.get_bind()
    rows = bind.execute(sa.text("""
        SELECT r.id, r.revision, r.title, r.pages, r.content,
               r.layout_overrides, r.props_overrides
        FROM reports r
        LEFT JOIN report_versions v ON v.report_id = r.id
        WHERE v.id IS NULL
        ORDER BY r.id
    """)).mappings().all()

    for r in rows:
        body = {
            "title": r["title"],
            "pages": r["pages"] or [],
            "content": r["content"] or {},
            "layout_overrides": r["layout_overrides"],
            "props_overrides": r["props_overrides"],
        }
        assert set(body) == set(_BODY_KEYS)
        gz, sha, nbytes = _serialize(body)
        bind.execute(
            sa.text("""
                INSERT INTO report_versions
                    (report_id, seq, revision, author_user_id, source,
                     created_at, body_gzip, body_sha256, body_bytes, is_pinned)
                VALUES
                    (:rid, 1, :rev, NULL, 'baseline',
                     now(), :gz, :sha, :n, false)
            """),
            {"rid": r["id"], "rev": r["revision"] or 1,
             "gz": gz, "sha": sha, "n": nbytes},
        )
    print(f"  [p93] 기준선 스냅샷 시딩: {len(rows)}건")


def downgrade() -> None:
    # 이 마이그레이션이 만든 것만 지운다(다른 경로는 'baseline' 을 쓰지 않는다).
    op.execute("DELETE FROM report_versions WHERE source = 'baseline'")
