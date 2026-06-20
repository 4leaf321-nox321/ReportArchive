# ReportArchive ↔ HWAX Portal SSO — Developer Integration Guide

**Audience:** the ReportArchive backend/frontend developer.
**Goal:** let a user already logged into the HWAX portal click the ReportArchive tile and land in ReportArchive **already logged in** — without breaking local email/password login or the `rat_` Personal Access Tokens.

> This guide describes what **you** add. It was written against the current code and verified
> end-to-end against the working reference implementation (MX White Paper). The portal side
> (token minting, JWKS, the launch tile) is already built and proven — you only build the
> **consumer** (the callback) on the ReportArchive side.

Key code references this guide is grounded in:
- Request auth resolver: `backend/app/shared/auth.py:72-118` (`_resolve_user_from_token`)
- Token mint/verify (HS256, local secret): `backend/app/modules/auth/services.py:37-56`
- PAT path (keep working): `backend/app/modules/users/pat.py:18-94`, branch at `auth.py:82-90`
- User model: `backend/app/modules/users/models.py:52-107` (email UNIQUE l.56, password_hash nullable l.60, **no external_id**, name NOT NULL l.57)
- Router mount: `backend/app/modules/__init__.py` (auth at `prefix="/api/auth"`)
- SPA token storage: `frontend/src/shared/api/client.js:15,33-97` (localStorage key `ra:access_token:v1`, axios `Authorization: Bearer` interceptor)
- SPA boot: `frontend/src/shared/auth/AuthContext.jsx:46,64-110`
- Worker count: `backend/run.py:34,58-64` + `backend/app/shared/runtime_tuning.py:28` (**defaults to 4 workers** — see §2.1)
- Canonical reference impl (different stack — async + cookie): `/home/koopark/claude/MXWhitePaper/apps/api/app/routers/portal_sso.py`

---

## The contract (fixed — build to it)

The portal mints a short-lived **RS256 "launch" JWT** and the portal SPA **auto-POSTs** it
(form field `token`) to your callback. The token:

| claim | value |
|---|---|
| `iss` | `https://hwax.sec.samsung.net` |
| `aud` | `report-archive` (← you verify this equals your `portal_audience`) |
| `scope` | `launch` (← you must check) |
| `email`, `name`, `sub`, `groups` | the user's identity |
| `exp` | ~90 s; `jti` single-use (← you must replay-guard) |

Verify it with the portal's **JWKS** at `<portal>/.well-known/jwks.json` (RS256, by `kid`).
Then upsert the user **by email** (link if the email already exists locally, JIT-create if not),
start **your own** ReportArchive session, and redirect into the SPA — already logged in.

---

## 0. The one architectural fact that changes the design

The MX White Paper reference sets **only a refresh cookie** and redirects; its SPA boots by calling
`/auth/refresh`, which reads that cookie and mints an access token.

**ReportArchive does NOT work this way.** Its SPA authenticates from a **Bearer token in
`localStorage`** (`ra:access_token:v1`), attached by an axios interceptor (`client.js:87-97`). There is
**no `/auth/refresh` endpoint and the SPA reads no cookies**.

> **Consequence:** if you only set a cookie like mxwp does, the user lands **logged out**, because
> nothing in the SPA reads it. You must hand the minted token to the SPA in a form its
> localStorage-based `AuthProvider` can adopt.

Two compliant options; this guide recommends **Option A** (smaller change):

- **Option A (recommended):** callback mints ReportArchive's own access token, 303-redirects to a tiny
  SPA route `/report-archive/sso` with the token in the **URL fragment** (`#sso_token=...`); a ~15-line
  `SsoLanding` component stores it via `setAccessToken()` and navigates to `/`. Also set a `Path=/`
  HttpOnly cookie for defense-in-depth and to satisfy the sub-path rule (§5).
- **Option B (cookie-faithful to mxwp):** callback sets only the `Path=/` HttpOnly cookie and redirects
  to `/report-archive/`; add a minimal `POST /api/auth/portal-exchange` that reads the cookie and
  returns the token as JSON, and have `AuthProvider` call it once on boot when no localStorage token exists.

Everything below uses Option A and notes Option B where relevant.

---

## 1. New config keys (`backend/app/config.py`)

Add to the `Settings` class. All defaults keep standalone deployments unchanged.

```python
# --- HWAX Portal SSO (downstream jwt-handoff) ---
portal_jwks_url: str = Field(default="")                 # empty => SSO disabled (callback 404)
portal_audience: str = Field(default="report-archive")   # MUST equal systems.yaml audience
portal_issuer: str = Field(default="https://hwax.sec.samsung.net")  # optional extra check
session_cookie_name: str = Field(default="ra_session")
session_cookie_path: str = Field(default="/")            # sub-path gotcha — see §5
sso_landing_path: str = Field(default="/report-archive/sso")  # 303 target (SsoLanding route)
```

**Rule:** when `portal_jwks_url` is empty the callback MUST return **404**. Standalone deploys set
nothing and expose nothing.

Env (portal deployment only):
```
PORTAL_JWKS_URL=https://hwax.sec.samsung.net/.well-known/jwks.json
PORTAL_AUDIENCE=report-archive
PORTAL_ISSUER=https://hwax.sec.samsung.net
SESSION_COOKIE_PATH=/
```
> On this dev box the portal backend serves JWKS directly at `http://127.0.0.1:8723/.well-known/jwks.json`
> (server-to-server; the public `https://hwax.sec.samsung.net/...` form is for the real deployment).

---

## 2. RS256 + kid + JWKS verification — ALONGSIDE the existing HS256

Do **not** touch `decode_access_token` (`services.py:50-56`), `_resolve_user_from_token`
(`auth.py:72-118`), or `pat.py`. RS256/JWKS verification lives entirely in the new module. The existing
resolver keeps verifying the service's own HS256 tokens and the `rat_` PATs; the RS256 *launch* token is
only ever exchanged at the callback — it is never sent as the Bearer on `/api/*` calls (and if it were, it
would correctly fail HS256 verification and 401).

Use **PyJWT** (already a dep, `requirements.txt:20`; `import jwt` used across the codebase) — **not**
`python-jose`. PyJWT 2.10.1 verifies RS256 from a JWKS via `jwt.algorithms.RSAAlgorithm.from_jwk`.

> ### 2.1 ⚠️ REQUIRED DECISION — jti replay under multiple workers
>
> Production runs **multi-worker uvicorn**: `run.py` launches `workers=get_int('uvicorn_workers')`,
> which **defaults to 4** (`runtime_tuning.py:28`). A module-level in-process `_seen_jti` set lives in
> ONE worker, so a replayed launch token routed to a *different* worker within the ~90 s window is **not
> detected** — silently defeating the contract's mandatory replay guard. The JWKS cache being per-worker
> is harmless (a few extra fetches); the jti gap is a real auth weakness.
>
> **Pick ONE and make it real (a code comment is NOT enough):**
>
> - **(a) Single worker on the portal deploy** — set `UVICORN_WORKERS=1` in the portal deployment's env /
>   service template, and keep the simple in-process set below. Minimal, no migration, but you MUST enforce
>   the env var (e.g. assert it at startup when `portal_jwks_url` is set).
> - **(b) Cross-process guard in Postgres** — a tiny table `sso_used_jti(jti PRIMARY KEY, exp TIMESTAMP)`;
>   `INSERT` that fails on duplicate = replay (catch `IntegrityError`), plus an opportunistic
>   `DELETE WHERE exp < now()`. Works at any worker count; costs one Alembic migration. Reuses the
>   existing sync `Session`/`get_db`.
>
> Recommendation: **(b)** if you keep multi-worker in production (the default); **(a)** only if you can
> guarantee and enforce a single worker. State the choice in the module docstring.

New file `backend/app/modules/auth/portal_sso.py` (shows option **(a)**; swap `_seen_jti` for the
Postgres guard if you choose **(b)**):

```python
"""HWAX Portal SSO callback (downstream jwt-handoff). Disabled (404) unless
settings.portal_jwks_url is set, so standalone deploys are unaffected. Runs
alongside the existing HS256 local login + rat_ PATs; touches none of them.

REPLAY GUARD: in-process _seen_jti REQUIRES UVICORN_WORKERS=1 (see guide §2.1).
For multi-worker deploys, replace _seen_jti with a Postgres sso_used_jti table.
"""
from __future__ import annotations

import json
import secrets
import time
from typing import Any

import httpx
import jwt
from jwt.algorithms import RSAAlgorithm
from fastapi import APIRouter, Depends, Form, HTTPException, Response, status
from fastapi.responses import RedirectResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.modules.auth import services as auth_services
from app.modules.users.models import User

router = APIRouter()

# In-process JWKS cache (300s) + jti replay set. Single-worker uvicorn assumed (§2.1).
_jwks_cache: dict[str, Any] = {"keys": None, "fetched": 0.0}
_seen_jti: dict[str, float] = {}


def _portal_jwks(force: bool = False) -> list[dict[str, Any]]:
    now = time.time()
    if not force and _jwks_cache["keys"] is not None and now - _jwks_cache["fetched"] < 300:
        return _jwks_cache["keys"]
    with httpx.Client(timeout=5) as client:
        r = client.get(settings.portal_jwks_url)
        r.raise_for_status()
        keys = r.json().get("keys", [])
    _jwks_cache.update(keys=keys, fetched=now)
    return keys


def _pick_key(kid: str | None):
    # Strict kid match; on a miss force ONE cache refresh (key may be freshly rotated),
    # then fail closed. Do NOT silently fall back to keys[0].
    for keys in (_portal_jwks(), _portal_jwks(force=True)):
        jwk = next((k for k in keys if k.get("kid") == kid), None)
        if jwk is not None:
            return RSAAlgorithm.from_jwk(json.dumps(jwk))
    raise HTTPException(status.HTTP_401_UNAUTHORIZED, "서명 키를 찾을 수 없습니다.")


def _verify_launch_token(token: str) -> dict[str, Any]:
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "잘못된 토큰입니다.")
    key = _pick_key(header.get("kid"))
    try:
        claims = jwt.decode(
            token, key, algorithms=["RS256"],
            audience=settings.portal_audience,
            issuer=settings.portal_issuer or None,
            options={"require": ["exp", "aud", "sub", "jti"]},
            leeway=30,  # tolerate minor portal/RA clock skew on split-host deploys
        )
    except jwt.PyJWTError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "토큰 검증에 실패했습니다.")
    if claims.get("scope") != "launch":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "launch 토큰이 아닙니다.")
    now = time.time()
    for k, exp in list(_seen_jti.items()):
        if exp < now:
            del _seen_jti[k]
    jti = claims["jti"]
    if jti in _seen_jti:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "이미 사용된 토큰입니다.")
    _seen_jti[jti] = float(claims["exp"])
    return claims


def _link_or_create_user(db: Session, *, email: str, name: str) -> User:
    user = db.execute(
        select(User).where(func.lower(User.email) == email.lower())
    ).scalar_one_or_none()
    if user is None:
        user = User(
            email=email,
            name=(name or email.split("@")[0])[:128],  # name is NOT NULL, max 128
            password_hash=auth_services.hash_password(secrets.token_urlsafe(32)),  # unusable for local login
            is_active=True,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
    elif not user.is_active:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "비활성 사용자입니다.")
    return user


@router.post("/portal-callback")
def portal_callback(token: str = Form(...), db: Session = Depends(get_db)) -> Response:
    if not settings.portal_jwks_url:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "SSO not enabled")

    claims = _verify_launch_token(token)
    user = _link_or_create_user(db, email=claims["email"], name=claims.get("name") or "")

    # Mint ReportArchive's OWN access token (existing HS256 machinery) and hand it to the SPA
    # via the redirect fragment (the SPA reads localStorage, not cookies — see §0).
    access = auth_services.create_access_token(user.id)
    landing = f"{settings.sso_landing_path}#sso_token={access}"
    resp = RedirectResponse(url=landing, status_code=303)
    resp.set_cookie(
        key=settings.session_cookie_name,
        value=access,
        path=settings.session_cookie_path,   # "/"  → returned under /report-archive/ (see §5)
        httponly=True,
        samesite="lax",
        secure=settings.is_production,
        max_age=int(settings.jwt_access_token_expires.total_seconds()),
    )
    return resp
```

Notes:
- Sync `Session` + `db.execute(select(...))` matches this codebase (mxwp's async/await is **not** applicable).
- `db.commit()`/`db.refresh(user)` **before** `create_access_token(user.id)` so `user.id` is populated
  (mirror signup at `auth/routes.py:163-188`).
- Reuses `auth_services.create_access_token(user.id)` — no new token format, no new session machinery.

---

## 3. Mount the router

In `backend/app/modules/__init__.py`, import and mount on the **same prefix as auth** so the path becomes
`/api/auth/portal-callback`:

```python
from app.modules.auth.portal_sso import router as portal_sso_router
...
app.include_router(portal_sso_router, prefix="/api/auth", tags=["portal-sso"])
```

Add only this; leave every existing `include_router` untouched.

---

## 4. SPA handoff (Option A)

**Route** — `frontend/src/App.jsx`. Add a **public** route as a direct child of the `RootLayout` route
block (alongside the existing public routes near `App.jsx:104-110`), **OUTSIDE** the `AuthedShell` /
`ProtectedRoute` guard (`App.jsx:113`) — `SsoLanding` must run *before* the guard because it is what
establishes the token:

```jsx
<Route path="/sso" element={<SsoLanding />} />
```

**Component** — new `frontend/src/modules/auth/SsoLanding.jsx`:

```jsx
import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { setAccessToken } from '@/shared/api/client'

export default function SsoLanding() {
  const navigate = useNavigate()
  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1))
    const token = params.get('sso_token')
    if (token) {
      setAccessToken(token, true)                 // store in localStorage like a normal login
      window.history.replaceState(null, '', window.location.pathname)  // scrub the fragment
      navigate('/', { replace: true })
    } else {
      navigate('/login', { replace: true })
    }
  }, [navigate])
  return null
}
```

`setAccessToken` already exists (`client.js:59`); after it stores the token, `AuthProvider` boot
(`AuthContext.jsx:64-87`) fetches `/api/me` and the user is logged in. Build the SPA with
`vite build --base=/report-archive/` (already wired at `App.jsx:162-165`) so `/sso` resolves at the
browser URL `/report-archive/sso`.

> **Option B instead of the fragment:** drop `#sso_token` from the redirect (land on `/report-archive/`),
> add `POST /api/auth/portal-exchange` that reads `settings.session_cookie_name` from the request cookies
> and returns `{access_token}`; have `AuthProvider` call it once on boot when `getAccessToken()` is null.
> Matches mxwp's cookie model exactly at the cost of one endpoint + a boot tweak.

---

## 5. Sub-path cookie Path caveat (CRITICAL)

ReportArchive is proxied under `/report-archive/`. A cookie set with the service's own API path (e.g.
`Path=/api/auth`) will **not** be returned on subsequent `/report-archive/...` requests (path mismatch —
the same class of bug mxwp fixed with `REFRESH_COOKIE_PATH="/"`).

**Fix:** set the session cookie with **`Path=/`** (the configurable `session_cookie_path`, default `"/"`),
as done in §2.

Cookie flags rationale: `HttpOnly` (not script-readable); `SameSite=Lax` (the portal auto-submits a
**top-level** POST form on the same portal origin — Lax allows the cookie on the resulting same-site
navigation; avoid `Strict`, which can drop the cookie on the POST→redirect); `Secure` in production (HTTPS).

> Reminder for THIS repo: the `Path=/` cookie is contract-compliant but does **not** by itself log the SPA
> in (the SPA reads `localStorage`). The fragment token (Option A) or the exchange endpoint (Option B) is
> what actually authenticates the SPA.

---

## 6. Portal `systems.yaml` entry to request — and the nginx prefix-strip precondition

Ask the portal admin to set the `report-archive` tile to:

```yaml
integration_type: jwt-handoff
audience: report-archive
url: /report-archive/api/auth/portal-callback
```

- `url` is the **browser-reachable, same-portal-origin** callback the portal SPA auto-POSTs the token to.
- `audience: report-archive` MUST equal `settings.portal_audience` (the `jwt.decode` audience). Mismatch → all launch tokens 401.
- The nginx proxy target stays in `routes.env` separately; the portal registry was fixed so it does **not**
  overwrite this callback `url` for a handoff tile.

> ### 6.1 ⚠️ PRECONDITION — the portal must STRIP the `/report-archive/` prefix
>
> Your callback resolves to the **backend** path `/api/auth/portal-callback` (auth prefix `/api/auth` +
> `/portal-callback`). The backend sets **no `root_path`** and has no `/report-archive` mount
> (`main.py:42-49`). So the browser URL `/report-archive/api/auth/portal-callback` only reaches the route
> if the portal nginx **strips** the `/report-archive/` segment (e.g. `proxy_pass http://backend/` with a
> trailing slash) — exactly as your standalone `location /api/` → backend works today
> (`nginx/nginx.conf.example:40-41`). If nginx forwards the full `/report-archive/...` path unmodified, the
> callback 404s.
>
> **Verify both reach the route:**
> ```
> curl -i -X POST http://127.0.0.1:3000/api/auth/portal-callback -d token=x                 # backend direct
> curl -i -X POST <portal>/report-archive/api/auth/portal-callback -d token=x               # through the portal
> ```
> With `PORTAL_JWKS_URL` set, BOTH should return **401** (`token=x` rejected). A **404** on the proxied one
> but **401** on the direct one means the prefix is NOT being stripped — fix the portal route before going further.

---

## 7. What stays the same (regression budget)

- `decode_access_token`, `create_access_token`, `_resolve_user_from_token`, `pat.py`, `/api/auth/login`,
  `/api/auth/signup` — **unchanged**.
- **No DB migration** for the login itself: `User.email` is already UNIQUE and `password_hash` already
  nullable. No `external_id` column is added (storing the portal `sub` is optional and out of scope).
  *(The only migration you'd add is the optional `sso_used_jti` table from §2.1 option (b).)*
- Local email/password login and `rat_` PATs keep working untouched.

---

## 8. Test checklist (`backend/tests/test_portal_sso.py`, mirror `tests/test_mcp_tokens.py` style)

1. `portal_jwks_url` unset → `POST /api/auth/portal-callback` returns **404**; local login + a `rat_` PAT
   still authenticate (regression).
2. Happy path (existing email) → 303 to `/report-archive/sso#sso_token=...` + `Set-Cookie ra_session; Path=/;
   HttpOnly`; the **existing** local user is linked (no duplicate row); the minted token works as a Bearer
   on `GET /api/me`.
3. JIT path (unknown email) → new `User` created (`is_active=true`, unusable `password_hash`, non-empty name).
4. Replay same `jti` → 401. *(Run single-process to be meaningful; see §2.1.)*
5. Wrong `aud` / `scope != "launch"` / expired `exp` → 401.
6. End-to-end: log into the portal, click the tile, land logged in at `/report-archive/` with the fragment
   scrubbed from the address bar.

---

## 9. Known limitations to flag

- **jti replay + JWKS cache are in-process.** See §2.1 — choose single-worker (enforced) or the Postgres
  guard. Do not ship multi-worker with the in-process set.
- **New SSO users have no workspace** until an admin assigns `home_workspace` / a `WorkspaceMember`.
  `GET /api/me` works without a workspace, but the default redirect (`'/'` → `RootRedirect` → `/w/dev`,
  `App.jsx:76-80`, `workspaces.js:9`) lands a membership-less user on a **403 board page**. They ARE logged
  in (just no workspace). Do **not** auto-attach to `dev` or any random workspace; if the portal `groups`
  claim should map to a workspace, treat that as a follow-up.
- **Session lifetime** is the existing `JWT_ACCESS_TOKEN_EXPIRES_HOURS`. With no refresh flow, the SSO
  session expires like any local session and the user re-clicks the tile.

---

*Generated for the ReportArchive developer. The portal-side launch mechanism is already live and was
verified end-to-end with the MX White Paper consumer; this guide is the matching ReportArchive consumer.*
