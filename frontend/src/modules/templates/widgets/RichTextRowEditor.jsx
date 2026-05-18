import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import StarterKit from '@tiptap/starter-kit'
import { Placeholder } from '@tiptap/extensions'
import { TextStyle, Color, FontSize } from '@tiptap/extension-text-style'
import {
  Bold as BoldIcon,
  Italic as ItalicIcon,
  Strikethrough as StrikeIcon,
  Underline as UnderlineIcon,
} from 'lucide-react'

// Toolbar choices. Both arrays use inline CSS values (not Tailwind class
// strings) — TipTap writes them as `style="font-size:..."` / `style="color:..."`
// so Tailwind purging is irrelevant here.
//
// Pixel-based sizes match the convention every common WYSIWYG (Word,
// Google Docs, Notion) uses. The empty-value "기본" row clears the mark
// so the row inherits the block / depth default again.
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

const COLOR_OPTIONS = [
  { label: '기본', value: null },
  { label: '검정', value: '#111827' },
  { label: '회색', value: '#6b7280' },
  { label: '빨강', value: '#dc2626' },
  { label: '주황', value: '#f97316' },
  { label: '노랑', value: '#ca8a04' },
  { label: '녹색', value: '#16a34a' },
  { label: '파랑', value: '#2563eb' },
  { label: '보라', value: '#9333ea' },
]

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
 * Plain-text logic upstream (prefix auto-convert `□ `/`- `/`· `, the `//`
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
    editable = true,
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
  useEffect(() => {
    onKeyDownRef.current = onKeyDown
    onChangeRef.current = onChange
    onFocusRef.current = onFocus
    onBlurRef.current = onBlur
    placeholderRef.current = placeholder
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
      }),
      TextStyle,
      Color,
      FontSize,
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
    onBlur: () => onBlurRef.current?.(),
  })

  // External rewrites (parent prefix-strip, content reset on item swap)
  // need to push their html back into the editor without firing onUpdate,
  // or we'd loop. setContent(..., false) skips emitting an update.
  useEffect(() => {
    if (!editor) return
    const incoming = html || '<p></p>'
    if (externalHtmlRef.current === incoming) return
    externalHtmlRef.current = incoming
    editor.commands.setContent(incoming, { emitUpdate: false })
  }, [html, editor])

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
          shouldShow={({ editor, from, to }) =>
            editor.isEditable && from !== to && !editor.state.selection.empty
          }
          className={RICH_TEXT_TOOLBAR_CLASS}
        >
          <RichTextFormatToolbarBody
            state={{
              bold: editor.isActive('bold'),
              italic: editor.isActive('italic'),
              underline: editor.isActive('underline'),
              strike: editor.isActive('strike'),
              fontSize: editor.getAttributes('textStyle')?.fontSize ?? '',
              color: editor.getAttributes('textStyle')?.color ?? null,
            }}
            actions={{
              toggleBold: () => editor.chain().focus().toggleBold().run(),
              toggleItalic: () => editor.chain().focus().toggleItalic().run(),
              toggleUnderline: () => editor.chain().focus().toggleUnderline().run(),
              toggleStrike: () => editor.chain().focus().toggleStrike().run(),
              setFontSize: (v) =>
                v
                  ? editor.chain().focus().setFontSize(v).run()
                  : editor.chain().focus().unsetFontSize().run(),
              setColor: (c) =>
                c
                  ? editor.chain().focus().setColor(c).run()
                  : editor.chain().focus().unsetColor().run(),
            }}
          />
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
export function RichTextFormatToolbarBody({ state, actions }) {
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
      <FontSizeSelect value={state.fontSize} onChange={actions.setFontSize} />
      <ToolbarSeparator />
      <ColorSwatches value={state.color} onChange={actions.setColor} />
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

function FontSizeSelect({ value, onChange }) {
  return (
    <select
      value={value ?? ''}
      onMouseDown={(e) => e.stopPropagation()}
      onChange={(e) => {
        const v = e.target.value
        onChange(v || null)
      }}
      className="h-7 rounded border border-input bg-background px-1 text-[11px]"
      title="글자 크기 (px)"
    >
      <option value="">기본</option>
      {FONT_SIZE_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

function ColorSwatches({ value, onChange }) {
  return (
    <div className="flex items-center gap-0.5">
      {COLOR_OPTIONS.map((c) => {
        const active = (c.value ?? null) === (value ?? null)
        return (
          <button
            key={c.label}
            type="button"
            title={c.label}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChange(c.value)}
            className={`h-5 w-5 rounded border ${
              active ? 'ring-2 ring-offset-1 ring-primary' : 'border-border'
            }`}
            style={{
              backgroundColor: c.value ?? 'transparent',
              backgroundImage:
                c.value === null
                  ? 'linear-gradient(135deg, transparent 45%, #ef4444 45%, #ef4444 55%, transparent 55%)'
                  : undefined,
            }}
          />
        )
      })}
    </div>
  )
}
