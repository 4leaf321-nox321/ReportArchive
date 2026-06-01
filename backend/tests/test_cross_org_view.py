"""조직 간 공개(cross-org view) end-to-end 테스트 — 조직간공개_설계.md Phase 1·2.

시나리오: 보고서 R 은 admin(id=1)이 만들어 "dx" 게시판에만 게시(mount)한다.
사용자 B 는 "dev" 게시판 멤버다 — dev 는 dx 의 *자손*(descendant)이라, 가시성은
viewer 워크스페이스의 자손 트리만 훑으므로 dev 멤버에겐 dx-only mount 가 안 보인다
(= 깨끗한 조직 분리). dx 를 공개로 켜면 B 에게 R 이 *공개 경로로만* 보이게 되고,
본문은 열리되 댓글·이력·링크는 막혀야 한다.

라이브 테스트 DB 를 건드린다. 각 테스트가 생성물을 정리하고 dx 공개 토글을
원복하므로 반복 실행해도 행이 새지 않는다.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.modules.auth.services import create_access_token
from app.modules.users.models import Role, User, WorkspaceMember
from app.modules.workspaces.models import Workspace

ADMIN_WORKSPACE = "dx"
# dx 의 자손 — 여기 멤버는 dx-only mount 를 (공개 전에는) 못 본다.
OUTSIDER_WORKSPACE = "dev"


def _admin_headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {create_access_token(1)}",
        "X-Workspace-Slug": ADMIN_WORKSPACE,
    }


def _ensure_outsider() -> int:
    """OUTSIDER_WORKSPACE 멤버인 사용자 B 를 보장(멱등). dx 멤버는 아님 —
    멤버십은 위로만 걸어가므로 자손 게시판 멤버는 조상(dx)에 접근 못 한다."""
    db = SessionLocal()
    try:
        user = (
            db.query(User).filter_by(email="cross-org-outsider@test.local").one_or_none()
        )
        if user is None:
            user = User(
                email="cross-org-outsider@test.local",
                name="외부 조직 열람자",
                password_hash="!unused-tests-only",
            )
            db.add(user)
            db.flush()
        member = (
            db.query(WorkspaceMember)
            .filter_by(user_id=user.id, workspace_slug=OUTSIDER_WORKSPACE)
            .one_or_none()
        )
        if member is None:
            db.add(
                WorkspaceMember(
                    user_id=user.id,
                    workspace_slug=OUTSIDER_WORKSPACE,
                    role=Role.user,
                )
            )
        db.commit()
        return user.id
    finally:
        db.close()


def _outsider_headers(user_id: int) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {create_access_token(user_id)}",
        "X-Workspace-Slug": OUTSIDER_WORKSPACE,
    }


def _set_dx_public(public: bool) -> None:
    db = SessionLocal()
    try:
        ws = db.get(Workspace, ADMIN_WORKSPACE)
        ws.external_view_default = public
        db.commit()
    finally:
        db.close()


def _pick_template(client: TestClient) -> tuple[str, int]:
    res = client.get("/api/templates", headers=_admin_headers())
    assert res.status_code == 200, res.text
    items = res.json()["data"]
    assert items, "Seed must include at least one template"
    return items[0]["template_id"], items[0]["version"]


def _create_mounted_report(client: TestClient, *, title: str = "공개 테스트") -> dict:
    template_id, version = _pick_template(client)
    res = client.post(
        "/api/reports",
        headers=_admin_headers(),
        json={
            "template_id": template_id,
            "template_version": version,
            "title": title,
            "tags": [],
        },
    )
    assert res.status_code == 201, res.text
    report = res.json()["data"]
    mount = client.post(
        "/api/mounts",
        headers=_admin_headers(),
        json={"report_id": report["id"], "workspace_slugs": [ADMIN_WORKSPACE]},
    )
    assert mount.status_code == 200, mount.text
    return report


def _delete_report(client: TestClient, report_id: int) -> None:
    client.delete(f"/api/reports/{report_id}", headers=_admin_headers())


# --------------------------------------------------------------------------- #
# Phase 1 — 읽기 가시성                                                        #
# --------------------------------------------------------------------------- #


def test_outsider_cannot_see_private_mount() -> None:
    """공개 끄면 dx-only 보고서는 dev 멤버에게 403."""
    client = TestClient(app)
    outsider = _ensure_outsider()
    report = _create_mounted_report(client)
    _set_dx_public(False)
    try:
        res = client.get(
            f"/api/reports/{report['id']}", headers=_outsider_headers(outsider)
        )
        assert res.status_code == 403, res.text
    finally:
        _delete_report(client, report["id"])


def test_outsider_can_read_public_mount_as_readonly() -> None:
    """dx 를 공개로 켜면 dev 멤버가 본문을 200 으로 보되, 읽기전용 플래그가 선다."""
    client = TestClient(app)
    outsider = _ensure_outsider()
    report = _create_mounted_report(client)
    _set_dx_public(True)
    try:
        res = client.get(
            f"/api/reports/{report['id']}", headers=_outsider_headers(outsider)
        )
        assert res.status_code == 200, res.text
        data = res.json()["data"]
        assert data["is_public_view"] is True
        assert data["can_comment"] is False
        assert data["can_edit"] is False
    finally:
        _set_dx_public(False)
        _delete_report(client, report["id"])


def test_member_view_is_not_public_readonly() -> None:
    """같은 보고서를 dx 멤버(admin)가 보면 공개전용 플래그가 서지 않는다."""
    client = TestClient(app)
    report = _create_mounted_report(client)
    _set_dx_public(True)
    try:
        res = client.get(f"/api/reports/{report['id']}", headers=_admin_headers())
        assert res.status_code == 200, res.text
        data = res.json()["data"]
        assert data["is_public_view"] is False
        assert data["can_comment"] is True
    finally:
        _set_dx_public(False)
        _delete_report(client, report["id"])


# --------------------------------------------------------------------------- #
# Phase 2 — 곁다리 차단                                                        #
# --------------------------------------------------------------------------- #


def test_public_viewer_comments_hidden_and_blocked() -> None:
    client = TestClient(app)
    outsider = _ensure_outsider()
    report = _create_mounted_report(client)
    rid = report["id"]
    _set_dx_public(True)
    try:
        h = _outsider_headers(outsider)
        # 조회: 숨김(빈 목록)
        listed = client.get(f"/api/reports/{rid}/threads", headers=h)
        assert listed.status_code == 200, listed.text
        assert listed.json()["data"]["items"] == []
        # 작성: 403
        created = client.post(
            f"/api/reports/{rid}/threads",
            headers=h,
            json={
                "page_index": 0,
                "block_id": "block-1",
                "body": {"type": "doc", "content": []},
            },
        )
        assert created.status_code == 403, created.text
    finally:
        _set_dx_public(False)
        _delete_report(client, rid)


def test_public_viewer_activities_hidden() -> None:
    client = TestClient(app)
    outsider = _ensure_outsider()
    report = _create_mounted_report(client)
    rid = report["id"]
    _set_dx_public(True)
    try:
        res = client.get(
            f"/api/reports/{rid}/activities", headers=_outsider_headers(outsider)
        )
        assert res.status_code == 200, res.text
        assert res.json()["data"]["items"] == []
    finally:
        _set_dx_public(False)
        _delete_report(client, rid)


def test_public_viewer_cannot_add_link() -> None:
    client = TestClient(app)
    outsider = _ensure_outsider()
    report = _create_mounted_report(client)
    rid = report["id"]
    _set_dx_public(True)
    try:
        res = client.post(
            f"/api/reports/{rid}/links",
            headers=_outsider_headers(outsider),
            json={"to_report_id": rid, "kind": "related", "direction": "outgoing"},
        )
        assert res.status_code == 403, res.text
    finally:
        _set_dx_public(False)
        _delete_report(client, rid)


# --------------------------------------------------------------------------- #
# Phase 3 — 설정 토글 + 권한 위임                                              #
# --------------------------------------------------------------------------- #


def test_manager_can_toggle_workspace_public_outsider_cannot() -> None:
    """dx 매니저(admin)는 게시판 공개 토글 200; dev 멤버(비매니저)는 403."""
    client = TestClient(app)
    outsider = _ensure_outsider()
    try:
        # 비매니저 거부
        denied = client.patch(
            f"/api/workspaces/{ADMIN_WORKSPACE}/external-view",
            headers=_outsider_headers(outsider),
            json={"external_view_default": True},
        )
        assert denied.status_code == 403, denied.text
        # 매니저 허용 + 값 반영
        ok = client.patch(
            f"/api/workspaces/{ADMIN_WORKSPACE}/external-view",
            headers=_admin_headers(),
            json={"external_view_default": True},
        )
        assert ok.status_code == 200, ok.text
        assert ok.json()["data"]["external_view_default"] is True
    finally:
        _set_dx_public(False)


def test_folder_override_makes_report_public_even_when_board_private() -> None:
    """게시판 기본은 비공개여도, 그 안 폴더를 공개로 override 하면 외부 열람 가능."""
    client = TestClient(app)
    outsider = _ensure_outsider()
    _set_dx_public(False)  # 게시판 기본 비공개
    # org 폴더 생성
    folder_res = client.post(
        "/api/folders?workspace_slug=" + ADMIN_WORKSPACE,
        headers=_admin_headers(),
        json={"name": "공개폴더-테스트"},
    )
    assert folder_res.status_code == 201, folder_res.text
    folder_id = folder_res.json()["data"]["id"]
    # 그 폴더에 보고서 게시
    template_id, version = _pick_template(client)
    rep = client.post(
        "/api/reports",
        headers=_admin_headers(),
        json={
            "template_id": template_id,
            "template_version": version,
            "title": "폴더공개 테스트",
            "tags": [],
        },
    )
    rid = rep.json()["data"]["id"]
    client.post(
        "/api/mounts",
        headers=_admin_headers(),
        json={
            "report_id": rid,
            "workspace_slugs": [ADMIN_WORKSPACE],
            "folder_id": folder_id,
        },
    )
    try:
        h = _outsider_headers(outsider)
        # override 전 — 비공개라 외부 403
        assert client.get(f"/api/reports/{rid}", headers=h).status_code == 403
        # 폴더를 공개로 override (매니저)
        patched = client.patch(
            f"/api/folders/{folder_id}",
            headers=_admin_headers(),
            json={"external_view": True},
        )
        assert patched.status_code == 200, patched.text
        assert patched.json()["data"]["external_view"] is True
        # override 후 — 외부 200 + 읽기전용
        got = client.get(f"/api/reports/{rid}", headers=h)
        assert got.status_code == 200, got.text
        assert got.json()["data"]["is_public_view"] is True
    finally:
        _delete_report(client, rid)
        client.delete(f"/api/folders/{folder_id}", headers=_admin_headers())


# --------------------------------------------------------------------------- #
# Phase 4 — 관계도 통합                                                        #
# --------------------------------------------------------------------------- #


def test_public_report_is_external_node_in_global_graph() -> None:
    """공개 보고서는 외부 조직 사용자의 전역 관계도에 노드로 보이고,
    is_external_public=True 로 구분된다. 비공개면 노드 자체가 안 보인다."""
    client = TestClient(app)
    outsider = _ensure_outsider()
    report = _create_mounted_report(client)
    rid = report["id"]
    h = _outsider_headers(outsider)
    url = "/api/reports/link-graph?include_isolated=true&limit=2000"
    try:
        # 비공개 — 외부 그래프에 노드 없음
        _set_dx_public(False)
        before = client.get(url, headers=h)
        assert before.status_code == 200, before.text
        assert not any(
            n.get("report_id") == rid for n in before.json()["data"]["nodes"]
        )
        # 공개 — 노드 등장 + 외부 공개 플래그
        _set_dx_public(True)
        after = client.get(url, headers=h)
        assert after.status_code == 200, after.text
        node = next(
            (n for n in after.json()["data"]["nodes"] if n.get("report_id") == rid),
            None,
        )
        assert node is not None, "공개 보고서가 외부 그래프에 노드로 보여야 한다"
        assert node["is_external_public"] is True
    finally:
        _set_dx_public(False)
        _delete_report(client, rid)


def test_include_public_explore_unions_public_reports() -> None:
    """기본 목록엔 다른 조직 공개분이 안 섞이고(§5), include_public=true 탐색
    에서만 합쳐지며 is_external_public 으로 표시된다."""
    client = TestClient(app)
    outsider = _ensure_outsider()
    report = _create_mounted_report(client)
    rid = report["id"]
    h = _outsider_headers(outsider)
    _set_dx_public(True)
    try:
        # 기본 목록(off) — 공개분 안 섞임
        base = client.get("/api/reports", headers=h)
        assert base.status_code == 200, base.text
        assert not any(r["id"] == rid for r in base.json()["data"])
        # 탐색(on) — 등장 + 외부 공개 표시
        explore = client.get("/api/reports?include_public=true", headers=h)
        assert explore.status_code == 200, explore.text
        row = next((r for r in explore.json()["data"] if r["id"] == rid), None)
        assert row is not None, "공개 탐색에 공개 보고서가 보여야 한다"
        assert row["is_external_public"] is True
    finally:
        _set_dx_public(False)
        _delete_report(client, rid)


def test_owner_sees_own_report_not_flagged_external() -> None:
    """게시판 멤버(admin)에겐 자기 보고서가 외부 공개 노드로 표시되지 않는다."""
    client = TestClient(app)
    report = _create_mounted_report(client)
    rid = report["id"]
    _set_dx_public(True)
    try:
        res = client.get(
            "/api/reports/link-graph?include_isolated=true&limit=2000",
            headers=_admin_headers(),
        )
        assert res.status_code == 200, res.text
        node = next(
            (n for n in res.json()["data"]["nodes"] if n.get("report_id") == rid),
            None,
        )
        assert node is not None
        assert node["is_external_public"] is False
    finally:
        _set_dx_public(False)
        _delete_report(client, rid)


# --------------------------------------------------------------------------- #
# Phase 5 — 비멤버 게시판 읽기전용 진입                                        #
# --------------------------------------------------------------------------- #
# dev 멤버(OUTSIDER)는 dx 의 멤버가 아니다(멤버십은 위로만 상속). dx 에 공개
# 폴더가 있으면 dx 컨텍스트로 *읽기전용* 진입할 수 있어야 하고, 공개분만 보이며
# 모든 쓰기는 막혀야 한다.

CLEAN_NONMEMBER_WS = "division-mx"  # OUTSIDER 비멤버 + 공개 컨텐츠 없음(진입 거부 테스트)


def _make_org_folder(client: TestClient, name: str, *, public: bool) -> int:
    res = client.post(
        f"/api/folders?workspace_slug={ADMIN_WORKSPACE}",
        headers=_admin_headers(),
        json={"name": name},
    )
    assert res.status_code == 201, res.text
    fid = res.json()["data"]["id"]
    if public:
        p = client.patch(
            f"/api/folders/{fid}",
            headers=_admin_headers(),
            json={"external_view": True},
        )
        assert p.status_code == 200, p.text
    return fid


def _make_report_in_folder(client: TestClient, folder_id: int | None, title: str) -> int:
    template_id, version = _pick_template(client)
    rep = client.post(
        "/api/reports",
        headers=_admin_headers(),
        json={
            "template_id": template_id,
            "template_version": version,
            "title": title,
            "tags": [],
        },
    )
    assert rep.status_code == 201, rep.text
    rid = rep.json()["data"]["id"]
    client.post(
        "/api/mounts",
        headers=_admin_headers(),
        json={
            "report_id": rid,
            "workspace_slugs": [ADMIN_WORKSPACE],
            "folder_id": folder_id,
        },
    )
    return rid


def test_nonmember_reads_public_board_filtered() -> None:
    """비멤버가 dx 진입 시 — 목록·폴더에 공개분만, 비공개는 안 보임."""
    client = TestClient(app)
    outsider = _ensure_outsider()
    _set_dx_public(False)
    pub_folder = _make_org_folder(client, "P5-공개폴더", public=True)
    priv_folder = _make_org_folder(client, "P5-비공개폴더", public=False)
    pub_rid = _make_report_in_folder(client, pub_folder, "P5 공개 보고서")
    priv_rid = _make_report_in_folder(client, priv_folder, "P5 비공개 보고서")
    h = {
        "Authorization": f"Bearer {create_access_token(outsider)}",
        "X-Workspace-Slug": ADMIN_WORKSPACE,  # 비멤버가 dx 컨텍스트로 진입
    }
    try:
        # 보고서 목록 — 공개만
        rows = client.get("/api/reports", headers=h)
        assert rows.status_code == 200, rows.text
        ids = [r["id"] for r in rows.json()["data"]]
        assert pub_rid in ids, "공개 보고서는 보여야"
        assert priv_rid not in ids, "비공개 보고서는 비멤버에게 안 보여야"
        assert all(r["is_external_public"] for r in rows.json()["data"])
        # 폴더 목록 — 공개 폴더만
        fl = client.get(
            f"/api/folders?workspace_slug={ADMIN_WORKSPACE}", headers=h
        )
        assert fl.status_code == 200, fl.text
        fids = [f["id"] for f in fl.json()["data"]["items"]]
        assert pub_folder in fids
        assert priv_folder not in fids
        # 단일 GET — 공개 200(읽기전용), 비공개 403
        gp = client.get(f"/api/reports/{pub_rid}", headers=h)
        assert gp.status_code == 200 and gp.json()["data"]["is_public_view"] is True
        assert client.get(f"/api/reports/{priv_rid}", headers=h).status_code == 403
    finally:
        _delete_report(client, pub_rid)
        _delete_report(client, priv_rid)
        client.delete(f"/api/folders/{pub_folder}", headers=_admin_headers())
        client.delete(f"/api/folders/{priv_folder}", headers=_admin_headers())


def test_nonmember_all_writes_blocked() -> None:
    """비멤버 읽기전용 진입자는 어떤 쓰기도 403."""
    client = TestClient(app)
    outsider = _ensure_outsider()
    _set_dx_public(False)
    pub_folder = _make_org_folder(client, "P5-쓰기차단-공개", public=True)
    pub_rid = _make_report_in_folder(client, pub_folder, "P5 쓰기차단 보고서")
    h = {
        "Authorization": f"Bearer {create_access_token(outsider)}",
        "X-Workspace-Slug": ADMIN_WORKSPACE,
    }
    tmpl = _pick_template(client)
    try:
        # 보고서 생성
        assert client.post(
            "/api/reports",
            headers=h,
            json={"template_id": tmpl[0], "template_version": tmpl[1],
                  "title": "침입", "tags": []},
        ).status_code == 403
        # 폴더 생성
        assert client.post(
            f"/api/folders?workspace_slug={ADMIN_WORKSPACE}",
            headers=h, json={"name": "침입폴더"},
        ).status_code == 403
        # mount
        assert client.post(
            "/api/mounts", headers=h,
            json={"report_id": pub_rid, "workspace_slugs": [ADMIN_WORKSPACE]},
        ).status_code == 403
        # 게시판 공개 토글
        assert client.patch(
            f"/api/workspaces/{ADMIN_WORKSPACE}/external-view",
            headers=h, json={"external_view_default": True},
        ).status_code == 403
        # 보고서 편집(PATCH)
        assert client.patch(
            f"/api/reports/{pub_rid}", headers=h, json={"title": "변조"},
        ).status_code == 403
        # 댓글 작성
        assert client.post(
            f"/api/reports/{pub_rid}/threads", headers=h,
            json={"page_index": 0, "block_id": "b1",
                  "body": {"type": "doc", "content": []}},
        ).status_code == 403
    finally:
        _delete_report(client, pub_rid)
        client.delete(f"/api/folders/{pub_folder}", headers=_admin_headers())


def test_nonmember_denied_when_no_public_content() -> None:
    """공개 컨텐츠가 없는 게시판엔 비멤버가 아예 진입 불가(403)."""
    client = TestClient(app)
    outsider = _ensure_outsider()
    h = {
        "Authorization": f"Bearer {create_access_token(outsider)}",
        "X-Workspace-Slug": CLEAN_NONMEMBER_WS,
    }
    # division-mx 는 OUTSIDER 비멤버 + 공개 컨텐츠 없음 → 진입 자체가 403
    assert client.get("/api/reports", headers=h).status_code == 403
