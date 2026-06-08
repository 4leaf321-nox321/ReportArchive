import { COLOR_TOKENS, normalizeToken } from './tokens'

/**
 * Reusable swatch grid for picking a text-color token. Shared by the RichText
 * inline toolbar, the block-level TextStyleField, and caption / note inputs.
 *
 *  - `value`    : current token (string) or null for "기본".
 *  - `onChange` : called with the picked token (null for default).
 *  - `size`     : swatch size in px (default 20).
 *  - `columns`  : swatches per row before wrapping (default 10).
 *
 * The palette has ~18 colors, so the swatches wrap into a fixed-width grid
 * instead of one long row — keeps the floating toolbars from overflowing.
 * The button preview is painted from each token's light-mode `swatch` hex; the
 * actual rendered text color comes from the theme CSS variable, not this value.
 * The "기본" swatch shows a diagonal slash to signal "no color / inherit".
 */
export function ColorSwatchPicker({ value, onChange, size = 20, columns = 10 }) {
  const current = normalizeToken(value)
  const dim = `${size}px`
  const gap = 2
  return (
    <div
      className="flex flex-wrap content-start gap-0.5"
      style={{ maxWidth: `${columns * (size + gap)}px` }}
    >
      {COLOR_TOKENS.map((c) => {
        const active = c.token === current
        return (
          <button
            key={c.label}
            type="button"
            title={c.label}
            // Keep editor/input focus while clicking the swatch.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChange(c.token)}
            className={`rounded border ${
              active ? 'ring-2 ring-offset-1 ring-primary' : 'border-border'
            }`}
            style={{
              width: dim,
              height: dim,
              backgroundColor: c.swatch ?? 'transparent',
              backgroundImage:
                c.token === null
                  ? 'linear-gradient(135deg, transparent 45%, #ef4444 45%, #ef4444 55%, transparent 55%)'
                  : undefined,
            }}
          />
        )
      })}
    </div>
  )
}
