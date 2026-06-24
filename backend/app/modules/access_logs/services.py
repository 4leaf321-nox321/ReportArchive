"""Access-log writes (login/signup) + admin reads.

기록(record_access)은 인증 흐름 끝에서 호출된다 — 감사 로그 실패가 로그인
자체를 막으면 안 되므로 모든 예외를 삼키고 경고만 남긴다.
"""
from __future__ import annotations

import logging
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.modules.access_logs.models import UserAccessLog
from app.modules.access_logs.schemas import (
    AccessLogBreakdownResponse,
    AccessLogPage,
    AccessLogRead,
    AccessLogStatPoint,
    AccessLogStatsResponse,
    AccessLogUserCount,
)
from app.modules.users.models import User
from app.modules.workspaces.models import Workspace

logger = logging.getLogger(__name__)

# 접속 통계는 한국 사용자 기준이라 KST(UTC+9) 벽시계로 버킷팅한다. created_at 은
# naive UTC 로 저장되므로 +9h 해서 naive KST 로 바꿔 일/주/월 경계를 가른다.
_KST_OFFSET = timedelta(hours=9)
_STATS_DEFAULT_PERIODS = {"day": 14, "week": 12, "month": 12}
_STATS_MAX_PERIODS = {"day": 31, "week": 26, "month": 24}
_STATS_UNASSIGNED = "미지정"

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


def _bucket_start(granularity: str, kst_dt: datetime) -> datetime:
    """주어진 naive KST 시각이 속한 버킷의 시작(자정 / 그 주 월요일 / 1일)."""
    day = kst_dt.replace(hour=0, minute=0, second=0, microsecond=0)
    if granularity == "week":
        return day - timedelta(days=day.weekday())  # 월요일
    if granularity == "month":
        return day.replace(day=1)
    return day  # day


def _bucket_step_back(granularity: str, start: datetime, n: int) -> datetime:
    """버킷 시작 `start` 에서 n 버킷 과거로 이동한 버킷 시작."""
    if granularity == "week":
        return start - timedelta(weeks=n)
    if granularity == "month":
        total = (start.year * 12 + (start.month - 1)) - n
        return start.replace(year=total // 12, month=(total % 12) + 1, day=1)
    return start - timedelta(days=n)  # day


def _bucket_label(granularity: str, start: datetime) -> str:
    if granularity == "month":
        return f"{start.year}.{start.month:02d}"
    if granularity == "week":
        return f"{start.month}/{start.day}~"  # 주 시작(월요일)
    return f"{start.month}/{start.day}"


def access_log_stats(
    db: Session,
    *,
    granularity: str = "day",
    periods: Optional[int] = None,
    success: Optional[bool] = True,
) -> AccessLogStatsResponse:
    """부서별·기간별 접속 통계 — 막대그래프용. success=True(성공만, 기본)/
    False(실패만)/None(전체)로 좁힐 수 있다. 부서는 사용자의 홈 부서
    (User.home_workspace_slug → Workspace.name)로 정하고, 홈 부서가 없으면
    '미지정'으로 묶는다. 일/주/월 버킷은 KST 벽시계 기준."""
    if granularity not in _STATS_DEFAULT_PERIODS:
        granularity = "day"
    n = periods or _STATS_DEFAULT_PERIODS[granularity]
    n = max(1, min(int(n), _STATS_MAX_PERIODS[granularity]))

    now_kst = datetime.utcnow() + _KST_OFFSET
    cur_start = _bucket_start(granularity, now_kst)
    first_start = _bucket_step_back(granularity, cur_start, n - 1)
    # 쿼리 하한(naive UTC) — 첫 버킷 시작(KST)을 UTC 로 환산.
    window_start_utc = first_start - _KST_OFFSET

    # 시간순 버킷 골격(데이터 없는 구간도 0으로 채워 연속 축을 만든다).
    bucket_order: list[datetime] = [
        _bucket_step_back(granularity, cur_start, n - 1 - i) for i in range(n)
    ]
    bucket_set = set(bucket_order)
    labels = {b: _bucket_label(granularity, b) for b in bucket_order}

    ws_names = dict(db.execute(select(Workspace.slug, Workspace.name)).all())

    q = (
        select(UserAccessLog.created_at, User.home_workspace_slug)
        .join(User, User.id == UserAccessLog.user_id, isouter=True)
        .where(UserAccessLog.created_at >= window_start_utc)
    )
    if success is not None:
        q = q.where(UserAccessLog.success.is_(success))
    rows = db.execute(q).all()

    tally: dict[datetime, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    dept_totals: dict[str, int] = defaultdict(int)
    for created_at, home_slug in rows:
        bkey = _bucket_start(granularity, created_at + _KST_OFFSET)
        if bkey not in bucket_set:  # 경계 밖(드묾) 방어
            continue
        dept = (ws_names.get(home_slug) if home_slug else None) or _STATS_UNASSIGNED
        tally[bkey][dept] += 1
        dept_totals[dept] += 1

    # 스택 순서 — 전체 건수 내림차순, '미지정'은 항상 마지막.
    departments = sorted(
        dept_totals.keys(),
        key=lambda d: (d == _STATS_UNASSIGNED, -dept_totals[d], d),
    )

    points = [
        AccessLogStatPoint(
            label=labels[b],
            bucket_start=b.strftime("%Y-%m-%d"),
            total=sum(tally.get(b, {}).values()),
            counts=dict(tally.get(b, {})),
        )
        for b in bucket_order
    ]
    return AccessLogStatsResponse(
        granularity=granularity,
        success=success,
        departments=departments,
        points=points,
    )


def access_log_user_breakdown(
    db: Session,
    *,
    granularity: str,
    bucket_start: str,
    department: Optional[str] = None,
    success: Optional[bool] = True,
) -> AccessLogBreakdownResponse:
    """드릴다운 — 한 버킷(+선택한 부서) 안에서 사용자별 접속 횟수(내림차순).
    bucket_start 는 access_log_stats 가 준 'YYYY-MM-DD'(KST 버킷 시작).
    department=None 이면 버킷 전체, '미지정'이면 홈 부서 없는 접속만."""
    if granularity not in _STATS_DEFAULT_PERIODS:
        granularity = "day"
    try:
        start_kst = datetime.strptime(bucket_start, "%Y-%m-%d")
    except (ValueError, TypeError):
        return AccessLogBreakdownResponse(total=0, users=[])
    start_kst = _bucket_start(granularity, start_kst)
    end_kst = _bucket_step_back(granularity, start_kst, -1)  # 다음 버킷 시작
    start_utc = start_kst - _KST_OFFSET
    end_utc = end_kst - _KST_OFFSET

    cnt = func.count().label("cnt")
    q = (
        select(
            UserAccessLog.user_id,
            UserAccessLog.email,
            Workspace.name,
            cnt,
        )
        .join(User, User.id == UserAccessLog.user_id, isouter=True)
        .join(Workspace, Workspace.slug == User.home_workspace_slug, isouter=True)
        .where(UserAccessLog.created_at >= start_utc)
        .where(UserAccessLog.created_at < end_utc)
    )
    if success is not None:
        q = q.where(UserAccessLog.success.is_(success))
    if department == _STATS_UNASSIGNED:
        q = q.where(Workspace.name.is_(None))
    elif department is not None:
        q = q.where(Workspace.name == department)
    q = q.group_by(
        UserAccessLog.user_id, UserAccessLog.email, Workspace.name
    ).order_by(cnt.desc())
    rows = db.execute(q).all()

    ids = {uid for uid, _, _, _ in rows if uid is not None}
    names: dict[int, str] = {}
    if ids:
        for uid, uname in db.execute(
            select(User.id, User.name).where(User.id.in_(ids))
        ):
            names[uid] = uname

    users = [
        AccessLogUserCount(
            user_id=uid,
            name=names.get(uid) if uid is not None else None,
            email=email,
            department=dept_name or _STATS_UNASSIGNED,
            count=int(c),
        )
        for uid, email, dept_name, c in rows
    ]
    return AccessLogBreakdownResponse(
        total=sum(u.count for u in users), users=users
    )
