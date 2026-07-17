"""온톨로지 에이전트 도구 카탈로그 (tool-calling 설계 §2).

LLM에게 노출하는 4개 읽기 도구 — 전부 기존 서비스에 매핑한다:
  list_object_types  — 온톨로지 지도(타입·속성·관계)              → list_types 등
  search_objects     — 타입+속성+관계로 객체 검색(결정적)          → search_entities (Phase C)
  get_object         — 객체 프로필(속성·관계·관련보고서)           → get_entity/list_relations
  search_reports     — 텍스트/의미 근거 검색(벡터 RAG를 도구화)     → hybrid_search

각 도구 = (OpenAI 함수 스키마, executor). executor(db, actor, args) → ToolResult:
  {"content": <LLM에 줄 요약 dict>, "objects": [...], "reports": [...]}.
결과는 상위 N + total 로 **크기를 제한**(토큰 폭주·환각 방지). 보고서는
hybrid_search 가 가시성 게이팅하므로 권한 밖 근거는 못 들어간다.
"""
from __future__ import annotations

from typing import Optional

from sqlalchemy.orm import Session

from app.ai import search as ai_search
from app.modules.entities import graph as ent_graph
from app.modules.entities import services as ent

# 결과 크기 상한 — LLM 컨텍스트/환각 방지.
_SEARCH_LIMIT = 15
_REPORTS_LIMIT = 8
_RELATIONS_LIMIT = 25
_SUBGRAPH_MAX_DEPTH = 2      # 에이전트는 넓게 안 봐도 된다(필요하면 seed 바꿔가며).
_SUBGRAPH_MAX_NODES = 40     # graph.subgraph 는 depth 로만 제한 → 고차수 노드면 폭주.


class ToolResult(dict):
    """{"content": dict, "objects": list, "reports": list}. content 만 LLM 에게
    가고, objects/reports 는 오케스트레이터가 인용으로 누적한다."""


def _ok(content: dict, *, objects=None, reports=None) -> ToolResult:
    return ToolResult(content=content, objects=objects or [], reports=reports or [])


def _err(msg: str) -> ToolResult:
    return ToolResult(content={"error": msg}, objects=[], reports=[])


# --------------------------------------------------------------------------- #
# list_object_types — 온톨로지 지도
# --------------------------------------------------------------------------- #
def _exec_list_object_types(db: Session, actor, args: dict) -> ToolResult:
    types = ent.list_types(db)
    otypes = []
    for t in types:
        defs = ent.list_property_defs(db, owner_kind="entity_type", owner_id=t.id)
        props = []
        for d in defs:
            p = {"key": d.key, "label": d.label, "data_type": d.data_type}
            if getattr(d, "enum_options", None):
                p["enum_values"] = [
                    o.get("value") for o in d.enum_options if isinstance(o, dict)
                ]
            if getattr(d, "ref_type_slug", None):
                p["ref_type"] = d.ref_type_slug
            props.append(p)
        otypes.append({
            "slug": t.slug,
            "label": t.label,
            "kind": str(getattr(t.kind_class, "value", t.kind_class)),
            "description": t.description or None,
            "properties": props,
        })
    rels = [
        {
            "slug": r.slug,
            "label": r.label,
            "directed": r.directed,
            "src_types": list(r.src_axis_slugs or []),
            "dst_types": list(r.dst_axis_slugs or []),
        }
        for r in ent.list_relation_types(db)
    ]
    return _ok({"object_types": otypes, "relation_types": rels})


# --------------------------------------------------------------------------- #
# search_objects — 타입+속성+관계 필터
# --------------------------------------------------------------------------- #
def _exec_search_objects(db: Session, actor, args: dict) -> ToolResult:
    type_slug = args.get("type")
    type_id = None
    if type_slug:
        t = ent.get_type_by_slug(db, type_slug)
        if not t:
            return _err(f"알 수 없는 객체 종류: {type_slug!r}. list_object_types 로 확인하세요.")
        # system 축(report·user·dept)은 entities 값 행이 없는 **투영 표식**이라 여기선
        # 구조적으로 0건이다. 빈 결과는 LLM 이 "그런 객체가 없다"로 오독하므로 길을
        # 알려준다(설계: system객체확장_user·report투영 §2.1).
        if str(getattr(t.kind_class, "value", t.kind_class)) == "system":
            return _err(
                f"{type_slug!r} 는 search_objects 로 찾을 수 없습니다(값 목록이 없는 투영 "
                f"객체). 보고서는 search_reports(제목·본문·날짜·종류·작성자)로 찾고, "
                f"이미 아는 대상의 상세·관계는 get_object(type={type_slug!r}, id=…) 를 쓰세요."
            )
        type_id = t.id
    # props 는 축의 property_defs 로 캐스팅해야 해서 type 이 없으면 **조용히 버려진다**
    # (services.search_entities: `if props and type_id is not None`). 그러면 필터가 안 걸린
    # 전체 목록이 그럴듯하게 돌아가 LLM 이 오답을 만든다 → 타입 오류처럼 시끄럽게 실패시킨다.
    if args.get("props") and type_id is None:
        return _err(
            "props(속성 필터)는 type 과 함께 써야 합니다 — 속성은 객체 종류마다 다릅니다. "
            "list_object_types 로 종류를 고른 뒤 type 과 같이 넘기세요."
        )
    limit = min(int(args.get("limit") or _SEARCH_LIMIT), _SEARCH_LIMIT)
    try:
        items, total = ent.search_entities(
            db,
            type_id=type_id,
            q=args.get("q"),
            props=args.get("props"),
            relations=args.get("relations"),
            year=args.get("year"),
            limit=limit,
        )
    except Exception as exc:  # noqa: BLE001 — 필터 형식 오류를 LLM 에게 알려 재시도.
        return _err(f"검색 실패(필터 형식 확인): {exc}")

    rows, objs = [], []
    for e in items:
        tslug = e.entity_type.slug if e.entity_type else None
        rows.append({
            "id": e.id, "value": e.value, "type": tslug,
            "properties": e.properties or {},
        })
        objs.append({"type": tslug, "id": str(e.id), "label": e.value})
    return _ok(
        {"items": rows, "total": total, "shown": len(rows),
         "truncated": total > len(rows)},
        objects=objs,
    )


# --------------------------------------------------------------------------- #
# get_object — 객체 프로필(속성·관계·관련보고서)
# --------------------------------------------------------------------------- #
def _exec_get_object(db: Session, actor, args: dict) -> ToolResult:
    otype = args.get("type")
    oid = str(args.get("id")) if args.get("id") is not None else None
    if not otype or not oid:
        return _err("type 과 id 가 필요합니다.")

    # actor 필수 — report 는 요청자 가시성 게이트라 actor 없이는 항상 None 이다.
    resolved = ent.resolve_object(db, otype, oid, actor.user)
    if not resolved:
        return _err(f"객체를 찾을 수 없습니다: {otype}:{oid}")

    content = {
        "type": resolved.get("type"),
        "id": resolved.get("id"),
        "label": resolved.get("label"),
        "kind": resolved.get("kind_class"),
    }
    objs = [{"type": resolved.get("type"), "id": str(resolved.get("id")),
             "label": resolved.get("label")}]
    reports_prov = []

    # 수동 object_links(led_by=담당 PL, owned_by 등)는 entity·system 양쪽에 다 붙는다.
    # FK 에 없는 의미라 여기서 안 실으면 AI 는 담당 PL 을 영원히 못 본다(라우트는
    # object_ref_links 에서 이미 같은 병합을 한다).
    rels = _manual_link_summary(db, actor, otype, oid)

    if str(resolved.get("kind_class")) == "system":
        # system(report·user·dept) — FK 파생 관계를 실어 hop 노드가 되게 한다
        # (설계: system객체확장_user·report투영 §5.1).
        props = _system_properties(db, otype, oid)
        if props:
            content["properties"] = props
        rels += _derived_summary(db, actor, otype, oid)
        if otype == "report":
            reports_prov = _self_report_prov(db, oid)  # 근거 = 그 보고서 자신
    else:
        # entity(reference/record) 면 속성·관계·관련보고서까지.
        try:
            eid = int(oid)
        except (TypeError, ValueError):
            eid = None
        if eid is not None:
            row = ent.get_entity(db, eid)
            if row:
                content["properties"] = row.properties or {}
                rels += _relation_summary(db, eid)
                reps, reports_prov = _related_reports(db, actor, eid)
                content["reports"] = reps
    content["relations"] = rels[:_RELATIONS_LIMIT]
    return _ok(content, objects=objs, reports=reports_prov)


def _manual_link_summary(db: Session, actor, obj_type: str, obj_id: str) -> list:
    """수동 object_links(양방향) — compact 형태. 상대는 resolve_object 가 해석하므로
    report 상대는 가시성 게이트가 걸린다(권한 밖이면 None → 제외)."""
    outgoing, incoming = ent.list_object_links_for_ref(db, obj_type, obj_id)
    out = []
    for link, direction, o_type, o_id in (
        [(x, "out", x.dst_type, x.dst_id) for x in outgoing]
        + [(x, "in", x.src_type, x.src_id) for x in incoming]
    ):
        other = ent.resolve_object(db, o_type, o_id, actor.user)
        if not other:
            continue  # 삭제된 엔티티(고아 링크)·권한 밖 → 조용히 제외
        out.append({
            "relation": link.relation,
            "direction": direction,
            "object": {"type": other.get("type"), "id": other.get("id"),
                       "label": other.get("label")},
        })
        if len(out) >= _RELATIONS_LIMIT:
            break
    return out


# --------------------------------------------------------------------------- #
# get_subgraph — seed 주변 관계망을 한 콜로(get_object 반복 없이 여러 홉)
# --------------------------------------------------------------------------- #
def _exec_get_subgraph(db: Session, actor, args: dict) -> ToolResult:
    raw = args.get("entity_id")
    try:
        eid = int(raw)
    except (TypeError, ValueError):
        return _err("entity_id(정수)가 필요합니다. search_objects/get_object 가 준 id.")

    # seed 는 entity 만 — system 객체(report/user/dept)는 그래프 노드가 아니다.
    row = ent.get_entity(db, eid)
    if row is None:
        return _err(f"엔티티를 찾을 수 없습니다: {eid} (system 객체는 get_object 를 쓰세요).")

    relations = args.get("relations") or None
    try:
        depth = int(args.get("depth") or _SUBGRAPH_MAX_DEPTH)
    except (TypeError, ValueError):
        depth = _SUBGRAPH_MAX_DEPTH
    depth = max(1, min(depth, _SUBGRAPH_MAX_DEPTH))

    # 라우트(entity_subgraph)와 같은 조립 — 구조 CTE + object_links(부서·PL) augment.
    # active_only: 비관리자는 active 기준정보만(deprecated 제외).
    is_admin = bool(getattr(actor.user, "is_system_admin", False))
    data = ent_graph.subgraph(
        db, [eid], relations=relations, max_depth=depth, active_only=not is_admin,
    )
    ent.augment_graph_object_links(db, data, actor.user)

    nodes = data.get("nodes", [])
    edges = data.get("edges", [])
    # 크기 상한 — graph.subgraph 는 depth 로만 제한해 고차수 노드면 수백 개가 된다.
    # seed 는 반드시 남기고, 넘치면 자른 뒤 양 끝이 살아있는 엣지만 유지(dangling 제거).
    truncated = len(nodes) > _SUBGRAPH_MAX_NODES
    if truncated:
        kept, seen = [], set()
        for n in nodes:
            if n["id"] == eid or len(kept) < _SUBGRAPH_MAX_NODES:
                kept.append(n)
                seen.add(n["id"])
        nodes = kept
        edges = [e for e in edges if e["src"] in seen and e["dst"] in seen]

    out_nodes = [
        {"id": n["id"], "value": n.get("value"), "type": n.get("type_slug"),
         "kind": n.get("kind", "entity"), "degree": n.get("degree")}
        for n in nodes
    ]
    objs = [
        {"type": n.get("type_slug"), "id": str(n.get("ref_id", n["id"])),
         "label": n.get("value")}
        for n in nodes
    ]
    content = {
        "seed": eid, "depth": depth,
        "nodes": out_nodes, "edges": edges,
        "node_count": len(out_nodes), "edge_count": len(edges),
    }
    if truncated:
        content["truncated"] = True
        content["note"] = (
            f"노드가 {_SUBGRAPH_MAX_NODES}개를 넘어 잘렸습니다. relations 로 관계 종류를 "
            "좁히거나 depth 를 줄이거나, 특정 노드를 get_object 로 파고드세요."
        )
    return _ok(content, objects=objs)


def _derived_summary(db: Session, actor, obj_type: str, obj_id: str) -> list:
    """system 객체의 FK 파생 관계 — _relation_summary 와 같은 compact 형태(상한)."""
    out = []
    for link in ent.derived_links_for(db, actor.user, obj_type, obj_id):
        o = link.get("object") or {}
        out.append({
            "relation": link.get("relation"),
            "direction": link.get("direction"),
            "object": {"type": o.get("type"), "id": o.get("id"),
                       "label": o.get("label")},
        })
        if len(out) >= _RELATIONS_LIMIT:
            break
    return out


def _system_properties(db: Session, obj_type: str, obj_id: str) -> dict:
    """system 객체의 속성 — 원 테이블 컬럼을 온플라이로 투영(저장 0, 설계 §1).

    report 만 대상: reports 의 컬럼이 곧 속성이다. 호출 전 resolve_object 가 가시성을
    검증했으므로 여기선 다시 게이팅하지 않는다. user 는 이름 외 비노출(§6), dept 는
    라벨이 전부라 속성 없음.
    """
    if obj_type != "report":
        return {}
    from app.modules.reports.models import Report

    try:
        r = db.get(Report, int(obj_id))
    except (TypeError, ValueError):
        return {}
    if r is None:
        return {}
    props = {
        "report_date": r.report_date.isoformat() if r.report_date else None,
        "phase": getattr(r.phase, "value", r.phase),
        "lifecycle": getattr(r.lifecycle, "value", r.lifecycle),
        "report_type": r.report_type.name if r.report_type else None,
        "tags": list(r.tags or []),
    }
    return {k: v for k, v in props.items() if v not in (None, [], "")}


def _self_report_prov(db: Session, obj_id: str) -> list:
    """report 객체 자신을 인용 근거로. 호출 전 resolve_object 가 가시성을 이미 검증."""
    from app.modules.reports.models import Report

    try:
        r = db.get(Report, int(obj_id))
    except (TypeError, ValueError):
        return []
    if r is None:
        return []
    return [{"report_id": r.id, "title": r.title, "workspace_slug": r.workspace_slug}]


def _relation_summary(db: Session, entity_id: int) -> list:
    """이 엔티티의 관계를 방향·상대값과 함께 요약(상한)."""
    parents, children = ent.list_relations(db, entity_id=entity_id)
    out = []
    for r in parents:  # 이 값이 src
        o = ent.get_entity(db, r.dst_entity_id)
        if o:
            out.append({"relation": r.relation, "direction": "out",
                        "object": {"id": o.id, "value": o.value,
                                   "type": o.entity_type.slug if o.entity_type else None}})
        if len(out) >= _RELATIONS_LIMIT:
            return out
    for r in children:  # 이 값이 dst
        o = ent.get_entity(db, r.src_entity_id)
        if o:
            out.append({"relation": r.relation, "direction": "in",
                        "object": {"id": o.id, "value": o.value,
                                   "type": o.entity_type.slug if o.entity_type else None}})
        if len(out) >= _RELATIONS_LIMIT:
            break
    return out


def _related_reports(db: Session, actor, entity_id: int):
    """이 엔티티를 태깅한 보고서 중 요청자가 볼 수 있는 것(가시성 교집합)."""
    from app.modules.reports.services import all_visible_report_ids

    rows = ent.list_report_links_for_entity(db, entity_id=entity_id)
    visible = all_visible_report_ids(db, actor.user.id)
    reps, prov = [], []
    for r in rows:
        if r.id not in visible:
            continue
        reps.append({"report_id": r.id, "title": r.title,
                     "workspace_slug": r.workspace_slug})
        prov.append({"report_id": r.id, "title": r.title,
                     "workspace_slug": r.workspace_slug})
        if len(reps) >= _REPORTS_LIMIT:
            break
    return reps, prov


# --------------------------------------------------------------------------- #
# search_reports — 벡터 RAG(hybrid_search)를 도구화
# --------------------------------------------------------------------------- #
def _column_filters_from_args(db: Session, args: dict) -> Optional[dict]:
    """에이전트 도구 args 의 (B) 날짜/종류/작성자/단계 → column_filters dict.

    last_days/period/date_from/date_to(상대·명시 날짜) + report_type(이름)·author(이름)
    ·phase·lifecycle. structured_qa 의 해석 헬퍼를 재사용(이름→id, 못 풀면 그 필터만
    생략). 아무것도 없으면 None."""
    from app.ai import structured_qa
    from app.modules.reports.services import resolve_date_range

    cf: dict = {}
    try:
        last_days = int(args["last_days"]) if args.get("last_days") else None
    except (ValueError, TypeError):
        last_days = None
    d_from, d_to = resolve_date_range(
        date_from=structured_qa._iso_date(args.get("date_from")),
        date_to=structured_qa._iso_date(args.get("date_to")),
        last_days=last_days, period=(args.get("period") or None),
    )
    if d_from is not None or d_to is not None:
        cf["date_from"], cf["date_to"] = d_from, d_to
    rt = args.get("report_type")
    if isinstance(rt, str) and rt.strip():
        tid = structured_qa._resolve_report_type(db, rt)
        if tid is not None:
            cf["report_type_ids"] = [tid]
    au = args.get("author")
    if isinstance(au, str) and au.strip():
        uid = structured_qa._resolve_author(db, au)
        if uid is not None:
            cf["author_ids"] = [uid]
    if args.get("phase") in ("drafting", "reviewing", "finalized"):
        cf["phases"] = [args["phase"]]
    if args.get("lifecycle") in ("single_shot", "ongoing"):
        cf["lifecycles"] = [args["lifecycle"]]
    return cf or None


def _exec_search_reports(db: Session, actor, args: dict) -> ToolResult:
    query = (args.get("query") or "").strip()
    if not query:
        return _err("query 가 필요합니다.")
    limit = min(int(args.get("limit") or _REPORTS_LIMIT), _REPORTS_LIMIT)
    cf = _column_filters_from_args(db, args)
    hits = ai_search.hybrid_search(
        db, query, actor, limit=limit, snippet_chars=300, column_filters=cf
    )
    rows, prov = [], []
    for h in hits:
        rows.append({"report_id": h["report_id"], "title": h.get("title"),
                     "snippet": h.get("snippet")})
        prov.append({"report_id": h["report_id"], "title": h.get("title"),
                     "workspace_slug": h.get("workspace_slug"),
                     "block_id": h.get("block_id"), "page_idx": h.get("page_idx"),
                     "snippet": h.get("snippet")})  # 근거 검증(_verify)용 본문 텍스트
    return _ok({"reports": rows, "count": len(rows)}, reports=prov)


# --------------------------------------------------------------------------- #
# aggregate_reports — 보고서-태깅 기준 집계(개수는 계산). structured_qa 재사용.
# --------------------------------------------------------------------------- #
_AGG_PREVIEW = 30
_AGG_CITE = 8


def _exec_aggregate_reports(db: Session, actor, args: dict) -> ToolResult:
    from app.ai import structured_qa

    filters = [str(x) for x in (args.get("filters") or []) if str(x).strip()]
    target = (args.get("target") or "report").strip() or "report"
    year = args.get("year")
    cf = _column_filters_from_args(db, args)
    agg = structured_qa.aggregate(db, actor, filters, year, target, column_filters=cf)
    if agg is None:
        return _err("조건(필터/타깃)을 온톨로지 객체로 해석하지 못했습니다. "
                    "list_object_types 로 타입·값을 확인하거나 search_reports 를 쓰세요.")
    values = agg["values"]
    prov = []
    if agg["report_ids"]:
        from sqlalchemy import select as _sel

        from app.modules.reports.models import Report as _R
        rid_cut = agg["report_ids"][:_AGG_CITE]
        meta = {
            rid: (title, slug) for rid, title, slug in db.execute(
                _sel(_R.id, _R.title, _R.workspace_slug).where(_R.id.in_(rid_cut))
            ).all()
        }
        prov = [{"report_id": rid, "title": meta.get(rid, (None, None))[0],
                 "workspace_slug": meta.get(rid, (None, None))[1]} for rid in rid_cut]
    return _ok({
        "count": agg["count"],
        "target": agg["target_label"],
        "unit": agg["unit"],
        "filters": agg["filters"],
        "year": agg["year"],
        "values": values[:_AGG_PREVIEW],
        "values_truncated": len(values) > _AGG_PREVIEW,
        "note": "볼 수 있는 보고서 기준. 개수는 계산된 값.",
    }, reports=prov)


# --------------------------------------------------------------------------- #
# 카탈로그 — 스키마 + dispatch
# --------------------------------------------------------------------------- #
# (B) 날짜/종류/작성자/단계 필터 — search_reports·aggregate_reports 공용 스키마 조각.
_FILTER_PROPS = {
    "last_days": {"type": "integer",
                  "description": "최근 N일([오늘-(N-1),오늘]). '최근 일주일'=7(선택)."},
    "period": {"type": "string",
               "description": "상대 기간 today|yesterday|this_week|this_month|this_year(선택)."},
    "date_from": {"type": "string", "description": "날짜범위 시작 YYYY-MM-DD(선택)."},
    "date_to": {"type": "string", "description": "날짜범위 끝 YYYY-MM-DD(선택)."},
    "report_type": {"type": "string", "description": "보고서 종류 이름 예:'주간보고'(선택)."},
    "author": {"type": "string", "description": "작성자 사람 이름(선택)."},
    "phase": {"type": "string",
              "description": "협업 단계 drafting|reviewing|finalized(선택)."},
    "lifecycle": {"type": "string", "description": "진행 상태 single_shot|ongoing(선택)."},
}


def _fn(name, description, properties, required=None) -> dict:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": properties,
                "required": required or [],
            },
        },
    }


_PROP_FILTER = {
    "type": "array",
    "description": "속성 필터. 각 원소 {key, op, value}. op: eq|gte|lte|between|contains.",
    "items": {
        "type": "object",
        "properties": {
            "key": {"type": "string"},
            "op": {"type": "string"},
            "value": {},
        },
        "required": ["key", "value"],
    },
}
_REL_FILTER = {
    "type": "array",
    "description": "관계 필터. 각 원소 {relation, dst_id} — 이 관계로 dst_id 객체와 연결된 것만. "
                   "dst_id 는 get_object 가 준 id: 엔티티·사용자는 정수 문자열('42'), "
                   "부서는 slug('cae').",
    "items": {
        "type": "object",
        "properties": {
            "relation": {"type": "string"},
            # 정수만 받으면 부서(slug) 대상을 표현할 수 없다 — ObjectRef id 는 varchar.
            "dst_id": {"type": ["integer", "string"]},
        },
        "required": ["relation", "dst_id"],
    },
}

# system 축 취급 규칙 — LLM 이 틀리기 쉬운 지점이라 도구 설명에 직접 박는다. report·
# user·dept 는 entities 값 행이 없는 투영 객체라 search_objects 로는 구조적으로 0건이다.
_SYSTEM_RULE = (
    " ※ report·user·dept 는 값 목록이 없는 '투영 객체'라 search_objects 로 찾을 수 없다 — "
    "보고서 찾기는 search_reports, 이미 아는 대상의 상세·관계는 get_object 를 쓰라."
)

# (스키마, executor) — 이름 순.
_CATALOG = {
    "list_object_types": (
        _fn(
            "list_object_types",
            "온톨로지 지도. 검색 가능한 객체 종류(타입)와 각 타입의 속성 key·데이터타입"
            "(enum이면 허용값)·관계 종류를 반환한다. 다른 도구로 쿼리를 만들기 전에 먼저 호출해 "
            "어휘(타입 slug·속성 key·관계 slug)를 확인하라." + _SYSTEM_RULE,
            {},
        ),
        _exec_list_object_types,
    ),
    "search_objects": (
        _fn(
            "search_objects",
            "타입+속성+관계로 온톨로지 객체를 검색한다(결정적 필터). 예: 특정 종류 중 "
            "속성이 조건에 맞거나 특정 객체와 관계된 것. 반환: 객체 목록(id·값·속성) + 총건수."
            + _SYSTEM_RULE,
            {
                "type": {"type": "string", "description": "객체 종류 slug(list_object_types 참고). "
                                                          "report·user·dept 는 불가."},
                "q": {"type": "string", "description": "이름/코드/설명 부분검색(선택)."},
                "props": _PROP_FILTER,
                "relations": _REL_FILTER,
                "year": {"type": "integer", "description": "자료연도(선택)."},
                "limit": {"type": "integer"},
            },
        ),
        _exec_search_objects,
    ),
    "get_object": (
        _fn(
            "get_object",
            "객체 하나의 프로필 — 속성, 연결된 객체(관계 방향·상대), 이 객체를 근거로 하는 "
            "보고서(권한 내). type 과 id 로 지목한다(search_objects 결과의 type·id). "
            "report·user·dept 도 지원한다 — 보고서의 작성자·게시부서·다룬 객체, 사용자의 "
            "소속부서·작성 보고서 같은 관계를 타고 이어서 조사할 수 있다(권한 내).",
            {
                "type": {"type": "string"},
                "id": {"type": "string"},
            },
            required=["type", "id"],
        ),
        _exec_get_object,
    ),
    "get_subgraph": (
        _fn(
            "get_subgraph",
            "한 엔티티 주변의 관계망(노드+엣지)을 한 번에 가져온다 — 관계를 여러 홉 타는 "
            "구조 조사를 get_object 반복 없이 끝낼 때 쓴다. 부서·담당 PL 같은 연결 객체도 "
            "1홉 얹힌다. 각 노드의 degree 는 화면 밖 이웃 수(크면 그쪽을 더 파볼 것). "
            "seed 는 **엔티티만**(report·user·dept 는 노드가 아니라 get_object 로 조사). "
            "노드가 많으면 잘리고 truncated 로 알린다 — relations 로 좁히거나 depth 를 줄여라.",
            {
                "entity_id": {"type": "integer",
                              "description": "중심 엔티티 id(search_objects/get_object 가 준 정수)."},
                "relations": {"type": "array", "items": {"type": "string"},
                              "description": "따라갈 관계 slug 제한(미지정=전체, 선택)."},
                "depth": {"type": "integer",
                          "description": f"홉 깊이(1~{_SUBGRAPH_MAX_DEPTH}, 기본 {_SUBGRAPH_MAX_DEPTH})."},
            },
            required=["entity_id"],
        ),
        _exec_get_subgraph,
    ),
    "search_reports": (
        _fn(
            "search_reports",
            "보고서 본문을 의미+키워드로 검색한다(텍스트 근거). 객체 구조로 답이 안 나오는 "
            "서술형·정성 질문이나, 객체의 근거 문서를 찾을 때 사용. '최근 일주일 작성' 같은 "
            "날짜·작성자·종류·단계 조건을 함께 걸 수 있다(선택 인자). 반환: 관련 보고서 발췌.",
            {
                "query": {"type": "string"},
                "limit": {"type": "integer"},
                **_FILTER_PROPS,
            },
            required=["query"],
        ),
        _exec_search_reports,
    ),
    "aggregate_reports": (
        _fn(
            "aggregate_reports",
            "조건에 해당하는 보고서(또는 그 보고서에 태깅된 객체)의 **개수·목록**을 "
            "센다 — search_objects 가 객체 자체 속성으로 세는 것과 달리, 이건 '어떤 "
            "값들로 태깅된 보고서'를 기준으로 센다(예: '낙하시험'과 '실패'로 태깅된 "
            "보고서에 나온 '과제'). 개수는 계산값(정확), 볼 수 있는 보고서만. "
            "filters=조건 값들(예: [\"낙하시험\",\"실패\"]), target=셀 대상('report' "
            "또는 축 slug), year=연도(선택). 날짜(last_days/period/date_from·to)·작성자"
            "(author)·종류(report_type)·단계(phase)로도 조건을 걸 수 있다.",
            {
                "filters": {
                    "type": "array", "items": {"type": "string"},
                    "description": "조건 값들(태깅). 서로 다른 축은 AND. 날짜/작성자 조건만 "
                                   "있으면 빈 배열 [] 가능.",
                },
                "target": {
                    "type": "string",
                    "description": "셀 대상: 'report'(기본) 또는 축 slug(그 축의 값 개수).",
                },
                "year": {"type": "integer", "description": "자료연도(선택)."},
                **_FILTER_PROPS,
            },
            required=["filters"],
        ),
        _exec_aggregate_reports,
    ),
}

# LLM 에 넘길 스키마 목록.
TOOL_SCHEMAS = [schema for schema, _ in _CATALOG.values()]


def run_tool(db: Session, actor, name: str, args: dict) -> ToolResult:
    """이름으로 도구 실행. 알 수 없는 이름은 error content(LLM 이 복구하게)."""
    entry = _CATALOG.get(name)
    if not entry:
        return _err(f"알 수 없는 도구: {name!r}")
    _, executor = entry
    return executor(db, actor, args or {})
