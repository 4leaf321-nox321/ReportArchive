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
  parseSvgToWidgets,
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
    const items = Array.from(cd.items || [])
    // 클립보드 항목을 동기적으로(이벤트 유효 시점) 붙잡는다 — 파일은 이벤트가 끝나도
    // 살아 있어 async 로 읽을 수 있다. PPT 텍스트박스는 image/svg+xml 로 오는데
    // SVG(=XML) 안에 실제 글자가 있어 그걸 추출한다.
    const svgFile =
      items.find((it) => it.kind === 'file' && it.type === 'image/svg+xml')?.getAsFile() ||
      null
    const rasterFiles = items
      .filter((it) => it.kind === 'file' && (it.type || '').startsWith('image/') && it.type !== 'image/svg+xml')
      .map((it) => it.getAsFile())
      .filter(Boolean)
    const html = cd.getData('text/html') || ''
    const plain = cd.getData('text/plain') || ''

    // ⚠️ [임시 진단] PPT 텍스트박스 SVG 안에 <text> 가 있는지(=글자를 뽑을 수
    // 있는지) 콘솔로 확인. 확인 뒤 제거.
    if (svgFile) {
      svgFile
        .text()
        .then((t) => {
          // eslint-disable-next-line no-console
          console.groupCollapsed(
            '%c[svg 진단] size=' + svgFile.size + ' <text>=' + (t.match(/<text[\s>]/g) || []).length + ' <tspan>=' + (t.match(/<tspan[\s>]/g) || []).length + ' <path>=' + (t.match(/<path[\s>]/g) || []).length,
            'color:#a21caf',
          )
          // eslint-disable-next-line no-console
          console.log(t.slice(0, 2000))
          // eslint-disable-next-line no-console
          console.groupEnd()
        })
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.warn('[svg 진단] 읽기 실패', err)
        })
    }

    // 순수 평문만(이미지·SVG·html 없음) 있으면 기본 동작(textarea 입력)에 맡긴다.
    if (!svgFile && !rasterFiles.length && !html.trim()) return
    e.preventDefault()

    // 텍스트 우선. (1) html 에서 텍스트, (2) text/plain, (3) SVG 안의 <text>(PPT
    // 텍스트박스), (4) 그래도 없으면 래스터/SVG 이미지로. async(SVG 파일 읽기).
    ;(async () => {
      const htmlSegs = html.trim() ? parseHtmlToWidgets(html) : []
      let segs = htmlSegs
      let hasTextSeg = htmlSegs.some((s) => s.type !== 'image')
      if (!hasTextSeg && plain.trim()) {
        segs = parseTextToWidgets(plain)
        hasTextSeg = segs.length > 0
      }
      if (!hasTextSeg && svgFile) {
        try {
          const svgSegs = parseSvgToWidgets(await svgFile.text())
          if (svgSegs.length) {
            segs = svgSegs
            hasTextSeg = true
          }
        } catch {
          /* SVG 파싱 실패 → 아래 이미지 폴백 */
        }
      }
      if (!hasTextSeg) {
        // 텍스트가 전혀 없음(순수 이미지 복사) → 이미지 위젯. 래스터가 있으면 그걸,
        // 없고 SVG 만 있으면 SVG 를 이미지로.
        segs = []
        for (const f of rasterFiles) {
          segs.push({ type: 'image', blob: f, alt: f.name || '', kind: '이미지', preview: f.name || '이미지' })
        }
        if (!rasterFiles.length && svgFile) {
          segs.push({ type: 'image', blob: svgFile, alt: '', kind: '이미지', preview: '이미지(SVG)' })
        }
      }
      setRich(segs)
      setText('')
    })()
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
