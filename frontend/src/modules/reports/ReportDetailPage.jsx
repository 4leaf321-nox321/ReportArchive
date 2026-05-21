import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom'
import {
  ArrowLeft,
  Bookmark,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ClipboardPaste,
  Copy,
  Download,
  FileBox,
  FileCode,
  FileText,
  FileType2,
  GripVertical,
  HardDrive,
  Layers,
  Maximize2,
  Pencil,
  Plus,
  Rows,
  Save,
  Settings2,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import GridLayout, { useContainerWidth } from 'react-grid-layout'
import { PrintScaleContext } from './printContext'
import { Button } from '@/shared/components/ui/button'
import { Badge } from '@/shared/components/ui/badge'
import { Card, CardContent } from '@/shared/components/ui/card'
import { ScrollArea } from '@/shared/components/ui/scroll-area'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { Input } from '@/shared/components/ui/input'
import { Textarea } from '@/shared/components/ui/textarea'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/shared/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/components/ui/popover'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu'
import { ConfirmDialog } from '@/shared/components/ConfirmDialog'
import { ErrorState } from '@/shared/components/ErrorState'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import { useAuth } from '@/shared/auth/AuthContext'
import { useAsync } from '@/shared/hooks/useAsync'
import { usePersistedState } from '@/shared/hooks/usePersistedState'
import { useWidgetCatalog } from '@/shared/hooks/useWidgetCatalog'
import {
  getReport,
  createReport,
  updateReport,
  deleteReport,
  LockConflictError,
} from './api'
import { useReportLock } from './useReportLock'
import {
  DEFAULT_REPORT_WIDTH_PX,
  ReportSettingsDialog,
} from './ReportSettingsDialog'
import { getTemplateVersion, createTemplate } from '@/shared/api/templates'
import { listTemplateCategories } from '@/shared/api/templateCategories'
import { STATUSES, STATUS_LABEL, STATUS_VARIANT } from './constants'
import { getRenderer } from '@/modules/templates/widgets'
import { WidgetPicker } from '@/modules/templates/WidgetPicker'
import { DepthStyleField, TextStyleField } from '@/modules/templates/widgets/_shared'
import { TemplatePicker } from './TemplatePicker'
import { SectionPickerDialog } from './SectionPickerDialog'
import { useSectionTaxonomy } from '@/shared/hooks/useSectionTaxonomy'
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
  const location = useLocation()
  const { slug, all: workspaces } = useWorkspace()
  const { me } = useAuth()
  const currentUserId = me?.user?.id ?? null
  const isNew = Boolean(templateId)
  // When the previous page handed us `state.startEditing` (the "복사"
  // flow does this so the new copy lands directly in edit mode), we
  // honor it on first mount only.
  const startEditingFromState = Boolean(location.state?.startEditing)

  // 'paginated' = show one page at a time with prev/next controls
  // 'all'       = stack every page vertically (scroll through them)
  const [viewMode, setViewMode] = usePersistedState(
    'ra:report-view-mode:v1',
    'paginated'
  )
  const [confirmDelete, setConfirmDelete] = useState(false)
  // Right-click on the empty (block-less) area — or the floating
  // "보고서 설정" pill at the bottom-right — opens this tabbed dialog.
  // Currently only the 폭 설정 tab is wired; the tab structure is in
  // place so other report-level settings can land here without another
  // dialog round-trip. Persisted per-report via draft.page_width_px.
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false)
  // Coords of the empty-area right-click. When non-null we render a small
  // floating menu with the "보고서 폭 설정" item; clicking it opens the
  // dialog above. Closes on outside-click / Esc / item click.
  const [pageContextMenu, setPageContextMenu] = useState(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [copyOpen, setCopyOpen] = useState(false)
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false)
  const [aiPromptOpen, setAiPromptOpen] = useState(false)
  const [aiPromptV2Open, setAiPromptV2Open] = useState(false)
  // Takeover prompt — holds the LockConflictError.holder payload when
  // the user tried to acquire a lock that someone else holds. Driving
  // the dialog open state by the holder object (vs a separate bool) lets
  // the dialog read the latest info directly.
  const [takeoverPrompt, setTakeoverPrompt] = useState(null)
  const [pasteJsonOpen, setPasteJsonOpen] = useState(false)
  // PDF print dialog — lets the writer pick a font scale before the
  // browser print dialog opens. Persisted so a writer who prefers 90%
  // doesn't have to re-pick on every print this session.
  const [pdfDialogOpen, setPdfDialogOpen] = useState(false)
  const [pdfPrintScale, setPdfPrintScale] = usePersistedState(
    'ra:pdf-print-scale:v1',
    1,
  )
  const [isEditing, setIsEditing] = useState(isNew || startEditingFromState)
  // "Printing" doesn't actually leave edit mode (no lock release, no
  // unsaved-change loss); it just renders all blocks read-only and stacks
  // every page vertically so the browser's print engine sees the same
  // chrome-free, paginated layout regardless of where the user was. Used
  // by both PDF print-to-file and the Word export's html2canvas capture.
  const [printing, setPrinting] = useState(false)
  const effectiveIsEditing = isEditing && !printing
  const effectiveViewMode = printing ? 'all' : viewMode
  const [currentPage, setCurrentPage] = useState(0)
  // Widget catalog (label/description/props_schema per widget type) is
  // bundled into the AI prompt so the model knows what shapes it may emit.
  const { catalog: widgetCatalog } = useWidgetCatalog()
  // The admin-managed "단락 구분" taxonomy. Cached module-wide so opening
  // many reports in one session doesn't refetch; the admin page calls
  // `invalidateSectionTaxonomyCache()` after mutations.
  const { categories: sectionCategories, itemByCode: sectionItemByCode } =
    useSectionTaxonomy()

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

  // Pessimistic edit lock — inert for new reports (no id yet). Heartbeats
  // every 30s while held; auto-releases on unmount. If a heartbeat ever
  // fails (typically because someone forced a takeover), we exit edit
  // mode and reload to surface their changes.
  const lock = useReportLock(isNew ? null : reportId, {
    onLost: () => {
      toast.warning(
        '다른 사용자가 편집을 강제로 가져갔습니다. 보기 모드로 전환합니다.'
      )
      setIsEditing(false)
      if (!isNew) reloadReport()
    },
  })

  // Local working copy of the report. `pages` is the source of truth for
  // template binding + content + layout_overrides; the top-level fields
  // hold cross-page metadata.
  const [draft, setDraft] = useState(null)
  useEffect(() => {
    if (isNew && seedTemplate) {
      // The "+ 새 보고서" flow hands us a title via router state (set in
      // ReportNewPage's name dialog). Fall back to the legacy default so
      // direct-link entry into /reports/new/:templateId/:version (no router
      // state) still works.
      const seededTitle =
        typeof location.state?.initialTitle === 'string' &&
        location.state.initialTitle.trim()
          ? location.state.initialTitle.trim()
          : '새 보고서'
      // Inherit per-template defaults (currently just page_width_px).
      // Lives on the template's schema doc under `report_defaults` —
      // every template version carries its own copy, so new reports
      // bound to that version pick up the same starting point.
      const tplDefaults = seedTemplate?.schema?.report_defaults ?? null
      const seededWidth = Number.isFinite(tplDefaults?.page_width_px)
        ? tplDefaults.page_width_px
        : null
      setDraft({
        title: seededTitle,
        report_date: todayIsoDate(),
        status: 'draft',
        tags: [],
        page_width_px: seededWidth,
        pages: [
          {
            template_id: seedTemplate.template_id,
            template_version: seedTemplate.version,
            content: seedContentFromTemplate(seedTemplate),
            layout_overrides: null,
            props_overrides: null,
            extra_blocks: [],
            blocks_order: [],
            block_sections: {},
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
        // Optimistic-concurrency token. We send this back as
        // `expected_revision` on save; the server rejects with 409 if
        // someone else's save landed between our load and our save.
        revision: existingReport.revision ?? 1,
        // Per-report content width. null falls through to the narrow
        // default at render; the right-click "보고서 폭 설정" dialog
        // writes here when the user picks a custom value.
        page_width_px: existingReport.page_width_px ?? null,
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
        extra_blocks: [],
        blocks_order: [],
        block_sections: {},
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

  /** Append a new ad-hoc widget to a page. `widgetType` is the registry key
   *  (e.g. 'rich_text', 'table'); `defaultProps` comes from the catalog so
   *  the new block has a usable starting state. The generated id is unique
   *  within the page so layout overrides / content keys stay clean. */
  function addExtraBlock(pageIdx, widgetType, defaultProps = {}) {
    setDraft((d) => {
      if (!d) return d
      const page = d.pages[pageIdx]
      if (!page) return d
      const tpl = getCachedTemplate(pageTemplateMap, page)
      const existingIds = collectPageBlockIds(page, tpl)
      const id = freshExtraId(widgetType, existingIds)
      const newBlock = {
        id,
        type: widgetType,
        props: { ...defaultProps },
      }
      // When blocks_order is already materialized (user has removed or
      // reordered blocks at least once on this page), append the new
      // extra to it so it actually renders. If blocks_order is empty,
      // combinedBlocks falls back to "template then extras" and the new
      // entry shows up implicitly.
      const nextOrder = page.blocks_order?.length
        ? [...page.blocks_order, id]
        : page.blocks_order ?? []
      // Pre-tag a few widget types with their most-likely 단락 구분 so
      // the writer doesn't have to right-click → 단락 구분 every time.
      // The map only seeds the value at insertion — the user can still
      // change or clear it via the context menu afterward.
      const defaultSection = WIDGET_DEFAULT_SECTION_CODE[widgetType]
      const nextSections = defaultSection
        ? { ...(page.block_sections ?? {}), [id]: defaultSection }
        : page.block_sections
      const nextPages = d.pages.map((p, i) =>
        i === pageIdx
          ? {
              ...p,
              extra_blocks: [...(p.extra_blocks ?? []), newBlock],
              blocks_order: nextOrder,
              ...(defaultSection ? { block_sections: nextSections } : {}),
            }
          : p,
      )
      return { ...d, pages: nextPages }
    })
  }

  /** Insert a new ad-hoc widget relative to an existing block. `direction`
   *  is one of 'up' / 'down' / 'left' / 'right' (against the anchor block).
   *
   *    up / down  — full-width row insert; every block at/after the insert
   *                 row gets its `row` bumped by 1 via layout_overrides so
   *                 the grid stays consistent.
   *    left / right — splits the anchor's col_span in half; the new block
   *                 takes the other half on the same row. blocks_order
   *                 decides which side ends up on the left.
   *
   *  We materialize layout_overrides for both the anchor (when it was
   *  shrunk or its row changed) and the new block — extras don't have a
   *  template layout to fall back on, so without an override the new
   *  block would render at default size/position. */
  function addExtraBlockAt(pageIdx, widgetType, defaultProps, anchorId, direction) {
    setDraft((d) => {
      if (!d) return d
      const page = d.pages[pageIdx]
      if (!page) return d
      const tpl = getCachedTemplate(pageTemplateMap, page)
      const blocks = combinedBlocks(tpl, page)
      const anchor = blocks.find((b) => b.id === anchorId)
      if (!anchor) return d

      // Resolve the anchor's *current* layout (override beats template).
      // Fallbacks mirror what `effectiveLayouts` uses so the inserted
      // block lands where the user sees the anchor.
      const overrides = page?.layout_overrides ?? {}
      function resolvedLayout(block) {
        const ov = overrides[block.id]
        const base = ov ?? block.layout ?? null
        return base
          ? { row: base.row, col_span: base.col_span, row_span: base.row_span ?? 4 }
          : { row: 1, col_span: REPORT_GRID_COLS, row_span: AUTO_FIT_INITIAL_ROWS }
      }
      const anchorLayout = resolvedLayout(anchor)

      const existingIds = collectPageBlockIds(page, tpl)
      const id = freshExtraId(widgetType, existingIds)
      const newBlock = { id, type: widgetType, props: { ...defaultProps } }

      // Materialize the order so subsequent renders use ours.
      const baseOrder = page.blocks_order?.length
        ? [...page.blocks_order]
        : blocks.map((b) => b.id)
      const anchorIdx = baseOrder.indexOf(anchorId)
      // Defensive: anchor not in order (shouldn't happen, but if it
      // does, append at end and leave layout to defaults).
      if (anchorIdx < 0) {
        const nextPages = d.pages.map((p, i) =>
          i === pageIdx
            ? {
                ...p,
                extra_blocks: [...(p.extra_blocks ?? []), newBlock],
                blocks_order: [...baseOrder, id],
              }
            : p,
        )
        return { ...d, pages: nextPages }
      }

      const nextOverrides = { ...overrides }
      let nextOrder

      if (direction === 'up' || direction === 'down') {
        // Full-width insert on its own row. Bump every block at or after
        // the insert row by 1 so we don't collide with them.
        const insertRow = direction === 'up' ? anchorLayout.row : anchorLayout.row + 1
        for (const b of blocks) {
          const lay = resolvedLayout(b)
          if (lay.row >= insertRow) {
            nextOverrides[b.id] = { ...(nextOverrides[b.id] ?? lay), row: lay.row + 1 }
          }
        }
        nextOverrides[id] = {
          row: insertRow,
          col_span: REPORT_GRID_COLS,
          row_span: AUTO_FIT_INITIAL_ROWS,
        }
        // Place the new id in blocks_order near the anchor so visual + DOM
        // order stay coherent (the grid uses (row, x) for layout, but
        // blocks_order seeds initial positions when there's no override).
        nextOrder =
          direction === 'up'
            ? [...baseOrder.slice(0, anchorIdx), id, ...baseOrder.slice(anchorIdx)]
            : [...baseOrder.slice(0, anchorIdx + 1), id, ...baseOrder.slice(anchorIdx + 1)]
      } else {
        // Left/right — prefer to fill the row's remaining capacity over
        // shrinking the anchor. When the row isn't full yet, the new
        // block claims the leftover columns without disturbing any
        // existing block; only when the row is fully packed do we split
        // the anchor in two. Caller is expected to hide the arrow only
        // when neither option is available (row full AND col_span < 2).
        const rowUsed = blocks
          .filter((b) => resolvedLayout(b).row === anchorLayout.row)
          .reduce((sum, b) => sum + resolvedLayout(b).col_span, 0)
        const remaining = REPORT_GRID_COLS - rowUsed
        let newColSpan
        if (remaining > 0) {
          newColSpan = remaining
        } else {
          // Row is packed → split the anchor. Clamp so we never emit
          // a 0-span block.
          const cs = Math.max(2, anchorLayout.col_span)
          newColSpan = Math.max(1, Math.floor(cs / 2))
          nextOverrides[anchorId] = {
            ...(nextOverrides[anchorId] ?? anchorLayout),
            col_span: cs - newColSpan,
          }
        }
        nextOverrides[id] = {
          row: anchorLayout.row,
          col_span: newColSpan,
          row_span: anchorLayout.row_span,
        }
        nextOrder =
          direction === 'left'
            ? [...baseOrder.slice(0, anchorIdx), id, ...baseOrder.slice(anchorIdx)]
            : [...baseOrder.slice(0, anchorIdx + 1), id, ...baseOrder.slice(anchorIdx + 1)]
      }

      // Seed the section tag if the widget type has a default — same
      // behavior as addExtraBlock so writers get a useful starting chip.
      const defaultSection = WIDGET_DEFAULT_SECTION_CODE[widgetType]
      const nextSections = defaultSection
        ? { ...(page.block_sections ?? {}), [id]: defaultSection }
        : page.block_sections

      const nextPages = d.pages.map((p, i) =>
        i === pageIdx
          ? {
              ...p,
              extra_blocks: [...(p.extra_blocks ?? []), newBlock],
              blocks_order: nextOrder,
              layout_overrides: nextOverrides,
              ...(defaultSection ? { block_sections: nextSections } : {}),
            }
          : p,
      )
      return { ...d, pages: nextPages }
    })
  }

  /** Replace the entire props object for an extra block. PropsPanel hands
   *  back a complete props object (e.g. `{ ...prev, items: [...] }`), so we
   *  just assign — no merge — to keep behavior consistent with the
   *  template editor's data flow. */
  function setExtraBlockProps(pageIdx, blockId, newProps) {
    setDraft((d) => {
      if (!d) return d
      const nextPages = d.pages.map((p, i) => {
        if (i !== pageIdx) return p
        const nextExtras = (p.extra_blocks ?? []).map((b) =>
          b.id === blockId ? { ...b, props: newProps } : b,
        )
        return { ...p, extra_blocks: nextExtras }
      })
      return { ...d, pages: nextPages }
    })
  }

  /** Removes a block from a page regardless of whether it came from the
   *  template or from extras. For extras, the block definition itself
   *  disappears; for template blocks, the page just stops listing the
   *  id in blocks_order so the template stays untouched.
   *  Either way, content / layout / props overrides scoped to that id
   *  get cleaned out so the saved page stays tight. */
  function removeBlockFromPage(pageIdx, blockId) {
    setDraft((d) => {
      if (!d) return d
      const page = d.pages[pageIdx]
      if (!page) return d
      const tpl = getCachedTemplate(pageTemplateMap, page)
      const allBlocks = combinedBlocks(tpl, page)
      // Materialize the implicit order into blocks_order on the first
      // edit so subsequent removes / reorders compose cleanly.
      const order = page.blocks_order?.length
        ? page.blocks_order
        : allBlocks.map((b) => b.id)
      const nextOrder = order.filter((id) => id !== blockId)
      const nextExtras = (page.extra_blocks ?? []).filter((b) => b.id !== blockId)
      const nextContent = { ...(page.content ?? {}) }
      delete nextContent[blockId]
      const nextLayout = { ...(page.layout_overrides ?? {}) }
      delete nextLayout[blockId]
      const nextPropsOverrides = { ...(page.props_overrides ?? {}) }
      delete nextPropsOverrides[blockId]
      const nextSections = { ...(page.block_sections ?? {}) }
      delete nextSections[blockId]
      const nextPages = d.pages.map((p, i) =>
        i !== pageIdx ? p : {
          ...p,
          blocks_order: nextOrder,
          extra_blocks: nextExtras,
          content: nextContent,
          layout_overrides: Object.keys(nextLayout).length ? nextLayout : null,
          props_overrides: Object.keys(nextPropsOverrides).length ? nextPropsOverrides : null,
          block_sections: nextSections,
        },
      )
      return { ...d, pages: nextPages }
    })
  }

  /** Reorder a block within a page by absolute index. Materializes
   *  blocks_order on first call (same trick as removal). */
  function reorderBlock(pageIdx, blockId, newIndex) {
    setDraft((d) => {
      if (!d) return d
      const page = d.pages[pageIdx]
      if (!page) return d
      const tpl = getCachedTemplate(pageTemplateMap, page)
      const allBlocks = combinedBlocks(tpl, page)
      const baseOrder = page.blocks_order?.length
        ? page.blocks_order
        : allBlocks.map((b) => b.id)
      const without = baseOrder.filter((id) => id !== blockId)
      const clamped = Math.max(0, Math.min(newIndex, without.length))
      const nextOrder = [...without.slice(0, clamped), blockId, ...without.slice(clamped)]
      const nextPages = d.pages.map((p, i) =>
        i !== pageIdx ? p : { ...p, blocks_order: nextOrder },
      )
      return { ...d, pages: nextPages }
    })
  }

  /** Tag a block with a "단락 구분" item code (or clear it when `code` is
   *  null). The taxonomy itself is admin-managed (section_categories /
   *  section_items tables); the backend just round-trips the saved code
   *  as opaque metadata so deletes don't cascade to existing reports. */
  function setBlockSection(pageIdx, blockId, code) {
    setDraft((d) => {
      if (!d) return d
      const nextPages = d.pages.map((p, i) => {
        if (i !== pageIdx) return p
        const next = { ...(p.block_sections ?? {}) }
        // Three-state value:
        //   string  → explicit pick.
        //   null    → explicit "no section" (overrides the template's
        //             per-block default).
        //   absent  → use the template default (block.section) at render.
        // The picker's "지우기" sends `null`, so the override sticks even
        // when the template defined a default.
        next[blockId] = code ?? null
        return { ...p, block_sections: next }
      })
      return { ...d, pages: nextPages }
    })
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
    const blocks = combinedBlocks(tpl, page)
    const curOverrides = page?.layout_overrides ?? {}
    const pageContentHeights = contentHeightsByPage[pageIdx] ?? {}

    // Group blocks by visual row (RGL y), then assign sequential row
    // numbers. Within a single y-group, split into multiple logical
    // rows when col_span sum would exceed GRID_COLS (12) — the
    // backend's validator rejects rows whose col_span totals more
    // than the grid, and RGL can transiently land items in the same
    // y while the user is dragging.
    const byY = new Map()
    for (const it of rglLayout) {
      if (!byY.has(it.y)) byY.set(it.y, [])
      byY.get(it.y).push(it)
    }
    const blockToRow = new Map()
    let rowCounter = 0
    for (const y of [...byY.keys()].sort((a, b) => a - b)) {
      const group = byY.get(y).sort((a, b) => (a.x ?? 0) - (b.x ?? 0))
      let curRow = ++rowCounter
      let colSum = 0
      for (const it of group) {
        const cs = clamp(it.w ?? 12, 1, 12)
        if (colSum + cs > 12) {
          curRow = ++rowCounter
          colSum = 0
        }
        blockToRow.set(it.i, curRow)
        colSum += cs
      }
    }
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
        row: blockToRow.get(it.i) ?? 1,
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
      const blocks = combinedBlocks(tpl, page)
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
      // Safety net: layout_overrides occasionally land with multiple
      // blocks in the same row whose col_span sums exceed 12 (e.g. a
      // template was edited to add a new block but RGL hadn't yet been
      // notified). The backend strictly rejects that, so we normalize
      // here right before the request goes out.
      const normalizedPages = draft.pages.map((p) => ({
        ...p,
        layout_overrides: normalizeLayoutOverrides(p.layout_overrides),
      }))
      const payload = {
        title: draft.title,
        report_date: draft.report_date || null,
        status: draft.status,
        tags: draft.tags ?? [],
        pages: normalizedPages,
        // null clears the per-report override and falls back to the
        // frontend's narrow default at render time.
        page_width_px: Number.isFinite(draft.page_width_px) ? draft.page_width_px : null,
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
        // Echo the revision we loaded so the server can detect a stale
        // save (covers the brief window where a forced takeover doesn't
        // yet show up in our heartbeat).
        await updateReport(draft.id, {
          ...payload,
          expected_revision: draft.revision,
        })
        toast.success('저장되었습니다.')
        await lock.release()
        reloadReport()
        setIsEditing(false)
      }
    } catch (err) {
      // Lock / revision conflicts: keep the editor open with the user's
      // changes intact so they can copy the diff manually before
      // reloading. Generic failures fall through to the same toast.
      if (err instanceof LockConflictError) {
        if (err.code === 'revision_mismatch') {
          toast.error(
            '다른 사용자가 먼저 저장했습니다. 변경사항을 보존하려면 복사 후 새로고침하세요.'
          )
        } else if (err.code === 'lock_not_held') {
          toast.error(
            '편집 권한이 없습니다 (인계되었거나 만료됨). 변경사항을 복사 후 새로고침하세요.'
          )
        } else {
          toast.error(err.message || '저장 실패')
        }
        return
      }
      toast.error(err.message || '저장 실패')
    }
  }

  function onCancelEdit() {
    if (isNew) {
      navigate(`/w/${slug}/reports`)
      return
    }
    // Drop the lock immediately so another user doesn't wait for the TTL.
    // Fire-and-forget — the hook also releases on unmount and best-effort
    // on tab close.
    lock.release().catch(() => {})
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

  /** Acquire the edit lock and flip into edit mode. On 409
   *  lock_held_by_other, surface a takeover dialog with the holder info;
   *  the user can then either back out or force the lock. New reports
   *  skip the lock entirely — they don't have a server id yet. */
  async function onEnterEdit({ force = false } = {}) {
    if (isNew) {
      setIsEditing(true)
      return
    }
    try {
      await lock.acquire({ force })
      setTakeoverPrompt(null)
      setIsEditing(true)
    } catch (err) {
      if (err instanceof LockConflictError && err.code === 'lock_held_by_other') {
        setTakeoverPrompt(err.holder)
        return
      }
      toast.error(err.message || '편집 모드 진입 실패')
    }
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

  /** Clone the current report's pages (content + layouts + overrides + extras
   *  + section tags) into a brand-new draft owned by the current user.
   *  Title comes from the dialog input; report_date resets to today and the
   *  backend auto-assigns owner / created_at / updated_by from the request.
   *  Status drops back to 'draft' since a copy represents fresh work.
   *  After creation we navigate to the new report's URL with `startEditing`
   *  in router state so it lands directly in the edit screen. */
  async function onCopy(newTitle) {
    if (!draft) return
    const first = draft.pages[0]
    try {
      const created = await createReport({
        template_id: first.template_id,
        template_version: first.template_version,
        title: newTitle,
        report_date: todayIsoDate(),
        status: 'draft',
        tags: draft.tags ?? [],
        pages: draft.pages,
        // Carry the source report's width preference into the copy so the
        // user sees the same layout immediately.
        page_width_px: Number.isFinite(draft.page_width_px) ? draft.page_width_px : null,
      })
      toast.success('보고서가 복사되었습니다.')
      setCopyOpen(false)
      navigate(`/w/${slug}/reports/${created.id}`, {
        state: { startEditing: true },
      })
    } catch (err) {
      toast.error(err.message || '복사 실패')
      throw err
    }
  }

  /** Snapshot the currently-viewed page's widget layout into a brand-new
   *  template. Only blocks (id/type/props/layout) are copied — content
   *  values stay behind because templates have no notion of filled-in
   *  data. Per-block overrides (props_overrides / layout_overrides) are
   *  merged so the saved template captures what the user actually sees,
   *  and extra blocks added at report-write time become first-class
   *  template blocks. blocks_order is honored so the saved order
   *  matches the on-screen order. */
  async function onSaveAsTemplate({ templateId, name, description, category }) {
    const page = currentPageData
    const template = currentTemplate
    if (!page || !template) {
      toast.error('템플릿 정보를 불러오는 중입니다. 잠시 후 다시 시도하세요.')
      throw new Error('Template not ready')
    }
    const fixupNotes = []
    const blocks = combinedBlocks(template, page).map((b) => {
      const propsOverride = page.props_overrides?.[b.id]
      const layoutOverride = page.layout_overrides?.[b.id]
      const blockContent = page.content?.[b.id]
      let mergedProps = { ...(b.props ?? {}), ...(propsOverride ?? {}) }
      // Chart-specific: structural fields (columns, x_column_key,
      // chart_type, axis titles) may live in content (legacy / current
      // ChartEditor behavior). Content is the *user-visible* source of
      // truth for these — what's drawn on screen — so it must win over
      // both the template default AND any stale props_overrides left by
      // an older PropsPanel session. Otherwise the template snapshot
      // wouldn't match what the user actually sees.
      if (b.type === 'chart' && blockContent && typeof blockContent === 'object') {
        for (const key of [
          'columns',
          'x_column_key',
          'chart_type',
          'x_axis_title',
          'y_axis_title',
        ]) {
          if (blockContent[key] !== undefined && blockContent[key] !== '') {
            mergedProps[key] = blockContent[key]
          }
        }
        // After resolving content↔overrides, the chart may still
        // violate the backend's schema rules (X-axis must exist, non-X
        // columns must be number-typed). normalizeChartPropsForTemplate
        // applies the same fixes a careful user would: pick a valid
        // X-axis, promote the lone text column when needed, drop any
        // remaining text columns from the schema. The user is notified
        // via a single toast at the end so they know what was tidied.
        const before = mergedProps
        mergedProps = normalizeChartPropsForTemplate(mergedProps)
        const note = describeChartFixup(b.id, before, mergedProps)
        if (note) fixupNotes.push(note)
      }
      const out = {
        id: b.id,
        type: b.type,
        props: mergedProps,
      }
      const mergedLayout = { ...(b.layout ?? {}), ...(layoutOverride ?? {}) }
      if (Object.keys(mergedLayout).length > 0) out.layout = mergedLayout
      return out
    })
    const schema = { version: 'widget-v1', blocks }
    try {
      const created = await createTemplate({
        template_id: templateId,
        name,
        description: description || '',
        category: category || 'misc',
        schema,
        // Scope to current workspace so it appears in this workspace's
        // template picker. Empty/null would make it globally visible.
        owner_workspace_slugs: slug ? [slug] : null,
      })
      toast.success(`템플릿 '${created.name}' 저장됨`)
      if (fixupNotes.length > 0) {
        toast.info(`차트 자동 정리: ${fixupNotes.join(' · ')}`)
      }
      setSaveTemplateOpen(false)
    } catch (err) {
      toast.error(err.message || '템플릿 저장 실패')
      throw err
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

  // PDF export — opens a small dialog so the writer can pick a font
  // scale, then triggers the browser's print dialog with that scale
  // applied via the `--print-scale` CSS variable that print rules in
  // index.css multiply against the widget text sizes.
  function handleExportPdf() {
    if (!draft) return
    setPdfDialogOpen(true)
  }
  function performPdfPrint(scale) {
    if (!draft) return
    const safe = Number.isFinite(scale) && scale > 0 ? scale : 1
    setPdfDialogOpen(false)
    document.documentElement.style.setProperty('--print-scale', String(safe))
    setPrinting(true)
    // Two RAFs so React has a chance to (a) re-render with printing=true,
    // (b) commit layout. Without this, the print preview can snapshot the
    // pre-toggle DOM and capture edit chrome.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        // Measure the rendered grid's screen width and pick a zoom ratio
        // so the entire grid (with its desktop-sized side-by-side widget
        // layout) fits inside the paper's printable area. Without this,
        // the grid's pixel-based positioning runs off the right edge of
        // A4 and content gets cropped.
        //
        // A4 portrait, 12mm margins ≈ 186mm × 273mm printable.
        // 186mm at 96dpi ≈ 703 CSS px. We bias slightly under 703 to
        // leave a tiny safety gutter for browsers that round oddly.
        const TARGET_PRINT_PX = 690
        const gridEl = document.querySelector(
          '.report-detail-root .react-grid-layout',
        )
        const screenW = gridEl?.getBoundingClientRect?.()?.width ?? 0
        const zoomRatio = screenW > TARGET_PRINT_PX
          ? Math.max(0.35, TARGET_PRINT_PX / screenW)
          : 1
        document.documentElement.style.setProperty(
          '--print-zoom',
          String(zoomRatio),
        )
        const cleanup = () => {
          setPrinting(false)
          document.documentElement.style.removeProperty('--print-scale')
          document.documentElement.style.removeProperty('--print-zoom')
          window.removeEventListener('afterprint', cleanup)
        }
        window.addEventListener('afterprint', cleanup)
        window.print()
        // Fallback for browsers that don't fire afterprint reliably (rare,
        // but Safari historically has been spotty). 500ms is generous —
        // the print dialog blocks the event loop in modern Chromium so we
        // shouldn't actually hit this in practice.
        setTimeout(() => {
          setPrinting(false)
          document.documentElement.style.removeProperty('--print-scale')
          document.documentElement.style.removeProperty('--print-zoom')
        }, 500)
      })
    })
  }

  // HTML export — clone the currently rendered report DOM (with the
  // app shell stripped) into a single self-contained .html with
  // stylesheets inlined and images converted to base64 data URIs.
  // Keeps the on-screen visual layout exactly as the writer sees it.
  async function handleExportHtml() {
    if (!draft) return
    setPrinting(true)
    try {
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)),
      )
      const { exportReportToHtml } = await import('./exportReportToHtml')
      await exportReportToHtml({ draft })
      toast.success('HTML 파일로 저장했습니다.')
    } catch (err) {
      console.error(err)
      toast.error(`HTML 저장 실패: ${err?.message ?? err}`)
    } finally {
      setPrinting(false)
    }
  }

  // Word export — runs the docx builder with the report mounted in
  // view-mode so html2canvas captures of chart/flowchart/milestone
  // blocks come out clean. The builder lives in exportReportToDocx.
  async function handleExportDocx() {
    if (!draft) return
    setPrinting(true)
    try {
      // Same two-frame wait so the DOM the exporter snapshots reflects
      // the read-only layout (no drag handles, no edit-mode picker
      // strips, etc.).
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)),
      )
      const { exportReportToDocx } = await import('./exportReportToDocx')
      await exportReportToDocx({
        draft,
        pageTemplateMap,
        sectionItemByCode,
      })
      toast.success('Word 파일로 저장했습니다.')
    } catch (err) {
      console.error(err)
      toast.error(`Word 저장 실패: ${err?.message ?? err}`)
    } finally {
      setPrinting(false)
    }
  }

  // Shared import path for both the file picker and the paste-JSON dialog.
  // Throws on schema mismatch so the caller can surface its own toast.
  function applyImportedDraft(text) {
    const obj = parseImportPayload(text)
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
  }

  /** Append-as-new-pages: keep title/date/tags and existing pages,
   *  drop the imported pages at the end as their own pages. The
   *  imported pages keep their own template binding. Use case: a
   *  generated multi-page section becomes a separate chapter. */
  function appendImportedAsNewPages(text) {
    const obj = parseImportPayload(text)
    let nextPageCount = 0
    setDraft((d) => {
      const existing = Array.isArray(d?.pages) ? d.pages : []
      const incoming = obj.pages.map(normalizePage)
      nextPageCount = existing.length + incoming.length
      return {
        ...(d ?? {}),
        // Metadata (title / date / tags) stays put — appending content
        // shouldn't quietly rewrite the report's identity.
        pages: [...existing, ...incoming],
      }
    })
    // Jump to the first appended page so the user lands on the new
    // content right away.
    setCurrentPage(Math.max(0, nextPageCount - obj.pages.length))
    setIsEditing(true)
  }

  /** Append-into-current-page: flatten the imported widgets (every
   *  page's `extra_blocks` + matching `content`) into the *current*
   *  page's extras. Keeps the current page's template, layout, and
   *  metadata; new blocks just slot in at the end of the page. Use
   *  case: dropping AI-generated widgets into the spot the writer is
   *  already working on without making a brand-new page.
   *
   *  Per-block IDs get remapped against the current page's existing
   *  ID space (template blocks + extras + content keys + ...) so
   *  imported blocks named the same way as something on the current
   *  page don't collide and get silently dropped.
   */
  function appendImportedToCurrentPage(text) {
    const obj = parseImportPayload(text)
    setDraft((d) => {
      if (!d?.pages || d.pages.length === 0) {
        // No page to merge into — fall through to the new-page path
        // so the user doesn't lose their paste.
        return {
          ...(d ?? {}),
          pages: obj.pages.map(normalizePage),
        }
      }
      const idx = clamp(currentPage, 0, d.pages.length - 1)
      const target = d.pages[idx]
      const targetTpl = getCachedTemplate(pageTemplateMap, target)
      const existingIds = collectPageBlockIds(target, targetTpl)

      const addedExtras = []
      const addedContent = {}
      const addedSections = {}
      for (const importedPage of obj.pages) {
        const idMap = new Map()
        for (const b of importedPage.extra_blocks ?? []) {
          if (!b?.id || !b?.type) continue
          let newId = b.id
          if (existingIds.has(newId)) newId = freshExtraId(b.type, existingIds)
          existingIds.add(newId)
          idMap.set(b.id, newId)
          addedExtras.push({ ...b, id: newId })
        }
        const importedContent = importedPage.content ?? {}
        const importedSections = importedPage.block_sections ?? {}
        for (const [oldId, newId] of idMap) {
          if (oldId in importedContent) addedContent[newId] = importedContent[oldId]
          if (oldId in importedSections) addedSections[newId] = importedSections[oldId]
        }
      }
      if (addedExtras.length === 0) {
        // Imported JSON had no extra_blocks (only template-content
        // entries that don't apply to our different template). Bail
        // gracefully — caller's toast still fires success but with a
        // hint via the next-line warning toast.
        toast.info('붙일 위젯이 없습니다. 가져온 JSON 에 extra_blocks 가 없습니다.')
        return d
      }
      // If the target page already maintains an explicit blocks_order,
      // append the new IDs so the new widgets actually render. Empty
      // blocks_order means "default = template then extras" and the
      // new extras get appended naturally by combinedBlocks().
      const nextOrder =
        Array.isArray(target.blocks_order) && target.blocks_order.length > 0
          ? [...target.blocks_order, ...addedExtras.map((b) => b.id)]
          : target.blocks_order ?? []

      const nextPages = [...d.pages]
      nextPages[idx] = {
        ...target,
        extra_blocks: [...(target.extra_blocks ?? []), ...addedExtras],
        content: { ...(target.content ?? {}), ...addedContent },
        block_sections: { ...(target.block_sections ?? {}), ...addedSections },
        blocks_order: nextOrder,
      }
      return { ...(d ?? {}), pages: nextPages }
    })
    setIsEditing(true)
  }

  async function handleLocalLoad(e) {
    const file = e.target.files?.[0]
    e.target.value = '' // reset so the same file can be re-loaded later
    if (!file) return
    try {
      const text = await file.text()
      applyImportedDraft(text)
      toast.success('JSON 파일을 불러왔습니다. 저장하려면 “저장” 버튼을 눌러주세요.')
    } catch (err) {
      toast.error(err.message || '불러오기 실패')
    }
  }

  // Build the prompt that teaches an external AI ReportArchive's JSON
  // shape + widget catalog. The prompt is *template-agnostic*: it does
  // not embed the current report's content or block layout (those tend
  // to confuse the model). Only the page's template binding
  // (template_id / template_version) is pre-filled so the round-trip
  // import + save still works against a real template.
  function buildAiPrompt() {
    const widgets = widgetCatalog?.widgets ?? []
    const firstPage = draft?.pages?.[0]
    const tplId = firstPage?.template_id ?? 'TEMPLATE_ID_HERE'
    const tplVer = firstPage?.template_version ?? 1

    const skeleton = {
      _type: 'report_archive_draft_v1',
      title: '<보고서 제목>',
      report_date: '<YYYY-MM-DD>',
      tags: [],
      pages: [
        {
          template_id: tplId,
          template_version: tplVer,
          name: null,
          extra_blocks: [
            { id: '<block_id_1>', type: '<widget_type>', props: { /* 위젯 props */ } },
            { id: '<block_id_2>', type: '<widget_type>', props: { /* 위젯 props */ } },
          ],
          content: {
            '<block_id_1>': { /* 해당 위젯의 content 형식 */ },
            '<block_id_2>': { /* 해당 위젯의 content 형식 */ },
          },
          layout_overrides: null,
          props_overrides: null,
          blocks_order: [],
          block_sections: {
            '<block_id_1>': '<단락 구분 item code>',
          },
        },
      ],
    }

    const sectionTaxonomyBlock = renderSectionTaxonomy(sectionCategories)

    const widgetCatalogBlock = widgets.length === 0
      ? '(위젯 카탈로그를 아직 불러오지 못했습니다. 잠시 후 다시 열어보세요.)'
      : widgets
          .map((w) => {
            const schemaStr = JSON.stringify(w.props_schema ?? {}, null, 2)
            return `### ${w.type} — ${w.label}\n${w.description}\nprops_schema:\n${indent(schemaStr, 2)}`
          })
          .join('\n\n')

    return [
      '당신은 ReportArchive 보고서 작성 도우미입니다.',
      '사용자 입력(자유 텍스트, 메모, 표 등)을 분석해, 아래 위젯들을 자유롭게 조합한 JSON 한 덩어리만 출력합니다.',
      'JSON 외의 설명·주석·마크다운 코드펜스(```)는 일체 출력하지 마세요. 응답은 반드시 `{` 로 시작해 `}` 로 끝나야 합니다.',
      '',
      '== 출력 JSON 전체 구조 ==',
      'top-level 형식은 아래와 같습니다. `pages` 배열에 페이지를 1개 이상 만들고, 각 페이지 안에서는 위젯 블록을 `extra_blocks` 에 선언하고, 같은 `id` 를 키로 `content` 에 데이터를 넣으세요.',
      JSON.stringify(skeleton, null, 2),
      '',
      '== 작성 규칙 ==',
      '1. 데이터 성격에 맞춰 다양한 위젯을 자유롭게 조합하세요. (제목 → heading, 줄글 → rich_text, 수치 카드 → key_value, 항목 나열 → bulleted_list, 표 데이터 → table, 시계열/추세 → chart 등)',
      '2. 위젯 블록은 모두 `extra_blocks` 에 정의합니다. 같은 `id` 가 `extra_blocks` 와 `content` 양쪽에 존재해야 합니다. (블록 선언 ↔ 데이터 매핑)',
      '3. `block_id` 는 정규식 `^[a-z][a-z0-9_]{0,63}$` 를 만족해야 합니다. 영문 소문자로 시작, 숫자·언더스코어 가능, 페이지 내 유일.',
      '4. 각 페이지의 `template_id` / `template_version` 은 위 골격에 채워둔 값을 그대로 유지하세요 (직접 수정 금지).',
      '5. 주제가 길거나 분리된다면 `pages` 에 페이지를 추가해도 됩니다. 같은 template_id / version 을 그대로 복사해 사용하세요.',
      '6. `layout_overrides`, `props_overrides`, `blocks_order` 는 비워두는 것이 안전합니다. (`null` / `[]` 그대로)',
      '7. `block_sections` 은 선택 사항입니다. 단락 구분이 분명한 블록만 아래 “단락 구분 (block_sections)” 절을 참고해 채우세요. 비울 때는 `{}`.',
      '8. 모르는 값은 생략하거나 빈 문자열 `""` 로 두세요. 임의의 값(placeholder)을 지어내지 마세요.',
      '9. `image` / `attachment` 위젯은 시스템에 업로드된 파일을 가리키는 `file_id` 가 필요하므로 절대 만들지 마세요.',
      '',
      '== 단락 구분 (block_sections) ==',
      '`pages[].block_sections` 는 `{ "block_id": "item_code" }` 형식의 맵입니다. 각 블록에 "이 블록이 어느 단락(섹션)에 속하는지" 표시하는 메타데이터로, 보고서 화면에서 색상 칩으로 표시됩니다.',
      '- 키 = 같은 페이지 안에 존재하는 블록 id (template 블록이든 extra 블록이든 OK)',
      '- 값 = 아래 taxonomy 의 `code` 문자열 (정확히 일치해야 함, label/한글이름 사용 금지)',
      '- 모든 블록에 달 필요 없음. 단락 구분이 분명한 블록만 태깅.',
      '- 같은 code 를 여러 블록에 사용 가능 (한 단락에 여러 위젯).',
      '- 아래 taxonomy 에 없는 code 는 사용 금지. 적절한 항목이 없으면 그 블록은 그냥 생략.',
      '',
      '아래는 현재 워크스페이스에 등록된 단락 구분 taxonomy 입니다 (카테고리별 그룹).',
      '',
      sectionTaxonomyBlock,
      '',
      '== 절대 하지 말 것 (체크리스트) ==',
      '- bulleted_list 의 items 를 `[{text, depth}, ...]` 객체 배열로 만들기 → 반드시 `["문자열", ...]`',
      '- key_value 의 content 를 `{values: {...}}` 로 감싸기 → 키를 top-level 에 그대로 펼치기',
      '- milestone 의 status 에 `planned` / `in_progress` 사용 → `pending` / `done` / `delayed` 만 허용',
      '- flowchart 를 `nodes` / `edges` 그래프로 표현 → `items: [{label, description?}]` 순차 리스트만 지원',
      '- image / attachment 위젯 생성 → 불가능 (file_id 필요)',
      '- props 에 widget 의 props_schema 에 없는 키 추가 (`additionalProperties: false`)',
      '- `block_sections` 값에 한글 라벨/카테고리 이름 넣기 → 반드시 `code` 문자열',
      '- 위 taxonomy 에 없는 임의의 code 만들기 → 적절한 항목이 없으면 그 블록 항목을 생략',
      '',
      '== 위젯 카탈로그 (전체 목록 / props_schema 원본) ==',
      widgetCatalogBlock,
      '',
      '== 위젯별 props / content 예시 ==',
      WIDGET_EXAMPLES_TEXT,
      '',
      '== 작성 흐름 ==',
      '① 사용자 입력을 훑어 섹션/표/리스트/수치 등을 식별 → ② 각 조각을 어떤 위젯으로 표현할지 결정 → ③ extra_blocks 에 블록을 선언하고 같은 id 로 content 채움 → ④ 단락 구분이 분명한 블록은 block_sections 에 태깅 → ⑤ JSON 만 출력.',
      '',
      '== 사용자 입력 ==',
      '<<여기에 보고서로 만들고 싶은 내용을 붙여 넣으세요>>',
    ].join('\n')
  }

  // V2: bakes the current page's template skeleton (already-arranged
  // widget blocks: id / type / props) into the prompt so the AI is told
  // to fill those existing blocks first, and only fall back to
  // `extra_blocks` when the template lacks a needed widget type. None of
  // the report's user-entered content is included — only the empty
  // template layout.
  function buildAiPromptV2() {
    const widgets = widgetCatalog?.widgets ?? []
    const firstPage = draft?.pages?.[0]
    const tplId = firstPage?.template_id ?? 'TEMPLATE_ID_HERE'
    const tplVer = firstPage?.template_version ?? 1
    const template = currentTemplate
    const tplBlocks = Array.isArray(template?.schema?.blocks) ? template.schema.blocks : []

    const contentSkeleton = {}
    for (const b of tplBlocks) {
      contentSkeleton[b.id] = `<${b.type} 위젯의 content (아래 위젯별 형식 참고)>`
    }

    const blockSectionsSkeleton = tplBlocks.length > 0
      ? { [tplBlocks[0].id]: '<단락 구분 item code>' }
      : { '<block_id>': '<단락 구분 item code>' }

    const skeleton = {
      _type: 'report_archive_draft_v1',
      title: '<보고서 제목>',
      report_date: '<YYYY-MM-DD>',
      tags: [],
      pages: [
        {
          template_id: tplId,
          template_version: tplVer,
          name: null,
          extra_blocks: [],
          content: tplBlocks.length > 0
            ? contentSkeleton
            : {
                '<block_id_1>': { /* extra_blocks 에 추가한 위젯의 content */ },
              },
          layout_overrides: null,
          props_overrides: null,
          blocks_order: [],
          block_sections: blockSectionsSkeleton,
        },
      ],
    }

    const sectionTaxonomyBlock = renderSectionTaxonomy(sectionCategories)

    const templateBlocksBlock = tplBlocks.length === 0
      ? '(현재 페이지에 바인딩된 템플릿을 아직 불러오지 못했거나 비어 있습니다. 잠시 후 다시 열어보세요. 그동안에는 모든 위젯을 `extra_blocks` 에 직접 선언하셔도 됩니다.)'
      : tplBlocks
          .map((b, i) => {
            const propsStr = JSON.stringify(b.props ?? {}, null, 2)
            return `### [${i + 1}] id="${b.id}"  type=${b.type}\nprops (수정 금지 — 참고용):\n${indent(propsStr, 2)}`
          })
          .join('\n\n')

    const widgetCatalogBlock = widgets.length === 0
      ? '(위젯 카탈로그를 아직 불러오지 못했습니다. 잠시 후 다시 열어보세요.)'
      : widgets
          .map((w) => {
            const schemaStr = JSON.stringify(w.props_schema ?? {}, null, 2)
            return `### ${w.type} — ${w.label}\n${w.description}\nprops_schema:\n${indent(schemaStr, 2)}`
          })
          .join('\n\n')

    return [
      '당신은 ReportArchive 보고서 작성 도우미입니다.',
      '사용자 입력(자유 텍스트, 메모, 표 등)을 분석해, 아래 위젯들을 자유롭게 조합한 JSON 한 덩어리만 출력합니다.',
      'JSON 외의 설명·주석·마크다운 코드펜스(```)는 일체 출력하지 마세요. 응답은 반드시 `{` 로 시작해 `}` 로 끝나야 합니다.',
      '',
      '== 출력 JSON 전체 구조 ==',
      'top-level 형식은 아래와 같습니다. `pages[0].content` 의 키는 아래 “템플릿에 이미 배치된 위젯” 섹션의 id 와 1:1 로 대응합니다. 부족할 때만 `extra_blocks` 에 새 위젯을 추가하고, 같은 id 를 `content` 에도 넣으세요.',
      JSON.stringify(skeleton, null, 2),
      '',
      '== 템플릿에 이미 배치된 위젯 (★ 우선 사용 ★) ==',
      '아래 블록들은 현재 페이지 템플릿에 이미 배치되어 있습니다. **반드시 이 id 들을 그대로 사용해 `content[id]` 를 채우세요.**',
      '- props 는 템플릿이 정한 값이며, 절대 수정하지 마세요. (`props_overrides` 도 비워두세요.)',
      '- 사용자 입력의 각 조각을 보고, 의미가 맞는 블록의 content 를 채웁니다.',
      '- 대응하는 블록이 정말 없을 때만 `extra_blocks` 에 새 위젯을 추가하세요.',
      '- 이 목록에 있는 블록은 절대 삭제·이름변경하지 마세요. (사용할 내용이 없으면 content 에서 그 id 만 비워 두면 됩니다.)',
      '',
      templateBlocksBlock,
      '',
      '== 부족한 위젯을 추가하는 방법 (extra_blocks) ==',
      '템플릿에 없는 위젯이 필요하면 `extra_blocks` 에 `{ id, type, props }` 형식으로 새 블록을 선언하고, 같은 id 를 키로 `content[id]` 에 데이터를 넣으세요.',
      '- `id` 는 정규식 `^[a-z][a-z0-9_]{0,63}$` 를 만족해야 하며, 위 템플릿 블록 id 와 충돌하지 않아야 합니다.',
      '- 새 블록의 `props` 는 아래 “위젯 카탈로그”의 `props_schema` 와 정확히 일치해야 합니다 (`additionalProperties: false`).',
      '- 꼭 필요한 위젯만 추가하세요. 무리하게 만들지 말 것.',
      '',
      '== 작성 규칙 ==',
      '1. 각 페이지의 `template_id` / `template_version` 은 위 골격에 채워둔 값을 그대로 유지하세요 (직접 수정 금지).',
      '2. `content` 의 키는 (a) 위 “템플릿에 이미 배치된 위젯” 의 id, 또는 (b) 본인이 `extra_blocks` 에 새로 선언한 id 둘 중 하나여야 합니다.',
      '3. `layout_overrides`, `props_overrides`, `blocks_order` 는 비워두는 것이 안전합니다. (`null` / `[]` 그대로)',
      '4. `block_sections` 은 선택 사항입니다. 단락 구분이 분명한 블록만 아래 “단락 구분 (block_sections)” 절을 참고해 채우세요. 비울 때는 `{}`.',
      '5. 주제가 길거나 분리된다면 `pages` 에 페이지를 추가해도 됩니다. 같은 template_id / version 을 그대로 복사해 사용하세요.',
      '6. 모르는 값은 생략하거나 빈 문자열 `""` 로 두세요. 임의의 값(placeholder)을 지어내지 마세요.',
      '7. `image` / `attachment` 위젯은 시스템에 업로드된 파일을 가리키는 `file_id` 가 필요하므로 절대 만들지 마세요.',
      '',
      '== 단락 구분 (block_sections) ==',
      '`pages[].block_sections` 는 `{ "block_id": "item_code" }` 형식의 맵입니다. 각 블록에 "이 블록이 어느 단락(섹션)에 속하는지" 표시하는 메타데이터로, 보고서 화면에서 색상 칩으로 표시됩니다.',
      '- 키 = 같은 페이지 안에 존재하는 블록 id (위 “템플릿에 이미 배치된 위젯” 의 id 또는 본인이 만든 extra id)',
      '- 값 = 아래 taxonomy 의 `code` 문자열 (정확히 일치해야 함, label/한글이름 사용 금지)',
      '- 모든 블록에 달 필요 없음. 단락 구분이 분명한 블록만 태깅.',
      '- 같은 code 를 여러 블록에 사용 가능 (한 단락에 여러 위젯).',
      '- 아래 taxonomy 에 없는 code 는 사용 금지. 적절한 항목이 없으면 그 블록은 그냥 생략.',
      '',
      '아래는 현재 워크스페이스에 등록된 단락 구분 taxonomy 입니다 (카테고리별 그룹).',
      '',
      sectionTaxonomyBlock,
      '',
      '== 절대 하지 말 것 (체크리스트) ==',
      '- 템플릿 블록의 id 를 바꾸거나 새로운 id 로 대체하기 → 위 “템플릿에 이미 배치된 위젯” 의 id 를 **그대로** 사용',
      '- 템플릿 블록을 `extra_blocks` 에 중복으로 다시 선언하기 → 템플릿 블록은 이미 있으므로 `content` 만 채움',
      '- bulleted_list 의 items 를 `[{text, depth}, ...]` 객체 배열로 만들기 → 반드시 `["문자열", ...]`',
      '- key_value 의 content 를 `{values: {...}}` 로 감싸기 → 키를 top-level 에 그대로 펼치기',
      '- milestone 의 status 에 `planned` / `in_progress` 사용 → `pending` / `done` / `delayed` 만 허용',
      '- flowchart 를 `nodes` / `edges` 그래프로 표현 → `items: [{label, description?}]` 순차 리스트만 지원',
      '- image / attachment 위젯 생성 → 불가능 (file_id 필요)',
      '- props 에 widget 의 props_schema 에 없는 키 추가 (`additionalProperties: false`)',
      '- `block_sections` 값에 한글 라벨/카테고리 이름 넣기 → 반드시 `code` 문자열',
      '- 위 taxonomy 에 없는 임의의 code 만들기 → 적절한 항목이 없으면 그 블록 항목을 생략',
      '',
      '== 위젯 카탈로그 (전체 목록 / props_schema 원본) ==',
      widgetCatalogBlock,
      '',
      '== 위젯별 props / content 예시 ==',
      WIDGET_EXAMPLES_TEXT,
      '',
      '== 작성 흐름 ==',
      '① 사용자 입력을 훑어 섹션/표/리스트/수치 등을 식별 → ② 위 “템플릿에 이미 배치된 위젯” 목록을 보고 각 조각을 어느 블록 id 에 채울지 결정 → ③ 빠진 위젯이 있을 때만 `extra_blocks` 에 새 블록을 선언 → ④ 단락 구분이 분명한 블록은 block_sections 에 태깅 → ⑤ JSON 만 출력.',
      '',
      '== 사용자 입력 ==',
      '<<여기에 보고서로 만들고 싶은 내용을 붙여 넣으세요>>',
    ].join('\n')
  }

  // Driven by performPdfPrint — when not printing the context value is 1
  // so screen rendering uses the chart's default font sizes; while
  // printing it switches to the user-picked scale so SVG-rendered text
  // (Recharts) re-renders with the right size for the page.
  const printContextValue = printing ? pdfPrintScale : 1

  return (
    <PrintScaleContext.Provider value={printContextValue}>
    <div className="flex h-full report-detail-root">
      <div className="relative flex-1 min-w-0 flex flex-col">
        <div className="flex flex-wrap items-center gap-3 border-b bg-background px-6 py-3 report-detail-toolbar">
          <div className="flex-1 min-w-[280px]">
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
              {/* "현재 OO 편집 중" — shown in view mode whenever another
                  user holds the lock. The dedicated GET embeds the latest
                  holder so this chip stays accurate without polling.
                  Hidden once I'm editing (the page state is then implied
                  by the 저장/취소 buttons). */}
              {!isEditing && existingReport?.edit_lock
                && existingReport.edit_lock.user_id !== currentUserId && (
                <LockHolderChip holder={existingReport.edit_lock} />
              )}
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

          <div className="flex flex-wrap items-center gap-2 ml-auto">
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
              <Button variant="outline" size="sm" onClick={() => onEnterEdit()}>
                <Pencil className="mr-1 h-3 w-3" />
                편집
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCopyOpen(true)}
              >
                <Copy className="mr-1 h-3 w-3" />
                복사
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSaveTemplateOpen(true)}
                title="현재 페이지의 위젯 배치를 새 템플릿으로 저장"
              >
                <FileBox className="mr-1 h-3 w-3" />
                템플릿으로 저장
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
              <Button
                variant="ghost"
                size="sm"
                title="AI에게 보고서 작성을 맡기기 위한 프롬프트 생성"
              >
                <Sparkles className="mr-1 h-3 w-3" />
                AI
                <ChevronDown className="ml-1 h-3 w-3 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setAiPromptOpen(true)}>
                <Sparkles className="mr-2 h-3.5 w-3.5" />
                V1 — 빈 골격 프롬프트
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setAiPromptV2Open(true)}>
                <Sparkles className="mr-2 h-3.5 w-3.5" />
                V2 — 템플릿 배치 우선
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

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
              <DropdownMenuItem onSelect={handleExportPdf}>
                <FileText className="mr-2 h-3.5 w-3.5" />
                PDF로 저장 (브라우저 인쇄)
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={handleExportDocx}>
                <FileType2 className="mr-2 h-3.5 w-3.5" />
                Word로 저장
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={handleExportHtml}>
                <FileCode className="mr-2 h-3.5 w-3.5" />
                HTML로 저장
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
          <div
            className="p-6 space-y-8 mx-auto w-full"
            // Per-report content width. Falls back to the narrow default
            // (1024px ≈ Tailwind `max-w-5xl`) so reports that pre-date the
            // setting keep their look. Right-click in the empty area below
            // opens the picker.
            style={{ maxWidth: `${draft.page_width_px ?? DEFAULT_REPORT_WIDTH_PX}px` }}
            onContextMenu={(e) => {
              // Blocks call `e.preventDefault()` in their own handler and
              // we let that flag bubble up here — when it's set we know a
              // child already handled the click and our page-level menu
              // should stay quiet. Any right-click that lands on empty
              // padding / inter-page gap reaches us with the flag unset.
              if (e.defaultPrevented) return
              // The width is a saved property, so the menu only makes
              // sense inside edit mode. In view mode we leave the native
              // browser context menu alone so the writer can still copy
              // text, inspect, etc.
              if (!effectiveIsEditing) return
              e.preventDefault()
              setPageContextMenu({ x: e.clientX, y: e.clientY })
            }}
          >
            {/* Print-only title block — the in-app title lives in the
                toolbar, which is hidden by the @media print rules. Adding
                an inline title here keeps the printed PDF self-explanatory
                without disturbing the screen layout. */}
            <div className="hidden print:block mb-4">
              <h1 className="text-2xl font-bold">{draft.title || '(제목 없음)'}</h1>
              <div className="text-sm text-muted-foreground mt-1">
                {draft.report_date}
                {existingReport?.owner_name ? ` · ${existingReport.owner_name}` : ''}
              </div>
            </div>
            {effectiveViewMode === 'all'
              ? pages.map((p, idx) => (
                  <PageSection
                    key={`page-${idx}`}
                    pageIdx={idx}
                    page={p}
                    template={getCachedTemplate(pageTemplateMap, p)}
                    isEditing={effectiveIsEditing}
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
                    onAddExtraBlockAt={(type, defaults, anchorId, direction) =>
                      addExtraBlockAt(idx, type, defaults, anchorId, direction)
                    }
                    onRemoveBlock={(blockId) => removeBlockFromPage(idx, blockId)}
                    onChangeExtraBlockProps={(blockId, newProps) =>
                      setExtraBlockProps(idx, blockId, newProps)
                    }
                    onChangeSection={(blockId, code) => setBlockSection(idx, blockId, code)}
                    sectionCategories={sectionCategories}
                    sectionItemByCode={sectionItemByCode}
                  />
                ))
              : (
                  <PageSection
                    key={`page-${safeCurrent}`}
                    pageIdx={safeCurrent}
                    page={currentPageData}
                    template={currentTemplate}
                    isEditing={effectiveIsEditing}
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
                    onAddExtraBlockAt={(type, defaults, anchorId, direction) =>
                      addExtraBlockAt(safeCurrent, type, defaults, anchorId, direction)
                    }
                    onRemoveBlock={(blockId) =>
                      removeBlockFromPage(safeCurrent, blockId)
                    }
                    onChangeExtraBlockProps={(blockId, newProps) =>
                      setExtraBlockProps(safeCurrent, blockId, newProps)
                    }
                    onChangeSection={(blockId, code) =>
                      setBlockSection(safeCurrent, blockId, code)
                    }
                    sectionCategories={sectionCategories}
                    sectionItemByCode={sectionItemByCode}
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

      <ReportCopyDialog
        open={copyOpen}
        onOpenChange={setCopyOpen}
        sourceTitle={draft?.title ?? ''}
        onConfirm={onCopy}
      />

      <SaveAsTemplateDialog
        open={saveTemplateOpen}
        onOpenChange={setSaveTemplateOpen}
        sourceTitle={draft?.title ?? ''}
        sourceTemplate={currentTemplate}
        pageCount={pageCount}
        currentPageIndex={safeCurrent}
        onConfirm={onSaveAsTemplate}
      />

      <AiPromptDialog
        open={aiPromptOpen}
        onOpenChange={setAiPromptOpen}
        getPrompt={buildAiPrompt}
        widgetCatalog={widgetCatalog}
        title="AI 프롬프트 V1 — 보고서 JSON 생성 (빈 골격)"
        description="아래 프롬프트를 AI에 보내고, 보고서 본문을 함께 입력하면 JSON 결과를 받을 수 있습니다. 그 JSON 을 “JSON 데이터 붙여넣기”로 다시 불러오세요."
      />

      <AiPromptDialog
        open={aiPromptV2Open}
        onOpenChange={setAiPromptV2Open}
        getPrompt={buildAiPromptV2}
        widgetCatalog={widgetCatalog}
        title="AI 프롬프트 V2 — 템플릿 배치를 우선해 채우기"
        description="현재 페이지 템플릿에 배치된 위젯들의 id·props 를 함께 전달합니다. AI 는 이 위젯들을 먼저 채우고, 부족할 때만 새 위젯을 `extra_blocks` 에 추가합니다. (보고서의 기존 내용은 포함되지 않습니다.)"
      />

      <PasteJsonDialog
        open={pasteJsonOpen}
        onOpenChange={setPasteJsonOpen}
        onReplace={(text) => {
          applyImportedDraft(text)
          toast.success('보고서 전체를 교체했습니다. 저장하려면 “저장” 버튼을 눌러주세요.')
        }}
        onAppendNewPages={(text) => {
          appendImportedAsNewPages(text)
          toast.success('JSON 의 페이지를 새 페이지로 뒤에 추가했습니다.')
        }}
        onAppendToCurrentPage={(text) => {
          appendImportedToCurrentPage(text)
          toast.success('JSON 의 위젯을 현재 페이지 끝에 이어 붙였습니다.')
        }}
      />

      {pageContextMenu && (
        <PageContextMenu
          x={pageContextMenu.x}
          y={pageContextMenu.y}
          onClose={() => setPageContextMenu(null)}
          onOpenSettings={() => {
            setPageContextMenu(null)
            setSettingsDialogOpen(true)
          }}
        />
      )}

      <ReportSettingsDialog
        open={settingsDialogOpen}
        currentWidthPx={draft?.page_width_px ?? null}
        defaultWidthPx={DEFAULT_REPORT_WIDTH_PX}
        onClose={() => setSettingsDialogOpen(false)}
        onApplyWidth={(px) => {
          setDraft((d) => (d ? { ...d, page_width_px: px } : d))
          setSettingsDialogOpen(false)
        }}
      />

      <TakeoverLockDialog
        holder={takeoverPrompt}
        onCancel={() => setTakeoverPrompt(null)}
        onConfirm={() => onEnterEdit({ force: true })}
      />

      <PdfPrintDialog
        open={pdfDialogOpen}
        onOpenChange={setPdfDialogOpen}
        scale={pdfPrintScale}
        onChangeScale={setPdfPrintScale}
        onConfirm={(s) => performPdfPrint(s)}
      />

      {/* Floating action cluster pinned to the viewport's bottom-right.
          The "위젯 추가" pill drops a new block on the current page
          (safeCurrent — in 'all' viewMode the writer flips the active
          page via PageStrip first); the "보고서 설정" pill opens the
          tabbed settings dialog (currently just 폭 설정). Both live
          inside the same container so the exporter strips them in one
          shot via `report-detail-floating`. */}
      {isEditing && (
        <div className="report-detail-floating fixed bottom-6 right-6 z-40 print:hidden flex flex-col items-end gap-2">
          <FloatingPasteJson onOpen={() => setPasteJsonOpen(true)} />
          <FloatingReportSettings onOpen={() => setSettingsDialogOpen(true)} />
          <FloatingAddWidget
            onAdd={(type, defaults) =>
              addExtraBlock(safeCurrent, type, defaults)
            }
          />
        </div>
      )}
    </div>
    </PrintScaleContext.Provider>
  )
}

/** Asks the user for the new title before kicking off a copy. Pre-fills
 *  '{원본} 사본' so the common case is one Enter; trims and rejects empty. */
function ReportCopyDialog({ open, onOpenChange, sourceTitle, onConfirm }) {
  const [title, setTitle] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (open) {
      const base = (sourceTitle ?? '').trim()
      setTitle(base ? `${base} 사본` : '')
      setSubmitting(false)
    }
  }, [open, sourceTitle])

  async function handleSubmit(e) {
    e.preventDefault()
    const trimmed = title.trim()
    if (!trimmed) return
    setSubmitting(true)
    try {
      await onConfirm(trimmed)
    } catch {
      // onConfirm surfaces its own toast on failure; keep the dialog
      // open so the user can retry with the same title.
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>보고서 복사</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="copy-title" className="text-sm font-medium">
              새 보고서 제목
            </label>
            <Input
              id="copy-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="새 제목"
              autoFocus
              required
            />
            <p className="text-[11px] text-muted-foreground">
              본문·레이아웃은 그대로 복사되며, 작성인은 현재 사용자, 작성일과
              보고 기준일은 오늘로 설정됩니다.
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              취소
            </Button>
            <Button type="submit" disabled={submitting || !title.trim()}>
              {submitting ? '복사 중...' : '복사'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// AI prompt example entries — one per `### <type>` section the prompt
// writes out. `types` is the list of widget types each entry covers (a
// single section covers multiple types when their handling is identical;
// e.g. image / attachment share a single "don't generate these" warning).
//
// Single source of truth for:
//   - WIDGET_EXAMPLES_TEXT  — the joined-text block both prompts paste in
//   - PROMPT_COVERED_WIDGETS — the set the coverage sidebar checks
//
// When the backend gains a new widget, add ONE entry here and both the
// prompts + the "미등록" flag update together.
const WIDGET_PROMPT_EXAMPLES = [
  {
    types: ['heading'],
    body: [
      '### heading (제목)',
      'props (required: level) : `{ "level": 2 }`   // 1=대제목, 2=중제목, 3=소제목',
      'content : `{ "text": "섹션 제목" }`',
    ].join('\n'),
  },
  {
    types: ['rich_text'],
    body: [
      '### rich_text (자유 서술 / 마크다운)',
      'props : `{}`   // 모든 필드 선택. label 등 없음.',
      'content (권장: 단순형) : `{ "markdown": "여러 줄 텍스트…\\n- 글머리도 가능" }`',
      'content (구조형) : `{ "items": [ {"depth":0,"text":"첫째 줄"}, {"depth":1,"text":"하위 항목"} ] }`   // depth 는 0~5 정수',
    ].join('\n'),
  },
  {
    types: ['equation'],
    body: [
      '### equation (수식 — LaTeX)',
      'props (required: label) : `{ "label":"지배 방정식" }`',
      'content : `{ "latex":"\\\\sigma = \\\\frac{F}{A}", "display_mode":"display", "number":"(1)" }`',
      '- latex 은 KaTeX 호환 LaTeX 문자열. **JSON 안에 들어가므로 백슬래시는 두 번** (`\\\\frac`, `\\\\sigma`, `\\\\int_0^1` 등).',
      '- display_mode 는 `display`(중앙·큰 글씨, 기본) | `inline`(베이스라인 정렬, 본문 삽입용).',
      '- number (선택)는 우측에 표시되는 식 번호 — 예: `"(1)"`, `"(eq. 3.2)"`. 비우면 표시 안 됨.',
    ].join('\n'),
  },
  {
    types: ['key_value'],
    body: [
      '### key_value (키-값 카드)  ★ 자주 틀리는 형식 — 주의 ★',
      'props (required: items) : `{ "label":"주요 결과", "items":[ {"key":"stress","label":"발생 응력","type":"number"}, {"key":"unit","label":"단위","type":"text"} ] }`',
      'content : `{ "stress": 100, "unit": "MPa" }`   // ← 각 item.key 가 그대로 top-level 키. `values` 같은 래퍼 절대 금지.',
      'item.type 은 text | number | integer | date | select 중 하나. `multi: true` 항목의 값은 배열 (예: `"defect_type": ["크랙","변형"]`).',
    ].join('\n'),
  },
  {
    types: ['bulleted_list'],
    body: [
      '### bulleted_list (글머리 리스트)  ★ 자주 틀리는 형식 — 주의 ★',
      'props (required: label) : `{ "label": "후속 검토 사항" }`',
      'content : `{ "items": [ "첫째 항목", "둘째 항목", "셋째 항목" ] }`   // ← 문자열 배열. {text, depth} 객체 절대 금지.',
    ].join('\n'),
  },
  {
    types: ['table'],
    body: [
      '### table (표)',
      'props (required: label, columns) : `{ "label":"검토 내용", "columns":[ {"key":"category","label":"구분","type":"text"}, {"key":"amount","label":"금액","type":"number"} ] }`',
      'content : `{ "rows":[ {"category":"배경","amount":1200}, {"category":"결과","amount":3400} ] }`   // 행 객체의 키 = column.key',
    ].join('\n'),
  },
  {
    types: ['chart'],
    body: [
      '### chart (차트 — 카테고리 x축)',
      'props (required: label) : `{ "label":"월별 매출", "chart_type":"line", "x_column_key":"month", "columns":[ {"key":"month","label":"월","type":"text"}, {"key":"sales","label":"매출","type":"number"} ] }`',
      'content : `{ "rows":[ {"month":"1월","sales":120}, {"month":"2월","sales":135} ] }`',
      '※ x_column_key 가 가리키는 열 외에 모든 열은 type:"number" 여야 합니다.',
      '※ x 도 숫자라면 chart 대신 **scatter** 를 사용하세요 (산점도 / 곡선 / 회귀).',
    ].join('\n'),
  },
  {
    types: ['scatter'],
    body: [
      '### scatter (산점도 — x·y 모두 수치)',
      'props (required: label, mode, x_column_key, columns≥2) : `{ "label":"전압-전류 곡선", "mode":"scatter_line", "x_column_key":"voltage", "columns":[ {"key":"voltage","label":"전압(V)","type":"number"}, {"key":"current","label":"전류(A)","type":"number"} ] }`',
      'content : `{ "rows":[ {"voltage":0,"current":0}, {"voltage":1.0,"current":0.5}, {"voltage":2.0,"current":1.1} ] }`',
      '- chart 와 달리 x·y **모두 type:"number"**. category 가 섞이면 chart 위젯을 쓰세요.',
      '- mode 는 `scatter`(점만) | `line`(선만) | `scatter_line`(점 + 선).',
      '- 시리즈를 명시적으로 지정하려면 content 에 `"series":[ {"label":"측정","x_key":"voltage","y_key":"current"} ]`. 생략 시 x_column_key 외 모든 number 열이 자동 시리즈가 됩니다.',
      '- props 에 x_axis_title / y_axis_title (선택) 로 축 라벨, content 에 x_min/x_max/y_min/y_max (선택) 로 범위 고정 가능.',
    ].join('\n'),
  },
  {
    types: ['scatter3d'],
    body: [
      '### scatter3d (3D 산점도 — Plotly)',
      'props (required: label, columns≥3) : `{ "label":"파라미터 응답면", "columns":[ {"key":"p1","label":"P1","type":"number"}, {"key":"p2","label":"P2","type":"number"}, {"key":"resp","label":"응답","type":"number"} ] }`',
      'content : `{ "mode":"scatter3d", "series":[ {"label":"실험","kind":"scatter3d","x_key":"p1","y_key":"p2","z_key":"resp"} ], "rows":[ {"p1":0,"p2":0,"resp":1.2}, {"p1":0.5,"p2":0.3,"resp":2.4} ], "colorscale":"Viridis" }`',
      '- 모든 컬럼은 type:"number" (3D 좌표). 회전·확대·호버는 Plotly 기본 제공.',
      '- series.kind 는 `scatter3d`(마커 구름) | `surface`(long-form 데이터를 그리드로 pivot 한 응답면). 한 차트에 둘 다 섞어도 OK.',
      '- 4번째 컬럼을 더해 `"color_key":"<key>"` 를 series 에 추가하면 마커/표면을 그 값으로 색상 매핑.',
      '- colorscale 은 `Viridis | Plasma | Cividis | Hot | Blues | Reds | Greens | RdBu | Bluered | Portland | Jet` 중 하나 (위젯 전체에 1개).',
    ].join('\n'),
  },
  {
    types: ['heatmap'],
    body: [
      '### heatmap (히트맵 — 2D 매트릭스)',
      'props (required: label) : `{ "label":"민감도 분석", "x_axis_title":"파라미터", "y_axis_title":"사양" }`',
      'content : `{ "x_labels":["A","B","C"], "y_labels":["사양1","사양2"], "matrix":[[0.1,0.4,0.7],[0.3,0.6,0.9]], "colorscale":"Viridis" }`',
      '- 데이터는 (행, 열) 의 2-D 매트릭스 — chart/scatter 의 columns+rows 모델과 **다릅니다**.',
      '- matrix[i] 는 y_labels[i] 행. matrix[i][j] 는 (y_labels[i], x_labels[j]) 셀 값.',
      '- 길이 일치 필수: matrix.length === y_labels.length, matrix[*].length === x_labels.length.',
      '- 빈 셀은 `null` (sparse data 도 OK — Plotly 가 갭으로 표시). reverse_scale:true 로 색상 반전.',
      '- z_min / z_max (선택) 로 색축 범위 고정 — 여러 히트맵 비교 시 유용.',
      '- colorscale 은 scatter3d 와 동일 enum.',
    ].join('\n'),
  },
  {
    types: ['radar'],
    body: [
      '### radar (레이더 차트 — 다축 폴라 비교)',
      'props (required: label) : `{ "label":"제품 비교" }`',
      'content : `{ "axis_labels":["속도","효율","가격","유지보수","확장성"], "series":[ {"label":"A안"}, {"label":"B안"} ], "values":[[90,75],[80,85],[60,90],[70,80],[85,70]] }`',
      '- axis_labels 는 각 폴라 축 라벨 (3개 이상 권장).',
      '- series 의 color (선택) 는 hex/CSS 컬러; 미지정 시 회전 팔레트 자동 적용.',
      '- values 는 **`values[축_index][시리즈_index]`** 형식의 2D 배열. values.length === axis_labels.length, values[*].length === series.length.',
      '- value_min / value_max (선택) 로 반경 범위 고정. fill_opacity (0~1, 기본 0.3) 로 폴리곤 채움 강도.',
      '- 사양 비교 / 평가표 / 다요소 점수에 적합. 비교 항목이 1개면 bulleted_list 가 더 어울립니다.',
    ].join('\n'),
  },
  {
    types: ['milestone'],
    body: [
      '### milestone (마일스톤)',
      'props (required: label) : `{ "label":"프로젝트 일정" }`',
      'content : `{ "items":[ {"date":"2026-01-15","label":"기획","status":"done"}, {"date":"2026-03-01","label":"개발","status":"pending","note":"인력 보강 필요"} ] }`',
      'status 는 `pending` | `done` | `delayed` 셋 중 하나. (in_progress / planned 등 다른 값 사용 금지)',
    ].join('\n'),
  },
  {
    types: ['flowchart'],
    body: [
      '### flowchart (플로우차트)',
      'props (required: label) : `{ "label":"검토 흐름", "orientation":"horizontal" }`   // orientation: horizontal | vertical',
      'content : `{ "items":[ {"label":"요구사항"}, {"label":"설계"}, {"label":"검토","description":"리뷰 미팅"}, {"label":"승인"} ] }`',
      '※ 순차 흐름만 지원. `nodes` / `edges` 같은 키 사용 금지.',
    ].join('\n'),
  },
  {
    types: ['progress_bar'],
    body: [
      '### progress_bar (진행률 바)',
      'props (required: label) : `{ "label":"작업 진척도", "default_max":100, "unit":"%" }`   // default_max / unit 은 선택. 기본 100% 기준이면 둘 다 생략 가능',
      'content : `{ "items":[ {"label":"기획","value":100}, {"label":"개발","value":65}, {"label":"테스트","value":20,"max":40,"note":"케이스 부족"} ] }`',
      '- value 는 현재값(숫자), max 는 목표값(생략하면 props.default_max 사용). 비율(value/max) 에 따라 색상이 자동: <30% 빨강, 30–70% 주황, 70% 이상 초록, 100% 이상 진초록.',
      '- status(선택)는 `pending` | `in_progress` | `done` | `blocked` 중 하나. 지정하면 자동 색상보다 우선.',
      '- 단순 % 가 아닌 절대값 비교(예: "8 / 12 건")도 가능 — props.unit 을 "건" 등으로 바꾸고 item.max 를 명시.',
      '- 여러 작업·지표의 진척도를 한 번에 비교할 때 사용. 단일 KPI 면 key_value 가 더 어울립니다.',
    ].join('\n'),
  },
  {
    types: ['raci_matrix'],
    body: [
      '### raci_matrix (RACI 매트릭스)',
      'props (required: label) : `{ "label":"역할 분담" }`   // default_roles 는 선택 (보고서별로 content.roles 가 우선)',
      'content : `{ "roles":[ {"key":"modeling","label":"모델링"}, {"key":"analysis","label":"분석"}, {"key":"develop","label":"개발"}, {"key":"design","label":"설계"} ], "rows":[ {"label":"요구사항 정의","assignments":{"modeling":"I","analysis":"R/A","develop":"C","design":"C"}}, {"label":"시스템 모델링","assignments":{"modeling":"R/A","analysis":"C","develop":"I","design":"C"}}, {"label":"구현","assignments":{"modeling":"I","analysis":"I","develop":"R/A","design":"C"}} ] }`',
      '- roles 는 content 안에 둡니다 (props 가 아님). key 는 영문 소문자/숫자/_ 만, 페이지 내에서 고유.',
      '- role 의 `group` (선택)은 상단 헤더 그룹 라벨. 같은 group 의 **인접한** 역할들이 자동으로 한 셀로 병합 (colspan).',
      '- assignments 의 키는 content.roles 의 key 와 정확히 일치해야 함. 알 수 없는 키 사용 금지.',
      '- 셀 값은 `R`(실무) | `A`(책임) | `C`(자문) | `I`(공유) 중 하나 또는 `/` 로 결합 (예: `R/A`). 스키마 값은 영문자, 화면 표시는 자동으로 한국어("실무 / 책임")로 변환됩니다.',
      '- R = 실무(실제 작업), A = 책임(최종 책임자, 한 행에 1명), C = 자문(의견 제공), I = 공유(결과 통지).',
      '- 표준: 한 행에 A 는 1명만 (책임자 단일화). R 은 여러 명 가능. C/I 는 자유.',
    ].join('\n'),
  },
  {
    types: ['image', 'attachment', 'cad_3d'],
    body: [
      '### image / attachment / cad_3d  ★ AI 가 만들지 마세요 ★',
      '세 위젯 모두 content 가 시스템에 업로드된 파일의 `file_id` 를 요구합니다. AI 는 file_id 를 알 수 없으므로 이 위젯들은 `extra_blocks` / `content` 양쪽 모두에서 생성하지 마세요. 이미지·첨부·3D 모델이 필요하다는 점만 본문 rich_text 에 메모해 두세요. (사용자가 보고서를 받은 뒤 직접 추가합니다.)',
    ].join('\n'),
  },
]

const WIDGET_EXAMPLES_TEXT = [
  '※ 모든 예시는 백엔드 스키마와 1:1 로 일치합니다. 키 이름·타입을 절대 변형하지 마세요.',
  ...WIDGET_PROMPT_EXAMPLES.map((e) => e.body),
].join('\n\n')

// Widget types the prompt's examples block covers. Used by the
// AiPromptDialog sidebar to flag catalog widgets without examples
// (rendered as a red "미등록" row). Auto-derived — adding a new entry
// to WIDGET_PROMPT_EXAMPLES is enough.
const PROMPT_COVERED_WIDGETS = new Set(
  WIDGET_PROMPT_EXAMPLES.flatMap((e) => e.types),
)

/** Prefix every line of `s` with `n` spaces. Used by buildAiPrompt so
 *  nested JSON renders cleanly under bullet headings. */
function indent(s, n) {
  const pad = ' '.repeat(n)
  return s.split('\n').map((line) => pad + line).join('\n')
}

/** Render the admin-managed 단락 구분 taxonomy as a plain-text block
 *  the AI can read. `categories` is the same `sectionCategories` array
 *  the page already holds (see useSectionTaxonomy); each entry has a
 *  name and an ordered `items` list. The output groups items under
 *  their category and shows `code: label (영문명: en)` per line so the
 *  AI must use the exact `code` string (not the Korean label) when
 *  filling `block_sections`. */
function renderSectionTaxonomy(categories) {
  const list = Array.isArray(categories) ? categories : []
  if (list.length === 0) {
    return '(아직 등록된 단락 구분이 없습니다. `block_sections` 는 `{}` 로 비워두세요.)'
  }
  return list
    .map((cat) => {
      const items = Array.isArray(cat.items) ? cat.items : []
      if (items.length === 0) {
        return `### ${cat.name} (slug=${cat.slug})\n  (등록된 항목 없음)`
      }
      const lines = items.map((it) => {
        const en = it.en ? `  (영문명: ${it.en})` : ''
        return `  - \`${it.code}\` : ${it.label}${en}`
      })
      return `### ${cat.name} (slug=${cat.slug})\n${lines.join('\n')}`
    })
    .join('\n\n')
}

/** Surfaces the generated AI prompt in a read-only textarea with a
 *  "복사" button. The prompt is rebuilt every time the dialog opens so
 *  it reflects the latest draft / catalog state. */
function AiPromptDialog({ open, onOpenChange, getPrompt, title, description, widgetCatalog }) {
  const [text, setText] = useState('')
  useEffect(() => {
    if (open) setText(getPrompt())
  }, [open, getPrompt])

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text)
      toast.success('프롬프트를 클립보드에 복사했습니다.')
    } catch {
      toast.error('클립보드 복사에 실패했습니다. 직접 선택해 복사해 주세요.')
    }
  }

  // Bucket the catalog into "covered by the prompt's examples block"
  // vs "not covered yet" so the sidebar can highlight gaps. Catalog
  // entries the prompt knows about are listed first; anything else
  // surfaces in a red 미등록 group so new widget types stand out.
  const widgetCoverage = (() => {
    const widgets = widgetCatalog?.widgets ?? []
    const covered = []
    const uncovered = []
    for (const w of widgets) {
      if (PROMPT_COVERED_WIDGETS.has(w.type)) covered.push(w)
      else uncovered.push(w)
    }
    return { covered, uncovered, total: widgets.length, loading: !widgetCatalog }
  })()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" />
            {title ?? 'AI 프롬프트 — 보고서 JSON 생성'}
          </DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          {description ?? '아래 프롬프트를 AI에 보내고, 보고서 본문을 함께 입력하면 JSON 결과를 받을 수 있습니다. 그 JSON 을 “JSON 데이터 붙여넣기”로 다시 불러오세요.'}
        </p>
        <div className="flex-1 min-h-0 flex gap-3">
          <WidgetCoverageSidebar coverage={widgetCoverage} />
          <Textarea
            readOnly
            value={text}
            onClick={(e) => e.currentTarget.select()}
            className="flex-1 min-h-[320px] font-mono text-[11px] leading-relaxed"
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            닫기
          </Button>
          <Button size="sm" onClick={handleCopy}>
            <Copy className="mr-1 h-3 w-3" />
            복사
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Left-hand sidebar in AiPromptDialog: lists every catalog widget
 *  with a check (등록됨) or X (미등록) so developers can tell at a
 *  glance whether a newly-added widget type still needs an example
 *  section in buildAiPrompt / buildAiPromptV2. */
function WidgetCoverageSidebar({ coverage }) {
  const { covered, uncovered, total, loading } = coverage
  return (
    <div className="w-60 shrink-0 border rounded-md overflow-auto p-2 text-xs bg-muted/20">
      <div className="font-medium">위젯 등록 현황</div>
      <div className="text-[10px] text-muted-foreground mb-2">
        {loading
          ? '카탈로그 불러오는 중…'
          : `등록 ${covered.length} / 전체 ${total}`}
      </div>
      {covered.length > 0 && (
        <div className="space-y-0.5 mb-3">
          {covered.map((w) => (
            <WidgetCoverageRow key={w.type} widget={w} covered />
          ))}
        </div>
      )}
      {uncovered.length > 0 && (
        <>
          <div className="font-medium text-destructive mt-2">
            미등록 ({uncovered.length})
          </div>
          <div className="text-[10px] text-muted-foreground mb-1">
            프롬프트 examples 보강 필요
          </div>
          <div className="space-y-0.5">
            {uncovered.map((w) => (
              <WidgetCoverageRow key={w.type} widget={w} covered={false} />
            ))}
          </div>
        </>
      )}
      {!loading && total === 0 && (
        <div className="text-[10px] text-muted-foreground italic">
          위젯 카탈로그가 비어 있습니다.
        </div>
      )}
    </div>
  )
}

function WidgetCoverageRow({ widget, covered }) {
  return (
    <div
      className="flex items-start gap-1.5 py-0.5"
      title={widget.description || widget.label || widget.type}
    >
      {covered ? (
        <Check className="h-3 w-3 mt-0.5 text-emerald-600 shrink-0" />
      ) : (
        <X className="h-3 w-3 mt-0.5 text-destructive shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <div className="font-mono text-[10px] leading-tight truncate">
          {widget.type}
        </div>
        {widget.label && widget.label !== widget.type && (
          <div className="text-[10px] text-muted-foreground leading-tight truncate">
            {widget.label}
          </div>
        )}
      </div>
    </div>
  )
}

/** Pre-print step for "PDF로 저장". The body sizes in print are
 *  multiplied by `--print-scale` (set on documentElement by
 *  performPdfPrint), so picking a preset here changes the printed font
 *  density without touching screen rendering. Chart text is rendered
 *  into SVG via inline fontSize props so it won't scale with this
 *  variable — the dialog notes that limitation.
 */
const PDF_SCALE_PRESETS = [0.8, 0.9, 1.0, 1.1, 1.2]
function PdfPrintDialog({ open, onOpenChange, scale, onChangeScale, onConfirm }) {
  const [local, setLocal] = useState(scale ?? 1)
  useEffect(() => {
    if (open) setLocal(scale ?? 1)
  }, [open, scale])
  function handleConfirm() {
    onChangeScale(local)
    onConfirm(local)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>PDF 인쇄</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <div className="text-sm font-medium">글자 배율</div>
            <div className="flex gap-1.5">
              {PDF_SCALE_PRESETS.map((p) => {
                const active = Math.abs(p - local) < 0.001
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setLocal(p)}
                    className={cn(
                      'flex-1 rounded-md border px-2 py-2 text-sm transition-colors',
                      active
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-background hover:bg-muted',
                    )}
                  >
                    {Math.round(p * 100)}%
                  </button>
                )
              })}
            </div>
            <p className="text-[11px] text-muted-foreground">
              100% = 화면과 동일한 크기. 페이지에 더 많은 내용을 담으려면 80~90%,
              가독성 우선이면 110~120%를 추천합니다. 본문·차트·표 글자 모두
              같은 비율로 함께 조정됩니다.
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              취소
            </Button>
            <Button onClick={handleConfirm}>인쇄 진행</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Lets the user paste a `report_archive_draft_v1` JSON blob directly
 *  instead of uploading a file. Three commit modes — what differs is
 *  *where* the imported content lands:
 *   - 전체 교체           → replace the whole draft (title/date/tags
 *                          + every page).
 *   - 새 페이지로 추가     → keep current draft; the imported pages
 *                          land at the END of the page list as their
 *                          own pages.
 *   - 현재 페이지 끝에 추가 → flatten the imported widgets and slot
 *                          them into the CURRENT page's extra_blocks.
 *                          Current page's template + metadata stays.
 *
 *  Validation is delegated to the callback, which throws on schema
 *  mismatch; we surface the error inline so the user can fix the
 *  paste without closing the dialog. */
function PasteJsonDialog({
  open,
  onOpenChange,
  onReplace,
  onAppendNewPages,
  onAppendToCurrentPage,
}) {
  const [text, setText] = useState('')
  const [err, setErr] = useState('')
  useEffect(() => {
    if (open) {
      setText('')
      setErr('')
    }
  }, [open])

  function runWith(fn) {
    if (!text.trim()) {
      setErr('붙여넣을 JSON 내용이 비어 있습니다.')
      return
    }
    try {
      fn(text)
      onOpenChange(false)
    } catch (e) {
      setErr(e.message || '실패')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardPaste className="h-4 w-4" />
            JSON 데이터 붙여넣기
          </DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          AI 가 만들어 준 보고서 JSON 또는 다른 보고서에서 내보낸 JSON 을 그대로 붙여 넣으세요.
          (<code>_type=&quot;report_archive_draft_v1&quot;</code> 형식이어야 합니다.)
        </p>
        <Textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            if (err) setErr('')
          }}
          placeholder='{ "_type": "report_archive_draft_v1", ... }'
          className="flex-1 min-h-[280px] font-mono text-[11px] leading-relaxed"
        />
        <div className="text-[10px] text-muted-foreground leading-relaxed space-y-0.5">
          <div>
            <strong>전체 교체</strong>: 보고서 전체를 새 JSON 으로 교체 (제목·날짜·태그 포함).
          </div>
          <div>
            <strong>새 페이지로 추가</strong>: 기존 페이지는 유지, JSON 의 페이지들을 맨 뒤에 새 페이지로 붙임.
          </div>
          <div>
            <strong>현재 페이지 끝에 추가</strong>: 기존 페이지·구조 유지, JSON 의 위젯들을 지금 보고 있는 페이지의 끝에 합침. (id 충돌은 자동 회피)
          </div>
        </div>
        {err && (
          <p className="text-xs text-destructive whitespace-pre-wrap">{err}</p>
        )}
        <div className="flex justify-end gap-2 pt-2 flex-wrap">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            취소
          </Button>
          {onAppendToCurrentPage && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => runWith(onAppendToCurrentPage)}
              title="현재 페이지의 extra_blocks 에 위젯을 추가 (페이지 늘리지 않음)"
            >
              <Plus className="mr-1 h-3 w-3" />
              현재 페이지 끝에 추가
            </Button>
          )}
          {onAppendNewPages && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => runWith(onAppendNewPages)}
              title="JSON 의 페이지들을 그대로 뒤에 새 페이지로 추가"
            >
              <Plus className="mr-1 h-3 w-3" />
              새 페이지로 추가
            </Button>
          )}
          <Button size="sm" onClick={() => runWith(onReplace)} title="보고서 전체를 교체">
            <Upload className="mr-1 h-3 w-3" />
            전체 교체
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** "템플릿으로 저장" dialog. Captures only the form metadata; the page-to-
 *  schema conversion (props + layout merging, blocks_order, extras) lives
 *  in the parent's onSaveAsTemplate handler so it can reach pageTemplate
 *  caches without prop-drilling. Slug is required (templates use it as
 *  a permanent id); name + description + category mirror the template
 *  editor's create dialog. */
function SaveAsTemplateDialog({
  open,
  onOpenChange,
  sourceTitle,
  sourceTemplate,
  pageCount,
  currentPageIndex,
  onConfirm,
}) {
  // Template id is auto-generated as a UUID on every open, mirroring the
  // template-editor's "new template" flow. The user never edits it.
  const [templateId, setTemplateId] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const { data: categories } = useAsync(() => listTemplateCategories(), [])
  const catList = categories ?? []

  useEffect(() => {
    if (!open) return
    setTemplateId(globalThis.crypto?.randomUUID?.() ?? fallbackUuidLocal())
    // Default the name to the source template's name with a suffix —
    // the user is most often making a variation of an existing template.
    const base = sourceTemplate?.name ?? sourceTitle ?? ''
    setName(base ? `${base} 사본` : '')
    setDescription('')
    setCategory(sourceTemplate?.category ?? '')
    setSubmitting(false)
  }, [open, sourceTitle, sourceTemplate])

  // Fall back to the first available category once the API responds, so
  // the dropdown isn't empty when the source template's category was
  // deleted (or when this is run on a template-less page somehow).
  useEffect(() => {
    if (!category && catList.length > 0) setCategory(catList[0].slug)
  }, [catList, category])

  async function handleSubmit(e) {
    e.preventDefault()
    if (!templateId.trim() || !name.trim()) return
    setSubmitting(true)
    try {
      await onConfirm({
        templateId: templateId.trim(),
        name: name.trim(),
        description: description.trim(),
        category: category || 'misc',
      })
    } catch {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>템플릿으로 저장</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="rounded-md border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground leading-relaxed">
            현재 페이지의 <strong>위젯 배치</strong>만 새 템플릿으로 저장됩니다.
            입력된 데이터(텍스트·표·차트 값 등)는 포함되지 않습니다.
            {pageCount > 1 && (
              <>
                <br />
                이 보고서는 {pageCount}페이지입니다 — <strong>페이지 {currentPageIndex + 1}</strong>
                만 저장됩니다.
              </>
            )}
          </div>

          <div className="space-y-1.5">
            <label htmlFor="tpl-slug" className="text-sm font-medium">
              템플릿 ID
            </label>
            <Input
              id="tpl-slug"
              value={templateId}
              readOnly
              className="font-mono text-[11px] bg-muted/40"
            />
            <p className="text-[11px] text-muted-foreground">
              자동 발급된 UUID. 발행 후 변경 불가.
            </p>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="tpl-name" className="text-sm font-medium">
              이름
            </label>
            <Input
              id="tpl-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="주간 R&D 보고 (사본)"
              required
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="tpl-desc" className="text-sm font-medium">
              설명 (선택)
            </label>
            <Input
              id="tpl-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="예: 모바일팀용 주간 보고"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="tpl-cat" className="text-sm font-medium">
              카테고리
            </label>
            <select
              id="tpl-cat"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              {catList.length === 0 && <option value="">misc</option>}
              {catList.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {c.name} ({c.slug})
                </option>
              ))}
            </select>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              취소
            </Button>
            <Button
              type="submit"
              disabled={submitting || !templateId.trim() || !name.trim()}
            >
              {submitting ? '저장 중...' : '저장'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
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

/** Header chip shown in view mode when someone else is currently editing
 *  this report. Renders the holder's name + a relative timestamp of when
 *  they last interacted (acquire / heartbeat). Tooltip carries the email
 *  for disambiguation when two users share a display name. */
function LockHolderChip({ holder }) {
  if (!holder) return null
  const name = holder.user_name || holder.user_email || `사용자 #${holder.user_id}`
  const rel = formatRelativeTime(holder.acquired_at)
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-amber-500/60 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-900"
      title={holder.user_email ? `${name} <${holder.user_email}>` : name}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
      {name} 편집 중
      {rel && <span className="text-amber-800/70"> · {rel}</span>}
    </span>
  )
}

function formatRelativeTime(iso) {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  const secs = Math.max(0, Math.floor((Date.now() - t) / 1000))
  if (secs < 30) return '방금'
  if (secs < 60) return `${secs}초 전`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}분 전`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}시간 전`
  return `${Math.floor(hours / 24)}일 전`
}

/** Confirmation dialog shown when the user clicks 편집 on a report that
 *  someone else currently holds. Open is driven by the `holder` prop —
 *  truthy holder = dialog visible; null = dismissed. Confirming triggers
 *  a force-takeover acquire (the prior holder will be bounced on their
 *  next heartbeat or save). */
function TakeoverLockDialog({ holder, onCancel, onConfirm }) {
  const open = Boolean(holder)
  const name = holder?.user_name || holder?.user_email || (holder ? `사용자 #${holder.user_id}` : '')
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onCancel() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>편집 권한 인계</DialogTitle>
        </DialogHeader>
        <p className="text-sm">
          현재{' '}
          <span className="font-semibold">{name}</span>
          {' '}님이 이 보고서를 편집 중입니다
          {holder?.acquired_at && (
            <span className="text-muted-foreground"> ({formatRelativeTime(holder.acquired_at)} 시작)</span>
          )}
          .
        </p>
        <p className="text-xs text-muted-foreground">
          강제로 인계받으면 현재 편집자는 다음 저장 시 “편집 권한이 없습니다” 안내를 받고
          보기 모드로 전환됩니다. 그가 작성 중이던 변경사항은 사라질 수 있습니다.
        </p>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={onCancel}>
            취소 (그냥 보기)
          </Button>
          <Button size="sm" onClick={onConfirm}>
            강제 인계 후 편집
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
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
    <div className="relative border-b bg-muted/30 report-detail-pagestrip">
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
  onAddExtraBlockAt,
  onRemoveBlock,
  onChangeExtraBlockProps,
  onChangeSection,
  sectionCategories,
  sectionItemByCode,
}) {
  // Per-page state for "edit widget props" — null when no panel is open,
  // otherwise the extra block's id. Lives here (not on each card) so a
  // right-click on one block closes any other open panel cleanly.
  const [propsEditingId, setPropsEditingId] = useState(null)
  // Same idea but for the "단락 구분" floating picker — non-null = open
  // with that block id as the target.
  const [sectionEditingId, setSectionEditingId] = useState(null)
  // Modal content editor — opened for non-inline-editable widgets when
  // their card is clicked in edit mode. Non-null = open with that
  // block id as the target. Inline-editable widgets (rich_text,
  // heading) don't go through this dialog at all.
  const [contentEditingId, setContentEditingId] = useState(null)
  // Context menu coords + target. Right-click on an extra block pops a
  // small menu here; click outside / Esc dismisses.
  const [contextMenu, setContextMenu] = useState(null)
  const blocks = useMemo(() => combinedBlocks(template, page), [template, page])

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
      // auto_fit per type:
      //   - graph / scatter / heatmap default to FALSE so the cell
      //     keeps a manually set size (Recharts/Plotly need a real
      //     height to paint, and a content-driven row_span snaps the
      //     chart small repeatedly during data edits)
      //   - everything else still defaults to TRUE (content-driven)
      // An explicit `auto_fit` in the saved layout always wins.
      const isAutoFit = autoFitForBlock(b, layout)
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
    <section
      id={`report-page-${pageIdx}`}
      className="space-y-3 report-detail-page"
    >
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
            // Same per-type default the effectiveLayouts computation
            // uses — without this lookup the card would always treat
            // an absent `auto_fit` as true, defeating the graph-widget
            // override.
            const autoFit = autoFitForBlock(block, effectiveLayouts[block.id])
            const isExtraBlock = block.source === 'extra'
            // Every block in edit mode is configurable: extras write back
            // to their own props, template blocks pile their changes onto
            // the page-level props_overrides for that block id. The
            // context menu is offered for any block in edit mode so users
            // can also reach 위젯 제거 via right-click.
            const canEditProps = isEditing && (
              isExtraBlock ? !!onChangeExtraBlockProps : !!onChangePropsOverride
            )
            const showContextMenu =
              isEditing && (canEditProps || !!onRemoveBlock || !!onChangeSection)
            const showInsertArrows = isEditing && !!onAddExtraBlockAt
            const blockColSpan = effectiveLayouts[block.id]?.col_span ?? REPORT_GRID_COLS
            // Horizontal insert is allowed when the row still has free
            // columns OR when the anchor is wide enough to be split in
            // half. Mirrors the logic inside addExtraBlockAt so the UI
            // never shows an arrow that would no-op.
            const blockRow = effectiveLayouts[block.id]?.row
            const rowUsed = Number.isFinite(blockRow)
              ? blocks.reduce(
                  (sum, b) =>
                    effectiveLayouts[b.id]?.row === blockRow
                      ? sum + (effectiveLayouts[b.id]?.col_span ?? 0)
                      : sum,
                  0,
                )
              : REPORT_GRID_COLS
            const rowHasRoom = rowUsed < REPORT_GRID_COLS
            const canInsertHorizontally = rowHasRoom || blockColSpan >= 2
            return (
              <div
                key={block.id}
                // `group/insert` scopes the hover state to this block's
                // wrapper so DirectionalAddArrows only lights up over the
                // hovered card, not its neighbors.
                className="min-w-0 h-full relative group/insert"
                onContextMenu={
                  showContextMenu
                    ? (e) => {
                        e.preventDefault()
                        setContextMenu({ x: e.clientX, y: e.clientY, blockId: block.id })
                      }
                    : undefined
                }
              >
                <BlockEditorCard
                  block={block}
                  content={page?.content?.[block.id]}
                  propsOverride={page?.props_overrides?.[block.id] ?? null}
                  active={isActive}
                  readOnly={!isEditing}
                  showDragHandle={isEditing}
                  autoFit={autoFit}
                  isExtra={isExtraBlock}
                  sectionCode={resolveBlockSection(page, block)}
                  sectionItemByCode={sectionItemByCode}
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
                  onRemove={
                    isEditing && onRemoveBlock
                      ? () => onRemoveBlock(block.id)
                      : undefined
                  }
                  onOpenProps={canEditProps ? () => setPropsEditingId(block.id) : undefined}
                  onOpenContentEdit={
                    isEditing && !INLINE_EDITABLE_WIDGETS.has(block.type)
                      ? () => setContentEditingId(block.id)
                      : undefined
                  }
                  onMeasureContentHeight={(px) =>
                    onMeasureContentHeight?.(block.id, px)
                  }
                  onMeasureEditHeight={(px) => handleMeasureEdit(block.id, px)}
                />
                {showInsertArrows && (
                  <DirectionalAddArrows
                    blockId={block.id}
                    canInsertHorizontally={canInsertHorizontally}
                    onAdd={(type, defaults, direction) =>
                      onAddExtraBlockAt(type, defaults, block.id, direction)
                    }
                  />
                )}
              </div>
            )
          })}
        </ResizableGrid>
      )}

      {/* Widget add UI moved to a floating button at the page bottom-right
          (FloatingAddWidget at ReportDetailPage root) so the writer
          doesn't have to scroll to the end of every page to find it. */}

      {contextMenu && (
        <BlockContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onEditProps={() => {
            setPropsEditingId(contextMenu.blockId)
            setContextMenu(null)
          }}
          onEditSection={
            onChangeSection
              ? () => {
                  setSectionEditingId(contextMenu.blockId)
                  setContextMenu(null)
                }
              : undefined
          }
          onRemove={
            onRemoveBlock
              ? () => {
                  onRemoveBlock(contextMenu.blockId)
                  setContextMenu(null)
                }
              : undefined
          }
        />
      )}

      {sectionEditingId && (() => {
        const target = blocks.find((b) => b.id === sectionEditingId)
        const current = resolveBlockSection(page, target)
        return (
          <SectionPickerDialog
            open
            categories={sectionCategories}
            currentSection={current}
            onPick={(code) => onChangeSection?.(sectionEditingId, code)}
            onClear={() => onChangeSection?.(sectionEditingId, null)}
            onClose={() => setSectionEditingId(null)}
          />
        )
      })()}

      {propsEditingId && (() => {
        const block = blocks.find((b) => b.id === propsEditingId)
        if (!block) return null
        const isExtraBlock = block.source === 'extra'
        // For template blocks, the dialog edits the effective (template
        // ∪ override) props and saves the full result back as the
        // page-level override for that block. Extras write back to their
        // own props directly.
        const override = page?.props_overrides?.[block.id] ?? null
        const effective = isExtraBlock
          ? block.props
          : { ...(block.props ?? {}), ...(override ?? {}) }
        return (
          <BlockPropsDialog
            block={block}
            initialProps={effective}
            isExtra={isExtraBlock}
            onChange={(newProps) => {
              if (isExtraBlock) {
                onChangeExtraBlockProps?.(block.id, newProps)
              } else {
                // Replace the entire override for this template block.
                // PropsPanel hands back the complete next props object,
                // so any subset of fields that match the template stays
                // in the override too — that's fine, the backend's
                // sanitizer only prunes empty dicts.
                onChangePropsOverride?.(block.id, newProps)
              }
            }}
            onClose={() => setPropsEditingId(null)}
          />
        )
      })()}

      {contentEditingId && (() => {
        const block = blocks.find((b) => b.id === contentEditingId)
        if (!block) return null
        // Mirror the inline path's "effective props" computation so the
        // modal editor renders with the same effective_props the saved
        // view does — text_style etc. propagate identically.
        const override = page?.props_overrides?.[block.id] ?? null
        const effective = mergePropsWithOverride(block.props, override)
        return (
          <WidgetContentEditDialog
            block={block}
            effectiveProps={effective}
            initialContent={page?.content?.[block.id]}
            initialPropsOverride={override}
            onApply={({ content: nextContent, propsOverride: nextOverride }) => {
              // Commit content first, then props override (the order
              // doesn't actually matter — they're independent slices —
              // but doing content first matches what onChange/onChangePropsOverride
              // do in the inline flow).
              onChangeContent?.(block.id, nextContent)
              if (block.source === 'extra') {
                // Extras don't use props_overrides; they own their props
                // directly. The editor handed us the merged override
                // shape, but for extras we route it to extra-block props.
                if (nextOverride) {
                  onChangeExtraBlockProps?.(block.id, {
                    ...block.props,
                    ...nextOverride,
                  })
                }
              } else {
                onChangePropsOverride?.(block.id, nextOverride)
              }
              setContentEditingId(null)
            }}
            onClose={() => setContentEditingId(null)}
          />
        )
      })()}
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

/** Parse + validate a `report_archive_draft_v1` payload. Returns the
 *  parsed object on success; throws with a user-readable message on
 *  any structural problem so the dialog caller can show it inline. */
function parseImportPayload(text) {
  const obj = JSON.parse(text)
  if (obj?._type !== 'report_archive_draft_v1') {
    throw new Error('지원하지 않는 형식입니다. (_type=report_archive_draft_v1 이어야 합니다.)')
  }
  if (!Array.isArray(obj.pages) || obj.pages.length === 0) {
    throw new Error('페이지 데이터가 비어 있습니다.')
  }
  return obj
}

function normalizePage(p) {
  return {
    template_id: p.template_id,
    template_version: p.template_version,
    name: p.name ?? null,
    content: p.content ?? {},
    layout_overrides: p.layout_overrides ?? null,
    props_overrides: p.props_overrides ?? null,
    extra_blocks: Array.isArray(p.extra_blocks) ? p.extra_blocks : [],
    blocks_order: Array.isArray(p.blocks_order) ? p.blocks_order : [],
    block_sections:
      p.block_sections && typeof p.block_sections === 'object'
        ? { ...p.block_sections }
        : {},
  }
}

/**
 * Reads blocks from a widget-v1 template schema. Each block becomes a
 * navigable card in the report editor. Annotated with `source='template'`
 * so callers can tell template-defined blocks apart from per-page
 * `extra_blocks` added at write time.
 */
function extractBlocks(schema) {
  const blocks = Array.isArray(schema?.blocks) ? schema.blocks : []
  return blocks.map((b) => ({
    id: b.id,
    title: b.props?.label || b.props?.default_text || b.id,
    type: b.type,
    props: b.props ?? {},
    layout: b.layout,
    source: 'template',
    // Default 단락 구분 baked into the template. Reports override via
    // `page.block_sections[block.id]` (absent = use this, null =
    // explicit clear, string = explicit pick).
    section: typeof b.section === 'string' && b.section.length > 0 ? b.section : null,
  }))
}

/** Floating right-click menu for an extra block. Positioned at the
 *  triggering mouse coords; dismisses on any click outside or Esc.
 *  Kept as a vanilla div + portal-less render — radix-ui doesn't ship
 *  a context-menu primitive in this project and a single item doesn't
 *  warrant pulling one in. */
function BlockContextMenu({ x, y, onClose, onEditProps, onEditSection, onRemove }) {
  useEffect(() => {
    function handleClick() { onClose() }
    function handleKey(e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('mousedown', handleClick)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('mousedown', handleClick)
      window.removeEventListener('keydown', handleKey)
    }
  }, [onClose])
  return (
    <div
      className="fixed z-50 min-w-[180px] rounded-md border bg-popover py-1 shadow-md"
      style={{ left: x, top: y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={onEditProps}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted text-left"
      >
        <Settings2 className="h-3.5 w-3.5" />
        속성 편집
      </button>
      {onEditSection && (
        <button
          type="button"
          onClick={onEditSection}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted text-left"
        >
          <Bookmark className="h-3.5 w-3.5" />
          단락 구분
        </button>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-destructive/10 text-destructive text-left"
        >
          <Trash2 className="h-3.5 w-3.5" />
          위젯 제거
        </button>
      )}
    </div>
  )
}

/** Right-click menu surfaced by the report wrapper itself — distinct from
 *  the per-block menu above. Lives at the page level so it can drive
 *  page-wide settings (currently just 폭, but the settings dialog hosts a
 *  tab structure to accumulate more without a UI redesign). Same dismiss
 *  behavior as BlockContextMenu so the two feel like one system. */
function PageContextMenu({ x, y, onClose, onOpenSettings }) {
  useEffect(() => {
    function handleClick() { onClose() }
    function handleKey(e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('mousedown', handleClick)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('mousedown', handleClick)
      window.removeEventListener('keydown', handleKey)
    }
  }, [onClose])
  return (
    <div
      className="fixed z-50 min-w-[180px] rounded-md border bg-popover py-1 shadow-md"
      style={{ left: x, top: y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={onOpenSettings}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted text-left"
      >
        <Settings2 className="h-3.5 w-3.5" />
        보고서 설정
      </button>
    </div>
  )
}

/** Modal that surfaces the widget's PropsPanel — the same component the
 *  template editor uses — so users can configure structural props (table
 *  columns, KV items, KPI label/unit, etc.) per-report. Works for both
 *  flavors of block:
 *   - extra blocks: edits write straight to extra_blocks[i].props
 *   - template blocks: edits write to page.props_overrides[block.id] as a
 *     full props snapshot (the backend folds it back over the template
 *     props at content-validation time)
 *  The caller picks where to route via the `onChange` it hands in. */
function BlockPropsDialog({ block, initialProps, isExtra, onChange, onClose }) {
  const renderer = getRenderer(block.type)
  const PropsPanel = renderer?.PropsPanel
  // Local working copy — PropsPanel hands back full props on every edit,
  // and we mirror it here so the panel remains responsive even though
  // the parent only re-reads on close.
  const [draft, setDraft] = useState(initialProps ?? {})
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings2 className="h-4 w-4" />
            위젯 속성 — {block.type}
            {!isExtra && (
              <Badge variant="outline" className="text-[10px] ml-1">
                템플릿 블록
              </Badge>
            )}
          </DialogTitle>
        </DialogHeader>
        {PropsPanel ? (
          <PropsPanel
            props={draft}
            onChange={(nextProps) => {
              setDraft(nextProps)
              onChange?.(nextProps)
            }}
          />
        ) : (
          <p className="text-sm text-muted-foreground py-4">
            이 위젯 종류는 편집 가능한 속성이 없습니다.
          </p>
        )}
        {!isExtra && (
          <p className="text-[11px] text-muted-foreground border-t pt-2">
            이 변경은 이 보고서에만 적용됩니다. 원본 템플릿은 그대로 유지됩니다.
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** Modal editor for widget *content*. Hosts the widget's own Editor
 *  with a local draft so typed changes don't reach the report state
 *  until the user clicks 적용 (the user can cancel out and discard).
 *  Used for every widget except the inline-editable ones (rich_text,
 *  heading) — their editing surfaces are tightly integrated with the
 *  document flow so editing inline is the right shape there.
 *
 *  The dialog reuses the same Editor component the inline path uses;
 *  the only differences are (a) it sits inside a modal with its own
 *  comfortable width, and (b) the onChange wires into local state so
 *  the report doesn't see partial typing. */
function WidgetContentEditDialog({
  block,
  effectiveProps,
  initialContent,
  initialPropsOverride,
  onApply,
  onClose,
}) {
  const renderer = getRenderer(block.type)
  const Editor = renderer?.Editor
  const [draftContent, setDraftContent] = useState(initialContent)
  // Some widgets (currently just Chart) can ask to mutate their own
  // props from inside the editor. We buffer those too so cancel really
  // means "nothing happened".
  const [draftPropsOverride, setDraftPropsOverride] = useState(initialPropsOverride)
  // Compute the props shown to the editor by re-merging the buffered
  // override on every render — the editor receives `effectiveProps` so
  // its UI reflects in-flight changes.
  const editorProps = mergePropsWithOverride(block.props, draftPropsOverride)
  function apply() {
    onApply({
      content: draftContent,
      // Treat empty {} the same as "no override" so we don't leave
      // an empty key in props_overrides.
      propsOverride:
        draftPropsOverride && Object.keys(draftPropsOverride).length > 0
          ? draftPropsOverride
          : null,
    })
  }
  if (!Editor) {
    // Defensive — should never happen because the card click handler
    // only fires for widgets that have a renderer.
    return null
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      {/* 80% of the viewport in both dimensions — chart in particular
          benefits from a large editing surface (the in-grid cell is
          much smaller than the modal). Tailwind `max-w-*` defaults on
          DialogContent are explicitly overridden to keep the 80vw / 80vh
          authoritative. */}
      <DialogContent
        className="w-[80vw] h-[80vh] max-w-[80vw] sm:max-w-[80vw] overflow-hidden flex flex-col"
        style={{ maxHeight: '80vh' }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="h-4 w-4" />
            위젯 편집 — {renderer.label ?? block.type}
          </DialogTitle>
        </DialogHeader>
        {/* No outer scroll wrapper — widgets that need horizontal /
            vertical scrolling own that internally (Chart splits into
            its own left/right panel with the right panel scrollable;
            table widgets use their own overflow-x-auto wrappers). A
            blanket overflow-y-auto here collapsed `flex: 1` heights
            for chart-like widgets that need to fit-to-container. */}
        <div className="flex-1 min-h-0 flex flex-col report-widget-body">
          <Editor
            props={editorProps ?? effectiveProps}
            content={draftContent}
            onChange={setDraftContent}
            onChangePropsOverride={(patch) => {
              // Mirror the live report's "replace with full props" wire
              // contract — the editor hands us a complete props object
              // (or a patch on top of the previous override; we treat
              // it as the next full override).
              setDraftPropsOverride(patch)
            }}
            // autoFit is meaningful only for the in-grid cell sizing
            // pipeline. The dialog has a definite (80vh) height + flex
            // chain — widgets that respect autoFit=false honor that
            // chain (chart fills its left panel; other widgets just
            // ignore the flag).
            autoFit={false}
            readOnly={false}
          />
        </div>
        <DialogFooter className="gap-2 sm:gap-2 pt-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            취소
          </Button>
          <Button size="sm" onClick={apply}>
            적용
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Hover-only "+ in this direction" affordance for an existing block.
 *  Four small circular buttons hug the block's edges and become visible
 *  while the parent (`group/insert`) is hovered. Clicking an arrow opens
 *  the standard widget catalog popover anchored to that arrow; picking
 *  a type calls `onAdd(type, defaults, direction)`.
 *
 *  Left/right arrows hide only when there's truly no horizontal room —
 *  the row is full AND the anchor can't be split. Up/down are always
 *  available. */
function DirectionalAddArrows({ canInsertHorizontally, onAdd }) {
  const { catalog, loading } = useWidgetCatalog()
  const [open, setOpen] = useState(null) // 'up' | 'down' | 'left' | 'right' | null
  if (loading) return null
  const widgets = catalog?.widgets ?? []
  function pick(direction, type, defaults) {
    onAdd(type, defaults, direction)
    setOpen(null)
  }
  // Common arrow button. The wrapper uses `pointer-events-none` while
  // hidden so it never blocks clicks on the block's own UI; the inner
  // Button re-enables them once visible.
  function Arrow({ direction, icon: Icon, positionClass, side, align }) {
    return (
      <Popover
        open={open === direction}
        onOpenChange={(o) => setOpen(o ? direction : null)}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            title="이 방향에 위젯 추가"
            // Stop the click from bubbling to the block's onActivate /
            // drag handlers — the arrow is purely a quick-add trigger.
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              'absolute z-20 flex h-6 w-6 items-center justify-center rounded-full',
              'border bg-background text-muted-foreground shadow-sm',
              'opacity-0 transition-opacity pointer-events-none',
              'hover:bg-primary hover:text-primary-foreground hover:border-primary',
              'group-hover/insert:opacity-100 group-hover/insert:pointer-events-auto',
              positionClass,
            )}
          >
            <Icon className="h-3 w-3" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side={side}
          align={align}
          sideOffset={6}
          // Width sized to fit all 5 category columns side by side. Radix
          // shifts the popover into view if a narrow viewport can't fit it.
          className="w-[760px] max-w-[92vw] p-2 max-h-[70vh] overflow-y-auto"
        >
          <WidgetPicker
            widgets={widgets}
            onSelect={(w) => pick(direction, w.type, w.default_props ?? {})}
          />
        </PopoverContent>
      </Popover>
    )
  }
  return (
    <>
      <Arrow
        direction="up"
        icon={ChevronUp}
        positionClass="-top-3 left-1/2 -translate-x-1/2"
        side="top"
        align="center"
      />
      <Arrow
        direction="down"
        icon={ChevronDown}
        positionClass="-bottom-3 left-1/2 -translate-x-1/2"
        side="bottom"
        align="center"
      />
      {canInsertHorizontally && (
        <Arrow
          direction="left"
          icon={ChevronLeft}
          positionClass="top-1/2 -left-3 -translate-y-1/2"
          side="left"
          align="center"
        />
      )}
      {canInsertHorizontally && (
        <Arrow
          direction="right"
          icon={ChevronRight}
          positionClass="top-1/2 -right-3 -translate-y-1/2"
          side="right"
          align="center"
        />
      )}
    </>
  )
}

/** Floating "위젯 추가" pill. Rendered inside the parent floating-action
 *  cluster (which owns the fixed positioning + the
 *  `report-detail-floating` class that exporters strip), so this
 *  component is just the Popover/Button — no positioning of its own. */
function FloatingAddWidget({ onAdd }) {
  const { catalog, loading } = useWidgetCatalog()
  const [open, setOpen] = useState(false)
  if (loading) return null
  const widgets = catalog?.widgets ?? []
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="lg"
          className="h-12 rounded-full px-5 shadow-lg"
          title="현재 페이지에 위젯 추가"
        >
          <Plus className="mr-2 h-4 w-4" />
          위젯 추가
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        sideOffset={8}
        // Width sized to fit all 5 category columns side by side. Radix
        // shifts the popover into view if a narrow viewport can't fit it.
        className="w-[760px] max-w-[92vw] p-2 max-h-[70vh] overflow-y-auto"
      >
        <WidgetPicker
          widgets={widgets}
          onSelect={(w) => {
            onAdd(w.type, w.default_props ?? {})
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

/** Sibling of FloatingAddWidget — opens the tabbed 보고서 설정 dialog.
 *  Same pill styling as the add-widget button (matched size/radius) so
 *  the two read as one floating action cluster. The dialog itself is
 *  mounted at the ReportDetailPage root; this just flips its open
 *  state through `onOpen`. */
function FloatingReportSettings({ onOpen }) {
  return (
    <Button
      size="lg"
      variant="secondary"
      className="h-12 rounded-full px-5 shadow-lg"
      title="보고서 설정 (폭 등)"
      onClick={onOpen}
    >
      <Settings2 className="mr-2 h-4 w-4" />
      보고서 설정
    </Button>
  )
}

/** Floating pill that opens the JSON paste dialog. Moved out of the
 *  "로컬" dropdown so AI-generated JSON paste is reachable in one click
 *  during writing, without expanding a menu. Dialog itself stays mounted
 *  at the ReportDetailPage root. */
function FloatingPasteJson({ onOpen }) {
  return (
    <Button
      size="lg"
      variant="secondary"
      className="h-12 rounded-full px-5 shadow-lg"
      title="AI 가 생성한 JSON 을 붙여넣어 보고서에 적용"
      onClick={onOpen}
    >
      <ClipboardPaste className="mr-2 h-4 w-4" />
      JSON 붙여넣기
    </Button>
  )
}

/** Pick a unique id for a new extra block. Tries `<type>_1`, `<type>_2`,
 *  … until it lands on one that doesn't clash with the page's existing
 *  ids (either template or extra). */
function freshExtraId(type, existingIds) {
  let n = 1
  while (existingIds.has(`${type}_${n}`)) n += 1
  return `${type}_${n}`
}

/** Every block id a page already touches — template blocks, extras, and
 *  any id that leaked into content / blocks_order / sections / overrides.
 *  Used when minting a new extra id so we never alias a template block
 *  (the backend rejects extras whose id matches a template block id) or
 *  a stale reference left over from a removed block. */
function collectPageBlockIds(page, template) {
  const ids = new Set()
  for (const b of extractBlocks(template?.schema)) ids.add(b.id)
  for (const b of page?.extra_blocks ?? []) {
    if (b?.id) ids.add(b.id)
  }
  for (const id of Object.keys(page?.content ?? {})) ids.add(id)
  for (const id of page?.blocks_order ?? []) ids.add(id)
  for (const id of Object.keys(page?.block_sections ?? {})) ids.add(id)
  for (const id of Object.keys(page?.layout_overrides ?? {})) ids.add(id)
  for (const id of Object.keys(page?.props_overrides ?? {})) ids.add(id)
  return ids
}

/** Combined template + page.extra_blocks list, in render order. Extras
 *  inherit the same shape so the rest of the editor (layouts, content
 *  validation, etc.) treats them as peers — only the `source` flag
 *  changes how the UI presents them.
 *
 *  When `page.blocks_order` is non-empty it overrides the default
 *  (template-order then extras) sequence: the page picks which blocks
 *  are visible and in what order. Template block ids omitted from
 *  blocks_order are dropped from the render, so users can remove
 *  template-defined blocks from a specific report without touching
 *  the template itself. */
/** Resolve the effective 단락 구분 code for a block, layering the
 *  page-level override on top of the template's per-block default.
 *
 *  Three states for `page.block_sections[id]`:
 *    - missing  → no override; use the template's `block.section`.
 *    - null     → explicit "no section" (overrides the template).
 *    - string   → explicit pick.
 *
 *  Returns the resolved code (or null when there is none).
 */
function resolveBlockSection(page, block) {
  if (!block) return null
  const overrides = page?.block_sections
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, block.id)) {
    const v = overrides[block.id]
    return typeof v === 'string' && v.length > 0 ? v : null
  }
  return typeof block.section === 'string' && block.section.length > 0
    ? block.section
    : null
}

function combinedBlocks(template, page) {
  const tplBlocks = extractBlocks(template?.schema)
  const extras = (page?.extra_blocks ?? []).map((b) => ({
    id: b.id,
    title: b.props?.label || b.props?.default_text || b.id,
    type: b.type,
    props: b.props ?? {},
    layout: b.layout,
    source: 'extra',
  }))
  const order = Array.isArray(page?.blocks_order) ? page.blocks_order : []
  if (order.length === 0) {
    return [...tplBlocks, ...extras]
  }
  const byId = new Map()
  for (const b of tplBlocks) byId.set(b.id, b)
  for (const b of extras) byId.set(b.id, b)
  const out = []
  const seen = new Set()
  for (const id of order) {
    if (seen.has(id)) continue
    const b = byId.get(id)
    if (b) {
      out.push(b)
      seen.add(id)
    }
  }
  return out
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

// Widgets that keep their editor INLINE in edit mode. Every other widget
// flips to a view-mode render in the page and opens a separate modal
// editor on click — that way the visible cell size matches view mode
// exactly (no more "drag the cell smaller and the inline editor still
// shows full controls" mismatch), and the editing surface gets enough
// room for its own controls regardless of the user's chosen cell size.
const INLINE_EDITABLE_WIDGETS = new Set(['rich_text', 'heading'])

function BlockEditorCard({
  block,
  content,
  propsOverride,
  active,
  readOnly,
  showDragHandle,
  autoFit,
  isExtra,
  sectionCode,
  sectionItemByCode,
  onActivate,
  onChange,
  onChangePropsOverride,
  onToggleAutoFit,
  onRemove,
  onOpenProps,
  onOpenContentEdit,
  onMeasureContentHeight,
  onMeasureEditHeight,
}) {
  // Non-inline-editable widgets render as if in view mode while sitting
  // inside the edit grid — their "edit" happens in a separate modal that
  // the parent opens via `onOpenContentEdit`. The chrome (drag handle,
  // resize affordances, autoFit toggle, etc.) is still driven by the
  // page-level `readOnly` flag; only the inner Editor flips to readOnly.
  const isInlineEditable = INLINE_EDITABLE_WIDGETS.has(block.type)
  const editorReadOnly = readOnly || !isInlineEditable
  const opensModalEditor =
    !readOnly && !isInlineEditable && typeof onOpenContentEdit === 'function'
  // Resolve the section-marker tag (if any) into its item + category so
  // the drag handle can show a colored chip. The lookup tolerates
  // unknown codes (orphaned tags from a deleted taxonomy entry) by
  // returning undefined → no badge.
  const sectionEntry = sectionCode ? sectionItemByCode?.[sectionCode] : null
  const sectionItem = sectionEntry?.item ?? null
  const sectionCategory = sectionEntry?.category ?? null
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
  // Suppress click that fires at the END of an RGL drag. RGL's
  // mousedown→mousemove→mouseup sequence on the drag handle bubbles
  // up to the Card as a click event; if the user actually moved the
  // widget, we don't want that click to ALSO open the modal editor.
  // Compare mouseup vs mousedown position — past ~5px of movement
  // means the user dragged, not clicked.
  const downPosRef = useRef(null)
  // Card chrome that adds to the measured `scrollHeight` to produce the
  // final cell height. In edit mode (`showDragHandle` true), the top
  // padding is bumped from pt-4 → pt-9 so the widget's own caption /
  // label has breathing room below the drag-handle bar. In view mode
  // there is no handle, so the standard pt-4 / pb-4 paddings apply.
  // Heading has no Card wrapper at all — it only needs room for the
  // handle when shown.
  const chromeExtraPx = (() => {
    if (block.type === 'heading') return showDragHandle ? 28 : 0
    let topPx = showDragHandle ? 36 : 16 // pt-9 vs pt-4
    // View-mode section header lives outside the measured mirror, so its
    // height has to be added to the row-span the autoFit measurement
    // produces — otherwise the cell would clip the strip's worth of
    // content at the bottom.
    if (!showDragHandle && sectionItem && sectionCategory && block.type !== 'heading') {
      topPx += 34 // SECTION_HEADER_HEIGHT_PX
    }
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

  // Shared section chip — rendered inline inside the drag-handle bar in
  // edit mode (compact pill on a crowded toolbar) and reused by the
  // heading-widget view-mode floater below. Card-based widgets get the
  // richer top-of-card header instead (`viewModeSectionHeader`).
  const sectionChip = (sectionItem && sectionCategory) ? (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-1.5 h-3.5 text-[9px] font-medium"
      style={{
        borderColor: sectionCategory.color,
        color: sectionCategory.color,
        backgroundColor: `${sectionCategory.color}1A`,
      }}
      title={`${sectionCategory.name} · ${sectionItem.label}`}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: sectionCategory.color }}
      />
      {sectionItem.label}
    </span>
  ) : null

  // View-mode header strip pinned to the top of the card. In-flow rather
  // than absolutely positioned so it cannot overlap the (newly enlarged)
  // widget body — the body just starts below the strip. Pulls its accent
  // tone from the 단락 구분 taxonomy: lightly tinted background, matching
  // bottom-border accent, item label on the right, category name on the
  // left as a quieter prefix. Heading blocks fall back to the floating
  // pill below since they don't have card chrome to host this strip.
  const SECTION_HEADER_HEIGHT_PX = 34
  const viewModeSectionHeader =
    !showDragHandle &&
    sectionItem &&
    sectionCategory &&
    block.type !== 'heading'
      ? (
          <div
            className="flex items-center px-3 rounded-t-lg border-b"
            style={{
              height: SECTION_HEADER_HEIGHT_PX,
              backgroundColor: `${sectionCategory.color}14`,
              color: sectionCategory.color,
              borderBottomColor: `${sectionCategory.color}40`,
            }}
            title={sectionItem.label}
          >
            <span className="text-[15px] font-semibold tracking-tight">
              {sectionItem.label}
            </span>
          </div>
        )
      : null

  // Heading blocks have no Card chrome, so the in-flow strip above would
  // stretch the single-line heading into a stacked block. Keep the small
  // floating pill for them — overlap risk is low because the heading
  // itself is one line and the chip sits in the top-right corner.
  const headingSectionChip =
    block.type === 'heading' && !showDragHandle && sectionChip
      ? (
          <div className="pointer-events-none absolute right-2 top-2 z-10">
            {sectionChip}
          </div>
        )
      : null

  const dragHandle = showDragHandle ? (
    <div className="block-drag-handle absolute inset-x-0 top-0 z-10 cursor-move px-2 py-0.5 bg-muted/60 backdrop-blur-sm border-b flex items-center gap-2 rounded-t-md">
      <GripVertical className="h-3 w-3 text-muted-foreground" />
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {block.type}
      </span>
      {isExtra && (
        <Badge variant="secondary" className="text-[9px] h-3.5 px-1">
          추가
        </Badge>
      )}
      {sectionChip}
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
      {onOpenProps && (
        <button
          type="button"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onOpenProps()
          }}
          className={cn(
            'rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted',
            !onToggleAutoFit && !onRemove && 'ml-auto',
          )}
          title="속성 편집 (또는 우클릭)"
          aria-label="속성 편집"
        >
          <Settings2 className="h-3 w-3" />
        </button>
      )}
      {onRemove && (
        <button
          type="button"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          className={cn(
            'rounded p-0.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10',
            !onToggleAutoFit && !onOpenProps && 'ml-auto',
          )}
          title="이 위젯 제거"
          aria-label="이 위젯 제거"
        >
          <Trash2 className="h-3 w-3" />
        </button>
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
          // text isn't hidden behind it in edit mode. The view-mode floating
          // section chip occupies the same top-right zone, so reserve the
          // same room there to keep the heading from running under it.
          (showDragHandle || headingSectionChip) && 'pt-7',
          active && !readOnly && 'ring-2 ring-primary/30 rounded-md',
          // Same body-text scaling as every other widget — without it the
          // heading's text-lg/xl/2xl stay at Tailwind defaults while body
          // widgets get the 1.3× boost, making a level-3 heading actually
          // smaller than rich_text body. The drag-handle / section chip
          // pieces use text-[9px]/[10px] which the boost rule doesn't touch.
          'report-widget-body',
        )}
      >
        {dragHandle}
        {headingSectionChip}
        <div className="relative w-full min-w-0">
          {autoFit && (
            // Heading has no Card / padding chrome, so the mirror just
            // spans the same width as the visible heading editor.
            <div
              ref={measureRef}
              aria-hidden="true"
              className="invisible pointer-events-none absolute left-0 right-0 top-0 report-autofit-mirror"
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
  function handleCardMouseDown(e) {
    downPosRef.current = { x: e.clientX, y: e.clientY }
  }
  function handleCardClick(e) {
    const start = downPosRef.current
    downPosRef.current = null
    if (start) {
      const dx = e.clientX - start.x
      const dy = e.clientY - start.y
      if (Math.abs(dx) + Math.abs(dy) > 5) return // drag, not click
    }
    onActivate?.(e)
    // Non-inline-editable widgets open the modal editor on click.
    // The drag handle / autoFit / settings / remove buttons live
    // inside the card and stop propagation themselves, so this
    // only fires when the user clicks the actual content area.
    if (opensModalEditor) onOpenContentEdit()
  }
  return (
    <Card
      id={`block-${block.id}`}
      onMouseDown={handleCardMouseDown}
      onClick={handleCardClick}
      className={cn(
        'relative h-full flex flex-col',
        autoFit ? 'overflow-visible' : 'overflow-hidden',
        active && !readOnly && 'ring-2 ring-primary/30',
        // Hover hint that this card opens a modal — only when in
        // edit mode and the click would actually do something.
        opensModalEditor && 'cursor-pointer hover:ring-2 hover:ring-primary/20'
      )}
    >
      {dragHandle}
      {viewModeSectionHeader}
      <CardContent
        className={cn(
          'relative pb-4',
          // pt-9 clears the absolute drag-handle bar in edit mode. The
          // view-mode section header sits in-flow above CardContent, so
          // no top-padding reservation is needed for it — pt-4 is the
          // standard breathing room between header and body.
          showDragHandle ? 'pt-9' : 'pt-4',
          // In manual (non-autoFit) mode the cell height is fixed by
          // the user's drag, so we set up a flex-column chain inside
          // the card so widgets that opt into `h-full` / `flex-1`
          // (like ChartEditor) can actually fill the cell.
          autoFit
            ? 'overflow-visible'
            : 'flex-1 min-h-0 overflow-auto flex flex-col'
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
            className="invisible pointer-events-none absolute left-0 right-0 top-0 pl-6 pr-6 report-widget-body report-autofit-mirror"
          >
            <Editor
              props={effectiveProps}
              content={content}
              onChange={NO_OP}
              autoFit={autoFit}
              readOnly={true}
            />
          </div>
        )}
        <div
          ref={contentRef}
          className={cn(
            // Continue the flex-column chain set up on CardContent so
            // widgets that fill the cell (chart) work in manual mode.
            // In autoFit mode we leave it as auto-height so the cell
            // can wrap the widget's natural size.
            !autoFit && 'flex-1 min-h-0 flex flex-col',
            // Scales the widget body's text (text-sm/base/lg/xl/2xl) by
            // 1.5× via `.report-widget-body` overrides in index.css. UI
            // metadata classes (text-xs / arbitrary px) are left alone so
            // hint labels, chips, and the per-block style panel keep their
            // intended size.
            'report-widget-body',
          )}
        >
          {Editor ? (
            <Editor
              props={effectiveProps}
              content={content}
              onChange={onChange}
              onChangePropsOverride={onChangePropsOverride}
              autoFit={autoFit}
              readOnly={editorReadOnly}
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

// Widget types whose auto_fit DEFAULTS to false (manual cell size).
// Charts / scatter / heatmap need a real height to paint — letting
// content drive the row_span makes them snap small repeatedly while
// the user edits data, which feels broken. Users can still flip the
// per-block toggle when they want auto-fit on these.
const WIDGETS_DEFAULT_NO_AUTOFIT = new Set([
  'chart',
  'scatter',
  'scatter3d',
  'heatmap',
  'radar',
])

/** Resolve whether a block is in auto_fit mode. Explicit `auto_fit`
 *  in the saved layout always wins; absent value falls back to the
 *  per-type default. */
function autoFitForBlock(block, layout) {
  if (layout && Object.prototype.hasOwnProperty.call(layout, 'auto_fit')) {
    return layout.auto_fit !== false
  }
  return !WIDGETS_DEFAULT_NO_AUTOFIT.has(block?.type)
}

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
    // Auto-fit blocks: hide the vertical / corner resize handles since
    // height is content-driven. Per-type default applies when the
    // layout doesn't explicitly set auto_fit — see `autoFitForBlock`.
    if (autoFitForBlock(b, layout)) {
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

/** Re-pack layout_overrides so each row's col_span sum fits the grid
 *  (12 columns). Preserves the original row numbers — only splits a row
 *  when its blocks would overflow, and shifts subsequent rows by the
 *  same offset so gaps stay stable. (Renumbering rows from 1 would be
 *  wrong: overrides only cover *some* of the page's blocks, so a hidden
 *  template block at row 1 would collide with an override collapsed to
 *  row 1.) Returns null when the input is null / empty. */
function normalizeLayoutOverrides(overrides) {
  if (!overrides || typeof overrides !== 'object') return overrides ?? null
  const entries = Object.entries(overrides)
  if (entries.length === 0) return null
  // Group by current row, preserving each block's id + layout shape.
  const byRow = new Map()
  for (const [id, layout] of entries) {
    const row = layout?.row ?? 1
    if (!byRow.has(row)) byRow.set(row, [])
    byRow.get(row).push({ id, layout })
  }
  const sortedRows = [...byRow.keys()].sort((a, b) => a - b)
  const out = {}
  // Accumulator: how many extra rows we've inserted due to overflow
  // splits. Applied to every subsequent original row so the relative
  // ordering survives.
  let bumpOffset = 0
  for (const origRow of sortedRows) {
    const group = byRow.get(origRow)
    let curRow = origRow + bumpOffset
    let colSum = 0
    for (const { id, layout } of group) {
      const cs = Math.max(1, Math.min(12, layout?.col_span ?? 12))
      if (colSum + cs > 12) {
        curRow += 1
        bumpOffset += 1
        colSum = 0
      }
      out[id] = { ...layout, row: curRow, col_span: cs }
      colSum += cs
    }
  }
  return out
}

/** Coerce a chart's effective props into something the backend's widget
 *  schema validator will accept. Three rules to satisfy:
 *    1. x_column_key must reference an existing column.
 *    2. The X column can be any type.
 *    3. Every other column (the series) must be type='number'.
 *
 *  When violated, we apply the same fixes the inline ⚠ chip offers:
 *    - x_column_key missing → fall back to the first text column, or
 *      the first column if there's no text column.
 *    - X is number-typed AND exactly one text column exists elsewhere →
 *      promote that text column to X-axis (typical "I mixed them up"
 *      user intent).
 *    - Any remaining non-X text columns → strip from schema (they have
 *      no plot role and would block save). */
function normalizeChartPropsForTemplate(props) {
  const cols = Array.isArray(props?.columns) ? [...props.columns] : []
  if (cols.length === 0) return props
  let xKey = props?.x_column_key
  // 1. X-axis must exist among the columns.
  if (!cols.some((c) => c.key === xKey)) {
    xKey =
      cols.find((c) => c.type !== 'number')?.key ?? cols[0]?.key
  }
  // 2. If X is number-typed AND a single text column exists, promote
  //    that text column to X (assume user mixed up the assignment).
  const xCol = cols.find((c) => c.key === xKey)
  const textCols = cols.filter((c) => c.type !== 'number')
  if (xCol && xCol.type === 'number' && textCols.length === 1) {
    xKey = textCols[0].key
  }
  // 3. Drop remaining non-X text columns — they fail validation and
  //    aren't plottable anyway.
  const finalCols = cols.filter(
    (c) => c.key === xKey || c.type === 'number',
  )
  return { ...props, x_column_key: xKey, columns: finalCols }
}

/** Diff two chart-props objects and return a short Korean note when the
 *  normalizer changed something user-meaningful. Returns null when the
 *  fixup was a no-op (template already valid). */
function describeChartFixup(blockId, before, after) {
  const parts = []
  if (before.x_column_key !== after.x_column_key) {
    parts.push(
      `'${blockId}' X축을 '${after.x_column_key}'로 변경`,
    )
  }
  const beforeCols = Array.isArray(before.columns) ? before.columns : []
  const afterCols = Array.isArray(after.columns) ? after.columns : []
  if (beforeCols.length !== afterCols.length) {
    const dropped = beforeCols.length - afterCols.length
    parts.push(`'${blockId}'에서 텍스트 시리즈 ${dropped}개 제외`)
  }
  return parts.length > 0 ? parts.join(', ') : null
}

/** When a writer inserts a fresh extra block of these types, seed the
 *  page's `block_sections` with the matching item code so the widget
 *  arrives already labelled. Codes match entries in the admin-managed
 *  단락 구분 taxonomy (see backend `section_items` table). The user can
 *  override or clear the tag at any time via the block's context menu.
 */
const WIDGET_DEFAULT_SECTION_CODE = {
  milestone: 'milestone',
}

/** RFC 4122 v4 UUID fallback for environments without crypto.randomUUID.
 *  Mirrors the helper in TemplateEditorPage so the two "create template"
 *  flows produce identically-shaped ids. */
function fallbackUuidLocal() {
  const hex = '0123456789abcdef'
  const out = new Array(36)
  for (let i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out[i] = '-'
    else if (i === 14) out[i] = '4'
    else if (i === 19) out[i] = hex[(Math.random() * 4) | 0 | 8]
    else out[i] = hex[(Math.random() * 16) | 0]
  }
  return out.join('')
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
