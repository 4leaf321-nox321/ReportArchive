import { useEffect, useRef, useState } from 'react'
import { Image as ImageIcon, Loader2, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { Textarea } from '@/shared/components/ui/textarea'
import { AuthedImage } from '@/shared/components/AuthedImage'
import { uploadFile } from '@/shared/api/files'
import { createVocPost } from '@/shared/api/voc'
import { VOC_CATEGORIES } from './constants'

/** New VOC post dialog — captures title / category / body + image
 *  attachments (screenshots etc.). The free-text "관련 페이지" field
 *  was removed because users were rarely filling it; pasting a
 *  screenshot is faster and conveys far more context. */
export function VocNewDialog({ open, onOpenChange, onCreated }) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [category, setCategory] = useState('question')
  const [attachments, setAttachments] = useState([])
  const [submitting, setSubmitting] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [err, setErr] = useState('')
  const fileInputRef = useRef(null)

  useEffect(() => {
    if (open) {
      setTitle('')
      setBody('')
      setCategory('question')
      setAttachments([])
      setErr('')
    }
  }, [open])

  async function handleFiles(fileList) {
    const incoming = Array.from(fileList || []).filter((f) => {
      if (!f.type.startsWith('image/')) {
        toast.error(`이미지 파일만 가능: ${f.name}`)
        return false
      }
      return true
    })
    if (incoming.length === 0) return
    setUploading(true)
    setProgress(0)
    const uploaded = []
    try {
      for (let i = 0; i < incoming.length; i += 1) {
        const file = incoming[i]
        const meta = await uploadFile(file, {
          onProgress: (p) => setProgress((i + p) / incoming.length),
        })
        uploaded.push({
          file_id: meta.id,
          filename: file.name,
          size: file.size,
          mime_type: file.type,
        })
      }
      setAttachments((prev) => [...prev, ...uploaded])
    } catch (e) {
      toast.error(e.message || '업로드 실패')
    } finally {
      setUploading(false)
      setProgress(0)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  function onDrop(e) {
    e.preventDefault()
    handleFiles(e.dataTransfer.files)
  }

  function onPaste(e) {
    // Pull image blobs out of the clipboard — covers Win+Shift+S /
    // macOS screenshot tool / "copy image" from a browser. Falls
    // through when only text is on the clipboard so the textarea
    // still handles a normal paste.
    const items = Array.from(e.clipboardData?.items ?? [])
    const imageFiles = items
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter(Boolean)
    if (imageFiles.length === 0) return
    e.preventDefault()
    handleFiles(imageFiles)
  }

  function removeAttachment(idx) {
    setAttachments((prev) => prev.filter((_, i) => i !== idx))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!title.trim()) {
      setErr('제목을 입력해주세요.')
      return
    }
    setSubmitting(true)
    setErr('')
    try {
      const created = await createVocPost({
        title: title.trim(),
        body,
        category,
        attachments,
      })
      toast.success('VOC가 등록되었습니다.')
      onCreated?.(created)
    } catch (e2) {
      setErr(e2?.message || '등록 실패')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-2xl max-h-[90vh] flex flex-col"
        onPaste={onPaste}
      >
        <DialogHeader>
          <DialogTitle>VOC 새 글</DialogTitle>
          <DialogDescription>
            도구에 대한 버그·기능 요청·질문·개선 아이디어를 남겨주세요.
            스크린샷은 직접 첨부하거나 Ctrl+V 로 붙여넣을 수 있습니다.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={handleSubmit}
          className="space-y-3 overflow-y-auto pr-1"
        >
          <div className="space-y-1.5">
            <Label htmlFor="voc-title">제목</Label>
            <Input
              id="voc-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="한 줄 요약"
              autoFocus
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="voc-category">분류</Label>
            <select
              id="voc-category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              {VOC_CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="voc-body">내용</Label>
            <Textarea
              id="voc-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="재현 절차, 기대 동작, 화면 등 자세히 적어주세요."
              className="min-h-[160px]"
            />
          </div>
          <div className="space-y-1.5">
            <Label>스크린샷·이미지</Label>
            <AttachmentGrid attachments={attachments} onRemove={removeAttachment} />
            <div
              tabIndex={0}
              onDragOver={(e) => e.preventDefault()}
              onDrop={onDrop}
              className="border-2 border-dashed rounded-md p-4 text-center hover:bg-muted/20 focus:bg-muted/30 focus:outline-none focus:ring-2 focus:ring-primary/40 transition-colors"
            >
              {uploading ? (
                <div className="flex items-center justify-center gap-2 text-muted-foreground text-xs">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  업로드 중… {Math.round(progress * 100)}%
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2 text-muted-foreground">
                  <ImageIcon className="h-5 w-5" />
                  <div className="text-xs">
                    이미지 드래그·앤·드롭, 또는 클릭해서 포커스 후{' '}
                    <kbd className="px-1 rounded bg-muted">Ctrl</kbd>+
                    <kbd className="px-1 rounded bg-muted">V</kbd>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={(e) => {
                      e.stopPropagation()
                      fileInputRef.current?.click()
                    }}
                  >
                    <Upload className="mr-1 h-3 w-3" />
                    파일 선택
                  </Button>
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => handleFiles(e.target.files)}
              />
            </div>
          </div>
          {err && (
            <p className="text-xs text-destructive whitespace-pre-wrap">{err}</p>
          )}
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            취소
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={submitting || uploading}>
            {submitting ? '등록 중…' : '등록'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AttachmentGrid({ attachments, onRemove }) {
  if (attachments.length === 0) return null
  return (
    <div className="grid grid-cols-3 gap-2 mb-1">
      {attachments.map((a, i) => (
        <div
          key={`${a.file_id}-${i}`}
          className="relative aspect-video bg-muted/40 rounded-md border overflow-hidden group"
          title={a.filename}
        >
          <AuthedImage
            fileId={a.file_id}
            alt={a.filename}
            className="absolute inset-0 w-full h-full object-cover"
          />
          <button
            type="button"
            onClick={() => onRemove(i)}
            className="absolute top-1 right-1 h-5 w-5 rounded-full bg-background/90 text-destructive border flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
            title="제거"
          >
            <X className="h-3 w-3" />
          </button>
          <div className="absolute bottom-0 left-0 right-0 bg-background/80 px-1 py-0.5 text-[9px] truncate">
            {a.filename}
          </div>
        </div>
      ))}
    </div>
  )
}
