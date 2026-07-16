"""LLM 매핑 제안 — 조회한 샘플 레코드 + 대상 축(속성정의·관계종류)을 LLM 에 주고
'어느 필드를 값·속성·관계로 매핑할지' 초안을 받는다.

안전장치 2겹:
  1) **휴리스틱 폴백** — LLM 이 없거나(dev mock) 응답이 쓸 수 없으면 필드명↔속성명
     정규화 매칭으로 대신 채운다. LLM 없이도 동작.
  2) **검증(_sanitize)** — 제안된 경로/슬러그/관계가 실제로 존재하는 것만 남긴다
     (환각 방어). 그래서 프론트는 받은 걸 그대로 폼에 넣어도 안전하다.

반환: {value_path, property_map:{slug:path}, relation_map:[{relation,target_type,path}], source}
"""
from __future__ import annotations

import json
import re

from sqlalchemy.orm import Session

from app.ai.llm import LLMError, chat
from app.modules.entities import services as ent

_JSON_RE = re.compile(r"\{.*\}", re.DOTALL)
_MAX_FIELDS = 100
_NAME_LEAVES = {"name", "title", "label", "이름", "명칭", "명", "값"}


def _flatten(obj, prefix: str = "", out: dict | None = None) -> dict:
    """중첩 JSON → {점표기 leaf 경로: 샘플값}. 배열은 첫 원소만."""
    if out is None:
        out = {}
    if isinstance(obj, dict):
        for k, v in obj.items():
            _flatten(v, f"{prefix}.{k}" if prefix else k, out)
    elif isinstance(obj, list):
        if obj:
            _flatten(obj[0], f"{prefix}.0", out)
    elif prefix:
        out[prefix] = obj
    return out


def _norm(s) -> str:
    return re.sub(r"[\s_\-]+", "", (str(s) or "").strip().lower())


def _leaf(path: str) -> str:
    return path.rsplit(".", 1)[-1]


def _flatten_many(records: list[dict], fields: list[str] | None = None) -> dict:
    """여러 레코드 → {점표기 leaf 경로: 대표 샘플값}.

    대표값은 **처음 만나는 non-null 값**. 한 레코드만 보면 그 레코드에서 null 인
    navigation($expand 된 product 등)의 하위 경로가 통째로 안 보여서, LLM 도
    휴리스틱도 그 필드의 존재 자체를 모른다.

    fields 는 probe 가 레코드 전체를 스캔해 모은 경로 목록 — 샘플 몇 건에는 값이
    없어도 후보로는 남겨야 하므로 값 없이(None) 채워 넣는다.
    """
    out: dict = {}
    for r in records or []:
        if not isinstance(r, dict):
            continue
        for p, v in _flatten(r).items():
            # 이미 값이 있으면 유지 — 먼저 만난 non-null 이 대표값.
            if out.get(p) is None:
                out[p] = v
            else:
                out.setdefault(p, v)
    for f in fields or []:
        out.setdefault(f, None)
    # 중간 노드 제거 — 어떤 레코드에서 product 가 null 이면 leaf 로 잡혀 'product' 가
    # 들어오는데, 하위 경로(product.ProductCode)가 있다면 그건 객체를 가리킨다.
    # 속성 값으로 쓸 수 없으니 후보에서 뺀다(probe 의 fields 와 같은 규칙).
    return {
        p: v for p, v in out.items()
        if not any(q.startswith(f"{p}.") for q in out)
    }


def suggest_mapping(
    db: Session,
    target_type_id: int,
    sample: dict | None = None,
    samples: list[dict] | None = None,
    fields: list[str] | None = None,
) -> dict:
    """매핑 초안 제안.

    samples/fields 는 probe 결과를 그대로 넘기면 된다(레코드 5건 + 전체 스캔 경로).
    sample 은 구버전 호출 하위호환 — samples 가 있으면 무시된다.
    """
    axis = ent.get_type(db, target_type_id)
    if axis is None:
        raise ValueError(f"축을 찾을 수 없습니다: {target_type_id}")

    defs = ent.list_property_defs(db, owner_kind="entity_type", owner_id=target_type_id)
    records = samples if samples else ([sample] if sample else [])
    paths = _flatten_many(records, fields)
    axes = ent.list_types(db)
    axis_slugs = {a.slug for a in axes}
    rel_types = ent.list_relation_types(db)
    # 이 축에서 나갈 수 있는 관계(출발 축 제약 없음 OR 이 축 포함).
    applicable = [
        r for r in rel_types
        if not r.src_axis_slugs or axis.slug in (r.src_axis_slugs or [])
    ]

    heur = _heuristic(defs, applicable, paths)

    llm = None
    try:
        llm = _llm_suggest(axis, defs, applicable, paths)
    except (LLMError, ValueError, json.JSONDecodeError, KeyError, TypeError):
        llm = None

    if llm:
        out = _sanitize(llm, defs, applicable, axis_slugs, set(paths))
        out["source"] = "llm"
        if not out["value_path"]:  # LLM 이 값 필드를 놓치면 휴리스틱으로 보강.
            out["value_path"] = heur["value_path"]
        return out

    out = _sanitize(heur, defs, applicable, axis_slugs, set(paths))
    out["source"] = "heuristic"
    return out


# --- 휴리스틱 -----------------------------------------------------------------
def _heuristic(defs, applicable, paths: dict) -> dict:
    plist = list(paths.keys())
    leaf_norm = {p: _norm(_leaf(p)) for p in plist}

    value_path = next((p for p in plist if leaf_norm[p] in _NAME_LEAVES), "")
    if not value_path and plist:
        value_path = plist[0]

    property_map = {}
    for d in defs:
        targets = {_norm(d.key), _norm(d.label)}
        hit = next((p for p in plist if leaf_norm[p] in targets), None)
        if hit:
            property_map[d.key] = hit

    relation_map = []
    for r in applicable:
        dsts = r.dst_axis_slugs or []
        if not dsts:
            continue
        cands = {_norm(r.slug), _norm(r.label)} | {_norm(s) for s in dsts}
        hit = next((p for p in plist if leaf_norm[p] in cands), None)
        if hit:
            relation_map.append({"relation": r.slug, "target_type": dsts[0], "path": hit})

    return {"value_path": value_path, "property_map": property_map,
            "relation_map": relation_map}


# --- LLM ---------------------------------------------------------------------
def _llm_suggest(axis, defs, applicable, paths: dict) -> dict | None:
    # 값이 없는 경로도 실재하는 후보다(샘플 몇 건에서만 비었을 뿐) — "null" 로 찍어
    # 항상 빈 필드처럼 오해하게 두지 말고 그렇게 밝힌다.
    fields_desc = "\n".join(
        f"- {p}: "
        + (
            "(샘플에 값 없음 — 필드는 존재)"
            if v is None
            else json.dumps(v, ensure_ascii=False)[:60]
        )
        for p, v in list(paths.items())[:_MAX_FIELDS]
    ) or "(없음)"
    props_desc = "\n".join(f"- {d.key} ({d.label}, {d.data_type})" for d in defs) or "(없음)"
    rels_desc = "\n".join(
        f"- {r.slug} ({r.label}) → 대상축 {','.join(r.dst_axis_slugs or []) or '제약없음'}"
        for r in applicable
    ) or "(없음)"

    prompt = (
        "외부 시스템 레코드의 필드를 온톨로지 축에 매핑한다. 아래 정보를 보고 JSON 으로만 답하라.\n\n"
        f"[대상 축] {axis.label} ({axis.slug})\n\n"
        f"[사용 가능한 필드 경로: 샘플값]\n{fields_desc}\n\n"
        f"[이 축의 속성 (slug, 라벨, 타입)]\n{props_desc}\n\n"
        f"[가능한 관계 (slug, 라벨, 대상축)]\n{rels_desc}\n\n"
        "규칙:\n"
        "- value_path: 객체의 '이름'에 해당하는 필드 경로 하나(위 목록에 있는 값만).\n"
        "- properties: 각 속성 slug 에 대응하는 필드 경로. 마땅한 필드가 없으면 넣지 마라.\n"
        "- relations: 관계로 이어질 필드가 있으면 {relation, target_type, path}. 없으면 빈 배열.\n"
        "- 위에 나열된 필드 경로·속성 slug·관계 slug·대상축 slug 만 사용하라(새로 지어내지 말 것).\n\n"
        '형식: {"value_path": "...", "properties": {"slug": "path", ...}, '
        '"relations": [{"relation": "...", "target_type": "...", "path": "..."}]}\n'
        "코드블록 없이 JSON 만 출력하라."
    )

    res = chat([{"role": "user", "content": prompt}], json_mode=True, temperature=0)
    # mock 백엔드(dev)는 프롬프트를 되울릴 뿐 — 실 제안이 아니므로 휴리스틱에 맡긴다.
    if res.backend == "mock":
        return None
    m = _JSON_RE.search(res.content or "")
    if not m:
        return None
    obj = json.loads(m.group(0))
    return {
        "value_path": str(obj.get("value_path") or ""),
        "property_map": {
            str(k): str(v) for k, v in (obj.get("properties") or {}).items() if v
        },
        "relation_map": [
            {
                "relation": str(r.get("relation") or ""),
                "target_type": str(r.get("target_type") or ""),
                "path": str(r.get("path") or ""),
            }
            for r in (obj.get("relations") or [])
            if isinstance(r, dict)
        ],
    }


# --- 검증(환각 방어) ----------------------------------------------------------
def _sanitize(sug: dict, defs, applicable, axis_slugs: set, path_set: set) -> dict:
    def_keys = {d.key for d in defs}
    rel_slugs = {r.slug for r in applicable}
    vp = sug.get("value_path") or ""
    value_path = vp if vp in path_set else ""
    property_map = {
        k: v for k, v in (sug.get("property_map") or {}).items()
        if k in def_keys and v in path_set
    }
    relation_map = [
        {"relation": r["relation"], "target_type": r["target_type"], "path": r["path"]}
        for r in (sug.get("relation_map") or [])
        if r.get("relation") in rel_slugs
        and r.get("target_type") in axis_slugs
        and r.get("path") in path_set
    ]
    return {"value_path": value_path, "property_map": property_map,
            "relation_map": relation_map}
