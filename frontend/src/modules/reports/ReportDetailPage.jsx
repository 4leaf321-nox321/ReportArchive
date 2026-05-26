import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  useParams,
  useNavigate,
  useLocation,
  useBlocker,
  Link,
} from 'react-router-dom'
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
  LayoutGrid,
  Loader2,
  Maximize2,
  Minimize2,
  Pencil,
  Plus,
  Rows,
  Save,
  Send,
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
import { InlineReportView } from '@/modules/composites/InlineReportView'
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
  publishReport,
  unpublishReport,
  setAuthorLock,
  LockConflictError,
} from './api'
import { useReportLock } from './useReportLock'
import {
  DEFAULT_REPORT_WIDTH_PX,
  DEFAULT_REPORT_GAP_PX,
  ReportSettingsDialog,
} from './ReportSettingsDialog'
import { SlideGuideOverlay } from './SlideGuideOverlay'
import {
  getTemplateVersion,
  createTemplate,
  getLatestTemplate,
} from '@/shared/api/templates'
import { listTemplateCategories } from '@/shared/api/templateCategories'
import { getRenderer } from '@/modules/templates/widgets'
import { WidgetPicker } from '@/modules/templates/WidgetPicker'
import { DepthStyleField, TextStyleField } from '@/modules/templates/widgets/_shared'
import { TemplatePicker } from './TemplatePicker'
import { SectionPickerDialog } from './SectionPickerDialog'
import { PromptPickerDialog } from './PromptPickerDialog'
import { MountDialog } from './MountDialog'
import { EditorsDialog } from './EditorsDialog'
import { FolderPickerButton } from './FolderPickerButton'
import { listMounts, mountReport } from '@/shared/api/mounts'
import { listCompositesContainingReport } from '@/shared/api/composites'
import { CommentsProvider } from '@/modules/comments/CommentsContext'
import { CommentPanel } from '@/modules/comments/CommentPanel'
import { CommentPin } from '@/modules/comments/CommentPin'
import { ActivityTimelineButton } from './ActivityTimeline'
import { useSectionTaxonomy } from '@/shared/hooks/useSectionTaxonomy'
import { cn } from '@/shared/lib/utils'
import { toast } from 'sonner'
import { renderPrompt, buildPromptContext } from '@/shared/ai/promptRenderer'

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
  const { slug, workspace, all: workspaces } = useWorkspace()
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
  const [mountOpen, setMountOpen] = useState(false)
  const [editorsOpen, setEditorsOpen] = useState(false)
  // Mounts state declared here, the fetching useEffect lives further
  // down past `existingReport`'s declaration — TDZ would fire otherwise.
  const [mountByWorkspace, setMountByWorkspace] = useState({})
  const isOrgContext = workspace?.kind === 'org'
  const isPersonalContext = workspace?.kind === 'personal'
  const currentMount = mountByWorkspace[slug]
  // AI prompt — picker + active selection. PromptPickerDialog is the
  // grid of available prompts; once the user picks one we stash the row
  // in `aiPromptActive` and the existing AiPromptDialog renders it.
  const [aiPromptPickerOpen, setAiPromptPickerOpen] = useState(false)
  const [aiPromptActive, setAiPromptActive] = useState(null)
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
  // 보고서 전체화면 모드 — AppShell의 헤더/사이드바를 가리고, 본문의
  // maxWidth 제한도 풀어서 보고서가 브라우저 전체 폭을 차지하게 한다.
  // 본문 옆 패딩(p-6)과 toolbar/page-strip은 유지해 종료 동선을 남긴다.
  const [reportFullscreen, setReportFullscreen] = useState(false)
  useEffect(() => {
    if (!reportFullscreen) return
    document.body.classList.add('report-fullscreen')
    const onKey = (e) => {
      if (e.key === 'Escape') setReportFullscreen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.classList.remove('report-fullscreen')
      window.removeEventListener('keydown', onKey)
    }
  }, [reportFullscreen])
  // "Printing" doesn't actually leave edit mode (no lock release, no
  // unsaved-change loss); it just renders all blocks read-only and stacks
  // every page vertically so the browser's print engine sees the same
  // chrome-free, paginated layout regardless of where the user was. Used
  // by both PDF print-to-file and the Word export's html2canvas capture.
  const [printing, setPrinting] = useState(false)
  // DOCX export progress. `null` when not exporting; otherwise a
  // `{ phase, current?, total?, label }` snapshot fed straight from the
  // exporter's onProgress callback. The bottom-screen overlay renders
  // from this and disappears when set back to null. Kept separate from
  // `printing` because `printing` also covers PDF / HTML paths that
  // don't need the same granular progress UX.
  const [docxProgress, setDocxProgress] = useState(null)
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

  // Mounts of this report, fetched lazily — used in org workspace to
  // surface the per-board folder placement in the toolbar. Keyed by
  // workspace_slug so the org folder picker can read/write the right
  // row. Lives here (not next to the other useStates above) because
  // it depends on existingReport — placed before its declaration would
  // hit TDZ on the dep array.
  useEffect(() => {
    if (isNew || !existingReport?.id) return
    let cancelled = false
    listMounts(existingReport.id)
      .then((rows) => {
        if (cancelled) return
        const map = {}
        for (const m of rows) map[m.workspace_slug] = m
        setMountByWorkspace(map)
      })
      .catch(() => {
        /* non-fatal; folder picker just won't show for org */
      })
    return () => {
      cancelled = true
    }
  }, [isNew, existingReport?.id])

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
      // Inherit per-template defaults (page_width_px, page_gap_px).
      // Lives on the template's schema doc under `report_defaults` —
      // every template version carries its own copy, so new reports
      // bound to that version pick up the same starting point.
      const tplDefaults = seedTemplate?.schema?.report_defaults ?? null
      const seededWidth = Number.isFinite(tplDefaults?.page_width_px)
        ? tplDefaults.page_width_px
        : null
      const seededGap = Number.isFinite(tplDefaults?.page_gap_px)
        ? tplDefaults.page_gap_px
        : null
      const seededBlend =
        typeof tplDefaults?.page_blend_blocks === 'boolean'
          ? tplDefaults.page_blend_blocks
          : false
      setDraft({
        title: seededTitle,
        report_date: todayIsoDate(),
        status: 'draft',
        tags: [],
        page_width_px: seededWidth,
        page_gap_px: seededGap,
        page_blend_blocks: seededBlend,
        // PPT 슬라이드 가이드 — 새 보고서는 가이드 OFF 로 시작.
        // 사용자가 보고서 설정 → 페이지 → "PPT 가이드" 에서 켤 수 있다.
        page_slide_guide: false,
        page_slide_ratio: null,
        page_slide_ratio_custom_w: null,
        page_slide_ratio_custom_h: null,
        report_type_id: null,
        report_type: null,
        // Entity tags (모델/부품/BOM/단계/불량/시험/시뮬레이션) — starts
        // empty on new reports; user picks values in 보고서 설정 → 속성.
        // Same slim EntityRefMini shape the backend returns on ReportRead.
        entities: [],
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
        // Per-report widget gap. null → frontend default (DEFAULT_REPORT_GAP_PX).
        page_gap_px: existingReport.page_gap_px ?? null,
        // Container blending toggle. null/false → bordered cards;
        // true → page blends widget chrome into the background.
        page_blend_blocks: existingReport.page_blend_blocks === true,
        // PPT 슬라이드 가이드 — 백엔드의 4 필드를 그대로 받아 draft 에
        // 저장. 오버레이 렌더 + 다이얼로그 표시 모두 이 값을 본다.
        page_slide_guide: existingReport.page_slide_guide === true,
        page_slide_ratio: existingReport.page_slide_ratio ?? null,
        page_slide_ratio_custom_w: existingReport.page_slide_ratio_custom_w ?? null,
        page_slide_ratio_custom_h: existingReport.page_slide_ratio_custom_h ?? null,
        // 보고서 종류 — picker writes the FK + embedded ref so the
        // settings dialog (and the list view, once we rerender it)
        // can show the name/status without a second roundtrip.
        report_type_id: existingReport.report_type_id ?? null,
        report_type: existingReport.report_type ?? null,
        // Entity tags — slim EntityRefMini list pre-flattened by the
        // backend; the settings dialog re-renders chips from it without
        // a second fetch. Mutated via onApplyEntities below.
        entities: existingReport.entities ?? [],
        pages,
      })
      setCurrentPage((p) => clamp(p, 0, pages.length - 1))
    }
  }, [isNew, seedTemplate, existingReport])

  // -------------------------------------------------------------------- //
  // Unsaved-changes guard                                                //
  //                                                                      //
  // While editing, intercept any navigation away from this report and    //
  // prompt the user (저장 / 포기 / 머무름). Catches:                       //
  //  - in-SPA navigation (sidebar links, browser back, navigate() calls) //
  //    via react-router's useBlocker                                     //
  //  - browser unload (tab close, refresh, URL bar change) via the       //
  //    standard beforeunload event (native browser confirm dialog)       //
  //                                                                      //
  // Dirty detection is a JSON.stringify diff against the draft as-of     //
  // edit-mode entry. Cheap enough for normal report sizes; only computed //
  // when the guard actually triggers, not on every render.               //
  // -------------------------------------------------------------------- //
  const draftRef = useRef(null)
  const isEditingRef = useRef(false)
  const editingSnapshotRef = useRef(null)
  const [unsavedNavPrompt, setUnsavedNavPrompt] = useState(null) // { proceed, reset, saving } | null

  useEffect(() => {
    draftRef.current = draft
  }, [draft])

  // Re-snapshot whenever edit mode is entered. Intentionally NOT dependent
  // on `draft` — we only freeze the baseline once per edit session, so any
  // subsequent setDraft becomes a "dirty" diff. Leaving edit mode (save /
  // cancel / takeover-lost) clears the snapshot so the guard goes silent.
  useEffect(() => {
    isEditingRef.current = isEditing
    if (isEditing && draftRef.current) {
      editingSnapshotRef.current = JSON.stringify(draftRef.current)
    } else {
      editingSnapshotRef.current = null
    }
  }, [isEditing])

  function isDraftDirty() {
    if (!isEditingRef.current) return false
    if (!editingSnapshotRef.current) return false
    return JSON.stringify(draftRef.current) !== editingSnapshotRef.current
  }

  // useBlocker is react-router 6.4+'s replacement for <Prompt>. The guard
  // runs every time the router considers navigating. We pass-through same-
  // path "navigations" (e.g. hash changes) and ignore the case where the
  // page itself navigated via the explicit save/cancel/copy/delete paths
  // (those flip isEditingRef synchronously before calling navigate).
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (currentLocation.pathname === nextLocation.pathname) return false
    return isDraftDirty()
  })

  useEffect(() => {
    if (blocker.state === 'blocked') {
      setUnsavedNavPrompt({
        proceed: () => blocker.proceed(),
        reset: () => blocker.reset(),
      })
    }
  }, [blocker])

  // Native browser unload — Chrome/FF show their own generic "Leave
  // site?" prompt when returnValue is set. We don't get to customize the
  // text (browser policy), so the in-SPA dialog above is the richer UX.
  useEffect(() => {
    if (!isEditing) return
    const handler = (e) => {
      if (!isDraftDirty()) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isEditing])

  // Fetch the template version for every page in the draft (deduped by
  // template_id+version). Cached in a map keyed by `${id}@${version}` so
  // switching pages is instant and the 'all' view can render every page
  // without waterfalling.
  const pageTemplateMap = usePageTemplates(draft?.pages, slug)

  // Map of template_id → latest published version number. Populated
  // lazily as the user navigates pages. Used by the AI-prompt context
  // so the {{template_version}} placeholder always reflects the most
  // recent baseline schema, regardless of which version the report was
  // originally bound to — that way an AI response generated against a
  // since-promoted v2 doesn't get pasted in as a stale v1 reference.
  const [latestVersionByTemplate, setLatestVersionByTemplate] = useState({})
  // Set of template_ids we've already kicked off a fetch for, so React's
  // strict-mode double-invocation doesn't fire two requests for the same
  // template_id. Lives in a ref because mutating it doesn't need to
  // trigger renders.
  const latestVersionFetchStartedRef = useRef(new Set())
  const currentTemplateIdForLatest =
    draft?.pages?.[currentPage]?.template_id ?? null
  useEffect(() => {
    const tid = currentTemplateIdForLatest
    if (!tid) return
    if (latestVersionFetchStartedRef.current.has(tid)) return
    latestVersionFetchStartedRef.current.add(tid)
    let cancelled = false
    getLatestTemplate(tid)
      .then((t) => {
        if (cancelled || !t?.version) return
        setLatestVersionByTemplate((m) =>
          m[tid] === t.version ? m : { ...m, [tid]: t.version },
        )
      })
      .catch(() => {
        // Silent — falling back to the page's stored version is the
        // existing behavior, so the worst case is "no improvement"
        // rather than a broken prompt.
      })
    return () => {
      cancelled = true
    }
  }, [currentTemplateIdForLatest])

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

  // Context-builder that the AiPromptDialog uses to render the prompt.
  // Returns a function instead of a fully-baked context because the
  // dialog now has interactive widget-exclusion checkboxes — the same
  // raw inputs need to be re-applied with a different `excludedWidgetTypes`
  // set every time the user toggles a widget. Declared above the
  // loading/!draft early returns so the hook order stays stable.
  const aiPromptContextBuilder = useCallback(
    (excludedWidgetTypes) => {
      const page = draft?.pages?.[currentPage] ?? draft?.pages?.[0]
      const tpl = getCachedTemplate(pageTemplateMap, page)
      // Prefer the latest published version of this template over the
      // version the report is currently bound to — see comment on
      // `latestVersionByTemplate` above. Falls back to the page's stored
      // version while the latest-fetch is still in flight or on error.
      const latestForPage =
        (page?.template_id && latestVersionByTemplate[page.template_id]) ??
        page?.template_version
      return buildPromptContext({
        widgetCatalog,
        sectionCategories,
        templateBlocks: tpl?.schema?.blocks,
        templateId: page?.template_id,
        templateVersion: latestForPage,
        excludedWidgetTypes,
      })
    },
    [
      widgetCatalog,
      sectionCategories,
      pageTemplateMap,
      draft,
      currentPage,
      latestVersionByTemplate,
    ],
  )

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

  /** Insert one or more deep-cloned pages right after `afterIdx`. The
   *  page strip's Ctrl+C snapshot is delivered here for paste —
   *  accepts either a single page or an array (multi-select copy).
   *  Each copy's `name` gets a "(복사)" suffix so the new chips are
   *  distinguishable in the strip; everything else (content / layout
   *  overrides / extra_blocks / block_sections) carries over verbatim
   *  because block_id-scoped data is page-local and never collides
   *  across pages of the same template. */
  function insertPageCopy(afterIdx, sourcePageOrPages) {
    const sources = Array.isArray(sourcePageOrPages)
      ? sourcePageOrPages
      : sourcePageOrPages
        ? [sourcePageOrPages]
        : []
    if (sources.length === 0) return
    setDraft((d) => {
      if (!d) return d
      const pages = d.pages ?? []
      const insertAt = Math.min(Math.max(0, afterIdx + 1), pages.length)
      const copies = sources.map((p) => ({
        ...p,
        name: p?.name ? `${p.name} (복사)` : null,
      }))
      const next = [
        ...pages.slice(0, insertAt),
        ...copies,
        ...pages.slice(insertAt),
      ]
      return { ...d, pages: next }
    })
    setCurrentPage(afterIdx + 1)
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
  // template defaults to keep `layout_overrides` lean. `auto_fit`'s default
  // depends on the widget type — graph widgets default to OFF, everything
  // else defaults to ON — so we preserve the explicit value (when set)
  // verbatim and only drop the override when the explicit value coincides
  // with the type's default.
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
    // Mirror PageSection's effectiveRowGap: per-report draft override wins,
    // otherwise REPORT_ROW_GAP. Keeps the saved row_span in sync with the
    // actual rendered gap between cells.
    const effectiveRowGap = Number.isFinite(draft.page_gap_px)
      ? draft.page_gap_px
      : REPORT_ROW_GAP

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
      // Read the *current* explicit auto_fit (if any) so we don't lose
      // it across an onLayoutChange cycle. Graph widgets default to OFF;
      // an explicit ON only survives if we re-write it back into the
      // newly-built layout object below — otherwise autoFitForBlock
      // falls back to the type's default and the checkbox visibly
      // un-checks itself on the next render. See the "어떤 경우 체크가
      // 한 번에 안 됨" bug report.
      const cur = curOverrides[block.id]
      const hasExplicitAutoFit =
        cur && Object.prototype.hasOwnProperty.call(cur, 'auto_fit')
      const explicitAutoFit = hasExplicitAutoFit ? cur.auto_fit !== false : null
      const defaultEnabled = !WIDGETS_DEFAULT_NO_AUTOFIT.has(block.type)
      const isAutoFit =
        explicitAutoFit !== null ? explicitAutoFit : defaultEnabled
      const contentPx = pageContentHeights[block.id]
      let rowSpan = Math.max(1, it.h ?? 2)
      if (isAutoFit && contentPx != null && contentPx > 0) {
        rowSpan = Math.max(
          1,
          Math.ceil(
            (contentPx + effectiveRowGap) / (REPORT_ROW_HEIGHT + effectiveRowGap)
          )
        )
      }
      const newLayout = {
        row: blockToRow.get(it.i) ?? 1,
        col_span: clamp(it.w ?? 12, 1, 12),
        row_span: rowSpan,
      }
      // Only persist `auto_fit` when it diverges from the type's default.
      // (Equal-to-default → leave the key out, so the override can still
      // drop when the rest of the layout matches the template.)
      if (explicitAutoFit !== null && explicitAutoFit !== defaultEnabled) {
        newLayout.auto_fit = explicitAutoFit
      }
      const blkTpl = block.layout
      const matchesTemplate =
        blkTpl &&
        isAutoFit === defaultEnabled &&
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

  // Toggle the per-block auto-fit flag inside layout_overrides. We
  // ALWAYS store the explicit `auto_fit` value (true/false) rather than
  // relying on absence to mean "ON" — graph widgets have a default of
  // OFF (see WIDGETS_DEFAULT_NO_AUTOFIT), so the old absence-as-ON
  // convention silently dropped the user's ON click for those types.
  // The override is still removed when the resulting layout matches the
  // template's layout *and* the explicit auto_fit equals the type's
  // default (= the override is fully redundant).
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
        auto_fit: enabled === true,
      }

      // The override is redundant when the row/col/row_span match the
      // template AND the explicit auto_fit matches this widget type's
      // default. Otherwise it has to stick around.
      const defaultEnabled = !WIDGETS_DEFAULT_NO_AUTOFIT.has(block.type)
      const blkTpl = block.layout
      const matchesTemplate =
        blkTpl &&
        next.auto_fit === defaultEnabled &&
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
        page_gap_px: Number.isFinite(draft.page_gap_px) ? draft.page_gap_px : null,
        page_blend_blocks: draft.page_blend_blocks === true,
        // PPT 슬라이드 가이드 4 필드. 가이드 OFF 면 false/null 로 비워서
        // 서버에 명시적으로 reset. ratio 가 custom 이 아닐 때는 custom
        // dims 도 null 로 같이 비워서 stale 값이 남지 않도록 한다.
        page_slide_guide: draft.page_slide_guide === true,
        page_slide_ratio: draft.page_slide_ratio ?? null,
        page_slide_ratio_custom_w:
          draft.page_slide_ratio === 'custom'
            ? draft.page_slide_ratio_custom_w ?? null
            : null,
        page_slide_ratio_custom_h:
          draft.page_slide_ratio === 'custom'
            ? draft.page_slide_ratio_custom_h ?? null
            : null,
        // 보고서 종류 — null clears the tag. The backend's update
        // schema uses `exclude_unset`, so always sending the key (even
        // when null) is the explicit "clear" signal.
        report_type_id: draft.report_type_id ?? null,
        // Entity tags — full replacement set every save (the backend
        // diffs against existing report_entities and rewrites). Empty
        // array clears all tags; sending the field unconditionally keeps
        // the create/update paths symmetric.
        entity_ids: (draft.entities ?? []).map((e) => e.id),
      }
      if (isNew) {
        const created = await createReport({
          ...payload,
          template_id: first.template_id,
          template_version: first.template_version,
        })
        // Auto-mount path: when the create dialog was launched from an
        // org workspace and the user kept the "같이 게시" checkbox on,
        // its config rides in via router state. Mount happens AFTER
        // create (separate API call) — failure here doesn't roll back
        // the create; we surface it as a warning and still navigate the
        // user to their personal copy so they don't lose the report.
        const mountConfig = location.state?.mountConfig
        let landingSlug = created.workspace_slug
        if (mountConfig?.slugs?.length) {
          try {
            await mountReport({
              reportId: created.id,
              workspaceSlugs: mountConfig.slugs,
              editPolicy: mountConfig.editPolicy || 'default',
            })
            // Land on the first mounted board so the user stays in the
            // org context they were browsing when they clicked 신규 작성.
            landingSlug = mountConfig.slugs[0]
            toast.success('보고서가 생성되고 게시판에 게시되었습니다.')
          } catch (mountErr) {
            toast.warning(
              '보고서는 생성되었지만 게시판 게시에 실패했습니다.',
              { description: mountErr?.message || '게시는 detail 페이지의 게시 버튼으로 다시 시도하세요.' },
            )
          }
        } else {
          toast.success('보고서가 생성되었습니다.')
        }
        // Creation is the save — drop straight into view mode. The
        // component instance stays mounted across the navigate (same
        // ReportDetailPage), so `isEditing` would otherwise leak from
        // the new-draft state and surface a misleading "저장" button.
        // The ref override (vs the setState below) is what the dirty
        // guard reads synchronously when the navigate fires.
        isEditingRef.current = false
        setIsEditing(false)
        // `landingSlug` was set above based on whether we mounted: org
        // slug if we did (user stays where they were), personal slug if
        // not (the only workspace that can see the report at this
        // point; otherwise is_visible_to → 403).
        navigate(`/w/${landingSlug}/reports/${created.id}`, {
          replace: true,
        })
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
      // Schema-validation errors come back from the backend as a single
      // multi-line string (one section per offending block — see
      // backend/app/widgets/validation.py). Put it in `description` so
      // sonner renders the linebreaks via the whitespace-pre-wrap class,
      // and lift duration so the user has time to read the list before
      // it auto-dismisses.
      const msg = err?.message || ''
      const isSchemaError = msg.startsWith('Content invalid')
      if (isSchemaError) {
        toast.error('저장 실패 — 위젯 데이터 형식 오류', {
          description: msg,
          duration: 20000,
          classNames: { description: 'whitespace-pre-wrap font-mono text-[11px]' },
        })
      } else {
        toast.error(err.message || '저장 실패')
      }
    }
  }

  function onCancelEdit() {
    // Explicit "discard" — the dirty guard should NOT prompt on the
    // navigate below. Flipping the ref synchronously ensures the
    // useBlocker callback sees us as out-of-edit-mode before the route
    // change actually fires.
    isEditingRef.current = false
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
        // Restore from server snapshot so cancelling an edit reverts
        // any chip changes the user made in the settings dialog
        // (the dialog applies into draft *before* save commits).
        report_type_id: existingReport.report_type_id ?? null,
        report_type: existingReport.report_type ?? null,
        entities: existingReport.entities ?? [],
        page_width_px: existingReport.page_width_px ?? null,
        page_gap_px: existingReport.page_gap_px ?? null,
        page_blend_blocks: existingReport.page_blend_blocks === true,
        // 가이드 4 필드 — cancel 시 서버 스냅샷 그대로 복원되도록 한다.
        page_slide_guide: existingReport.page_slide_guide === true,
        page_slide_ratio: existingReport.page_slide_ratio ?? null,
        page_slide_ratio_custom_w: existingReport.page_slide_ratio_custom_w ?? null,
        page_slide_ratio_custom_h: existingReport.page_slide_ratio_custom_h ?? null,
        revision: existingReport.revision ?? 1,
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
      // Bypass the dirty guard — the report we'd be guarding no longer
      // exists, and the redirect below is a deliberate consequence of
      // the user's destructive action.
      isEditingRef.current = false
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
        page_gap_px: Number.isFinite(draft.page_gap_px) ? draft.page_gap_px : null,
        page_blend_blocks: draft.page_blend_blocks === true,
        // 슬라이드 가이드 설정도 복사. 원본의 보기 옵션을 그대로 들고
        // 가는 게 사용자의 통상 기대치.
        page_slide_guide: draft.page_slide_guide === true,
        page_slide_ratio: draft.page_slide_ratio ?? null,
        page_slide_ratio_custom_w:
          draft.page_slide_ratio === 'custom'
            ? draft.page_slide_ratio_custom_w ?? null
            : null,
        page_slide_ratio_custom_h:
          draft.page_slide_ratio === 'custom'
            ? draft.page_slide_ratio_custom_h ?? null
            : null,
        // The 종류 tag follows the copy too — same reasoning as width.
        report_type_id: draft.report_type_id ?? null,
        // Entity tags follow the copy as well — the new report inherits
        // the same model/part/BOM/단계/etc. tagging the user already
        // confirmed on the source. Cleared/edited in 보고서 설정.
        entity_ids: (draft.entities ?? []).map((e) => e.id),
      })
      toast.success('보고서가 복사되었습니다.')
      setCopyOpen(false)
      // Bypass the dirty guard — copy was an explicit "leave for the
      // new clone" action. The source draft (which may be dirty) is
      // intentionally abandoned here; the destination is the copy.
      isEditingRef.current = false
      // Same reason as the create-from-template path above — copy lands
      // in the creator's personal workspace, so navigate using the
      // server-returned slug rather than the page's current `slug`.
      navigate(`/w/${created.workspace_slug}/reports/${created.id}`, {
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

  // Build the canonical `report_archive_draft_v1` payload — shared by the
  // local-save (file download) path and the floating "JSON 복사" button
  // so they always emit identical shapes. `meta` carries server-side
  // audit fields (owner / timestamps / status) for offline-archive
  // readability; they're informational and don't round-trip through
  // import (see parseImportPayload — it ignores meta entirely).
  function buildDraftJsonPayload() {
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
    return {
      _type: 'report_archive_draft_v1',
      saved_at: new Date().toISOString(),
      title: draft?.title ?? '',
      report_date: draft?.report_date ?? '',
      tags: draft?.tags ?? [],
      pages: draft?.pages ?? [],
      meta,
    }
  }

  // Local snapshot export — downloads the current working draft (title +
  // report_date + tags + pages) as a JSON file. The `id` and `status`
  // columns are deliberately omitted: the snapshot is meant to be portable
  // across reports, not to round-trip server identity. A version tag lets
  // the importer reject unrelated JSON.
  function handleLocalSave() {
    if (!draft) return
    const payload = buildDraftJsonPayload()
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

  // Copy the same draft snapshot to the clipboard. Use case: feed the
  // current report state into an AI conversation alongside a patch
  // prompt — the AI then has both the prompt's `{{template_blocks}}`
  // context AND the actual content shapes to mimic, which makes
  // `content` field outputs land in the right schema. Falls back to a
  // hidden textarea + execCommand path so insecure-context browsers
  // (file://, http on intranet) still work.
  async function handleCopyJson() {
    if (!draft) {
      toast.error('복사할 보고서가 없습니다.')
      return
    }
    const payload = buildDraftJsonPayload()
    const text = JSON.stringify(payload, null, 2)
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      const sizeKb = Math.round(text.length / 102.4) / 10
      toast.success(`현재 문서 JSON 을 클립보드에 복사했습니다 (${sizeKb} KB).`)
    } catch (e) {
      toast.error('클립보드 복사에 실패했습니다.', {
        description: String(e?.message ?? e),
      })
    }
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
    // Initial spinner state — picked up by the overlay below. Updated
    // continuously via the onProgress callback so the user sees
    // "N/M 위젯 변환 중" tick as html2canvas works through each block.
    setDocxProgress({ phase: 'start', current: 0, total: 0, label: '준비 중...' })
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
        onProgress: setDocxProgress,
      })
      toast.success('Word 파일로 저장했습니다.')
    } catch (err) {
      console.error(err)
      toast.error(`Word 저장 실패: ${err?.message ?? err}`)
    } finally {
      setPrinting(false)
      setDocxProgress(null)
    }
  }

  // Shared import path for both the file picker and the paste-JSON dialog.
  // Throws on schema mismatch so the caller can surface its own toast.
  async function applyImportedDraft(text) {
    const obj = parseImportPayload(text)
    // Bump each page's template_version to the current latest before
    // pushing into the draft — see remapPagesToLatestVersions comment
    // for the rationale.
    await remapPagesToLatestVersions(obj.pages)
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

  /** Append-as-new-pages: drop the imported pages at the end as their
   *  own pages.
   *
   *  Carve-out for unsaved new reports: the seed-template page is just
   *  a placeholder we synthesize before the user has done anything, so
   *  prepending it to imported content always looks like a bug ("왜 빈
   *  첫 페이지가 남지?"). When `draft.id` is absent (= report has never
   *  been saved), we discard the placeholder and let the imported pages
   *  be the entire body. For existing reports the historical "append at
   *  the end" semantics stay intact. */
  async function appendImportedAsNewPages(text) {
    const obj = parseImportPayload(text)
    await remapPagesToLatestVersions(obj.pages)
    let nextPageCount = 0
    let firstImportedIndex = 0
    setDraft((d) => {
      const isUnsavedNew = !d?.id
      const existing =
        !isUnsavedNew && Array.isArray(d?.pages) ? d.pages : []
      const incoming = obj.pages.map(normalizePage)
      firstImportedIndex = existing.length
      nextPageCount = existing.length + incoming.length
      return {
        ...(d ?? {}),
        // Metadata (title / date / tags) stays put — appending content
        // shouldn't quietly rewrite the report's identity.
        pages: [...existing, ...incoming],
      }
    })
    // Jump to the first imported page so the user lands on the new
    // content right away (= 0 when we dropped the unsaved placeholder).
    setCurrentPage(firstImportedIndex)
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

  /** Patch-mode paste: take a `report_archive_draft_patch_v1` payload and
   *  overlay its block_updates onto the current page. Each update lands
   *  in two places at most:
   *    - update.content      → page.content[id]            (overwrite)
   *    - update.props_patch  → page.props_overrides[id]    (shallow merge)
   *
   *  Block ids that don't exist on the current page (template blocks +
   *  extras + any existing content/props/sections keys, via
   *  collectPageBlockIds) are skipped and surfaced as a warning toast so
   *  the author notices AI hallucinations instead of seeing a silent
   *  no-op. Save is *not* triggered — the user reviews the change in the
   *  editor and saves manually, same flow as the other paste modes. */
  function applyPatchToCurrentPage(text) {
    const obj = parsePatchPayload(text)
    if (!draft?.pages || draft.pages.length === 0) {
      throw new Error('현재 보고서에 페이지가 없습니다.')
    }
    // Compute the entire next page outside the state setter so the
    // applied/skipped tally is computed once even under React StrictMode
    // (which double-invokes state-updater functions in dev). The setter
    // then only swaps the precomputed page in.
    const idx = clamp(currentPage, 0, draft.pages.length - 1)
    const target = draft.pages[idx]
    const targetTpl = getCachedTemplate(pageTemplateMap, target)
    const knownIds = collectPageBlockIds(target, targetTpl)

    const nextContent = { ...(target.content ?? {}) }
    const nextPropsOverrides = { ...(target.props_overrides ?? {}) }
    const skippedIds = []
    let appliedCount = 0
    for (const u of obj.block_updates) {
      if (!knownIds.has(u.id)) {
        skippedIds.push(u.id)
        continue
      }
      if ('content' in u) {
        nextContent[u.id] = u.content
      }
      if ('props_patch' in u) {
        nextPropsOverrides[u.id] = {
          ...(nextPropsOverrides[u.id] ?? {}),
          ...u.props_patch,
        }
      }
      appliedCount++
    }

    if (appliedCount > 0) {
      const nextPage = {
        ...target,
        content: nextContent,
        props_overrides:
          Object.keys(nextPropsOverrides).length > 0
            ? nextPropsOverrides
            : null,
      }
      setDraft((d) => {
        if (!d?.pages || d.pages.length === 0) return d
        const nextPages = [...d.pages]
        // Bound-check again in case currentPage shifted between compute
        // and apply — fall through to the original target index since
        // the user's intent was "the page they were looking at".
        nextPages[Math.min(idx, nextPages.length - 1)] = nextPage
        return { ...d, pages: nextPages }
      })
      setIsEditing(true)
      toast.success(
        `${appliedCount}개 블록을 갱신했습니다. 저장하려면 “저장” 버튼을 눌러주세요.` +
          (skippedIds.length > 0
            ? ` (${skippedIds.length}개는 id 가 일치하지 않아 건너뜀)`
            : ''),
      )
    } else {
      toast.warning(
        '갱신된 블록이 없습니다. 모든 id 가 현재 페이지에 존재하지 않습니다.',
        {
          description:
            skippedIds.length > 0
              ? `건너뛴 id: ${skippedIds.slice(0, 8).join(', ')}${skippedIds.length > 8 ? ` … (+${skippedIds.length - 8})` : ''}`
              : undefined,
        },
      )
    }
  }

  async function handleLocalLoad(e) {
    const file = e.target.files?.[0]
    e.target.value = '' // reset so the same file can be re-loaded later
    if (!file) return
    try {
      const text = await file.text()
      await applyImportedDraft(text)
      toast.success('JSON 파일을 불러왔습니다. 저장하려면 “저장” 버튼을 눌러주세요.')
    } catch (err) {
      toast.error(err.message || '불러오기 실패')
    }
  }


  // Driven by performPdfPrint — when not printing the context value is 1
  // so screen rendering uses the chart's default font sizes; while
  // printing it switches to the user-picked scale so SVG-rendered text
  // (Recharts) re-renders with the right size for the page.
  const printContextValue = printing ? pdfPrintScale : 1

  return (
    <PrintScaleContext.Provider value={printContextValue}>
    <CommentsProvider
      reportId={existingReport?.id ?? null}
      reportPhase={existingReport?.phase}
    >
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
              {/* ReportPhase chip — read-only here. Transitions happen
                  via the 발행/발행취소 button and via auto-triggers
                  (first external comment / mount). */}
              <PhaseChip phase={existingReport?.phase ?? draft.phase ?? 'drafting'} />
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
              {/* "포함된 종합 문서 N개" — Phase 5C 양방향 네비. 보고서가
                  어떤 종합에 인용되어 있는지 한 클릭으로 추적. 0건이면
                  chip 자체가 렌더 안 됨. isNew 일 때는 report id 가 없어
                  fetch 자체 안 함. */}
              {!isNew && existingReport?.id && (
                <ContainingCompositesChip reportId={existingReport.id} />
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

          <Button
            variant="ghost"
            size="sm"
            onClick={() => setReportFullscreen((v) => !v)}
            title={reportFullscreen ? '전체화면 종료 (Esc)' : '전체화면으로 보기'}
            aria-pressed={reportFullscreen}
          >
            {reportFullscreen ? (
              <Minimize2 className="mr-1 h-3 w-3" />
            ) : (
              <Maximize2 className="mr-1 h-3 w-3" />
            )}
            {reportFullscreen ? '축소' : '전체화면'}
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
              {/* 편집 — finalized 상태에서는 차단. 작성자가 발행 취소 후 편집. */}
              {existingReport?.phase !== 'finalized' && (
                <Button variant="outline" size="sm" onClick={() => onEnterEdit()}>
                  <Pencil className="mr-1 h-3 w-3" />
                  편집
                </Button>
              )}
              {/* 폴더 — context-dependent:
                  • personal workspace: 본인 보고서면 Report.folder_id 변경
                  • org workspace: 본 보고서가 이 게시판에 mount되어 있고
                    사용자가 owner/mounter/admin이면 mount.folder_id 변경
                  게시 버튼은 owner만 (개인 → 조직 흐름이라 의미). */}
              {!isNew && isPersonalContext &&
                existingReport?.owner_user_id === me?.user?.id && (
                  <FolderPickerButton
                    mode="personal"
                    reportId={existingReport.id}
                    folderId={existingReport.folder_id}
                    onChanged={() => reloadReport()}
                  />
              )}
              {!isNew && isOrgContext && currentMount && (
                <FolderPickerButton
                  mode="org"
                  workspaceSlug={slug}
                  reportId={existingReport.id}
                  folderId={currentMount.folder_id}
                  onChanged={(newFolderId) =>
                    setMountByWorkspace((m) => ({
                      ...m,
                      [slug]: { ...m[slug], folder_id: newFolderId },
                    }))
                  }
                />
              )}
              {!isNew && existingReport?.owner_user_id === me?.user?.id && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setMountOpen(true)}
                  title="조직 게시판에 게시 / 게시 해제"
                >
                  <Send className="mr-1 h-3 w-3" />
                  게시
                </Button>
              )}
              {/* 발행 / 발행 취소 — owner only. phase=finalized 면 unpublish,
                  그 외엔 publish. 한 버튼이 상황에 따라 라벨/액션 토글. */}
              {!isNew && existingReport?.owner_user_id === me?.user?.id && (
                <Button
                  variant={existingReport?.phase === 'finalized' ? 'secondary' : 'default'}
                  size="sm"
                  onClick={async () => {
                    try {
                      if (existingReport.phase === 'finalized') {
                        await unpublishReport(existingReport.id)
                        toast.success('발행 취소됨 (작성 모드로)')
                      } else {
                        await publishReport(existingReport.id)
                        toast.success('발행됨')
                      }
                      reloadReport()
                    } catch (e) {
                      toast.error(
                        e?.response?.data?.message || '동작 실패',
                      )
                    }
                  }}
                  title={
                    existingReport?.phase === 'finalized'
                      ? '발행 취소 (작성 모드로 되돌림)'
                      : '발행 — 편집 잠금, 게시판 멤버 알림'
                  }
                >
                  {existingReport?.phase === 'finalized' ? '발행 취소' : '발행'}
                </Button>
              )}
              {/* 활동 이력 popover — 누구나 조회. */}
              {!isNew && existingReport?.id && (
                <ActivityTimelineButton reportId={existingReport.id} />
              )}
              {/* 추가 편집자 관리 — owner는 추가/제거 가능, 그 외는
                  목록만 (왜 누가 편집권 가졌는지 확인용). */}
              {!isNew && existingReport?.id && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setEditorsOpen(true)}
                  title="추가 편집자"
                >
                  편집자
                </Button>
              )}
              {/* 작성자 hard lock — owner only. 클릭 시 prompt로 사유 받음
                  (v1; 후에 dialog로 교체). 잠금 상태에선 동일 버튼이 해제로. */}
              {!isNew && existingReport?.owner_user_id === me?.user?.id && (
                <Button
                  variant={existingReport?.author_lock_enabled ? 'destructive' : 'outline'}
                  size="sm"
                  onClick={async () => {
                    try {
                      if (existingReport.author_lock_enabled) {
                        if (!window.confirm('수정 잠금을 해제하시겠어요?')) return
                        await setAuthorLock(existingReport.id, { enabled: false })
                        toast.success('잠금 해제')
                      } else {
                        const reason = window.prompt(
                          '수정 잠금 사유 (선택, 비워두면 미기재):',
                          '',
                        )
                        // null = 취소
                        if (reason === null) return
                        await setAuthorLock(existingReport.id, {
                          enabled: true,
                          reason,
                        })
                        toast.success('수정 잠금 활성화')
                      }
                      reloadReport()
                    } catch (e) {
                      toast.error(e?.response?.data?.message || '잠금 변경 실패')
                    }
                  }}
                  title={
                    existingReport?.author_lock_enabled
                      ? '수정 잠금 해제'
                      : '작성자 외 편집 차단'
                  }
                >
                  {existingReport?.author_lock_enabled ? '🔒 잠금 해제' : '🔒 수정 잠금'}
                </Button>
              )}
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
              <DropdownMenuItem onSelect={() => setAiPromptPickerOpen(true)}>
                <Sparkles className="mr-2 h-3.5 w-3.5" />
                AI 프롬프트 선택
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

        {/* Phase banner — explicit signal that the report is past the
            drafting stage. drafting needs no banner (default state);
            reviewing + finalized do. */}
        {existingReport?.phase === 'reviewing' && (
          <div className="border-b bg-amber-50 px-6 py-2 text-xs text-amber-900 flex items-center gap-2">
            <span className="text-base">👀</span>
            <span className="font-medium">리뷰 진행 중</span>
            <span className="flex-1 text-amber-800/80">
              외부 코멘트가 달렸거나 조직 게시판에 게시된 상태. 코멘트 패널을
              우측에 펼쳐서 의견을 확인하세요.
            </span>
          </div>
        )}
        {existingReport?.phase === 'finalized' && (
          <div className="border-b bg-blue-50 px-6 py-2 text-xs text-blue-900 flex items-center gap-2">
            <span className="text-base">✅</span>
            <span className="font-medium">발행됨</span>
            <span className="flex-1 text-blue-800/80">
              작성자가 발행을 완료한 보고서. 편집은 차단되어 있으며,
              수정하려면 '발행 취소' 후 작성 모드로.
            </span>
          </div>
        )}

        {/* Author lock banner — sits below the toolbar so it's
            unmissable while not blocking the title. */}
        {existingReport?.author_lock_enabled && (
          <div className="border-b bg-red-50 px-6 py-2 text-xs text-red-800 flex items-center gap-2">
            <span className="text-base">🔒</span>
            <span className="font-medium">
              {existingReport.owner_name || '작성자'}가(이) 수정 잠금 —
            </span>
            <span className="flex-1 truncate">
              {existingReport.author_lock_reason || '사유 미기재'}
            </span>
            <span className="text-[10px] opacity-70">작성자 외 편집 불가</span>
          </div>
        )}

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
          onInsertCopy={insertPageCopy}
          onRenamePage={renamePage}
          isEditing={isEditing}
          viewMode={viewMode}
        />

        <ScrollArea className="flex-1">
          <div
            className={cn(
              // relative — SlideGuideOverlay 가 inset:0 으로 깔리려면
              // 부모가 positioning ancestor 여야 한다. 다른 위젯/페이지
              // 카드도 같은 컨테이너 안에서 absolute 를 쓰지 않으므로
              // 충돌은 없다.
              'relative p-6 space-y-8 mx-auto w-full report-detail-content',
              // When the writer opts into blending, drop the per-widget
              // card chrome so the page reads as one continuous surface.
              // The styling itself lives in index.css under
              // `.report-detail-content.report-blend-blocks` to keep
              // the selector authoritative and ditto for the inline
              // composite renderer in InlineReportView.
              draft.page_blend_blocks === true && 'report-blend-blocks',
            )}
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
            {/* PPT 슬라이드 가이드 — 컨테이너 첫 자식으로 마운트해서 모든
                위젯 뒤(z-0)에 깔린다. enabled 가 false 면 마운트 자체를
                건너뛰어 ResizeObserver 비용을 안 낸다. 인쇄/풀스크린에서의
                숨김은 CSS 가 담당. */}
            {draft.page_slide_guide === true && (
              <SlideGuideOverlay
                ratio={draft.page_slide_ratio ?? '16:9'}
                customW={draft.page_slide_ratio_custom_w}
                customH={draft.page_slide_ratio_custom_h}
              />
            )}
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
                    showPageHeader={pageCount > 1 && !reportFullscreen}
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
                    rowGapPx={draft.page_gap_px}
                    reportId={existingReport?.id ?? null}
                    reportPhase={existingReport?.phase}
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
                    showPageHeader={pageCount > 1 && !reportFullscreen}
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
                    rowGapPx={draft.page_gap_px}
                    reportId={existingReport?.id ?? null}
                    reportPhase={existingReport?.phase}
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

      {/* Comment side panel — sibling of main column inside the outer
          flex row. Toggle/state lives in CommentsContext so the pin on
          each widget can open it. Hidden until reportId is known (new
          reports + template-edit don't have one). */}
      {existingReport?.id && <CommentPanel />}

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

      <PromptPickerDialog
        open={aiPromptPickerOpen}
        onClose={() => setAiPromptPickerOpen(false)}
        onPick={(p) => {
          setAiPromptActive(p)
          setAiPromptPickerOpen(false)
        }}
      />

      <AiPromptDialog
        open={aiPromptActive != null}
        onOpenChange={(o) => !o && setAiPromptActive(null)}
        prompt={aiPromptActive}
        contextBuilder={aiPromptContextBuilder}
        widgetCatalog={widgetCatalog}
      />

      <PasteJsonDialog
        open={pasteJsonOpen}
        onOpenChange={setPasteJsonOpen}
        onReplace={async (text) => {
          await applyImportedDraft(text)
          toast.success('보고서 전체를 교체했습니다. 저장하려면 “저장” 버튼을 눌러주세요.')
        }}
        onAppendNewPages={async (text) => {
          await appendImportedAsNewPages(text)
          toast.success('JSON 의 페이지를 새 페이지로 뒤에 추가했습니다.')
        }}
        onAppendToCurrentPage={(text) => {
          appendImportedToCurrentPage(text)
          toast.success('JSON 의 위젯을 현재 페이지 끝에 이어 붙였습니다.')
        }}
        onApplyPatch={(text) => {
          applyPatchToCurrentPage(text)
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

      <MountDialog
        open={mountOpen}
        onOpenChange={setMountOpen}
        report={existingReport}
        onChanged={() => {
          /* future: refresh report meta to pick up phase auto-transition */
        }}
      />

      <EditorsDialog
        open={editorsOpen}
        onOpenChange={setEditorsOpen}
        report={existingReport}
        onChanged={() => {
          /* server stamps activity + notifies the new editor; no
              local report fields to refresh */
        }}
      />

      <ReportSettingsDialog
        open={settingsDialogOpen}
        currentWidthPx={draft?.page_width_px ?? null}
        defaultWidthPx={DEFAULT_REPORT_WIDTH_PX}
        currentGapPx={draft?.page_gap_px ?? null}
        defaultGapPx={DEFAULT_REPORT_GAP_PX}
        currentBlendBlocks={draft?.page_blend_blocks === true}
        currentSlideGuide={
          draft
            ? {
                enabled: draft.page_slide_guide === true,
                ratio: draft.page_slide_ratio ?? null,
                customW: draft.page_slide_ratio_custom_w ?? null,
                customH: draft.page_slide_ratio_custom_h ?? null,
              }
            : null
        }
        showPropertiesTab
        currentTypeId={draft?.report_type_id ?? null}
        currentType={draft?.report_type ?? null}
        currentEntities={draft?.entities ?? []}
        metadata={
          // draft holds the user-editable subset (title/status/report_date);
          // owner/workspace/timestamps are server-authoritative and only
          // exist post-save, so we pull them from `existingReport`. For
          // brand-new reports `existingReport` is null and those rows
          // auto-hide via MetadataList's empty-value filter.
          draft
            ? {
                title: draft.title,
                report_date: draft.report_date,
                status: draft.status,
                owner_name: existingReport?.owner_name,
                owner_email: existingReport?.owner_email,
                workspace_slug: existingReport?.workspace_slug ?? slug,
                created_at: existingReport?.created_at,
                updated_at: existingReport?.updated_at,
                updated_by_name: existingReport?.updated_by_name,
                updated_by_email: existingReport?.updated_by_email,
              }
            : null
        }
        onClose={() => setSettingsDialogOpen(false)}
        onApplyWidth={(px) => {
          // Dialog batches width + gap + type drafts and fires these on
          // its own footer "적용"; we just merge into the report draft.
          // The dialog closes itself afterwards.
          setDraft((d) => (d ? { ...d, page_width_px: px } : d))
        }}
        onApplyGap={(px) => {
          setDraft((d) => {
            if (!d) return d
            // Rescale row_span values across all pages so each widget's
            // visual height stays the same after the inter-cell margin
            // changes. Without this, non-autofit widgets (charts,
            // scatter etc.) keep their stored row_span and the new
            // larger margin makes them blow up vertically — every extra
            // unit of margin adds (h-1)*Δmargin to the rendered height.
            const oldGap = Number.isFinite(d.page_gap_px)
              ? d.page_gap_px
              : REPORT_ROW_GAP
            const newGap = Number.isFinite(px) ? px : REPORT_ROW_GAP
            if (oldGap === newGap) {
              return { ...d, page_gap_px: px }
            }
            const rescale = (h) => {
              if (!Number.isFinite(h) || h < 1) return h
              const visual = h * REPORT_ROW_HEIGHT + (h - 1) * oldGap
              return Math.max(
                1,
                Math.round(
                  (visual + newGap) / (REPORT_ROW_HEIGHT + newGap),
                ),
              )
            }
            const nextPages = d.pages.map((page) => {
              const tpl = getCachedTemplate(pageTemplateMap, page)
              const tplBlocks = tpl
                ? (tpl.schema?.blocks ?? [])
                : []
              const overrides = { ...(page.layout_overrides ?? {}) }
              let changed = false
              // 1) Walk template blocks and write rescaled overrides where
              //    needed. Without this, blocks that fall through to
              //    `block.layout` (i.e. no per-report override yet) would
              //    still render at the old gap's row_span — exactly the
              //    case where charts blow up after a gap change.
              for (const b of tplBlocks) {
                const existing = overrides[b.id]
                const baseRowSpan = Number.isFinite(existing?.row_span)
                  ? existing.row_span
                  : Number.isFinite(b.layout?.row_span)
                    ? b.layout.row_span
                    : null
                if (!Number.isFinite(baseRowSpan)) continue
                const nh = rescale(baseRowSpan)
                if (nh === baseRowSpan) continue
                const merged = {
                  row: existing?.row ?? b.layout?.row ?? 1,
                  col_span:
                    existing?.col_span ?? b.layout?.col_span ?? REPORT_GRID_COLS,
                  row_span: nh,
                  ...(existing && 'auto_fit' in existing
                    ? { auto_fit: existing.auto_fit }
                    : {}),
                }
                overrides[b.id] = merged
                changed = true
              }
              // 2) Update any leftover overrides for blocks that aren't in
              //    the template (e.g. orphaned ids from old data).
              for (const [id, layout] of Object.entries(overrides)) {
                if (tplBlocks.some((b) => b.id === id)) continue
                if (!Number.isFinite(layout?.row_span)) continue
                const nh = rescale(layout.row_span)
                if (nh !== layout.row_span) {
                  overrides[id] = { ...layout, row_span: nh }
                  changed = true
                }
              }
              // 3) Rescale per-report extra_blocks' own layouts in place.
              const extras = page.extra_blocks ?? []
              let extrasChanged = false
              const nextExtras = extras.map((b) => {
                if (Number.isFinite(b?.layout?.row_span)) {
                  const nh = rescale(b.layout.row_span)
                  if (nh !== b.layout.row_span) {
                    extrasChanged = true
                    return { ...b, layout: { ...b.layout, row_span: nh } }
                  }
                }
                return b
              })
              if (!changed && !extrasChanged) return page
              return {
                ...page,
                layout_overrides:
                  Object.keys(overrides).length > 0 ? overrides : null,
                extra_blocks: extrasChanged ? nextExtras : extras,
              }
            })
            return { ...d, page_gap_px: px, pages: nextPages }
          })
        }}
        onApplyBlendBlocks={(blend) => {
          setDraft((d) => (d ? { ...d, page_blend_blocks: blend === true } : d))
        }}
        onApplySlideGuide={(cfg) => {
          // cfg = { enabled, ratio, customW, customH }. enabled 이 false
          // 면 비율/커스텀 값도 같이 비워서 draft 가 깔끔하게 OFF 상태로
          // 돌아가도록 한다 (저장 시에도 같은 정책을 따른다).
          setDraft((d) => {
            if (!d) return d
            const enabled = cfg?.enabled === true
            return {
              ...d,
              page_slide_guide: enabled,
              page_slide_ratio: enabled ? cfg?.ratio ?? null : null,
              page_slide_ratio_custom_w:
                enabled && cfg?.ratio === 'custom' ? cfg?.customW ?? null : null,
              page_slide_ratio_custom_h:
                enabled && cfg?.ratio === 'custom' ? cfg?.customH ?? null : null,
            }
          })
        }}
        onApplyType={({ id, ref }) => {
          setDraft((d) => (d ? { ...d, report_type_id: id, report_type: ref } : d))
        }}
        onApplyEntities={(entities) => {
          // Slim EntityRefMini[] handed back from the dialog. Persisted on
          // save via entity_ids in the PATCH payload (above); held here
          // so the dialog re-opens with the user's draft chips intact
          // even before they save.
          setDraft((d) => (d ? { ...d, entities } : d))
        }}
      />

      <TakeoverLockDialog
        holder={takeoverPrompt}
        onCancel={() => setTakeoverPrompt(null)}
        onConfirm={() => onEnterEdit({ force: true })}
      />

      <UnsavedChangesDialog
        open={!!unsavedNavPrompt}
        saving={!!unsavedNavPrompt?.saving}
        onSaveAndLeave={async () => {
          // Run the same save path the toolbar's "저장" uses. On success
          // onSave() flips isEditing=false and (for new reports) navigates
          // away — but the explicit proceed() below is what unblocks
          // *this* originally-blocked navigation. We flag `saving` so the
          // dialog can show progress and stay open if onSave throws.
          setUnsavedNavPrompt((p) => (p ? { ...p, saving: true } : p))
          try {
            await onSave()
            // Mark clean for the proceed call below. onSave's setIsEditing
            // is async, so we update the ref synchronously here too.
            isEditingRef.current = false
            editingSnapshotRef.current = null
            unsavedNavPrompt?.proceed()
            setUnsavedNavPrompt(null)
          } catch {
            // onSave already toasts. Drop the saving flag so the user
            // can retry or pick a different action.
            setUnsavedNavPrompt((p) => (p ? { ...p, saving: false } : p))
          }
        }}
        onDiscardAndLeave={() => {
          // Mark clean so the blocker (and any subsequent guards) lets
          // navigation through. We don't roll back `draft` itself —
          // the navigation is about to unmount this view anyway.
          isEditingRef.current = false
          editingSnapshotRef.current = null
          unsavedNavPrompt?.proceed()
          setUnsavedNavPrompt(null)
        }}
        onStay={() => {
          unsavedNavPrompt?.reset()
          setUnsavedNavPrompt(null)
        }}
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
          <FloatingCopyJson onCopy={handleCopyJson} />
          <FloatingPasteJson onOpen={() => setPasteJsonOpen(true)} />
          <FloatingReportSettings onOpen={() => setSettingsDialogOpen(true)} />
          <FloatingAddWidget
            onAdd={(type, defaults) =>
              addExtraBlock(safeCurrent, type, defaults)
            }
          />
        </div>
      )}
      {/* 전체화면 모드에서는 툴바가 숨어 종료 동선이 사라지므로
          우상단에 작은 종료 핀을 띄운다. ESC로도 빠질 수 있다. */}
      {reportFullscreen && (
        <div className="report-detail-floating fixed top-3 right-3 z-50 print:hidden">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setReportFullscreen(false)}
            title="전체화면 종료 (Esc)"
            className="shadow-md"
          >
            <Minimize2 className="mr-1 h-3 w-3" />
            전체화면 종료
          </Button>
        </div>
      )}
      {/* DOCX export progress overlay — fixed full-screen dim + center
          card with spinner + step label + (when known) bar. Blocks user
          interaction during export which is desirable: clicking around
          while html2canvas captures the DOM yields garbage. Driven by
          `docxProgress` state; hidden when null. */}
      {docxProgress && <DocxExportOverlay progress={docxProgress} />}
    </div>
    </CommentsProvider>
    </PrintScaleContext.Provider>
  )
}

/** Centered, blocking spinner shown during Word export. Reads the
 *  progress feed from `exportReportToDocx.onProgress` so the user sees
 *  "위젯 변환 중 (N/M)" tick instead of staring at a frozen page. */
function DocxExportOverlay({ progress }) {
  const isBlock = progress.phase === 'block'
  const pct =
    isBlock && progress.total > 0
      ? Math.round((progress.current / progress.total) * 100)
      : null
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 backdrop-blur-sm"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="rounded-lg border bg-card shadow-xl px-6 py-5 min-w-[280px] max-w-sm">
        <div className="flex items-center gap-3 mb-2">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
          <div className="font-semibold text-sm">Word 파일로 저장 중</div>
        </div>
        <div className="text-xs text-muted-foreground mb-2">
          {progress.label ?? '진행 중...'}
        </div>
        {isBlock && progress.total > 0 && (
          <>
            <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-200"
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="mt-1.5 text-[11px] text-muted-foreground tabular-nums">
              {progress.current}/{progress.total} ({pct}%)
            </div>
          </>
        )}
      </div>
    </div>
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


/** Renders the selected prompt's body — with placeholder tokens already
 *  expanded via renderPrompt(prompt.body, context) — in a read-only
 *  textarea with a "복사" button + a widget-coverage sidebar. The dialog
 *  is content-agnostic: any prompt row from the catalog works, so the
 *  hard-coded "v1 / v2 / v3 …" menu is no longer needed.
 *
 *  Coverage rule:
 *    - prompt.wildcard_all = true (body has {{widget_catalog}} or
 *      {{widget_examples}}) → every catalog widget counts as covered.
 *    - otherwise            → covered = derived_widget_types (the set
 *      of {{widget:foo}} tokens). The rest goes in the "미등록" group.
 */
function AiPromptDialog({
  open,
  onOpenChange,
  prompt,
  contextBuilder,
  widgetCatalog,
}) {
  // Widgets unchecked in the sidebar. Only meaningful when the prompt
  // body has wildcard tokens ({{widget_catalog}} / {{widget_examples}})
  // — for those, buildPromptContext strips excluded types from the
  // catalog block + examples block, shrinking the rendered prompt so
  // very long catalogs don't choke the AI.
  //
  // Persisted to localStorage per prompt id so the user's curated
  // selection survives close/reopen of the dialog. Default = empty
  // (everything checked) for unknown prompts.
  const storageKey = prompt?.id ? `ai-prompt-excluded:${prompt.id}` : null
  const [excludedTypes, setExcludedTypes] = useState(() => new Set())

  // Re-seed exclusion set whenever the dialog opens onto a different
  // prompt. Reads from localStorage first; falls back to empty set.
  useEffect(() => {
    if (!open || !prompt?.id) {
      setExcludedTypes(new Set())
      return
    }
    try {
      const raw = localStorage.getItem(`ai-prompt-excluded:${prompt.id}`)
      if (raw) {
        const arr = JSON.parse(raw)
        if (Array.isArray(arr)) {
          setExcludedTypes(new Set(arr))
          return
        }
      }
    } catch {
      /* corrupt entry — ignore */
    }
    setExcludedTypes(new Set())
  }, [open, prompt?.id])

  // Persist on change. Skip during initial open before the seed effect
  // has fired (storageKey null + open false case).
  useEffect(() => {
    if (!open || !storageKey) return
    try {
      if (excludedTypes.size === 0) {
        localStorage.removeItem(storageKey)
      } else {
        localStorage.setItem(storageKey, JSON.stringify([...excludedTypes]))
      }
    } catch {
      /* quota / disabled storage — silently ignore */
    }
  }, [excludedTypes, open, storageKey])

  const context = useMemo(
    () => contextBuilder(excludedTypes),
    [contextBuilder, excludedTypes],
  )

  const text = useMemo(() => {
    if (!open || !prompt) return ''
    return renderPrompt(prompt.body, context)
  }, [open, prompt, context])

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text)
      toast.success('프롬프트를 클립보드에 복사했습니다.')
    } catch {
      toast.error('클립보드 복사에 실패했습니다. 직접 선택해 복사해 주세요.')
    }
  }

  const widgetCoverage = useMemo(() => {
    const widgets = widgetCatalog?.widgets ?? []
    const coveredSet = prompt?.wildcard_all
      ? new Set(widgets.map((w) => w.type))
      : new Set(prompt?.derived_widget_types ?? [])
    const covered = []
    const uncovered = []
    for (const w of widgets) {
      if (coveredSet.has(w.type)) covered.push(w)
      else uncovered.push(w)
    }
    return {
      covered,
      uncovered,
      total: widgets.length,
      loading: !widgetCatalog,
      wildcardAll: !!prompt?.wildcard_all,
      pageContext: !!prompt?.page_context,
    }
  }, [prompt, widgetCatalog])

  // Checkbox toggles only make sense for wildcard prompts — those are
  // the ones where the catalog/examples block is the bulky part of
  // the rendered text. Non-wildcard prompts already target specific
  // widgets via {{widget:foo}} tokens that we honor as-is.
  const interactive = !!prompt?.wildcard_all

  function handleToggleType(type) {
    setExcludedTypes((prev) => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  function handleToggleAll(checkedAll) {
    if (checkedAll) {
      // All-on → nothing excluded
      setExcludedTypes(new Set())
    } else {
      // All-off → exclude every covered widget. Uncovered widgets
      // wouldn't have been in the prompt anyway, so leaving them out
      // of the set keeps the storage tidy.
      setExcludedTypes(new Set(widgetCoverage.covered.map((w) => w.type)))
    }
  }

  const title = prompt?.name
    ? `AI 프롬프트 — ${prompt.name}`
    : 'AI 프롬프트'
  const description =
    prompt?.description ||
    '아래 프롬프트를 AI에 보내고, 보고서 본문을 함께 입력하면 JSON 결과를 받을 수 있습니다. 그 JSON 을 "JSON 데이터 붙여넣기"로 다시 불러오세요.'

  const charCount = text.length
  const charCountKb = Math.round(charCount / 102.4) / 10

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" />
            {title}
          </DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">{description}</p>
        <div className="flex-1 min-h-0 flex gap-3">
          <WidgetCoverageSidebar
            coverage={widgetCoverage}
            interactive={interactive}
            excludedTypes={excludedTypes}
            onToggleType={handleToggleType}
            onToggleAll={handleToggleAll}
          />
          <Textarea
            readOnly
            value={text}
            onClick={(e) => e.currentTarget.select()}
            className="flex-1 min-h-[320px] font-mono text-[11px] leading-relaxed"
          />
        </div>
        <div className="flex items-center gap-2 pt-2">
          <span className="text-[11px] text-muted-foreground">
            {charCount.toLocaleString()} 자 · {charCountKb} KB
            {interactive && excludedTypes.size > 0 && (
              <span className="ml-2 text-amber-600">
                ({excludedTypes.size}개 위젯 제외 적용 중)
              </span>
            )}
          </span>
          <div className="flex-1" />
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            닫기
          </Button>
          <Button size="sm" onClick={handleCopy} disabled={!text}>
            <Copy className="mr-1 h-3 w-3" />
            복사
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Left-hand sidebar in AiPromptDialog.
 *
 *  Two modes share this component:
 *    - **읽기 전용** (default, non-wildcard prompts): green check / red
 *      X icons next to each catalog widget so the author can see at a
 *      glance which widgets the prompt covers.
 *    - **인터랙티브** (wildcard prompts only — body has
 *      `{{widget_catalog}}` / `{{widget_examples}}`): each covered
 *      widget gets a checkbox. Unchecking strips that widget from the
 *      rendered catalog + examples blocks so the AI sees a shorter
 *      prompt. Useful when the full catalog blows past the model's
 *      context window or just dilutes attention. Selection persists
 *      per prompt id in localStorage (handled by the parent dialog).
 *
 *  "미등록" widgets (no `{{widget:foo}}` example registered) stay
 *  display-only even in interactive mode — toggling them does nothing
 *  because they aren't in the prompt to begin with. */
function WidgetCoverageSidebar({
  coverage,
  interactive = false,
  excludedTypes,
  onToggleType,
  onToggleAll,
}) {
  const { covered, uncovered, total, loading, wildcardAll, pageContext } =
    coverage
  const excludedSet = excludedTypes ?? new Set()
  const selectedCount = interactive
    ? covered.length - covered.filter((w) => excludedSet.has(w.type)).length
    : covered.length
  const allSelected = interactive && selectedCount === covered.length
  const noneSelected = interactive && selectedCount === 0

  return (
    <div className="w-60 shrink-0 border rounded-md overflow-auto p-2 text-xs bg-muted/20">
      {pageContext && (
        <div className="mb-2 rounded-md border border-violet-500/40 bg-violet-500/10 px-2 py-1.5">
          <div className="font-medium text-violet-700">페이지 편집 모드</div>
          <div className="text-[10px] text-muted-foreground mt-0.5 leading-relaxed">
            이 프롬프트는 <code>&#123;&#123;template_blocks&#125;&#125;</code> 를 사용해 현재 페이지의 블록들을 컨텍스트로 받습니다. AI 응답을 받으면 “JSON 데이터 붙여넣기 → 일부 블록 갱신” 으로 적용하세요.
          </div>
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <div className="font-medium">
          {interactive ? '사용할 위젯 선택' : '위젯 등록 현황'}
        </div>
        {interactive && covered.length > 0 && (
          <button
            type="button"
            onClick={() => onToggleAll?.(!allSelected)}
            className="text-[10px] text-primary hover:underline"
          >
            {allSelected ? '전체 해제' : '전체 선택'}
          </button>
        )}
      </div>
      <div className="text-[10px] text-muted-foreground mb-2">
        {loading
          ? '카탈로그 불러오는 중…'
          : interactive
            ? `선택 ${selectedCount} / 등록 ${covered.length} (전체 ${total})`
            : wildcardAll
              ? `전체 위젯 포함 (catalog/examples wildcard)`
              : `등록 ${covered.length} / 전체 ${total}`}
      </div>
      {interactive && noneSelected && (
        <div className="mb-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-2 py-1 text-[10px] text-amber-700 leading-relaxed">
          모든 위젯이 제외돼 있어 AI 가 어떤 위젯도 만들 수 없습니다. 최소 1개는 선택하세요.
        </div>
      )}
      {covered.length > 0 && (
        <div className="space-y-0.5 mb-3">
          {covered.map((w) => (
            <WidgetCoverageRow
              key={w.type}
              widget={w}
              covered
              interactive={interactive}
              checked={interactive ? !excludedSet.has(w.type) : true}
              onToggle={() => onToggleType?.(w.type)}
            />
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
              <WidgetCoverageRow
                key={w.type}
                widget={w}
                covered={false}
                interactive={false}
              />
            ))}
          </div>
        </>
      )}
      {!loading && total === 0 && (
        <div className="text-[10px] text-muted-foreground italic">
          위젯 카탈로그가 비어 있습니다.
        </div>
      )}
      {interactive && (
        <div className="mt-2 pt-2 border-t text-[10px] text-muted-foreground leading-relaxed">
          체크 해제는 <code>&#123;&#123;widget_catalog&#125;&#125;</code> /
          {' '}<code>&#123;&#123;widget_examples&#125;&#125;</code> 토큰에만 적용됩니다.
          본문에 직접 적힌 <code>&#123;&#123;widget:foo&#125;&#125;</code> 토큰은 그대로 유지.
        </div>
      )}
    </div>
  )
}

function WidgetCoverageRow({
  widget,
  covered,
  interactive = false,
  checked = true,
  onToggle,
}) {
  const tooltip = widget.description || widget.label || widget.type
  // Interactive covered row: render a checkbox label so the whole row
  // is clickable. Non-interactive (or uncovered) row: keep the
  // original check / X icon display.
  if (interactive && covered) {
    return (
      <label
        className="flex items-start gap-1.5 py-0.5 cursor-pointer hover:bg-background/60 rounded px-1 -mx-1"
        title={tooltip}
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          className="mt-0.5 h-3 w-3 shrink-0 accent-primary cursor-pointer"
        />
        <div className="min-w-0 flex-1">
          <div
            className={`font-mono text-[10px] leading-tight truncate ${
              checked ? '' : 'text-muted-foreground line-through'
            }`}
          >
            {widget.type}
          </div>
          {widget.label && widget.label !== widget.type && (
            <div className="text-[10px] text-muted-foreground leading-tight truncate">
              {widget.label}
            </div>
          )}
        </div>
      </label>
    )
  }
  return (
    <div
      className="flex items-start gap-1.5 py-0.5"
      title={tooltip}
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
 *  instead of uploading a file. Four commit modes — what differs is
 *  *where* the imported content lands:
 *   - 전체 교체           → replace the whole draft (title/date/tags
 *                          + every page).
 *   - 새 페이지로 추가     → keep current draft; the imported pages
 *                          land at the END of the page list as their
 *                          own pages.
 *   - 현재 페이지 끝에 추가 → flatten the imported widgets and slot
 *                          them into the CURRENT page's extra_blocks.
 *                          Current page's template + metadata stays.
 *   - 일부 블록 갱신       → expects a `report_archive_draft_patch_v1`
 *                          payload; overlays its block_updates onto
 *                          the current page's content / props_overrides.
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
  onApplyPatch,
}) {
  const [text, setText] = useState('')
  const [err, setErr] = useState('')
  const [submitting, setSubmitting] = useState(false)
  // Live "is this a patch payload?" probe — surfaces a single-line
  // preview ("N개 블록 갱신 예정: …") so the author sees what's about
  // to happen *before* hitting the patch button. Falls back to null
  // for any non-patch / invalid input — no preview shown, no error.
  const patchPreview = useMemo(() => probePatchPreview(text), [text])
  useEffect(() => {
    if (open) {
      setText('')
      setErr('')
      setSubmitting(false)
    }
  }, [open])

  // Wraps both sync and async callbacks — `applyImportedDraft` /
  // `appendImportedAsNewPages` are async now (they fetch the template's
  // latest version before pushing the new draft) so we resolve the
  // return value through Promise.resolve before closing the dialog.
  function runWith(fn) {
    if (!text.trim()) {
      setErr('붙여넣을 JSON 내용이 비어 있습니다.')
      return
    }
    setSubmitting(true)
    Promise.resolve()
      .then(() => fn(text))
      .then(() => {
        setSubmitting(false)
        onOpenChange(false)
      })
      .catch((e) => {
        setSubmitting(false)
        setErr(e?.message || '실패')
      })
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
          <div>
            <strong>일부 블록 갱신</strong>: <code>_type=&quot;report_archive_draft_patch_v1&quot;</code> 형식의 JSON 을 받아 현재 페이지의 지정 블록만 덮어씁니다. (id 가 없는 블록은 건너뜀)
          </div>
        </div>
        {patchPreview && (
          <div className="rounded-md border border-primary/40 bg-primary/5 px-2 py-1.5 text-[11px] leading-relaxed">
            <div className="font-medium">
              패치 미리보기 — {patchPreview.count}개 블록 갱신 예정
            </div>
            <div className="mt-0.5 text-muted-foreground break-all">
              {patchPreview.ids.slice(0, 12).join(', ')}
              {patchPreview.ids.length > 12 &&
                ` … (+${patchPreview.ids.length - 12})`}
            </div>
          </div>
        )}
        {err && (
          <p className="text-xs text-destructive whitespace-pre-wrap">{err}</p>
        )}
        <div className="flex justify-end gap-2 pt-2 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            취소
          </Button>
          {onApplyPatch && (
            <Button
              variant={patchPreview ? 'default' : 'outline'}
              size="sm"
              onClick={() => runWith(onApplyPatch)}
              disabled={submitting}
              title="JSON 의 block_updates 를 현재 페이지의 블록에 덮어쓰기 (id 매칭)"
            >
              <Sparkles className="mr-1 h-3 w-3" />
              일부 블록 갱신
            </Button>
          )}
          {onAppendToCurrentPage && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => runWith(onAppendToCurrentPage)}
              disabled={submitting}
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
              disabled={submitting}
              title="JSON 의 페이지들을 그대로 뒤에 새 페이지로 추가"
            >
              <Plus className="mr-1 h-3 w-3" />
              새 페이지로 추가
            </Button>
          )}
          <Button
            size="sm"
            onClick={() => runWith(onReplace)}
            disabled={submitting}
            title="보고서 전체를 교체"
          >
            <Upload className="mr-1 h-3 w-3" />
            {submitting ? '처리 중...' : '전체 교체'}
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

/** Dirty-navigation guard dialog — surfaces when the user tries to leave
 *  the page (in-SPA navigation OR browser unload) while the report draft
 *  has unsaved changes. Three paths out: save+leave (preserves data),
 *  discard+leave (loses the diff), stay (no-op).
 *
 *  `saving` reflects an in-flight onSave from the save-and-leave button
 *  so we can disable the buttons and show progress without dismissing
 *  the dialog (the dialog stays open if onSave throws, e.g. lock conflict). */
function UnsavedChangesDialog({
  open,
  saving = false,
  onSaveAndLeave,
  onDiscardAndLeave,
  onStay,
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !saving) onStay?.() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>저장하지 않은 변경사항</DialogTitle>
        </DialogHeader>
        <p className="text-sm">
          이 보고서에 저장하지 않은 편집이 있습니다. 페이지를 떠나면 변경사항이
          사라질 수 있습니다 — 어떻게 할까요?
        </p>
        <p className="text-xs text-muted-foreground">
          "저장 후 나가기" 는 일반 저장과 동일하게 처리되고, 저장이 끝나면
          원래 이동하려던 곳으로 자동 이동합니다.
        </p>
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <Button variant="ghost" size="sm" onClick={onStay} disabled={saving}>
            취소 (머무름)
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onDiscardAndLeave}
            disabled={saving}
          >
            저장 안 함
          </Button>
          <Button size="sm" onClick={onSaveAndLeave} disabled={saving}>
            {saving ? '저장 중...' : '저장 후 나가기'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Inline 상태 chip. Read-only badge when viewing; switches to a small
 *  select in edit mode so users can flip between 작성 중 / 진행 업무 /
 *  완료 업무. Status is part of the dashboard's status panel aggregation. */
/** ReportPhase chip — read-only display. Phase transitions happen via
 *  side effects (mount, first external comment) and the 발행/발행취소
 *  button; users never set phase via a dropdown. */
function PhaseChip({ phase }) {
  const meta = PHASE_META[phase] ?? PHASE_META.drafting
  return (
    <Badge variant={meta.variant} title={meta.tooltip}>
      {meta.label}
    </Badge>
  )
}

/** "포함된 종합 문서 N개" — Phase 5C 양방향 네비. 이 보고서가 어떤 종합
 *  문서에 item 으로 인용되고 있는지 한 클릭에 보이고 그쪽으로 이동.
 *
 *  Lazy fetch: 데이터를 항상 불러오되 0건이면 컴포넌트 자체가 렌더
 *  안 됨 → 헤더 noise 최소화. fetch 비용은 작은 JOIN (composite
 *  count 가 보통 한 자릿수).
 *
 *  렌더 결정:
 *   - 0건: null
 *   - 1~∞건: Popover trigger (count chip) + 목록. 0건일 가능성이 흔해서
 *     count 가 0 일 때 "포함되어 있지 않음" 같은 dead chip 은 안 띄움. */
function ContainingCompositesChip({ reportId }) {
  const navigate = useNavigate()
  const { data } = useAsync(
    () =>
      reportId
        ? listCompositesContainingReport(reportId)
        : Promise.resolve([]),
    [reportId],
  )
  const list = data ?? []
  if (list.length === 0) return null
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-full bg-secondary text-secondary-foreground px-2 py-0.5 text-[11px] font-medium hover:bg-secondary/80 transition-colors"
          title="이 보고서가 인용된 종합 문서 목록"
        >
          <Layers className="h-3 w-3" />
          포함된 종합 문서 {list.length}개
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-1">
        <div className="max-h-72 overflow-y-auto space-y-0.5">
          {list.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() =>
                navigate(`/w/${c.workspace_slug}/composites/${c.id}`)
              }
              className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-muted"
            >
              <Layers className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{c.title}</div>
                <div className="text-[11px] text-muted-foreground flex items-center gap-1.5 flex-wrap mt-0.5">
                  <span className="inline-flex items-center rounded-full bg-primary/10 text-primary px-1 py-0 text-[10px]">
                    {c.kind === 'recurring' ? '정기' : '주제'}
                  </span>
                  {c.published_at && (
                    <span className="text-blue-600 dark:text-blue-400">
                      발행됨
                    </span>
                  )}
                  {c.period_date && <span>· 기준 {c.period_date}</span>}
                  {c.owner_name && <span>· {c.owner_name}</span>}
                </div>
              </div>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

const PHASE_META = {
  drafting: {
    label: '작성 중',
    variant: 'secondary',
    tooltip: '아직 외부 리뷰가 시작되지 않은 상태. 자유 편집.',
  },
  reviewing: {
    label: '리뷰 중',
    variant: 'default',
    tooltip:
      '게시되거나 외부 코멘트가 달려 리뷰 단계로 진입. 편집은 여전히 가능.',
  },
  finalized: {
    label: '발행됨',
    variant: 'outline',
    tooltip:
      '작성자가 발행 액션을 한 상태. 작성자 외 편집 차단. 발행 취소로 작성 모드 복귀.',
  },
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
  onInsertCopy,
  onRenamePage,
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
  // Expanded "browse" panel — search box + page card grid with mini-
  // schematic of each page's widget layout. Closed by default; opens
  // on click of the [LayoutGrid] toggle at the right end of the strip.
  const [expanded, setExpanded] = useState(false)
  const [query, setQuery] = useState('')
  // In-memory clipboard for Ctrl+C / Ctrl+V on page chips. Always stores
  // an ARRAY of page snapshots (single-page copy → length 1). Module-
  // local so it doesn't persist across report navigation — pasting a
  // template-shaped clone into a different report's registry is unsafe.
  const clipboardRef = useRef([])

  // Multi-select state for the chip strip. Plain click clears + selects
  // a single idx; Ctrl/Cmd+Click toggles individual indices; Shift+
  // Click ranges from the last anchor. Selection drives Ctrl+C — when
  // non-empty, *all* selected pages get copied in numeric order.
  const [selectedIdxs, setSelectedIdxs] = useState(() => new Set())
  // Anchor for shift+click range selection. Mirrors the DataTable
  // pattern: last single-toggled idx; stays put across consecutive
  // shift+clicks so the user can grow/shrink the range from one start.
  const anchorIdxRef = useRef(null)
  // Clear selection if the page set itself changed under us (page
  // added / removed / reordered) — stale indices could point at
  // shifted content.
  useEffect(() => {
    setSelectedIdxs(new Set())
  }, [pages.length])

  // F2 inline-rename state. `renamingIdx` is the chip whose label is
  // currently being edited via the on-chip <Input>; null when no rename
  // is active. `renameValue` mirrors the input's text and is flushed
  // to the parent via `onRenamePage` on commit.
  const [renamingIdx, setRenamingIdx] = useState(null)
  const [renameValue, setRenameValue] = useState('')
  // Esc cancel path: Esc tells the input to blur, which then runs the
  // commit-on-blur logic. The flag lets that handler distinguish
  // "user cancelled" from "user clicked outside" so Esc doesn't save
  // partial edits.
  const cancelRenameRef = useRef(false)

  function handleChipClick(event, idx) {
    if (event.shiftKey && anchorIdxRef.current !== null) {
      const anchor = anchorIdxRef.current
      const lo = Math.min(anchor, idx)
      const hi = Math.max(anchor, idx)
      const range = new Set()
      for (let i = lo; i <= hi; i++) range.add(i)
      setSelectedIdxs(range)
      onSelect(idx)
      return
    }
    if (event.ctrlKey || event.metaKey) {
      setSelectedIdxs((prev) => {
        const next = new Set(prev)
        if (next.has(idx)) next.delete(idx)
        else next.add(idx)
        return next
      })
      anchorIdxRef.current = idx
      onSelect(idx)
      return
    }
    // Plain click — clear multi-selection, navigate, reseat anchor.
    setSelectedIdxs(new Set())
    anchorIdxRef.current = idx
    onSelect(idx)
  }

  function handleChipKeyDown(event, idx) {
    // F2 → enter inline rename mode for this chip.
    if (event.key === 'F2') {
      event.preventDefault()
      const src = pages[idx]
      setRenamingIdx(idx)
      setRenameValue(src?.name ?? '')
      return
    }
    const isCmdC =
      (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c'
    const isCmdV =
      (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v'
    if (!isCmdC && !isCmdV) return
    // Skip if there's a real text selection — keep normal OS clipboard
    // behavior for users that highlighted page label text manually.
    if (typeof window !== 'undefined') {
      const sel = window.getSelection?.()
      if (sel && !sel.isCollapsed) return
    }
    if (isCmdC) {
      event.preventDefault()
      // If the user has built a multi-select, copy ALL of those (in
      // numeric order). Otherwise fall back to the focused chip.
      const indices =
        selectedIdxs.size > 0
          ? [...selectedIdxs].sort((a, b) => a - b)
          : [idx]
      const snapshots = indices
        .map((i) => pages[i])
        .filter(Boolean)
        // Deep clone via JSON so post-copy edits to the source pages
        // don't bleed into the clipboard. Page payloads are pure data
        // (no Date / Map / Set) so JSON is sufficient.
        .map((p) => JSON.parse(JSON.stringify(p)))
      if (snapshots.length === 0) return
      clipboardRef.current = snapshots
      toast.success(
        snapshots.length === 1
          ? `페이지 ${indices[0] + 1} 복사됨 — Ctrl+V 로 새 페이지로 붙여넣기`
          : `페이지 ${snapshots.length}개 복사됨 (${indices.map((i) => i + 1).join(', ')}) — Ctrl+V 로 붙여넣기`,
      )
      return
    }
    if (isCmdV) {
      event.preventDefault()
      const clip = clipboardRef.current
      if (!clip || clip.length === 0) {
        toast.message(
          '복사된 페이지가 없습니다. 먼저 페이지 chip 위에서 Ctrl+C 로 복사하세요.',
        )
        return
      }
      if (typeof onInsertCopy !== 'function') return
      onInsertCopy(idx, clip)
      toast.success(
        clip.length === 1
          ? `페이지 ${idx + 1} 뒤에 복제 페이지 추가됨`
          : `페이지 ${idx + 1} 뒤에 ${clip.length}개 복제 페이지 추가됨`,
      )
      setSelectedIdxs(new Set())
    }
  }

  // Rename input handlers. Enter / Escape both blur the input which
  // routes through `handleRenameBlur`; the cancel flag distinguishes
  // the two paths so Esc discards instead of saving.
  function handleRenameInputKeyDown(event) {
    event.stopPropagation()
    if (event.key === 'Enter') {
      event.preventDefault()
      event.currentTarget.blur()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      cancelRenameRef.current = true
      event.currentTarget.blur()
    }
  }
  function handleRenameBlur(idx) {
    if (cancelRenameRef.current) {
      cancelRenameRef.current = false
      setRenamingIdx(null)
      setRenameValue('')
      return
    }
    if (typeof onRenamePage === 'function') {
      onRenamePage(idx, renameValue)
    }
    setRenamingIdx(null)
    setRenameValue('')
  }

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
          const isSelected = selectedIdxs.has(idx)
          const isRenaming = renamingIdx === idx

          return (
            <div
              key={idx}
              className="shrink-0 group relative"
              ref={isActive ? activeChipRef : undefined}
            >
              <button
                type="button"
                onClick={(e) => handleChipClick(e, idx)}
                onKeyDown={(e) => handleChipKeyDown(e, idx)}
                data-page-chip-idx={idx}
                title="클릭: 이동 · Ctrl/Shift+클릭: 다중 선택 · Ctrl+C/V: 복사·붙여넣기 · F2: 이름 변경"
                className={cn(
                  'flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors',
                  // Selection style takes precedence — explicit "this is
                  // one of N picked for an op". Active page (the one
                  // currently shown) layers on top via the ring so
                  // active+selected reads as both signals.
                  isSelected && 'border-primary bg-primary/5 ring-1 ring-primary',
                  !isSelected && isActive && 'border-primary bg-primary/10 text-primary font-medium',
                  !isSelected && !isActive && 'border-border bg-background hover:bg-muted',
                )}
              >
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {idx + 1}
                </span>
                {isRenaming ? (
                  <Input
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={handleRenameInputKeyDown}
                    onBlur={() => handleRenameBlur(idx)}
                    onClick={(e) => e.stopPropagation()}
                    placeholder={fallback}
                    className="h-5 max-w-[180px] px-1 text-xs"
                  />
                ) : (
                  <span
                    className={cn(
                      'max-w-[160px] truncate',
                      !p.name?.trim() && 'italic text-muted-foreground'
                    )}
                  >
                    {label}
                  </span>
                )}
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
        {/* Spacer to push the expand toggle to the right edge once the
            chip row's natural width has been laid out. shrink-0 keeps
            the toggle visible even when the strip overflows. */}
        <div className="ml-auto" />
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className={cn(
            'shrink-0 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors',
            expanded
              ? 'border-primary bg-primary/10 text-primary'
              : 'border-border bg-background hover:bg-muted'
          )}
          title={expanded ? '펼치기 닫기' : '페이지 펼쳐 보기 + 검색'}
          aria-expanded={expanded}
        >
          <LayoutGrid className="h-3 w-3" />
          {expanded ? '접기' : '펼치기'}
        </button>
      </div>
      {expanded && (
        <PageBrowsePanel
          pages={pages}
          pageTemplateMap={pageTemplateMap}
          currentPage={currentPage}
          viewMode={viewMode}
          query={query}
          onQueryChange={setQuery}
          onSelect={(idx) => {
            onSelect(idx)
            setExpanded(false)
          }}
          onClose={() => setExpanded(false)}
        />
      )}
    </div>
  )
}

// ── PageBrowsePanel — search + card grid with REAL screenshot thumbs ──
//
// Sits below the page-strip when the user opens the expand toggle.
// Each card shows: (page #, title, template name, an html2canvas
// screenshot of that page rendered via InlineReportView).
//
// Capture strategy — offscreen+sequential+progressive:
//   1. On panel open, mount a hidden container off-screen with one
//      <InlineReportView snapshot={{pages: [p]}} /> per page.
//   2. Wait ~400ms for chart libs (plotly/three) to settle.
//   3. For each page in order, html2canvas the matching offscreen
//      DOM → PNG dataURL → setState(thumbnails[i] = url). The grid
//      re-renders progressively as each capture lands.
//   4. On panel close, the offscreen container unmounts, freeing memory.
//
// Why not parallel: plotly's WebGL contexts contend if many run at
// once, and html2canvas reads pixels via getImageData which the
// browser serializes anyway. Sequential is slower per-batch but
// avoids capture artifacts.
//
// Why offscreen and not just visible: paginated viewMode only renders
// the current page in the editor DOM, so other pages aren't capturable
// without dragging the whole report into 'all' mode (heavy reflow + a
// flicker users don't want). InlineReportView gives us a thin read-only
// renderer we can mount anywhere.

const THUMBNAIL_RENDER_WIDTH = 800 // px — offscreen container width
const THUMBNAIL_PIXEL_RATIO = 0.4  // html2canvas scale; <1 keeps PNG tiny

function PageBrowsePanel({
  pages,
  pageTemplateMap,
  currentPage,
  viewMode,
  query,
  onQueryChange,
  onSelect,
  onClose,
}) {
  const enriched = useMemo(
    () =>
      pages.map((p, idx) => {
        const tpl = getCachedTemplate(pageTemplateMap, p)
        const tplName = tpl?.name ?? ''
        const label = p.name?.trim() || tplName || `페이지 ${idx + 1}`
        return {
          idx,
          page: p,
          template: tpl,
          label,
          searchHaystack: `${label} ${tplName}`.toLowerCase(),
        }
      }),
    [pages, pageTemplateMap]
  )
  const trimmed = query.trim().toLowerCase()
  const filtered = trimmed
    ? enriched.filter((e) => e.searchHaystack.includes(trimmed))
    : enriched

  const [thumbnails, setThumbnails] = useState({})
  const [capturedCount, setCapturedCount] = useState(0)
  const offscreenRef = useRef(null)

  // Sequential capture pipeline. Re-runs when the page set changes
  // (page added/removed/renamed/contents edited triggers a new
  // `pages` reference from the parent). Cancels on cleanup so a
  // panel-close mid-capture doesn't leak state setters.
  useEffect(() => {
    let cancelled = false
    setThumbnails({})
    setCapturedCount(0)
    async function captureAll() {
      const container = offscreenRef.current
      if (!container) return
      // Give InlineReportView a chance to mount each page + plotly /
      // three / image loads to settle before we read pixels. Without
      // this, charts often capture as empty boxes.
      await new Promise((r) => setTimeout(r, 450))
      const { default: html2canvas } = await import('html2canvas')
      for (let i = 0; i < pages.length; i++) {
        if (cancelled) return
        const el = container.querySelector(`[data-thumb-page="${i}"]`)
        if (!el) continue
        try {
          const canvas = await html2canvas(el, {
            scale: THUMBNAIL_PIXEL_RATIO,
            backgroundColor: '#ffffff',
            logging: false,
            useCORS: true,
          })
          if (cancelled) return
          const url = canvas.toDataURL('image/png')
          setThumbnails((prev) => ({ ...prev, [i]: url }))
        } catch {
          // Silently fall through — the card stays on the loading skeleton.
          // A failed page rarely blocks the whole batch.
        }
        setCapturedCount((n) => n + 1)
      }
    }
    captureAll()
    return () => {
      cancelled = true
    }
  }, [pages])

  return (
    <>
      <div className="border-t bg-card">
        <div className="flex items-center gap-3 px-6 py-2.5">
          <div className="relative flex-1 max-w-md">
            <Input
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              placeholder="페이지 제목·템플릿 이름 검색"
              autoFocus
              className="h-8 text-xs"
            />
          </div>
          <span className="text-xs text-muted-foreground tabular-nums">
            {filtered.length} / {pages.length}
          </span>
          {capturedCount < pages.length && (
            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground tabular-nums">
              <Loader2 className="h-3 w-3 animate-spin" />
              썸네일 {capturedCount}/{pages.length}
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-muted-foreground hover:text-foreground"
            title="닫기"
          >
            닫기
          </button>
        </div>
        {filtered.length === 0 ? (
          <div className="px-6 pb-6 text-xs text-muted-foreground">
            일치하는 페이지가 없습니다.
          </div>
        ) : (
          <div className="px-6 pb-4 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-3 max-h-[60vh] overflow-y-auto">
            {filtered.map((e) => (
              <PageCard
                key={e.idx}
                entry={e}
                thumbnail={thumbnails[e.idx]}
                isActive={viewMode === 'paginated' && e.idx === currentPage}
                onClick={() => onSelect(e.idx)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Offscreen capture surface. position:fixed + far-left keeps the
          container in layout (measurable size → chart libs render)
          while invisible. aria-hidden so screen readers skip the
          duplicate content. Unmounts when the panel closes via the
          parent's conditional render. */}
      <div
        ref={offscreenRef}
        aria-hidden="true"
        style={{
          position: 'fixed',
          left: '-10000px',
          top: 0,
          width: `${THUMBNAIL_RENDER_WIDTH}px`,
          pointerEvents: 'none',
          opacity: 0,
        }}
      >
        {pages.map((p, idx) => (
          <div
            key={idx}
            data-thumb-page={idx}
            style={{
              width: `${THUMBNAIL_RENDER_WIDTH}px`,
              background: '#ffffff',
              marginBottom: 24,
            }}
          >
            <InlineReportView
              snapshot={{
                pages: [p],
                page_width_px: THUMBNAIL_RENDER_WIDTH,
              }}
            />
          </div>
        ))}
      </div>
    </>
  )
}

function PageCard({ entry, thumbnail, isActive, onClick }) {
  const { idx, page, template, label } = entry
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex flex-col rounded-md border p-2 text-left transition-colors',
        isActive
          ? 'border-primary bg-primary/5 ring-1 ring-primary'
          : 'border-border bg-background hover:bg-muted/40'
      )}
    >
      <div className="flex items-center gap-1.5 mb-0.5">
        <span className="text-[10px] tabular-nums text-muted-foreground shrink-0">
          {idx + 1}
        </span>
        <span
          className={cn(
            'text-xs font-medium truncate flex-1',
            !page.name?.trim() && 'italic text-muted-foreground'
          )}
          title={label}
        >
          {label}
        </span>
      </div>
      <div className="text-[10px] text-muted-foreground truncate mb-1.5">
        {template?.name ? `${template.name} v${page.template_version}` : '템플릿 미지정'}
      </div>
      <PageThumbnail src={thumbnail} />
    </button>
  )
}

function PageThumbnail({ src }) {
  // Fixed aspect (4/3) so the card grid lines up cleanly even before
  // captures land. object-top + object-cover crop the long pages to
  // show their first ~portion of content — that's almost always where
  // the title / lead chart lives, so it's the most recognizable part.
  return (
    <div
      className="w-full rounded border border-border/60 bg-muted/40 overflow-hidden flex items-center justify-center"
      style={{ aspectRatio: '4 / 3' }}
    >
      {src ? (
        <img
          src={src}
          alt=""
          className="w-full h-full object-cover object-top"
          draggable={false}
        />
      ) : (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/60" />
      )}
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
  rowGapPx,
  reportId,
  reportPhase,
}) {
  // Effective RGL vertical margin between widget rows. Per-report
  // setting (draft.page_gap_px) overrides the constant; falling back to
  // REPORT_ROW_GAP keeps pre-existing reports laid out unchanged.
  const effectiveRowGap = Number.isFinite(rowGapPx) ? rowGapPx : REPORT_ROW_GAP
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
            Math.ceil((px + effectiveRowGap) / (REPORT_ROW_HEIGHT + effectiveRowGap))
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
  }, [blocks, page?.layout_overrides, contentHeights, editHeights, isEditing, effectiveRowGap])

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
          rowGapPx={effectiveRowGap}
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
                  reportId={reportId}
                  pageIndex={pageIdx}
                  reportPhase={reportPhase}
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
                    // html_embed has no meaningful auto-fit (see
                    // autoFitForBlock); hiding the toggle prevents
                    // users from "turning it on" only to see the cell
                    // immediately collapse.
                    isEditing && block.type !== 'html_embed'
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

/** Walk `pages` and replace each page's `template_version` with the
 *  current latest published version of that page's `template_id`.
 *  Mutates the page objects in place — callers always run this on a
 *  freshly-parsed payload that nothing else references yet, so the
 *  mutation is contained.
 *
 *  Same idea as the in-editor `latestVersionByTemplate` cache, but
 *  applied at paste-time so JSON authored against an older template
 *  version (whether by a previous v1/v2 prompt run, or by an external
 *  collaborator) renders against the same baseline the editor would
 *  use for new reports. On fetch failure we leave the page's original
 *  version intact — that just means "no improvement", not breakage.
 */
async function remapPagesToLatestVersions(pages) {
  const cache = new Map()
  for (const page of pages) {
    const tid = page?.template_id
    if (!tid) continue
    if (!cache.has(tid)) {
      try {
        const latest = await getLatestTemplate(tid)
        cache.set(tid, latest?.version ?? null)
      } catch {
        cache.set(tid, null)
      }
    }
    const v = cache.get(tid)
    if (v != null && Number.isFinite(v) && v !== page.template_version) {
      page.template_version = v
    }
  }
}

/** Parse + validate a `report_archive_draft_v1` payload. Returns the
 *  parsed object on success; throws with a user-readable message on
 *  any structural problem so the dialog caller can show it inline.
 *
 *  Includes a pre-parse pass that fixes the single most common LLM
 *  failure mode for this app — equation widget bodies with single-
 *  backslash LaTeX commands like `"\sigma"` / `"\frac"` that JSON.parse
 *  rejects (`Bad escaped character`). See parseJsonWithLatexFix below
 *  for the exact heuristic. */
function parseImportPayload(text) {
  const obj = parseJsonWithLatexFix(text)
  if (obj?._type !== 'report_archive_draft_v1') {
    throw new Error('지원하지 않는 형식입니다. (_type=report_archive_draft_v1 이어야 합니다.)')
  }
  if (!Array.isArray(obj.pages) || obj.pages.length === 0) {
    throw new Error('페이지 데이터가 비어 있습니다.')
  }
  return obj
}

/** Parse a "patch" payload — the format an AI returns when asked to update
 *  only specific blocks of the current page, rather than emitting a full
 *  draft. Validates structure but leaves content / props_patch values as
 *  free-form JSON (props is freeform by design; content shape is per-widget).
 *
 *  Shape:
 *    {
 *      "_type": "report_archive_draft_patch_v1",
 *      "block_updates": [
 *        { "id": "...", "content": <any>?, "props_patch": <object>? },
 *        ...
 *      ]
 *    }
 *
 *  At least one of `content` / `props_patch` must be present per entry —
 *  an entry with only `id` is a no-op and rejected so authors notice.
 */
function parsePatchPayload(text) {
  const obj = parseJsonWithLatexFix(text)
  if (obj?._type !== 'report_archive_draft_patch_v1') {
    throw new Error(
      '지원하지 않는 형식입니다. (_type=report_archive_draft_patch_v1 이어야 합니다.)',
    )
  }
  if (!Array.isArray(obj.block_updates) || obj.block_updates.length === 0) {
    throw new Error('block_updates 배열이 비어 있습니다.')
  }
  obj.block_updates.forEach((u, i) => {
    if (!u || typeof u !== 'object' || Array.isArray(u)) {
      throw new Error(`block_updates[${i}] 가 객체가 아닙니다.`)
    }
    if (typeof u.id !== 'string' || !u.id.trim()) {
      throw new Error(`block_updates[${i}].id 가 비어 있습니다.`)
    }
    const hasContent = 'content' in u
    const hasProps = 'props_patch' in u
    if (!hasContent && !hasProps) {
      throw new Error(
        `block_updates[${i}] (id="${u.id}") 에 content 도 props_patch 도 없습니다.`,
      )
    }
    if (
      hasProps &&
      (u.props_patch == null ||
        typeof u.props_patch !== 'object' ||
        Array.isArray(u.props_patch))
    ) {
      throw new Error(
        `block_updates[${i}] (id="${u.id}").props_patch 는 객체여야 합니다.`,
      )
    }
  })
  return obj
}

/** Lightweight "is this a patch payload?" probe for live preview in the
 *  PasteJsonDialog — never throws. Returns the parsed update count + the
 *  list of target ids when the text is a valid patch, otherwise null.
 *  Cheap enough to run on every keystroke (parser cost is the JSON parse
 *  itself, which the user pays for any payload they're about to apply). */
function probePatchPreview(text) {
  if (!text || !text.trim()) return null
  try {
    const obj = parsePatchPayload(text)
    return {
      count: obj.block_updates.length,
      ids: obj.block_updates.map((u) => u.id),
    }
  } catch {
    return null
  }
}

/** Wrap JSON.parse with a single-pass LaTeX-friendly backslash repair.
 *
 *  AI responses frequently produce `"\sigma"` / `"\frac{...}"` (single
 *  backslash) instead of the JSON-correct `"\\sigma"` / `"\\frac{...}"`.
 *  JSON.parse fails on `\s` (Bad escaped character) and silently
 *  corrupts `\f` (form feed) / `\b` (backspace) into control chars,
 *  which then breaks KaTeX rendering downstream.
 *
 *  Repair strategy: scan the text, find any odd-length run of
 *  backslashes immediately before an ASCII letter, and add one more
 *  backslash so the run is even (= single literal `\` in the resulting
 *  string). Excludes letters that are unambiguous JSON-only escapes
 *  (n/r/t/u) so `\n` newlines, `\t` tabs, `\uXXXX` Unicode escapes
 *  inside genuine prose keep working. `\b` / `\f` are included in the
 *  fix-up because LaTeX commands like `\beta` / `\frac` start with
 *  them, and a stray BS/FF char inside a string is extremely unlikely
 *  in this app's payloads.
 *
 *  If the repaired text still won't parse, we fall back to the raw
 *  text so the user sees the original error, not a derived one. */
function parseJsonWithLatexFix(text) {
  const repaired = escapeUnescapedLatexBackslashes(text)
  try {
    return JSON.parse(repaired)
  } catch (e1) {
    try {
      return JSON.parse(text)
    } catch {
      // Surface the repaired-version error — it's typically more
      // diagnostic because the LaTeX issues have already been
      // factored out.
      throw e1
    }
  }
}

function escapeUnescapedLatexBackslashes(text) {
  // Letters that we *don't* touch — JSON-only escapes where the LaTeX
  // confusion case doesn't apply (no common command starts with these
  // and they're heavily used in real string content).
  const JSON_ONLY = new Set(['n', 'r', 't', 'u'])
  const out = []
  let i = 0
  while (i < text.length) {
    if (text[i] !== '\\') {
      out.push(text[i])
      i++
      continue
    }
    let run = 0
    while (i + run < text.length && text[i + run] === '\\') run++
    const after = text[i + run]
    const isOdd = run % 2 === 1
    const looksLikeLatex =
      after && /[a-zA-Z]/.test(after) && !JSON_ONLY.has(after)
    if (isOdd && looksLikeLatex) {
      // Add one more backslash so the run becomes even = one literal
      // backslash followed by a LaTeX command in the decoded string.
      out.push('\\'.repeat(run + 1))
    } else {
      out.push('\\'.repeat(run))
    }
    i += run
  }
  return out.join('')
}

function normalizePage(p) {
  const extras = Array.isArray(p.extra_blocks) ? p.extra_blocks : []
  // Default layout for AI-generated graph widgets: half-width + auto-fit
  // square. AI / JSON imports rarely specify per-block layout, so without
  // this seed the widgets land in the full-width fallback row and their
  // square auto-fit shrinks them to a thin strip. By seeding `col_span: 6`
  // here, each graph occupies half the report width and the autoFit
  // measurement (clientWidth-based, see PageBlockCard) makes its height
  // equal to that width — a square the user expects. Only fills in
  // entries that aren't already in `layout_overrides`.
  const layoutOverrides = { ...(p.layout_overrides ?? {}) }
  let layoutChanged = false
  for (const b of extras) {
    if (!b?.id || !b?.type) continue
    // Only graph-style widgets get the half-width + square seed.
    // html_embed shares the default-OFF behavior but doesn't have a
    // natural square aspect, so we leave its layout to the user.
    if (!WIDGETS_SQUARE_AUTOFIT.has(b.type)) continue
    if (layoutOverrides[b.id]) continue
    layoutOverrides[b.id] = {
      // `row` left undefined → falls through to the row=99 fallback in
      // buildRglItems, which RGL then wraps into rows of two half-width
      // graphs each.
      col_span: 6,
      row_span: AUTO_FIT_INITIAL_ROWS,
      auto_fit: true,
    }
    layoutChanged = true
  }
  return {
    template_id: p.template_id,
    template_version: p.template_version,
    name: p.name ?? null,
    content: p.content ?? {},
    layout_overrides:
      layoutChanged || p.layout_overrides
        ? Object.keys(layoutOverrides).length > 0
          ? layoutOverrides
          : null
        : null,
    props_overrides: p.props_overrides ?? null,
    extra_blocks: extras,
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

/** Floating "JSON 복사" button — copies the current draft snapshot (same
 *  shape as the file-download path) to the clipboard so the writer can
 *  paste the report state into an AI conversation alongside a patch-style
 *  prompt. Sits directly above 붙여넣기 in the floating cluster. */
function FloatingCopyJson({ onCopy }) {
  return (
    <Button
      size="lg"
      variant="secondary"
      className="h-12 rounded-full px-5 shadow-lg"
      title="현재 보고서의 JSON 을 클립보드에 복사 (AI 에 줄 컨텍스트로 사용)"
      onClick={onCopy}
    >
      <Copy className="mr-2 h-4 w-4" />
      JSON 복사
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
  // Comment anchoring — passed down so CommentPin can look up threads.
  // `reportId=null` (new-report or template-edit context) just hides
  // the pin since there's nothing to anchor against.
  reportId,
  pageIndex,
  reportPhase,
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
  // View-mode "fullscreen" — opens the same Editor (readOnly) inside a
  // 95vw/95vh dialog so the user can read content the cell would have
  // had to scroll. Gated by WIDGETS_FULLSCREEN_VIEWER and only in view
  // (readOnly) mode — edit mode has its own modal editors for the
  // non-inline-editable widgets.
  const [fullscreenOpen, setFullscreenOpen] = useState(false)
  const canFullscreen =
    readOnly && WIDGETS_FULLSCREEN_VIEWER.has(block.type)
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
    // Graph widgets (chart / scatter / scatter3d / heatmap / radar)
    // need a real height to paint, and the most "natural" auto-fit
    // shape for those is a square — driven by the cell's measured
    // width rather than the (essentially undefined) intrinsic content
    // height. For non-graph widgets we keep the original scrollHeight
    // behavior so text/tables still shrink to their actual content.
    const wantsSquare = WIDGETS_SQUARE_AUTOFIT.has(block.type)
    const measure = () => {
      raf = 0
      const reported = wantsSquare
        ? el.clientWidth || el.offsetWidth
        : el.scrollHeight
      if (reported > 0) onMeasureContentHeight(reported + chromeExtraPx)
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
  }, [
    autoFit,
    onMeasureContentHeight,
    content,
    effectiveProps,
    chromeExtraPx,
    block.type,
  ])
  useEffect(() => {
    // Edit-mode measurement only — view mode's visible editor *is* the
    // read-only render, so the mirror's measurement already covers it.
    if (!autoFit || readOnly || !onMeasureEditHeight) return
    const el = contentRef.current
    if (!el) return
    let raf = 0
    const wantsSquare = WIDGETS_SQUARE_AUTOFIT.has(block.type)
    const measure = () => {
      raf = 0
      const reported = wantsSquare
        ? el.clientWidth || el.offsetWidth
        : el.scrollHeight
      if (reported > 0) onMeasureEditHeight(reported + chromeExtraPx)
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
  }, [
    autoFit,
    readOnly,
    onMeasureEditHeight,
    content,
    effectiveProps,
    chromeExtraPx,
    block.type,
  ])

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
            // data-export-skip → html2canvas ignoreElements drops this
            // strip when capturing the widget for DOCX export, since the
            // exporter emits the section label as a separate paragraph
            // above the image and doesn't want it baked into the PNG.
            data-export-skip="section-header"
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
          'group relative h-full flex items-center',
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
        {/* Heading widgets get the comment pin too — anchored top-right.
            No fullscreen for headings (nothing to expand). */}
        {reportId && (
          <div className="absolute right-2 top-2 z-10 flex items-center gap-1">
            <CommentPin
              reportId={reportId}
              pageIndex={pageIndex ?? 0}
              blockId={block.id}
            />
          </div>
        )}
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
      // Marker for the page-level "컨테이너 경계 녹이기" toggle — the
      // CSS rule in index.css drops border / background / shadow on
      // elements carrying this attribute when the wrapping page has
      // `.report-blend-blocks`. Nested Cards inside widgets (Milestone /
      // Flowchart preview canvases use bg-card too) intentionally don't
      // carry this marker, so their inner chrome stays visible.
      data-report-widget-card="true"
      onMouseDown={handleCardMouseDown}
      onClick={handleCardClick}
      className={cn(
        'group relative h-full flex flex-col',
        autoFit ? 'overflow-visible' : 'overflow-hidden',
        active && !readOnly && 'ring-2 ring-primary/30',
        // Hover hint that this card opens a modal — only when in
        // edit mode and the click would actually do something.
        opensModalEditor && 'cursor-pointer hover:ring-2 hover:ring-primary/20'
      )}
    >
      {dragHandle}
      {viewModeSectionHeader}
      {/* Pin + fullscreen group — anchored top-right, horizontally
          stacked so they never overlap. Each child positions inline.
          Pin appears for any widget with a comment-able report context;
          fullscreen only for view-mode widgets that benefit from it. */}
      {(reportId || canFullscreen) && (
        <div className="absolute right-2 top-2 z-10 flex items-center gap-1">
          {reportId && (
            <CommentPin
              reportId={reportId}
              pageIndex={pageIndex ?? 0}
              blockId={block.id}
            />
          )}
          {canFullscreen && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                setFullscreenOpen(true)
              }}
              onMouseDown={(e) => e.stopPropagation()}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-background/95 border border-transparent text-muted-foreground opacity-0 transition-opacity hover:border-border hover:text-foreground group-hover:opacity-100 print:hidden"
              title="전체화면으로 보기"
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}
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
      {/* Fullscreen view button is now rendered above (next to the
          comment pin) so they share a single top-right group. */}
      {fullscreenOpen && Editor && (
        <FullscreenWidgetDialog
          open={fullscreenOpen}
          onClose={() => setFullscreenOpen(false)}
          title={effectiveProps?.label || block.type}
        >
          <Editor
            props={effectiveProps}
            content={content}
            onChange={NO_OP}
            readOnly={true}
            autoFit={false}
          />
        </FullscreenWidgetDialog>
      )}
    </Card>
  )
}

/** Big-screen viewer wrapping any widget's Editor in read-only mode.
 *  95vw / 95vh — enough headroom that even a wide chart breathes, and
 *  the inner cell takes flex-1 so chart/scatter/iframe widgets fill the
 *  dialog instead of rendering at their tiny default size. */
function FullscreenWidgetDialog({ open, onClose, title, children }) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[95vw] max-w-[95vw] h-[95vh] max-h-[95vh] flex flex-col overflow-hidden p-4">
        <DialogHeader className="shrink-0">
          <DialogTitle className="text-sm font-medium truncate pr-8">
            {title}
          </DialogTitle>
        </DialogHeader>
        <div className="flex-1 min-h-0 flex flex-col mt-2 report-widget-body">
          {children}
        </div>
      </DialogContent>
    </Dialog>
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
// the user edits data, which feels broken. `html_embed` is here too
// because the iframe content has no measurable intrinsic height from
// the parent's side, so auto-fit would collapse the cell to a tiny
// strip. Users can still flip the per-block toggle when they want
// auto-fit on these.
const WIDGETS_DEFAULT_NO_AUTOFIT = new Set([
  'chart',
  'scatter',
  'scatter3d',
  'heatmap',
  'contour',
  'treemap',
  'packing',
  'tree',
  'network',
  'pie',
  'waffle',
  'box',
  'density',
  'radar',
  'sankey',
  'html_embed',
])

// Subset that wants the auto-fit measurement to track cell *width*
// (square cell). Pure graph widgets are square-by-convention; html_embed
// has no natural aspect ratio, so when its auto-fit is explicitly turned
// on we fall back to the regular scrollHeight measurement instead.
const WIDGETS_SQUARE_AUTOFIT = new Set([
  'chart',
  'scatter',
  'scatter3d',
  'heatmap',
  'contour',
  'packing',
  'tree',
  'network',
  'pie',
  'waffle',
  'box',
  'density',
  'radar',
])

// Widgets that get a "전체화면" affordance in view mode — the cell
// sometimes can't show the whole content at the report's normal
// density (long HTML, dense chart, multi-series scatter). The button
// opens the same widget in a 95vw / 95vh modal so the user can read
// without scrolling. cad_3d intentionally not here — it ships its
// own browser-fullscreen toolbar with scene-aware refit logic that
// the generic modal can't replicate.
const WIDGETS_FULLSCREEN_VIEWER = new Set([
  'html_embed',
  'video',
  'chart',
  'scatter',
  'scatter3d',
  'heatmap',
  'contour',
  'treemap',
  'packing',
  'tree',
  'network',
  'pie',
  'waffle',
  'box',
  'density',
  'radar',
  'sankey',
])

/** Resolve whether a block is in auto_fit mode. Explicit `auto_fit`
 *  in the saved layout normally wins; absent value falls back to the
 *  per-type default.
 *
 *  html_embed is hard-coded to false regardless of any stored value:
 *  the iframe content has no measurable height from the parent side
 *  (no postMessage handshake) so auto-fit measurement always reports a
 *  ~0 height and collapses the cell. Legacy widgets that were created
 *  while the default was still ON would otherwise stay stuck in the
 *  collapsed state even after dragging the row_span larger. */
function autoFitForBlock(block, layout) {
  if (block?.type === 'html_embed') return false
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

function ResizableGrid({
  items,
  onLayoutChange,
  children,
  isStatic = false,
  rowGapPx,
}) {
  const { containerRef, width, mounted } = useContainerWidth({ measureBeforeMount: true })
  const finalItems = isStatic ? items.map((it) => ({ ...it, static: true })) : items
  const effectiveRowGap = Number.isFinite(rowGapPx) ? rowGapPx : REPORT_ROW_GAP
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
            margin: [REPORT_COL_GAP, effectiveRowGap],
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
