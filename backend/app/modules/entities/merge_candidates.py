"""엔티티 중복 후보 탐지 (엔티티머지보조_설계.md §3).

한 축(EntityType) 안에서 같은 대상을 가리키는 중복/동의어 엔티티 후보를 찾는다.
머지 실행은 services.merge_entities 가, 여기서는 **탐지·노출**만 한다.

2레이어:
  - L0 정규화 그룹핑(결정적): casefold + 공백/하이픈/특수문자 제거 → 같은 정규형끼리.
    예: "Galaxy S26" ≡ "galaxy-s26". (한글↔라틴 교차는 못 잡음 → L1·LLM 담당.)
  - L1 임베딩 유사도(넓은 그물): bge-m3 코사인 ≥ 임계(기본 0.60, 실측 §4 — 같은 쌍
    최저 0.64를 포함하려면 낮아야 함). 점수는 정렬·노출용이고 자동 머지 신호 아님.

오탐(예: S26 vs S26 Ultra)은 사람(검토 UI) 또는 LLM 검증(Phase 2)이 거른다.
기각된 쌍(EntityMergeDismissal)은 제외해 재출현을 막는다. mock 임베딩이면 L0만.
"""
from __future__ import annotations

import re
import unicodedata

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.modules.entities.models import (
    Entity,
    EntityMergeDismissal,
    EntityStatus,
    EntityType,
    ReportEntity,
)

# 값↔값 짧은 문자열 유사도의 넓은 그물 임계(실측 §4). embedding_suggest_min_score
# (청크↔값 0.45)와 별개 — 값↔값은 스케일이 달라 별도. config 로 빼지 않고 상수로
# 두되, 필요 시 Phase 2 에서 튜닝.
MERGE_SIM_THRESHOLD = 0.60
# 한 축에서 임베딩 비교할 최대 값 수(폭주 방지). 넘으면 truncated=True.
_MAX_VALUES = 1500


def _merge_normalize(s: str) -> str:
    """L0 그룹핑용 강한 정규화 — casefold + 유니코드 NFKC + 영숫자/한글 외 제거.
    `별칭 비교용 _normalize`(trim+lower)보다 공격적: 공백·하이픈·기호를 다 떼서
    "Galaxy S26"·"galaxy-s26"·"GALAXY S26" 을 같은 키로 만든다."""
    s = unicodedata.normalize("NFKC", s or "")
    s = s.casefold()
    # 영숫자 + 한글만 남김(공백·하이픈·괄호·점 등 제거).
    return re.sub(r"[^0-9a-z가-힣]+", "", s)


def _usage_counts(db: Session, entity_ids: list[int]) -> dict[int, int]:
    """엔티티별 참조 보고서 수(ReportEntity). 생존값 추천·노출에 쓰인다."""
    if not entity_ids:
        return {}
    rows = db.execute(
        select(ReportEntity.entity_id, func.count())
        .where(ReportEntity.entity_id.in_(entity_ids))
        .group_by(ReportEntity.entity_id)
    ).all()
    return {eid: n for eid, n in rows}


class _UnionFind:
    def __init__(self, ids: list[int]):
        self.parent = {i: i for i in ids}

    def find(self, x: int) -> int:
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[rb] = ra


def find_merge_candidates(
    db: Session, type_id: int, *, threshold: float | None = None
) -> dict:
    """축 `type_id` 의 중복 후보 클러스터.

    반환: {
      "type_id", "scanned": 평가한 값 수, "truncated": 상한 초과 여부,
      "backend": 임베딩 백엔드, "threshold",
      "clusters": [{"members": [{id,value,code,usage_count}],
                    "suggested_survivor_id", "score", "exact": bool}]
    }
    """
    etype = db.get(EntityType, type_id)
    if etype is None:
        raise ValueError(f"Unknown entity type: {type_id}")

    thr = MERGE_SIM_THRESHOLD if threshold is None else threshold

    ents = list(
        db.execute(
            select(Entity)
            .where(Entity.type_id == type_id, Entity.status == EntityStatus.active)
            .order_by(Entity.id)
        ).scalars()
    )
    truncated = len(ents) > _MAX_VALUES
    ents = ents[:_MAX_VALUES]
    ids = [e.id for e in ents]
    by_id = {e.id: e for e in ents}

    # 기각 쌍 — (low, high) 정규화로 저장돼 있다.
    dismissed: set[tuple[int, int]] = set(
        db.execute(
            select(
                EntityMergeDismissal.entity_low_id,
                EntityMergeDismissal.entity_high_id,
            ).where(EntityMergeDismissal.type_id == type_id)
        ).all()
    )

    def _pair(a: int, b: int) -> tuple[int, int]:
        return (a, b) if a < b else (b, a)

    uf = _UnionFind(ids)
    # 쌍별 점수(클러스터 노출용) + 정확매칭 여부.
    pair_score: dict[tuple[int, int], float] = {}
    exact_pairs: set[tuple[int, int]] = set()

    # --- L0 정규화 그룹핑 ---
    norm_groups: dict[str, list[int]] = {}
    for e in ents:
        key = _merge_normalize(e.value)
        if key:
            norm_groups.setdefault(key, []).append(e.id)
    for group in norm_groups.values():
        for i in range(len(group)):
            for j in range(i + 1, len(group)):
                p = _pair(group[i], group[j])
                if p in dismissed:
                    continue
                uf.union(*p)
                pair_score[p] = 1.0
                exact_pairs.add(p)

    # --- L1 임베딩 유사도(넓은 그물) ---
    backend = (settings.embedding_backend or "mock").lower()
    if backend != "mock" and len(ents) >= 2:
        import numpy as np

        from app.ai.embeddings import EmbeddingError, embed_texts

        try:
            vecs = embed_texts([e.value for e in ents])
        except EmbeddingError:
            vecs = None  # 임베딩 장애 — L0 결과만 반환
        if vecs is not None:
            mat = np.asarray(vecs, dtype=np.float32)
            mat = mat / (np.linalg.norm(mat, axis=1, keepdims=True) + 1e-8)
            cos = mat @ mat.T
            n = len(ents)
            for i in range(n):
                for j in range(i + 1, n):
                    s = float(cos[i][j])
                    if s < thr:
                        continue
                    p = _pair(ids[i], ids[j])
                    if p in dismissed:
                        continue
                    uf.union(*p)
                    # 더 높은 점수로 갱신(L0=1.0 이 이미 있으면 유지).
                    if s > pair_score.get(p, 0.0):
                        pair_score[p] = s

    # --- 클러스터 구성 ---
    clusters_by_root: dict[int, list[int]] = {}
    for eid in ids:
        clusters_by_root.setdefault(uf.find(eid), []).append(eid)

    usage = _usage_counts(db, ids)
    clusters = []
    for members in clusters_by_root.values():
        if len(members) < 2:
            continue
        # 생존값 추천 = 사용횟수 최다(동률이면 id 작은=먼저 만든 것).
        survivor = max(members, key=lambda eid: (usage.get(eid, 0), -eid))
        # 클러스터 대표 점수 = 멤버 간 쌍 점수 중 최대(가장 강한 연결).
        member_set = set(members)
        scores = [
            v for (a, b), v in pair_score.items() if a in member_set and b in member_set
        ]
        exact = any(
            p in exact_pairs
            for p in pair_score
            if p[0] in member_set and p[1] in member_set
        )
        clusters.append(
            {
                "members": [
                    {
                        "id": eid,
                        "value": by_id[eid].value,
                        "code": by_id[eid].code,
                        "usage_count": usage.get(eid, 0),
                    }
                    for eid in sorted(
                        members, key=lambda x: (-usage.get(x, 0), x)
                    )
                ],
                "suggested_survivor_id": survivor,
                "score": round(max(scores), 4) if scores else None,
                "exact": exact,
            }
        )

    # 강한 연결(정확매칭/높은 점수) 먼저 보이게.
    clusters.sort(key=lambda c: (not c["exact"], -(c["score"] or 0)))

    return {
        "type_id": type_id,
        "scanned": len(ents),
        "truncated": truncated,
        "backend": backend,
        "threshold": thr,
        "clusters": clusters,
    }


def validate_cluster(db: Session, type_id: int, entity_ids: list[int]) -> dict:
    """LLM 검증자 (Phase 2, §5) — 한 클러스터의 값들 중 **실제로 같은 대상**을
    가리키는 것끼리 묶고, 대표 표기를 고르고, 다른 것(outlier)을 분리한다.

    넓은 그물(L1 0.60)이 섞어 넣은 오탐(예: S26 vs S26 Ultra)을 LLM이 걸러
    Phase 1 UI의 멤버별 체크박스를 자동 세팅하게 한다(중복=체크, outlier=해제,
    대표=생존). 머지는 admin 전용이라 엔티틀먼트는 bypass(별도 게이트 없음).

    반환: {backend, duplicate_ids, canonical_id, outlier_ids, reason}.
      mock 백엔드면 verdict 없음(backend='mock', 나머지 None)."""
    import json
    import re

    etype = db.get(EntityType, type_id)
    if etype is None:
        raise ValueError(f"Unknown entity type: {type_id}")
    ents = [db.get(Entity, i) for i in entity_ids]
    ents = [e for e in ents if e and e.type_id == type_id]
    if len(ents) < 2:
        raise ValueError("검증하려면 값이 2개 이상이어야 합니다.")

    backend = (settings.llm_backend or "mock").lower()
    if backend == "mock":
        return {
            "backend": "mock",
            "duplicate_ids": None,
            "canonical_id": None,
            "outlier_ids": None,
            "reason": "LLM 미연결(mock) — 사람이 직접 판단하세요.",
        }

    from app.ai.llm import LLMError, chat

    by_value = {e.value: e.id for e in ents}
    values = [e.value for e in ents]
    system = (
        "너는 기준정보(엔티티) 중복 판정기다. 한 축(분류 기준) 안의 값들이 주어지면, "
        "그 중 **현실에서 정확히 같은 대상**을 가리키는 표기끼리만 묶어라.\n"
        "판정 규칙:\n"
        "- 표기(대소문자·공백·한글/영문)만 다르고 같은 대상이면 **같다**: "
        "'갤럭시S26'='GALAXYS26'='Galaxy S26'.\n"
        "- **등급·접미사·세대가 다르면 서로 다른 제품이다(절대 합치지 마라)**: "
        "'S26'·'S26+'·'S26 Ultra'·'S26 Pro' 는 **모두 다름**. 'A100'≠'A200'. "
        "'1세대'≠'2세대'. 같은 제품군이라는 이유로 묶으면 안 된다.\n"
        "- 확신이 없으면 묶지 말고 outliers 로 분리한다(틀린 머지는 위험).\n"
        "**JSON 으로만** 답하라(코드블록 없이).\n"
        '형식: {"duplicates": ["같은 표기들"], "canonical": "대표 표기", '
        '"outliers": ["다른 표기들"], "reason": "한 줄 근거"}\n'
        "duplicates 는 서로 같은 것들의 목록(대표 포함, 2개 미만이면 빈 배열), "
        "outliers 는 나머지. 모두 입력 값 문자열 그대로 적는다."
    )
    user = json.dumps(
        {"축": etype.label, "값들": values}, ensure_ascii=False
    )
    try:
        res = chat(
            [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ]
        )
    except LLMError as exc:
        raise ValueError(f"LLM 호출 실패: {exc}") from exc

    m = re.search(r"\{.*\}", res.content or "", re.DOTALL)
    if not m:
        raise ValueError("LLM 응답에서 JSON 을 찾지 못했습니다.")
    try:
        parsed = json.loads(m.group(0))
    except (json.JSONDecodeError, ValueError) as exc:
        raise ValueError(f"LLM 응답 파싱 실패: {exc}") from exc

    # 값 문자열 → id 매핑(정확 일치 → 대소문자 무시 폴백). 모르는 값은 무시.
    lower_map = {v.lower(): vid for v, vid in by_value.items()}

    def _to_id(v):
        if not isinstance(v, str):
            return None
        return by_value.get(v) or lower_map.get(v.strip().lower())

    dup_ids = [i for i in (_to_id(v) for v in parsed.get("duplicates") or []) if i]
    out_ids = [i for i in (_to_id(v) for v in parsed.get("outliers") or []) if i]
    canonical_id = _to_id(parsed.get("canonical"))
    # 대표가 duplicates 에 없으면(혹은 누락) duplicates 첫 항목으로 보정.
    if canonical_id not in dup_ids:
        canonical_id = dup_ids[0] if dup_ids else None

    return {
        "backend": backend,
        "duplicate_ids": dup_ids,
        "canonical_id": canonical_id,
        "outlier_ids": out_ids,
        "reason": str(parsed.get("reason") or "")[:500],
    }
