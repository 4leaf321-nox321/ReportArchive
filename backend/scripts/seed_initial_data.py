"""
Idempotent seed for initial application data.

Run after `setup_and_upgrade_db.py`. Creates:
  - Workspace tree (DX 부문 루트 + 공통 _global 가상 노드)
  - Seed admin user (id "admin", password "32167") with admin role on dx
  - System templates (widget-v1)

Re-running is safe: existing rows are skipped (matched by primary key).
하위 부서는 시드에 두지 않고 관리자 UI(/admin)에서 추가.
"""
from __future__ import annotations

import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.modules.auth.services import hash_password
from app.modules.workspaces.models import Workspace
from app.modules.users.models import Role, User, WorkspaceMember
from app.modules.template_categories.models import TemplateCategory
from app.modules.templates.models import Template
from app.modules.reports.models import Report


TEMPLATE_CATEGORIES = [
    {"slug": "periodic", "name": "주기 보고", "sort_order": 1},
    {"slug": "incident", "name": "인시던트", "sort_order": 2},
    {"slug": "release", "name": "릴리스", "sort_order": 3},
    {"slug": "meeting", "name": "회의록", "sort_order": 4},
    {"slug": "tech", "name": "기술 문서", "sort_order": 5},
    {"slug": "misc", "name": "기타", "sort_order": 99},
]


WORKSPACES = [
    {"slug": "dx", "name": "DX 부문", "parent_slug": None},
    {
        "slug": "_global",
        "name": "공통",
        "description": "부서 횡단 집계 뷰",
        "parent_slug": None,
        "virtual": True,
    },
]

SEED_USERS = [
    # Seed administrator. `email` column doubles as the login id — short
    # value lets operators log in by typing just "admin".
    {
        "email": "admin",
        "name": "관리자",
        "password": "32167",
        "memberships": [("dx", Role.admin)],
    },
]


def _make_schema(blocks: list[dict]) -> dict:
    """Wraps a block list into a widget-v1 template schema document."""
    return {"version": "widget-v1", "blocks": blocks}


TEMPLATES = [
    {
        "template_id": "weekly-dev",
        "name": "개발 주간 보고",
        "category": "periodic",
        "description": "팀 단위 주간 진행상황 / 이슈 / 다음 주 계획",
        "blocks": [
            # 메모 위젯 — 빈 상태로 시작. 모델/부품/BOM 같은 식별 정보는
            # 별도의 "보고서 속성"에서 관리하기로 했고, 본문 위젯은 작성자가
            # 필요한 메모를 직접 추가하는 자리로 사용한다.
            {"id": "meta", "type": "key_value", "props": {
                "label": "메모",
            }},
            {"id": "summary", "type": "rich_text", "props": {
                "label": "주간 요약", "placeholder": "이번 주 핵심 내용을 3-5줄로", "required": True,
            }},
            {"id": "progress", "type": "bulleted_list", "props": {
                "label": "진행 항목", "placeholder": "완료 / 진행 중 작업", "min_items": 1,
            }},
            {"id": "issues", "type": "table", "props": {
                "label": "이슈 / 리스크",
                "columns": [
                    {"key": "issue", "label": "이슈", "type": "text", "required": True},
                    {"key": "severity", "label": "심각도", "type": "select",
                     "options": ["낮음", "보통", "높음"], "required": True},
                    {"key": "owner", "label": "담당", "type": "text"},
                    {"key": "due", "label": "마감", "type": "date"},
                ],
            }},
            {"id": "next_week", "type": "bulleted_list", "props": {
                "label": "다음 주 계획", "min_items": 1,
            }},
        ],
    },
    {
        "template_id": "weekly-biz",
        "name": "영업 주간 보고",
        "category": "periodic",
        "description": "영업 파이프라인 / 신규 미팅 / 클로징 현황",
        "blocks": [
            {"id": "meta", "type": "key_value", "props": {
                "label": "보고 정보",
                "items": [
                    {"key": "period", "label": "보고 기간", "type": "text", "required": True},
                    {"key": "owner", "label": "작성자", "type": "text", "required": True},
                ],
            }},
            {"id": "pipeline", "type": "table", "props": {
                "label": "주요 파이프라인",
                "columns": [
                    {"key": "account", "label": "고객사", "type": "text", "required": True},
                    {"key": "stage", "label": "단계", "type": "select",
                     "options": ["리드", "제안", "협상", "클로징"], "required": True},
                    {"key": "amount", "label": "예상금액", "type": "number"},
                    {"key": "next_action", "label": "다음 액션", "type": "text"},
                ],
            }},
            {"id": "new_meetings", "type": "bulleted_list", "props": {
                "label": "신규 미팅",
            }},
            {"id": "closing", "type": "rich_text", "props": {
                "label": "클로징 현황", "placeholder": "이번 주 마감/예정 건",
            }},
        ],
    },
    {
        "template_id": "monthly-summary",
        "name": "월간 부서 요약",
        "category": "periodic",
        "description": "월말 부서별 KPI / 성과 / 다음 달 목표 (KPI는 한 행에 나란히 배치)",
        "blocks": [
            {"id": "meta", "type": "key_value",
             "layout": {"row": 1, "col_span": 12, "row_span": 2},
             "props": {
                "label": "보고 정보",
                "items": [
                    {"key": "period", "label": "월", "type": "text", "required": True},
                    {"key": "team", "label": "부서", "type": "text", "required": True},
                ],
            }},
            {"id": "achievements", "type": "rich_text",
             "layout": {"row": 3, "col_span": 12, "row_span": 4},
             "props": {
                "label": "성과 요약", "required": True,
            }},
            {"id": "next_goals", "type": "bulleted_list",
             "layout": {"row": 4, "col_span": 12, "row_span": 3},
             "props": {
                "label": "다음 달 목표", "min_items": 1,
            }},
        ],
    },
    {
        "template_id": "incident",
        "name": "인시던트 보고",
        "category": "incident",
        "description": "장애 발생 후 사후 분석 (postmortem)",
        "blocks": [
            {"id": "meta", "type": "key_value", "props": {
                "label": "장애 개요",
                "items": [
                    {"key": "title", "label": "제목", "type": "text", "required": True},
                    {"key": "occurred_at", "label": "발생 시각", "type": "text", "required": True},
                    {"key": "severity", "label": "심각도", "type": "select",
                     "options": ["S1", "S2", "S3", "S4"], "required": True},
                    {"key": "duration", "label": "지속 시간", "type": "text"},
                ],
            }},
            {"id": "overview", "type": "rich_text", "props": {
                "label": "개요", "placeholder": "무슨 일이 일어났는가", "required": True,
            }},
            {"id": "timeline", "type": "table", "props": {
                "label": "타임라인",
                "columns": [
                    {"key": "time", "label": "시각", "type": "text", "required": True},
                    {"key": "event", "label": "사건", "type": "text", "required": True},
                ],
            }},
            {"id": "root_cause", "type": "rich_text", "props": {
                "label": "근본 원인", "required": True,
            }},
            {"id": "action_items", "type": "table", "props": {
                "label": "조치 항목",
                "columns": [
                    {"key": "action", "label": "조치", "type": "text", "required": True},
                    {"key": "owner", "label": "담당", "type": "text"},
                    {"key": "due", "label": "마감", "type": "date"},
                    {"key": "status", "label": "상태", "type": "select",
                     "options": ["대기", "진행", "완료"]},
                ],
            }},
            {"id": "evidence", "type": "image", "props": {
                "label": "증거 자료 (그래프/스크린샷)", "max_count": 6,
            }},
        ],
    },
    {
        "template_id": "release-note",
        "name": "릴리스 노트",
        "category": "release",
        "description": "버전별 변경사항 요약",
        "blocks": [
            {"id": "meta", "type": "key_value", "props": {
                "label": "릴리스 정보",
                "items": [
                    {"key": "version", "label": "버전", "type": "text", "required": True},
                    {"key": "released_at", "label": "릴리스일", "type": "date", "required": True},
                ],
            }},
            {"id": "highlights", "type": "rich_text", "props": {
                "label": "주요 변경", "required": True,
            }},
            {"id": "features", "type": "bulleted_list", "props": {"label": "기능"}},
            {"id": "fixes", "type": "bulleted_list", "props": {"label": "버그 수정"}},
        ],
    },
    {
        "template_id": "meeting-decision",
        "name": "의사결정 회의록",
        "category": "meeting",
        "description": "결정사항·배경·반대의견·후속조치를 구조화",
        "blocks": [
            {"id": "meta", "type": "key_value", "props": {
                "label": "회의 정보",
                "items": [
                    {"key": "title", "label": "회의 제목", "type": "text", "required": True},
                    {"key": "date", "label": "일자", "type": "date", "required": True},
                    {"key": "attendees", "label": "참석자", "type": "text"},
                ],
            }},
            {"id": "context", "type": "rich_text", "props": {
                "label": "배경", "required": True,
            }},
            {"id": "options", "type": "table", "props": {
                "label": "검토 옵션",
                "columns": [
                    {"key": "option", "label": "옵션", "type": "text", "required": True},
                    {"key": "pros", "label": "장점", "type": "text"},
                    {"key": "cons", "label": "단점", "type": "text"},
                ],
            }},
            {"id": "decision", "type": "rich_text", "props": {
                "label": "결정", "required": True,
            }},
            {"id": "follow_up", "type": "bulleted_list", "props": {"label": "후속 조치"}},
        ],
    },
    {
        "template_id": "rfc",
        "name": "기술 검토서 (RFC)",
        "category": "tech",
        "description": "제안된 기술 변경의 동기·설계·리스크 검토",
        "blocks": [
            {"id": "meta", "type": "key_value", "props": {
                "label": "RFC 정보",
                "items": [
                    {"key": "title", "label": "제목", "type": "text", "required": True},
                    {"key": "author", "label": "작성자", "type": "text", "required": True},
                    {"key": "status", "label": "상태", "type": "select",
                     "options": ["draft", "in_review", "accepted", "rejected"], "required": True},
                ],
            }},
            {"id": "motivation", "type": "rich_text", "props": {
                "label": "동기", "required": True,
            }},
            {"id": "design", "type": "rich_text", "props": {
                "label": "설계", "required": True,
            }},
            {"id": "alternatives", "type": "rich_text", "props": {"label": "대안"}},
            {"id": "risks", "type": "bulleted_list", "props": {"label": "리스크"}},
            {"id": "diagrams", "type": "image", "props": {
                "label": "다이어그램", "max_count": 5,
            }},
        ],
    },
    {
        "template_id": "adr",
        "name": "아키텍처 결정 문서 (ADR)",
        "category": "tech",
        "description": "아키텍처 의사결정의 맥락·결정·결과 기록",
        "blocks": [
            {"id": "meta", "type": "key_value", "props": {
                "label": "ADR 정보",
                "items": [
                    {"key": "title", "label": "제목", "type": "text", "required": True},
                    {"key": "status", "label": "상태", "type": "select",
                     "options": ["proposed", "accepted", "deprecated", "superseded"], "required": True},
                    {"key": "date", "label": "일자", "type": "date", "required": True},
                ],
            }},
            {"id": "context", "type": "rich_text", "props": {
                "label": "맥락", "required": True,
            }},
            {"id": "decision", "type": "rich_text", "props": {
                "label": "결정", "required": True,
            }},
            {"id": "consequences", "type": "rich_text", "props": {
                "label": "결과", "required": True,
            }},
        ],
    },
]


def seed_workspaces(db: Session) -> None:
    # Insert root nodes first to satisfy FK ordering.
    by_slug = {w["slug"]: w for w in WORKSPACES}
    inserted: set[str] = set()

    def insert(slug: str) -> None:
        if slug in inserted:
            return
        spec = by_slug[slug]
        if spec["parent_slug"]:
            insert(spec["parent_slug"])
        existing = db.get(Workspace, slug)
        if existing:
            inserted.add(slug)
            return
        db.add(
            Workspace(
                slug=spec["slug"],
                name=spec["name"],
                description=spec.get("description", ""),
                parent_slug=spec.get("parent_slug"),
                # Color column has a default; it gets overwritten below by
                # the auto-from-tree recompute. Seed never picks colors.
                virtual=spec.get("virtual", False),
                sort_order=len(inserted),
            )
        )
        inserted.add(slug)
        print(f"[NEW] workspace: {slug}")

    for spec in WORKSPACES:
        insert(spec["slug"])

    # Ensure even fresh-seeded workspaces get the auto-derived palette
    # color, not the column default.
    from app.modules.workspaces.services import recompute_workspace_colors

    db.flush()
    recompute_workspace_colors(db)


def seed_template_categories(db: Session) -> None:
    for spec in TEMPLATE_CATEGORIES:
        if db.get(TemplateCategory, spec["slug"]):
            continue
        db.add(
            TemplateCategory(
                slug=spec["slug"],
                name=spec["name"],
                sort_order=spec["sort_order"],
            )
        )
        print(f"[NEW] template_category: {spec['slug']} ({spec['name']})")


def seed_user(db: Session, email: str, name: str, password: str) -> User:
    user = db.query(User).filter_by(email=email).one_or_none()
    if user:
        # Backfill password hash for users created before auth was wired up.
        if not user.password_hash:
            user.password_hash = hash_password(password)
            print(f"[..]  password set for existing user: {user.email}")
        return user
    user = User(
        email=email,
        name=name,
        password_hash=hash_password(password),
    )
    db.add(user)
    db.flush()
    print(f"[NEW] user: {user.email} (id={user.id})")
    return user


def seed_membership(db: Session, user: User, workspace_slug: str, role: Role) -> None:
    existing = (
        db.query(WorkspaceMember)
        .filter_by(user_id=user.id, workspace_slug=workspace_slug)
        .one_or_none()
    )
    if existing:
        if existing.role != role:
            existing.role = role
            print(f"[..]  role updated: user={user.email} ws={workspace_slug} → {role.value}")
        return
    db.add(WorkspaceMember(user_id=user.id, workspace_slug=workspace_slug, role=role))
    print(f"[NEW] membership: user={user.email} ws={workspace_slug} role={role.value}")


def _is_widget_v1(schema: dict | None) -> bool:
    return isinstance(schema, dict) and schema.get("version") == "widget-v1"


def _spec_matches_db(spec: dict, db_template: Template) -> bool:
    """True if the seeded spec already matches the row in the DB.

    We compare on (name, description, category, schema). When templates
    diverge (e.g. we add layout to a seed), we want to detect it and replace.
    """
    if db_template.name != spec["name"]:
        return False
    if db_template.description != spec["description"]:
        return False
    if db_template.category != spec["category"]:
        return False
    return db_template.schema == _make_schema(spec["blocks"])


def seed_templates(db: Session, created_by_user_id: int) -> None:
    """Seeds widget-v1 templates.

    Replacement policy:
      - Matches the seed spec exactly → skip (truly idempotent).
      - Legacy schema (pre widget-v1) OR widget-v1 but stale shape →
        wipe all versions + referencing reports, then insert fresh v1.
      - Absent → insert v1.

    Stale-shape detection lets us evolve seed templates (e.g. add layout,
    rename props) without manual SQL surgery in dev.
    """
    for spec in TEMPLATES:
        all_versions = (
            db.query(Template).filter(Template.template_id == spec["template_id"]).all()
        )
        latest = next((t for t in all_versions if t.is_latest), None)

        if latest and _spec_matches_db(spec, latest):
            continue  # truly up to date

        if all_versions:
            # Stale or legacy — wipe everything that template_id owns.
            deleted_reports = (
                db.query(Report)
                .filter(Report.template_id == spec["template_id"])
                .delete(synchronize_session=False)
            )
            for t in all_versions:
                db.delete(t)
            db.flush()
            kind = "legacy" if not _is_widget_v1(latest.schema if latest else None) else "stale"
            print(
                f"[..]  {kind} template wiped: {spec['template_id']} "
                f"(removed {len(all_versions)} version(s), {deleted_reports} report(s))"
            )

        schema = _make_schema(spec["blocks"])
        db.add(
            Template(
                template_id=spec["template_id"],
                version=1,
                name=spec["name"],
                description=spec["description"],
                category=spec["category"],
                schema=schema,
                owner_workspace_slugs=None,  # global / 전사
                is_published=True,
                is_latest=True,
                created_by_user_id=created_by_user_id,
            )
        )
        print(f"[NEW] template: {spec['template_id']} v1")


def main() -> int:
    db = SessionLocal()
    try:
        seed_workspaces(db)
        seed_template_categories(db)
        db.flush()

        first_user_id: int | None = None
        for spec in SEED_USERS:
            user = seed_user(db, spec["email"], spec["name"], spec["password"])
            db.flush()
            if first_user_id is None:
                first_user_id = user.id
            for ws_slug, role in spec["memberships"]:
                seed_membership(db, user, ws_slug, role)

        if first_user_id is not None:
            seed_templates(db, first_user_id)
        db.commit()
    except Exception as exc:
        db.rollback()
        print(f"[ERR] {exc}", file=sys.stderr)
        return 1
    finally:
        db.close()
    print()
    print("[DONE] seed")
    print()
    print("Test accounts (email / password):")
    for spec in SEED_USERS:
        print(f"  {spec['email']:<25} / {spec['password']:<12}  ({spec['name']})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
