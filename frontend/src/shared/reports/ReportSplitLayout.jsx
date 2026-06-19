import { X, Pencil } from 'lucide-react'
import { cn } from '@/shared/lib/utils'
import { InlineReportView } from '@/modules/composites/InlineReportView'
import { useReportTabs } from './ReportTabsContext'
import { ReportTabBar } from './ReportTabBar'

// 보고서 화면의 분할 레이아웃. AppShell 의 <Outlet/>(=라우트 페이지)을 감싼다.
//
//  - 비-보고서 라우트: children 을 그대로(스크롤은 main). 좌측 탭바는 AppShell
//    의 shell 배치가 담당.
//  - 보고서 라우트: 좌(편집 가능, 라우트 에디터)·우(읽기전용 InlineReportView)
//    2-pane. 각 패널이 자기 탭바를 갖는다. 좌측 컬럼은 분할 on/off 와 무관하게
//    항상 존재하므로, 우측을 켜고 꺼도 좌측 에디터가 remount 되지 않는다(편집
//    상태·락 보존).
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
        <div className="flex-1 min-h-0">{children}</div>
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
            <SplitToolbarHeader tab={rightTab} onClose={() => closeRight(rightTab.key)} />
            <div className="flex-1 min-h-0 overflow-auto px-6 py-4">
              <InlineReportView reportId={rightTab.reportId} exposeBlockIds={false} />
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// 우측 패널 상단 바 — 원래 보고서 화면의 툴바와 같은 구성(제목 + 우측 버튼
// 그룹)을 흉내낸다. 다만 분할 우측은 읽기전용이라 '편집'은 비활성(편집은 좌측
// 에서). 보고서 본문 폭/메타는 InlineReportView 가 그린다.
function SplitToolbarHeader({ tab, onClose }) {
  return (
    <div className="flex items-center gap-3 border-b bg-background px-6 py-3 shrink-0">
      <div className="flex-1 min-w-0">
        <div className="text-lg font-semibold truncate">
          {tab.title || <span className="text-muted-foreground">(제목 없음)</span>}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">보기 전용 (분할)</div>
      </div>
      {/* 원래 화면의 버튼 구조를 맞추되, 우측 패널은 읽기전용이라 편집은 비활성. */}
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
  )
}
