import { useEffect, useState } from 'react'
import { Sparkles, RotateCw } from 'lucide-react'
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
import { getReportAiSummary, bulkAiSummary } from '@/modules/reports/api'
import { useAuth } from '@/shared/auth/AuthContext'

/**
 * 헤더 메타줄의 "i"(작성·수정 정보) 옆 작은 "AI 요약" 버튼 (B). 클릭하면 모달로
 * 요약을 보여준다 — 본문 위 띠 배너 대신(화면을 어지럽히지 않게). 요약이 없으면
 * 버튼 자체를 렌더 안 함. 태그·분류는 추천(미적용) 칩으로만.
 */
export function ReportAiSummaryButton({ reportId }) {
  const { me } = useAuth()
  const canRegenerate = !!me?.ai_features?.includes('auto_summary')
  const [data, setData] = useState(null) // null=없음/미로딩
  const [open, setOpen] = useState(false)
  const [regenerating, setRegenerating] = useState(false)

  async function handleRegenerate() {
    setRegenerating(true)
    try {
      await bulkAiSummary([reportId])
      toast.success('요약을 다시 생성 요청했습니다 — 잠시 후 갱신됩니다.')
      setOpen(false)
    } catch (e) {
      toast.error(e?.response?.data?.message || e?.message || '요청 실패')
    } finally {
      setRegenerating(false)
    }
  }

  useEffect(() => {
    if (reportId == null) return undefined
    let cancelled = false
    getReportAiSummary(reportId)
      .then((d) => !cancelled && setData(d))
      .catch(() => {}) // 권한·미적재는 조용히 무시
    return () => {
      cancelled = true
    }
  }, [reportId])

  if (!data || !data.summary) return null

  const hasMeta = data.tags?.length > 0 || data.suggested_category

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="AI 자동 요약 보기"
        className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-medium text-violet-600 hover:bg-violet-500/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring dark:text-violet-400"
      >
        <Sparkles className="h-3 w-3" />
        AI 요약
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-violet-500" /> AI 요약
            </DialogTitle>
            <DialogDescription>
              B300이 본문에서 자동 생성한 요약입니다. 아래 태그·분류는 추천이며,
              적용하기 전까지 분류·검색에 반영되지 않습니다.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
              {data.summary}
            </p>
            {hasMeta && (
              <div className="flex flex-wrap items-center gap-1 border-t pt-3">
                {data.suggested_category && (
                  <span className="rounded-full border border-dashed px-2 py-0.5 text-[11px] text-muted-foreground">
                    분류 추천: {data.suggested_category}
                  </span>
                )}
                {(data.tags ?? []).map((t) => (
                  <span
                    key={t}
                    className="rounded-full border border-dashed px-2 py-0.5 text-[11px] text-muted-foreground"
                  >
                    {t}
                  </span>
                ))}
                <span className="text-[10px] text-muted-foreground/70">
                  · 추천(미적용)
                </span>
              </div>
            )}
          </div>
          {canRegenerate && (
            <DialogFooter>
              <Button
                variant="outline"
                size="sm"
                onClick={handleRegenerate}
                disabled={regenerating}
              >
                <RotateCw className="mr-1 h-3.5 w-3.5" />
                {regenerating ? '요청 중…' : '다시 생성'}
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
