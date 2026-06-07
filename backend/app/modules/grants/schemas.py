"""공유(grant) API 스키마."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, model_validator

from app.modules.grants.models import GrantLevel, GrantPrincipalType


class GrantRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    principal_type: GrantPrincipalType
    principal_ref: Optional[str] = None
    # 사람이 읽는 라벨 — 부서명 / 사용자명 / "전체 공개". 라우트가 채운다.
    principal_label: Optional[str] = None
    level: GrantLevel
    created_by_user_id: Optional[int] = None
    created_by_name: Optional[str] = None
    created_at: datetime


class GrantCreate(BaseModel):
    principal_type: GrantPrincipalType
    principal_ref: Optional[str] = None
    level: GrantLevel = GrantLevel.view

    @model_validator(mode="after")
    def _normalize(self) -> "GrantCreate":
        # all_org 는 대상 ref 없음 + view 전용(공개 열람).
        if self.principal_type == GrantPrincipalType.all_org:
            self.principal_ref = None
            self.level = GrantLevel.view
        else:
            if not self.principal_ref:
                raise ValueError("principal_ref is required for workspace/user grants")
        return self
