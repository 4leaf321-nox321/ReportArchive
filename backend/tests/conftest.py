"""테스트 공용 픽스처.

⚠️ **이 스위트는 별도 테스트 DB 없이 dev DB 에 직접 붙는다**(아래 참고). 그래서
"DB 에 저장되는 상태"는 테스트 사이에 새어 나간다. 특히 기능 플래그(app_settings)가
그랬다 — 아래 `_clean_app_settings` 주석 참고.

이 저장소의 통합 테스트들은 별도 테스트 DB 를 띄우지 않고 settings.database_url
이 가리키는 (개발) DB 에 직접 붙는다. 일부 오래된 테스트가 사용자 id 2(seeded
admin)·id 3(seeded manager)를 하드코딩하는데, 현재 시드는 id 1(admin)만 만든다
(scripts/seed_initial_data.py). 그래서 그 사용자가 없으면 인증이 401 로 떨어진다.

여기서 세션 시작 시 id 2·3 사용자를 **멱등하게 보장**해 그 간극을 메운다. 운영
시드와는 무관한 테스트 전용 보조이며, dev DB 에만 추가된다(분명히 식별되는
이메일). 근본적으로는 전용 테스트 DB + 결정적 시드(격리)가 정석이지만, 이 픽스처는
기존 테스트를 건드리지 않고 안전망을 되살리는 최소 조치다.
"""
from __future__ import annotations

import os
import sys

import pytest

# ⚠️ **app 을 import 하기 전에** 정해야 한다 — settings 는 import 시점에 굳는다.
#
# dev 의 .env 는 LLM_BACKEND=openai + LLM_BASE_URL=<Windows 호스트>:8080 을 가리킨다.
# 그 llama-server 가 안 떠 있으면 LLM 을 타는 테스트가 **connect 에서 매달려**
# 스위트가 통째로 멈춘다(실제로 15분을 넘겼고, 그 전엔 산발적 실패로 나타났다).
# 테스트는 LLM 응답의 내용이 아니라 배선을 검증하므로 mock 이 맞다. 진짜 LLM 을
# 태우려면 실행할 때 LLM_BACKEND 를 명시적으로 준다(환경변수가 .env 를 이긴다).
os.environ.setdefault("LLM_BACKEND", "mock")

from app.database import SessionLocal
from app.modules.auth.services import hash_password
from app.modules.users.models import Role, User, WorkspaceMember
from app.modules.workspaces.models import Workspace


# (id, email, name, is_system_admin) — 테스트가 가정하는 사용자.
_SEED_TEST_USERS = [
    (2, "test-admin-id2@seed.local", "테스트 관리자(id2)", True),
    (3, "test-manager-id3@seed.local", "테스트 매니저(id3)", False),
]
# 두 사용자에게 보장할 워크스페이스 멤버십(테스트가 X-Workspace-Slug 로 쓰는 것).
_SEED_MEMBER_WORKSPACES = ["dev", "dx"]


def _ensure_user(db, uid: int, email: str, name: str, is_admin: bool) -> None:
    if db.get(User, uid) is not None:
        return
    db.add(
        User(
            id=uid,
            email=email,
            name=name,
            password_hash=hash_password("test-password"),
            is_active=True,
            is_system_admin=is_admin,
        )
    )
    db.flush()


def _ensure_membership(db, uid: int, slug: str) -> None:
    if db.get(Workspace, slug) is None:
        return  # 해당 워크스페이스가 없으면 멤버십도 의미 없음(건너뜀)
    exists = (
        db.query(WorkspaceMember)
        .filter_by(user_id=uid, workspace_slug=slug)
        .first()
    )
    if exists is None:
        db.add(
            WorkspaceMember(user_id=uid, workspace_slug=slug, role=Role.manager)
        )


@pytest.fixture(scope="session", autouse=True)
def _seed_legacy_test_users():
    """id 2·3 사용자(+멤버십)를 세션 시작 시 한 번 보장."""
    db = SessionLocal()
    try:
        for uid, email, name, is_admin in _SEED_TEST_USERS:
            _ensure_user(db, uid, email, name, is_admin)
            for slug in _SEED_MEMBER_WORKSPACES:
                _ensure_membership(db, uid, slug)
        db.commit()
    finally:
        db.close()
    yield


# --------------------------------------------------------------------------- #
# app_settings(기능 플래그) 격리                                                 #
#                                                                              #
# 왜 필요한가 — 실제로 겪은 flakiness 의 원인:                                    #
#   1. 기능 플래그는 .env 가 아니라 **DB**(app_settings)에 저장되고, store 가 45초    #
#      TTL 로 캐시한다(store._TTL). 스위트 실행 시간이 43~57초라 딱 그 경계다.        #
#   2. 일부 테스트가 store.set_many() 로 플래그를 켜고 **되돌리지 않았다**            #
#      (예: test_app_settings 의 rag_rerank_enabled).                            #
#   3. 그 뒤 실행되는 테스트가 오염된 값을 본다. 45초가 지나면 캐시가 다시 로드돼      #
#      값이 또 바뀐다 → **어느 테스트가 어느 값을 보는지가 실행 속도에 따라 달라져**   #
#      매번 다른 테스트가 실패했다.                                                #
#   4. 하필 dev 서버엔 LLM 이 없어서, rag_auto_route_enabled 가 켜진 채로 남으면      #
#      에이전트 라우팅이 없는 LLM 을 호출해 타임아웃까지 매달린다(실행이 4배 느려짐).  #
#                                                                              #
# 대책 두 가지(둘 다 **테스트에만** 적용 — 운영 동작은 그대로):                      #
#   ⓐ 매 테스트 뒤 DB override 를 전부 지운다(아래 fixture).                       #
#   ⓑ 캐시 TTL 을 0 으로 — 캐시 경계 자체를 없애 타이밍 의존을 제거한다.             #
# --------------------------------------------------------------------------- #
# 세션 시작 시점의 override 스냅샷 — 테스트는 여기로 되돌린다.
_SETTINGS_BASELINE: dict = {}


@pytest.fixture(scope="session", autouse=True)
def _no_app_settings_cache():
    """ⓑ 테스트에서는 설정 캐시를 끈다(TTL 0 = 매번 DB 조회) + 기준선 스냅샷.

    캐시가 있으면 "DB 는 바뀌었는데 프로세스는 45초간 옛 값을 본다"는 창이 생기고,
    그 창의 위치가 실행 속도에 따라 달라져 재현이 안 되는 실패가 난다.
    운영의 TTL(45초)은 여러 프로세스 간 절충이라 그대로 둔다.
    """
    from app.modules.app_settings import store

    prev = store._TTL
    store._TTL = 0.0
    store.invalidate()

    global _SETTINGS_BASELINE
    _SETTINGS_BASELINE = store._load_overrides()
    if _SETTINGS_BASELINE:
        # 기준선이 비어 있지 않으면 알린다 — 개발자가 dev 화면에서 조정한 값일 수도,
        # 죽은 실행이 남긴 오염일 수도 있다. **조용히 지우지 않는다**(개발 환경의
        # 설정을 테스트가 말없이 날리면 안 된다). 오염이면 테스트가 깨져서 보인다.
        import warnings as _w
        _w.warn(
            f"app_settings 에 override 가 있습니다: {_SETTINGS_BASELINE}. "
            "테스트는 매 테스트 뒤 이 상태로 되돌립니다. 의도한 값이 아니면 지우세요.",
            stacklevel=1,
        )
    yield
    _restore_app_settings()
    store._TTL = prev


@pytest.fixture(autouse=True)
def _clean_app_settings():
    """ⓐ 테스트가 바꾼 DB override 를 **세션 시작 상태로** 되돌린다(테스트 뒤).

    통째로 지우지 않는 이유: 이 스위트는 dev DB 에 붙으므로, 개발자가 화면에서
    조정해 둔 설정을 테스트가 말없이 날려선 안 된다. 기준선과 다를 때만 손댄다.
    """
    yield
    _restore_app_settings()


def _restore_app_settings() -> None:
    """현재 override 를 _SETTINGS_BASELINE 과 일치시킨다(다를 때만 DB 를 건드림)."""
    from app.database import SessionLocal as _S
    from app.modules.app_settings import store
    from app.modules.app_settings.models import AppSetting

    if store._load_overrides() == _SETTINGS_BASELINE:
        return
    db = _S()
    try:
        db.query(AppSetting).delete()
        for key, value in _SETTINGS_BASELINE.items():
            store.set_many(db, {key: value}, None)
        db.commit()
        store.invalidate()
    finally:
        db.close()


# --------------------------------------------------------------------------- #
# 진단용 HTTP 로깅 (옵트인)                                                     #
#                                                                              #
# 왜 있나 — 전체 스위트를 돌리면 **가끔**(경험상 ~15%) 서로 다른 테스트가 몇 건씩   #
# `KeyError: 'data'` 로 깨진다. 성공 응답 대신 오류 응답이 온 것인데, 정작 **본문을 #
# 못 봐서** 원인을 못 밝혔다(재현이 어렵고 조용한 환경에선 잘 안 난다).            #
# 실패한 요청은 전부 관리자 토큰(user 2)으로 낸 것이었다는 것까지가 지금 아는 전부. #
#                                                                              #
# 그래서 다음 재발 때 한 번에 잡도록 훅만 남겨 둔다:                               #
#     RA_DEBUG_HTTP=1 pytest tests/ -q -s
# ⚠️ `-s` 가 **필수**다 — 없으면 pytest 가 stderr 를 캡처해 로그가 안 보인다(실측).
# 4xx/5xx 응답의 method·URL·본문(앞 300자)을 stderr 로 찍는다. 환경변수가 없으면    #
# 아무것도 안 하므로 평소 실행 비용은 0.                                          #
#                                                                              #
# ⚠️ 401/403 을 **의도적으로 검사하는** 테스트도 있어 로그에 정상 4xx 가 섞인다.    #
#    실패한 테스트 이름 근처의 줄을 보면 된다.                                     #
#                                                                              #
# (참고: 같은 flakiness 의 다른 원인 하나 — DB 저장 설정 오염 — 은 위 격리          #
#  픽스처로 이미 해결됐다. 여기 남은 건 그것과 별개의 잔여 원인이다.)              #
# --------------------------------------------------------------------------- #
if os.environ.get("RA_DEBUG_HTTP"):
    from starlette.testclient import TestClient as _TestClient

    _orig_request = _TestClient.request

    def _request_with_error_log(self, method, url, **kwargs):
        res = _orig_request(self, method, url, **kwargs)
        if res.status_code >= 400:
            body = (res.text or "")[:300].replace("\n", " ")
            print(f"\n[HTTP {res.status_code}] {method} {url} → {body}", file=sys.stderr)
        return res

    _TestClient.request = _request_with_error_log
