import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { X, Pencil, History } from 'lucide-react'
import { cn } from '@/shared/lib/utils'
import { useAsync } from '@/shared/hooks/useAsync'
import { useWidgetClipboard } from './WidgetClipboardContext'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { getReport } from '@/modules/reports/api'
import {
  PhaseChip,
  ReportDateField,
  ReportEntitiesPanel,
  ReadOnlyReportBody,
} from '@/modules/reports/ReportDetailPage'
import { useReportTabs } from './ReportTabsContext'
import { ReportTabBar } from './ReportTabBar'
import { useScrollSync } from './useScrollSync'

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
  const {
    onReportRoute,
    splitOpen,
    rightTab,
    closeRight,
    compareVersion,
    setCompareVersion,
    compareDiff,
    scrollSyncEnabled,
    setScrollSyncEnabled,
  } = useReportTabs()

  // 버전 비교 중 + 스크롤 동기화 ON 일 때만 좌우 스크롤을 연동한다.
  useScrollSync(Boolean(compareVersion) && scrollSyncEnabled)

  if (!onReportRoute) return children

  return (
    <div className="flex h-full min-h-0">
      {/* 좌측(primary) — 라우트 에디터. 항상 존재. 좌측 탭바는 폴더 사이드바를
          덮지 않도록 ReportDetailPage 의 편집 컬럼 안(폴더 사이드바 오른쪽)에서
          렌더한다 — 여기서 깔면 폴더 사이드바까지 덮인다. */}
      <div className="flex flex-1 min-w-0 min-h-0 flex-col">
        {/* min-w-0 + overflow-hidden 필수: 안 주면 보고서의 min-content 폭
            (예: 1024px 페이지)이 좁은 분할 패널을 넘어 늘어나, 보고서 컬럼과
            그에 절대배치된 편집 플로팅 버튼(absolute right-6)이 우측 패널을
            침범한다. 패널 경계에서 클립해 bleed 를 막는다. */}
        <div className="flex-1 min-w-0 min-h-0 overflow-hidden">{children}</div>
      </div>

      {/* 우측(secondary) — 읽기전용 분할 패널. 일반 분할(rightTab) 또는
          버전 비교(compareVersion). 비교가 켜지면 그쪽이 우선. */}
      {splitOpen && (rightTab || compareVersion) && (
        <>
          <div className="w-px shrink-0 bg-border" aria-hidden="true" />
          <div
            className="flex flex-1 min-w-0 min-h-0 flex-col bg-muted/20"
            data-app-chrome="report-split"
          >
            {compareVersion ? (
              <CompareVersionPane
                version={compareVersion}
                compareDiff={compareDiff}
                scrollSyncEnabled={scrollSyncEnabled}
                onToggleScrollSync={() => setScrollSyncEnabled((v) => !v)}
                onClose={() => setCompareVersion(null)}
              />
            ) : (
              <>
                <ReportTabBar pane="right" placement="pane" />
                <SplitCompanionPane
                  tab={rightTab}
                  onClose={() => closeRight(rightTab.key)}
                />
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// 좌측 툴바(.report-detail-toolbar)는 버튼이 많아 좁은 폭에서 여러 줄로 줄바꿈돼
// 높이가 가변이다. 우측 패널 헤더를 그 높이에 minHeight 로 맞춰 본문 시작 위치를
// 정렬한다. ResizeObserver 로 줄바꿈/리사이즈 변화를 추적하고, 툴바가 비동기로
// 마운트될 수 있어 몇 프레임 재시도한다. 좌측 툴바가 없으면 null.
function useLeftToolbarHeight() {
  const [h, setH] = useState(null)
  useEffect(() => {
    let ro = null
    let raf = 0
    let tries = 0
    const attach = () => {
      const el = document.querySelector('.report-detail-toolbar')
      if (!el) {
        if (tries++ < 120) raf = requestAnimationFrame(attach)
        return
      }
      const update = () => setH(el.getBoundingClientRect().height)
      update()
      ro = new ResizeObserver(update)
      ro.observe(el)
    }
    attach()
    return () => {
      cancelAnimationFrame(raf)
      if (ro) ro.disconnect()
    }
  }, [])
  return h
}

// 우측 패널 본체 — 보고서를 1회 fetch 해서 (1) 좌측과 같은 높이의 툴바 헤더,
// (2) "관련 정보" 줄(ReportEntitiesPanel), (3) 본문(InlineReportView)을 그린다.
// 같은 fetch 결과를 InlineReportView 에 snapshot 으로 넘겨 중복 요청을 피한다.
function SplitCompanionPane({ tab, onClose }) {
  const { setClip } = useWidgetClipboard()
  const headerMinH = useLeftToolbarHeight()
  const { data: report, loading, error } = useAsync(
    () => (tab.reportId ? getReport(tab.reportId) : Promise.resolve(null)),
    [tab.reportId],
  )

  // 우측(읽기전용) 위젯을 공유 클립보드로 복사 → 좌측 편집창에서 Ctrl+V /
  // 우클릭 붙여넣기(복사이므로 cutSource=null).
  function handleCopyWidget(snap) {
    setClip({ ...snap, cutSource: null })
    toast.success('위젯을 복사했습니다 — 편집 창에서 붙여넣기(Ctrl+V)')
  }

  return (
    <>
      {/* 툴바 헤더 — 좌측(ReportDetailPage)의 report-detail-toolbar 와 동일한
          구성(px-6 py-3) + 좌측 툴바가 좁은 폭에서 줄바꿈돼 늘어난 높이를 minHeight
          로 맞춘다(버튼 수가 달라도 본문 시작 높이 일치). 우측은 읽기전용이라 '편집'은 비활성. */}
      <div
        className="flex flex-wrap items-start gap-x-3 gap-y-2 border-b bg-background px-6 py-3 shrink-0"
        style={{ minHeight: headerMinH ? `${headerMinH}px` : undefined }}
      >
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
          {/* 좌측 툴바의 <Button size="sm">(h-9)과 같은 높이로 맞춰 좌/우 헤더
              높이를 일치시킨다(예전엔 h-7 라 8px 차이). */}
          <button
            type="button"
            disabled
            title="분할 보기는 읽기 전용입니다 — 편집은 왼쪽 화면에서"
            className={cn(
              'inline-flex items-center gap-1 rounded-md border h-9 px-3 text-xs',
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
            className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
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

      {/* 본문 — 에디터의 view-mode 렌더 경로(ReadOnlyReportBody=PageSection)를 그대로
          재사용해 좌측과 픽셀 동일하게 그린다. 스크롤 컨테이너는 패딩 없음(에디터의
          ScrollArea 와 동일) — 패딩은 .report-detail-content(p-6)가 담당. */}
      <div className="flex-1 min-h-0 overflow-auto">
        {loading ? (
          <div className="p-6">
            <Skeleton className="h-40" />
          </div>
        ) : error ? (
          <div className="p-6 text-xs text-destructive">{error.message}</div>
        ) : report ? (
          <ReadOnlyReportBody
            report={report}
            exposeBlockIds={false}
            onCopyWidget={handleCopyWidget}
          />
        ) : null}
      </div>
    </>
  )
}

const COMPARE_SOURCE_LABEL = { save: '저장', restore: '되돌림', publish: '게시' }

function fmtCompareTs(ts) {
  if (!ts) return ''
  try {
    return new Date(ts).toLocaleString('ko-KR', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return String(ts)
  }
}

// 버전 비교 패널 — 우측에 현재 보고서의 과거 버전을 띄운다. 좌측(에디터)과
// 나란히 보며 위젯 단위 차이(compareDiff)를 양쪽에 강조하고, 스크롤을 연동할 수
// 있다. 본문은 InlineReportView(snapshot=버전 body)로 읽기전용 렌더.
function CompareVersionPane({
  version,
  compareDiff,
  scrollSyncEnabled,
  onToggleScrollSync,
  onClose,
}) {
  const { setClip } = useWidgetClipboard()
  // 과거 버전의 위젯을 공유 클립보드로 복사 → 좌측 편집창에 붙여넣기(복원 용도).
  function handleCopyWidget(snap) {
    setClip({ ...snap, cutSource: null })
    toast.success('위젯을 복사했습니다 — 편집 창에서 붙여넣기(Ctrl+V)')
  }
  const body = version?.body ?? null
  // 버전 body 엔 보고서 표시 설정(page_width_px·page_gap_px·rich-text prefix)이
  // 빠져 있다 — 버전은 본문만 스냅샷한다. 그대로 렌더하면 기본 폭/간격으로 떨어져
  // 좌측(현재 보고서)과 컨테이너 형태가 달라진다. 그래서 현재 보고서의 표시 설정을
  // fetch 해 body 에 덧씌워 InlineReportView 가 좌측과 같은 폭/간격으로 그리게 한다.
  const { data: liveReport } = useAsync(
    () => (version?.reportId ? getReport(version.reportId) : Promise.resolve(null)),
    [version?.reportId],
  )
  const snapshot =
    body && liveReport
      ? {
          ...body,
          page_width_px: liveReport.page_width_px,
          page_gap_px: liveReport.page_gap_px,
          page_blend_blocks: liveReport.page_blend_blocks,
          page_rich_text_prefix_d0: liveReport.page_rich_text_prefix_d0,
          page_rich_text_prefix_d1: liveReport.page_rich_text_prefix_d1,
          page_rich_text_prefix_d2: liveReport.page_rich_text_prefix_d2,
          // PageSection/usePageTemplates 가 쓰는 식별 필드 — 버전 body 엔 없으므로
          // 현재 보고서에서 가져온다(템플릿 fetch 스코프·reportId·phase).
          workspace_slug: liveReport.workspace_slug,
          id: liveReport.id,
          phase: liveReport.phase,
        }
      : body

  // 좌측 툴바 높이에 맞춰 비교 헤더 minHeight 정렬(버튼 줄바꿈까지 추적).
  const headerMinH = useLeftToolbarHeight()

  return (
    <>
      {/* 좌측 탭 스트립과 같은 높이의 줄 — 비교 패널엔 탭바가 없어 좌우 콘텐츠
          시작 높이가 어긋나던 것을 맞춘다(ReportTabBar 의 TabStrip 과 동일한
          컨테이너/칩 클래스). 비교 대상 버전을 탭처럼 표시 + 종료 버튼. */}
      <div className="flex items-stretch gap-1 border-b bg-muted/40 px-2 py-1 shrink-0">
        <div className="group flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs text-foreground shadow-sm max-w-[240px]">
          <History className="h-3 w-3 text-amber-500 shrink-0" />
          <span className="truncate">버전 #{version?.seq} 비교</span>
          <button
            type="button"
            aria-label="비교 종료"
            title="비교 종료"
            onClick={onClose}
            className="inline-flex h-4 w-4 items-center justify-center rounded shrink-0 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>

      {/* 헤더 — 좌측 툴바와 같은 높이(px-6 py-3)에 더해, 줄바꿈으로 늘어난 좌측
          툴바 높이를 minHeight 로 맞춘다. 어느 버전과 비교 중인지 + 스크롤 동기화
          토글 + 비교 종료. */}
      <div
        className="flex flex-wrap items-start gap-x-3 gap-y-2 border-b bg-background px-6 py-3 shrink-0"
        style={{ minHeight: headerMinH ? `${headerMinH}px` : undefined }}
      >
        <div className="basis-full min-w-0">
          <div className="flex items-center gap-1.5 text-lg font-semibold truncate">
            <History className="h-4 w-4 text-amber-500 shrink-0" />
            버전 비교
            <span className="text-muted-foreground font-normal text-sm">
              #{version?.seq} · {fmtCompareTs(version?.createdAt)}
              {version?.source
                ? ` · ${COMPARE_SOURCE_LABEL[version.source] || version.source}`
                : ''}
            </span>
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            이 버전(우)과 현재 편집본(좌)을 나란히 비교 — 달라진 위젯이 색으로 표시됩니다.
          </div>
        </div>
        <div className="flex items-center gap-2 ml-auto shrink-0">
          <button
            type="button"
            onClick={onToggleScrollSync}
            aria-pressed={!!scrollSyncEnabled}
            title="좌우 스크롤을 함께 움직입니다"
            className={cn(
              'inline-flex items-center gap-1 rounded-md border h-9 px-3 text-xs',
              scrollSyncEnabled
                ? 'border-amber-400 bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300'
                : 'text-muted-foreground hover:bg-muted',
            )}
          >
            스크롤 동기화 {scrollSyncEnabled ? 'ON' : 'OFF'}
          </button>
          <button
            type="button"
            aria-label="비교 종료"
            title="비교 종료"
            onClick={onClose}
            className="inline-flex h-9 items-center gap-1 rounded-md px-3 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
            종료
          </button>
        </div>
      </div>

      {/* 본문 — 버전 body 를 읽기전용 렌더. data-compare-scroll="right" 로 스크롤
          동기화 훅이 이 뷰포트를 잡는다. compareDiff + compareSide 로 우측에서
          삭제/변경된 위젯을 강조(Phase 2). */}
      <div
        className="flex-1 min-h-0 overflow-auto"
        data-compare-scroll="right"
      >
        {snapshot ? (
          <ReadOnlyReportBody
            report={snapshot}
            exposeBlockIds={false}
            compareDiff={compareDiff}
            compareSide="right"
            onCopyWidget={handleCopyWidget}
          />
        ) : (
          <div className="p-6">
            <Skeleton className="h-40" />
          </div>
        )}
      </div>
    </>
  )
}
