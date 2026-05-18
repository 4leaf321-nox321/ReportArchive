import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import {
  ArrowLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  GripVertical,
  HardDrive,
  Layers,
  Maximize2,
  Pencil,
  Plus,
  Rows,
  Save,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import GridLayout, { useContainerWidth } from 'react-grid-layout'
import { Button } from '@/shared/components/ui/button'
import { Badge } from '@/shared/components/ui/badge'
import { Card, CardContent } from '@/shared/components/ui/card'
import { ScrollArea } from '@/shared/components/ui/scroll-area'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { Input } from '@/shared/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/shared/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu'
import { ConfirmDialog } from '@/shared/components/ConfirmDialog'
import { ErrorState } from '@/shared/components/ErrorState'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import { useAsync } from '@/shared/hooks/useAsync'
import { usePersistedState } from '@/shared/hooks/usePersistedState'
import { getReport, createReport, updateReport, deleteReport } from './api'
import { getTemplateVersion } from '@/shared/api/templates'
import { STATUSES, STATUS_LABEL, STATUS_VARIANT } from './constants'
import { getRenderer } from '@/modules/templates/widgets'
import { DepthStyleField, TextStyleField } from '@/modules/templates/widgets/_shared'
import { TemplatePicker } from './TemplatePicker'
import { cn } from '@/shared/lib/utils'
import { toast } from 'sonner'

/**
 * Two entry modes:
 *   /reports/new/:templateId/:version  → blank report seeded from a template
 *   /reports/:reportId                 → existing report
 *
 * Reports are multi-page: `draft.pages` is an ordered array, each entry
 * binding to its own template + content + layout_overrides. `currentPage`
 * is the index shown in paginated view-mode; `viewMode === 'all'` stacks
 * every page below one another.
 */
export default function ReportDetailPage() {
  const { reportId, templateId, version } = useParams()
  const navigate = useNavigate()
  const { slug, all: workspaces } = useWorkspace()
  const isNew = Boolean(templateId)

  // 'paginated' = show one page at a time with prev/next controls
  // 'all'       = stack every page vertically (scroll through them)
  const [viewMode, setViewMode] = usePersistedState(
    'ra:report-view-mode:v1',
    'paginated'
  )
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [isEditing, setIsEditing] = useState(isNew)
  const [currentPage, setCurrentPage] = useState(0)

  // New-report mode: fetch the seed template directly from the URL params
  // (the existing-report fetch path goes through `existingReport.pages`
  // and the `pageTemplateMap` below).
  const { data: seedTemplate, loading: tplLoading, error: tplError } = useAsync(
    () => (isNew && slug ? getTemplateVersion(templateId, Number(version)) : Promise.resolve(null)),
    [isNew, templateId, version, slug]
  )
  const {
    data: existingReport,
    loading: rptLoading,
    error: rptError,
    reload: reloadReport,
  } = useAsync(
    () => (!isNew && reportId && slug ? getReport(reportId) : Promise.resolve(null)),
    [isNew, reportId, slug]
  )

  const loading = isNew ? tplLoading : rptLoading
  const error = isNew ? tplError : rptError

  // Local working copy of the report. `pages` is the source of truth for
  // template binding + content + layout_overrides; the top-level fields
  // hold cross-page metadata.
  const [draft, setDraft] = useState(null)
  useEffect(() => {
    if (isNew && seedTemplate) {
      setDraft({
        title: '새 보고서',
        report_date: todayIsoDate(),
        status: 'draft',
        tags: [],
        pages: [
          {
            template_id: seedTemplate.template_id,
            template_version: seedTemplate.version,
            content: seedContentFromTemplate(seedTemplate),
            layout_overrides: null,
            props_overrides: null,
          },
        ],
      })
      setCurrentPage(0)
    } else if (!isNew && existingReport) {
      // Backend always emits a non-empty `pages` array post-migration.
      // The fallback synthesizes one from top-level fields just in case
      // we ever read a stale row that pre-dates the backfill.
      const pages =
        existingReport.pages && existingReport.pages.length > 0
          ? existingReport.pages.map(normalizePage)
          : [
              {
                template_id: existingReport.template_id,
                template_version: existingReport.template_version,
                content: existingReport.content ?? {},
                layout_overrides: existingReport.layout_overrides ?? null,
                props_overrides: existingReport.props_overrides ?? null,
              },
            ]
      setDraft({
        id: existingReport.id,
        title: existingReport.title,
        report_date: existingReport.report_date ?? todayIsoDate(),
        tags: existingReport.tags ?? [],
        status: existingReport.status,
        pages,
      })
      setCurrentPage((p) => clamp(p, 0, pages.length - 1))
    }
  }, [isNew, seedTemplate, existingReport])

  // Fetch the template version for every page in the draft (deduped by
  // template_id+version). Cached in a map keyed by `${id}@${version}` so
  // switching pages is instant and the 'all' view can render every page
  // without waterfalling.
  const pageTemplateMap = usePageTemplates(draft?.pages, slug)

  // Active block tracking — composite key so the same block id across two
  // pages doesn't collide. `null` = nothing focused.
  const [activeBlock, setActiveBlock] = useState(null) // { pageIdx, blockId } | null

  // File input for "로컬 불러오기" — declared up here so the hook order
  // stays stable across the loading → ready transition (the button itself
  // is rendered after the early-returns below).
  const fileInputRef = useRef(null)

  // Auto-fit content-height cache. Per page, per block: the natural pixel
  // height of the block's *read-only* (view-mode) render. Lifted up here so
  // `handleLayoutChange` can write a content-driven row_span into
  // layout_overrides even when the visible cell is sized for the (possibly
  // taller) edit-mode GUI.
  const [contentHeightsByPage, setContentHeightsByPage] = useState({})
  const setContentHeight = useCallback((pageIdx, blockId, px) => {
    setContentHeightsByPage((prev) => {
      if (prev[pageIdx]?.[blockId] === px) return prev
      return {
        ...prev,
        [pageIdx]: { ...(prev[pageIdx] ?? {}), [blockId]: px },
      }
    })
  }, [])

  // Keyboard nav between pages (paginated view only). Ignored while focus
  // is in a text input so the arrow keys still move the caret as expected.
  const pageCountForKeys = draft?.pages?.length ?? 0
  useEffect(() => {
    if (viewMode !== 'paginated') return
    if (pageCountForKeys <= 1) return
    function onKey(e) {
      const t = e.target
      if (
        t instanceof HTMLElement &&
        (t.matches('input, textarea, select') || t.isContentEditable)
      ) {
        return
      }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault()
        setCurrentPage((p) => clamp(p - 1, 0, pageCountForKeys - 1))
      } else if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        e.preventDefault()
        setCurrentPage((p) => clamp(p + 1, 0, pageCountForKeys - 1))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [viewMode, pageCountForKeys])

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-6">
        <ErrorState
          title={isNew ? '템플릿을 불러올 수 없습니다' : '보고서를 불러올 수 없습니다'}
          description={error.message}
          action={
            <Button asChild variant="outline">
              <Link to={isNew ? `/w/${slug}/reports/new` : `/w/${slug}/reports`}>돌아가기</Link>
            </Button>
          }
        />
      </div>
    )
  }

  if (!draft) return null

  const pages = draft.pages
  const pageCount = pages.length
  const safeCurrent = clamp(currentPage, 0, pageCount - 1)
  const currentPageData = pages[safeCurrent]
  const currentTemplate = getCachedTemplate(pageTemplateMap, currentPageData)

  function updatePage(idx, patch) {
    setDraft((d) => {
      if (!d) return d
      const next = [...d.pages]
      next[idx] = { ...next[idx], ...patch }
      return { ...d, pages: next }
    })
  }

  function updateBlockContent(pageIdx, blockId, value) {
    setDraft((d) => {
      if (!d) return d
      const next = [...d.pages]
      const target = next[pageIdx]
      next[pageIdx] = {
        ...target,
        content: { ...(target.content ?? {}), [blockId]: value },
      }
      return { ...d, pages: next }
    })
  }

  /**
   * Merge a partial props override onto the given block. `patch` keys are
   * shallow — e.g. `{ text_style: {...} | undefined }`. Undefined/empty
   * values drop the key from the block's override; an empty block drops
   * out of the page's override map; an empty map nulls the field entirely.
   * Keeps the saved JSON sparse so PATCH diffs stay tight.
   */
  function updateBlockPropsOverride(pageIdx, blockId, patch) {
    setDraft((d) => {
      if (!d) return d
      const next = [...d.pages]
      const target = next[pageIdx]
      const curMap = target.props_overrides ?? {}
      const curBlock = curMap[blockId] ?? {}
      const merged = { ...curBlock, ...patch }
      for (const key of Object.keys(merged)) {
        const v = merged[key]
        if (
          v === undefined ||
          v === null ||
          (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0)
        ) {
          delete merged[key]
        }
      }
      const nextMap = { ...curMap }
      if (Object.keys(merged).length === 0) {
        delete nextMap[blockId]
      } else {
        nextMap[blockId] = merged
      }
      const nextOverrides = Object.keys(nextMap).length === 0 ? null : nextMap
      next[pageIdx] = { ...target, props_overrides: nextOverrides }
      return { ...d, pages: next }
    })
  }

  function addPage(template) {
    setDraft((d) => {
      if (!d) return d
      const newPage = {
        template_id: template.template_id,
        template_version: template.version,
        name: null,
        content: seedContentFromTemplate(template),
        layout_overrides: null,
        props_overrides: null,
      }
      const next = [...d.pages, newPage]
      return { ...d, pages: next }
    })
    setCurrentPage(pages.length) // jump to the newly added page
    setPickerOpen(false)
  }

  function removePage(idx) {
    if (pageCount <= 1) return
    setDraft((d) => {
      if (!d) return d
      const next = d.pages.filter((_, i) => i !== idx)
      return { ...d, pages: next }
    })
    setCurrentPage((p) => clamp(p > idx ? p - 1 : p, 0, pageCount - 2))
  }

  function renamePage(idx, name) {
    const trimmed = typeof name === 'string' ? name.trim() : ''
    updatePage(idx, { name: trimmed === '' ? null : trimmed })
  }

  // RGL layout-change handler scoped to one page. Diffs against that page's
  // template defaults to keep `layout_overrides` lean. `auto_fit` defaults to
  // true; we only persist it when the user has explicitly disabled it (so the
  // diff still strips overrides that match the template + default flag).
  //
  // Critically, for auto_fit blocks the persisted `row_span` is computed
  // from the *content* (read-only render) height — not the rgl cell `h`,
  // which in edit mode may be larger to accommodate the editor GUI. That
  // way the saved size matches what view mode will render, leaving no
  // empty space and no scrollbars after editing is complete.
  function handleLayoutChange(pageIdx, rglLayout) {
    const page = draft.pages[pageIdx]
    const tpl = getCachedTemplate(pageTemplateMap, page)
    if (!tpl) return
    const blocks = extractBlocks(tpl.schema)
    const curOverrides = page?.layout_overrides ?? {}
    const pageContentHeights = contentHeightsByPage[pageIdx] ?? {}

    const sortedYs = [...new Set(rglLayout.map((it) => it.y))].sort((a, b) => a - b)
    const yToRow = new Map(sortedYs.map((y, i) => [y, i + 1]))
    const overrides = {}
    for (const it of rglLayout) {
      const block = blocks.find((b) => b.id === it.i)
      if (!block) continue
      const explicitlyDisabled = curOverrides[block.id]?.auto_fit === false
      const isAutoFit = !explicitlyDisabled
      const contentPx = pageContentHeights[block.id]
      let rowSpan = Math.max(1, it.h ?? 2)
      if (isAutoFit && contentPx != null && contentPx > 0) {
        rowSpan = Math.max(
          1,
          Math.ceil(
            (contentPx + REPORT_ROW_GAP) / (REPORT_ROW_HEIGHT + REPORT_ROW_GAP)
          )
        )
      }
      const newLayout = {
        row: yToRow.get(it.y) ?? 1,
        col_span: clamp(it.w ?? 12, 1, 12),
        row_span: rowSpan,
      }
      if (explicitlyDisabled) newLayout.auto_fit = false
      const blkTpl = block.layout
      const matchesTemplate =
        blkTpl &&
        !explicitlyDisabled &&
        blkTpl.row === newLayout.row &&
        blkTpl.col_span === newLayout.col_span &&
        blkTpl.row_span === newLayout.row_span
      if (!matchesTemplate) {
        overrides[block.id] = newLayout
      }
    }
    const next = Object.keys(overrides).length === 0 ? null : overrides
    if (!sameOverrides(page.layout_overrides, next)) {
      updatePage(pageIdx, { layout_overrides: next })
    }
  }

  // Toggle the per-block auto-fit flag inside layout_overrides. Default is
  // ON, so disabling stores `auto_fit: false` explicitly; re-enabling drops
  // the field (default takes over) and removes the override entirely when
  // row/col/row_span still match the template's layout.
  function handleToggleAutoFit(pageIdx, blockId, enabled) {
    setDraft((d) => {
      if (!d) return d
      const page = d.pages[pageIdx]
      const tpl = getCachedTemplate(pageTemplateMap, page)
      if (!tpl) return d
      const blocks = extractBlocks(tpl.schema)
      const block = blocks.find((b) => b.id === blockId)
      if (!block) return d
      const cur = page.layout_overrides?.[blockId]
      const base = cur ?? block.layout ?? { row: 99, col_span: REPORT_GRID_COLS, row_span: AUTO_FIT_INITIAL_ROWS }
      const next = {
        row: base.row ?? 1,
        col_span: base.col_span ?? REPORT_GRID_COLS,
        row_span: base.row_span ?? AUTO_FIT_INITIAL_ROWS,
      }
      if (!enabled) next.auto_fit = false

      const blkTpl = block.layout
      const matchesTemplate =
        blkTpl &&
        enabled &&
        blkTpl.row === next.row &&
        blkTpl.col_span === next.col_span &&
        blkTpl.row_span === next.row_span
      const newOverrides = { ...(page.layout_overrides ?? {}) }
      if (matchesTemplate) delete newOverrides[blockId]
      else newOverrides[blockId] = next
      const finalOverrides =
        Object.keys(newOverrides).length === 0 ? null : newOverrides
      const nextPages = d.pages.slice()
      nextPages[pageIdx] = { ...page, layout_overrides: finalOverrides }
      return { ...d, pages: nextPages }
    })
  }

  async function onSave() {
    try {
      // The first page's template doubles as the report's primary
      // template (backend FK + listing display).
      const first = draft.pages[0]
      const payload = {
        title: draft.title,
        report_date: draft.report_date || null,
        status: draft.status,
        tags: draft.tags ?? [],
        pages: draft.pages,
      }
      if (isNew) {
        const created = await createReport({
          ...payload,
          template_id: first.template_id,
          template_version: first.template_version,
        })
        toast.success('보고서가 생성되었습니다.')
        // Creation is the save — drop straight into view mode. The
        // component instance stays mounted across the navigate (same
        // ReportDetailPage), so `isEditing` would otherwise leak from
        // the new-draft state and surface a misleading "저장" button.
        setIsEditing(false)
        navigate(`/w/${slug}/reports/${created.id}`, { replace: true })
      } else {
        await updateReport(draft.id, payload)
        toast.success('저장되었습니다.')
        reloadReport()
        setIsEditing(false)
      }
    } catch (err) {
      toast.error(err.message || '저장 실패')
    }
  }

  function onCancelEdit() {
    if (isNew) {
      navigate(`/w/${slug}/reports`)
      return
    }
    if (existingReport) {
      // Re-seed from the server snapshot.
      const pages =
        existingReport.pages && existingReport.pages.length > 0
          ? existingReport.pages.map(normalizePage)
          : [
              {
                template_id: existingReport.template_id,
                template_version: existingReport.template_version,
                content: existingReport.content ?? {},
                layout_overrides: existingReport.layout_overrides ?? null,
                props_overrides: existingReport.props_overrides ?? null,
              },
            ]
      setDraft({
        id: existingReport.id,
        title: existingReport.title,
        report_date: existingReport.report_date ?? todayIsoDate(),
        tags: existingReport.tags ?? [],
        status: existingReport.status,
        pages,
      })
      setCurrentPage((p) => clamp(p, 0, pages.length - 1))
    }
    setIsEditing(false)
  }

  async function onDelete() {
    try {
      await deleteReport(draft.id)
      toast.success('보고서가 삭제되었습니다.')
      navigate(`/w/${slug}/reports`)
    } catch (err) {
      toast.error(err.message || '삭제 실패')
    }
  }

  // Local snapshot export — downloads the current working draft (title +
  // report_date + tags + pages) as a JSON file. The `id` and `status`
  // columns are deliberately omitted: the snapshot is meant to be portable
  // across reports, not to round-trip server identity. A version tag lets
  // the importer reject unrelated JSON.
  function handleLocalSave() {
    if (!draft) return
    // Audit fields — informational only. They describe the server-side
    // state of the report at export time so the JSON is self-explanatory
    // when archived offline. They don't round-trip back through import.
    const meta = existingReport
      ? {
          workspace_slug: existingReport.workspace_slug,
          owner_user_id: existingReport.owner_user_id,
          owner_name: existingReport.owner_name,
          owner_email: existingReport.owner_email,
          updated_by_user_id: existingReport.updated_by_user_id,
          updated_by_name: existingReport.updated_by_name,
          updated_by_email: existingReport.updated_by_email,
          created_at: existingReport.created_at,
          updated_at: existingReport.updated_at,
          status: existingReport.status,
        }
      : null
    const payload = {
      _type: 'report_archive_draft_v1',
      saved_at: new Date().toISOString(),
      title: draft.title ?? '',
      report_date: draft.report_date ?? '',
      tags: draft.tags ?? [],
      pages: draft.pages ?? [],
      meta,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const safeName = (draft.title || 'report')
      .replace(/[\\/:*?"<>|]+/g, '_')
      .slice(0, 80) || 'report'
    a.download = `${safeName}-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    toast.success('JSON 파일로 저장했습니다.')
  }
  async function handleLocalLoad(e) {
    const file = e.target.files?.[0]
    e.target.value = '' // reset so the same file can be re-loaded later
    if (!file) return
    try {
      const text = await file.text()
      const obj = JSON.parse(text)
      if (obj?._type !== 'report_archive_draft_v1') {
        throw new Error('지원하지 않는 파일 형식입니다.')
      }
      if (!Array.isArray(obj.pages) || obj.pages.length === 0) {
        throw new Error('페이지 데이터가 비어 있습니다.')
      }
      setDraft((d) => ({
        ...(d ?? {}),
        title: typeof obj.title === 'string' ? obj.title : (d?.title ?? ''),
        report_date:
          typeof obj.report_date === 'string' && obj.report_date
            ? obj.report_date
            : (d?.report_date ?? todayIsoDate()),
        tags: Array.isArray(obj.tags) ? obj.tags : (d?.tags ?? []),
        pages: obj.pages.map(normalizePage),
      }))
      setCurrentPage(0)
      // Loaded content is unsaved — switch into edit mode so the user can
      // review and either save back to the server or discard.
      setIsEditing(true)
      toast.success('JSON 파일을 불러왔습니다. 저장하려면 “저장” 버튼을 눌러주세요.')
    } catch (err) {
      toast.error(err.message || '불러오기 실패')
    }
  }

  return (
    <div className="flex h-full">
      <div className="relative flex-1 min-w-0 flex flex-col">
        <div className="flex items-center gap-3 border-b bg-background px-6 py-3">
          <div className="flex-1 min-w-0">
            {isEditing ? (
              <Input
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                placeholder="제목"
                className="border-0 px-0 text-lg font-semibold focus-visible:ring-0 h-auto py-0"
              />
            ) : (
              <div className="text-lg font-semibold truncate">
                {draft.title || <span className="text-muted-foreground">(제목 없음)</span>}
              </div>
            )}
            <div className="mt-0.5 text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
              <span>
                {currentTemplate?.name ?? <span className="italic">템플릿 불러오는 중…</span>}
              </span>
              <span>v{currentPageData?.template_version}</span>
              {pageCount > 1 && (
                <Badge variant="outline" className="text-[10px]">
                  {pageCount}개 페이지
                </Badge>
              )}
              <StatusField
                editing={isEditing}
                value={draft.status ?? 'draft'}
                onChange={(v) => setDraft({ ...draft, status: v })}
              />
              <ReportDateField
                editing={isEditing}
                value={draft.report_date ?? ''}
                onChange={(v) => setDraft({ ...draft, report_date: v })}
              />
            </div>
            {!isNew && existingReport && (
              <ReportMetaLine
                ownerName={existingReport.owner_name}
                ownerEmail={existingReport.owner_email}
                workspaceSlug={existingReport.workspace_slug}
                workspaceName={
                  workspaces?.find((w) => w.slug === existingReport.workspace_slug)?.name
                  ?? existingReport.workspace_slug
                }
                createdAt={existingReport.created_at}
                updatedByName={existingReport.updated_by_name}
                updatedByEmail={existingReport.updated_by_email}
                updatedAt={existingReport.updated_at}
              />
            )}
          </div>

          <ViewModeToggle value={viewMode} onChange={setViewMode} />

          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate(`/w/${slug}/reports`)}
          >
            <ArrowLeft className="mr-1 h-3 w-3" />
            목록
          </Button>

          {isEditing ? (
            <>
              <Button variant="outline" size="sm" onClick={onSave}>
                <Save className="mr-1 h-3 w-3" />
                {isNew ? '생성' : '저장'}
              </Button>
              <Button variant="ghost" size="sm" onClick={onCancelEdit}>
                <X className="mr-1 h-3 w-3" />
                {isNew ? '나가기' : '취소'}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={() => setIsEditing(true)}>
                <Pencil className="mr-1 h-3 w-3" />
                편집
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 className="mr-1 h-3 w-3" />
                삭제
              </Button>
            </>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" title="JSON 파일로 저장하거나 불러오기">
                <HardDrive className="mr-1 h-3 w-3" />
                로컬
                <ChevronDown className="ml-1 h-3 w-3 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={handleLocalSave}>
                <Download className="mr-2 h-3.5 w-3.5" />
                JSON으로 저장
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => fileInputRef.current?.click()}>
                <Upload className="mr-2 h-3.5 w-3.5" />
                JSON에서 불러오기
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            onChange={handleLocalLoad}
            className="hidden"
          />
        </div>

        {/* Page strip — chips that select the active page (paginated mode).
            In 'all' mode they act as scroll-to anchors. Always shows the
            "+ 페이지 추가" button when editing. */}
        <PageStrip
          pages={pages}
          pageTemplateMap={pageTemplateMap}
          currentPage={safeCurrent}
          onSelect={(idx) => {
            setCurrentPage(idx)
            if (viewMode === 'all') {
              const el = document.getElementById(`report-page-${idx}`)
              if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }
          }}
          onRemove={removePage}
          onAdd={() => setPickerOpen(true)}
          isEditing={isEditing}
          viewMode={viewMode}
        />

        <ScrollArea className="flex-1">
          <div className="p-6 space-y-8">
            {viewMode === 'all'
              ? pages.map((p, idx) => (
                  <PageSection
                    key={`page-${idx}`}
                    pageIdx={idx}
                    page={p}
                    template={getCachedTemplate(pageTemplateMap, p)}
                    isEditing={isEditing}
                    activeBlock={activeBlock}
                    onActivate={(blockId) => setActiveBlock({ pageIdx: idx, blockId })}
                    onChangeContent={(blockId, value) => updateBlockContent(idx, blockId, value)}
                    onChangePropsOverride={(blockId, patch) =>
                      updateBlockPropsOverride(idx, blockId, patch)
                    }
                    onLayoutChange={(rglLayout) => handleLayoutChange(idx, rglLayout)}
                    onToggleAutoFit={(blockId, enabled) =>
                      handleToggleAutoFit(idx, blockId, enabled)
                    }
                    contentHeights={contentHeightsByPage[idx]}
                    onMeasureContentHeight={(blockId, px) =>
                      setContentHeight(idx, blockId, px)
                    }
                    onRename={(name) => renamePage(idx, name)}
                    showPageHeader={pageCount > 1}
                  />
                ))
              : (
                  <PageSection
                    key={`page-${safeCurrent}`}
                    pageIdx={safeCurrent}
                    page={currentPageData}
                    template={currentTemplate}
                    isEditing={isEditing}
                    activeBlock={activeBlock}
                    onActivate={(blockId) =>
                      setActiveBlock({ pageIdx: safeCurrent, blockId })
                    }
                    onChangeContent={(blockId, value) =>
                      updateBlockContent(safeCurrent, blockId, value)
                    }
                    onChangePropsOverride={(blockId, patch) =>
                      updateBlockPropsOverride(safeCurrent, blockId, patch)
                    }
                    onLayoutChange={(rglLayout) => handleLayoutChange(safeCurrent, rglLayout)}
                    onToggleAutoFit={(blockId, enabled) =>
                      handleToggleAutoFit(safeCurrent, blockId, enabled)
                    }
                    contentHeights={contentHeightsByPage[safeCurrent]}
                    onMeasureContentHeight={(blockId, px) =>
                      setContentHeight(safeCurrent, blockId, px)
                    }
                    onRename={(name) => renamePage(safeCurrent, name)}
                    showPageHeader={pageCount > 1}
                  />
                )}

          </div>
        </ScrollArea>

        {/* Floating prev/next pager — always reachable on long pages. The
            top page strip handles arbitrary jumps; this pill handles linear
            stepping plus surfaces the current/total counter while scrolled
            deep into a page. */}
        {viewMode === 'paginated' && pageCount > 1 && (
          <FloatingPager
            current={safeCurrent}
            total={pageCount}
            onChange={setCurrentPage}
          />
        )}
      </div>

      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="max-w-5xl max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>페이지 추가 — 템플릿 선택</DialogTitle>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-auto">
            <TemplatePicker onPick={addPage} compact reloadKey={pickerOpen ? 1 : 0} />
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="보고서 삭제"
        description="이 보고서를 정말 삭제하시겠습니까? 되돌릴 수 없습니다."
        confirmLabel="삭제"
        variant="destructive"
        onConfirm={onDelete}
      />
    </div>
  )
}

// --------------------------------------------------------------------------- //
// View-mode toggle + page navigation                                          //
// --------------------------------------------------------------------------- //

/**
 * One-line metadata strip under the report title: who wrote it (and in which
 * workspace), when it was created, and who last touched it. Sits between the
 * header chips (template/status) and the toolbar so the audit trail is always
 * visible without opening a separate panel.
 */
function ReportMetaLine({
  ownerName,
  ownerEmail,
  workspaceSlug,
  workspaceName,
  createdAt,
  updatedByName,
  updatedByEmail,
  updatedAt,
}) {
  const wroteSameAsEdited =
    ownerName && updatedByName && ownerName === updatedByName
  const createdSameAsUpdated =
    createdAt && updatedAt && Math.abs(new Date(createdAt) - new Date(updatedAt)) < 60_000
  const wsDisplay = workspaceName ?? workspaceSlug

  return (
    <div className="mt-1 flex items-center gap-x-3 gap-y-1 flex-wrap text-[11px] text-muted-foreground">
      <span title={ownerEmail ? `${ownerName ?? '?'} <${ownerEmail}>` : undefined}>
        작성{' '}
        <span className="text-foreground/80">{ownerName ?? '—'}</span>
        {wsDisplay && (
          <span
            className="text-muted-foreground/70"
            title={workspaceSlug !== wsDisplay ? workspaceSlug : undefined}
          >
            {' · '}{wsDisplay}
          </span>
        )}
        {createdAt && <span className="text-muted-foreground/70"> · {formatMetaDate(createdAt)}</span>}
      </span>
      {!createdSameAsUpdated && updatedAt && (
        <span title={updatedByEmail ? `${updatedByName ?? '?'} <${updatedByEmail}>` : undefined}>
          최근 수정{' '}
          {!wroteSameAsEdited && (
            <>
              <span className="text-foreground/80">{updatedByName ?? '—'}</span>
              <span className="text-muted-foreground/70"> · </span>
            </>
          )}
          <span className="text-muted-foreground/70">{formatMetaDate(updatedAt)}</span>
        </span>
      )}
    </div>
  )
}

function formatMetaDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Inline 상태 chip. Read-only badge when viewing; switches to a small
 *  select in edit mode so users can flip between 작성 중 / 진행 업무 /
 *  완료 업무. Status is part of the dashboard's status panel aggregation. */
function StatusField({ editing, value, onChange }) {
  if (!editing) {
    return <Badge variant={STATUS_VARIANT[value] ?? 'secondary'}>{STATUS_LABEL[value] ?? value}</Badge>
  }
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-6 rounded border border-input bg-background px-1.5 text-[11px]"
      aria-label="상태"
    >
      {STATUSES.map((s) => (
        <option key={s.value} value={s.value}>{s.label}</option>
      ))}
    </select>
  )
}

/** Inline 보고 기준일 chip. Read-only badge when not editing; switches to a
 *  native date input in edit mode so the user can back-date or schedule the
 *  report. Used by the dashboard's period filters instead of created_at,
 *  so changing it moves the report between weeks/months in the trend chart. */
function ReportDateField({ editing, value, onChange }) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px]">
      <span className="text-muted-foreground">보고 기준일</span>
      {editing ? (
        <input
          type="date"
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          className="h-6 rounded border border-input bg-background px-1.5 text-[11px] font-mono"
        />
      ) : (
        <span className="text-foreground/80 font-mono">{value || '—'}</span>
      )}
    </span>
  )
}

function todayIsoDate() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function ViewModeToggle({ value, onChange }) {
  return (
    <div className="inline-flex rounded-md border bg-background overflow-hidden">
      <button
        type="button"
        onClick={() => onChange('paginated')}
        className={cn(
          'px-2.5 py-1 text-xs flex items-center gap-1.5',
          value === 'paginated'
            ? 'bg-primary text-primary-foreground'
            : 'text-muted-foreground hover:bg-muted'
        )}
        aria-pressed={value === 'paginated'}
        title="페이지별 보기"
      >
        <Layers className="h-3 w-3" />
        페이지별
      </button>
      <button
        type="button"
        onClick={() => onChange('all')}
        className={cn(
          'px-2.5 py-1 text-xs flex items-center gap-1.5 border-l',
          value === 'all'
            ? 'bg-primary text-primary-foreground'
            : 'text-muted-foreground hover:bg-muted'
        )}
        aria-pressed={value === 'all'}
        title="전체 보기"
      >
        <Rows className="h-3 w-3" />
        전체
      </button>
    </div>
  )
}

function PageStrip({
  pages,
  pageTemplateMap,
  currentPage,
  onSelect,
  onRemove,
  onAdd,
  isEditing,
  viewMode,
}) {
  // Ref to the currently-active chip so we can scroll it into view when
  // the user navigates — critical when there are enough pages to overflow.
  const activeChipRef = useRef(null)
  // Ref to the scroll container so we can detect overflow and decide
  // whether to show the edge fades.
  const scrollRef = useRef(null)
  const [overflow, setOverflow] = useState({ left: false, right: false })

  useEffect(() => {
    activeChipRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'center',
    })
  }, [currentPage, pages.length])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const update = () => {
      setOverflow({
        left: el.scrollLeft > 2,
        right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2,
      })
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [pages.length])

  // When there's only one page and we're not editing, don't show the
  // strip at all — it'd just be empty chrome.
  if (pages.length <= 1 && !isEditing) return null

  return (
    <div className="relative border-b bg-muted/30">
      <div
        className={cn(
          'pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-muted/80 to-transparent transition-opacity',
          overflow.left ? 'opacity-100' : 'opacity-0'
        )}
      />
      <div
        className={cn(
          'pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-muted/80 to-transparent transition-opacity',
          overflow.right ? 'opacity-100' : 'opacity-0'
        )}
      />
      <div
        ref={scrollRef}
        className="flex items-center gap-1.5 px-6 py-2 overflow-x-auto"
      >
        {pages.map((p, idx) => {
          const tpl = getCachedTemplate(pageTemplateMap, p)
          const fallback = tpl?.name ?? `페이지 ${idx + 1}`
          const label = p.name?.trim() ? p.name : fallback
          const isActive = viewMode === 'paginated' && idx === currentPage

          return (
            <div
              key={idx}
              className="shrink-0 group relative"
              ref={isActive ? activeChipRef : undefined}
            >
              <button
                type="button"
                onClick={() => onSelect(idx)}
                className={cn(
                  'flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors',
                  isActive
                    ? 'border-primary bg-primary/10 text-primary font-medium'
                    : 'border-border bg-background hover:bg-muted'
                )}
              >
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {idx + 1}
                </span>
                <span
                  className={cn(
                    'max-w-[160px] truncate',
                    !p.name?.trim() && 'italic text-muted-foreground'
                  )}
                >
                  {label}
                </span>
              </button>
              {/* Delete button — only in edit mode and when there's more
                  than one page. Absolute-positioned so it doesn't reserve
                  width between chips when not hovered. */}
              {isEditing && pages.length > 1 && (
                <button
                  type="button"
                  onClick={() => onRemove(idx)}
                  className="absolute -top-1.5 -right-1.5 hidden group-hover:flex h-4 w-4 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm hover:text-destructive hover:border-destructive"
                  title="이 페이지 삭제"
                  aria-label={`페이지 ${idx + 1} 삭제`}
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              )}
            </div>
          )
        })}
        {isEditing && (
          <button
            type="button"
            onClick={onAdd}
            className="shrink-0 inline-flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Plus className="h-3 w-3" />
            페이지 추가
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * Pill-shaped pager pinned to the bottom-right of the content column —
 * always reachable regardless of how far the user scrolls. Sits inside
 * the column's `relative` container so it doesn't overlap the AI dock
 * on wide screens. The keyboard shortcuts (←/→ and PgUp/PgDn) do the
 * same thing without taking the mouse off the editor.
 */
function FloatingPager({ current, total, onChange }) {
  const prev = () => onChange(clamp(current - 1, 0, total - 1))
  const next = () => onChange(clamp(current + 1, 0, total - 1))
  return (
    <div
      className="absolute bottom-4 right-4 z-20 flex items-center gap-0.5 rounded-full border bg-background/95 backdrop-blur shadow-lg px-1 py-0.5"
      role="navigation"
      aria-label="페이지 이동"
    >
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 rounded-full"
        onClick={prev}
        disabled={current === 0}
        aria-label="이전 페이지 (←)"
        title="이전 페이지 (←)"
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <span className="text-xs text-muted-foreground tabular-nums px-2 select-none">
        {current + 1} / {total}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 rounded-full"
        onClick={next}
        disabled={current === total - 1}
        aria-label="다음 페이지 (→)"
        title="다음 페이지 (→)"
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Per-page editor                                                             //
// --------------------------------------------------------------------------- //

/**
 * Renders one page's blocks inside a resizable grid. Pages share the same
 * GRID_COLS / ROW_HEIGHT so dragging a block to "8 cols" looks identical
 * across pages and across edit/view modes.
 */
function PageSection({
  pageIdx,
  page,
  template,
  isEditing,
  activeBlock,
  onActivate,
  onChangeContent,
  onChangePropsOverride,
  onLayoutChange,
  onToggleAutoFit,
  onMeasureContentHeight,
  contentHeights,
  onRename,
  showPageHeader,
}) {
  const blocks = useMemo(() => extractBlocks(template?.schema), [template])

  // Edit-GUI heights live here (mode-local — only consulted when editing).
  // The visible Editor in edit mode often needs more room than the read-only
  // render (inputs, focus rings, placeholder space). We size the grid cell
  // to the larger of the two so users can always interact, but the saved
  // row_span (computed in the parent's handleLayoutChange) only uses the
  // content-render height so view mode stays gap-free.
  const [editHeights, setEditHeights] = useState({})
  const handleMeasureEdit = useCallback((blockId, px) => {
    setEditHeights((prev) =>
      prev[blockId] === px ? prev : { ...prev, [blockId]: px }
    )
  }, [])
  // Drop stale measurements when blocks are removed.
  useEffect(() => {
    const ids = new Set(blocks.map((b) => b.id))
    setEditHeights((prev) => {
      const next = {}
      let changed = false
      for (const [k, v] of Object.entries(prev)) {
        if (ids.has(k)) next[k] = v
        else changed = true
      }
      return changed ? next : prev
    })
  }, [blocks])

  const effectiveLayouts = useMemo(() => {
    const overrides = page?.layout_overrides ?? {}
    const out = {}
    for (const b of blocks) {
      let layout = overrides[b.id] ?? b.layout ?? null
      // auto_fit defaults to true. Only an explicit `false` opts out — that
      // way existing template/report data automatically gains the behavior
      // without a backfill.
      const isAutoFit = layout?.auto_fit !== false
      if (isAutoFit) {
        const contentPx = contentHeights?.[b.id]
        const editPx = editHeights[b.id]
        // Edit mode: max(edit GUI, content) so the editor never gets clipped.
        // View mode: content only — view should match the saved size exactly.
        const px = isEditing
          ? Math.max(editPx ?? 0, contentPx ?? 0)
          : contentPx ?? null
        if (px != null && px > 0) {
          const rows = Math.max(
            1,
            Math.ceil((px + REPORT_ROW_GAP) / (REPORT_ROW_HEIGHT + REPORT_ROW_GAP))
          )
          if (rows !== layout?.row_span) {
            layout = { ...(layout ?? {}), row_span: rows }
          }
        } else {
          // No measurement yet. Stored row_span values predate the fine
          // grid (rowHeight 60 → 8), so a row_span of 2 would render as
          // ~20px — too small to even fit the drag handle. Bump to a
          // sensible placeholder until the first measurement lands; the
          // ResizeObserver then snaps it to the true content height.
          const stored = layout?.row_span ?? 0
          if (stored < AUTO_FIT_INITIAL_ROWS) {
            layout = { ...(layout ?? {}), row_span: AUTO_FIT_INITIAL_ROWS }
          }
        }
      }
      out[b.id] = layout
    }
    return out
  }, [blocks, page?.layout_overrides, contentHeights, editHeights, isEditing])

  const rglItems = useMemo(
    () => buildRglItems(blocks, effectiveLayouts),
    [blocks, effectiveLayouts]
  )

  return (
    <section id={`report-page-${pageIdx}`} className="space-y-3">
      {showPageHeader && (
        <div className="flex items-center gap-2 border-b pb-2">
          <Badge variant="outline" className="text-[10px] shrink-0">
            페이지 {pageIdx + 1}
          </Badge>
          {isEditing ? (
            <Input
              value={page?.name ?? ''}
              onChange={(e) => onRename?.(e.target.value)}
              placeholder={template?.name ?? '페이지 이름'}
              className="h-7 max-w-md border-0 bg-transparent px-1 text-sm font-medium focus-visible:ring-1 focus-visible:ring-primary placeholder:italic placeholder:text-muted-foreground"
            />
          ) : (
            <span
              className={cn(
                'text-sm font-medium truncate',
                !page?.name?.trim() && 'italic text-muted-foreground'
              )}
            >
              {page?.name?.trim() ? page.name : template?.name ?? '...'}
            </span>
          )}
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            {template?.name ? `${template.name} ` : ''}v{page?.template_version}
          </span>
        </div>
      )}
      {!template ? (
        <Skeleton className="h-32" />
      ) : blocks.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            템플릿에 블록이 없습니다.
          </CardContent>
        </Card>
      ) : (
        <ResizableGrid
          items={rglItems}
          onLayoutChange={isEditing ? onLayoutChange : undefined}
          isStatic={!isEditing}
        >
          {blocks.map((block) => {
            const isActive =
              activeBlock?.pageIdx === pageIdx && activeBlock?.blockId === block.id
            const autoFit = effectiveLayouts[block.id]?.auto_fit !== false
            return (
              <div key={block.id} className="min-w-0 h-full">
                <BlockEditorCard
                  block={block}
                  content={page?.content?.[block.id]}
                  propsOverride={page?.props_overrides?.[block.id] ?? null}
                  active={isActive}
                  readOnly={!isEditing}
                  showDragHandle={isEditing}
                  autoFit={autoFit}
                  onActivate={() => onActivate(block.id)}
                  onChange={(value) => onChangeContent(block.id, value)}
                  onChangePropsOverride={(patch) =>
                    onChangePropsOverride?.(block.id, patch)
                  }
                  onToggleAutoFit={
                    isEditing
                      ? (enabled) => onToggleAutoFit?.(block.id, enabled)
                      : undefined
                  }
                  onMeasureContentHeight={(px) =>
                    onMeasureContentHeight?.(block.id, px)
                  }
                  onMeasureEditHeight={(px) => handleMeasureEdit(block.id, px)}
                />
              </div>
            )
          })}
        </ResizableGrid>
      )}
    </section>
  )
}

// --------------------------------------------------------------------------- //
// Helpers                                                                     //
// --------------------------------------------------------------------------- //

/**
 * Returns a Map keyed by `${template_id}@${version}` → fetched template.
 * Fetches each unique template referenced by the report's pages exactly
 * once and caches the result for the lifetime of the component.
 */
function usePageTemplates(pages, slug) {
  const [cache, setCache] = useState(() => new Map())

  // The set of keys we still need to fetch this render.
  const missingKeys = useMemo(() => {
    if (!pages || !slug) return []
    const seen = new Set()
    const out = []
    for (const p of pages) {
      const key = `${p.template_id}@${p.template_version}`
      if (seen.has(key)) continue
      seen.add(key)
      if (!cache.has(key)) out.push({ key, template_id: p.template_id, version: p.template_version })
    }
    return out
  }, [pages, slug, cache])

  useEffect(() => {
    if (missingKeys.length === 0) return
    let cancelled = false
    Promise.all(
      missingKeys.map(({ key, template_id, version }) =>
        getTemplateVersion(template_id, version).then(
          (tpl) => [key, tpl],
          () => [key, null] // tolerate fetch failures — page just shows skeleton
        )
      )
    ).then((pairs) => {
      if (cancelled) return
      setCache((prev) => {
        const next = new Map(prev)
        for (const [key, tpl] of pairs) {
          if (tpl) next.set(key, tpl)
        }
        return next
      })
    })
    return () => {
      cancelled = true
    }
  }, [missingKeys])

  return cache
}

function getCachedTemplate(map, page) {
  if (!page) return null
  return map.get(`${page.template_id}@${page.template_version}`) ?? null
}

function normalizePage(p) {
  return {
    template_id: p.template_id,
    template_version: p.template_version,
    name: p.name ?? null,
    content: p.content ?? {},
    layout_overrides: p.layout_overrides ?? null,
    props_overrides: p.props_overrides ?? null,
  }
}

/**
 * Reads blocks from a widget-v1 template schema. Each block becomes a
 * navigable card in the report editor.
 */
function extractBlocks(schema) {
  const blocks = Array.isArray(schema?.blocks) ? schema.blocks : []
  return blocks.map((b) => ({
    id: b.id,
    title: b.props?.label || b.props?.default_text || b.id,
    type: b.type,
    props: b.props ?? {},
    layout: b.layout,
  }))
}

/**
 * For a brand-new page, copy any per-widget defaults into `content` so
 * the user opens the editor with placeholders pre-populated.
 */
function seedContentFromTemplate(template) {
  const out = {}
  for (const block of template?.schema?.blocks ?? []) {
    if (block.type === 'heading' && block.props?.default_text) {
      out[block.id] = { text: block.props.default_text }
    }
  }
  return out
}

// Widget types whose props_schema accepts text_style (and optionally
// depth_styles) AND whose report-side editing benefits from a block-level
// style override. RichText is intentionally excluded — its TipTap-based
// editor provides inline B/I/U/size/color via a BubbleMenu on selection,
// so a separate accordion would just be a second, redundant control.
const WIDGETS_WITH_REPORT_STYLE = new Set()

function BlockEditorCard({
  block,
  content,
  propsOverride,
  active,
  readOnly,
  showDragHandle,
  autoFit,
  onActivate,
  onChange,
  onChangePropsOverride,
  onToggleAutoFit,
  onMeasureContentHeight,
  onMeasureEditHeight,
}) {
  const renderer = getRenderer(block.type)
  // Per-report override fully replaces the matching style key. The
  // backend's _sanitize_props_overrides whitelist guarantees only
  // visual-style keys reach this merge, so structural props like
  // `items` / `min_length` always come from the template.
  const effectiveProps = mergePropsWithOverride(block.props, propsOverride)

  // Two measurement targets for auto-fit:
  //   measureRef → hidden read-only mirror; drives the persisted row_span
  //                so view mode shows no gap and no scrollbar.
  //   contentRef → visible editor; drives the cell height *during edit*
  //                only, so input affordances (TipTap caret, table inputs,
  //                focus rings) don't get clipped or covered by neighbors.
  const measureRef = useRef(null)
  const contentRef = useRef(null)
  // Card chrome that adds to the measured `scrollHeight` to produce the
  // final cell height. In edit mode (`showDragHandle` true), the top
  // padding is bumped from pt-4 → pt-9 so the widget's own caption /
  // label has breathing room below the drag-handle bar. In view mode
  // there is no handle, so the standard pt-4 / pb-4 paddings apply.
  // Heading has no Card wrapper at all — it only needs room for the
  // handle when shown.
  const chromeExtraPx = (() => {
    if (block.type === 'heading') return showDragHandle ? 28 : 0
    const topPx = showDragHandle ? 36 : 16 // pt-9 vs pt-4
    const bottomPx = 16 // pb-4
    return topPx + bottomPx
  })()
  useEffect(() => {
    if (!autoFit || !onMeasureContentHeight) return
    const el = measureRef.current
    if (!el) return
    let raf = 0
    const measure = () => {
      raf = 0
      const h = el.scrollHeight
      if (h > 0) onMeasureContentHeight(h + chromeExtraPx)
    }
    const schedule = () => {
      if (raf) return
      raf = requestAnimationFrame(measure)
    }
    schedule()
    const ro = new ResizeObserver(schedule)
    ro.observe(el)
    const mo = new MutationObserver(schedule)
    mo.observe(el, { childList: true, subtree: true, characterData: true })
    return () => {
      if (raf) cancelAnimationFrame(raf)
      ro.disconnect()
      mo.disconnect()
    }
  }, [autoFit, onMeasureContentHeight, content, effectiveProps, chromeExtraPx])
  useEffect(() => {
    // Edit-mode measurement only — view mode's visible editor *is* the
    // read-only render, so the mirror's measurement already covers it.
    if (!autoFit || readOnly || !onMeasureEditHeight) return
    const el = contentRef.current
    if (!el) return
    let raf = 0
    const measure = () => {
      raf = 0
      const h = el.scrollHeight
      if (h > 0) onMeasureEditHeight(h + chromeExtraPx)
    }
    const schedule = () => {
      if (raf) return
      raf = requestAnimationFrame(measure)
    }
    schedule()
    const ro = new ResizeObserver(schedule)
    ro.observe(el)
    const mo = new MutationObserver(schedule)
    mo.observe(el, { childList: true, subtree: true, characterData: true })
    return () => {
      if (raf) cancelAnimationFrame(raf)
      ro.disconnect()
      mo.disconnect()
    }
  }, [autoFit, readOnly, onMeasureEditHeight, content, effectiveProps, chromeExtraPx])

  if (!renderer) {
    return (
      <Card className="h-full">
        <CardContent className="pt-6 text-sm text-destructive">
          미지의 위젯 타입: <span className="font-mono">{block.type}</span>
        </CardContent>
      </Card>
    )
  }

  const dragHandle = showDragHandle ? (
    <div className="block-drag-handle absolute inset-x-0 top-0 z-10 cursor-move px-2 py-0.5 bg-muted/60 backdrop-blur-sm border-b flex items-center gap-2 rounded-t-md">
      <GripVertical className="h-3 w-3 text-muted-foreground" />
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {block.type}
      </span>
      {onToggleAutoFit && (
        <label
          className={cn(
            'ml-auto flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-[10px] font-medium select-none',
            autoFit
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:text-foreground'
          )}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          title="콘텐츠 크기에 맞춰 자동으로 높이 조절"
        >
          <input
            type="checkbox"
            className="h-3 w-3 accent-primary"
            checked={!!autoFit}
            onChange={(e) => onToggleAutoFit(e.target.checked)}
          />
          <Maximize2 className="h-3 w-3" />
          자동 맞춤
        </label>
      )}
    </div>
  ) : null

  if (block.type === 'heading') {
    const { Editor: HE } = renderer
    return (
      <div
        id={`block-${block.id}`}
        onClick={onActivate}
        className={cn(
          'relative h-full flex items-center',
          // Reserve space below the absolute drag-handle bar so the heading
          // text isn't hidden behind it in edit mode.
          showDragHandle && 'pt-7',
          active && !readOnly && 'ring-2 ring-primary/30 rounded-md'
        )}
      >
        {dragHandle}
        <div className="relative w-full min-w-0">
          {autoFit && (
            // Heading has no Card / padding chrome, so the mirror just
            // spans the same width as the visible heading editor.
            <div
              ref={measureRef}
              aria-hidden="true"
              className="invisible pointer-events-none absolute left-0 right-0 top-0"
            >
              <HE props={effectiveProps} content={content} onChange={NO_OP} readOnly={true} />
            </div>
          )}
          <div ref={contentRef}>
            <HE props={effectiveProps} content={content} onChange={onChange} readOnly={readOnly} />
          </div>
        </div>
      </div>
    )
  }

  const { Editor } = renderer
  const showStylePanel = !readOnly && WIDGETS_WITH_REPORT_STYLE.has(block.type)

  // When auto-fit is on, the cell height tracks content exactly, so neither
  // a scrollbar nor an empty gap should appear. We drop the inner
  // `overflow-auto` + `flex-1 min-h-0` clamp; the card grows / shrinks with
  // the measured row_span via the grid layout.
  return (
    <Card
      id={`block-${block.id}`}
      onClick={onActivate}
      className={cn(
        'relative h-full flex flex-col',
        autoFit ? 'overflow-visible' : 'overflow-hidden',
        active && !readOnly && 'ring-2 ring-primary/30'
      )}
    >
      {dragHandle}
      <CardContent
        className={cn(
          'relative pb-4',
          showDragHandle ? 'pt-9' : 'pt-4',
          autoFit ? 'overflow-visible' : 'flex-1 min-h-0 overflow-auto'
        )}
      >
        {autoFit && Editor && (
          // The mirror's outer box spans CardContent's padding-box (left:0,
          // right:0 inside a relative parent), so it needs the same px-6
          // horizontal padding as CardContent to land the inner Editor on
          // exactly the same width as the visible copy — otherwise text
          // wrapping diverges and the measured height is wrong.
          <div
            ref={measureRef}
            aria-hidden="true"
            className="invisible pointer-events-none absolute left-0 right-0 top-0 pl-6 pr-6"
          >
            <Editor
              props={effectiveProps}
              content={content}
              onChange={NO_OP}
              readOnly={true}
            />
          </div>
        )}
        <div ref={contentRef}>
          {Editor ? (
            <Editor
              props={effectiveProps}
              content={content}
              onChange={onChange}
              readOnly={readOnly}
            />
          ) : (
            <p className="text-xs text-muted-foreground italic">
              이 위젯은 보고서에서 입력하지 않습니다.
            </p>
          )}
          {showStylePanel && (
            <ReportBlockStylePanel
              type={block.type}
              effectiveProps={effectiveProps}
              onChange={onChangePropsOverride}
            />
          )}
        </div>
      </CardContent>
    </Card>
  )
}

// Mirror copies render in read-only mode where their `onChange` should
// never fire. A shared no-op keeps the prop identity stable across
// renders so child editors don't re-bind handlers.
const NO_OP = () => {}

function mergePropsWithOverride(baseProps, override) {
  if (!override) return baseProps ?? {}
  return { ...(baseProps ?? {}), ...override }
}

/**
 * Collapsible style panel rendered inside a report's BlockEditorCard.
 * The fields show the *effective* (template + override) value so the
 * writer sees what they're editing; changes are saved to the report's
 * `props_overrides`, fully replacing that style key for this block.
 *
 * The template itself is never touched — opening the same template in
 * the designer still shows the original style.
 */
function ReportBlockStylePanel({ type, effectiveProps, onChange }) {
  return (
    <details
      className="mt-3 rounded-md border bg-muted/20 px-3 py-2"
      onClick={(e) => e.stopPropagation()}
    >
      <summary className="cursor-pointer text-xs font-medium select-none text-muted-foreground hover:text-foreground">
        이 보고서에서만 스타일 조정
      </summary>
      <div className="mt-2 space-y-3">
        <TextStyleField
          value={effectiveProps.text_style}
          onChange={(text_style) => onChange?.({ text_style })}
        />
        {type === 'rich_text' && (
          <DepthStyleField
            value={effectiveProps.depth_styles}
            onChange={(depth_styles) => onChange?.({ depth_styles })}
          />
        )}
        <p className="text-[10px] text-muted-foreground">
          이 스타일은 이 보고서에만 저장됩니다. 템플릿이나 다른 보고서는 영향을
          받지 않습니다. 모든 항목을 “기본”으로 두면 템플릿의 스타일로 되돌아갑니다.
        </p>
      </div>
    </details>
  )
}

// --------------------------------------------------------------------------- //
// Layout helpers — drive the edit-mode react-grid-layout                      //
// --------------------------------------------------------------------------- //

const REPORT_GRID_COLS = 12
// Fine vertical granularity so auto-fit can land cells within a few pixels
// of the natural content height. The horizontal gap stays wider so side-by-
// side cells still have a normal visual separation.
const REPORT_ROW_HEIGHT = 8
const REPORT_ROW_GAP = 4
const REPORT_COL_GAP = 12
// Placeholder row_span used by buildRglItems when a block has no layout at
// all, and by effectiveLayouts before the first content measurement lands.
// 12 fine rows ≈ 92px — enough for a Card with the drag handle and a line
// of content; small enough that auto-fit shrinks visibly on most widgets.
const AUTO_FIT_INITIAL_ROWS = 12

function buildRglItems(blocks, effectiveLayouts) {
  const byRow = new Map()
  for (const b of blocks) {
    const layout = effectiveLayouts[b.id] ?? { row: 99, col_span: REPORT_GRID_COLS, row_span: AUTO_FIT_INITIAL_ROWS }
    if (!byRow.has(layout.row)) byRow.set(layout.row, [])
    byRow.get(layout.row).push(b)
  }
  const items = []
  for (const b of blocks) {
    const layout = effectiveLayouts[b.id] ?? { row: 99, col_span: REPORT_GRID_COLS, row_span: AUTO_FIT_INITIAL_ROWS }
    const sameRow = byRow.get(layout.row) ?? []
    let x = 0
    for (const sib of sameRow) {
      if (sib.id === b.id) break
      const sibLayout = effectiveLayouts[sib.id] ?? { col_span: REPORT_GRID_COLS }
      x += clamp(sibLayout.col_span ?? REPORT_GRID_COLS, 1, REPORT_GRID_COLS)
    }
    const item = {
      i: b.id,
      x: Math.min(x, REPORT_GRID_COLS - 1),
      y: layout.row - 1,
      w: clamp(layout.col_span ?? REPORT_GRID_COLS, 1, REPORT_GRID_COLS),
      h: Math.max(1, layout.row_span ?? 2),
      minW: 1,
      maxW: REPORT_GRID_COLS,
      minH: 1,
    }
    // Auto-fit blocks: hide the vertical / corner resize handles since height
    // is content-driven. Only the right edge ('e') remains so users can still
    // adjust column-span. Default ON — only explicit `auto_fit: false` opts out.
    if (layout?.auto_fit !== false) {
      item.resizeHandles = ['e']
    }
    items.push(item)
  }
  return compactVerticalLayout(items)
}

function compactVerticalLayout(rawItems) {
  const sortedIndices = rawItems.map((_, idx) => idx)
  sortedIndices.sort((a, b) => {
    const dy = rawItems[a].y - rawItems[b].y
    if (dy !== 0) return dy
    return rawItems[a].x - rawItems[b].x
  })
  const out = new Array(rawItems.length)
  const placedSoFar = []
  for (const idx of sortedIndices) {
    const item = rawItems[idx]
    let y = 0
    while (collidesWithAny(item, y, placedSoFar)) y += 1
    const compacted = { ...item, y }
    out[idx] = compacted
    placedSoFar.push(compacted)
  }
  return out
}

function collidesWithAny(item, candidateY, others) {
  for (const o of others) {
    if (
      item.x < o.x + o.w &&
      item.x + item.w > o.x &&
      candidateY < o.y + o.h &&
      candidateY + item.h > o.y
    ) {
      return true
    }
  }
  return false
}

function ResizableGrid({ items, onLayoutChange, children, isStatic = false }) {
  const { containerRef, width, mounted } = useContainerWidth({ measureBeforeMount: true })
  const finalItems = isStatic ? items.map((it) => ({ ...it, static: true })) : items
  return (
    <div ref={containerRef} className="w-full">
      {mounted && width > 0 && (
        <GridLayout
          key={isStatic ? 'static' : 'editable'}
          className="layout"
          layout={finalItems}
          width={width}
          gridConfig={{
            cols: REPORT_GRID_COLS,
            rowHeight: REPORT_ROW_HEIGHT,
            margin: [REPORT_COL_GAP, REPORT_ROW_GAP],
          }}
          dragConfig={{
            enabled: !isStatic,
            handle: '.block-drag-handle',
          }}
          resizeConfig={{
            enabled: !isStatic,
          }}
          onLayoutChange={onLayoutChange}
        >
          {children}
        </GridLayout>
      )}
    </div>
  )
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n))
}

function sameOverrides(a, b) {
  const aKeys = a ? Object.keys(a) : []
  const bKeys = b ? Object.keys(b) : []
  if (aKeys.length !== bKeys.length) return false
  for (const k of aKeys) {
    if (!b || !b[k]) return false
    const x = a[k]
    const y = b[k]
    if (x.row !== y.row || x.col_span !== y.col_span || x.row_span !== y.row_span) return false
    // auto_fit defaults to true when absent; treat absent / true as equal,
    // but persisted `false` must compare strictly so toggles register.
    const xFit = x.auto_fit === false ? false : true
    const yFit = y.auto_fit === false ? false : true
    if (xFit !== yFit) return false
  }
  return true
}
