"""보고서 본문(content) → 검색용 평문/청크 추출.

키워드 검색(현재)과 향후 AI(임베딩·RAG)가 공유하는 단일 토대. 위젯 타입에
결합하지 않고(레지스트리·DB 무의존) content JSON 을 재귀로 훑어 사람이 읽는
문자열만 모은다. 새 위젯이 생겨도 자동 포함되며, 약간의 노이즈는 부분일치
검색이라 무해하다.

산출물 두 형태:
  - `extract_chunks(...)` → 블록/페이지/제목 단위 `TextChunk` 리스트. 위치 메타
    (report_id, page_idx, block_id)를 달고 있어 (a) 스니펫·위젯 점프, (b) 향후
    임베딩 단위, (c) RAG 인용 단위로 그대로 쓸 수 있다.
  - `extract_searchable_text(...)` → 청크를 합친 단일 평문. `reports.search_text`
    (pg_trgm GIN 인덱스) 컬럼에 넣는 키워드 인덱스용.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Any, Optional

# content JSON 에서 "검색에 의미 없는" 키 — 재귀 수집에서 그 값을 건너뛴다.
# file_id/색·토큰/좌표/노드ID/레이아웃 등. 새 위젯이 비텍스트 키를 추가하면
# 여기만 보강하면 된다(과수집보다 과락이 안전 — 노이즈를 줄이는 쪽).
_SKIP_KEYS: frozenset[str] = frozenset(
    {
        # 식별자·참조
        "file_id",
        "fileId",
        "id",
        "key",
        "type",
        "source",
        "target",
        "slug",
        "relation",
        "url",
        "href",
        "src",
        # 좌표·치수
        "x",
        "y",
        "z",
        "w",
        "h",
        "depth",
        "col_span",
        "row_span",
        "value",
        # 스타일·색
        "color",
        "bg",
        "fg",
        "token",
        "align",
        "weight",
        "font_family",
        "font_size_px",
        "size",
        "aspect_ratio",
        # 구조 사이드테이블(텍스트 아님)
        "layout",
        "merges",
        "cell_styles",
        "column_widths",
        "blocks_order",
        "block_sections",
        "layout_overrides",
        "props_overrides",
    }
)

# 실제 HTML 태그(여는/닫는)가 들어있을 때만 태그를 벗긴다. "a < b" 같은 평문은
# 건드리지 않으려고 진짜 태그 패턴일 때만 strip.
_TAG_RE = re.compile(r"</?[a-zA-Z][^>]*>")
_WS_RE = re.compile(r"\s+")

# 청크 1개·전체 평문 길이 상한 — 인덱스 비대화 방지. 검색은 부분일치라 앞부분만
# 있어도 대부분 잡힌다.
_MAX_CHUNK_CHARS = 8_000
_MAX_TOTAL_CHARS = 100_000


class _HTMLStripper(HTMLParser):
    """HTML → 평문(태그 제거, 텍스트 노드만)."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._parts: list[str] = []

    def handle_data(self, data: str) -> None:
        s = data.strip()
        if s:
            self._parts.append(s)

    def get_text(self) -> str:
        return " ".join(self._parts)


def _strip_html(s: str) -> str:
    try:
        p = _HTMLStripper()
        p.feed(s)
        return p.get_text()
    except Exception:
        # 파서 실패 시 거친 폴백.
        return _TAG_RE.sub(" ", s)


def _maybe_strip_html(s: str) -> str:
    return _strip_html(s) if _TAG_RE.search(s) else s


def _norm(s: str) -> str:
    return _WS_RE.sub(" ", s).strip()


def _collect(node: Any, out: list[str]) -> None:
    """content 값을 재귀로 훑어 사람이 읽는 문자열을 out 에 모은다.

    - dict: denylist 키의 값은 건너뛰고, 나머지 값으로 내려간다(키 자체는 텍스트로
      수집하지 않음 — 동적 키는 보통 slug/숫자라 의미 없음).
    - list: 각 원소로 내려간다.
    - str: 진짜 HTML 이면 태그 제거 후 수집.
    - 숫자/불리언/None: 무시.
    """
    if isinstance(node, str):
        s = _norm(_maybe_strip_html(node))
        if s:
            out.append(s)
        return
    if isinstance(node, dict):
        for k, v in node.items():
            if k in _SKIP_KEYS:
                continue
            _collect(v, out)
        return
    if isinstance(node, list):
        for v in node:
            _collect(v, out)
        return
    # int/float/bool/None → 검색 대상 아님.


@dataclass
class TextChunk:
    """검색·임베딩·인용의 최소 단위. 위치 메타로 어느 보고서·페이지·위젯에서
    나왔는지 되짚을 수 있다."""

    text: str
    report_id: Optional[int] = None
    page_idx: Optional[int] = None  # None = 레거시 단일 content(또는 제목/페이지명)
    block_id: Optional[str] = None  # None = 제목/페이지명 등 블록 아님
    widget_type: Optional[str] = None  # 알 수 있을 때만(없으면 None); '__title__'/'__page__' 마커

    @property
    def key(self) -> str:
        """결정적 청크 식별자 — 향후 임베딩 행을 매달 때 안정 키로 사용."""
        page = "c" if self.page_idx is None else str(self.page_idx)
        block = self.block_id if self.block_id is not None else "_"
        return f"{self.report_id}:{page}:{block}"

    def to_dict(self) -> dict:
        return {
            "key": self.key,
            "text": self.text,
            "report_id": self.report_id,
            "page_idx": self.page_idx,
            "block_id": self.block_id,
            "widget_type": self.widget_type,
        }


def _chunks_from_content(
    content: Any,
    *,
    report_id: Optional[int],
    page_idx: Optional[int],
    block_types: Optional[dict[str, str]],
    out: list[TextChunk],
) -> None:
    """블록 id → 위젯 content 맵을 블록 단위 청크로."""
    if not isinstance(content, dict):
        return
    for block_id, widget_content in content.items():
        parts: list[str] = []
        _collect(widget_content, parts)
        if not parts:
            continue
        # 같은 블록 안 중복 제거(순서 유지) — 평문 미러와 *_html 이 같은 문장을
        # 두 번 내는 경우가 흔해, 인덱스 비대화를 막는다.
        seen: set[str] = set()
        deduped = [p for p in parts if not (p in seen or seen.add(p))]
        text = _norm(" ".join(deduped))
        if not text:
            continue
        out.append(
            TextChunk(
                text=text,
                report_id=report_id,
                page_idx=page_idx,
                block_id=block_id,
                widget_type=(block_types or {}).get(block_id),
            )
        )


def extract_chunks(
    *,
    content: Optional[dict] = None,
    pages: Optional[list[dict]] = None,
    title: str = "",
    report_id: Optional[int] = None,
    block_types: Optional[dict[str, str]] = None,
) -> list[TextChunk]:
    """보고서 한 건의 모든 검색 텍스트를 청크 리스트로.

    `content` = 레거시 단일/0페이지 content (블록 id → 위젯 content).
    `pages`   = 다중 페이지 리스트(각 dict 에 `content`, `name`).
    `block_types` = (선택) 블록 id → 위젯 타입. 주면 청크 메타에 채워짐(없으면 None).
    """
    chunks: list[TextChunk] = []

    if isinstance(title, str) and title.strip():
        chunks.append(
            TextChunk(
                text=_norm(title),
                report_id=report_id,
                widget_type="__title__",
            )
        )

    _chunks_from_content(
        content or {},
        report_id=report_id,
        page_idx=None,
        block_types=block_types,
        out=chunks,
    )

    for pi, page in enumerate(pages or []):
        if not isinstance(page, dict):
            continue
        name = page.get("name")
        if isinstance(name, str) and name.strip():
            chunks.append(
                TextChunk(
                    text=_norm(name),
                    report_id=report_id,
                    page_idx=pi,
                    widget_type="__page__",
                )
            )
        _chunks_from_content(
            page.get("content") or {},
            report_id=report_id,
            page_idx=pi,
            block_types=block_types,
            out=chunks,
        )

    # 빈 청크 제거 + 청크별 길이 상한.
    result: list[TextChunk] = []
    for c in chunks:
        t = c.text.strip()
        if not t:
            continue
        if len(t) > _MAX_CHUNK_CHARS:
            t = t[:_MAX_CHUNK_CHARS]
        c.text = t
        result.append(c)
    return result


def extract_searchable_text(
    *,
    content: Optional[dict] = None,
    pages: Optional[list[dict]] = None,
    title: str = "",
    report_id: Optional[int] = None,
    block_types: Optional[dict[str, str]] = None,
    max_chars: int = _MAX_TOTAL_CHARS,
) -> str:
    """청크를 합친 단일 평문 — `reports.search_text` 키워드 인덱스 컬럼용.

    소문자화는 하지 않는다(ILIKE 가 대소문자 무시 + 스니펫에 원문 케이스 유지).
    """
    chunks = extract_chunks(
        content=content,
        pages=pages,
        title=title,
        report_id=report_id,
        block_types=block_types,
    )
    joined = "\n".join(c.text for c in chunks)
    if len(joined) > max_chars:
        joined = joined[:max_chars]
    return joined


def extract_searchable_text_for_report(report: Any) -> str:
    """ORM `Report` 한 건에서 바로 평문 뽑기 — 서비스 쓰기 경로용 편의 래퍼."""
    return extract_searchable_text(
        content=getattr(report, "content", None),
        pages=getattr(report, "pages", None),
        title=getattr(report, "title", "") or "",
        report_id=getattr(report, "id", None),
    )


def extract_chunks_for_report(report: Any) -> list[TextChunk]:
    """ORM `Report` 한 건에서 바로 청크 리스트 뽑기 — 임베딩(RAG) 경로용 편의
    래퍼. extract_searchable_text_for_report 와 대칭."""
    return extract_chunks(
        content=getattr(report, "content", None),
        pages=getattr(report, "pages", None),
        title=getattr(report, "title", "") or "",
        report_id=getattr(report, "id", None),
    )
