"""Pydantic schemas for templates.

Templates carry a JSON Schema document under `schema`. We don't model that
schema as a Pydantic shape — it's whatever JSON Schema 2020-12 allows. The
service layer uses jsonschema to validate the document is itself a valid
schema before saving.
"""
from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from pydantic import AliasChoices, BaseModel, ConfigDict, Field


class TemplateRead(BaseModel):
    """
    The Template model uses `schema` as the JSONB column name, which collides
    with Pydantic's `BaseModel.schema()` legacy method. We expose it through a
    `schema_definition` field on the Pydantic side and serialize it as "schema"
    via `serialization_alias` — and also populate via "schema" via
    `validation_alias` so model_validate() accepts dicts using either name.
    """

    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    template_id: str
    version: int
    name: str
    description: str
    category: str
    schema_definition: dict = Field(
        validation_alias=AliasChoices("schema_definition", "schema"),
        serialization_alias="schema",
    )
    owner_workspace_slugs: Optional[List[str]]
    is_published: bool
    is_latest: bool
    created_by_user_id: Optional[int]
    created_at: datetime

    @classmethod
    def from_orm_(cls, obj) -> "TemplateRead":
        return cls.model_validate(
            {
                "template_id": obj.template_id,
                "version": obj.version,
                "name": obj.name,
                "description": obj.description,
                "category": obj.category,
                "schema": obj.schema,
                "owner_workspace_slugs": obj.owner_workspace_slugs,
                "is_published": obj.is_published,
                "is_latest": obj.is_latest,
                "created_by_user_id": obj.created_by_user_id,
                "created_at": obj.created_at,
            }
        )


class TemplateCreate(BaseModel):
    """Create a new template (publishes as v1)."""

    template_id: str = Field(..., min_length=1, max_length=64, pattern=r"^[a-z0-9][a-z0-9-]*$")
    name: str = Field(..., min_length=1, max_length=255)
    description: str = ""
    category: str = "misc"
    schema_: dict = Field(..., alias="schema")
    # NULL or empty list = global. Otherwise visible to each workspace's tree.
    owner_workspace_slugs: Optional[List[str]] = None


class TemplateNewVersion(BaseModel):
    """Create a new version of an existing template."""

    name: Optional[str] = None
    description: Optional[str] = None
    category: Optional[str] = None
    schema_: dict = Field(..., alias="schema")


class TemplateScopeUpdate(BaseModel):
    """Replace a template's 공유 부서(visibility scope). Metadata only — does
    not bump the version. NULL/empty = 전사(global)."""

    owner_workspace_slugs: Optional[List[str]] = None


class TemplateVersionSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    version: int
    is_latest: bool
    is_published: bool
    created_at: datetime
