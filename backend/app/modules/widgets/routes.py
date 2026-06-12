"""Widget catalog endpoint — exposes the widget registry to the frontend.

The frontend uses this to populate the template builder palette and to
mirror per-widget validation hints. Authentication required (any user)
since this isn't sensitive but isn't public either.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from app.modules.users.models import User
from app.shared.auth import get_current_user_no_workspace
from app.shared.responses import success_response
from app.widgets import (
    TEMPLATE_SCHEMA_VERSION,
    authoring_rules,
    list_ref_categories,
    list_widget_descriptors,
)

router = APIRouter()


@router.get("")
def list_widgets(_: User = Depends(get_current_user_no_workspace)):
    return success_response(
        data={
            "schema_version": TEMPLATE_SCHEMA_VERSION,
            "widgets": list_widget_descriptors(),
            "ref_categories": list_ref_categories(),
        }
    )


@router.get("/authoring-rules")
def widget_authoring_rules(
    types: list[str] | None = Query(default=None),
    _: User = Depends(get_current_user_no_workspace),
):
    """위젯 작성 상세 룰(AI 프롬프트용) — **단일 소스**(authoring_rules.json).
    프런트 '복사용 프롬프트'와 MCP(describe_template/describe_widgets)가 같이 쓴다.
    `types` 지정 시 그 위젯들 + 전역 preamble, 미지정 시 전체."""
    text = (
        authoring_rules.rules_for_types(types)
        if types
        else authoring_rules.all_rules_text()
    )
    return success_response(
        data={
            "preamble": authoring_rules.preamble(),
            "rules_text": text,
            "covered_types": sorted(authoring_rules.covered_types()),
        }
    )
