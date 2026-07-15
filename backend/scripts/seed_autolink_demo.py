"""자동 연결(규칙 기반 관계) 데모 시드 — 로컬 dev DB.

과제통칭(A35…) + 과제(A35-G…) 두 축과 소속 관계 종류를 만들고 값을 넣는다.
멱등: 이미 있으면 재사용. 실행: venv/bin/python scripts/seed_autolink_demo.py
"""
from __future__ import annotations

from app.database import SessionLocal
from app.modules.entities import services as ent
from app.modules.entities.schemas import (
    EntityCreate,
    EntityTypeCreate,
    RelationTypeCreate,
)

FAMILY_SLUG = "project_family"
CASE_SLUG = "project_case"
REL_SLUG = "belongs_to_family"

FAMILIES = ["A35", "A40", "B10"]
CASES = ["A35-G", "A35-F", "A40-S", "A40-T", "B10-X", "C99-Z"]  # C99-Z=매칭 없음


def ensure_axis(db, slug, label):
    row = ent.get_type_by_slug(db, slug)
    if row:
        return row
    return ent.create_type(db, EntityTypeCreate(slug=slug, label=label))


def ensure_rel(db, slug, label, src, dst):
    row = ent.get_relation_type(db, slug)
    if row:
        return row
    return ent.create_relation_type(
        db,
        RelationTypeCreate(
            slug=slug,
            label=label,
            inverse_label="소속 과제",
            src_axis_slugs=[src],
            dst_axis_slugs=[dst],
        ),
    )


def ensure_value(db, type_id, value):
    return ent.create_entity(
        db, EntityCreate(type_id=type_id, value=value), creator_user_id=None
    )


def main():
    db = SessionLocal()
    try:
        fam = ensure_axis(db, FAMILY_SLUG, "과제 통칭")
        case = ensure_axis(db, CASE_SLUG, "과제")
        rel = ensure_rel(db, REL_SLUG, "소속 통칭", CASE_SLUG, FAMILY_SLUG)
        for v in FAMILIES:
            ensure_value(db, fam.id, v)
        for v in CASES:
            ensure_value(db, case.id, v)
        print(f"과제 통칭(축 id={fam.id}): {', '.join(FAMILIES)}")
        print(f"과제(축 id={case.id}): {', '.join(CASES)}")
        print(f"관계 종류: {rel.label} ({rel.slug}) — 과제 → 과제 통칭")
        print("완료. 엔티티 관리 → '과제' 축 → '자동 연결'에서 대상=과제 통칭,")
        print("관계=소속 통칭, 규칙=접두어(또는 구분자 '-')로 시도해보세요.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
