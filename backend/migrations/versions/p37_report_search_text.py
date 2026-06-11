"""phase 37 — reports.search_text + pg_trgm GIN (본문 전문검색)

보고서 제목 + 모든 위젯 본문을 평탄화한 평문을 `reports.search_text`(TEXT)에
저장하고, pg_trgm 트라이그램 GIN 인덱스로 부분일치 검색한다. 한국어는 스톡 PG에
형태소 사전이 없어 `to_tsvector('korean')`을 못 쓰므로, 언어 비의존 3글자 n-gram
(pg_trgm)으로 "보고서"가 "보고서를"에 잡히게 한다.

평문 추출은 Python(app.widgets.text_extraction)이 담당한다 — HTML strip·위젯 구조
이해가 필요해 SQL 트리거로는 못 한다. 따라서 컬럼은 NULL 로 추가하고, 기존 행은
별도 백필 스크립트(scripts/backfill_search_text.py)로 채운다.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "p37_report_search_text"
down_revision: Union[str, None] = "p36_user_preferences"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 트라이그램 부분일치(언어 비의존, 한국어 포함). 표준 contrib 확장.
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")

    op.add_column(
        "reports",
        sa.Column("search_text", sa.Text(), nullable=True),
    )

    # 부분일치(ILIKE '%..%')·similarity 가속용 GIN 트라이그램 인덱스.
    op.create_index(
        "ix_reports_search_text_trgm",
        "reports",
        ["search_text"],
        postgresql_using="gin",
        postgresql_ops={"search_text": "gin_trgm_ops"},
    )

    # 기존 보고서 색인 — 운영 자동 업데이트(setup_and_upgrade_db.py 가 alembic
    # upgrade head 만 돌림)에서 별도 백필 단계 없이 즉시 검색되게, 이 마이그레이션
    # 안에서 같이 채운다. 평문 추출은 Python(app.widgets.text_extraction)이 담당.
    # ※ 새/수정 보고서는 ORM 이벤트 훅이 자동 색인하므로 여기선 기존 행만.
    _backfill_search_text(op.get_bind())


def _backfill_search_text(bind) -> None:
    import json

    from app.widgets.text_extraction import extract_searchable_text

    # 메모리 폭주 방지 — id 만 먼저 받아 배치로 처리.
    ids = [row[0] for row in bind.execute(sa.text("SELECT id FROM reports")).fetchall()]
    batch = 200
    for start in range(0, len(ids), batch):
        chunk = ids[start : start + batch]
        rows = (
            bind.execute(
                sa.text(
                    "SELECT id, title, content, pages FROM reports WHERE id = ANY(:ids)"
                ),
                {"ids": chunk},
            )
            .mappings()
            .all()
        )
        for r in rows:
            content = r["content"]
            pages = r["pages"]
            # psycopg 가 보통 dict/list 로 주지만, 문자열이면 방어적으로 파싱.
            if isinstance(content, str):
                try:
                    content = json.loads(content)
                except Exception:
                    content = {}
            if isinstance(pages, str):
                try:
                    pages = json.loads(pages)
                except Exception:
                    pages = []
            text = (
                extract_searchable_text(
                    content=content or {},
                    pages=pages or [],
                    title=r["title"] or "",
                    report_id=r["id"],
                )
                or None
            )
            bind.execute(
                sa.text("UPDATE reports SET search_text = :t WHERE id = :id"),
                {"t": text, "id": r["id"]},
            )


def downgrade() -> None:
    op.drop_index("ix_reports_search_text_trgm", table_name="reports")
    op.drop_column("reports", "search_text")
    # 확장은 다른 곳이 쓸 수 있어 남겨둔다(DROP EXTENSION 안 함).
