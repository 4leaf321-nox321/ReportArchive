"""런타임 설정 저장소 — 큐레이션된 레지스트리 + `.env` 폴백 + 짧은 프로세스 캐시.

정책(합의):
- `.env`(settings) = 기본값. app_settings 테이블에 override 가 있으면 그 값이 우선.
- 노출 대상은 REGISTRY 로 **큐레이션**(범용 key-value 아님). 각 키에 타입·범위·
  라벨·설명 + **재색인 필요 여부**(requires_reindex) 메타.
- get() 은 짧은 TTL 캐시로 재시작 없이 반영하되 요청마다 DB 히트는 피한다. 프로세스가
  여러 개(웹·워커)면 다른 프로세스는 최대 TTL 만큼 늦게 본다(경계 있는 eventual).

★ 함정: requires_reindex=True 인 키(청크 링크 임계 등)는 **색인 시점**에 값이
report_chunks.entity_ids 에 구워지므로, 런타임 변경은 **기존 보고서엔 무효** —
재색인(reindex_embeddings)해야 반영된다. UI 가 이 배지를 반드시 보여준다.
"""
from __future__ import annotations

import json
import threading
import time
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings

# 노출할 설정만 큐레이션. key 는 settings(.env) 필드명과 일치해야 한다(기본값 폴백).
REGISTRY: dict[str, dict] = {
    "rag_rerank_enabled": {
        "type": "bool", "group": "검색 품질", "label": "재랭킹 기본값",
        "desc": "후보 문단을 LLM 이 다시 채점해 상위만 인용(질문당 AI 1콜). "
                "사용자가 질문마다 켜고 끌 수 있고, 이 값은 그 기본값.",
        "requires_reindex": False,
    },
    "rag_hyde_enabled": {
        "type": "bool", "group": "검색 품질", "label": "HyDE(가상답변) 기본값",
        "desc": "모호한 질문을 가상 답변 문단으로 바꿔 검색(질문당 AI 1콜). "
                "사용자 질문별 override 가능, 이 값은 기본값.",
        "requires_reindex": False,
    },
    "rag_decompose_enabled": {
        "type": "bool", "group": "질문 이해", "label": "질문 분해",
        "desc": "복합 질문을 하위 질문들로 쪼개 각각 검색 후 근거를 합친다(질문당 "
                "AI 1콜). HyDE 와 동시에 켜지면 분해가 우선.",
        "requires_reindex": False,
    },
    "rag_alias_expand_enabled": {
        "type": "bool", "group": "질문 이해", "label": "별칭·약어 확장",
        "desc": "질문이 언급한 객체의 다른 표기(정식명·코드·별칭)를 키워드 검색에 "
                "덧붙인다(온톨로지 별칭 재사용, AI 불필요). 즉시 반영.",
        "requires_reindex": False,
    },
    "rag_aggregate_routing_enabled": {
        "type": "bool", "group": "질문 이해", "label": "집계 질의 라우팅",
        "desc": "\"몇 개·목록·비교\" 같은 집계형 질문을 온톨로지 집계로 답한다"
                "(개수는 계산이라 정확). 신호어 있을 때만 AI 1콜. 불확실하면 일반 검색 폴백.",
        "requires_reindex": False,
    },
    "seed_link_min_score": {
        "type": "float", "group": "온톨로지 링킹", "label": "질문→씨앗 의미 임계",
        "min": 0.0, "max": 1.0, "step": 0.01,
        "desc": "질문을 온톨로지 객체(씨앗)에 의미로 연결할 최소 코사인. 높일수록 엄격. "
                "질의 시점 적용 → 즉시 반영.",
        "requires_reindex": False,
    },
    "embedding_hybrid_min_score": {
        "type": "float", "group": "검색 품질", "label": "하이브리드 최소 유사도",
        "min": 0.0, "max": 1.0, "step": 0.01,
        "desc": "시맨틱 검색에서 약한 매치를 거르는 최소 코사인. 즉시 반영.",
        "requires_reindex": False,
    },
    "chunk_link_min_score": {
        "type": "float", "group": "온톨로지 링킹", "label": "구절→객체 의미 임계",
        "min": 0.0, "max": 1.0, "step": 0.01,
        "desc": "보고서 문단을 객체에 의미로 연결할 최소 코사인. **색인 시점 적용** — "
                "변경 후 재색인해야 기존 보고서에 반영.",
        "requires_reindex": True,
    },
    "chunk_link_max_per_chunk": {
        "type": "int", "group": "온톨로지 링킹", "label": "문단당 객체 링크 상한",
        "min": 1, "max": 50, "step": 1,
        "desc": "한 문단이 연결될 객체 수 상한. **색인 시점 적용** — 재색인 필요.",
        "requires_reindex": True,
    },
}

_TTL = 45.0  # 초 — 재시작 없이 반영하되 요청마다 DB 히트는 피하는 절충
_CACHE: dict[str, Any] = {"at": 0.0, "vals": {}}
_lock = threading.Lock()


def _coerce(type_name: str, value):
    if type_name == "bool":
        return bool(value)
    if type_name == "int":
        return int(value)
    if type_name == "float":
        return float(value)
    return value


def _load_overrides() -> dict[str, Any]:
    """app_settings 전체를 타입 변환해 로드. 테이블 부재·오류 시 {}(기본값 폴백)."""
    from app.database import SessionLocal
    from app.modules.app_settings.models import AppSetting

    db = SessionLocal()
    try:
        rows = db.execute(select(AppSetting.key, AppSetting.value)).all()
    except Exception:  # noqa: BLE001 — 테이블 미생성 등: 조용히 기본값으로
        return {}
    finally:
        db.close()
    out: dict[str, Any] = {}
    for key, raw in rows:
        meta = REGISTRY.get(key)
        if not meta:
            continue
        try:
            out[key] = _coerce(meta["type"], json.loads(raw))
        except (ValueError, TypeError):
            continue
    return out


def _overrides() -> dict[str, Any]:
    now = time.monotonic()
    with _lock:
        if now - _CACHE["at"] > _TTL:
            _CACHE["vals"] = _load_overrides()
            _CACHE["at"] = now
        return _CACHE["vals"]


def invalidate() -> None:
    """캐시 강제 만료 — 쓰기 직후 같은 프로세스가 즉시 새 값을 보게."""
    with _lock:
        _CACHE["at"] = 0.0


def get(key: str):
    """유효값 = DB override(있으면) 아니면 .env 기본값. REGISTRY 밖 키는 settings 직접."""
    default = getattr(settings, key, None)
    if key not in REGISTRY:
        return default
    ov = _overrides()
    return ov[key] if key in ov else default


def _validate(key: str, value):
    meta = REGISTRY[key]
    v = _coerce(meta["type"], value)
    if meta["type"] in ("int", "float"):
        lo, hi = meta.get("min"), meta.get("max")
        if lo is not None and v < lo:
            raise ValueError(f"{key}: {v} < 최소 {lo}")
        if hi is not None and v > hi:
            raise ValueError(f"{key}: {v} > 최대 {hi}")
    return v


def set_many(db: Session, changes: dict, user_id: int | None) -> dict:
    """override 를 upsert. 알 수 없는 키·범위 밖은 ValueError. 커밋 후 캐시 무효화."""
    from app.modules.app_settings.models import AppSetting

    applied: dict[str, Any] = {}
    for key, raw in (changes or {}).items():
        if key not in REGISTRY:
            raise ValueError(f"알 수 없는 설정: {key}")
        v = _validate(key, raw)
        row = db.get(AppSetting, key)
        if row is None:
            db.add(AppSetting(key=key, value=json.dumps(v), updated_by_user_id=user_id))
        else:
            row.value = json.dumps(v)
            row.updated_by_user_id = user_id
        applied[key] = v
    db.commit()
    invalidate()
    return applied


def reset(db: Session, key: str) -> None:
    """override 삭제 → .env 기본값으로 복귀. 캐시 무효화."""
    from app.modules.app_settings.models import AppSetting

    row = db.get(AppSetting, key)
    if row is not None:
        db.delete(row)
        db.commit()
    invalidate()


def all_effective(db: Session) -> list[dict]:
    """관리자 UI 용 — 키별 (유효값·기본값·override 여부 + 메타). DB 직접(캐시 무관)."""
    from app.modules.app_settings.models import AppSetting

    rows = {r.key: r for r in db.execute(select(AppSetting)).scalars().all()}
    out: list[dict] = []
    for key, meta in REGISTRY.items():
        default = getattr(settings, key, None)
        overridden = key in rows
        val = default
        if overridden:
            try:
                val = _coerce(meta["type"], json.loads(rows[key].value))
            except (ValueError, TypeError):
                val = default
        out.append({
            "key": key,
            "value": val,
            "default": default,
            "overridden": overridden,
            "type": meta["type"],
            "label": meta["label"],
            "desc": meta["desc"],
            "group": meta["group"],
            "min": meta.get("min"),
            "max": meta.get("max"),
            "step": meta.get("step"),
            "requires_reindex": bool(meta.get("requires_reindex")),
        })
    return out
