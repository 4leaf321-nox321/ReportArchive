// 본문 @멘션의 "부서" 칩을 클릭했을 때, 부서 보고서 목록으로 곧장 이동하는
// 대신 링크 옆에 띄우는 미리보기 카드. 부서 기본정보 + 최근 보고서 몇 건을
// 보여주고, 실제 이동은 카드 안에서 사용자가 고를 때만(보고서 행 또는
// "부서 보고서 열기" 버튼) 일어난다 → 맥락을 잃지 않는다.
//
// 다른 부서의 보고서는 listReports({ workspaceSlug }) 로 일시 조회한다(전역
// 워크스페이스 컨텍스트를 호출 단위 헤더로 덮어씀 — api/client 참고).
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, ArrowRight, Building2, FileText } from 'lucide-react'
import { listReports } from './api'

const MARGIN = 12
const PREVIEW_WIDTH = 360
const clamp = (n, min, max) => Math.max(min, Math.min(max, n))

function computeBox(rect) {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
  const vh = typeof window !== 'undefined' ? window.innerHeight : 768
  const width = Math.min(PREVIEW_WIDTH, vw - 2 * MARGIN)
  const below = rect ? vh - rect.bottom - MARGIN : vh - 2 * MARGIN
  const above = rect ? rect.top - MARGIN : vh - 2 * MARGIN
  const useAbove = below < 260 && above > below
  const avail = Math.max(useAbove ? above : below, 200)
  const height = clamp(Math.min(420, avail), 200, vh - 2 * MARGIN)
  const left = clamp(
    rect ? rect.left : (vw - width) / 2,
    MARGIN,
    Math.max(MARGIN, vw - width - MARGIN),
  )
  const top = useAbove
    ? clamp((rect?.top ?? vh) - 6 - height, MARGIN, vh - height - MARGIN)
    : clamp((rect?.bottom ?? 0) + 6, MARGIN, vh - height - MARGIN)
  return { left, top, width, height }
}

function fmtDate(s) {
  if (!s) return ''
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('ko-KR', {
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
  })
}

export default function DeptMentionPreview({
  slug,
  dept, // useWorkspace().all 에서 찾은 워크스페이스 객체 | null
  anchorRect,
  onOpenDept, // () => 부서 보고서 목록으로 이동
  onOpenReport, // (reportId) => 그 보고서로 이동
  onClose,
}) {
  const [box, setBox] = useState(() => computeBox(anchorRect))
  useEffect(() => setBox(computeBox(anchorRect)), [anchorRect])

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // null = 로딩, [] = 없음/에러, [...] = 최근 보고서. 멘션된 부서의 보고서를
  // updated_at 내림차순 상위 5건만.
  const [reports, setReports] = useState(null)
  useEffect(() => {
    let alive = true
    setReports(null)
    listReports({ workspaceSlug: slug })
      .then((rows) => {
        if (!alive) return
        const recent = (rows ?? [])
          .slice()
          .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
          .slice(0, 5)
        setReports(recent)
      })
      .catch(() => {
        if (alive) setReports([])
      })
    return () => {
      alive = false
    }
  }, [slug])

  const name = dept?.name || slug

  return createPortal(
    <>
      <div className="fixed inset-0 z-[60]" onMouseDown={onClose} />
      <div
        className="fixed z-[61] flex flex-col rounded-lg border bg-popover shadow-xl"
        style={{ left: box.left, top: box.top, width: box.width, maxHeight: box.height }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b shrink-0">
          <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-xs font-semibold text-foreground">{name}</span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted"
            title="닫기"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {dept?.description && (
          <div className="px-3 py-2 text-xs text-muted-foreground border-b shrink-0 line-clamp-2">
            {dept.description}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto p-1">
          <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            최근 보고서
          </div>
          {reports === null ? (
            <div className="px-2 py-6 text-center text-xs text-muted-foreground">
              불러오는 중…
            </div>
          ) : reports.length === 0 ? (
            <div className="px-2 py-6 text-center text-xs text-muted-foreground">
              표시할 보고서가 없습니다.
            </div>
          ) : (
            reports.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => onOpenReport(r.id)}
                className="flex w-full items-baseline gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted"
              >
                <FileText className="h-3.5 w-3.5 shrink-0 translate-y-0.5 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                  {r.title || '(제목 없음)'}
                </span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {fmtDate(r.updated_at)}
                </span>
              </button>
            ))
          )}
        </div>

        <div className="flex items-center px-3 py-2 border-t shrink-0">
          <button
            type="button"
            onClick={onOpenDept}
            className="ml-auto inline-flex items-center gap-1 rounded-md border bg-background px-2.5 py-1 text-xs font-medium hover:bg-muted"
            title="이 부서의 보고서 목록 열기"
          >
            부서 보고서 열기 <ArrowRight className="h-3 w-3" />
          </button>
        </div>
      </div>
    </>,
    document.body,
  )
}
