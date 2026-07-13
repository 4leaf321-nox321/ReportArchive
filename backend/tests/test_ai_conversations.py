"""대화 영구 저장 — 서비스 CRUD + 소유권 스코프."""
from app.database import SessionLocal
from app.modules.ai import conversations as cs


def test_conversation_crud_and_ownership():
    db = SessionLocal()
    conv = cs.create(db, 2, title="테스트", messages=[{"role": "user", "content": "안녕"}])
    try:
        assert conv.id
        # 내 목록에 있음.
        assert conv.id in [c.id for c in cs.list_for_user(db, 2)]
        # 소유자 조회 OK / 남은 차단(존재 비노출).
        assert cs.get_owned(db, conv.id, 2) is not None
        assert cs.get_owned(db, conv.id, 3) is None
        # 업데이트(메시지 통째 교체).
        cs.update(
            db, cs.get_owned(db, conv.id, 2),
            messages=[{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}],
        )
        assert len(cs.get_owned(db, conv.id, 2).messages) == 2
    finally:
        c = cs.get_owned(db, conv.id, 2)
        if c:
            cs.delete(db, c)
        db.close()
