// Shared text-color token system.
//
// Historically each consumer stored an absolute CSS color (`#dc2626`) inline.
// Absolute colors don't adapt to the theme, so a pasted/explicit black turns
// invisible in dark mode. Instead we store a *semantic token* (`red`, `ink`,
// …) rendered as a `rt-c-{token}` class whose actual value resolves from a
// per-theme CSS variable (see index.css). `null` means "no token" → the text
// inherits `--foreground` and adapts for free.
//
// This module is the single source of truth: the palette, the class mapper,
// and the legacy/paste hex→token resolver. Both the rich-text mark and the
// block-level (TextStyleField / caption) pickers import from here.

/**
 * The curated palette. `swatch` is the light-mode hex — used only to paint the
 * picker button preview and to seed the nearest-token matcher; the *rendered*
 * color always comes from the CSS variable, never this value.
 */
export const COLOR_TOKENS = [
  { token: null, label: '기본', swatch: null },
  // Grayscale
  { token: 'ink', label: '검정', swatch: '#111827' },
  { token: 'gray', label: '회색', swatch: '#6b7280' },
  { token: 'slate', label: '슬레이트', swatch: '#475569' },
  // Warm
  { token: 'red', label: '빨강', swatch: '#dc2626' },
  { token: 'orange', label: '주황', swatch: '#f97316' },
  { token: 'amber', label: '황색', swatch: '#d97706' },
  { token: 'yellow', label: '노랑', swatch: '#ca8a04' },
  { token: 'lime', label: '라임', swatch: '#65a30d' },
  // Green → cyan
  { token: 'green', label: '녹색', swatch: '#16a34a' },
  { token: 'teal', label: '청록', swatch: '#0d9488' },
  { token: 'cyan', label: '시안', swatch: '#0891b2' },
  // Blue → indigo
  { token: 'sky', label: '하늘', swatch: '#0284c7' },
  { token: 'blue', label: '파랑', swatch: '#2563eb' },
  { token: 'indigo', label: '남색', swatch: '#4f46e5' },
  // Violet → magenta
  { token: 'violet', label: '바이올렛', swatch: '#7c3aed' },
  { token: 'purple', label: '보라', swatch: '#9333ea' },
  { token: 'pink', label: '분홍', swatch: '#db2777' },
  { token: 'rose', label: '장미', swatch: '#e11d48' },
]

// Set of valid non-null token names, for validation on parse.
const VALID_TOKENS = new Set(
  COLOR_TOKENS.map((c) => c.token).filter(Boolean),
)

/** Narrow an arbitrary value to a known token name, or null. */
export function normalizeToken(value) {
  return typeof value === 'string' && VALID_TOKENS.has(value) ? value : null
}

/**
 * token → DOM class. `null`/unknown → '' so the text falls back to inherited
 * `--foreground`. The emitted classes (`rt-c-red`, …) are defined in index.css.
 */
export function colorTokenClass(token) {
  const t = normalizeToken(token)
  return t ? `rt-c-${t}` : ''
}

/** Pull the token out of a class string, e.g. "foo rt-c-red bar" → "red". */
export function tokenFromClassName(className) {
  if (typeof className !== 'string') return null
  const m = className.match(/(?:^|\s)rt-c-([a-z]+)(?:\s|$)/)
  return m ? normalizeToken(m[1]) : null
}

// --------------------------------------------------------------------------- //
// Legacy / paste hex → token resolution                                       //
// --------------------------------------------------------------------------- //

const NAMED = {
  black: { r: 0, g: 0, b: 0 },
  white: { r: 255, g: 255, b: 255 },
}

/**
 * Parse a CSS color string into {r,g,b} (0–255), or null if unparseable
 * (e.g. `var(...)`, `currentColor`, `transparent`, hsl()). We only need the
 * forms a browser/clipboard actually emits for text color: hex and rgb()/rgba().
 */
export function parseCssColor(input) {
  if (typeof input !== 'string') return null
  const s = input.trim().toLowerCase()
  if (!s) return null
  if (NAMED[s]) return NAMED[s]

  // #rgb / #rrggbb
  const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/)
  if (hex) {
    const h = hex[1]
    if (h.length === 3) {
      return {
        r: parseInt(h[0] + h[0], 16),
        g: parseInt(h[1] + h[1], 16),
        b: parseInt(h[2] + h[2], 16),
      }
    }
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    }
  }

  // rgb(r,g,b) / rgba(r,g,b,a) — integer or percentage channels.
  const rgb = s.match(/^rgba?\(([^)]+)\)$/)
  if (rgb) {
    const parts = rgb[1].split(/[,/\s]+/).filter(Boolean)
    if (parts.length < 3) return null
    const chan = (p) =>
      p.endsWith('%')
        ? Math.round((parseFloat(p) / 100) * 255)
        : Math.round(parseFloat(p))
    const r = chan(parts[0])
    const g = chan(parts[1])
    const b = chan(parts[2])
    if ([r, g, b].some((n) => Number.isNaN(n))) return null
    return {
      r: Math.min(255, Math.max(0, r)),
      g: Math.min(255, Math.max(0, g)),
      b: Math.min(255, Math.max(0, b)),
    }
  }

  return null
}

/** WCAG relative luminance (0 = black, 1 = white). */
export function relativeLuminance({ r, g, b }) {
  const lin = (c) => {
    const x = c / 255
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

// Exact-match table: a color saved by *our own* picker round-trips back to its
// token (so a deliberate `검정`/#111827 stays `ink` instead of being absorbed
// to default by the near-black rule below). Keyed by lowercased hex6.
const EXACT_HEX_TO_TOKEN = (() => {
  const m = {}
  for (const c of COLOR_TOKENS) {
    if (c.swatch) m[c.swatch.toLowerCase()] = c.token
  }
  return m
})()

// Palette seeds for nearest-color matching (excludes the null default).
const PALETTE_RGB = COLOR_TOKENS.filter((c) => c.swatch).map((c) => ({
  token: c.token,
  ...parseCssColor(c.swatch),
}))

// Luminance bands for "this is effectively the default" — a pure-ish black
// (pasted from Excel/Word as #000 / rgb(0,0,0)) or a pure-ish white. These
// absorb to `null` so the text follows the theme instead of being pinned.
const NEAR_BLACK_LUM = 0.04
const NEAR_WHITE_LUM = 0.85

/**
 * Resolve an arbitrary CSS color (from legacy inline styles or external paste)
 * to a palette token, or `null` to mean "drop the color, inherit the theme".
 *
 *   1. exact match to one of our own swatches → that token (preserve intent)
 *   2. near-black or near-white → null (absorb default)
 *   3. otherwise → nearest palette token by RGB distance
 *   4. unparseable → null
 */
export function hexToToken(input) {
  const rgb = parseCssColor(input)
  if (!rgb) return null

  // 1. exact swatch
  if (typeof input === 'string') {
    const exact = EXACT_HEX_TO_TOKEN[input.trim().toLowerCase()]
    if (exact) return exact
  }
  // hex normalized form may differ (e.g. #DC2626) — re-check via rgb roundtrip.
  const asHex = `#${[rgb.r, rgb.g, rgb.b]
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('')}`
  if (EXACT_HEX_TO_TOKEN[asHex]) return EXACT_HEX_TO_TOKEN[asHex]

  // 2. default absorption band
  const lum = relativeLuminance(rgb)
  if (lum <= NEAR_BLACK_LUM || lum >= NEAR_WHITE_LUM) return null

  // 3. nearest palette token
  let best = null
  let bestDist = Infinity
  for (const p of PALETTE_RGB) {
    const d =
      (p.r - rgb.r) ** 2 + (p.g - rgb.g) ** 2 + (p.b - rgb.b) ** 2
    if (d < bestDist) {
      bestDist = d
      best = p.token
    }
  }
  return best
}
