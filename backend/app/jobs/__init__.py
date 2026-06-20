"""백그라운드 작업 큐 (Job Queue).

웹 요청 경로에서 떼어내야 하는 무거운/지연 가능 작업을 Postgres `jobs`
테이블에 적재하고, 별도 워커 프로세스(`worker.py`)가 꺼내 처리한다.
Redis/Celery 등 외부 브로커 없이 기존 Postgres 만으로 동작한다.

설계: `백그라운드워커_설계.md`.
"""
