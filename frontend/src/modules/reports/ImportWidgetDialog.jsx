import { useEffect, useState } from 'react'
import { Search, FileText, Loader2, Plus } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import { Input } from '@/shared/components/ui/input'
import { Button } from '@/shared/components/ui/button'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { cn } from '@/shared/lib/utils'
import { useAsync } from '@/shared/hooks/useAsync'
import { useSectionTaxonomy } from '@/shared/hooks/useSectionTaxonomy'
import { searchReports, getReport } from '@/modules/reports/api'
import { WorkspaceCombobox } from '@/shared/components/WorkspaceCombobox'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import { getTemplateVersion } from '@/shared/api/templates'
import { getRenderer } from '@/modules/templates/widgets'
import {
  combinedBlocks,
  BlockBody,
  resolveBlockSection,
} from '@/modules/composites/InlineReportView'

// 다른 보고서에 이미 작성된 위젯을 현재 보고서로 가져오는 모달.
//
//  - 좌측: 보고서 검색(제목·내용). 결과를 클릭하면 그 보고서를 연다.
//  - 우측: 선택한 보고서의 위젯들을 읽기전용으로 미리보고, 각 위젯의
//    "가져오기" 버튼으로 현재 보고서에 복사한다.
//
// onImport(picked) — picked = { type, props, content, layout, section }.
// 실제 블록 생성(새 id 발급·content/section 복사)은 호출측(ReportDetailPage)이
// importExtraBlock 으로 처리한다.
export function ImportWidgetDialog({ open, onClose, onImport }) {
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  const [location, setLocation] = useState('all') // 'all' | 'personal' | 'boards'
  const [board, setBoard] = useState('') // 특정 게시판 slug('' = 미지정)
  const [selectedId, setSelectedId] = useState(null)

  // 입력 디바운스(250ms).
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250)
    return () => clearTimeout(t)
  }, [q])

  // 모달 닫힐 때 상태 초기화.
  useEffect(() => {
    if (!open) {
      setQ('')
      setDebounced('')
      setLocation('all')
      setBoard('')
      setSelectedId(null)
    }
  }, [open])

  // 부서(게시판) 트리 — 메인 화면 조직 선택과 같은 계층형 picker. useWorkspace
  // 의 전체 워크스페이스에서 org(부서) 만 추려 트리/검색으로 고른다(조직이 많아도
  // 찾기 쉽게). 개인공간·virtual 은 제외.
  const { all: allWorkspaces } = useWorkspace()
  const boardChoices = (allWorkspaces ?? []).filter((w) => w.kind === 'org')

  // 검색어가 비면 접근 가능한 보고서를 최신순으로 브라우즈. board(특정 부서)가
  // 있으면 그 게시판으로, 없으면 location(전체/내공간/부서게시판) 필터.
  const { data: search, loading: searching } = useAsync(
    () =>
      open
        ? searchReports(debounced, { limit: 50, location, board })
        : Promise.resolve(null),
    [open, debounced, location, board],
  )
  const results = search?.results ?? []

  const { data: report, loading: loadingReport } = useAsync(
    () => (selectedId ? getReport(selectedId) : Promise.resolve(null)),
    [selectedId],
  )

  const { itemByCode: sectionItemByCode } = useSectionTaxonomy()

  function handlePick(page, block) {
    const propsOverride = page.props_overrides?.[block.id] ?? null
    onImport({
      type: block.type,
      props: propsOverride
        ? { ...(block.props ?? {}), ...propsOverride }
        : { ...(block.props ?? {}) },
      content: page.content?.[block.id] ?? null,
      layout: page.layout_overrides?.[block.id] ?? block.layout ?? null,
      section: resolveBlockSection(page, block),
      // 가져온 원본 보고서 — 붙여넣은 보고서와 "참고" 관계로 연결한다.
      sourceReportId: report?.id ?? null,
    })
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[80vw] max-w-[80vw] h-[80vh] max-h-[80vh] flex flex-col p-0 overflow-hidden">
        <DialogHeader className="px-5 py-3 border-b shrink-0">
          <DialogTitle>다른 보고서의 작성 위젯 가져오기</DialogTitle>
        </DialogHeader>
        <div className="flex flex-1 min-h-0">
          {/* 좌측 — 보고서 검색 */}
          <div className="w-80 shrink-0 border-r flex flex-col min-h-0">
            <div className="p-3 border-b shrink-0 space-y-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  autoFocus
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="보고서 검색 (비우면 전체)"
                  className="pl-8"
                />
              </div>
              {/* 위치 필터 — 전체 / 내공간(소유) / 내 부서게시판(공유). 빠른
                  토글이라 특정 부서를 고르면(board) 무시되고, 클릭하면 board 해제. */}
              <div className="flex rounded-md border p-0.5 text-[11px]">
                {[
                  { key: 'all', label: '전체' },
                  { key: 'personal', label: '내 공간' },
                  { key: 'boards', label: '내 부서' },
                ].map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => {
                      setLocation(opt.key)
                      setBoard('')
                    }}
                    className={cn(
                      'flex-1 rounded px-2 py-1 transition-colors',
                      !board && location === opt.key
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-muted',
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              {/* 특정 부서(게시판) 선택 — 다른 부서 게시판도 검색해서 고를 수
                  있다(권한 범위 내). 링크 picker 의 게시조직 필터와 동일 UI. */}
              <WorkspaceCombobox
                workspaces={boardChoices}
                value={board}
                onChange={(slug) => {
                  setBoard(slug)
                  if (slug) setLocation('all')
                }}
                allowNone
                noneLabel="전체 부서"
                placeholder="전체 부서"
                searchPlaceholder="부서명·경로로 검색"
                compact
                className="w-full"
              />
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
              {searching && results.length === 0 && (
                <div className="p-2 text-xs text-muted-foreground flex items-center gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" /> 불러오는 중…
                </div>
              )}
              {!searching && results.length === 0 && (
                <div className="p-2 text-xs text-muted-foreground">
                  {debounced
                    ? '검색 결과가 없습니다.'
                    : '접근 가능한 보고서가 없습니다.'}
                </div>
              )}
              {results.map((hit) => {
                const r = hit.report ?? hit
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setSelectedId(r.id)}
                    className={cn(
                      'w-full text-left rounded-md px-2.5 py-2 text-xs flex items-start gap-2',
                      String(r.id) === String(selectedId)
                        ? 'bg-primary/10 text-foreground'
                        : 'hover:bg-muted text-muted-foreground',
                    )}
                  >
                    <FileText className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-foreground">
                        {r.title || '(제목 없음)'}
                      </span>
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {[r.report_date, r.owner_name, r.workspace_slug]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* 우측 — 선택 보고서의 위젯 */}
          <div className="flex-1 min-w-0 overflow-y-auto p-4 bg-muted/20">
            {!selectedId && (
              <div className="text-sm text-muted-foreground">
                왼쪽에서 보고서를 선택하세요.
              </div>
            )}
            {selectedId && loadingReport && <Skeleton className="h-40" />}
            {report &&
              (report.pages ?? []).map((page, pi) => (
                <SourcePageWidgets
                  key={pi}
                  page={page}
                  pageIndex={pi}
                  totalPages={report.pages.length}
                  sectionItemByCode={sectionItemByCode}
                  onPick={(block) => handlePick(page, block)}
                />
              ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function SourcePageWidgets({ page, pageIndex, totalPages, sectionItemByCode, onPick }) {
  const { data: template, loading } = useAsync(
    () => getTemplateVersion(page.template_id, page.template_version),
    [page.template_id, page.template_version],
  )
  if (loading) return <Skeleton className="h-24 mb-3" />
  if (!template) return null
  // Editor 가 있는(렌더 가능한) 블록만 — 가져올 수 있는 위젯.
  const blocks = combinedBlocks(template.schema, page).filter(
    (b) => getRenderer(b.type)?.Editor,
  )
  if (blocks.length === 0) return null
  return (
    <div className="mb-5">
      {totalPages > 1 && (
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">
          페이지 {pageIndex + 1} · {page.name || template.name}
        </div>
      )}
      <div className="space-y-3">
        {blocks.map((block) => {
          const hasContent = page.content?.[block.id] != null
          return (
            <div key={block.id} className="rounded-lg border bg-card overflow-hidden">
              <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-3 py-1.5">
                <span className="text-xs font-medium text-muted-foreground truncate">
                  {block.props?.label || block.type}
                  {!hasContent && (
                    <span className="ml-1 text-[10px] text-muted-foreground/70">
                      (빈 위젯)
                    </span>
                  )}
                </span>
                <Button
                  size="sm"
                  className="h-7 shrink-0"
                  onClick={() => onPick(block)}
                >
                  <Plus className="mr-1 h-3 w-3" /> 가져오기
                </Button>
              </div>
              <div className="p-3 max-h-[320px] overflow-auto">
                <BlockBody
                  block={block}
                  content={page.content?.[block.id]}
                  propsOverride={page.props_overrides?.[block.id] ?? null}
                  sectionCode={resolveBlockSection(page, block)}
                  sectionItemByCode={sectionItemByCode}
                />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
