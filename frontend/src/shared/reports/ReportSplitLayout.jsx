import { X } from 'lucide-react'
import { cn } from '@/shared/lib/utils'
import { InlineReportView } from '@/modules/composites/InlineReportView'
import { useReportTabs } from './ReportTabsContext'

// 분할 보기 레이아웃. AppShell 의 <Outlet/>(=라우트 페이지)을 감싼다.
//
// ⚠ 핵심: 분할 on/off 토글이 에디터(ReportDetailPage)를 remount 시키면 안 된다
// (편집락·미저장 편집 소실). 그래서 감싸는 <div> 구조를 항상 동일하게 유지하고,
// 분할이 꺼져 있을 땐 `display:contents`(Tailwind `contents`)로 래퍼를
// 레이아웃에서 투명하게 만든다 — DOM 노드 동일, className 만 바뀌므로 React 가
// children 을 재마운트하지 않고 in-place 로 유지한다. 분할이 켜지면 같은
// 노드가 flex 컨테이너가 되고 우측에 읽기전용 companion 패널이 붙는다.
export function ReportSplitLayout({ children }) {
  const { splitTab, activeKey } = useReportTabs()
  // 분할은 "보고서 라우트(activeKey 있음)"에서만, 활성과 다른 저장된 보고서를
  // 우측에 띄울 때만 보인다. 비-보고서 화면에선 companion 을 숨긴다.
  const showSplit =
    Boolean(splitTab) &&
    Boolean(activeKey) &&
    Boolean(splitTab.reportId) &&
    splitTab.key !== activeKey

  return (
    <div className={cn(showSplit ? 'flex h-full min-h-0' : 'contents')}>
      <div className={cn(showSplit ? 'flex-1 min-w-0 overflow-auto' : 'contents')}>
        {children}
      </div>
      {showSplit && (
        <>
          <div className="w-px shrink-0 bg-border" aria-hidden="true" />
          <div
            className="flex-1 min-w-0 overflow-hidden"
            data-app-chrome="report-split"
          >
            <SplitCompanionPane tab={splitTab} />
          </div>
        </>
      )}
    </div>
  )
}

// 우측 읽기전용 패널 — 상단에 다른 열린 탭 선택 드롭다운 + 닫기, 본문은
// InlineReportView(읽기전용). exposeBlockIds=false 로 `id="block-…"` 를 떼
// 좌측 에디터의 document.getElementById('block-…') 조회와 충돌하지 않게 한다.
function SplitCompanionPane({ tab }) {
  const { tabs, activeKey, setSplit } = useReportTabs()
  // 우측 후보 = 활성 탭이 아니고 저장된(r:) 보고서인 탭들.
  const candidates = tabs.filter((t) => t.key !== activeKey && t.reportId)

  return (
    <div className="flex h-full flex-col bg-muted/20">
      <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 shrink-0">
        <span className="text-[11px] text-muted-foreground shrink-0">분할</span>
        <select
          value={tab.key}
          onChange={(e) => setSplit(e.target.value)}
          className="h-7 min-w-0 flex-1 rounded border border-input bg-background px-1 text-xs"
          title="우측에 표시할 보고서"
        >
          {candidates.map((t) => (
            <option key={t.key} value={t.key}>
              {t.title || '제목 없음'}
            </option>
          ))}
        </select>
        <button
          type="button"
          aria-label="분할 닫기"
          title="분할 닫기"
          onClick={() => setSplit(null)}
          className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground shrink-0"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-4">
        <InlineReportView reportId={tab.reportId} exposeBlockIds={false} />
      </div>
    </div>
  )
}
