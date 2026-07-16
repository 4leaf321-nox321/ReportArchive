"""Auth routes — login, public signup, admin-only register.

Login + signup are open. Register is admin-only (organization onboards
users via workspace admin without requiring a password change).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.modules.access_logs import services as access_log_services
from app.modules.auth import services as auth_services
from app.modules.auth.schemas import (
    LoginRequest,
    LoginResponse,
    PasswordResetConfirm,
    PasswordResetRequestCreate,
    PublicWorkspace,
    RegisteredUser,
    RegisterRequest,
    SignupRequest,
)
from app.modules.users.models import (
    PasswordResetRequest,
    PasswordResetStatus,
    Role,
    User,
    WorkspaceMember,
)
from app.modules.workspaces.models import Workspace
from app.modules.workspaces.services import ensure_personal_workspace
from app.shared.auth import CurrentUser, require_admin
from app.shared.responses import created_response, error_response, success_response

router = APIRouter()


@router.post("/login")
def login(payload: LoginRequest, request: Request, db: Session = Depends(get_db)):
    # 도메인 힌트: 시스템 관리자만 "@" 없는 아이디(예: "admin")로 로그인한다.
    # 일반 사용자가 도메인 없이 아이디만 입력하면 samsung.com 을 붙이라고 안내.
    identifier = (payload.email or "").strip()
    if "@" not in identifier:
        admin = db.execute(
            select(User).where(User.email == identifier)
        ).scalar_one_or_none()
        if not (admin and admin.is_system_admin):
            access_log_services.record_access(
                db,
                email=identifier,
                success=False,
                event="login",
                request=request,
            )
            return error_response(
                "samsung.com 도메인을 함께 입력해주세요.",
                status_code=status.HTTP_401_UNAUTHORIZED,
            )
    user = auth_services.authenticate(db, payload.email, payload.password)
    if not user:
        # 실패도 남긴다(미가입 이메일 포함) — 이상 접속 확인용. user_id 없음.
        access_log_services.record_access(
            db,
            email=payload.email,
            success=False,
            event="login",
            request=request,
        )
        return error_response(
            "이메일 또는 비밀번호가 올바르지 않습니다.",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )
    token = auth_services.create_access_token(user.id)
    access_log_services.record_access(
        db,
        email=user.email,
        success=True,
        event="login",
        user_id=user.id,
        request=request,
    )
    return success_response(
        data=LoginResponse(
            access_token=token,
            expires_in=int(settings.jwt_access_token_expires.total_seconds()),
            user_id=user.id,
            email=user.email,
            name=user.name,
            must_change_password=user.must_change_password,
        )
    )


@router.post("/password-reset-requests", status_code=status.HTTP_202_ACCEPTED)
def request_password_reset(
    payload: PasswordResetRequestCreate, db: Session = Depends(get_db)
):
    """공개 '비밀번호 찾기' 접수.

    셀프 재설정이 켜져 있고(password_self_reset_enabled) 메일이 실제로 도달할
    수 있으면(mailer.is_active) 가입 계정에 재설정 링크를 보낸다. 둘 중 하나라도
    아니면 관리자 중개 큐에 쌓는다 — 요청이 조용히 사라지면 안 된다.

    보안: 이메일 가입 여부를 응답으로 노출하지 않는다(항상 202/동일 메시지).
    """
    from app.mailer import service as mail_service

    email = payload.email.strip().lower()
    user = db.execute(
        select(User).where(User.email == email)
    ).scalar_one_or_none()

    if settings.password_self_reset_enabled and mail_service.is_active():
        # 셀프 재설정 — 가입 계정에만 실제 발송(미가입이면 조용히 넘어감).
        if user is not None and user.is_active and "@" in (user.email or ""):
            raw = auth_services.create_password_reset_token(db, user)
            base = settings.email_base_url
            reset_url = f"{base}/reset-password?token={raw}" if base else raw
            mail_service.enqueue_email(
                db,
                to=user.email,
                template="password_reset",
                context={
                    "url": reset_url,
                    "name": user.name,
                    "expires_minutes": auth_services.PASSWORD_RESET_EXPIRE_MINUTES,
                },
            )
            db.commit()
        return success_response(
            data=None,
            message="해당 이메일로 가입된 계정이 있으면 비밀번호 재설정 링크를 보냈습니다.",
        )

    # 폴백: 관리자 중개 큐(메일 인프라 미설정). 같은 이메일 pending 중복 방지.
    existing = db.execute(
        select(PasswordResetRequest).where(
            PasswordResetRequest.email == email,
            PasswordResetRequest.status == PasswordResetStatus.pending,
        )
    ).first()
    if existing is None:
        db.add(
            PasswordResetRequest(
                email=email,
                user_id=user.id if user else None,
                status=PasswordResetStatus.pending,
            )
        )
        db.commit()
    return success_response(
        data=None,
        message="요청이 접수되었습니다. 부서 관리자가 확인 후 처리합니다.",
    )


@router.post("/password-reset/confirm")
def confirm_password_reset(
    payload: PasswordResetConfirm, request: Request, db: Session = Depends(get_db)
):
    """이메일 링크의 토큰으로 새 비밀번호를 설정한다. 토큰은 1회용·만료."""
    user = auth_services.consume_password_reset_token(db, payload.token.strip())
    if user is None:
        return error_response(
            "링크가 만료되었거나 이미 사용되었습니다. 다시 요청해주세요.",
            status_code=status.HTTP_400_BAD_REQUEST,
        )
    user.password_hash = auth_services.hash_password(payload.new_password)
    user.must_change_password = False
    db.commit()
    access_log_services.record_access(
        db,
        email=user.email,
        success=True,
        event="password_reset",
        user_id=user.id,
        request=request,
    )
    return success_response(
        data=None, message="비밀번호가 변경되었습니다. 새 비밀번호로 로그인하세요."
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
def signup(payload: SignupRequest, request: Request, db: Session = Depends(get_db)):
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

    # 가입 = 첫 접속. 로그인 이력과 같은 표에 'signup' 으로 남긴다.
    access_log_services.record_access(
        db,
        email=user.email,
        success=True,
        event="signup",
        user_id=user.id,
        request=request,
    )

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
