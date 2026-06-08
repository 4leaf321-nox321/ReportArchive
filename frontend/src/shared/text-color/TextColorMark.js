import { Mark, mergeAttributes } from '@tiptap/core'
import {
  colorTokenClass,
  hexToToken,
  normalizeToken,
  tokenFromClassName,
} from './tokens'

// Pull a token out of an element, trying the formats in order of trust:
//   1. our own `rt-c-{token}` class (canonical, current format)
//   2. a legacy inline `style="color: …"` (old saved content)
//   3. a `<font color>` attribute (Word/Excel/web paste)
// Returns null when none yield a recognized token, which gates the mark off.
function extractToken(el) {
  const fromClass = tokenFromClassName(el.getAttribute('class') || '')
  if (fromClass) return fromClass
  const inline = el.style?.color
  if (inline) {
    const t = hexToToken(inline)
    if (t) return t
  }
  const fontColor = el.getAttribute?.('color')
  if (fontColor) {
    const t = hexToToken(fontColor)
    if (t) return t
  }
  return null
}

/**
 * Semantic text-color mark. Renders `<span class="rt-c-{token}">` and resolves
 * the actual color from a per-theme CSS variable, so colored text adapts to
 * light/dark automatically. Kept separate from TextStyle (which owns
 * font-size) so the two compose as independent marks.
 *
 * Commands keep the legacy `setColor`/`unsetColor` names so existing call sites
 * work unchanged — they now pass a *token* (`'red'`) instead of a hex.
 */
export const TextColor = Mark.create({
  name: 'textColor',

  addAttributes() {
    return {
      token: {
        default: null,
        parseHTML: (element) => extractToken(element),
        renderHTML: (attrs) => {
          const cls = colorTokenClass(attrs.token)
          return cls ? { class: cls } : {}
        },
      },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'span',
        // Only claim spans that actually carry a color we recognize; return
        // false otherwise so plain/font-size-only spans pass through to
        // TextStyle untouched.
        getAttrs: (el) => (extractToken(el) ? {} : false),
      },
      {
        tag: 'font[color]',
        getAttrs: (el) => (extractToken(el) ? {} : false),
      },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes), 0]
  },

  addCommands() {
    return {
      setColor:
        (token) =>
        ({ commands }) => {
          const t = normalizeToken(token)
          return t
            ? commands.setMark(this.name, { token: t })
            : commands.unsetMark(this.name)
        },
      unsetColor:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    }
  },
})
