"""데모용 외부 시스템 API (커넥터 연동 실습).

외부 PLM/시험관리 시스템을 흉내 낸 아주 작은 JSON API. 표준 라이브러리만 쓰며(의존성 0),
외부 시스템 연계 커넥터(/admin/connectors)로 붙여 온톨로지를 채우는 걸 실습할 수 있다.

실행:
    python scripts/sample_external_api.py            # 8099 포트
    python scripts/sample_external_api.py 9000        # 임의 포트

엔드포인트:
    GET /api/suppliers  → {"data": {"items": [ {code,name,tier}, ... ]}}
    GET /api/projects   → {"data": {"items": [ {id,name,status,phase,budget,supplier{code,name}}, ... ]}}

커넥터 매핑 예시(과제):
    base_url        http://127.0.0.1:8099
    endpoint_path   /api/projects
    records_path    data.items
    대상 축         (record 축, 예: '과제')
    value_path      name
    속성 매핑       status ← status,  phase ← phase,  budget ← budget
    관계 매핑       (관계) · 대상 축=공급사 · path=supplier.code

인증 실습을 원하면 REQUIRE_TOKEN 을 켜라(아래) — 그러면 커넥터에서 Bearer 'demo-token-123'
을 설정해야 200 이 온다.
"""
from __future__ import annotations

import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# True 로 바꾸면 Authorization: Bearer demo-token-123 을 요구(인증 실습).
REQUIRE_TOKEN = False
DEMO_TOKEN = "demo-token-123"

SUPPLIERS = [
    {"code": "SUP-A", "name": "LG에너지솔루션", "tier": "1"},
    {"code": "SUP-B", "name": "삼성SDI", "tier": "1"},
    {"code": "SUP-C", "name": "한국단자공업", "tier": "2"},
]

PROJECTS = [
    {
        "id": "PRJ-001",
        "name": "차세대 배터리 개발",
        "status": "진행중",
        "phase": "설계",
        "budget": 1200,
        "supplier": {"code": "SUP-A", "name": "LG에너지솔루션"},
    },
    {
        "id": "PRJ-002",
        "name": "전장 커넥터 표준화",
        "status": "진행중",
        "phase": "검증",
        "budget": 350,
        "supplier": {"code": "SUP-C", "name": "한국단자공업"},
    },
    {
        "id": "PRJ-003",
        "name": "고전압 시스템 안전성",
        "status": "완료",
        "phase": "양산",
        "budget": 800,
        "supplier": {"code": "SUP-B", "name": "삼성SDI"},
    },
]

ROUTES = {
    "/api/suppliers": SUPPLIERS,
    "/api/projects": PROJECTS,
}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 (BaseHTTPRequestHandler 규약)
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        if REQUIRE_TOKEN:
            auth = self.headers.get("Authorization", "")
            if auth != f"Bearer {DEMO_TOKEN}":
                self._send(401, {"error": "unauthorized"})
                return
        items = ROUTES.get(path)
        if items is None:
            self._send(404, {"error": f"unknown path: {path}"})
            return
        self._send(200, {"data": {"items": items}, "count": len(items)})

    def log_message(self, *args) -> None:  # 조용히(요청 로그 스팸 방지)
        pass


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8099
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"샘플 외부 API 실행 중 → http://127.0.0.1:{port}")
    print(f"  GET /api/suppliers  ({len(SUPPLIERS)}건)")
    print(f"  GET /api/projects   ({len(PROJECTS)}건)")
    print("  Ctrl+C 로 종료")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n종료")
        server.shutdown()


if __name__ == "__main__":
    main()
