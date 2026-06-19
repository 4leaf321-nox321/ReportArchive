import { X, Pencil } from 'lucide-react'
import { cn } from '@/shared/lib/utils'
import { useAsync } from '@/shared/hooks/useAsync'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { getReport } from '@/modules/reports/api'
import { InlineReportView } from '@/modules/composites/InlineReportView'
import {
  PhaseChip,
  ReportDateField,
  ReportEntitiesPanel,
} from '@/modules/reports/ReportDetailPage'
import { useReportTabs } from './ReportTabsContext'
import { ReportTabBar } from './ReportTabBar'

// 보고서 화면의 분할 레이아웃. AppShell 의 <Outlet/>(=라우트 페이지)을 감싼다.
//
//  - 비-보고서 라우트: children 을 그대로(스크롤은 main). 좌측 탭바는 AppShell
//    의 shell 배치가 담당.
//  - 보고서 라우트: 좌(편집 가능, 라우트 에디터)·우(읽기전용 InlineReportView)
//    2-pane. 각 패널이 자기 탭바를 갖는다. 좌측 컬럼은 분할 on/off 와 무관하게
//    항상 존재하므로, 우측을 켜고 꺼도 좌측 에디터가 remount 되지 않는다.
//
// ⚠ 우측은 항상 읽기전용(편집은 좌측 1개씩). InlineReportView 에 exposeBlockIds
// =false 를 줘서 `id="block-…"` 충돌(좌측 에디터의 getElementById)을 막는다.
export function ReportSplitLayout({ children }) {
  const { onReportRoute, splitOpen, rightTab, closeRight } = useReportTabs()

  if (!onReportRoute) return children

  return (
    <div className="flex h-full min-h-0">
      {/* 좌측(primary) — 라우트 에디터. 항상 존재. */}
      <div className="flex flex-1 min-w-0 min-h-0 flex-col">
        <ReportTabBar pane="left" placement="pane" />
        {/* min-w-0 + overflow-hidden 필수: 안 주면 보고서의 min-content 폭
            (예: 1024px 페이지)이 좁은 분할 패널을 넘어 늘어나, 보고서 컬럼과
            그에 절대배치된 편집 플로팅 버튼(absolute right-6)이 우측 패널을
            침범한다. 패널 경계에서 클립해 bleed 를 막는다. */}
        <div className="flex-1 min-w-0 min-h-0 overflow-hidden">{children}</div>
      </div>

      {/* 우측(secondary) — 읽기전용 분할 패널. */}
      {splitOpen && rightTab && (
        <>
          <div className="w-px shrink-0 bg-border" aria-hidden="true" />
          <div
            className="flex flex-1 min-w-0 min-h-0 flex-col bg-muted/20"
            data-app-chrome="report-split"
          >
            <ReportTabBar pane="right" placement="pane" />
            <SplitCompanionPane
              tab={rightTab}
              onClose={() => closeRight(rightTab.key)}
            />
          </div>
        </>
      )}
    </div>
  )
}

// 우측 패널 본체 — 보고서를 1회 fetch 해서 (1) 좌측과 같은 높이의 툴바 헤더,
// (2) "관련 정보" 줄(ReportEntitiesPanel), (3) 본문(InlineReportView)을 그린다.
// 같은 fetch 결과를 InlineReportView 에 snapshot 으로 넘겨 중복 요청을 피한다.
function SplitCompanionPane({ tab, onClose }) {
  const { data: report, loading, error } = useAsync(
    () => (tab.reportId ? getReport(tab.reportId) : Promise.resolve(null)),
    [tab.reportId],
  )

  return (
    <>
      {/* 툴바 헤더 — 좌측(ReportDetailPage)의 report-detail-toolbar 와 동일한
          구성(px-6 py-3, 제목 text-lg + 메타 줄 PhaseChip·보고기준일)으로 높이를
          맞춘다. 우측은 읽기전용이라 '편집'은 비활성. */}
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2 border-b bg-background px-6 py-3 shrink-0">
        {/* 좌측(분할 시) 툴바와 동일하게 제목을 한 줄 전체로 깔고(basis-full)
            버튼은 아래 행으로 — 좌/우 툴바 높이를 맞춘다. */}
        <div className="basis-full min-w-0">
          <div className="text-lg font-semibold truncate">
            {report?.title || tab.title || (
              <span className="text-muted-foreground">(제목 없음)</span>
            )}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
            <PhaseChip phase={report?.phase ?? 'drafting'} />
            <ReportDateField
              editing={false}
              value={report?.report_date ?? ''}
              onChange={() => {}}
            />
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              보기 전용
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 ml-auto shrink-0">
          <button
            type="button"
            disabled
            title="분할 보기는 읽기 전용입니다 — 편집은 왼쪽 화면에서"
            className={cn(
              'inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs',
              'cursor-not-allowed text-muted-foreground opacity-60',
            )}
          >
            <Pencil className="h-3.5 w-3.5" />
            편집
          </button>
          <button
            type="button"
            aria-label="분할 닫기"
            title="분할 닫기"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* "관련 정보" 줄 — 좌측과 동일. 태깅된 엔티티가 없으면 렌더 안 됨. */}
      <ReportEntitiesPanel
        entities={report?.entities ?? []}
        collabSlugs={report?.collab_workspace_slugs ?? []}
      />

      {/* 본문 — 읽기전용 렌더. snapshot 으로 위 fetch 결과 재사용(중복 요청 방지). */}
      <div className="flex-1 min-h-0 overflow-auto px-6 py-4">
        {loading ? (
          <Skeleton className="h-40" />
        ) : error ? (
          <div className="text-xs text-destructive">{error.message}</div>
        ) : report ? (
          <InlineReportView snapshot={report} exposeBlockIds={false} />
        ) : null}
      </div>
    </>
  )
}
