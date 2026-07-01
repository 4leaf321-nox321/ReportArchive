import { useRef, useState } from 'react'
import { Tags, AlertTriangle } from 'lucide-react'
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
import { Textarea } from '@/shared/components/ui/textarea'
import { cn } from '@/shared/lib/utils'
import { llmAssignSections } from '@/modules/reports/api'

/**
 * "Local LLM으로 단락구분 지정" 모달 (report_authoring 권한 재사용) — 연결된 사내
 * LLM 이 현재 문서의 각 위젯 내용을 보고 알맞은 단락 구분(section)을 자동 지정한다.
 * 본인 작성 중(drafting) 보고서에만 적용되며, 성공 시 onDone 으로 상세를 새로고침.
 *
 * `mode`: 'empty'(빈 위젯만 채우기, 기본) | 'all'(전부 다시 지정 — 기존 수동 지정도 교체).
 * `editing`: 편집 모드면 저장 안 한 변경분이 사라질 수 있어 경고 배너를 띄운다.
 */
export function LlmSectionsDialog({ reportId, editing = false, onClose, onDone }) {
  const [mode, setMode] = useState('empty') // 'empty' | 'all'
  const [instructions, setInstructions] = useState('')
  const [busy, setBusy] = useState(false)
  const abortRef = useRef(null)

  async function handleSubmit() {
    if (busy) return
    const controller = new AbortController()
    abortRef.current = controller
    setBusy(true)
    try {
      const res = await llmAssignSections(reportId, {
        overwrite: mode === 'all',
        instructions: instructions.trim(),
        signal: controller.signal,
      })
      const assigned = res?.assigned ?? 0
      if (assigned > 0) {
        toast.success(`단락 구분 ${assigned}개를 지정했습니다.`)
      } else {
        toast.info(res?.warnings?.[0] || '지정할 위젯이 없습니다.')
      }
      onDone?.()
      onClose?.()
    } catch (e) {
      if (e?.code === 'ERR_CANCELED' || e?.name === 'CanceledError') {
        toast.info('단락구분 지정을 중단했습니다.')
      } else {
        toast.error(
          e?.response?.data?.message || e?.message || '단락구분 지정에 실패했습니다.',
        )
      }
    } finally {
      abortRef.current = null
      setBusy(false)
    }
  }

  function handleCancel() {
    if (busy && abortRef.current) abortRef.current.abort()
    else onClose?.()
  }

  return (
    <Dialog open onOpenChange={(o) => !o && handleCancel()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Tags className="h-4 w-4 text-violet-500" /> Local LLM으로 단락구분 지정
          </DialogTitle>
          <DialogDescription>
            연결된 사내 LLM이 이 문서의 각 위젯 내용을 보고 알맞은 <b>단락 구분</b>을
            자동으로 지정합니다. (본인 작성 중 보고서에 적용)
          </DialogDescription>
        </DialogHeader>

        {editing && (
          <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              지금 <b>편집 중</b>입니다. <b>저장된 내용</b> 기준으로 적용되고 편집
              모드를 빠져나가므로, <b>저장하지 않은 변경사항은 사라질 수 있습니다.</b>{' '}
              먼저 저장한 뒤 실행하는 것을 권장합니다.
            </span>
          </div>
        )}

        <div className="space-y-1.5">
          {[
            { key: 'empty', label: '빈 위젯만 채우기', desc: '이미 지정된 단락 구분은 그대로 두고 빈 위젯만 지정합니다.' },
            { key: 'all', label: '전부 다시 지정', desc: '모든 위젯의 단락 구분을 다시 지정합니다(기존 수동 지정도 교체).' },
          ].map((opt) => (
            <button
              key={opt.key}
              type="button"
              onClick={() => setMode(opt.key)}
              className={cn(
                'flex w-full items-start gap-2 rounded-md border px-3 py-2 text-left text-sm',
                mode === opt.key
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:bg-muted',
              )}
            >
              <span
                className={cn(
                  'mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full border',
                  mode === opt.key ? 'border-primary bg-primary' : 'border-muted-foreground',
                )}
              />
              <span className="min-w-0">
                <span className="font-medium">{opt.label}</span>
                <span className="block text-[11px] text-muted-foreground">{opt.desc}</span>
              </span>
            </button>
          ))}
        </div>

        <Textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={2}
          placeholder="(선택) 참고 지시 — 예) 시험 결과 위주로 분류해줘"
          className="text-sm"
        />

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={handleCancel}>
            {busy ? '중단' : '취소'}
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={busy}>
            {busy ? '지정 중…' : '지정하기'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
