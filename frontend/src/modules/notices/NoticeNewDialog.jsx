import { useEffect, useState } from 'react'
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
import { createNotice } from '@/shared/api/notices'
import { AuthedRichText } from '@/shared/rich-text/AuthedRichText'

/** 새 공지 작성 다이얼로그 — 제목 / 리치 텍스트 본문(문단 사이 이미지·크기
 *  조절) / 상단 고정. 시스템 관리자만 이 다이얼로그에 도달한다(목록 페이지에서
 *  버튼 노출을 admin 으로 게이트). */
export function NoticeNewDialog({ open, onOpenChange, onCreated }) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [pinned, setPinned] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (open) {
      setTitle('')
      setBody('')
      setPinned(false)
      setErr('')
    }
  }, [open])

  async function handleSubmit(e) {
    e.preventDefault()
    if (!title.trim()) {
      setErr('제목을 입력해주세요.')
      return
    }
    setSubmitting(true)
    setErr('')
    try {
      const created = await createNotice({ title: title.trim(), body, pinned })
      toast.success('공지가 등록되었습니다.')
      onCreated?.(created)
    } catch (e2) {
      setErr(e2?.message || '등록 실패')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>새 공지</DialogTitle>
          <DialogDescription>
            전체 사용자에게 보이는 공지사항입니다. 본문 문단 사이에 이미지를 넣고
            드래그로 크기를 조절할 수 있습니다.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3 overflow-y-auto pr-1">
          <div className="space-y-1.5">
            <Label htmlFor="notice-title">제목</Label>
            <Input
              id="notice-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="한 줄 요약"
              autoFocus
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label>내용</Label>
            <AuthedRichText value={body} onChange={setBody} />
          </div>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={pinned}
              onChange={(e) => setPinned(e.target.checked)}
            />
            상단 고정 (중요 공지를 목록 맨 위로)
          </label>
          {err && (
            <p className="text-xs text-destructive whitespace-pre-wrap">{err}</p>
          )}
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            취소
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={submitting}>
            {submitting ? '등록 중…' : '등록'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
