// 관련 보고서 추천 — 이 보고서와 벡터 유사도가 높은 다른 보고서(가시성 내).
// 백엔드 GET /api/reports/{id}/related 가 semantic_search 재사용(권한 게이팅).
// 뷰 보조 기능이라 print/export 에선 숨긴다(추천은 동적, 인쇄 부적합).
// 헤더 클릭으로 임시 접기/펴기(저장 안 함 — 새로고침하면 다시 펼침).
import { useState } from 'react'
import { Link as RouterLink } from 'react-router-dom'
import { ChevronDown, Sparkles } from 'lucide-react'

import { useAsync } from '@/shared/hooks/useAsync'

import { getRelatedReports } from './api'

export function RelatedReportsSection({ reportId }) {
  const [open, setOpen] = useState(true)
  const { data } = useAsync(
    () => (reportId ? getRelatedReports(reportId, { limit: 5 }) : Promise.resolve(null)),
    [reportId],
  )
  const items = data?.items || []
  if (items.length === 0) return null
  return (
    <section className="rounded-md border bg-muted/20 px-4 py-3 print:hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-xs font-semibold text-muted-foreground"
      >
        <Sparkles className="h-3.5 w-3.5" />
        관련 보고서
        <span className="text-[10px] font-normal">{items.length}건</span>
        <ChevronDown
          className={`ml-auto h-3.5 w-3.5 transition-transform ${open ? '' : '-rotate-90'}`}
        />
      </button>
      {open && (
        <ul className="mt-2 space-y-1.5">
          {items.map((r) => (
            <li key={r.report_id} className="flex flex-col">
              <RouterLink
                to={`/w/${r.workspace_slug}/reports/${r.report_id}`}
                className="flex items-baseline gap-2 text-sm hover:underline"
              >
                <span className="truncate">{r.title || `보고서 ${r.report_id}`}</span>
                <span className="ml-auto shrink-0 text-[10px] text-muted-foreground tabular-nums">
                  {Math.round((r.score || 0) * 100)}%
                </span>
              </RouterLink>
              {r.snippet && (
                <p className="line-clamp-1 text-[11px] text-muted-foreground">{r.snippet}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
