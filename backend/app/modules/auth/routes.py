"""Auth routes — login, public signup, admin-only register.

Login + signup are open. Register is admin-only (organization onboards
users via workspace admin without requiring a password change).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.modules.auth import services as auth_services
from app.modules.auth.schemas import (
    LoginRequest,
    LoginResponse,
    PublicWorkspace,
    RegisteredUser,
    RegisterRequest,
    SignupRequest,
)
from app.modules.users.models import Role, User, WorkspaceMember
from app.modules.workspaces.models import Workspace
from app.modules.workspaces.services import ensure_personal_workspace
from app.shared.auth import CurrentUser, require_admin
from app.shared.responses import created_response, error_response, success_response

router = APIRouter()


@router.post("/login")
def login(payload: LoginRequest, db: Session = Depends(get_db)):
    user = auth_services.authenticate(db, payload.email, payload.password)
    if not user:
        return error_response(
            "이메일 또는 비밀번호가 올바르지 않습니다.",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )
    token = auth_services.create_access_token(user.id)
    return success_response(
        data=LoginResponse(
            access_token=token,
            expires_in=int(settings.jwt_access_token_expires.total_seconds()),
            user_id=user.id,
            email=user.email,
            name=user.name,
        )
    )


@router.get("/workspaces")
def public_workspace_list(db: Session = Depends(get_db)):
    """Public — used by the signup form's 소속 dropdown.

    Lists real (non-virtual) workspaces only. Sorted by tree position so
    parents appear before children — the frontend uses this for indent.
    """
    rows = list(
        db.execute(
            select(Workspace)
            .where(Workspace.virtual.is_(False))
            .order_by(Workspace.sort_order, Workspace.slug)
        ).scalars()
    )
    return success_response(
        data=[
            PublicWorkspace(slug=w.slug, name=w.name, parent_slug=w.parent_slug)
            for w in rows
        ]
    )


@router.post("/signup")
def signup(payload: SignupRequest, db: Session = Depends(get_db)):
    """Open self-signup. Creates the user + assigns `user` role on the
    chosen workspace. Returns an access token so the user lands logged in.

    Validation:
      - email must be unique
      - workspace must exist + not be virtual
    """
    existing = db.execute(
        select(User).where(User.email == payload.email)
    ).scalar_one_or_none()
    if existing:
        raise HTTPException(status.HTTP_409_CONFLICT, "이미 등록된 이메일입니다.")

    workspace = db.get(Workspace, payload.workspace_slug)
    if not workspace:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, f"부서를 찾을 수 없습니다: {payload.workspace_slug}"
        )
    if workspace.virtual:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "가상 부서에는 가입할 수 없습니다. 실제 부서를 선택하세요.",
        )

    user = User(
        email=payload.email,
        name=payload.name,
        password_hash=auth_services.hash_password(payload.password),
        is_active=True,
        # signup 시 선택한 부서를 home(소속) 으로. 멤버십 row 도 함께
        # 만들어 두므로 home != membership 모순 상태가 안 됨.
        home_workspace_slug=workspace.slug,
    )
    db.add(user)
    db.flush()  # populate user.id before creating membership

    db.add(
        WorkspaceMember(
            user_id=user.id,
            workspace_slug=workspace.slug,
            role=Role.user,
        )
    )
    # Every user needs a personal workspace — reports default-land there
    # (reports/routes.py:139). Skipping this here would surface as an
    # FK violation on first report-create. See ensure_personal_workspace
    # docstring for details. Idempotent.
    ensure_personal_workspace(db, user)
    db.commit()
    db.refresh(user)

    token = auth_services.create_access_token(user.id)
    return created_response(
        data=LoginResponse(
            access_token=token,
            expires_in=int(settings.jwt_access_token_expires.total_seconds()),
            user_id=user.id,
            email=user.email,
            name=user.name,
        )
    )


@router.post("/register")
def register(
    payload: RegisterRequest,
    db: Session = Depends(get_db),
    _actor: CurrentUser = Depends(require_admin),
):
    """Admin-only user creation. `workspace_slug` 가 주어지면 home(소속)
    부서로 지정하고 워크스페이스 멤버 row 도 같이 만들어 둠. 생략 시
    home 미지정 상태로 생성되고 admin 이 나중에 계정 관리에서 채워야 함."""
    existing = db.execute(select(User).where(User.email == payload.email)).first()
    if existing:
        raise HTTPException(status.HTTP_409_CONFLICT, "이미 등록된 이메일입니다.")

    home_slug = (payload.workspace_slug or "").strip() or None
    if home_slug:
        ws = db.get(Workspace, home_slug)
        if not ws:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, f"부서를 찾을 수 없습니다: {home_slug}"
            )
        if ws.virtual:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "가상 부서는 소속으로 지정할 수 없습니다.",
            )

    user = User(
        email=payload.email,
        name=payload.name,
        password_hash=auth_services.hash_password(payload.password),
        is_active=True,
        home_workspace_slug=home_slug,
    )
    db.add(user)
    db.flush()  # populate user.id for ensure_personal_workspace + memberships
    # Same as signup — admin-created users also need a personal workspace
    # so their first /api/reports POST doesn't FK-violate.
    ensure_personal_workspace(db, user)
    # home 이 지정됐다면 그 부서의 멤버 row 도 함께 만들어 home/멤버십
    # 모순을 피한다. role=user 가 기본 — admin 이 부서 멤버 페이지에서
    # 필요 시 승급.
    if home_slug:
        db.add(
            WorkspaceMember(
                user_id=user.id,
                workspace_slug=home_slug,
                role=Role.user,
            )
        )
    db.commit()
    db.refresh(user)
    return created_response(data=RegisteredUser.model_validate(user))
