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
import {
  parseTextToWidgets,
  parseHtmlToWidgets,
} from './pasteToWidgets'

// 붙여넣기 → 여러 위젯 분해(④) 대화상자. 붙여넣기 이벤트에서 clipboardData 를 직접
// 읽어 (1) 서식 있는 text/html(워드·PPT 텍스트박스·웹) (2) 이미지 파일(워드/캡처)
// 을 함께 처리한다. 순수 텍스트는 textarea 로 직접 입력·붙여넣기도 가능.
const KIND_BADGE = {
  제목: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  문단: 'bg-muted text-muted-foreground',
  목록: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  표: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  이미지: 'bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400',
}

export function PasteToWidgetsDialog({ open, onOpenChange, onConfirm }) {
  const [text, setText] = useState('')
  // 서식/이미지 붙여넣기로 만들어진 세그먼트(있으면 text 대신 이걸 쓴다).
  const [rich, setRich] = useState([])
  useEffect(() => {
    if (open) {
      setText('')
      setRich([])
    }
  }, [open])

  // 미리보기·생성에 쓸 최종 세그먼트: 서식/이미지 붙여넣기가 있으면 그걸, 없으면
  // 직접 입력한 텍스트를 파싱한 것.
  const segments = useMemo(
    () => (rich.length ? rich : text.trim() ? parseTextToWidgets(text) : []),
    [rich, text],
  )

  function handlePaste(e) {
    const cd = e.clipboardData
    if (!cd) return
    // ⚠️ [임시 진단] 붙여넣기 클립보드 내용을 콘솔에 남긴다 — PPT 텍스트박스가
    // 어떤 형식(types)에 텍스트/이미지를 담는지 파악용. 확인 뒤 이 블록은 제거.
    try {
      const types = Array.from(cd.types || [])
      // eslint-disable-next-line no-console
      console.groupCollapsed('%c[paste 진단] types: ' + types.join(', '), 'color:#a21caf')
      for (const t of types) {
        const v = cd.getData(t) || ''
        // eslint-disable-next-line no-console
        console.log(t, '· len=', v.length, '·', JSON.stringify(v.slice(0, 400)))
      }
      // eslint-disable-next-line no-console
      console.log(
        'items:',
        Array.from(cd.items || []).map((it) => ({ kind: it.kind, type: it.type })),
      )
      // eslint-disable-next-line no-console
      console.log(
        'files:',
        Array.from(cd.files || []).map((f) => ({ name: f.name, type: f.type, size: f.size })),
      )
      // eslint-disable-next-line no-console
      console.groupEnd()
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[paste 진단] 실패', err)
    }
    const files = Array.from(cd.items || [])
      .filter((it) => it.kind === 'file' && (it.type || '').startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter(Boolean)
    const html = cd.getData('text/html') || ''
    const plain = cd.getData('text/plain') || ''
    // 이미지가 있거나 서식(html)이 있으면 rich 경로로 가로챈다. 순수 텍스트만
    // 있으면 기본 동작(텍스트가 textarea 로 들어가고 onChange 가 파싱)에 맡긴다.
    if (files.length || html.trim()) {
      e.preventDefault()
      // 텍스트 우선 원칙. PPT 텍스트박스(도형)를 복사하면 그 도형을 그린 PNG 가
      // 이미지(클립보드 파일 + html <img>)로 오고, 텍스트는 text/plain 이나
      // html 안에 별도로 담긴다. 그래서 (1) html 에서 실제 텍스트가 나오면 그걸,
      // (2) 아니면 text/plain 이 있으면 그걸(= html 이 도형 이미지뿐이어도 평문
      // 텍스트를 살린다), (3) 둘 다 없을 때만 이미지로 받아들인다.
      const htmlSegs = html.trim() ? parseHtmlToWidgets(html) : []
      const htmlHasText = htmlSegs.some((s) => s.type !== 'image')
      let segs
      if (htmlHasText) segs = htmlSegs
      else if (plain.trim()) segs = parseTextToWidgets(plain)
      else segs = htmlSegs

      // 텍스트/표 세그먼트가 하나도 없을 때만(순수 이미지 복사) 클립보드 이미지를
      // 이미지 위젯으로 추가한다. 텍스트가 있으면 도형 렌더 이미지는 버린다.
      const hasTextSeg = segs.some((s) => s.type !== 'image')
      if (!hasTextSeg) {
        for (const f of files) {
          segs.push({
            type: 'image',
            blob: f,
            alt: f.name || '',
            kind: '이미지',
            preview: f.name || '이미지',
          })
        }
      }
      setRich(segs)
      setText('')
    }
  }

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
          워드·PPT·웹에서 복사한 내용을 아래에 붙여넣으면 <b>제목·문단·목록·표·이미지</b>를
          감지해 여러 위젯으로 만듭니다. (PPT는 텍스트박스째 복사해도 됩니다. 워드 이미지는
          함께 붙습니다.)
        </p>
        <div className="flex-1 min-h-0 grid grid-cols-2 gap-3 overflow-hidden">
          <div className="flex min-h-0 flex-col gap-1">
            <Textarea
              value={rich.length ? '' : text}
              onChange={(e) => {
                setText(e.target.value)
                setRich([])
              }}
              onPaste={handlePaste}
              autoFocus
              placeholder={
                rich.length
                  ? '붙여넣은 서식/이미지를 사용 중입니다. 지우고 다시 하려면 「초기화」.'
                  : '여기에 붙여넣기 (Ctrl+V) 또는 직접 입력'
              }
              disabled={rich.length > 0}
              className="flex-1 min-h-[260px] font-mono text-[11px] leading-relaxed resize-none disabled:opacity-60"
            />
            {rich.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setRich([])
                  setText('')
                }}
                className="self-start text-[11px] text-muted-foreground underline hover:text-foreground"
              >
                초기화
              </button>
            )}
          </div>
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
