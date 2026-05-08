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
    """Admin-only user creation (no membership assignment — admin then adds
    the user to a workspace via the members endpoint)."""
    existing = db.execute(select(User).where(User.email == payload.email)).first()
    if existing:
        raise HTTPException(status.HTTP_409_CONFLICT, "이미 등록된 이메일입니다.")

    user = User(
        email=payload.email,
        name=payload.name,
        password_hash=auth_services.hash_password(payload.password),
        is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return created_response(data=RegisteredUser.model_validate(user))
