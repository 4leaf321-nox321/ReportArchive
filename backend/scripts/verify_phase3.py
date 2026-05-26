"""Phase 3 verification — exercises can_edit() on every code path.

Run with:
    cd backend && ./venv/bin/python scripts/verify_phase3.py

Prints PASS/FAIL for each path. No DB writes — read-only checks against
the current dev state. Uses real users/workspaces/reports; if any path
can't be exercised with the current data, it's reported as SKIP with
guidance on how to set up.
"""
from __future__ import annotations

from sqlalchemy import select

from app.database import SessionLocal
from app.modules.editors.models import ReportEditor
from app.modules.mounts.models import MountEditPolicy, ReportMount
from app.modules.reports.models import Report
from app.modules.users.models import Role, User, WorkspaceMember
from app.shared.permissions import can_edit


def expect(label: str, decision, want_allowed: bool, want_role: str | None = None) -> bool:
    ok = decision.allowed == want_allowed
    if want_role is not None:
        ok = ok and decision.role == want_role
    mark = "✓ PASS" if ok else "✗ FAIL"
    role_part = f" role={decision.role}"
    print(f"  {mark}  {label} → allowed={decision.allowed}{role_part}")
    if not ok:
        print(
            f"         expected allowed={want_allowed}"
            + (f", role={want_role}" if want_role else "")
        )
    return ok


def main() -> int:
    db = SessionLocal()
    fails = 0

    # ── pick a report owned by a non-sys-admin (prefer over a random
    #    non-admin who has zero reports).
    report = db.execute(
        select(Report)
        .join(User, Report.owner_user_id == User.id)
        .where(User.is_system_admin == False)  # noqa: E712
        .limit(1)
    ).scalar_one_or_none()
    if not report:
        print(
            "SKIP: no report owned by a non-sys-admin user — create one"
            " (login as 박세현 / a non-admin and add a report) and rerun."
        )
        return 0
    nonadmin = db.get(User, report.owner_user_id)
    sys_admin = db.execute(
        select(User).where(User.is_system_admin == True).limit(1)  # noqa: E712
    ).scalar_one()

    print(f"Using report id={report.id} title={report.title!r}")
    print(f"  owner: {nonadmin.email} (id={nonadmin.id})")
    print(f"  sys admin: {sys_admin.email} (id={sys_admin.id})")
    print(f"  lock={report.author_lock_enabled}")
    print()

    print("=== Path 1: owner ===")
    fails += not expect(
        "owner can edit", can_edit(db, nonadmin, report), True, "owner"
    )

    print("=== Path 2: sys admin (decision #2 — bypasses lock) ===")
    fails += not expect(
        "sys admin can edit",
        can_edit(db, sys_admin, report),
        True,
        "sys_admin",
    )

    print("=== Path 3: random non-owner non-admin ===")
    third = db.execute(
        select(User)
        .where(
            User.is_system_admin == False,  # noqa: E712
            User.id != nonadmin.id,
        )
        .limit(1)
    ).scalar_one_or_none()
    if third is None:
        print(
            "  SKIP: only one non-admin user in DB; create a second one to test"
        )
    else:
        # Default expectation: not allowed UNLESS this user happens to be
        # a lead on a workspace where the owner is also a member, or has
        # an explicit ReportEditor row. Just print the decision and let
        # the operator judge.
        d = can_edit(db, third, report)
        print(
            f"  user {third.email} (id={third.id}) → allowed={d.allowed} role={d.role}"
        )
        print(
            "  (this varies by data; expected 'none' if the user has no admin"
            " role in any workspace where the owner is also a member)"
        )

    print()
    print("=== Path 4: explicit editor grant ===")
    if third is None:
        print("  SKIP: need a second non-admin user")
    else:
        # Need to isolate the editor path from other paths. If any
        # existing mount opens a lead/coauthor route, those win even
        # without a grant. Temporarily tighten every mount to
        # owner_only so the only way `third` gets in is via the grant.
        existing_mounts = list(
            db.execute(
                select(ReportMount).where(ReportMount.report_id == report.id)
            ).scalars()
        )
        prev_policies = [(m.workspace_slug, m.edit_policy) for m in existing_mounts]
        for m in existing_mounts:
            m.edit_policy = MountEditPolicy.owner_only
        db.flush()

        had_grant = db.get(ReportEditor, (report.id, third.id)) is not None
        if not had_grant:
            db.add(
                ReportEditor(
                    report_id=report.id,
                    user_id=third.id,
                    added_by_user_id=nonadmin.id,
                )
            )
            db.flush()
        fails += not expect(
            "granted editor can edit",
            can_edit(db, third, report),
            True,
            "editor",
        )
        if not had_grant:
            db.delete(db.get(ReportEditor, (report.id, third.id)))
            db.flush()
            fails += not expect(
                "after revoke, editor cannot",
                can_edit(db, third, report),
                False,
            )
        # Restore mount policies — keeping the rollback at the bottom
        # would also handle this, but make the intent explicit.
        for slug, pol in prev_policies:
            m = db.get(ReportMount, (report.id, slug))
            if m:
                m.edit_policy = pol
        db.flush()

    print()
    print("=== Path 5: hard lock veto ===")
    if report.author_lock_enabled:
        print("  lock already enabled; skipping toggle")
    else:
        report.author_lock_enabled = True
        db.flush()
        fails += not expect(
            "owner CAN edit through lock", can_edit(db, nonadmin, report), True, "owner"
        )
        fails += not expect(
            "sys admin BYPASSES lock (decision #2)",
            can_edit(db, sys_admin, report),
            True,
            "sys_admin",
        )
        if third is not None:
            fails += not expect(
                "third user blocked by lock",
                can_edit(db, third, report),
                False,
                "locked",
            )
        report.author_lock_enabled = False
        db.flush()

    print()
    print("=== Path 6: mount edit_policy ===")
    mount = db.execute(
        select(ReportMount).where(ReportMount.report_id == report.id).limit(1)
    ).scalar_one_or_none()
    if mount is None:
        print(
            "  SKIP: report is not mounted to any board. Mount it from the"
            " UI to exercise lead/coauthor paths."
        )
    else:
        print(f"  testing on mount workspace={mount.workspace_slug} policy={mount.edit_policy.value}")
        # Find anyone who's admin in that workspace via the membership table
        # (direct only — ancestor walk is exercised inside can_edit)
        admins = list(
            db.execute(
                select(WorkspaceMember.user_id).where(
                    WorkspaceMember.workspace_slug == mount.workspace_slug,
                    WorkspaceMember.role == Role.admin,
                )
            ).scalars()
        )
        # Find a user who is workspace admin but not sys admin (so they
        # exercise the 'lead' path, not 'sys_admin').
        lead = None
        for uid in admins:
            u = db.get(User, uid)
            if u and not u.is_system_admin and u.id != nonadmin.id:
                lead = u
                break
        if lead is None:
            print(
                "  SKIP: no non-sys-admin workspace lead found. Either"
                " promote a normal user to admin role on a workspace where"
                " the owner is also a member, or trust the sys_admin path"
                " above for coverage."
            )
        else:
            # Owner must also be a member of that workspace for the lead
            # rule to fire (§4.2). Check ancestor walk via _resolve_role.
            from app.shared.auth import _resolve_role
            author_role = _resolve_role(db, nonadmin.id, mount.workspace_slug)
            if author_role is None:
                print(
                    f"  SKIP: owner {nonadmin.email} is not a member of"
                    f" {mount.workspace_slug} (or its ancestors); lead path"
                    " can't fire."
                )
            else:
                fails += not expect(
                    f"lead ({lead.email}) can edit",
                    can_edit(db, lead, report),
                    True,
                    "lead",
                )

        # owner_only policy test — temporarily flip
        prev_policy = mount.edit_policy
        mount.edit_policy = MountEditPolicy.owner_only
        db.flush()
        if third is not None:
            fails += not expect(
                "owner_only blocks non-grant non-lead",
                can_edit(db, third, report),
                False,
            )
        mount.edit_policy = prev_policy
        db.flush()

    db.rollback()  # discard any temporary writes (lock, editor row, policy)
    db.close()

    print()
    print("=" * 50)
    if fails == 0:
        print("ALL CHECKED PATHS PASSED")
        return 0
    else:
        print(f"{fails} FAILURE(S)")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
