"""엔티티 그래프 트래버설 — 재귀 CTE 기반 (D-2).

`entity_relations`(엣지) 위에서 다중 관계 종류·양방향·가변 깊이 순회를 한 곳에
모은다. **이 모듈의 공개 시그니처가 안정 계약**이다(엔티티그래프_온톨로지_설계.md
§4 "전환 경계"): 지금 구현은 Postgres 재귀 CTE, 나중에 그래프DB(Apache AGE)로
전환하면 **이 모듈 내부만** Cypher 로 교체하고 호출부(서비스·라우트·프론트)는
그대로 둔다.

방향 규약(part_of 기준: src=자식 --part_of--> dst=부모):
  - direction='in'  : dst∈frontier → src 수집 = 부모에서 자식(자손)으로 내려감.
  - direction='out' : src∈frontier → dst 수집 = 자식에서 부모(조상)로 올라감.
  - direction='both': 양쪽 합집합.

권한(가시성)은 여기서 다루지 않는다 — 그래프는 순수 구조만. 보고서 가시성
교집합은 상위(reports 검색)에서 적용한다(semantic_search 패턴).
"""
from __future__ import annotations

from typing import Iterable, Optional

import sqlalchemy as sa
from sqlalchemy import literal, select
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Session

from app.modules.entities.models import (
    Entity,
    EntityRelation,
    EntityStatus,
    EntityType,
)

# 깊이 상한 — 사이클/폭주 가드(acyclic 타입은 순환이 없지만, 비acyclic·손상 데이터
# 에서도 안전하게 종료하도록 모든 CTE 가 depth < max_depth 로 멈춘다).
_DEFAULT_MAX_DEPTH = 20


def _dir_cols(direction: str):
    """순회 방향에 따른 (매칭 컬럼, 다음 컬럼). 매칭=frontier 와 비교할 끝,
    다음=수집해 다음 frontier 가 될 끝."""
    if direction == "in":
        return EntityRelation.dst_entity_id, EntityRelation.src_entity_id
    if direction == "out":
        return EntityRelation.src_entity_id, EntityRelation.dst_entity_id
    raise ValueError(f"direction 은 'in'|'out' 이어야 합니다: {direction!r}")


def _reachable_one_dir(
    db: Session,
    start_ids: list[int],
    *,
    relations: Optional[list[str]],
    direction: str,
    max_depth: int,
    active_only: bool = False,
) -> set[int]:
    """한 방향 재귀 CTE. start 에서 도달 가능한 노드 집합(start 자신 제외).
    active_only 면 deprecated 엔티티를 거치지 않는다(일반 사용자 노출용)."""
    match_col, next_col = _dir_cols(direction)

    # 시드 frontier = start_ids(depth 0). PG 배열을 unnest 해 행으로 편다.
    seed = select(
        sa.func.unnest(literal(start_ids, type_=ARRAY(sa.Integer))).label("node"),
        literal(0).label("depth"),
    )
    trav = seed.cte("trav", recursive=True)

    step = (
        select(next_col.label("node"), (trav.c.depth + 1).label("depth"))
        .select_from(EntityRelation)
        .join(trav, match_col == trav.c.node)
        .where(trav.c.depth < max_depth)
    )
    if relations:
        step = step.where(EntityRelation.relation.in_(relations))
    if active_only:
        step = step.where(next_col.in_(_active_entity_ids()))
    trav = trav.union_all(step)

    rows = db.execute(select(trav.c.node).distinct()).all()
    return {r[0] for r in rows} - set(start_ids)


def _active_entity_ids():
    """active 상태 엔티티 id 의 스칼라 서브쿼리 — 재귀 step 의 `next.in_(...)`
    필터로 써서 deprecated 노드로는 한 hop 도 넘어가지 않게 한다."""
    return select(Entity.id).where(Entity.status == EntityStatus.active)


def _reachable_undirected(
    db: Session,
    start_ids: list[int],
    *,
    relations: Optional[list[str]],
    max_depth: int,
    active_only: bool = False,
) -> set[int]:
    """무방향 재귀 CTE — 매 hop 마다 엣지를 양방향 어느 쪽으로든 따라간다(혼합 경로).
    서브그래프/AI 컨텍스트처럼 '이 노드 주변 N hop 전부'가 필요할 때(방향 무관).
    direction 'in'/'out' 의 합집합(순수 방향)과 달리 model→(in)part→(out)test 같은
    꺾이는 경로도 도달한다."""
    er = EntityRelation
    seed = select(
        sa.func.unnest(literal(start_ids, type_=ARRAY(sa.Integer))).label("node"),
        literal(0).label("depth"),
    )
    trav = seed.cte("trav_u", recursive=True)
    # 다음 노드 = 현재 노드의 반대편 끝.
    next_node = sa.case(
        (er.src_entity_id == trav.c.node, er.dst_entity_id),
        else_=er.src_entity_id,
    )
    step = (
        select(next_node.label("node"), (trav.c.depth + 1).label("depth"))
        .select_from(er)
        .join(
            trav,
            sa.or_(er.src_entity_id == trav.c.node, er.dst_entity_id == trav.c.node),
        )
        .where(trav.c.depth < max_depth)
    )
    if relations:
        step = step.where(er.relation.in_(relations))
    if active_only:
        step = step.where(next_node.in_(_active_entity_ids()))
    trav = trav.union_all(step)
    rows = db.execute(select(trav.c.node).distinct()).all()
    return {r[0] for r in rows} - set(start_ids)


def reachable(
    db: Session,
    start_ids: Iterable[int],
    *,
    relations: Optional[list[str]] = None,
    direction: str = "in",
    max_depth: int = _DEFAULT_MAX_DEPTH,
    active_only: bool = False,
) -> set[int]:
    """start_ids 에서 주어진 관계(들)를 따라 도달하는 모든 엔티티 id(start 제외).

    relations=None 이면 모든 관계 종류를 따라간다. direction:
      - 'in'/'out' : 순수 방향(롤업=자손, 조상 등). 매 hop 같은 방향만.
      - 'both'     : 무방향(엣지를 어느 쪽으로든) — 꺾이는 경로 포함, 서브그래프용.
    active_only=True 면 deprecated 엔티티는 거치지도 수집하지도 않는다.
    재귀 CTE 한 방으로 — Python BFS 보다 라운드트립이 적다.
    """
    ids = sorted({int(x) for x in start_ids})
    if not ids:
        return set()
    if direction == "both":
        return _reachable_undirected(
            db, ids, relations=relations, max_depth=max_depth,
            active_only=active_only,
        )
    return _reachable_one_dir(
        db, ids, relations=relations, direction=direction, max_depth=max_depth,
        active_only=active_only,
    )


def neighbors(
    db: Session,
    entity_id: int,
    *,
    relations: Optional[list[str]] = None,
    direction: str = "both",
) -> set[int]:
    """1-hop 이웃 id. (트래버설 없이 단순 인접 조회 — picker 좁힘 등.)"""
    out: set[int] = set()
    if direction in ("out", "both"):
        q = select(EntityRelation.dst_entity_id).where(
            EntityRelation.src_entity_id == entity_id
        )
        if relations:
            q = q.where(EntityRelation.relation.in_(relations))
        out |= {r[0] for r in db.execute(q).all()}
    if direction in ("in", "both"):
        q = select(EntityRelation.src_entity_id).where(
            EntityRelation.dst_entity_id == entity_id
        )
        if relations:
            q = q.where(EntityRelation.relation.in_(relations))
        out |= {r[0] for r in db.execute(q).all()}
    return out


def subgraph(
    db: Session,
    seed_ids: Iterable[int],
    *,
    relations: Optional[list[str]] = None,
    max_depth: int = 2,
    active_only: bool = False,
) -> dict:
    """seed 주변 서브그래프(노드+엣지). 관계도 시각화·AI(GraphRAG) 컨텍스트용.

    노드 = seed ∪ 양방향 도달분, 엣지 = 그 노드 집합 안에서 끝이 양쪽 다 들어오는
    entity_relations. 노드엔 표시 메타(value, type_slug)를 동봉한다.
    active_only=True(일반 사용자)면 deprecated 노드를 거치지 않아 active 분만 보인다
    — seed 자신은 deprecated 라도 중심으로 남는다(라우트가 진입 보장).
    반환: {"nodes": [{id,value,type_slug,type_id}], "edges": [{src,dst,relation}]}
    """
    seeds = sorted({int(x) for x in seed_ids})
    if not seeds:
        return {"nodes": [], "edges": []}
    node_ids = set(seeds) | reachable(
        db, seeds, relations=relations, direction="both", max_depth=max_depth,
        active_only=active_only,
    )

    # 노드 메타.
    nrows = db.execute(
        select(Entity.id, Entity.value, Entity.type_id, EntityType.slug)
        .join(EntityType, EntityType.id == Entity.type_id)
        .where(Entity.id.in_(node_ids))
    ).all()
    nodes = [
        {"id": i, "value": v, "type_id": t, "type_slug": s}
        for (i, v, t, s) in nrows
    ]

    # 엣지 — 양 끝이 모두 node_ids 안인 것만(내부 간선).
    eq = select(
        EntityRelation.src_entity_id,
        EntityRelation.dst_entity_id,
        EntityRelation.relation,
    ).where(
        EntityRelation.src_entity_id.in_(node_ids),
        EntityRelation.dst_entity_id.in_(node_ids),
    )
    if relations:
        eq = eq.where(EntityRelation.relation.in_(relations))
    edges = [
        {"src": s, "dst": d, "relation": rel}
        for (s, d, rel) in db.execute(eq).all()
    ]
    return {"nodes": nodes, "edges": edges}
