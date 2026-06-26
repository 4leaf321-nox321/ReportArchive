"""보고서 1건 자동 요약/태깅 핸들러 (B, B300_보조AI_설계.md §B) — embed_report 대칭.

저장 시 적재되어 LLM 으로 **초록 + 추천 태그/분류**를 만들어 report_ai_summaries 에
upsert 한다. content_hash 동일하면 skip(비용 가드). 소프트삭제는 기존 요약 제거.
작성자(owner)가 'auto_summary' 엔티틀먼트(§E)가 없으면 생성하지 않는다.

요약은 표시물(승인 불필요), tags/suggested_category 는 추천(적용은 사람이).

payload: { report_id: int, force?: bool }
"""
from __future__ import annotations

import hashlib
import json
import re

from sqlalchemy import delete
from sqlalchemy.orm import Session

from app.ai.llm import chat
from app.ai.models import ReportAiSummary
from app.config import settings
from app.jobs.registry import handler
from app.modules.reports.models import Report
from app.widgets.text_extraction import extract_searchable_text_for_report

# 프롬프트 입력 본문 상한(문자) — 토큰 폭주 방지. 해시도 이 잘린 본문 기준.
_MAX_TEXT = 8000

_PROMPT = (
    "다음 보고서 본문을 읽고 JSON 으로만 답하라. 형식:\n"
    '{"summary": "2~3문장 한국어 초록", "tags": ["키워드", ...], '
    '"category": "한 단어 분류 또는 null"}\n'
    "summary 는 핵심만 간결히. tags 는 3~6개. 코드블록 없이 JSON 만 출력하라.\n\n"
    "본문:\n"
)

_JSON_RE = re.compile(r"\{.*\}", re.DOTALL)


def _parse(content: str) -> dict:
    """LLM 응답에서 JSON 추출. 실패하면 원문을 summary 로 폴백 — 재시도 폭주를
    막고 dev(mock 에코)에서도 행이 생기게 한다."""
    m = _JSON_RE.search(content or "")
    if m:
        try:
            obj = json.loads(m.group(0))
            cat = obj.get("category")
            return {
                "summary": str(obj.get("summary") or "").strip(),
                "tags": [
                    str(t).strip()
                    for t in (obj.get("tags") or [])
                    if str(t).strip()
                ][:10],
                "category": (str(cat).strip() or None) if cat else None,
            }
        except (json.JSONDecodeError, ValueError, TypeError):
            pass
    return {"summary": (content or "").strip()[:500], "tags": [], "category": None}


@handler("summarize_report")
def summarize_report(session: Session, payload: dict) -> dict:
    report_id = int(payload["report_id"])
    force = bool(payload.get("force", False))
    # 엔드포인트가 이미 권한을 인가하고 적재한 잡(일괄·수동 '다시 생성')이면 작성자
    # 게이트를 건너뛴다 — 인가가 호출부로 옮겨감.
    authorized = bool(payload.get("authorized", False))

    report = session.get(Report, report_id)
    if report is None:
        return {"report_id": report_id, "skipped": "not_found"}

    # 소프트삭제: 요약 대상 아님 — 기존 요약 제거.
    if getattr(report, "deleted_at", None) is not None:
        session.execute(
            delete(ReportAiSummary).where(ReportAiSummary.report_id == report_id)
        )
        session.commit()
        return {"report_id": report_id, "skipped": "deleted"}

    existing = session.get(ReportAiSummary, report_id)
    # 기존 요약 보존 — 자동(저장)으론 덮어쓰지 않는다(사용자가 기존 걸 선호할 수
    # 있어서). force(수동 '다시 생성'·목록 일괄)일 때만 갱신.
    if existing is not None and not force:
        return {"report_id": report_id, "skipped": "exists"}

    # 권한 게이트(§E) — authorized 잡은 통과. 자동 경로는 **소유자 OR 최근 편집자**
    # 가 'auto_summary' 권한자면 통과(편집 권한 보유자가 작업한 문서).
    if not authorized:
        from app.ai.entitlements import ai_enabled_for
        from app.modules.users.models import User

        def _entitled(uid):
            u = session.get(User, uid) if uid else None
            return u is not None and ai_enabled_for(session, u, "auto_summary")

        if not (
            _entitled(report.owner_user_id)
            or _entitled(getattr(report, "updated_by_user_id", None))
        ):
            return {"report_id": report_id, "skipped": "not_entitled"}

    text = (extract_searchable_text_for_report(report) or "")[:_MAX_TEXT]
    if not text.strip():
        return {"report_id": report_id, "skipped": "empty"}

    fingerprint = f"{settings.llm_backend}:{settings.llm_model}"
    content_hash = hashlib.sha256(
        (fingerprint + "\n" + text).encode("utf-8")
    ).hexdigest()

    # LLM 호출 — 실패(LLMError)는 위로 전파(큐가 재시도). 저장은 이미 끝나 무해.
    res = chat([{"role": "user", "content": _PROMPT + text}])
    parsed = _parse(res.content or "")

    if existing is None:
        existing = ReportAiSummary(report_id=report_id)
        session.add(existing)
    existing.summary = parsed["summary"]
    existing.tags = parsed["tags"]
    existing.suggested_category = parsed["category"]
    existing.content_hash = content_hash
    existing.model = res.model
    session.commit()
    return {"report_id": report_id, "summary_len": len(parsed["summary"])}
