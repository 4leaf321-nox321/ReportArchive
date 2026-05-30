"""보고서 link kind 의 보조 유틸리티.

phase 14 이후 link 종류 카탈로그는 DB (``report_link_kinds`` 테이블) 가
권위 — 코드 상수 LINK_KINDS 는 제거되었다. 여기엔 화면 색 화이트리스트만
남아 admin 이 입력하는 color 값을 검증하는 데 쓰인다 (Tailwind purge 가
정적 분석에 의존하므로 임의 hex 는 허용 불가).
"""
from __future__ import annotations


# 프론트엔드 `shared/reports/linkKinds.js` 의 COLOR_CLASSES 키와 일치해야
# 한다. 새 색을 도입하려면 양쪽 다 entry 를 추가.
ALLOWED_COLORS: set[str] = {
    "blue",
    "green",
    "purple",
    "amber",
    "slate",
    "rose",
    "sky",
    "teal",
    "orange",
    "pink",
}


def is_valid_color(color: str) -> bool:
    return color in ALLOWED_COLORS
