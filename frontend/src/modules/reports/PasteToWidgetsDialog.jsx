import { useEffect, useMemo, useState } from 'react'
import { ClipboardType } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import { Button } from '@/shared/components/ui/button'
import { Textarea } from '@/shared/components/ui/textarea'
import { cn } from '@/shared/lib/utils'
import { parseTextToWidgets } from './pasteToWidgets'

// 붙여넣기 → 여러 위젯 분해(④) 대화상자. 텍스트를 붙여넣으면 제목/문단/목록/표를
// 감지해 미리보기로 보여주고, 확인 시 onConfirm(segments) 로 위젯들을 만든다.
// 일반 붙여넣기 동작은 건드리지 않는다(전용 진입).
const KIND_BADGE = {
  제목: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  문단: 'bg-muted text-muted-foreground',
  목록: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  표: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
}

export function PasteToWidgetsDialog({ open, onOpenChange, onConfirm }) {
  const [text, setText] = useState('')
  useEffect(() => {
    if (open) setText('')
  }, [open])

  const segments = useMemo(
    () => (text.trim() ? parseTextToWidgets(text) : []),
    [text],
  )

  function handleConfirm() {
    if (segments.length === 0) return
    onConfirm(segments)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardType className="h-4 w-4" />
            텍스트로 위젯 만들기
          </DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          워드·마크다운 등에서 복사한 글을 붙여넣으면 <b>제목·문단·목록·표</b>를 감지해
          여러 위젯으로 한 번에 만듭니다. (제목은 <code>#</code>, 표는 <code>|</code> 또는
          엑셀 복사(탭)로 인식)
        </p>
        <div className="flex-1 min-h-0 grid grid-cols-2 gap-3 overflow-hidden">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus
            placeholder={'# 개요\n첫 문단 내용…\n\n- 항목 1\n- 항목 2\n\n| 구분 | 값 |\n| --- | --- |\n| A | 1 |'}
            className="min-h-[300px] font-mono text-[11px] leading-relaxed resize-none"
          />
          <div className="min-h-0 overflow-y-auto rounded-md border bg-muted/30 p-2 text-xs">
            {segments.length === 0 ? (
              <div className="flex h-full items-center justify-center px-2 text-center text-muted-foreground">
                붙여넣으면 여기에 감지된 위젯이 미리보기로 표시됩니다.
              </div>
            ) : (
              <ol className="space-y-1.5">
                {segments.map((s, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span
                      className={cn(
                        'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
                        KIND_BADGE[s.kind] ?? 'bg-muted text-muted-foreground',
                      )}
                    >
                      {s.kind}
                    </span>
                    <span className="min-w-0 truncate text-muted-foreground">
                      {s.preview || '(빈 내용)'}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            취소
          </Button>
          <Button onClick={handleConfirm} disabled={segments.length === 0}>
            {segments.length > 0 ? `위젯 ${segments.length}개 만들기` : '위젯 만들기'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
