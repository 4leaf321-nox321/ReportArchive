/**
 * Equation widget — LaTeX-rendered math formula.
 *
 * Edit mode: split layout with raw LaTeX source on the left and live
 * rendered preview on the right. Display-mode + equation-number
 * controls sit above the split.
 *
 * View mode: just the rendered formula (centered in display mode)
 * plus the caption and optional equation number at the right.
 *
 * Rendering goes through KaTeX which emits static HTML + inline SVG
 * for symbols, so HTML / PDF export gets the math correctly without
 * any runtime math typesetter. DOCX export captures the rendered
 * cell as PNG via the standard visual-block path.
 */
import { useEffect, useRef } from 'react'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { CaptionInput, LabelField, PreviewLabel, captionSkipProps, captionPositionOf } from './_shared'

const DISPLAY_MODES = [
  { value: 'display', label: '큰 식 (가운데 정렬)' },
  { value: 'inline', label: '인라인 (작게)' },
]

const SAMPLE_LATEX = 'F = m \\cdot a'

// Categorized symbol palette — each entry has the LaTeX snippet to
// insert and a display glyph for the button. `caret` (optional) is
// the number of characters the cursor should back up after insertion
// — useful for templates like `\sqrt{}` where the caret should land
// inside the empty braces.
const SYMBOL_CATEGORIES = [
  {
    name: '기본',
    items: [
      { latex: '\\pm ', glyph: '±' },
      { latex: '\\mp ', glyph: '∓' },
      { latex: '\\times ', glyph: '×' },
      { latex: '\\div ', glyph: '÷' },
      { latex: '\\cdot ', glyph: '⋅' },
      { latex: '\\le ', glyph: '≤' },
      { latex: '\\ge ', glyph: '≥' },
      { latex: '\\ne ', glyph: '≠' },
      { latex: '\\approx ', glyph: '≈' },
      { latex: '^\\circ ', glyph: '°' },
      { latex: '\\infty ', glyph: '∞' },
    ],
  },
  {
    name: '그리스',
    items: [
      { latex: '\\alpha ', glyph: 'α' },
      { latex: '\\beta ', glyph: 'β' },
      { latex: '\\gamma ', glyph: 'γ' },
      { latex: '\\delta ', glyph: 'δ' },
      { latex: '\\varepsilon ', glyph: 'ε' },
      { latex: '\\theta ', glyph: 'θ' },
      { latex: '\\lambda ', glyph: 'λ' },
      { latex: '\\mu ', glyph: 'μ' },
      { latex: '\\nu ', glyph: 'ν' },
      { latex: '\\pi ', glyph: 'π' },
      { latex: '\\rho ', glyph: 'ρ' },
      { latex: '\\sigma ', glyph: 'σ' },
      { latex: '\\tau ', glyph: 'τ' },
      { latex: '\\phi ', glyph: 'φ' },
      { latex: '\\omega ', glyph: 'ω' },
      { latex: '\\Delta ', glyph: 'Δ' },
      { latex: '\\Phi ', glyph: 'Φ' },
      { latex: '\\Omega ', glyph: 'Ω' },
    ],
  },
  {
    name: '구조',
    items: [
      // `caret: 1` parks the cursor between `}` of the LAST brace
      // pair so the user can type the next argument immediately.
      { latex: '\\frac{}{}', glyph: 'a⁄b', caret: 3, title: '분수' },
      { latex: '^{}', glyph: 'x²', caret: 1, title: '위첨자' },
      { latex: '_{}', glyph: 'xₙ', caret: 1, title: '아래첨자' },
      { latex: '\\sqrt{}', glyph: '√x', caret: 1, title: '제곱근' },
      { latex: '\\sqrt[]{}', glyph: 'ⁿ√x', caret: 3, title: 'n제곱근' },
      { latex: '\\sum_{i=1}^{n} ', glyph: 'Σ', title: '시그마 합' },
      { latex: '\\int_{a}^{b} ', glyph: '∫', title: '적분' },
      { latex: '\\prod_{i=1}^{n} ', glyph: '∏', title: '곱' },
      { latex: '\\lim_{x \\to 0} ', glyph: 'lim', title: '극한' },
      { latex: '\\partial ', glyph: '∂', title: '편미분 기호' },
      { latex: '\\nabla ', glyph: '∇', title: '나블라' },
      { latex: '\\vec{}', glyph: 'a⃗', caret: 1, title: '벡터' },
      { latex: '\\bar{}', glyph: 'ā', caret: 1, title: '평균/바' },
      { latex: '\\hat{}', glyph: 'â', caret: 1, title: '햇' },
      // Line break — works in display mode at the top level AND
      // inside environments like aligned / gathered. Inserts a real
      // newline in the source so the textarea reads naturally.
      { latex: ' \\\\\n', glyph: '↵', title: '줄바꿈' },
    ],
  },
  {
    name: '괄호',
    items: [
      { latex: '\\left( \\right)', glyph: '(…)', caret: 8, title: '괄호' },
      { latex: '\\left[ \\right]', glyph: '[…]', caret: 8, title: '대괄호' },
      { latex: '\\left\\{ \\right\\}', glyph: '{…}', caret: 9, title: '중괄호' },
      { latex: '\\left| \\right|', glyph: '|x|', caret: 8, title: '절대값' },
    ],
  },
  {
    name: '화살표',
    items: [
      { latex: '\\to ', glyph: '→' },
      { latex: '\\Rightarrow ', glyph: '⇒' },
      { latex: '\\leftrightarrow ', glyph: '↔' },
      { latex: '\\Leftrightarrow ', glyph: '⇔' },
    ],
  },
]

// Self-contained sample formulas grouped by domain. Picking one
// REPLACES the current LaTeX so the writer can start from a known-
// good template instead of an empty box. <optgroup> labels split the
// dropdown into engineering domains so the list scans quickly.
const FORMULA_TEMPLATES = [
  {
    group: '역학',
    items: [
      { name: '운동 방정식 (F = ma)', latex: 'F = m \\cdot a' },
      { name: '후크의 법칙', latex: 'F = -k x' },
      { name: '운동에너지', latex: 'KE = \\frac{1}{2} m v^2' },
      { name: '위치에너지', latex: 'PE = m g h' },
      { name: '일 (W = F·d)', latex: 'W = F \\cdot d' },
      { name: '일률 (P = W/t)', latex: 'P = \\frac{W}{t} = F \\cdot v' },
      { name: '토크 (τ = r×F)', latex: '\\tau = r \\times F' },
      { name: '각운동량', latex: 'L = I \\omega' },
      { name: '만유인력', latex: 'F = G \\frac{m_1 m_2}{r^2}' },
    ],
  },
  {
    group: '구조 / 재료',
    items: [
      { name: '응력 (σ = F/A)', latex: '\\sigma = \\frac{F}{A}' },
      { name: '응력-변형률', latex: '\\sigma = E \\cdot \\varepsilon' },
      { name: '안전계수', latex: 'SF = \\frac{\\sigma_{\\text{허용}}}{\\sigma_{\\text{작용}}}' },
      { name: '최대 전단응력', latex: '\\tau_{\\max} = \\sqrt{\\sigma_x^2 + 4\\tau^2}' },
    ],
  },
  {
    group: '열역학 / 전열',
    items: [
      { name: '이상기체 (PV = nRT)', latex: 'P V = n R T' },
      { name: '열량 (Q = mcΔT)', latex: 'Q = m c \\Delta T' },
      { name: '푸리에 열전도', latex: 'q = -k \\frac{dT}{dx}' },
      { name: '효율 (η = W/Q)', latex: '\\eta = \\frac{W_{\\text{out}}}{Q_{\\text{in}}}' },
      { name: '카르노 효율', latex: '\\eta_{\\text{Carnot}} = 1 - \\frac{T_c}{T_h}' },
      { name: '슈테판-볼츠만', latex: 'P = \\varepsilon \\sigma A T^4' },
    ],
  },
  {
    group: '유체',
    items: [
      { name: '베르누이', latex: 'P + \\tfrac{1}{2} \\rho v^2 + \\rho g h = \\text{const}' },
      { name: '연속방정식', latex: 'A_1 v_1 = A_2 v_2' },
      { name: '레이놀즈 수', latex: 'Re = \\frac{\\rho v D}{\\mu}' },
      { name: '점성 응력 (뉴턴)', latex: '\\tau = \\mu \\frac{du}{dy}' },
    ],
  },
  {
    group: '전기 / 회로',
    items: [
      { name: '옴의 법칙 (V = IR)', latex: 'V = I R' },
      { name: '전력 (P = VI)', latex: 'P = V I = I^2 R = \\frac{V^2}{R}' },
      { name: 'RC 시상수', latex: '\\tau = R C' },
      { name: '콘덴서 에너지', latex: 'E = \\tfrac{1}{2} C V^2' },
      { name: '인덕터 에너지', latex: 'E = \\tfrac{1}{2} L I^2' },
      { name: '임피던스 (Z)', latex: 'Z = R + j X' },
      { name: '패러데이 법칙', latex: '\\varepsilon = -\\frac{d\\Phi}{dt}' },
      { name: '키르히호프 전압', latex: '\\sum_{i} V_i = 0' },
    ],
  },
  {
    group: '미적분',
    items: [
      { name: '미분', latex: '\\frac{d}{dx} f(x)' },
      { name: '편미분', latex: '\\frac{\\partial f}{\\partial x}' },
      { name: '적분', latex: '\\int_{a}^{b} f(x) \\, dx' },
      { name: '시그마 합', latex: '\\sum_{i=1}^{n} x_i' },
      { name: '곱 (Π)', latex: '\\prod_{i=1}^{n} x_i' },
      { name: '극한', latex: '\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1' },
      { name: '부분적분', latex: '\\int u \\, dv = uv - \\int v \\, du' },
      { name: '체인 룰', latex: "\\frac{d}{dx} f(g(x)) = f'(g(x)) \\cdot g'(x)" },
      { name: '테일러 급수', latex: 'f(x) = \\sum_{n=0}^{\\infty} \\frac{f^{(n)}(a)}{n!} (x-a)^n' },
    ],
  },
  {
    group: '대수 / 기하',
    items: [
      { name: '제곱근 (a² + b²)', latex: '\\sqrt{a^2 + b^2}' },
      { name: '2차 방정식 근의 공식', latex: 'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}' },
      { name: '코사인 법칙', latex: 'c^2 = a^2 + b^2 - 2ab\\cos\\gamma' },
      { name: '사인 법칙', latex: '\\frac{a}{\\sin A} = \\frac{b}{\\sin B} = \\frac{c}{\\sin C}' },
      { name: '오일러 등식', latex: 'e^{i\\pi} + 1 = 0' },
      { name: '2×2 행렬', latex: '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}' },
      { name: '다중행 식 (aligned)', latex: '\\begin{aligned} y &= ax + b \\\\ z &= cx^2 \\end{aligned}' },
    ],
  },
  {
    group: '통계 / 확률',
    items: [
      { name: '평균', latex: '\\bar{x} = \\frac{1}{n} \\sum_{i=1}^{n} x_i' },
      { name: '분산', latex: '\\sigma^2 = \\frac{1}{N} \\sum_{i=1}^{N} (x_i - \\mu)^2' },
      { name: '표준편차', latex: '\\sigma = \\sqrt{\\frac{1}{N} \\sum (x_i - \\mu)^2}' },
      { name: '표준오차', latex: 'SE = \\frac{\\sigma}{\\sqrt{n}}' },
      { name: '신뢰구간', latex: '\\bar{x} \\pm z \\cdot \\frac{\\sigma}{\\sqrt{n}}' },
      { name: '정규분포 PDF', latex: 'f(x) = \\frac{1}{\\sigma\\sqrt{2\\pi}} e^{-\\frac{(x-\\mu)^2}{2\\sigma^2}}' },
    ],
  },
]

// --------------------------------------------------------------------------- //
// Props panel + preview                                                         //
// --------------------------------------------------------------------------- //

export function EquationPropsPanel({ props, onChange }) {
  return (
    <div className="space-y-4">
      <LabelField
        label="라벨"
        value={props.label}
        onChange={(v) => onChange({ ...props, label: v })}
        placeholder="기본 방정식"
      />
    </div>
  )
}

export function EquationPreview({ props }) {
  return (
    <div className="space-y-2">
      <PreviewLabel hint="LaTeX 수식">
        {props.label || '(라벨 없음)'}
      </PreviewLabel>
      <div className="aspect-video bg-muted/40 border border-dashed rounded-md flex items-center justify-center text-xl">
        <MathRender latex="\\Sigma f(x) = \\frac{a+b}{c}" displayMode="display" />
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Editor                                                                        //
// --------------------------------------------------------------------------- //

export function EquationEditor({ props, content, onChange, readOnly }) {
  const caption = content?.caption ?? ''
  const latex = content?.latex ?? ''
  const displayMode = content?.display_mode === 'inline' ? 'inline' : 'display'
  const number = content?.number ?? ''
  const textareaRef = useRef(null)
  const capPos = captionPositionOf(content)

  function patch(next) {
    const merged = { ...(content ?? {}), latex, display_mode: displayMode, ...next }
    if (!merged.caption) delete merged.caption
    if (!merged.caption_skip_autofill) delete merged.caption_skip_autofill
    if (!merged.latex) delete merged.latex
    if (merged.display_mode === 'display') delete merged.display_mode
    if (!merged.number) delete merged.number
    onChange(merged)
  }

  /** Insert a snippet at the textarea's caret position. `caret`
   *  (optional) tells how many characters back from the end the
   *  caret should land — used for templates like `\sqrt{}` to park
   *  the cursor inside the braces. Selection is replaced if any. */
  function insertSnippet(snippet, caret = 0) {
    const ta = textareaRef.current
    if (!ta) {
      patch({ latex: latex + snippet })
      return
    }
    const start = ta.selectionStart
    const end = ta.selectionEnd
    const next = latex.slice(0, start) + snippet + latex.slice(end)
    const caretPos = start + snippet.length - caret
    patch({ latex: next })
    // Restore focus + caret after React commits the state update.
    setTimeout(() => {
      ta.focus()
      ta.setSelectionRange(caretPos, caretPos)
    }, 0)
  }
  function applyTemplate(value) {
    if (!value) return
    patch({ latex: value })
    // Move focus into the textarea so the user can immediately tweak
    // the inserted template.
    setTimeout(() => {
      const ta = textareaRef.current
      if (!ta) return
      ta.focus()
      ta.setSelectionRange(value.length, value.length)
    }, 0)
  }

  if (readOnly) {
    if (!caption && !latex) return null
    return (
      <div className="space-y-2">
        {capPos !== 'below' && (
          <CaptionInput
            value={caption}
            readOnly
            placeholder={props.label}
            skipAutofill={content?.caption_skip_autofill}
            color={content?.caption_color}
            html={content?.caption_html}
          />
        )}
        {latex && (
          <div className="flex items-center gap-3 px-2 py-2">
            <div className="flex-1 min-w-0 overflow-x-auto">
              <MathRender latex={latex} displayMode={displayMode} />
            </div>
            {number && (
              <span className="shrink-0 text-sm text-muted-foreground tabular-nums">
                {number}
              </span>
            )}
          </div>
        )}
        {capPos === 'below' && (
          <CaptionInput
            value={caption}
            readOnly
            placeholder={props.label}
            skipAutofill={content?.caption_skip_autofill}
            color={content?.caption_color}
            html={content?.caption_html}
          />
        )}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {capPos !== 'below' && (
        <CaptionInput
          value={caption}
          onChange={(v) => patch({ caption: v })}
          placeholder={props.label}
          {...captionSkipProps({ content, patch })}
        />
      )}

      <div className="flex flex-wrap items-center gap-3 text-xs">
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground">표시:</span>
          <select
            value={displayMode}
            onChange={(e) => patch({ display_mode: e.target.value })}
            className="h-7 rounded border px-2 text-xs"
          >
            {DISPLAY_MODES.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground">식 번호:</span>
          <Input
            value={number}
            onChange={(e) => patch({ number: e.target.value })}
            placeholder="(1)"
            className="h-7 w-20 text-xs"
          />
        </div>
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground">예시:</span>
          <select
            // Wrapping the select's value with a sentinel keeps it
            // visually showing the placeholder after a template is
            // applied — picking the same name again should reload it.
            value=""
            onChange={(e) => {
              applyTemplate(e.target.value)
              e.target.value = ''
            }}
            className="h-7 rounded border px-2 text-xs"
          >
            <option value="">예시 선택…</option>
            {FORMULA_TEMPLATES.map((group) => (
              <optgroup key={group.group} label={group.group}>
                {group.items.map((t) => (
                  <option key={t.name} value={t.latex}>{t.name}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
        <a
          href="https://katex.org/docs/supported.html"
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto text-[10px] text-muted-foreground hover:text-foreground underline"
        >
          KaTeX 문법 참고
        </a>
      </div>

      {/* Symbol palette — click to insert at the textarea caret. Each
          row is a category; buttons preserve textarea focus via
          `onMouseDown.preventDefault()` so the caret stays put while
          the user reaches for a button. */}
      <div className="rounded-md border bg-muted/20 p-2 space-y-1 text-xs">
        {SYMBOL_CATEGORIES.map((cat) => (
          <div key={cat.name} className="flex items-start gap-2">
            <span className="text-[10px] text-muted-foreground w-10 shrink-0 pt-1">
              {cat.name}
            </span>
            <div className="flex flex-wrap gap-1">
              {cat.items.map((item, i) => (
                <button
                  key={i}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => insertSnippet(item.latex, item.caret ?? 0)}
                  title={item.title ?? item.latex.trim()}
                  className="inline-flex items-center justify-center min-w-[2rem] h-7 px-2 rounded border bg-background hover:bg-muted text-sm"
                >
                  {item.glyph}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* LaTeX source */}
        <div className="space-y-1">
          <div className="flex items-baseline justify-between">
            <Label className="text-[11px] text-muted-foreground">LaTeX 소스</Label>
            <span className="text-[10px] text-muted-foreground">
              Enter = 줄바꿈
            </span>
          </div>
          <textarea
            ref={textareaRef}
            value={latex}
            onChange={(e) => patch({ latex: e.target.value })}
            placeholder={SAMPLE_LATEX}
            // Monospace + sane defaults for the source — KaTeX accepts
            // single- and multi-line input the same way. We keep
            // newlines so the user can format `\begin{align}…\end{align}`
            // blocks readably without affecting the rendered output.
            className="w-full font-mono text-sm rounded-md border bg-background p-2 outline-none focus:ring-2 focus:ring-primary/20"
            rows={6}
            spellCheck={false}
          />
        </div>

        {/* Live preview */}
        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground">미리보기</Label>
          <div className="min-h-[6rem] rounded-md border bg-background p-3 flex items-center justify-center overflow-x-auto">
            {latex.trim() ? (
              <MathRender latex={latex} displayMode={displayMode} />
            ) : (
              <span className="text-xs text-muted-foreground">
                LaTeX 소스를 입력하면 미리보기가 나타납니다.
              </span>
            )}
          </div>
        </div>
      </div>
      {capPos === 'below' && (
        <CaptionInput
          value={caption}
          onChange={(v) => patch({ caption: v })}
          placeholder={props.label}
          {...captionSkipProps({ content, patch })}
        />
      )}
    </div>
  )
}

// --------------------------------------------------------------------------- //
// KaTeX renderer                                                                //
// --------------------------------------------------------------------------- //

/** Normalize the user's source so a literal newline in the textarea
 *  becomes a LaTeX line break. KaTeX accepts `\\` for line breaks in
 *  display mode (top-level OR inside math environments), so the
 *  writer can hit Enter to start a new line without learning the
 *  syntax. Pass-through when the source uses an explicit math env
 *  (`aligned`, `gathered`, `matrix`, …) — those manage their own
 *  line breaks via `\\` already; injecting more would break the
 *  layout. */
function prepareLatex(src) {
  if (!src) return ''
  if (/\\begin\{[a-zA-Z*]+\}/.test(src)) return src
  // Treat any run of newlines as a single break, drop empty lines.
  const lines = src
    .split(/\r?\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  if (lines.length <= 1) return src
  return lines.join(' \\\\ ')
}

/** Render a LaTeX string into a DOM node via KaTeX. Errors render
 *  inline in red rather than throwing — keeps the editor usable
 *  while the writer is mid-equation. */
function MathRender({ latex, displayMode = 'display' }) {
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    try {
      katex.render(prepareLatex(latex ?? ''), el, {
        displayMode: displayMode === 'display',
        throwOnError: false,
        errorColor: '#dc2626',
        // `output: html` skips the MathML twin which DOCX-export
        // captures don't need; smaller DOM, faster paint. Accessible
        // readers fall back to the raw LaTeX in `aria-label` below.
        output: 'html',
      })
    } catch (err) {
      el.textContent = String(err)
    }
  }, [latex, displayMode])
  return (
    <span
      ref={ref}
      // Source LaTeX as accessible label so screen readers / search
      // get something meaningful from the rendered formula.
      aria-label={latex}
    />
  )
}
