import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import StarterKit from '@tiptap/starter-kit'
import { Placeholder } from '@tiptap/extensions'
import { TextStyle, FontSize, FontFamily } from '@tiptap/extension-text-style'
import { DOMSerializer } from '@tiptap/pm/model'
import { TextColor, ColorSwatchPicker, hexToToken, colorTokenClass } from '@/shared/text-color'
import {
  Bold as BoldIcon,
  Italic as ItalicIcon,
  Strikethrough as StrikeIcon,
  Underline as UnderlineIcon,
  Link2Off as UnlinkIcon,
} from 'lucide-react'
import { ReportLinkMark } from './extensions/ReportLinkMark'

// Font-size choices. Values are inline CSS (`style="font-size:..."`) so
// Tailwind purging is irrelevant here. Text *color* is no longer a hex array —
// it lives in the shared token system (@/shared/text-color), rendered as a
// `rt-c-{token}` class so it adapts to light/dark.
//
// Pixel-based sizes match the convention every common WYSIWYG (Word,
// Google Docs, Notion) uses. The empty-value "기본" row clears the mark
// so the row inherits the block / depth default again.
// Inline font-family choices. Values are full CSS font stacks (the FontFamily
// mark writes them as `style="font-family:..."` — free-form, so unlike the
// block-level keyed enum we can list as many as we like). Each ends in a
// generic fallback so text stays readable when the named font isn't installed.
export const FONT_FAMILY_OPTIONS = [
  // 한국어 시스템 글꼴
  { label: '맑은 고딕', value: "'Malgun Gothic', '맑은 고딕', sans-serif" },
  { label: '바탕', value: "Batang, '바탕', serif" },
  { label: '굴림', value: "Gulim, '굴림', sans-serif" },
  { label: '돋움', value: "Dotum, '돋움', sans-serif" },
  { label: '궁서', value: "Gungsuh, '궁서', serif" },
  { label: '나눔고딕', value: "'Nanum Gothic', sans-serif" },
  { label: '나눔명조', value: "'Nanum Myeongjo', serif" },
  // 범용(시스템 기본 스택)
  {
    label: '산세리프',
    value: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  },
  {
    label: '세리프',
    value: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
  },
  {
    label: '고정폭',
    value: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  },
  // 라틴 글꼴
  { label: 'Arial', value: 'Arial, Helvetica, sans-serif' },
  { label: 'Times New Roman', value: "'Times New Roman', Times, serif" },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Courier New', value: "'Courier New', Courier, monospace" },
]

// 다중 셀 일괄 툴바에서 선택 셀들의 글자크기가 제각각일 때 FontSizeSelect 에
// 넘기는 sentinel — 어떤 옵션 value 와도 안 맞아 드롭다운이 공란으로 표시된다.
export const MIXED_FONT_SIZE = 'mixed'

export const FONT_SIZE_OPTIONS = [
  { label: '10', value: '10px' },
  { label: '11', value: '11px' },
  { label: '12', value: '12px' },
  { label: '13', value: '13px' },
  { label: '14', value: '14px' },
  { label: '16', value: '16px' },
  { label: '18', value: '18px' },
  { label: '20', value: '20px' },
  { label: '24', value: '24px' },
  { label: '28', value: '28px' },
  { label: '32', value: '32px' },
  { label: '36', value: '36px' },
  { label: '48', value: '48px' },
]

// Slice the row's single-paragraph doc into a `before` and `after` half at
// a 0-based plain-text offset, preserving inline marks (bold/italic/color/
// font-size) on both sides. The slice is serialized back to html via the
// schema's DOMSerializer and re-wrapped in `<p>...</p>` so the result is a
// drop-in replacement for items[i].html.
function sliceAtChar(view, charOffset) {
  const docSize = view.state.doc.content.size
  // ProseMirror positions: the paragraph's interior spans [1, docSize - 1].
  const start = 1
  const end = Math.max(start, docSize - 1)
  const splitPos = Math.max(start, Math.min(start + (charOffset | 0), end))

  const schema = view.state.schema
  const serializer = DOMSerializer.fromSchema(schema)

  function sliceHtml(fragment) {
    const container = document.createElement('div')
    container.appendChild(serializer.serializeFragment(fragment))
    return container.innerHTML
  }

  const beforeFragment = view.state.doc.slice(start, splitPos).content
  const afterFragment = view.state.doc.slice(splitPos, end).content
  const beforeInner = sliceHtml(beforeFragment)
  const afterInner = sliceHtml(afterFragment)
  const beforeText = view.state.doc.textBetween(start, splitPos, '', '')
  const afterText = view.state.doc.textBetween(splitPos, end, '', '')

  return {
    beforeHtml: `<p>${beforeInner}</p>`,
    beforeText,
    afterHtml: `<p>${afterInner}</p>`,
    afterText,
  }
}

/**
 * A single-line rich text editor used as one row of the RichText widget's
 * outline. Renders TipTap inline and exposes the same imperative surface
 * (focus/blur/caret/length) the old `<input>` ref used to offer, so the
 * parent OutlineRow's keyboard wiring keeps working unchanged.
 *
 * The editor is configured down to a single paragraph — block-level marks
 * (heading, lists, blockquote, code block, hard break) are disabled so
 * the row stays one logical line. Enter / Tab / Backspace at boundaries
 * are bubbled to the parent via `onKeyDown` so depth changes and row
 * splitting still happen at the outline level, not inside the editor.
 *
 * Plain-text logic upstream (prefix auto-convert `■ `/`- `/`· `, the `//`
 * relation combo, char counts) reads the second argument of `onChange`
 * (`text`); the first argument is the canonical HTML stored on the item.
 */
export const RichTextRowEditor = forwardRef(function RichTextRowEditor(
  {
    html,
    placeholder,
    onChange,
    onKeyDown,
    onFocus,
    onBlur,
    className,
    // React-style object (camelCase keys) applied directly to the
    // ProseMirror contenteditable DOM node. Inline style here wins over
    // any conflicting Tailwind class on the same element, which is how
    // template-time `text_style.font_size_px` / weight / family / align
    // beat the editor's hard-coded `text-sm` baseline.
    style,
    editable = true,
    // 표/비교표 셀에서 그리드 포커스 타깃(querySelector)으로 쓰도록 contenteditable
    // DOM 에 data-grid-cell 을 달아 준다. 비우면 미부착.
    gridCellKey,
    // 탭/줄바꿈이 든 붙여넣기(엑셀 표)를 여러 셀로 펼치도록 부모에 위임.
    // 호출되면 에디터 기본 붙여넣기는 막는다.
    onPastePlain,
    // 버블 메뉴 글자크기 선택의 "기본" 라벨에 실제 기본 px 을 명시(예:
    // "기본 (18px)"). 안 주면 그냥 "기본". 표 셀은 표의 기본 본문 크기를
    // 내려보내 작성자가 기본값이 몇 px 인지 알게 한다.
    defaultSizePx,
  },
  ref,
) {
  // Track the latest "external" html string so the effect below can tell
  // whether a content reset came from the parent or from our own update.
  // Without this, calling setContent in response to our own onUpdate would
  // bounce the cursor to the start every keystroke.
  const externalHtmlRef = useRef(html)
  // Cross-row toolbar applies formatting to many rows in one shot. Setting
  // each editor's selection + running a command would normally fire onUpdate
  // → parent setState → race between rows. While this flag is on the
  // editor's onUpdate is a no-op; the caller harvests getHTML/getText itself
  // and batches the items update into a single onChange.
  const suppressUpdateRef = useRef(false)
  // Callback refs — TipTap captures editorProps once at construction time,
  // so closures over parent state would go stale across renders. We read
  // the latest callbacks through refs on every keystroke instead.
  const onKeyDownRef = useRef(onKeyDown)
  const onChangeRef = useRef(onChange)
  const onFocusRef = useRef(onFocus)
  const onBlurRef = useRef(onBlur)
  const placeholderRef = useRef(placeholder)
  // 표/비교표 셀: 탭/줄바꿈이 든 붙여넣기(엑셀)를 가로채 여러 셀로 펼치게
  // 부모에 넘긴다. 단일 값 붙여넣기는 평소대로 에디터가 처리.
  const onPastePlainRef = useRef(onPastePlain)
  // 버블 툴바(글자크기/글꼴 select·색 스와치) 를 조작하는 동안만 true. 네이티브
  // <select> 를 누르면 에디터가 blur 되는데, 그때 선택을 접어버리면 명령이
  // 빈 선택에 적용돼 버린다. 이 플래그가 켜져 있으면 blur-collapse 를 건너뛴다.
  const toolbarInteractingRef = useRef(false)
  useEffect(() => {
    onKeyDownRef.current = onKeyDown
    onChangeRef.current = onChange
    onFocusRef.current = onFocus
    onBlurRef.current = onBlur
    placeholderRef.current = placeholder
    onPastePlainRef.current = onPastePlain
  })

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Inline-only: kill every block-level node StarterKit adds so the
        // doc is always `<doc><paragraph><text*/></paragraph></doc>`.
        heading: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
        hardBreak: false,
        // We use Underline below — StarterKit provides it too in v3 but
        // configuring it here is a no-op since we don't extend it further.
        //
        // Per-row history is disabled — undo/redo is owned by the parent
        // OutlineEditor so a single Ctrl+Z can step back across structural
        // changes (Enter splits, Tab depth, relation chips) that don't
        // pass through any one editor's transaction log.
        history: false,
        // StarterKit v3 enables a Link mark by default; we don't expose it
        // and it would collide with ReportLinkMark's `<a>` parseHTML. Off.
        link: false,
      }),
      TextStyle,
      TextColor,
      FontSize,
      FontFamily,
      ReportLinkMark,
      Placeholder.configure({
        // The placeholder text comes from props.placeholder. Latest value
        // lives on a ref so updating it after construction is cheap (the
        // extension reads `editor.options.placeholder` on each render).
        placeholder: () => placeholderRef.current ?? '',
        emptyEditorClass: 'rt-row-empty',
      }),
    ],
    content: html || '<p></p>',
    editable,
    editorProps: {
      attributes: {
        class: className || '',
        spellcheck: 'false',
        ...(gridCellKey ? { 'data-grid-cell': gridCellKey } : {}),
      },
      // 엑셀 등에서 탭/줄바꿈이 든 텍스트를 붙여넣으면 부모(표/비교표)가
      // 여러 셀로 펼치게 위임 — 단일 값/일반 텍스트는 그대로 에디터가 처리.
      handlePaste(_view, event) {
        const cb = onPastePlainRef.current
        if (!cb) return false
        const text = event.clipboardData?.getData('text/plain')
        if (!text || (text.indexOf('\t') === -1 && text.indexOf('\n') === -1)) {
          return false
        }
        event.preventDefault()
        // text/html 도 함께 넘긴다 — 부모(표/비교표)가 엑셀 셀 병합
        // (rowspan/colspan)을 재현하는 데 쓴다. 평문엔 병합 정보가 없음.
        cb(text, event.clipboardData?.getData('text/html') || '')
        return true
      },
      // Normalize pasted color before ProseMirror parses it: external sources
      // (Excel/Word/web) bring inline `color`/`<font color>`, most often a
      // default black that turns invisible in dark mode. Map each to a palette
      // token class (near-black/white absorb to "no color" → inherits theme),
      // and drop background fills. The TextColor mark would map inline color on
      // its own, but pre-cleaning keeps the doc free of raw hex + bg noise.
      transformPastedHTML(html) {
        if (typeof html !== 'string' || !html || typeof DOMParser === 'undefined') {
          return html
        }
        let doc
        try {
          doc = new DOMParser().parseFromString(html, 'text/html')
        } catch {
          return html
        }
        doc.querySelectorAll('font[color]').forEach((el) => {
          const cls = colorTokenClass(hexToToken(el.getAttribute('color')))
          el.removeAttribute('color')
          if (cls) el.classList.add(cls)
        })
        doc.querySelectorAll('[style]').forEach((el) => {
          const { style } = el
          if (style.color) {
            const cls = colorTokenClass(hexToToken(style.color))
            style.removeProperty('color')
            if (cls) el.classList.add(cls)
          }
          style.removeProperty('background-color')
          style.removeProperty('background')
          if (!el.getAttribute('style')) el.removeAttribute('style')
        })
        return doc.body.innerHTML
      },
      handleKeyDown(view, event) {
        const cb = onKeyDownRef.current
        if (!cb) return false
        const { from, to } = view.state.selection
        const docLen = view.state.doc.textContent.length
        const ctx = {
          atStart: from === to && from <= 1,
          atEnd: from === to && from >= docLen + 1,
          text: view.state.doc.textContent,
          caret: Math.max(0, from - 1),
          isCollapsed: from === to,
          // Split the paragraph at the current caret, returning rich-html
          // halves so an Enter keypress mid-line can move the tail to a new
          // row without losing inline marks. Caller decides whether to act
          // on the result (e.g. only split when afterText is non-empty).
          splitAtCaret: () => sliceAtChar(view, Math.max(0, from - 1)),
        }
        // The callback returns true to absorb (suppresses default), false
        // to let ProseMirror handle normally.
        return !!cb(event, ctx)
      },
    },
    onUpdate({ editor }) {
      if (suppressUpdateRef.current) return
      const nextHtml = editor.getHTML()
      const nextText = editor.getText()
      externalHtmlRef.current = nextHtml
      onChangeRef.current?.(nextHtml, nextText)
    },
    onFocus: () => onFocusRef.current?.(),
    onBlur: ({ editor }) => {
      // 포커스가 빠질 때(특히 한글 IME 조합을 마치고 다른 창/프로그램으로 전환)
      // 마지막 입력이 부모 state 로 아직 안 올라갔을 수 있다. blur 시 현재 에디터
      // 내용을 한 번 더 onChange 로 흘려 "마지막 글자 유실"을 막는다. 이미 같은
      // 내용이 올라가 있으면(externalHtmlRef 일치) 건너뛴다(중복 커밋 방지).
      if (editor && !editor.isDestroyed && !suppressUpdateRef.current) {
        const nextHtml = editor.getHTML()
        if (nextHtml !== externalHtmlRef.current) {
          externalHtmlRef.current = nextHtml
          onChangeRef.current?.(nextHtml, editor.getText())
        }
      }
      onBlurRef.current?.()
      // 셀 밖/다른 셀로 포커스가 빠지면 남아 있던 텍스트 선택을 접어 버블
      // 메뉴(서식 팔렛)를 닫는다 — 안 그러면 셀마다 에디터가 선택을 그대로
      // 들고 있어 팔렛이 안 꺼지는 채로 남는다. 단, 자기 버블 툴바를 조작
      // 중이면(글꼴/크기 select·색 스와치) 선택을 유지해야 명령이 먹는다.
      window.setTimeout(() => {
        if (!editor || editor.isDestroyed) return
        if (editor.isFocused || toolbarInteractingRef.current) return
        const { from, to } = editor.state.selection
        if (from !== to) editor.commands.setTextSelection(from)
      }, 150)
    },
  })

  // External rewrites (parent prefix-strip, content reset on item swap)
  // need to push their html back into the editor without firing onUpdate,
  // or we'd loop. setContent(..., false) skips emitting an update.
  useEffect(() => {
    if (!editor) return
    const incoming = html || '<p></p>'
    if (externalHtmlRef.current === incoming) return
    // IME 조합 중엔 setContent 가 조합을 끊어 조합 중이던 마지막 글자를 날린다
    // (ProseMirror 도 조합 중 DOM 변경을 피한다). 조합이 끝날 때까지 재시드를
    // 미룬다 — externalHtmlRef 를 갱신하지 않으므로, 조합 종료 후 onUpdate 가
    // 최신 html 을 올리면 이 효과가 다시 평가돼 자연스레 일치(재시드 불필요)한다.
    if (editor.view?.composing) return
    externalHtmlRef.current = incoming
    editor.commands.setContent(incoming, { emitUpdate: false })
  }, [html, editor])

  // Sync `style` prop → contenteditable DOM. We only manage the four
  // typography properties the template editor can set; any other inline
  // style (e.g. per-character `font-size: 16px` from the bubble menu)
  // lives inside the doc and is unaffected. Clearing happens by setting
  // the property to the empty string, which restores cascade behavior.
  // We depend on the individual fields rather than the `style` object
  // identity because parent helpers (`depthBodyInlineStyle`) build a
  // fresh object each render — depending on the object would re-fire on
  // every keystroke for no behavioral reason.
  useEffect(() => {
    if (!editor) return
    const dom = editor.view?.dom
    if (!dom) return
    const s = style ?? {}
    dom.style.fontSize = s.fontSize ?? ''
    dom.style.fontFamily = s.fontFamily ?? ''
    dom.style.fontWeight = s.fontWeight == null ? '' : String(s.fontWeight)
    dom.style.textAlign = s.textAlign ?? ''
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, style?.fontSize, style?.fontFamily, style?.fontWeight, style?.textAlign])

  useImperativeHandle(
    ref,
    () => ({
      focus(opts) {
        editor?.commands.focus(opts?.position)
      },
      blur() {
        editor?.commands.blur()
      },
      getHTML: () => editor?.getHTML() ?? '',
      getText: () => editor?.getText() ?? '',
      // 이 셀(에디터) 안 텍스트 런들의 글자크기 집합. 서식 없는(=기본) 런은
      // null 로 표기하고, 빈 셀도 {null}(=기본) 을 돌려준다. 표의 일괄 서식
      // 툴바가 선택한 여러 셀의 집합을 합쳐 '균일/혼합/기본'을 판단한다.
      getFontSizeSet() {
        const out = new Set()
        if (!editor) return out
        editor.state.doc.descendants((node) => {
          if (!node.isText) return
          const ts = node.marks.find((m) => m.type.name === 'textStyle')
          out.add(ts?.attrs?.fontSize || null)
        })
        if (out.size === 0) out.add(null)
        return out
      },
      // ProseMirror positions: 0 = before doc, 1 = inside <p> at start.
      // We report a 0-based caret across plain text so the parent's
      // "caret === 0" / "caret === length" checks keep semantic meaning.
      getCaret() {
        if (!editor) return 0
        const { from } = editor.state.selection
        return Math.max(0, from - 1)
      },
      setCaret(pos) {
        if (!editor) return
        const max = editor.state.doc.textContent.length
        const target = Math.max(0, Math.min(pos | 0, max)) + 1
        editor.commands.setTextSelection(target)
      },
      getTextLength: () => editor?.state.doc.textContent.length ?? 0,
      isAtStart() {
        if (!editor) return true
        const { from, to } = editor.state.selection
        return from === to && from <= 1
      },
      isAtEnd() {
        if (!editor) return true
        const { from, to } = editor.state.selection
        const end = editor.state.doc.textContent.length + 1
        return from === to && from >= end
      },
      // Used by the cross-row drag in RichText.jsx — flipping editable off
      // lets the browser's native selection extend past the row boundary
      // without ProseMirror snapping it back to a single editor's doc.
      setEditable(b) {
        editor?.setEditable(!!b)
      },
      // Split the paragraph at an explicit 0-based plain-text offset and
      // return both halves as `<p>...</p>` html (with marks preserved) plus
      // their text. Used by the cross-row Delete handler so it can keep
      // chars 0..fromOffset of the first row and chars toOffset..end of the
      // last row without losing inline formatting.
      splitAt(charOffset) {
        if (!editor) return null
        return sliceAtChar(editor.view, charOffset)
      },
      // Map a DOM selection endpoint (node + offset) to a 0-based char
      // index within this row's plain text. Returns null when the position
      // sits outside the editor doc. Used by RichText.jsx to record where
      // a cross-row drag started/ended within each row.
      charOffsetFromDOM(node, offset) {
        if (!editor) return null
        try {
          const pos = editor.view.posAtDOM(node, offset, -1)
          if (typeof pos !== 'number' || pos < 0) return null
          return Math.max(0, pos - 1)
        } catch (_err) {
          return null
        }
      },
      // Run `cb(editor)` (one or more chained commands) without firing the
      // normal onUpdate → parent setState path, and return the resulting
      // html/text. The caller is expected to fold these into a single
      // batched onChange so per-row commands don't race on stale items.
      // Forces editable=true around the call because some TipTap mark
      // commands no-op on read-only editors; the previous editable state
      // is restored before returning.
      applyAndCapture(cb) {
        if (!editor) return { html: '', text: '' }
        suppressUpdateRef.current = true
        const wasEditable = editor.isEditable
        if (!wasEditable) editor.setEditable(true)
        try {
          cb(editor)
        } finally {
          if (!wasEditable) editor.setEditable(false)
          suppressUpdateRef.current = false
        }
        const nextHtml = editor.getHTML()
        const nextText = editor.getText()
        externalHtmlRef.current = nextHtml
        return { html: nextHtml, text: nextText }
      },
      // Insert a mention link at the caret. `queryLength` chars are deleted
      // backward from the caret first (the typed "@query"), then the display
      // `text` is inserted carrying the reportLink mark with the given `attrs`
      // (report: {reportId, workspaceSlug}; dept: {deptSlug}). Returns the new
      // html/text (like applyAndCapture) so the parent folds it into one
      // batched onChange / undo step. No-ops the per-editor onUpdate while
      // running so the parent owns the single state write.
      insertReportLink({ text, queryLength = 0, attrs = {} }) {
        if (!editor || !text) return { html: editor?.getHTML() ?? '', text: editor?.getText() ?? '' }
        suppressUpdateRef.current = true
        const wasEditable = editor.isEditable
        if (!wasEditable) editor.setEditable(true)
        try {
          const { from } = editor.state.selection
          const start = Math.max(1, from - Math.max(0, queryLength | 0))
          editor
            .chain()
            .focus()
            .deleteRange({ from: start, to: from })
            .insertContent({
              type: 'text',
              text,
              marks: [{ type: 'reportLink', attrs }],
            })
            // Drop the mark from the stored selection so the next typed
            // char after the link is plain text (inclusive:false already
            // covers most cases; this is belt-and-suspenders).
            .unsetMark('reportLink')
            .run()
        } finally {
          if (!wasEditable) editor.setEditable(false)
          suppressUpdateRef.current = false
        }
        const nextHtml = editor.getHTML()
        const nextText = editor.getText()
        externalHtmlRef.current = nextHtml
        return { html: nextHtml, text: nextText }
      },
    }),
    [editor],
  )

  if (!editor) return null

  return (
    <>
      <EditorContent editor={editor} />
      {editable && (
        <BubbleMenu
          editor={editor}
          options={{ placement: 'top' }}
          // Hide on empty selection so the toolbar doesn't flash while
          // the user is just typing — only show when actual text is picked.
          // 포커스 조건이 핵심: 다중 셀 일괄 서식은 각 셀 에디터에서
          // selectAll() 을 돌려 비어있지 않은 선택을 남기는데, 포커스까지
          // 봐야 그 많은(포커스 없는) 셀들의 버블 팔렛이 한꺼번에 뜨는 걸
          // 막는다. 자기 툴바 조작 중(네이티브 select 클릭 등)엔 blur 돼도
          // 계속 보여야 하므로 toolbarInteractingRef 로 예외.
          shouldShow={({ editor, from, to }) =>
            editor.isEditable &&
            from !== to &&
            !editor.state.selection.empty &&
            (editor.isFocused || toolbarInteractingRef.current)
          }
          className={RICH_TEXT_TOOLBAR_CLASS}
        >
          {/* 툴바를 만지는 동안 blur-collapse 를 잠시 끈다(네이티브 select 가
              에디터를 blur 시켜도 선택이 유지되도록). pointerdown 직후 잠깐만. */}
          <div
            className="contents"
            onPointerDown={() => {
              toolbarInteractingRef.current = true
              window.setTimeout(() => {
                toolbarInteractingRef.current = false
              }, 400)
            }}
          >
          <RichTextFormatToolbarBody
            defaultSizePx={defaultSizePx}
            state={{
              bold: editor.isActive('bold'),
              italic: editor.isActive('italic'),
              underline: editor.isActive('underline'),
              strike: editor.isActive('strike'),
              fontSize: editor.getAttributes('textStyle')?.fontSize ?? '',
              fontFamily: editor.getAttributes('textStyle')?.fontFamily ?? '',
              color: editor.getAttributes('textColor')?.token ?? null,
              reportLink: editor.isActive('reportLink'),
            }}
            actions={{
              toggleBold: () => editor.chain().focus().toggleBold().run(),
              toggleItalic: () => editor.chain().focus().toggleItalic().run(),
              toggleUnderline: () => editor.chain().focus().toggleUnderline().run(),
              toggleStrike: () => editor.chain().focus().toggleStrike().run(),
              unsetReportLink: () =>
                editor.chain().focus().unsetReportLink().run(),
              setFontSize: (v) =>
                v
                  ? editor.chain().focus().setFontSize(v).run()
                  : editor.chain().focus().unsetFontSize().run(),
              setFontFamily: (v) =>
                v
                  ? editor.chain().focus().setFontFamily(v).run()
                  : editor.chain().focus().unsetFontFamily().run(),
              setColor: (c) =>
                c
                  ? editor.chain().focus().setColor(c).run()
                  : editor.chain().focus().unsetColor().run(),
            }}
          />
          </div>
        </BubbleMenu>
      )}
    </>
  )
})

// Shared chrome / styling between the per-row TipTap bubble menu and the
// cross-row floating toolbar in RichText.jsx, so both look identical.
export const RICH_TEXT_TOOLBAR_CLASS =
  'z-50 flex items-center gap-1 rounded-md border bg-popover px-1 py-1 shadow-md'

/**
 * The inner contents of the format toolbar. Pre-computed `state` and
 * dispatch `actions` keep this component decoupled from any specific
 * TipTap instance — the in-editor bubble menu wires it to a single editor,
 * while the cross-row toolbar wires it to row-html manipulation helpers.
 */
export function RichTextFormatToolbarBody({ state, actions, defaultSizePx }) {
  return (
    <>
      <ToolbarButton
        active={!!state.bold}
        onClick={actions.toggleBold}
        title="굵게 (Ctrl+B)"
      >
        <BoldIcon className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        active={!!state.italic}
        onClick={actions.toggleItalic}
        title="기울임 (Ctrl+I)"
      >
        <ItalicIcon className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        active={!!state.underline}
        onClick={actions.toggleUnderline}
        title="밑줄 (Ctrl+U)"
      >
        <UnderlineIcon className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        active={!!state.strike}
        onClick={actions.toggleStrike}
        title="취소선 (Ctrl+Shift+S)"
      >
        <StrikeIcon className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarSeparator />
      <FontFamilySelect value={state.fontFamily} onChange={actions.setFontFamily} />
      <FontSizeSelect
        value={state.fontSize}
        onChange={actions.setFontSize}
        defaultSizePx={defaultSizePx}
      />
      <ToolbarSeparator />
      <ColorSwatchPicker value={state.color} onChange={actions.setColor} />
      {/* 보고서 멘션 링크가 선택에 걸려 있을 때만 — 링크 해제(텍스트는 유지). */}
      {state.reportLink && actions.unsetReportLink && (
        <>
          <ToolbarSeparator />
          <ToolbarButton
            active={false}
            onClick={actions.unsetReportLink}
            title="보고서 링크 해제"
          >
            <UnlinkIcon className="h-3.5 w-3.5" />
          </ToolbarButton>
        </>
      )}
    </>
  )
}

function ToolbarButton({ active, onClick, title, children }) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      title={title}
      className={`inline-flex h-7 w-7 items-center justify-center rounded text-xs transition-colors ${
        active
          ? 'bg-primary/15 text-primary'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
      }`}
    >
      {children}
    </button>
  )
}

function ToolbarSeparator() {
  return <span className="mx-0.5 inline-block h-4 w-px bg-border" />
}

function FontFamilySelect({ value, onChange }) {
  return (
    <select
      value={value ?? ''}
      onMouseDown={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.value || null)}
      className="h-7 max-w-[7.5rem] rounded border border-input bg-background px-1 text-[11px]"
      title="글자체"
    >
      <option value="">글꼴</option>
      {FONT_FAMILY_OPTIONS.map((o) => (
        <option key={o.label} value={o.value} style={{ fontFamily: o.value }}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

function FontSizeSelect({ value, onChange, defaultSizePx }) {
  // "기본" 행에 실제 기본 px 을 같이 표기 — 작성자가 기본이 몇 px 인지 알게.
  const defaultLabel = Number.isFinite(defaultSizePx)
    ? `기본 (${defaultSizePx}px)`
    : '기본'
  // 선택 셀들의 크기가 제각각이면(MIXED) 어떤 옵션과도 안 맞는 숨은 항목을
  // 골라 둬서 드롭다운이 공란으로 보이게 한다.
  const isMixed = value === MIXED_FONT_SIZE
  return (
    <select
      value={isMixed ? MIXED_FONT_SIZE : (value ?? '')}
      onMouseDown={(e) => e.stopPropagation()}
      onChange={(e) => {
        const v = e.target.value
        onChange(v || null)
      }}
      className="h-7 rounded border border-input bg-background px-1 text-[11px]"
      title="글자 크기 (px)"
    >
      {isMixed && <option value={MIXED_FONT_SIZE} hidden />}
      <option value="">{defaultLabel}</option>
      {FONT_SIZE_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

