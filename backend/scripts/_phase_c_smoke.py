"""End-to-end smoke test for Phase C: create a widget-v1 report against the
seeded weekly-dev template, post valid + invalid content payloads, verify
the API rejects bad content with a useful error message.

Run with backend already up on :3000:
    python scripts/_phase_c_smoke.py

Exits 0 on success, prints diagnostics on failure.
"""
from __future__ import annotations

import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import requests

API = "http://localhost:3000/api"


def login() -> str:
    r = requests.post(
        f"{API}/auth/login",
        json={"email": "admin", "password": "32167"},
        timeout=5,
    )
    r.raise_for_status()
    return r.json()["data"]["access_token"]


def headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "X-Workspace-Slug": "dev"}


def create_report(token: str, payload: dict) -> requests.Response:
    return requests.post(f"{API}/reports", json=payload, headers=headers(token), timeout=5)


def main() -> int:
    token = login()
    print("[OK] login")

    # Round-trip a valid widget-v1 report against weekly-dev.
    valid_content = {
        "meta": {"period": "2026-W19", "team": "dev", "owner": "테스터"},
        "summary": {"markdown": "이번 주 핵심 요약."},
        "progress": {"items": ["기능 A 출시", "장애 대응 완료"]},
        "issues": {
            "rows": [
                {"issue": "성능 저하", "severity": "보통", "owner": "홍길동"}
            ]
        },
        "next_week": {"items": ["기능 B 설계"]},
    }
    r = create_report(
        token,
        {
            "template_id": "weekly-dev",
            "template_version": 1,
            "title": "Phase C smoke",
            "tags": ["smoke"],
            "content": valid_content,
        },
    )
    if r.status_code not in (200, 201):
        print(f"[ERR] valid create failed: {r.status_code} {r.text}")
        return 1
    report_id = r.json()["data"]["id"]
    print(f"[OK] valid report created: id={report_id}")

    # Cleanup the smoke report so re-runs stay clean.
    d = requests.delete(f"{API}/reports/{report_id}", headers=headers(token), timeout=5)
    if d.status_code not in (200, 204):
        print(f"[..] cleanup status {d.status_code} (non-fatal)")
    else:
        print("[OK] cleanup")

    # Bad content: required key_value field missing.
    bad_missing = {
        "template_id": "weekly-dev",
        "template_version": 1,
        "title": "x",
        "content": {"meta": {"period": "x"}},  # missing 'team' and 'owner'
    }
    r = create_report(token, bad_missing)
    if r.status_code != 400:
        print(f"[ERR] expected 400 for missing required, got {r.status_code}: {r.text}")
        return 1
    msg = r.json().get("message", "")
    if "meta" not in msg:
        print(f"[ERR] error message should mention block 'meta', got: {msg}")
        return 1
    print(f"[OK] missing-required rejected: {msg!r}")

    # Bad content: enum violation in select.
    bad_enum = {
        "template_id": "weekly-dev",
        "template_version": 1,
        "title": "x",
        "content": {
            "meta": {"period": "x", "team": "dev", "owner": "x"},
            "issues": {"rows": [{"issue": "x", "severity": "GHOST"}]},
        },
    }
    r = create_report(token, bad_enum)
    if r.status_code != 400:
        print(f"[ERR] expected 400 for bad enum, got {r.status_code}: {r.text}")
        return 1
    print(f"[OK] enum-violation rejected: {r.json().get('message')!r}")

    # Bad content: unknown block id.
    bad_block = {
        "template_id": "weekly-dev",
        "template_version": 1,
        "title": "x",
        "content": {"ghost_block": {"x": 1}},
    }
    r = create_report(token, bad_block)
    if r.status_code != 400:
        print(f"[ERR] expected 400 for unknown block, got {r.status_code}: {r.text}")
        return 1
    print(f"[OK] unknown-block rejected: {r.json().get('message')!r}")

    print()
    print("[DONE] Phase C smoke passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
