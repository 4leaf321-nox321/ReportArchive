"""Placeholder utilities for prompt bodies.

The supported placeholder vocabulary is split into two flavors:

  - **Variable tokens** — replaced with the corresponding string at
    render time:
       {{template_id}}        — current page's template id
       {{template_version}}   — current page's template version
       {{section_taxonomy}}   — admin-managed 단락 구분 taxonomy block
       {{widget_catalog}}     — full catalog (all widgets, props_schema)
       {{widget_examples}}    — full WIDGET_PROMPT_EXAMPLES dump

  - **Widget inline tokens** — `{{widget:foo}}` inlines a single widget's
    props_schema + example at that exact spot. Used both for rendering
    AND for deriving the set of widgets a prompt covers (= the chips
    shown next to each prompt in the picker).

The 1st-pass implementation lives backend-side as a *detection* helper
only (extract_widget_types / has_wildcard). Actual body rendering for
the picker preview is done client-side in Phase 3 — the prompt list
endpoint just attaches the derived widget set so the frontend can show
coverage chips without re-running the regex itself.
"""
from __future__ import annotations

import re
from typing import Iterable

# Single-widget inline token: {{widget:foo_bar}}. Same identifier rules
# as widget `type` strings (lowercase, underscore, no leading digit).
_WIDGET_TOKEN_RE = re.compile(r"{{\s*widget\s*:\s*([a-z][a-z0-9_]*)\s*}}")
# Wildcard tokens that effectively cover the entire catalog. Either one
# being present means "this prompt addresses every widget type" — useful
# for the v1/v2 seed prompts that dump the whole catalog at once.
_WILDCARD_RE = re.compile(r"{{\s*(widget_catalog|widget_examples)\s*}}")
# Page-context token: {{template_blocks}} feeds the AI the *current page's*
# block list rather than the global catalog. Used by patch-style prompts
# that edit existing blocks instead of generating new ones, so coverage
# chips can distinguish "이 프롬프트는 페이지를 편집한다" from the wildcard /
# per-widget categories.
_PAGE_CONTEXT_RE = re.compile(r"{{\s*template_blocks\s*}}")


def extract_widget_types(body: str) -> list[str]:
    """Return the list of widget types referenced by `{{widget:foo}}`
    tokens, in document order, with duplicates removed. The order is
    stable so picker chips stay where the author put them."""
    if not body:
        return []
    seen: dict[str, None] = {}
    for m in _WIDGET_TOKEN_RE.finditer(body):
        seen.setdefault(m.group(1), None)
    return list(seen.keys())


def has_wildcard(body: str) -> bool:
    """True iff the body contains a token that pulls in the *entire*
    widget catalog (so any specific {{widget:foo}} tokens are subsumed)."""
    if not body:
        return False
    return _WILDCARD_RE.search(body) is not None


def has_page_context(body: str) -> bool:
    """True iff the body uses the {{template_blocks}} token — i.e. it
    operates on the user's CURRENT page rather than the global catalog.
    These prompts are typically patch-style edits and warrant their own
    badge in the picker UI."""
    if not body:
        return False
    return _PAGE_CONTEXT_RE.search(body) is not None


def detect_widget_coverage(body: str) -> dict:
    """Bundle the derived facts into one dict — what the prompt list
    endpoint attaches to each row so the frontend's picker can render
    chips + the AiPromptDialog sidebar without reparsing the body."""
    return {
        "widget_types": extract_widget_types(body),
        "wildcard_all": has_wildcard(body),
        "page_context": has_page_context(body),
    }


# Exposed for callers that already have an iterable of token strings
# (e.g. when we add a server-side renderer in Phase 4 and want to walk
# the matches in a single sweep alongside the catalog lookup).
def iter_widget_tokens(body: str) -> Iterable[tuple[int, int, str]]:
    """Yield (start, end, widget_type) tuples for every {{widget:foo}}
    occurrence. Useful for renderers that need both the position (to
    splice in replacement text) and the type."""
    if not body:
        return
    for m in _WIDGET_TOKEN_RE.finditer(body):
        yield m.start(), m.end(), m.group(1)
