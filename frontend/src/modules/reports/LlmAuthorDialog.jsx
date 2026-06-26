import { useState } from 'react'
import { Sparkles, AlertTriangle } from 'lucide-react'
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
import { llmAuthorReport } from '@/modules/reports/api'

/**
 * "Local LLM으로 작성" 모달 (report_authoring) — 작성할 내용을 적으면 연결된
 * local LLM(B300)이 템플릿에 맞춰 보고서 내용을 생성한다. MCP 외부 AI 작성의
 * 사내판. 본인 작성 중(drafting) 보고서에만 적용되며, 성공 시 onDone 으로
 * 상세 화면을 새로고침한다.
 *
 * `editing`: 현재 편집 모드(본인 락 보유)면 true. AI 작성은 서버 저장본 기준으로
 * 적용 후 새로고침하므로, 저장하지 않은 편집분은 사라질 수 있다 — 그 사실을 고지한다.
 */
export function LlmAuthorDialog({ reportId, editing = false, onClose, onDone }) {
  const [instructions, setInstructions] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleSubmit() {
    const text = instructions.trim()
    if (text.length < 2 || busy) return
    setBusy(true)
    try {
      const res = await llmAuthorReport(reportId, { instructions: text })
      const warnings = res?.warnings ?? []
      toast.success(
        warnings.length
          ? `AI가 작성했습니다 (주의 ${warnings.length}건은 건너뜀).`
          : 'AI가 보고서 내용을 작성했습니다.',
      )
      onDone?.()
      onClose?.()
    } catch (e) {
      toast.error(
        e?.response?.data?.message ||
          e?.message ||
          'AI 작성에 실패했습니다.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose?.()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-violet-500" /> Local LLM으로 작성
          </DialogTitle>
          <DialogDescription>
            작성할 내용을 적어주세요. 연결된 사내 LLM이 이 보고서 템플릿에 맞춰
            내용을 채웁니다. (본인 작성 중 보고서에 적용 — 기존 내용은 준 블록만
            덮어씁니다.)
          </DialogDescription>
        </DialogHeader>

        {editing && (
          <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              지금 <b>편집 중</b>입니다. AI 작성은 <b>저장된 내용</b> 기준으로
              적용되고 편집 모드를 빠져나가므로,{' '}
              <b>저장하지 않은 변경사항은 사라질 수 있습니다.</b> 먼저 저장한 뒤
              실행하는 것을 권장합니다.
            </span>
          </div>
        )}

        <Textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={6}
          autoFocus
          placeholder={
            '예) 갤럭시S 울트라 낙하 시험 주간 보고. 이번 주 진행 현황, ' +
            '주요 이슈(디스플레이 파손율 3%), 다음 주 계획을 요약해서 작성해줘.'
          }
          className="text-sm"
        />

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            취소
          </Button>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={busy || instructions.trim().length < 2}
          >
            {busy ? '작성 중…' : '작성'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
