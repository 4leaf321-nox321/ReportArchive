"""의존성 레지스트리 — "무엇이 이 대상(부서 slug / 계정 id)을 참조하는가" 를
한 곳에서 만든다.

배경(조직개편·계정삭제_설계.md §3): 부서/계정 삭제 시 RESTRICT FK 가 남아 있으면
`db.commit()` 이 `IntegrityError` 로 터지는데, 어떤 테이블이 대상을 참조하는지가
삭제 검사 함수 안에 하드코딩돼 있어 새 테이블 추가를 못 따라간다(부서 삭제 500 버그
의 원인 — files/html_embed_bundles/composite_reports 누락). 이 목록을 두 소스로
자동/명시 수집한다:

1. **FK 자동수집** — `Base.metadata` 를 훑어 대상 컬럼을 가리키는 모든 ForeignKey 를
   찾는다. 새 테이블이 대상을 FK 로 참조하면 코드 수정 없이 자동 편입된다.
2. **FK 없는 참조 수동보충** — 메타데이터로 못 찾는 것(배열 컬럼·다형 참조)이나,
   FK 는 CASCADE 라 DB 는 막지 않지만 정책상 삭제를 거부하고 싶은 것(예: 멤버가
   남은 부서). 호출부가 명시 등록한다.

`ondelete` 가 RESTRICT / NO ACTION(미지정) 이면 DB 가 삭제를 **차단**한다. CASCADE /
SET NULL 은 자동 처리돼 안전하므로 blocker 로 세지 않는다.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from sqlalchemy import Table, func, select
from sqlalchemy.orm import Session

from app.database import Base

# ondelete 값 중 DB 가 삭제를 막는 것(대문자 정규화 기준). None(미지정)은 Postgres
# 기본 NO ACTION 이라 차단으로 취급한다.
_BLOCKING_FK_ONDELETE = {"RESTRICT", "NO ACTION"}


@dataclass(frozen=True)
class Dependent:
    """대상을 참조하는 한 종류의 항목."""

    key: str  # 응답 dict 의 안정적 키(프론트가 라벨 매핑에 사용)
    label: str  # 사람이 읽는 이름(한국어)
    blocks: bool  # True 면 이 항목이 남아 있을 때 삭제 거부
    count: Callable[[Session, object], int]  # (db, target_key) -> 행 수
    detail: str = ""  # ondelete 종류 등 디버그용


def _make_fk_counter(table: Table, local_col) -> Callable[[Session, object], int]:
    def _count(db: Session, target_key) -> int:
        stmt = select(func.count()).select_from(table).where(local_col == target_key)
        return int(db.execute(stmt).scalar() or 0)

    return _count


def fk_blocking_dependents(
    target_table: str,
    target_col: str,
    labels: dict[tuple[str, str], tuple[str, str]] | None = None,
) -> list[Dependent]:
    """`Base.metadata` 에서 `target_table.target_col` 을 참조하는 FK 중 **삭제를
    차단**(RESTRICT/NO ACTION)하는 것만 Dependent 로 수집한다.

    labels: (table_name, local_col_name) -> (key, label) 매핑. 없으면 테이블명을
    키·라벨로 쓴다(자기참조는 target_table 그대로라 라벨을 반드시 넘길 것).
    """
    labels = labels or {}
    out: list[Dependent] = []
    for table in Base.metadata.tables.values():
        for fk in table.foreign_keys:
            ref = fk.column  # 참조되는 컬럼(대상)
            if ref.table.name != target_table or ref.name != target_col:
                continue
            ondelete = (fk.ondelete or "NO ACTION").upper()
            if ondelete not in _BLOCKING_FK_ONDELETE:
                continue  # CASCADE / SET NULL 은 자동 안전 → blocker 아님
            local_col = fk.parent
            ident = (table.name, local_col.name)
            key, label = labels.get(ident, (table.name, table.name))
            out.append(
                Dependent(
                    key=key,
                    label=label,
                    blocks=True,
                    count=_make_fk_counter(table, local_col),
                    detail=ondelete,
                )
            )
    # 결정적 순서(테스트·표시 안정)
    out.sort(key=lambda d: d.key)
    return out


def count_blockers(
    db: Session, dependents: list[Dependent], target_key
) -> dict[str, int]:
    """차단(blocks=True) 항목별 행 수를 {key: count} 로. 하나라도 >0 이면 삭제 거부."""
    return {
        d.key: d.count(db, target_key) for d in dependents if d.blocks
    }
