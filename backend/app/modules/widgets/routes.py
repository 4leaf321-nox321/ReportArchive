"""Widget catalog endpoint — exposes the widget registry to the frontend.

The frontend uses this to populate the template builder palette and to
mirror per-widget validation hints. Authentication required (any user)
since this isn't sensitive but isn't public either.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends

from app.modules.users.models import User
from app.shared.auth import get_current_user_no_workspace
from app.shared.responses import success_response
from app.widgets import TEMPLATE_SCHEMA_VERSION, list_widget_descriptors

router = APIRouter()


@router.get("")
def list_widgets(_: User = Depends(get_current_user_no_workspace)):
    return success_response(
        data={
            "schema_version": TEMPLATE_SCHEMA_VERSION,
            "widgets": list_widget_descriptors(),
        }
    )
