import { Sparkles } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/shared/components/ui/popover'

/**
 * 보고서 목록 "상태" 칸의 AI 요약 칩 — 요약이 있는 행에만 ✨ 를 띄우고, 클릭하면
 * 팝오버로 요약문을 보여준다. 요약문은 목록 API(ReportSummary.ai_summary)가 이미
 * 실어주므로 추가 요청 없이 즉시 표시한다. 행 클릭(상세 이동)과 겹치지 않도록
 * 트리거에서 이벤트 전파를 멈춘다.
 */
export function AiSummaryListChip({ summary }) {
  if (!summary) return null
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          title="AI 요약 보기"
          aria-label="AI 요약 보기"
          className="inline-flex h-5 w-5 items-center justify-center rounded text-violet-500 hover:bg-violet-500/10"
        >
          <Sparkles className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 text-sm"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-violet-600 dark:text-violet-400">
          <Sparkles className="h-3.5 w-3.5" /> AI 요약
        </div>
        <p className="whitespace-pre-wrap break-words text-muted-foreground">
          {summary}
        </p>
      </PopoverContent>
    </Popover>
  )
}

export default AiSummaryListChip
