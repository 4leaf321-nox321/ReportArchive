import { useRef, useState } from 'react'
import { Node, mergeAttributes } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react'
import { AuthedImage } from '@/shared/components/AuthedImage'

/** 리치 텍스트 본문에 인라인으로 들어가는 이미지. 원본 파일은 인증이 필요한
 *  blob 이라 표준 Image 확장(<img src>)으로는 못 띄운다. 그래서 파일 id 만
 *  저장하고 AuthedImage(토큰 fetch)로 그리는 커스텀 노드. width(px)를 저장해
 *  크기 조절 결과가 본문 HTML 에 남는다. 저장 HTML 형태:
 *    <img data-file-id="ID" data-width="320" style="width:320px"> */

function AuthedImageView({ node, updateAttributes, selected, editor }) {
  const { fileId, width, filename } = node.attrs
  const editable = editor.isEditable
  const boxRef = useRef(null)
  // 드래그 중엔 로컬 폭으로 부드럽게 미리보기, 놓을 때 한 번만 노드 속성 커밋
  // (매 이동마다 트랜잭션을 쌓아 undo 이력을 더럽히지 않도록).
  const [dragW, setDragW] = useState(null)
  const effectiveWidth = dragW ?? width

  function startResize(e) {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startW = boxRef.current?.offsetWidth || 320
    let latest = startW
    function onMove(ev) {
      let w = Math.round(startW + (ev.clientX - startX))
      w = Math.max(60, w)
      const parentW = boxRef.current?.parentElement?.offsetWidth
      if (parentW) w = Math.min(w, parentW)
      latest = w
      setDragW(w)
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setDragW(null)
      updateAttributes({ width: latest })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <NodeViewWrapper
      className="rt-img-node"
      style={{ margin: '0.5rem 0' }}
      data-drag-handle
    >
      <span
        ref={boxRef}
        style={{
          position: 'relative',
          display: 'inline-block',
          maxWidth: '100%',
          lineHeight: 0,
        }}
        className={
          selected && editable ? 'rounded ring-2 ring-primary ring-offset-1' : ''
        }
      >
        <AuthedImage
          fileId={fileId}
          alt={filename || ''}
          className="block rounded-md border"
          style={{
            width: effectiveWidth ? `${effectiveWidth}px` : 'auto',
            maxWidth: '100%',
            height: 'auto',
          }}
        />
        {editable && (
          <span
            onPointerDown={startResize}
            title="드래그해서 크기 조절"
            className="absolute -bottom-1 -right-1 h-4 w-4 cursor-nwse-resize rounded-sm border-2 border-background bg-primary shadow"
          />
        )}
      </span>
    </NodeViewWrapper>
  )
}

export const AuthedImageNode = Node.create({
  name: 'authedImage',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      fileId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-file-id'),
        renderHTML: (attrs) =>
          attrs.fileId ? { 'data-file-id': attrs.fileId } : {},
      },
      width: {
        default: null,
        parseHTML: (el) => {
          const raw = el.getAttribute('data-width') || el.style?.width || ''
          const n = parseInt(raw, 10)
          return Number.isFinite(n) ? n : null
        },
        renderHTML: (attrs) =>
          attrs.width
            ? { 'data-width': attrs.width, style: `width:${attrs.width}px` }
            : {},
      },
      filename: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-filename'),
        renderHTML: (attrs) =>
          attrs.filename ? { 'data-filename': attrs.filename } : {},
      },
    }
  },

  parseHTML() {
    return [{ tag: 'img[data-file-id]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['img', mergeAttributes(HTMLAttributes)]
  },

  addNodeView() {
    return ReactNodeViewRenderer(AuthedImageView)
  },
})
