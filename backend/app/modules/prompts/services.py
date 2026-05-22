"""Business logic for AI prompts."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.modules.prompts.models import Prompt, PromptStatus
from app.modules.prompts.schemas import PromptCreate, PromptUpdate


def find_by_name_ci(db: Session, name: str) -> Optional[Prompt]:
    """Case-insensitive name lookup — prevents near-duplicate names like
    '주간보고 v3' / '주간 보고 v3' from sneaking in through the picker."""
    return db.execute(
        select(Prompt).where(func.lower(Prompt.name) == name.strip().lower())
    ).scalar_one_or_none()


def list_visible(
    db: Session,
    *,
    user_id: int,
    is_admin: bool,
    q: Optional[str] = None,
    limit: int = 200,
) -> list[Prompt]:
    """List prompts the user can pick from.

    - Admin: sees everything (official + all unofficial) so they can
      reuse another user's pending prompt without re-creating it.
    - Non-admin: official + own unofficial.

    `q` does case-insensitive substring match on name + description so
    the picker can drive its filter server-side.
    """
    stmt = select(Prompt)
    if not is_admin:
        stmt = stmt.where(
            or_(
                Prompt.status == PromptStatus.official,
                Prompt.created_by_user_id == user_id,
            )
        )
    if q:
        needle = f"%{q.strip().lower()}%"
        stmt = stmt.where(
            or_(
                func.lower(Prompt.name).like(needle),
                func.lower(Prompt.description).like(needle),
            )
        )
    stmt = stmt.order_by(Prompt.status.desc(), Prompt.name).limit(limit)
    return list(db.execute(stmt).scalars())


def list_all_for_admin(
    db: Session, *, q: Optional[str] = None, limit: int = 500
) -> list[Prompt]:
    stmt = select(Prompt)
    if q:
        needle = f"%{q.strip().lower()}%"
        stmt = stmt.where(
            or_(
                func.lower(Prompt.name).like(needle),
                func.lower(Prompt.description).like(needle),
            )
        )
    # Unofficial first so triage items surface at the top of the admin tab.
    stmt = stmt.order_by(Prompt.status.asc(), Prompt.created_at.desc()).limit(limit)
    return list(db.execute(stmt).scalars())


def get(db: Session, prompt_id: int) -> Optional[Prompt]:
    return db.get(Prompt, prompt_id)


def create(
    db: Session,
    payload: PromptCreate,
    *,
    creator_user_id: int,
    is_admin: bool,
) -> Prompt:
    name = payload.name.strip()
    if not name:
        raise ValueError("이름은 비워둘 수 없습니다.")
    existing = find_by_name_ci(db, name)
    if existing is not None:
        # Same idempotency contract as report_types: if the name already
        # exists, hand the existing row back so the picker links to the
        # canonical entry instead of erroring out.
        return existing

    # Admin creating from the admin tab → official by default (they can
    # still pass `status=unofficial` to seed a triage row if needed).
    # Non-admins always create unofficial — promotion is a separate
    # admin-only action.
    if is_admin:
        status_ = (
            payload.status if payload.status is not None else PromptStatus.official
        )
    else:
        status_ = PromptStatus.unofficial

    now = datetime.utcnow()
    row = Prompt(
        name=name,
        description=(payload.description or "").strip(),
        body=payload.body or "",
        settings=payload.settings or {},
        status=status_,
        created_by_user_id=creator_user_id,
        approved_by_user_id=(
            creator_user_id if status_ == PromptStatus.official else None
        ),
        approved_at=now if status_ == PromptStatus.official else None,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def update(db: Session, row: Prompt, payload: PromptUpdate) -> Prompt:
    data = payload.model_dump(exclude_unset=True)
    if "name" in data and data["name"] is not None:
        new_name = data["name"].strip()
        if not new_name:
            raise ValueError("이름은 비워둘 수 없습니다.")
        clash = db.execute(
            select(Prompt).where(
                func.lower(Prompt.name) == new_name.lower(),
                Prompt.id != row.id,
            )
        ).scalar_one_or_none()
        if clash is not None:
            raise ValueError(f"이미 같은 이름의 프롬프트가 있습니다: {clash.name}")
        row.name = new_name
    if "description" in data and data["description"] is not None:
        row.description = data["description"].strip()
    if "body" in data and data["body"] is not None:
        row.body = data["body"]
    if "settings" in data and data["settings"] is not None:
        row.settings = data["settings"]
    db.commit()
    db.refresh(row)
    return row


def promote(db: Session, row: Prompt, approver_user_id: int) -> Prompt:
    if row.status == PromptStatus.official:
        return row
    row.status = PromptStatus.official
    row.approved_by_user_id = approver_user_id
    row.approved_at = datetime.utcnow()
    db.commit()
    db.refresh(row)
    return row


def demote(db: Session, row: Prompt) -> Prompt:
    """Reverse a promote — admin can flag a prompt back to unofficial
    without deleting it (e.g. they want the author to revise the name
    first). Nothing else references prompts as FKs, so demotion is a
    pure status flip."""
    if row.status == PromptStatus.unofficial:
        return row
    row.status = PromptStatus.unofficial
    row.approved_by_user_id = None
    row.approved_at = None
    db.commit()
    db.refresh(row)
    return row


def delete(db: Session, row: Prompt) -> None:
    """Delete a prompt. Nothing in the schema FKs to prompts (the picker
    in the report editor just copies the body to the clipboard), so
    deletes are unconstrained."""
    db.delete(row)
    db.commit()
