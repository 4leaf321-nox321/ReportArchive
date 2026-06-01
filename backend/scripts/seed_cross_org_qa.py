"""조직 간 공개(cross-org view) 수동 점검용 시드 — 조직간공개_설계.md §12.0.

§12 점검 계획의 "환경 준비"를 1-커맨드로 깔아준다. 멱등(re-run 안전):
이메일·폴더명·보고서 제목으로 기존 행을 찾고 없을 때만 만든다.

깔리는 것
---------
- 계정 4종 (비밀번호 공통 `qa12345`):
    qa-dx-manager@test.local   — dx 매니저 (공개 토글/폴더 override 권한)
    qa-dx-member@test.local     — dx 일반멤버 (내부 열람자)
    qa-dev-member@test.local    — dev 일반멤버 (★ 외부 조직 열람자)
    qa-sysadmin@test.local      — 시스템관리자 (전체 가시)
  ※ dx 와 dev 는 시드에 이미 있는 워크스페이스를 쓴다(dev 는 dx 의 자손).
    dev 멤버는 dx-only mount 가 안 보이므로 cross-org 분리가 성립한다.
- dx 게시판 org 폴더 2개: "QA-공개샘플", "QA-비공개샘플"
- 보고서 4건 (제목 접두사 "[QA]"):
    A 공개 후보   → dx, 폴더=QA-공개샘플
    B 비공개      → dx, 폴더=QA-비공개샘플
    C 미분류      → dx, 폴더=없음
    D 개인        → 게시 안 함(개인 공간에만)
  A↔C 는 link 로 연결해 관계도에 엣지가 생긴다.

기본 상태는 **전부 비공개(OFF)** — 설계의 "기존 행 false/null = 격리 유지" 와
동일한 깨끗한 baseline. 무엇을 켜서 어떤 시나리오를 보는지는 실행 후 출력되는
가이드를 따른다.

실행:  (backend venv 활성화 후)
    python scripts/seed_cross_org_qa.py
"""
from __future__ import annotations

import sys
from datetime import date, timedelta
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token, hash_password
from app.modules.users.models import Role, User, WorkspaceMember
from app.modules.workspaces.models import Workspace, WorkspaceKind
from app.modules.workspaces.services import ensure_personal_workspace

DX = "dx"
DEV = "dev"
PASSWORD = "qa12345"
TITLE_PREFIX = "[QA]"

# (email, name, is_system_admin, [(workspace_slug, role)])
QA_USERS = [
    ("qa-dx-manager@test.local", "QA DX 매니저", False, [(DX, Role.manager)]),
    ("qa-dx-member@test.local", "QA DX 멤버", False, [(DX, Role.user)]),
    ("qa-dev-member@test.local", "QA DEV 멤버(외부)", False, [(DEV, Role.user)]),
    ("qa-sysadmin@test.local", "QA 시스템관리자", True, []),
]

FOLDER_PUBLIC = "QA-공개샘플"
FOLDER_PRIVATE = "QA-비공개샘플"


def _require_workspaces(db) -> None:
    """dx / dev 가 있어야 한다(seed_initial_data + /admin 으로 트리 구성 가정)."""
    missing = [s for s in (DX, DEV) if db.get(Workspace, s) is None]
    if missing:
        raise SystemExit(
            f"필요한 워크스페이스가 없습니다: {missing}. 먼저 seed_initial_data.py "
            f"실행 + /admin 에서 '{DEV}' 게시판(dx 자손)을 만들어 주세요."
        )
    if db.get(Workspace, DEV).kind != WorkspaceKind.org:
        raise SystemExit(f"'{DEV}' 는 org 게시판이어야 합니다.")


def ensure_users(db) -> dict[str, int]:
    """4 계정 보장(멱등). returns email→user_id."""
    ids: dict[str, int] = {}
    for email, name, is_sysadmin, memberships in QA_USERS:
        user = db.query(User).filter_by(email=email).one_or_none()
        if user is None:
            user = User(
                email=email,
                name=name,
                password_hash=hash_password(PASSWORD),
                is_system_admin=is_sysadmin,
            )
            db.add(user)
            db.flush()
            print(f"  + 사용자 생성: {email} (id={user.id})")
        else:
            # sys-admin 플래그/이름은 재실행 시 맞춰준다.
            user.is_system_admin = is_sysadmin
            user.name = name
        for slug, role in memberships:
            m = (
                db.query(WorkspaceMember)
                .filter_by(user_id=user.id, workspace_slug=slug)
                .one_or_none()
            )
            if m is None:
                db.add(
                    WorkspaceMember(user_id=user.id, workspace_slug=slug, role=role)
                )
            else:
                m.role = role
        ids[email] = user.id
    # 보고서 작성자(매니저)의 개인 워크스페이스 보장 — 보고서는 personal-{id}
    # 에서 태어나므로 FK 대상이 있어야 한다.
    mgr = db.get(User, ids["qa-dx-manager@test.local"])
    ensure_personal_workspace(db, mgr)
    db.commit()
    return ids


def _headers(user_id: int, workspace: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {create_access_token(user_id)}",
        "X-Workspace-Slug": workspace,
    }


def _pick_template(client: TestClient, headers) -> tuple[str, int]:
    res = client.get("/api/templates", headers=headers)
    res.raise_for_status()
    items = res.json()["data"]
    if not items:
        raise SystemExit("템플릿이 없습니다. seed_initial_data.py 를 먼저 실행하세요.")
    return items[0]["template_id"], items[0]["version"]


def ensure_folders(client: TestClient, headers) -> dict[str, int]:
    """dx org 폴더 2개 보장(멱등). returns name→folder_id."""
    existing = {
        f["name"]: f["id"]
        for f in client.get(
            f"/api/folders?workspace_slug={DX}", headers=headers
        ).json()["data"]["items"]
    }
    out: dict[str, int] = {}
    for name in (FOLDER_PUBLIC, FOLDER_PRIVATE):
        if name in existing:
            out[name] = existing[name]
            continue
        res = client.post(
            f"/api/folders?workspace_slug={DX}",
            headers=headers,
            json={"name": name},
        )
        res.raise_for_status()
        out[name] = res.json()["data"]["id"]
        print(f"  + 폴더 생성: {name} (id={out[name]})")
    return out


def _create_report(client, headers, *, title, template, report_date) -> int:
    res = client.post(
        "/api/reports",
        headers=headers,
        json={
            "template_id": template[0],
            "template_version": template[1],
            "title": title,
            "report_date": report_date.isoformat(),
            "tags": [],
        },
    )
    res.raise_for_status()
    return res.json()["data"]["id"]


def _mount(client, headers, report_id, *, folder_id=None) -> None:
    res = client.post(
        "/api/mounts",
        headers=headers,
        json={
            "report_id": report_id,
            "workspace_slugs": [DX],
            "folder_id": folder_id,
        },
    )
    res.raise_for_status()


def ensure_reports(client, headers, mgr_id, folders, template) -> None:
    """보고서 4건 + A↔C link 보장(멱등 — 제목으로 판정)."""
    # dx 게시판 + 매니저 개인 공간 양쪽을 봐야 미게시(개인) 보고서도 잡힌다.
    have = _existing_qa_titles_via_api(
        client, headers
    ) | _existing_qa_titles_via_api(client, _headers(mgr_id, f"personal-{mgr_id}"))
    today = date.today()

    plan = [
        (f"{TITLE_PREFIX} 공개 후보 보고서", folders[FOLDER_PUBLIC], today),
        (f"{TITLE_PREFIX} 비공개 보고서", folders[FOLDER_PRIVATE], today - timedelta(days=1)),
        (f"{TITLE_PREFIX} 미분류 보고서", None, today - timedelta(days=2)),
    ]
    created: dict[str, int] = {}
    for title, folder_id, rdate in plan:
        if title in have:
            print(f"  · 이미 있음: {title}")
            continue
        rid = _create_report(client, headers, title=title, template=template, report_date=rdate)
        _mount(client, headers, rid, folder_id=folder_id)
        created[title] = rid
        print(f"  + 보고서 게시: {title} (id={rid}, folder={folder_id})")

    # 개인 보고서 — 게시 안 함(개인 공간에만 머묾).
    personal_title = f"{TITLE_PREFIX} 개인 보고서(미게시)"
    if personal_title not in have:
        rid = _create_report(
            client, headers, title=personal_title, template=template,
            report_date=today - timedelta(days=3),
        )
        print(f"  + 개인 보고서(미게시): {personal_title} (id={rid})")

    # A↔C link — 관계도 엣지용. 양쪽 다 이번에 만들었을 때만(멱등 단순화).
    a = created.get(f"{TITLE_PREFIX} 공개 후보 보고서")
    c = created.get(f"{TITLE_PREFIX} 미분류 보고서")
    if a and c:
        kinds = client.get("/api/reports/link-kinds", headers=headers).json()["data"]
        kind = kinds[0]["key"] if kinds else "related"
        res = client.post(
            f"/api/reports/{a}/links",
            headers=headers,
            json={"to_report_id": c, "kind": kind, "direction": "outgoing"},
        )
        if res.status_code in (200, 201):
            print(f"  + link 생성: 공개후보 → 미분류 (kind={kind})")


def _existing_qa_titles_via_api(client, headers) -> set[str]:
    """dx 게시판 + 매니저 개인 목록에서 [QA] 제목 수집(멱등 판정)."""
    titles: set[str] = set()
    for r in client.get("/api/reports", headers=headers).json().get("data", []):
        if r["title"].startswith(TITLE_PREFIX):
            titles.add(r["title"])
    return titles


def _print_guide(ids: dict[str, int]) -> None:
    bar = "─" * 64
    print("\n" + bar)
    print("조직 간 공개 — 점검 환경 준비 완료 (§12). 기본 상태: 전부 비공개(OFF)")
    print(bar)
    print("계정 (비밀번호 공통: %s)" % PASSWORD)
    print("  · qa-dx-manager@test.local  — dx 매니저(토글/폴더 권한)")
    print("  · qa-dx-member@test.local    — dx 멤버(내부 열람)")
    print("  · qa-dev-member@test.local   — ★ dev 멤버 = 외부 조직 열람자")
    print("  · qa-sysadmin@test.local     — 시스템관리자")
    print("\n데이터(dx 게시판):")
    print("  · 폴더 QA-공개샘플  → 보고서 '공개 후보'")
    print("  · 폴더 QA-비공개샘플 → 보고서 '비공개'")
    print("  · 미분류           → 보고서 '미분류' (공개후보와 link 연결)")
    print("  · 개인 보고서      → 게시 안 함")
    print("\n시나리오(§12.2):")
    print("  1) qa-dx-manager 로 dx 진입 → 사이드바 'BoardPublicBar' 또는")
    print("     QA-공개샘플 폴더 행의 🌐 버튼을 '공개'로 토글.")
    print("  2) qa-dev-member 로 로그인 → 그 공개 보고서가:")
    print("       · 상세에 🌐 읽기전용 배너 / 댓글·이력·편집 비활성")
    print("       · 목록 'public 탐색' 체크 시 🌐 행으로 등장")
    print("       · 전역 관계도에 sky 점선 외곽선 노드로 등장")
    print("  3) QA-비공개샘플/개인 보고서는 qa-dev-member 에게 끝까지 403/미노출.")
    print("  4) 토글 OFF 로 되돌리면 즉시 403 (라이브 판정).")
    print(bar)
    print("정리: 이 시드가 만든 행은 이메일 'qa-*@test.local' / 제목 '[QA]' /")
    print("      폴더 'QA-*' 로 식별됩니다. 재실행은 안전(멱등).")
    print(bar)


def main() -> None:
    db = SessionLocal()
    try:
        _require_workspaces(db)
        print("[1/3] 계정 보장…")
        ids = ensure_users(db)
    finally:
        db.close()

    client = TestClient(app)
    mgr_id = ids["qa-dx-manager@test.local"]
    headers = _headers(mgr_id, DX)
    template = _pick_template(client, headers)
    print("[2/3] 폴더 보장…")
    folders = ensure_folders(client, headers)
    print("[3/3] 보고서 보장…")
    ensure_reports(client, headers, mgr_id, folders, template)

    _print_guide(ids)


if __name__ == "__main__":
    main()
