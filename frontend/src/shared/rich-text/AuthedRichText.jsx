import { useEffect, useRef } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Placeholder } from '@tiptap/extensions'
import { TextStyle, FontSize } from '@tiptap/extension-text-style'
import { toast } from 'sonner'
import {
  Bold as BoldIcon,
  Italic as ItalicIcon,
  Underline as UnderlineIcon,
  Strikethrough as StrikeIcon,
  List as ListIcon,
  ListOrdered,
  Image as ImageIcon,
} from 'lucide-react'
import { uploadFile } from '@/shared/api/files'
import { AuthedImageNode } from './AuthedImageNode'
import './authedRichText.css'

// 글자 크기 선택지(px). FontSize 마크가 인라인 style="font-size:.." 로 써서
// 저장 HTML·읽기 렌더에 그대로 반영된다. 빈 값("기본")은 마크를 해제한다.
const FONT_SIZE_OPTIONS = [
  '10px', '11px', '12px', '13px', '14px', '16px', '18px',
  '20px', '24px', '28px', '32px', '36px', '48px',
]

function imageFilesFromClipboard(event) {
  return Array.from(event.clipboardData?.items || [])
    .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
    .map((it) => it.getAsFile())
    .filter(Boolean)
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// 운영 중 쌓인 예전 글은 본문이 순수 텍스트다. TipTap 에 그대로 넣으면 개행이
// 공백으로 뭉개진다. 태그가 없으면 평문으로 보고 빈 줄=문단, 단일 개행=<br> 로
// 변환해 줄바꿈을 보존한다. 리치 에디터가 저장한 값은 <p> 등으로 시작하므로
// 이 변환을 타지 않는다.
const HTML_TAG_RE = /<(p|br|div|img|ul|ol|li|h[1-6]|strong|em|u|s|blockquote|code|span|a)[\s/>]/i

function normalizeToHtml(value) {
  if (!value) return ''
  if (HTML_TAG_RE.test(value)) return value
  const paras = escapeHtml(value)
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
  return paras.join('') || '<p></p>'
}

/** 리치 텍스트 에디터/뷰어(인증 blob 인라인 이미지 지원). `editable` 이면
 *  툴바(굵게·기울임·밑줄·취소선·목록·이미지)와 함께 편집, 아니면 콘텐츠만
 *  렌더한다. 이미지는 문단 사이에 삽입되고(커스텀 authedImage 노드) 드래그로
 *  크기를 조절할 수 있다. 값은 HTML 문자열. 예전 순수 텍스트 값도 자동 변환해
 *  하위 호환된다. read-only 렌더도 TipTap 을 거치므로 임의 스크립트 등은
 *  스키마에 없어 걸러진다(dangerouslySetInnerHTML 대비 안전). */
export function AuthedRichText({
  value = '',
  onChange,
  editable = true,
  placeholder = '내용을 입력하세요. 이미지는 툴바의 이미지 버튼, 드래그·앤·드롭, 또는 Ctrl+V 로 넣을 수 있습니다.',
}) {
  const fileInputRef = useRef(null)
  // insert 함수는 editor 클로저가 필요 → ref 로 최신 유지(paste/drop 핸들러가 참조).
  const insertRef = useRef(null)
  // 우리 자신의 업데이트로 인한 재시드를 막기 위한 마지막 외부 value 추적.
  const lastValueRef = useRef(value)

  const editor = useEditor({
    extensions: [
      StarterKit,
      TextStyle,
      FontSize,
      AuthedImageNode,
      ...(editable ? [Placeholder.configure({ placeholder })] : []),
    ],
    content: normalizeToHtml(value),
    editable,
    editorProps: {
      attributes: {
        class: editable ? 'rt-prose min-h-[140px]' : 'rt-prose',
      },
      handlePaste(_view, event) {
        const files = imageFilesFromClipboard(event)
        if (!files.length) return false
        event.preventDefault()
        files.forEach((f) => insertRef.current?.(f))
        return true
      },
      handleDrop(_view, event) {
        const files = Array.from(event.dataTransfer?.files || []).filter((f) =>
          f.type.startsWith('image/'),
        )
        if (!files.length) return false
        event.preventDefault()
        files.forEach((f) => insertRef.current?.(f))
        return true
      },
    },
    onUpdate({ editor }) {
      const html = editor.getHTML()
      lastValueRef.current = html
      onChange?.(html)
    },
  })

  useEffect(() => {
    insertRef.current = async (file) => {
      if (!editor) return
      if (!file.type.startsWith('image/')) {
        toast.error(`이미지 파일만 가능: ${file.name}`)
        return
      }
      try {
        const meta = await uploadFile(file)
        editor
          .chain()
          .focus()
          .insertContent({
            type: 'authedImage',
            attrs: { fileId: meta.id, filename: file.name },
          })
          .run()
      } catch (e) {
        toast.error(e.message || '이미지 업로드 실패')
      }
    }
  }, [editor])

  useEffect(() => {
    editor?.setEditable(editable)
  }, [editable, editor])

  // 외부 value 변경(뷰어에서 다른 글로 전환 등) 동기화.
  useEffect(() => {
    if (!editor) return
    if (value === lastValueRef.current) return
    lastValueRef.current = value
    const html = normalizeToHtml(value)
    if (html !== editor.getHTML()) {
      editor.commands.setContent(html, { emitUpdate: false })
    }
  }, [value, editor])

  if (!editor) return null

  if (!editable) {
    return <EditorContent editor={editor} />
  }

  function pickImages(files) {
    Array.from(files || []).forEach((f) => insertRef.current?.(f))
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  return (
    <div className="rounded-md border">
      <div className="flex flex-wrap items-center gap-0.5 border-b bg-muted/30 px-1.5 py-1">
        <TB
          active={editor.isActive('bold')}
          onClick={() => editor.chain().focus().toggleBold().run()}
          title="굵게 (Ctrl+B)"
        >
          <BoldIcon className="h-4 w-4" />
        </TB>
        <TB
          active={editor.isActive('italic')}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          title="기울임 (Ctrl+I)"
        >
          <ItalicIcon className="h-4 w-4" />
        </TB>
        <TB
          active={editor.isActive('underline')}
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          title="밑줄 (Ctrl+U)"
        >
          <UnderlineIcon className="h-4 w-4" />
        </TB>
        <TB
          active={editor.isActive('strike')}
          onClick={() => editor.chain().focus().toggleStrike().run()}
          title="취소선"
        >
          <StrikeIcon className="h-4 w-4" />
        </TB>
        <Sep />
        <FontSizeSelect editor={editor} />
        <Sep />
        <TB
          active={editor.isActive('bulletList')}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          title="글머리 기호 목록"
        >
          <ListIcon className="h-4 w-4" />
        </TB>
        <TB
          active={editor.isActive('orderedList')}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          title="번호 매기기 목록"
        >
          <ListOrdered className="h-4 w-4" />
        </TB>
        <Sep />
        <TB onClick={() => fileInputRef.current?.click()} title="이미지 삽입">
          <ImageIcon className="h-4 w-4" />
        </TB>
      </div>
      <EditorContent editor={editor} className="px-3 py-2" />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => pickImages(e.target.files)}
      />
    </div>
  )
}

function TB({ active, onClick, title, children }) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      title={title}
      className={`inline-flex h-7 w-7 items-center justify-center rounded transition-colors ${
        active
          ? 'bg-primary/15 text-primary'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
      }`}
    >
      {children}
    </button>
  )
}

function Sep() {
  return <span className="mx-0.5 inline-block h-4 w-px bg-border" />
}

function FontSizeSelect({ editor }) {
  // 현재 선택/커서 위치의 글자 크기(없으면 기본). useEditor 가 선택 변경마다
  // 리렌더하므로 값이 실시간 반영된다.
  const current = editor.getAttributes('textStyle')?.fontSize ?? ''
  return (
    <select
      value={current}
      // 네이티브 select 를 열 때 preventDefault 하면 안 되지만(드롭다운이 안 열림),
      // 선택 상태는 아래 onChange 의 .focus() 가 되살린다.
      onMouseDown={(e) => e.stopPropagation()}
      onChange={(e) => {
        const v = e.target.value
        if (v) editor.chain().focus().setFontSize(v).run()
        else editor.chain().focus().unsetFontSize().run()
      }}
      className="h-7 rounded border border-input bg-background px-1 text-[11px]"
      title="글자 크기 (px)"
    >
      <option value="">크기</option>
      {FONT_SIZE_OPTIONS.map((v) => (
        <option key={v} value={v}>
          {parseInt(v, 10)}
        </option>
      ))}
    </select>
  )
}
