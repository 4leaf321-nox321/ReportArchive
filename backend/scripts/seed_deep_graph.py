"""깊은 온톨로지 그래프 샘플 시드 (관계도 3D 확장 탐색 실측용).

문제: 기존 샘플은 관계 사슬이 얕아(대부분 2 hop) 관계도에서 노드를 "이웃 확장"
해도 depth 4+ 로 뻗어 나가는 케이스가 없다. 이 스크립트는 전기차 플랫폼을 소재로
**깊게 중첩된 BOM(part_of 사슬)** 과 각 층의 **횡단 관계**(시험·해석·불량·공급사·
인시던트)를 심어, 어느 노드에서 확장해도 계속 이웃이 나오는 짙은 그래프를 만든다.

멱등: 엔티티는 create_entity(=get-or-create), 관계는 add_relation(=중복 무시).
여러 번 돌려도 안전. 실행:  python scripts/seed_deep_graph.py
"""
from __future__ import annotations

import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from sqlalchemy import select

from app.database import SessionLocal
from app.modules.entities import services as ent_svc
from app.modules.entities.models import Entity, EntityType, User
from app.modules.entities.schemas import EntityCreate

CREATOR_ID = 1  # admin

# ── 축 slug → id 캐시 ────────────────────────────────────────────────
_type_ids: dict[str, int] = {}
_cache: dict[tuple[str, str], Entity] = {}


def _load_types(db):
    for t in db.execute(select(EntityType)).scalars():
        _type_ids[t.slug] = t.id


def ent(db, type_slug: str, value: str, *, code=None, desc="") -> Entity:
    """(축, 값) get-or-create. 같은 실행 안에서는 캐시."""
    key = (type_slug, value)
    if key in _cache:
        return _cache[key]
    tid = _type_ids.get(type_slug)
    if tid is None:
        raise SystemExit(f"축을 찾을 수 없습니다: {type_slug}")
    row = ent_svc.create_entity(
        db,
        EntityCreate(type_id=tid, value=value, code=code, description=desc),
        creator_user_id=CREATOR_ID,
    )
    _cache[key] = row
    return row


def rel(db, src: Entity, dst: Entity, relation: str):
    """src --relation--> dst. 축 제약/중복/순환은 서비스가 검증(멱등)."""
    try:
        ent_svc.add_relation(
            db, src=src, dst=dst, relation=relation, creator_user_id=CREATOR_ID
        )
    except ValueError as e:
        # 축 제약 위반 등은 데이터 설계 실수 → 바로 드러나게 출력.
        print(f"  ! {src.value} --{relation}--> {dst.value}: {e}")


def build(db):
    _load_types(db)
    admin = db.get(User, CREATOR_ID)
    if admin is None:
        raise SystemExit("admin(id=1) 사용자가 없습니다. seed_initial_data 먼저 실행.")

    # ── 1) 플랫폼 & 파생 모델(model↔model) ──────────────────────────
    egmp = ent(db, "model", "E-GMP 플랫폼", desc="전용 전기차 플랫폼")
    egmp2 = ent(db, "model", "E-GMP 2세대", desc="차세대 플랫폼")
    rel(db, egmp2, egmp, "supersedes")  # 2세대가 1세대를 대체
    for v in ["EV6", "EV9", "IONIQ 5", "GV60"]:
        m = ent(db, "model", v, desc="E-GMP 기반 양산 모델")
        rel(db, m, egmp, "variant_of")

    # ── 2) 깊은 BOM 중첩(part_of 사슬) — 배터리 시스템 ────────────────
    #   플랫폼 ← 팩 ← 모듈 ← 셀 ← 양극재 ← 전구체  (platform 기준 depth 5)
    pack = ent(db, "part", "배터리 팩 어셈블리", desc="고전압 배터리 팩")
    module = ent(db, "part", "배터리 모듈", desc="셀 집합 모듈")
    cell = ent(db, "part", "배터리 셀", desc="파우치형 리튬이온 셀")
    cathode = ent(db, "part", "양극재", desc="NCM 양극 활물질")
    precursor = ent(db, "part", "니켈 전구체", desc="전구체 원소재")
    rel(db, pack, egmp, "part_of")
    rel(db, module, pack, "part_of")
    rel(db, cell, module, "part_of")
    rel(db, cathode, cell, "part_of")
    rel(db, precursor, cathode, "part_of")

    #   팩의 다른 하위 사슬(냉각계) — 폭도 넓힌다.
    cooling = ent(db, "part", "냉각 시스템", desc="배터리 열관리")
    plate = ent(db, "part", "쿨링 플레이트", desc="알루미늄 냉각판")
    coolant = ent(db, "part", "냉각수", desc="부동액 기반 냉각수")
    rel(db, cooling, pack, "part_of")
    rel(db, plate, cooling, "part_of")
    rel(db, coolant, cooling, "part_of")

    #   모듈의 다른 하위(BMS) — MCU 칩까지.
    bms = ent(db, "part", "BMS 보드", desc="배터리 관리 시스템 보드")
    mcu = ent(db, "part", "MCU 칩", desc="차량용 마이크로컨트롤러")
    fw = ent(db, "bom", "BMS-FW-0417", desc="BMS 펌웨어 BOM")
    rel(db, bms, module, "part_of")
    rel(db, mcu, bms, "part_of")
    rel(db, fw, bms, "part_of")  # bom part_of part

    # ── 3) 두 번째 깊은 사슬 — 구동 모터(플랫폼 공유로 상호연결) ──────
    motor = ent(db, "part", "구동 모터 어셈블리", desc="후륜 구동 모터")
    stator = ent(db, "part", "고정자", desc="모터 스테이터")
    winding = ent(db, "part", "권선 코일", desc="헤어핀 권선")
    copper = ent(db, "part", "구리 소재", desc="전기동 소재")
    inverter = ent(db, "part", "인버터", desc="전력 변환 인버터")
    igbt = ent(db, "part", "IGBT 모듈", desc="전력 반도체")
    rel(db, motor, egmp, "part_of")
    rel(db, stator, motor, "part_of")
    rel(db, winding, stator, "part_of")
    rel(db, copper, winding, "part_of")
    rel(db, inverter, motor, "part_of")
    rel(db, igbt, inverter, "part_of")

    # ── 4) 공급사(supplied_by) — 사슬 말단을 더 밀어냄 ────────────────
    suppliers = {
        precursor: "코발트프리 소재㈜",
        cathode: "케이양극재㈜",
        cell: "델타셀㈜",
        mcu: "오토칩반도체㈜",
        igbt: "파워세미㈜",
        copper: "동성금속㈜",
        coolant: "케미쿨㈜",
    }
    for part, sup_name in suppliers.items():
        sup = ent(db, "supplier", sup_name)
        rel(db, part, sup, "supplied_by")

    # ── 5) 시험/해석/불량/단계(횡단 관계로 폭 + 깊이) ─────────────────
    #   각 부품 tested_by rel_test, simulated_by sim_type, has_defect defect.
    t_vib = ent(db, "rel_test", "진동 내구 시험")
    t_therm = ent(db, "rel_test", "열충격 시험")
    t_cycle = ent(db, "rel_test", "충방전 수명 시험")
    s_thermal = ent(db, "sim_type", "열유동 해석")
    s_struct = ent(db, "sim_type", "구조 강성 해석")
    s_emag = ent(db, "sim_type", "전자기 해석")
    rel(db, cell, t_cycle, "tested_by")
    rel(db, cell, t_therm, "tested_by")
    rel(db, module, t_vib, "tested_by")
    rel(db, motor, t_vib, "tested_by")
    rel(db, pack, s_thermal, "simulated_by")
    rel(db, plate, s_thermal, "simulated_by")
    rel(db, stator, s_emag, "simulated_by")
    rel(db, module, s_struct, "simulated_by")

    #   불량 → 발생 단계(defect --occurs_at--> phase): 사슬을 phase 까지.
    ph_dev = ent(db, "phase", "개발")
    ph_pilot = ent(db, "phase", "파일럿")
    ph_mp = ent(db, "phase", "양산")
    d_plating = ent(db, "defect", "리튬 석출")
    d_swell = ent(db, "defect", "셀 스웰링")
    d_short = ent(db, "defect", "권선 단락")
    d_over = ent(db, "defect", "인버터 과열")
    rel(db, cell, d_plating, "has_defect")
    rel(db, cell, d_swell, "has_defect")
    rel(db, winding, d_short, "has_defect")
    rel(db, inverter, d_over, "has_defect")
    rel(db, d_plating, ph_mp, "occurs_at")
    rel(db, d_swell, ph_pilot, "occurs_at")
    rel(db, d_short, ph_dev, "occurs_at")
    rel(db, d_over, ph_pilot, "occurs_at")

    # ── 6) 인시던트(incident --caused_by--> part|defect) ─────────────
    inc_fire = ent(db, "incident", "필드 화재 리콜 A", desc="주차 중 발화 신고")
    inc_derate = ent(db, "incident", "출력 제한 클레임", desc="고온 주행 출력 저하")
    rel(db, inc_fire, cell, "caused_by")
    rel(db, inc_fire, d_plating, "caused_by")
    rel(db, inc_derate, inverter, "caused_by")
    rel(db, inc_derate, d_over, "caused_by")

    # ── 7) 시험 실행(test_run --tested--> part) & 과제(project) ───────
    tr1 = ent(db, "test_run", "TR-2026-셀수명-01")
    tr2 = ent(db, "test_run", "TR-2026-모터진동-03")
    rel(db, tr1, cell, "tested")
    rel(db, tr2, motor, "tested")
    proj = ent(db, "project", "차세대 배터리 안전성 과제")
    rel(db, proj, cell, "targets")
    rel(db, proj, pack, "targets")

    db.commit()
    # 요약
    n_ent = db.execute(select(Entity.id)).scalars().all()
    from app.modules.entities.models import EntityRelation
    n_rel = db.execute(select(EntityRelation.id)).scalars().all()
    print(f"완료. 엔티티 총 {len(n_ent)}개, 관계 총 {len(n_rel)}개.")
    print(f"깊은 사슬 예: E-GMP 플랫폼 → 배터리 팩 → 배터리 모듈 → 배터리 셀 "
          f"→ 양극재 → 니켈 전구체 → 공급사 (part_of 5홉 + 1).")


def main():
    db = SessionLocal()
    try:
        build(db)
    finally:
        db.close()


if __name__ == "__main__":
    main()
