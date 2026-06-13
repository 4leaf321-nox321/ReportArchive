"""Access-log writes (login/signup) + admin reads.

기록(record_access)은 인증 흐름 끝에서 호출된다 — 감사 로그 실패가 로그인
자체를 막으면 안 되므로 모든 예외를 삼키고 경고만 남긴다.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.modules.access_logs.models import UserAccessLog
from app.modules.access_logs.schemas import AccessLogPage, AccessLogRead
from app.modules.users.models import User

logger = logging.getLogger(__name__)

# 세션 복원(/api/me)으로 들어오는 '접속'은 페이지마다 잦으므로, 같은 사용자가
# 이 간격 이내에 이미 기록됐으면 새 행을 만들지 않는다(도배 방지 + 방문 경계
# 근사). 로그인 직후의 /me 도 방금 쓴 login 행 덕분에 자연히 생략된다.
SESSION_LOG_THROTTLE = timedelta(minutes=30)


def client_info(request) -> tuple[Optional[str], Optional[str]]:
    """FastAPI Request → (ip, user_agent).

    역방향 프록시(nginx) 뒤에서는 request.client.host 가 127.0.0.1 이라
    의미가 없다. X-Forwarded-For 의 첫 홉을 진짜 클라이언트 IP 로 본다.
    """
    if request is None:
        return None, None
    ip: Optional[str] = None
    xff = request.headers.get("x-forwarded-for")
    if xff:
        ip = (xff.split(",")[0] or "").strip() or None
    if not ip and request.client:
        ip = request.client.host
    ua = request.headers.get("user-agent")
    return (ip[:64] if ip else None), (ua[:512] if ua else None)


def record_access(
    db: Session,
    *,
    email: str,
    success: bool,
    event: str = "login",
    user_id: Optional[int] = None,
    request=None,
    ip: Optional[str] = None,
    user_agent: Optional[str] = None,
) -> None:
    """접속 시도 1건 기록(커밋 포함). 로깅 실패는 삼킨다(rollback + 경고)."""
    if request is not None and (ip is None or user_agent is None):
        r_ip, r_ua = client_info(request)
        ip = ip or r_ip
        user_agent = user_agent or r_ua
    try:
        db.add(
            UserAccessLog(
                user_id=user_id,
                email=(email or "").strip().lower()[:255],
                event=event,
                success=success,
                ip_address=ip,
                user_agent=user_agent,
            )
        )
        db.commit()
    except Exception:  # noqa: BLE001 — 감사 로그가 인증 흐름을 깨면 안 됨
        db.rollback()
        logger.warning("failed to record user access log", exc_info=True)


def touch_session(
    db: Session,
    *,
    user_id: int,
    email: str,
    request=None,
    ip: Optional[str] = None,
    user_agent: Optional[str] = None,
    throttle: timedelta = SESSION_LOG_THROTTLE,
) -> None:
    """세션 복원(/api/me)으로 다시 들어온 '접속'을 event='resume' 로 기록.

    단, 같은 사용자가 throttle 이내에 이미 기록됐으면 생략한다 — /api/me 가
    페이지마다 불려도 도배되지 않고, 로그인 직후의 /me 도 방금 쓴 login 행
    때문에 자연히 건너뛴다. '로그인 유지'로 토큰만 들고 재방문하는 사용자가
    이력에 안 잡히던 공백을 메운다.
    """
    try:
        last = db.execute(
            select(func.max(UserAccessLog.created_at)).where(
                UserAccessLog.user_id == user_id
            )
        ).scalar_one_or_none()
    except Exception:  # noqa: BLE001 — 조회 실패가 /me 를 막으면 안 됨
        db.rollback()
        last = None
    if last is not None and (datetime.utcnow() - last) < throttle:
        return
    record_access(
        db,
        email=email,
        success=True,
        event="resume",
        user_id=user_id,
        request=request,
        ip=ip,
        user_agent=user_agent,
    )


def list_access_logs(
    db: Session,
    *,
    limit: int = 50,
    offset: int = 0,
    user_id: Optional[int] = None,
    success: Optional[bool] = None,
) -> AccessLogPage:
    """최근 접속 이력(최신순) + 총건수. user_id / success 로 좁힐 수 있다.
    표시용 이름은 현재 User 에서 한 번에 매핑(계정 삭제 시 None)."""
    base = select(UserAccessLog)
    count_q = select(func.count()).select_from(UserAccessLog)
    if user_id is not None:
        base = base.where(UserAccessLog.user_id == user_id)
        count_q = count_q.where(UserAccessLog.user_id == user_id)
    if success is not None:
        base = base.where(UserAccessLog.success.is_(success))
        count_q = count_q.where(UserAccessLog.success.is_(success))

    total = int(db.execute(count_q).scalar_one())
    rows = list(
        db.execute(
            base.order_by(
                UserAccessLog.created_at.desc(), UserAccessLog.id.desc()
            )
            .limit(limit)
            .offset(offset)
        ).scalars()
    )

    ids = {r.user_id for r in rows if r.user_id is not None}
    names: dict[int, str] = {}
    if ids:
        for uid, uname in db.execute(
            select(User.id, User.name).where(User.id.in_(ids))
        ):
            names[uid] = uname

    items = [
        AccessLogRead(
            id=r.id,
            user_id=r.user_id,
            name=names.get(r.user_id) if r.user_id is not None else None,
            email=r.email,
            event=r.event,
            success=r.success,
            ip_address=r.ip_address,
            user_agent=r.user_agent,
            created_at=r.created_at,
        )
        for r in rows
    ]
    return AccessLogPage(items=items, total=total)
