"""메일러 — 나가는 이메일 발송(SMTP 클라이언트).

플랫폼은 메일 서버가 아니라, 기존 SMTP 릴레이에 접속해 알림/비밀번호
재설정 등 나가는 메일만 보낸다. 모든 발송은 작업 큐의 `send_email` 잡을
경유해 비동기·재시도·관리자 가시성을 얻는다(인라인 발송 금지).

공개 API:
  - enqueue_email(session, ...) — 메일 발송 잡 적재(라우트/서비스에서 호출)
  - send_now(...) — 실제 발송(잡 핸들러가 호출; 백엔드 분기)
  - status() — 관리자 화면용 설정 상태
  - OUTBOX — mock 백엔드가 채우는 테스트용 발송 기록
"""
from app.mailer.service import OUTBOX, enqueue_email, is_active, send_now, status

__all__ = ["OUTBOX", "enqueue_email", "is_active", "send_now", "status"]
