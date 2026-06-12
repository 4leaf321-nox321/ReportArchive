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
  ArrowRightLeft,
  Bookmark,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ClipboardPaste,
  Copy,
  Activity,
  History,
  Download,
  FileBox,
  FileCode,
  FileText,
  FileType2,
  Folder,
  GripVertical,
  HardDrive,
  Inbox,
  Info,
  Layers,
  LayoutGrid,
  Loader2,
  Lock,
  LockOpen,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Network,
  Pencil,
  Plus,
  Rows,
  Save,
  Scissors,
  Send,
  Settings2,
  Share2,
  Sparkles,
  Tag,
  Trash2,
  Undo2,
  Upload,
  X,
} from 'lucide-react'
import GridLayout, { useContainerWidth } from 'react-grid-layout'
import { PrintScaleContext } from './printContext'
import {
  ReportStyleContext,
  useReportStyleValue,
} from '@/shared/reports/ReportStyleContext'
import { Button } from '@/shared/components/ui/button'
import { Badge } from '@/shared/components/ui/badge'
import { Separator } from '@/shared/components/ui/separator'
import { Card, CardContent } from '@/shared/components/ui/card'
import { ScrollArea } from '@/shared/components/ui/scroll-area'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { Input } from '@/shared/components/ui/input'
import { InlineReportView } from '@/modules/composites/InlineReportView'
import { Textarea } from '@/shared/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/shared/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/components/ui/popover'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu'
import { ConfirmDialog } from '@/shared/components/ConfirmDialog'
import { ErrorState } from '@/shared/components/ErrorState'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import { useAuth } from '@/shared/auth/AuthContext'
import { useAsync } from '@/shared/hooks/useAsync'
import { usePersistedState } from '@/shared/hooks/usePersistedState'
import { useWidgetCatalog } from '@/shared/hooks/useWidgetCatalog'
import { listEntityTypes } from '@/shared/api/entities'
import {
  getReport,
  createReport,
  copyReport,
  updateReport,
  trashReport,
  restoreReport,
  deleteReport,
  publishReport,
  unpublishReport,
  setAuthorLock,
  listReports,
  LockConflictError,
} from './api'
import { FOLDER_FILTER_UNCATEGORIZED } from './FolderSidebar'
import { useReportLock } from './useReportLock'
import {
  DEFAULT_REPORT_WIDTH_PX,
  DEFAULT_REPORT_GAP_PX,
  EntityTagsSection,
  CollabDeptSection,
  ReportSettingsDialog,
} from './ReportSettingsDialog'
import { ReportTypePicker } from './ReportTypePicker'
import {
  LinkedReportsChip,
  ReportLinksSection,
  useReportLinks,
} from './ReportLinks'
import { ReportMentionProvider, useReportMention } from '@/shared/reports/ReportMentionContext'
import { blockRefKey, buildBlockIndex, referenceableBlockList } from '@/shared/reports/blockNumbering'
import { CurrentBlockRefContext } from '@/shared/reports/CurrentBlockRefContext'
import BlockRefPreview from './BlockRefPreview'
import DeptMentionPreview from './DeptMentionPreview'
import { ReportMentionDialog } from './ReportMentionDialog'
import { ReportGraphModal } from './ReportGraphModal'
import { SlideGuideOverlay } from './SlideGuideOverlay'
import {
  getTemplateVersion,
  createTemplate,
  getLatestTemplate,
} from '@/shared/api/templates'
import { listTemplateCategories } from '@/shared/api/templateCategories'
import { getRenderer } from '@/modules/templates/widgets'
import { useCaptionSkipPref } from '@/shared/widgets/useCaptionSkipPref'
import { TableViewContext } from '@/modules/templates/widgets/Table'
import { WidgetPicker } from '@/modules/templates/WidgetPicker'
import { DepthStyleField, TextStyleField } from '@/modules/templates/widgets/_shared'
import { TemplatePicker } from './TemplatePicker'
import { SectionPickerDialog } from './SectionPickerDialog'
import { PromptPickerDialog } from './PromptPickerDialog'
import { MountDialog } from './MountDialog'
import { ShareEditor } from '@/shared/components/ShareEditor'
import { FolderPickerDialog } from './FolderPickerButton'
import { listMounts, mountReport } from '@/shared/api/mounts'
import { listFolders } from '@/shared/api/folders'
import { listCompositesContainingReport } from '@/shared/api/composites'
import { SubmitToCompositeButton } from '@/modules/composites/SubmitToCompositeDialog'
import { createPreset } from '@/shared/api/presets'
import { CommentsProvider, useComments } from '@/modules/comments/CommentsContext'
import { CommentPanel } from '@/modules/comments/CommentPanel'
import { CommentPin } from '@/modules/comments/CommentPin'
import { ActivityTimelineDialog } from './ActivityTimeline'
import { ReportVersionHistoryDialog } from './ReportVersionHistoryDialog'
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
  // 새 위젯 "제목 생략" 기본값 기억(위젯 type별 user preference).
  const { getSkip: getCaptionSkip, rememberSkip: rememberCaptionSkip } =
    useCaptionSkipPref()
  const isNew = Boolean(templateId)
  // When the previous page handed us `state.startEditing` (the "복사"
  // flow does this so the new copy lands directly in edit mode), we
  // honor it on first mount only.
  const startEditingFromState = Boolean(location.state?.startEditing)

  // 'paginated' = show one page at a time with prev/next controls
  // 'all'       = stack every page vertically (scroll through them)
  //
  // 보기 모드는 보고서별로 기억된다(draft.page_default_view_mode — 편집모드
  // 전용 토글로 저장). 저장값이 없는 보고서(기존·MCP·AI)는 아래 개인
  // 전역설정(localStorage, 과거 전역토글의 잔존값)으로 폴백하고, 그마저 없으면
  // 'paginated'. globalViewMode 는 이제 읽기 전용 폴백, viewMode 가 표시 상태.
  const [globalViewMode] = usePersistedState('ra:report-view-mode:v1', 'paginated')
  const [viewMode, setViewMode] = useState(globalViewMode)
  // 좌측 보조 사이드바(같은 폴더 보고서 목록) 토글. 보고서 간 이동해도
  // 유지되도록 개인설정으로 기억. 상단 툴바의 옛 FolderSiblingNav 를 대체.
  const [folderPanelOpen, setFolderPanelOpen] = usePersistedState(
    'ra:report-folder-panel:v1',
    false,
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
  const [savePresetOpen, setSavePresetOpen] = useState(false)
  // 보고서 관계도 모달 (지식그래프 Phase 1a). 저장된 보고서일 때만 의미.
  const [graphOpen, setGraphOpen] = useState(false)
  const [mountOpen, setMountOpen] = useState(false)
  // "더보기" 메뉴에서 여는 controlled 표면들(공유 · 폴더 이동 · 활동 이력).
  const [shareOpen, setShareOpen] = useState(false)
  const [folderPickOpen, setFolderPickOpen] = useState(false)
  const [activityOpen, setActivityOpen] = useState(false)
  const [versionsOpen, setVersionsOpen] = useState(false)
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
  // 보고서 전체화면(발표) 모드 — PPT 발표처럼 브라우저 UI까지 가리는 진짜
  // 전체화면(Fullscreen API)을 쓰되, 대상은 *문서 전체*(documentElement)로
  // 잡는다. 그래야 body 로 portal 되는 것들(멘션 팝업·toast·popover)이 그대로
  // 보이고, 자식 위젯(3D 모델)의 자체 전체화면도 깔끔히 교체·복귀된다.
  // 동시에 기존 `report-fullscreen` CSS 클래스도 적용해 AppShell 헤더/사이드바
  // 를 가리고 본문 maxWidth 를 푼다 → 내부 동작은 기존 전체화면과 동일.
  const [reportFullscreen, setReportFullscreen] = useState(false)
  // 상태가 켜지면 CSS 클래스 적용(요청 실패 시에도 창-채우기로 우아하게 폴백).
  useEffect(() => {
    if (!reportFullscreen) return
    document.body.classList.add('report-fullscreen')
    return () => document.body.classList.remove('report-fullscreen')
  }, [reportFullscreen])
  const enterReportFullscreen = useCallback(() => {
    const el = document.documentElement
    const req = el.requestFullscreen || el.webkitRequestFullscreen
    if (req) Promise.resolve(req.call(el)).catch(() => {})
    setReportFullscreen(true)
  }, [])
  const exitReportFullscreen = useCallback(() => {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement
    const exit = document.exitFullscreen || document.webkitExitFullscreen
    if (fsEl && exit) Promise.resolve(exit.call(document)).catch(() => {})
    setReportFullscreen(false)
  }, [])
  const toggleReportFullscreen = useCallback(() => {
    if (reportFullscreen) exitReportFullscreen()
    else enterReportFullscreen()
  }, [reportFullscreen, enterReportFullscreen, exitReportFullscreen])
  // 문서 fullscreen 생명주기와 상태 동기화. "완전히 빠져나온"(fullscreen 요소가
  // 아예 없는) 경우에만 발표 모드 종료로 본다. 자식 위젯(3D)이 전체화면을
  // 가져가면 fullscreenElement 는 그 요소(non-null)라 발표 모드는 유지된다 —
  // 3D 가 화면을 차지했다가 빠지면 다시 보고서로 복귀.
  useEffect(() => {
    const onChange = () => {
      const fsEl = document.fullscreenElement || document.webkitFullscreenElement
      if (!fsEl) setReportFullscreen(false)
    }
    document.addEventListener('fullscreenchange', onChange)
    document.addEventListener('webkitfullscreenchange', onChange)
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      document.removeEventListener('webkitfullscreenchange', onChange)
    }
  }, [])
  // "목록" 복귀 시 함께 넘길 location.state(보던 폴더/페이지로 돌아가게).
  // siblingFolderId 가 한참 아래에서 계산되므로 ref 로 들고, 렌더마다 갱신해
  // 백스페이스 핸들러(아래 effect)와 목록 버튼이 같은 최신값을 읽게 한다.
  const listBackStateRef = useRef(undefined)

  // 백스페이스 → "목록" 으로 빠르게 복귀(보기 모드 전용). 단, 입력 중
  // (input/textarea/contentEditable)이거나 편집모드·새 보고서, 또는 모달
  // /드롭다운이 열려 있으면 그쪽 기본 동작(텍스트 삭제·닫기)을 살려야
  // 하므로 무시한다. 수정자 키와 함께 눌린 경우도 제외.
  useEffect(() => {
    if (isEditing || isNew || !slug) return
    function onKeyDown(e) {
      if (e.key !== 'Backspace' || e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target
      const tag = t?.tagName
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        t?.isContentEditable
      ) {
        return
      }
      if (
        document.querySelector(
          '[role="dialog"][data-state="open"], [role="menu"][data-state="open"], [role="alertdialog"][data-state="open"]',
        )
      ) {
        return
      }
      e.preventDefault()
      navigate(`/w/${slug}/reports`, { state: listBackStateRef.current })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isEditing, isNew, slug, navigate])
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
  // HTML export progress — uses the same {phase, current, total, label}
  // shape as docxProgress so the shared ExportOverlay component can read
  // both. Set to null when no export is running.
  const [htmlProgress, setHtmlProgress] = useState(null)
  // Abort controller for the currently-running export (HTML or DOCX —
  // they`re mutually exclusive thanks to setPrinting). Wired to the
  // overlay`s 취소 button; aborted state triggers AbortError inside the
  // exporter at the next polled checkpoint.
  const exportAbortRef = useRef(null)
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

  // "더보기 > 폴더 이동"의 적용 모드 — 개인 헤더(owner)면 personal, 게시판
  // 헤더(게시된 상태)면 org, 둘 다 아니면 null(메뉴에서 숨김).
  const folderPickMode =
    !isNew && isPersonalContext &&
    existingReport?.owner_user_id === me?.user?.id
      ? 'personal'
      : !isNew && isOrgContext && currentMount
        ? 'org'
        : null

  // 보고서 간 link (참조 / 후속 …). 칩과 본문 하단 섹션 양쪽에서 같은
  // 데이터를 봐야 하므로 페이지 레벨에서 hook 을 한 번만 호출하고 결과를
  // 둘 다에게 prop 으로 흘려준다. existingReport.id 가 없으면 (새 보고서
  // 작성 단계) hook 은 빈 배열 반환 + 추가 폼도 비활성.
  const linkedReports = useReportLinks(existingReport?.id)

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
        // 긴 글 머리 기호 — depth-별 null 이면 프런트 기본 글리프 사용.
        page_rich_text_prefix_d0: null,
        page_rich_text_prefix_d1: null,
        page_rich_text_prefix_d2: null,
        // 새 보고서는 저장된 보기 모드 없음 → null(개인 전역설정 폴백).
        page_default_view_mode: null,
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
        // 긴 글 depth-별 머리 기호 override. 각 null → 그 depth 만 기본.
        page_rich_text_prefix_d0: existingReport.page_rich_text_prefix_d0 ?? null,
        page_rich_text_prefix_d1: existingReport.page_rich_text_prefix_d1 ?? null,
        page_rich_text_prefix_d2: existingReport.page_rich_text_prefix_d2 ?? null,
        // 보고서별 기본 보기 모드. null → 표시 상태는 개인 전역설정으로 폴백.
        page_default_view_mode: existingReport.page_default_view_mode ?? null,
        // 보고서 종류 — picker writes the FK + embedded ref so the
        // settings dialog (and the list view, once we rerender it)
        // can show the name/status without a second roundtrip.
        report_type_id: existingReport.report_type_id ?? null,
        report_type: existingReport.report_type ?? null,
        // Entity tags — slim EntityRefMini list pre-flattened by the
        // backend; the settings dialog re-renders chips from it without
        // a second fetch. Mutated via onApplyEntities below.
        entities: existingReport.entities ?? [],
        // 협업 부서 — 워크스페이스 슬러그 배열. onApplyCollab 로 갱신.
        collab_workspace_slugs: existingReport.collab_workspace_slugs ?? [],
        pages,
      })
      setCurrentPage((p) => clamp(p, 0, pages.length - 1))
    }
  }, [isNew, seedTemplate, existingReport])

  // 보고서가 로드되면 그 보고서에 저장된 기본 보기 모드로 표시 상태를 맞춘다.
  // 보고서 id 가 바뀔 때 한 번만 — 저장 후 reloadReport(같은 id) 에서는 방금
  // 고른 모드를 덮어쓰지 않도록 ref 로 가드. 저장값이 없으면(기존/MCP/AI)
  // 개인 전역설정으로 폴백한다.
  const viewModeSyncedReportRef = useRef(undefined)
  useEffect(() => {
    if (isNew || !existingReport?.id) return
    if (viewModeSyncedReportRef.current === existingReport.id) return
    viewModeSyncedReportRef.current = existingReport.id
    setViewMode(existingReport.page_default_view_mode ?? globalViewMode)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew, existingReport?.id])

  // 보기 모드 전환. 토글은 편집모드 전용이므로 항상 보고서별 설정(draft)에
  // 써서 save 시 영속화한다. 표시 상태도 즉시 반영.
  const handleViewModeChange = useCallback((next) => {
    setViewMode(next)
    setDraft((d) => (d ? { ...d, page_default_view_mode: next } : d))
  }, [])

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
  // Latest `safeCurrent` page index in a ref so the keyboard-shortcut
  // useEffect can read it without listing it in deps — the const itself
  // is declared AFTER the loading early returns (Rules of Hooks forbid
  // moving the effect past the early returns, and listing safeCurrent
  // in deps from up here triggers TDZ on render). Synced inside the
  // component body after the safeCurrent declaration; reads via
  // safeCurrentRef.current always pick up the latest page.
  const safeCurrentRef = useRef(0)
  // In-memory single-slot clipboard for widget copy/cut/paste. Holds
  // an effective snapshot — props / content / layout / section all
  // merged so the destination page can paste as a self-contained
  // extra block without dragging template-vs-override semantics
  // along. `cutSource` tracks the origin when we want to clear the
  // clipboard after the FIRST paste (cut should be a true move, not
  // a duplicate). Copy leaves cutSource null → user can paste many
  // times.
  const [blockClipboard, setBlockClipboard] = useState(null)

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

  // Edit-mode shortcuts:
  //   Delete        — 선택 위젯 삭제 (activeBlock 필요)
  //   Ctrl/Cmd+C    — 선택 위젯 복사 (activeBlock 필요)
  //   Ctrl/Cmd+X    — 선택 위젯 잘라내기 (activeBlock 필요)
  //   Ctrl/Cmd+V    — 클립보드 위젯을 현재 페이지에 붙여넣기
  //
  // 사용자가 텍스트 입력 중(input/textarea/contenteditable)이거나 모달
  // 다이얼로그가 열려 있으면 모두 무시 — 그쪽 키 동작이 우선.
  // Backspace 는 너무 흔히 쓰여 일부러 묶지 않는다. Ctrl+C 는 텍스트
  // 선택 복사와 충돌하지 않도록 selection 이 비어 있을 때만 hijack.
  useEffect(() => {
    if (!isEditing) return
    function onKey(e) {
      const ae = document.activeElement
      if (ae instanceof HTMLElement) {
        if (ae.matches('input, textarea, select')) return
        if (ae.isContentEditable) return
      }
      if (document.querySelector('[role="dialog"]')) return

      // Plain Delete — 기존 동작 유지
      if (!(e.ctrlKey || e.metaKey)) {
        if (e.key !== 'Delete' || !activeBlock) return
        e.preventDefault()
        removeBlockFromPage(activeBlock.pageIdx, activeBlock.blockId)
        setActiveBlock(null)
        return
      }

      // Ctrl/Cmd 조합
      const key = e.key.toLowerCase()
      if (key === 'c') {
        if (!activeBlock) return
        // 사용자가 위젯 안의 텍스트를 선택해 둔 상태면 그쪽 복사가
        // 우선. selection 이 비어 있을 때만 위젯 복사로 hijack.
        const sel = window.getSelection?.()
        if (sel && sel.toString().length > 0) return
        e.preventDefault()
        copyBlockToClipboard(activeBlock.pageIdx, activeBlock.blockId)
      } else if (key === 'x') {
        if (!activeBlock) return
        e.preventDefault()
        copyBlockToClipboard(activeBlock.pageIdx, activeBlock.blockId, { cut: true })
      } else if (key === 'v') {
        if (!blockClipboard) return
        e.preventDefault()
        // 항상 현재 보고 있는 페이지로 붙여넣기 (activeBlock 이 다른
        // 페이지에 남아있을 수 있어 그쪽 기준은 헷갈림). 다만 active
        // 위젯이 현재 페이지에 있다면 그걸 anchor 로 써서 "지금 보고
        // 있는 위젯 아래" 로 paste — 마우스 우클릭 패턴과 동일한
        // mental model.
        const targetPage = safeCurrentRef.current
        const anchor =
          activeBlock?.pageIdx === targetPage ? activeBlock.blockId : null
        pasteBlockOnPage(targetPage, anchor)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing, activeBlock, blockClipboard])

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

  // Comment panel anchor → human-readable widget context. Lets each
  // thread card in the panel show "[표] 분포 분석 · 2장 결과" instead of
  // the opaque "블록 abc123 · p.2" — without this, reviewers can't
  // tell which widget the message is talking about. Returns null
  // gracefully when the block is missing (deleted after the thread was
  // anchored) so the panel can fall back to raw ids.
  const resolveCommentBlock = useCallback(
    (pageIndex, blockId) => {
      const page = draft?.pages?.[pageIndex]
      if (!page) return null
      const tpl = getCachedTemplate(pageTemplateMap, page)
      const blocks = combinedBlocks(tpl, page)
      const block = blocks.find((b) => b.id === blockId)
      if (!block) return null
      const widgetMeta = widgetCatalog?.byType?.[block.type] ?? null
      const props = block.props ?? {}
      return {
        widgetType: block.type,
        widgetLabel: widgetMeta?.label || block.type,
        blockLabel: props.label || props.default_text || null,
        pageNumber: pageIndex + 1,
        pageName: page.name?.trim() || tpl?.name || null,
      }
    },
    [draft, pageTemplateMap, widgetCatalog],
  )

  // Pair the comment thread card with "jump to that widget in the body":
  // switch page first if needed, then scrollIntoView. setTimeout gives
  // React a tick to mount the new page's blocks before we query the DOM
  // — without it, scroll silently no-ops on the first cross-page click.
  const navigateToCommentBlock = useCallback(
    (pageIndex, blockId, { flash = false } = {}) => {
      const pageCountSafe = draft?.pages?.length ?? 0
      if (pageCountSafe === 0) return
      const targetPage = clamp(pageIndex, 0, pageCountSafe - 1)
      if (targetPage !== currentPage) setCurrentPage(targetPage)
      setTimeout(() => {
        const el = document.getElementById(`block-${blockId}`)
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        // `#` 참조 점프는 도착 위젯을 잠깐 강조한다. 코멘트 점프는 우측 패널
        // 포커스(amber ring)가 이미 표식이라 flash 를 끈다.
        if (flash) flashBlock(blockId)
      }, 80)
    },
    [draft?.pages?.length, currentPage],
  )

  // ── 본문 `#` 위젯 참조 클릭 UX ──────────────────────────────────────────
  // refPreview  : 화면 밖/다른 페이지 참조를 흘끗 보는 팝오버 상태 | null
  // returnAnchor: "위젯으로 이동" 후 읽던 자리로 돌아오기 위한 앵커 | null
  const [refPreview, setRefPreview] = useState(null)
  const [returnAnchor, setReturnAnchor] = useState(null)
  // 부서 @멘션 미리보기 팝오버 상태 { slug, anchorRect } | null
  const [deptPreview, setDeptPreview] = useState(null)

  // 도착 위젯을 ~1.6s 강조. 애니메이션을 다시 트리거하려 클래스를 뗐다
  // 리플로우 후 다시 붙인다. (id 는 페이지-로컬이라, 현재 페이지에 마운트된
  // 엘리먼트만 잡힌다 — navigateToCommentBlock 과 동일 전제.)
  function flashBlock(blockId) {
    const el = document.getElementById(`block-${blockId}`)
    if (!el) return
    el.classList.remove('ref-flash')
    void el.offsetWidth
    el.classList.add('ref-flash')
    window.setTimeout(() => el.classList.remove('ref-flash'), 1700)
  }

  // 앵커에서 위로 올라가며 실제 스크롤되는 조상을 찾는다(복귀 시 그 위치를
  // 되돌리려고). 못 찾으면 null → window 스크롤로 폴백.
  function findScrollParent(el) {
    let node = el?.parentElement
    while (node) {
      const oy = window.getComputedStyle(node).overflowY
      if (/(auto|scroll|overlay)/.test(oy) && node.scrollHeight > node.clientHeight)
        return node
      node = node.parentElement
    }
    return null
  }

  // 참조 링크 클릭의 "스마트" 처리. 최신 draft/currentPage 를 항상 보도록
  // ref 에 구현을 담고, 컨텍스트엔 안정적 래퍼만 흘려보낸다(consumer 불필요
  // 리렌더 방지).
  const refClickImplRef = useRef(null)
  refClickImplRef.current = (pageIndex, blockId, anchorEl) => {
    const key = blockRefKey(pageIndex, blockId)
    const meta = blockRefIndex.get(key)
    if (!meta) {
      toast.error('참조한 위젯을 찾을 수 없습니다 (삭제되었을 수 있습니다).')
      return
    }
    // 참조 대상이 *현재 페이지*에 마운트돼 있고 화면에 (일부라도) 보이면
    // 이동 없이 하이라이트만 — "바로 옆" 케이스가 가장 가볍고 자연스럽다.
    // (id 는 페이지-로컬이라 같은 페이지일 때만 getElementById 가 정확하다.)
    if (pageIndex === currentPage) {
      const el = document.getElementById(`block-${blockId}`)
      if (el) {
        const r = el.getBoundingClientRect()
        const visible =
          r.height > 0 && r.bottom > 40 && r.top < window.innerHeight - 40
        if (visible) {
          el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
          flashBlock(blockId)
          return
        }
      }
    }
    // 화면 밖 / 다른 페이지 → 미리보기 팝오버. snapshotBlock 은 draft 데이터를
    // 직접 읽어 (pageIndex, blockId) 로 정확히 해석하므로 페이지 마운트와 무관.
    setRefPreview({
      pageIndex,
      blockId,
      anchorEl,
      anchorRect: anchorEl?.getBoundingClientRect?.() ?? null,
      snapshot: snapshotBlock(pageIndex, blockId),
      label: meta.label ?? '',
      caption: meta.caption ?? '',
    })
  }
  const onBlockRefClick = useCallback(
    (pageIndex, blockId, anchorEl) =>
      refClickImplRef.current?.(pageIndex, blockId, anchorEl),
    [],
  )

  // 부서 @멘션 클릭 → 이동 대신 미리보기 팝오버. (setState 만 쓰므로 안정적)
  const onDeptMentionClick = useCallback((slug, anchorEl) => {
    setDeptPreview({
      slug,
      anchorRect: anchorEl?.getBoundingClientRect?.() ?? null,
    })
  }, [])
  // 팝오버에서 실제 이동을 고르면 — 출발 정보를 실어 "돌아가기" 알약이 뜨게.
  function openDeptList(slug) {
    setDeptPreview(null)
    navigate(`/w/${slug}/reports`, {
      state: { fromMention: { fromTitle: existingReport?.title ?? null } },
    })
  }
  function openDeptReport(slug, reportId) {
    setDeptPreview(null)
    navigate(`/w/${slug}/reports/${reportId}`, {
      state: { fromMention: { fromTitle: existingReport?.title ?? null } },
    })
  }

  // 팝오버 "위젯으로 이동" → 읽던 자리를 복귀앵커로 저장하고 실제 점프.
  function jumpFromPreview() {
    const rp = refPreview
    if (!rp) return
    const scrollEl = findScrollParent(rp.anchorEl)
    setReturnAnchor({
      scrollEl,
      scrollTop: scrollEl ? scrollEl.scrollTop : window.scrollY,
      page: currentPage,
    })
    setRefPreview(null)
    navigateToCommentBlock(rp.pageIndex, rp.blockId, { flash: true })
  }

  // 떠 있는 "돌아가기" 알약 → 저장한 페이지/스크롤 위치로 복귀.
  function goBackFromRef() {
    const ra = returnAnchor
    if (!ra) return
    if (ra.page !== currentPage) setCurrentPage(ra.page)
    setTimeout(() => {
      if (ra.scrollEl) ra.scrollEl.scrollTop = ra.scrollTop
      else window.scrollTo({ top: ra.scrollTop })
    }, 80)
    setReturnAnchor(null)
  }

  // Whole-report cross-reference index ("그림 3", "표 2"). Walks every page in
  // document order so numbers are continuous across pages; recomputed when the
  // draft / templates / catalog change, so reordering a block re-numbers every
  // body reference automatically. (Hook above the early returns — see below.)
  const blockRefIndex = useMemo(() => {
    const ordered = []
    const pages = draft?.pages ?? []
    pages.forEach((page, pageIndex) => {
      const tpl = getCachedTemplate(pageTemplateMap, page)
      const overrides = page?.layout_overrides ?? {}
      // Number in *visual reading order* (top→bottom, left→right), not
      // blocks_order array order — otherwise a block dropped at the top of the
      // page but appended to blocks_order would get a high number. Position
      // comes from the effective layout (row, col_offset), with the array
      // index as a stable tiebreaker for same-cell / missing col_offset.
      const positioned = combinedBlocks(tpl, page).map((b, idx) => {
        const lay = overrides[b.id] ?? b.layout ?? {}
        return {
          b,
          idx,
          row: Number.isFinite(lay.row) ? lay.row : 1,
          col: Number.isFinite(lay.col_offset) ? lay.col_offset : 0,
        }
      })
      positioned.sort((a, c) => a.row - c.row || a.col - c.col || a.idx - c.idx)
      for (const { b } of positioned) {
        // Caption for the # picker: plain caption → rich caption text → the
        // widget's template label, so "그림 3" always has a meaningful subtitle.
        const c = page.content?.[b.id] ?? {}
        const caption =
          (c.caption && c.caption.trim()) ||
          (typeof c.caption_html === 'string'
            ? c.caption_html.replace(/<[^>]*>/g, '').trim()
            : '') ||
          (b.props?.label ?? '')
        ordered.push({ id: b.id, type: b.type, caption, pageIndex })
      }
    })
    return buildBlockIndex(ordered, widgetCatalog)
  }, [draft, pageTemplateMap, widgetCatalog])

  const referenceableBlocks = useMemo(
    () => referenceableBlockList(blockRefIndex),
    [blockRefIndex],
  )

  // Jump to a referenced block — reuses the comment "jump to widget" path
  // (switches page first if it lives elsewhere, then scrollIntoView). The
  // reference carries (pageIndex, blockId) since ids are page-local.
  const scrollToBlock = useCallback(
    (pageIndex, blockId) => {
      if (pageIndex == null || !blockId) return
      navigateToCommentBlock(pageIndex, blockId)
    },
    [navigateToCommentBlock],
  )

  // ⚠ Hook — MUST sit above ALL early returns below (loading / error /
  // !draft) so its call order is stable across renders. The first render
  // hits the `if (loading)` bail-out before any of the later hooks would
  // run, so any hook placed after that branch shows up as a "new" hook
  // once loading completes → "Rendered more hooks than during the previous
  // render" crash. draft 가 아직 null 이면 depthGlyphs 칸이 모두 undefined →
  // helper 가 각 depth 별로 기본 글리프로 알아서 폴백한다.
  const reportStyleValue = useReportStyleValue({
    depthGlyphs: [
      draft?.page_rich_text_prefix_d0,
      draft?.page_rich_text_prefix_d1,
      draft?.page_rich_text_prefix_d2,
    ],
  })

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
  // 우클릭 메뉴의 「다른 페이지로 옮기기」 stage 가 보여줄 페이지 목록.
  // 라벨 fallback 은 PageStrip 의 chip label 규칙과 동일: 사용자 지정
  // 이름 → 템플릿 이름 → "페이지 N".
  const pagesMeta = pages.map((p, idx) => {
    const tpl = getCachedTemplate(pageTemplateMap, p)
    return {
      idx,
      label: p.name?.trim() || tpl?.name || `페이지 ${idx + 1}`,
    }
  })
  // Keep the keyboard-shortcut effect in sync without putting
  // `safeCurrent` in its deps array — that would TDZ-throw at render
  // because the effect runs before this line.
  safeCurrentRef.current = safeCurrent
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
    // "제목 생략" 토글이 바뀌면 그 위젯 type 의 새-위젯 기본값으로 기억.
    // 모든 블록 콘텐츠 변경이 이 함수를 거치므로, 플래그가 실제로 뒤집힐
    // 때만(타이핑 등은 무시) rememberSkip 을 부른다.
    const page = draft?.pages?.[pageIdx]
    if (page) {
      const oldSkip = page.content?.[blockId]?.caption_skip_autofill === true
      const newSkip = value?.caption_skip_autofill === true
      if (oldSkip !== newSkip) {
        const tpl = getCachedTemplate(pageTemplateMap, page)
        const block = combinedBlocks(tpl, page).find((b) => b.id === blockId)
        if (block?.type) rememberCaptionSkip(block.type, newSkip)
      }
    }
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

  // 페이지 순서 변경 (드래그&드롭) — fromIdx 페이지를 빼서 toIdx 위치에 끼운다.
  // 보고 있던 페이지가 reorder 후에도 그대로 선택되도록 *참조 동일성*으로
  // currentPage 를 다시 찾는다(인덱스만 바뀌고 보던 페이지는 유지).
  function reorderPages(fromIdx, toIdx) {
    if (fromIdx === toIdx) return
    const arr = pages
    // toIdx === arr.length 는 "맨 끝(마지막 다음)에 삽입" 을 뜻한다(끝 드롭존).
    if (
      fromIdx < 0 ||
      fromIdx >= arr.length ||
      toIdx < 0 ||
      toIdx > arr.length
    ) {
      return
    }
    const reordered = arr.slice()
    const [moved] = reordered.splice(fromIdx, 1)
    // 삽입선은 "toIdx chip 의 *왼쪽*(앞)에 끼움" 의미. 그런데 위에서
    // fromIdx 를 먼저 빼면 그 뒤 인덱스가 1씩 당겨지므로, 왼→오른(from<to)
    // 드래그 시 toIdx 에 그대로 끼우면 한 칸 뒤로 밀린다(드롭 대상 *뒤*로).
    // from<to 면 1 보정해 항상 대상 chip 앞에 정확히 오게 한다. 끝 드롭존
    // (toIdx === arr.length)도 이 식이 자연히 처리: from<len → len-1 →
    // 제거 후 배열 끝에 append.
    const insertAt = fromIdx < toIdx ? toIdx - 1 : toIdx
    reordered.splice(insertAt, 0, moved)
    setDraft((d) => (d ? { ...d, pages: reordered } : d))
    setCurrentPage((p) => {
      const cur = arr[p]
      const ni = reordered.indexOf(cur)
      return ni >= 0 ? ni : clamp(p, 0, reordered.length - 1)
    })
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
      // 새 위젯 "제목 생략" 기본값 — 이 type 에 대해 기억된 값이 on 이면 새
      // 블록의 content 에 미리 박는다(report 는 content 가 블록과 분리 저장).
      const skipSeed = getCaptionSkip(widgetType)
      const nextPages = d.pages.map((p, i) =>
        i === pageIdx
          ? {
              ...p,
              extra_blocks: [...(p.extra_blocks ?? []), newBlock],
              blocks_order: nextOrder,
              ...(defaultSection ? { block_sections: nextSections } : {}),
              ...(skipSeed
                ? {
                    content: {
                      ...(p.content ?? {}),
                      [id]: { caption_skip_autofill: true },
                    },
                  }
                : {}),
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

      // 새 위젯 "제목 생략" 기본값 시드 — addExtraBlock 과 동일.
      const skipSeed = getCaptionSkip(widgetType)
      const nextPages = d.pages.map((p, i) =>
        i === pageIdx
          ? {
              ...p,
              extra_blocks: [...(p.extra_blocks ?? []), newBlock],
              blocks_order: nextOrder,
              layout_overrides: nextOverrides,
              ...(defaultSection ? { block_sections: nextSections } : {}),
              ...(skipSeed
                ? {
                    content: {
                      ...(p.content ?? {}),
                      [id]: { caption_skip_autofill: true },
                    },
                  }
                : {}),
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

  /** Snapshot a block`s full EFFECTIVE state into a serializable
   *  descriptor — used by both copy and cut. We merge the template /
   *  override layers (props_overrides, layout_overrides,
   *  block_sections) into a flat shape so the paste site can recreate
   *  the widget as a standalone extra block with no template parent.
   *  Returns `null` when the block can`t be resolved. */
  function snapshotBlock(pageIdx, blockId) {
    const page = draft?.pages?.[pageIdx]
    if (!page) return null
    const tpl = getCachedTemplate(pageTemplateMap, page)
    const block = combinedBlocks(tpl, page).find((b) => b.id === blockId)
    if (!block) return null
    const propsOverride = page.props_overrides?.[blockId] ?? null
    const layoutOverride = page.layout_overrides?.[blockId] ?? null
    const content = page.content?.[blockId] ?? null
    const section = resolveBlockSection(page, block)
    const effectiveProps = propsOverride
      ? { ...(block.props ?? {}), ...propsOverride }
      : block.props ?? {}
    const effectiveLayout = layoutOverride ?? block.layout ?? null
    return {
      type: block.type,
      props: effectiveProps,
      content,
      layout: effectiveLayout,
      section,
    }
  }

  /** Copy a block to the in-memory clipboard. `cut=true` also removes
   *  the source so the gesture reads as a move; the clipboard then
   *  carries a `cutSource` flag that auto-clears the slot after the
   *  first paste (= a cut block can`t be pasted twice; that would be
   *  a duplicate, not a move). */
  function copyBlockToClipboard(pageIdx, blockId, { cut = false } = {}) {
    const snap = snapshotBlock(pageIdx, blockId)
    if (!snap) return
    setBlockClipboard({ ...snap, cutSource: cut ? { pageIdx, blockId } : null })
    if (cut) {
      removeBlockFromPage(pageIdx, blockId)
      // 활성 선택이 잘려나간 블록이었으면 같이 비워줘야 다른 단축키
      // (Del, Ctrl+C 등) 가 stale block id 를 잡지 않음.
      if (
        activeBlock?.pageIdx === pageIdx &&
        activeBlock?.blockId === blockId
      ) {
        setActiveBlock(null)
      }
    }
    toast.success(cut ? '위젯을 잘라냈습니다' : '위젯을 복사했습니다')
  }

  /** Paste the clipboard onto the target page as a brand-new extra
   *  block. Behavior by `anchorId`:
   *    - anchorId === null      → append at end of page (drag-reorder
   *                               afterward)
   *    - anchorId === <block>   → insert as a new full-row right BELOW
   *                               the anchor; everything at/after the
   *                               anchor`s row bumps down by 1. Original
   *                               col_span / row_span / auto_fit are
   *                               preserved verbatim (paste keeps shape).
   *  Auto-clears the clipboard when the source was a cut (move
   *  semantics) — copy keeps it so the user can repeat-paste. */
  function pasteBlockOnPage(pageIdx, anchorId = null) {
    if (!blockClipboard) return
    const clip = blockClipboard
    let pastedId = null
    setDraft((d) => {
      if (!d) return d
      const page = d.pages[pageIdx]
      if (!page) return d
      const tpl = getCachedTemplate(pageTemplateMap, page)
      const allBlocks = combinedBlocks(tpl, page)
      const existingIds = collectPageBlockIds(page, tpl)
      const newId = freshExtraId(clip.type, existingIds)
      pastedId = newId
      const newBlock = {
        id: newId,
        type: clip.type,
        props: { ...(clip.props ?? {}) },
        // Layout carries col_span / row_span / auto_fit verbatim so
        // the pasted widget keeps the source`s shape. row will be
        // overridden by the anchor branch below; the append branch
        // doesn`t care since blocks_order drives initial placement.
        layout: clip.layout ? { ...clip.layout } : null,
      }
      const nextExtras = [...(page.extra_blocks ?? []), newBlock]
      const nextContent =
        clip.content != null
          ? { ...(page.content ?? {}), [newId]: clip.content }
          : page.content
      const nextSections = clip.section
        ? { ...(page.block_sections ?? {}), [newId]: clip.section }
        : page.block_sections

      const overrides = page?.layout_overrides ?? {}
      const baseOrder = page.blocks_order?.length
        ? [...page.blocks_order]
        : allBlocks.map((b) => b.id)

      function resolvedLayout(block) {
        const ov = overrides[block.id]
        const base = ov ?? block.layout ?? null
        return base
          ? { row: base.row, col_span: base.col_span, row_span: base.row_span ?? 4 }
          : { row: 1, col_span: REPORT_GRID_COLS, row_span: AUTO_FIT_INITIAL_ROWS }
      }

      const anchor = anchorId
        ? allBlocks.find((b) => b.id === anchorId)
        : null

      let nextOverrides = overrides
      let nextOrder

      if (anchor) {
        // "기준 위젯 바로 아래" — anchor 행 다음에 새 행 끼우고 그 아래
        // 모든 블록의 row 를 +1. addExtraBlockAt('down') 와 같은 패턴이지만
        // 새 블록의 col_span/row_span 은 clip 원본 그대로 유지.
        const anchorLayout = resolvedLayout(anchor)
        const insertRow = anchorLayout.row + 1
        nextOverrides = { ...overrides }
        for (const b of allBlocks) {
          const lay = resolvedLayout(b)
          if (lay.row >= insertRow) {
            nextOverrides[b.id] = {
              ...(nextOverrides[b.id] ?? lay),
              row: lay.row + 1,
            }
          }
        }
        nextOverrides[newId] = {
          row: insertRow,
          col_span: clip.layout?.col_span ?? REPORT_GRID_COLS,
          row_span: clip.layout?.row_span ?? AUTO_FIT_INITIAL_ROWS,
          ...(clip.layout?.col_offset != null
            ? { col_offset: clip.layout.col_offset }
            : {}),
          ...(clip.layout?.auto_fit != null
            ? { auto_fit: clip.layout.auto_fit }
            : {}),
        }
        const anchorIdx = baseOrder.indexOf(anchorId)
        nextOrder =
          anchorIdx >= 0
            ? [...baseOrder.slice(0, anchorIdx + 1), newId, ...baseOrder.slice(anchorIdx + 1)]
            : [...baseOrder, newId]
      } else {
        // Anchor 없음 → 페이지 끝에 추가. blocks_order 가 비어있으면
        // combinedBlocks 가 "template 다음 extras" fallback 으로 살려줌.
        nextOrder = page.blocks_order?.length
          ? [...page.blocks_order, newId]
          : page.blocks_order ?? []
      }

      const nextPages = d.pages.map((p, i) =>
        i === pageIdx
          ? {
              ...p,
              extra_blocks: nextExtras,
              content: nextContent,
              blocks_order: nextOrder,
              block_sections: nextSections,
              ...(anchor
                ? { layout_overrides: nextOverrides }
                : {}),
            }
          : p,
      )
      return { ...d, pages: nextPages }
    })
    // Move-semantics: a cut block survives in the clipboard only until
    // its first paste. Plain copy stays so the user can paste again.
    if (clip.cutSource) setBlockClipboard(null)
    if (pastedId) {
      // 붙여넣은 직후 그 위젯을 active 로 표시 → 그 다음 Ctrl+V 면
      // 또 paste, Del 면 그 위젯 삭제 같은 후속 동작이 자연스럽게.
      setActiveBlock({ pageIdx, blockId: pastedId })
    }
    toast.success('위젯을 붙여 넣었습니다')
  }

  /** Move a single block from one page to another in one atomic
   *  setDraft call. Same effective state copies over (props / content
   *  / layout / section) as copy-paste, but source page sheds the
   *  block, destination page appends it at the end. No-op when src and
   *  dst are the same page (UI doesn`t even surface that option). */
  function moveBlockToPage(srcPageIdx, blockId, dstPageIdx) {
    if (srcPageIdx === dstPageIdx) return
    setDraft((d) => {
      if (!d) return d
      const srcPage = d.pages[srcPageIdx]
      const dstPage = d.pages[dstPageIdx]
      if (!srcPage || !dstPage) return d

      // ---- Build the snapshot from the LIVE draft `d` so we`re not
      // racing against any pending state from outside this updater.
      const srcTpl = getCachedTemplate(pageTemplateMap, srcPage)
      const srcBlocks = combinedBlocks(srcTpl, srcPage)
      const block = srcBlocks.find((b) => b.id === blockId)
      if (!block) return d
      const propsOverride = srcPage.props_overrides?.[blockId] ?? null
      const layoutOverride = srcPage.layout_overrides?.[blockId] ?? null
      const content = srcPage.content?.[blockId] ?? null
      const section = resolveBlockSection(srcPage, block)
      const effProps = propsOverride
        ? { ...(block.props ?? {}), ...propsOverride }
        : block.props ?? {}
      const effLayout = layoutOverride ?? block.layout ?? null

      // ---- Strip everything tied to blockId from the SOURCE page.
      // Mirrors removeBlockFromPage so the source page reads exactly
      // like the block was deleted there.
      const srcOrder = srcPage.blocks_order?.length
        ? srcPage.blocks_order
        : srcBlocks.map((b) => b.id)
      const nextSrcOrder = srcOrder.filter((id) => id !== blockId)
      const nextSrcExtras = (srcPage.extra_blocks ?? []).filter(
        (b) => b.id !== blockId,
      )
      const nextSrcContent = { ...(srcPage.content ?? {}) }
      delete nextSrcContent[blockId]
      const nextSrcLayout = { ...(srcPage.layout_overrides ?? {}) }
      delete nextSrcLayout[blockId]
      const nextSrcPropsOv = { ...(srcPage.props_overrides ?? {}) }
      delete nextSrcPropsOv[blockId]
      const nextSrcSections = { ...(srcPage.block_sections ?? {}) }
      delete nextSrcSections[blockId]

      // ---- Append to the DESTINATION page as a fresh extra block.
      const dstTpl = getCachedTemplate(pageTemplateMap, dstPage)
      const existingIds = collectPageBlockIds(dstPage, dstTpl)
      const newId = freshExtraId(block.type, existingIds)
      const newBlock = {
        id: newId,
        type: block.type,
        props: { ...effProps },
        layout: effLayout ? { ...effLayout } : null,
      }
      const nextDstExtras = [...(dstPage.extra_blocks ?? []), newBlock]
      const nextDstContent =
        content != null
          ? { ...(dstPage.content ?? {}), [newId]: content }
          : dstPage.content
      const nextDstSections = section
        ? { ...(dstPage.block_sections ?? {}), [newId]: section }
        : dstPage.block_sections
      const nextDstOrder = dstPage.blocks_order?.length
        ? [...dstPage.blocks_order, newId]
        : dstPage.blocks_order ?? []

      const nextPages = d.pages.map((p, i) => {
        if (i === srcPageIdx) {
          return {
            ...p,
            blocks_order: nextSrcOrder,
            extra_blocks: nextSrcExtras,
            content: nextSrcContent,
            layout_overrides: Object.keys(nextSrcLayout).length
              ? nextSrcLayout
              : null,
            props_overrides: Object.keys(nextSrcPropsOv).length
              ? nextSrcPropsOv
              : null,
            block_sections: nextSrcSections,
          }
        }
        if (i === dstPageIdx) {
          return {
            ...p,
            extra_blocks: nextDstExtras,
            content: nextDstContent,
            blocks_order: nextDstOrder,
            block_sections: nextDstSections,
          }
        }
        return p
      })
      return { ...d, pages: nextPages }
    })
    // 옮긴 블록이 active 였으면 active 상태도 비워줘야 stale id 가 안 남음.
    if (
      activeBlock?.pageIdx === srcPageIdx &&
      activeBlock?.blockId === blockId
    ) {
      setActiveBlock(null)
    }
    toast.success('다른 페이지로 옮겼습니다')
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
      // Explicit x offset (col_offset) — ALWAYS persist, even x=0.
      // (Fix A) 예전엔 x>0 일 때만 저장하고 x=0 은 "복원 시 형제 col_span
      // 누적"으로 추정했는데, 한 행 안에서 시각적 좌우 순서가 블록 배열(문서)
      // 순서와 다르면(나중에 추가한 블록을 왼쪽으로 드래그 등) 그 추정이 어긋나
      // 충돌→엉뚱한 자리로 밀리는 왕복 손실이 있었다. x 를 항상 명시 저장하면
      // 복원이 추정 없이 그대로 복구한다. (x=0 은 기본값이라 matchesTemplate
      // 가지치기에는 영향 없음 — col_offset ?? 0 비교로 흡수.)
      newLayout.col_offset = clamp(it.x ?? 0, 0, REPORT_GRID_COLS - 1)
      const blkTpl = block.layout
      const matchesTemplate =
        blkTpl &&
        isAutoFit === defaultEnabled &&
        blkTpl.row === newLayout.row &&
        blkTpl.col_span === newLayout.col_span &&
        blkTpl.row_span === newLayout.row_span &&
        (blkTpl.col_offset ?? 0) === (newLayout.col_offset ?? 0)
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

  // (Fix B) 저장 직전, 자동맞춤(auto_fit) 블록의 persisted row_span 을 *뷰 모드*
  // 콘텐츠 측정 높이(contentHeightsByPage)로 다시 맞춘다. handleLayoutChange 는
  // 드래그/리사이즈 시점에만 row_span 을 갱신하므로, 마지막 드래그 이후 콘텐츠
  // 높이가 바뀌면(텍스트 편집 등) draft 의 row_span 이 낡은 채로 저장돼 reload·
  // export 초기 렌더에서 높이→아래 블록 위치가 어긋났다. effectiveLayouts 의
  // 뷰 모드 공식과 동일하게 계산해, "저장된 크기 = 뷰가 그릴 크기" 를 보장한다.
  // 측정값이 없는 블록(아직 마운트 안 된 다른 페이지 등)은 건드리지 않는다.
  function reconcileAutoFitRowSpans(page, pageIdx) {
    const overrides = page.layout_overrides
    if (!overrides) return overrides
    const tpl = getCachedTemplate(pageTemplateMap, page)
    if (!tpl) return overrides
    const blocks = combinedBlocks(tpl, page)
    const heights = contentHeightsByPage[pageIdx] ?? {}
    const gap = Number.isFinite(draft?.page_gap_px)
      ? draft.page_gap_px
      : REPORT_ROW_GAP
    let changed = false
    const next = {}
    for (const [blockId, layout] of Object.entries(overrides)) {
      const block = blocks.find((b) => b.id === blockId)
      const contentPx = heights[blockId]
      if (
        block &&
        autoFitForBlock(block, layout) &&
        contentPx != null &&
        contentPx > 0
      ) {
        const rows = Math.max(
          1,
          Math.ceil((contentPx + gap) / (REPORT_ROW_HEIGHT + gap)),
        )
        if (rows !== layout?.row_span) {
          next[blockId] = { ...layout, row_span: rows }
          changed = true
          continue
        }
      }
      next[blockId] = layout
    }
    return changed ? next : overrides
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
      const normalizedPages = draft.pages.map((p, pageIdx) => ({
        ...p,
        // (Fix B) 자동맞춤 row_span 을 뷰 측정 높이로 확정한 뒤 정규화.
        layout_overrides: normalizeLayoutOverrides(
          reconcileAutoFitRowSpans(p, pageIdx),
        ),
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
        // 긴 글 depth-별 머리 기호. 빈 문자열은 다이얼로그에서 이미 null
        // 로 정규화했지만 안전을 위해 한 번 더 trim 해서 비면 null 로 보낸다.
        page_rich_text_prefix_d0: normalizeRichTextPrefix(draft.page_rich_text_prefix_d0),
        page_rich_text_prefix_d1: normalizeRichTextPrefix(draft.page_rich_text_prefix_d1),
        page_rich_text_prefix_d2: normalizeRichTextPrefix(draft.page_rich_text_prefix_d2),
        // 보고서별 기본 보기 모드. null 이면 저장값 해제(개인 전역설정 폴백).
        page_default_view_mode: draft.page_default_view_mode ?? null,
        // 보고서 종류 — null clears the tag. The backend's update
        // schema uses `exclude_unset`, so always sending the key (even
        // when null) is the explicit "clear" signal.
        report_type_id: draft.report_type_id ?? null,
        // Entity tags — full replacement set every save (the backend
        // diffs against existing report_entities and rewrites). Empty
        // array clears all tags; sending the field unconditionally keeps
        // the create/update paths symmetric.
        entity_ids: (draft.entities ?? []).map((e) => e.id),
        // 협업 부서 — 슬러그 전체 교체 집합. 빈 배열이면 전부 해제.
        collab_workspace_slugs: draft.collab_workspace_slugs ?? [],
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
          description: (
            <div
              onClick={(e) => {
                const range = document.createRange()
                range.selectNodeContents(e.currentTarget)
                const sel = window.getSelection()
                sel?.removeAllRanges()
                sel?.addRange(range)
              }}
              style={{ cursor: 'text' }}
            >
              {msg}
            </div>
          ),
          duration: 20000,
          closeButton: true,
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
        collab_workspace_slugs: existingReport.collab_workspace_slugs ?? [],
        page_width_px: existingReport.page_width_px ?? null,
        page_gap_px: existingReport.page_gap_px ?? null,
        page_blend_blocks: existingReport.page_blend_blocks === true,
        // 가이드 4 필드 — cancel 시 서버 스냅샷 그대로 복원되도록 한다.
        page_slide_guide: existingReport.page_slide_guide === true,
        page_slide_ratio: existingReport.page_slide_ratio ?? null,
        page_slide_ratio_custom_w: existingReport.page_slide_ratio_custom_w ?? null,
        page_slide_ratio_custom_h: existingReport.page_slide_ratio_custom_h ?? null,
        page_rich_text_prefix_d0: existingReport.page_rich_text_prefix_d0 ?? null,
        page_rich_text_prefix_d1: existingReport.page_rich_text_prefix_d1 ?? null,
        page_rich_text_prefix_d2: existingReport.page_rich_text_prefix_d2 ?? null,
        // 보기 모드도 cancel 시 서버 스냅샷으로 복원.
        page_default_view_mode: existingReport.page_default_view_mode ?? null,
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
      // "삭제" = 소프트삭제(휴지통). 개인 목록에선 숨지만 게시된 부서
      // 게시판엔 그대로 남고, 휴지통에서 복구할 수 있다.
      await trashReport(draft.id)
      toast.success('휴지통으로 이동했습니다. (휴지통에서 복구 가능)')
      // dirty guard 우회 — 사용자의 의도된 이동.
      isEditingRef.current = false
      navigate(`/w/${slug}/reports`)
    } catch (err) {
      toast.error(err.message || '삭제 실패')
    }
  }

  // 작성자 hard lock 토글(owner only) — "더보기" 메뉴 항목에서 호출.
  async function toggleAuthorLock() {
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
        if (reason === null) return
        await setAuthorLock(existingReport.id, { enabled: true, reason })
        toast.success('수정 잠금 활성화')
      }
      reloadReport()
    } catch (e) {
      toast.error(e?.response?.data?.message || '잠금 변경 실패')
    }
  }

  async function onRestore() {
    try {
      await restoreReport(draft.id)
      toast.success('복구되었습니다.')
      reloadReport()
    } catch (err) {
      toast.error(err.message || '복구 실패')
    }
  }

  // 영구삭제(purge) — 휴지통 배너에서. 비가역. 백엔드가 게시 중이면 막고
  // (can_purge=false 면 버튼 자체가 안 뜸), 종합보고 안건도 cascade 로 사라진다.
  async function onPurge() {
    const n = existingReport?.composite_ref_count ?? 0
    const warn =
      '이 보고서를 영구히 삭제합니다. 되돌릴 수 없습니다.' +
      (n > 0 ? `\n\n종합보고 ${n}건의 안건에서도 함께 사라집니다.` : '')
    if (!window.confirm(warn)) return
    try {
      await deleteReport(draft.id)
      toast.success('영구 삭제되었습니다.')
      isEditingRef.current = false
      navigate(`/w/${slug}/reports`)
    } catch (err) {
      toast.error(
        err?.response?.data?.message || err.message || '영구 삭제 실패',
      )
    }
  }

  /** Clone the current report's pages (content + layouts + overrides + extras
   *  + section tags) into a brand-new draft owned by the current user.
   *  Title comes from the dialog input; report_date resets to today and the
   *  backend auto-assigns owner / created_at / updated_by from the request.
   *  Status drops back to 'draft' since a copy represents fresh work.
   *  After creation we navigate to the new report's URL with `startEditing`
   *  in router state so it lands directly in the edit screen. */
  async function onCopy(newTitle, folderId, mode) {
    // Copy works off the *saved* report (server duplicates by id, including
    // its relations like 연결된 보고서 — which only exist server-side). The
    // backend decides exactly what travels per `mode`.
    if (!existingReport?.id) return
    try {
      const created = await copyReport(existingReport.id, {
        title: newTitle,
        folder_id: folderId ?? null,
        mode,
      })
      toast.success(
        mode === 'full'
          ? '보고서가 복사되었습니다 (메타데이터·연결 포함).'
          : '보고서가 복사되었습니다 (본문만).',
      )
      setCopyOpen(false)
      // Bypass the dirty guard — copy is an explicit "leave for the new
      // clone" action. The source draft is intentionally left as-is.
      isEditingRef.current = false
      // Copy lands in the creator's personal workspace, so navigate using
      // the server-returned slug rather than the page's current `slug`.
      navigate(`/w/${created.workspace_slug}/reports/${created.id}`, {
        state: { startEditing: true },
      })
    } catch (err) {
      toast.error(err.message || '복사 실패')
      throw err
    }
  }

  async function onSavePreset(name, description, ownerWorkspaceSlugs) {
    // 저장된 보고서를 스냅샷해 "프리셋"으로 만든다(서버가 id 로 스냅샷).
    if (!existingReport?.id) return
    try {
      await createPreset({
        source_report_id: existingReport.id,
        name,
        description: description ?? '',
        owner_workspace_slugs: ownerWorkspaceSlugs, // null = 전사 공개
      })
      toast.success('프리셋으로 저장되었습니다.')
      setSavePresetOpen(false)
    } catch (err) {
      toast.error(err.message || '프리셋 저장 실패')
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
    // Defer — 즉시 revoke 시 다운로드 fetch 가 진행 중일 때 콘솔에
    // GET blob:... ERR_FILE_NOT_FOUND. 충분한 여유 두고 정리.
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
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
    // Belt + suspenders: cancel any leftover controller before starting
    // (shouldn`t happen — setPrinting blocks re-entry — but cheap.)
    exportAbortRef.current?.abort()
    const controller = new AbortController()
    exportAbortRef.current = controller
    setPrinting(true)
    // Seed the overlay immediately so the user sees feedback the
    // instant they click — the chart-settle wait alone can take a few
    // seconds on chart-heavy reports.
    setHtmlProgress({ phase: 'settle', label: '차트 렌더링 안정화 중...' })
    try {
      // Two RAFs let React commit the printing=true render. Then poll
      // until every "크기 조정 중…" placeholder is gone — these are the
      // Chart / Scatter / Heatmap / Box / Treemap / Density / Sankey
      // widgets cycling through their 200ms ResizeObserver debounce
      // after the print-mode layout shift remeasures every grid cell.
      // Without waiting them out, captured DOM contains placeholders
      // that have no JS to flip back, so charts appear permanently
      // resizing in the saved HTML. Cap at ~5s so a stuck widget
      // doesn't hang the export indefinitely; the exporter scrubs any
      // survivor's text so a stragglers' placeholder shows as empty,
      // not as a fake "still computing" lie.
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)),
      )
      if (controller.signal.aborted) throw new DOMException('Export cancelled', 'AbortError')
      await waitForChartsToSettle(5000, controller.signal)
      if (controller.signal.aborted) throw new DOMException('Export cancelled', 'AbortError')
      setHtmlProgress({ phase: 'load', label: '내보내기 모듈 로드 중...' })
      const { exportReportToHtml } = await import('./exportReportToHtml')
      await exportReportToHtml({
        draft,
        onProgress: setHtmlProgress,
        signal: controller.signal,
      })
      toast.success('HTML 파일로 저장했습니다.')
    } catch (err) {
      if (err?.name === 'AbortError') {
        toast.info('HTML 내보내기를 취소했습니다.')
      } else {
        console.error(err)
        toast.error(`HTML 저장 실패: ${err?.message ?? err}`)
      }
    } finally {
      setPrinting(false)
      setHtmlProgress(null)
      if (exportAbortRef.current === controller) exportAbortRef.current = null
    }
  }

  // Poll the live DOM at 100ms intervals until no widget is showing the
  // "크기 조정 중…" placeholder, or the budget runs out. Polling is
  // cheap (one querySelectorAll + textContent scan per tick), and the
  // loop unblocks the instant all charts settle.
  //
  // Quiet-period gate: after a tick comes back clean, we re-check 250ms
  // later — comfortably past the widgets' 200ms ResizeObserver debounce.
  // Without this, a chart whose debounce was about to fire when we
  // checked (`resizing` would flip true ~5ms after our scan) sneaks
  // its placeholder into the clone with no React left to flip it back.
  async function waitForChartsToSettle(budgetMs, signal) {
    const root = document.querySelector('.report-detail-root')
    if (!root) return
    const start = performance.now()
    const isResizing = () =>
      Array.from(root.querySelectorAll('div')).some(
        (el) =>
          el.children.length === 0 &&
          el.textContent?.trim() === '크기 조정 중…',
      )
    while (performance.now() - start < budgetMs) {
      if (signal?.aborted) return
      if (!isResizing()) {
        // 250ms > 200ms ResizeObserver debounce in every chart widget,
        // so a tail debounce arming right after our scan will have
        // either fired (placeholder appears → re-loop) or be safely
        // past its window.
        await new Promise((r) => setTimeout(r, 250))
        if (!isResizing()) {
          await new Promise((r) => requestAnimationFrame(r))
          return
        }
        // Re-armed during the quiet window — fall back into the poll.
        continue
      }
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  // Word export — runs the docx builder with the report mounted in
  // view-mode so html2canvas captures of chart/flowchart/milestone
  // blocks come out clean. The builder lives in exportReportToDocx.
  async function handleExportDocx() {
    if (!draft) return
    exportAbortRef.current?.abort()
    const controller = new AbortController()
    exportAbortRef.current = controller
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
      if (controller.signal.aborted) throw new DOMException('Export cancelled', 'AbortError')
      const { exportReportToDocx } = await import('./exportReportToDocx')
      await exportReportToDocx({
        draft,
        pageTemplateMap,
        sectionItemByCode,
        onProgress: setDocxProgress,
        signal: controller.signal,
      })
      toast.success('Word 파일로 저장했습니다.')
    } catch (err) {
      if (err?.name === 'AbortError') {
        toast.info('Word 내보내기를 취소했습니다.')
      } else {
        console.error(err)
        toast.error(`Word 저장 실패: ${err?.message ?? err}`)
      }
    } finally {
      setPrinting(false)
      setDocxProgress(null)
      if (exportAbortRef.current === controller) exportAbortRef.current = null
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

  // 같은 폴더 형제 보고서 네비게이션용 folder id. 개인 공간은 보고서의
  // folder_id, 조직 게시판은 이 워크스페이스 mount 의 folder_id 를 쓴다.
  // 미분류(null)는 'uncategorized' 센티넬로 — listReports 가 동일하게
  // 미분류 형제만 내려준다. 새 보고서/문맥 불명이면 undefined → 네비 숨김.
  const siblingFolderId = isNew
    ? undefined
    : isPersonalContext
      ? existingReport?.folder_id ?? FOLDER_FILTER_UNCATEGORIZED
      : isOrgContext && currentMount
        ? currentMount.folder_id ?? FOLDER_FILTER_UNCATEGORIZED
        : undefined

  // "목록"으로 돌아갈 때 보던 폴더로 복원시킬 state. 폴더 문맥이 불명(undefined)
  // 이면 state 없이 기본 목록으로. 렌더마다 ref 갱신(백스페이스 핸들러 공유).
  listBackStateRef.current =
    siblingFolderId === undefined
      ? undefined
      : { listFolderId: siblingFolderId }

  return (
    <PrintScaleContext.Provider value={printContextValue}>
    <ReportStyleContext.Provider value={reportStyleValue}>
    <ReportMentionProvider
      hostReportId={existingReport?.id ?? null}
      hostReportTitle={existingReport?.title ?? null}
      // @ 트리거는 편집 모드 + 편집권한일 때만. navigate 는 enabled 무관 항상 제공
      // (뷰 모드/비편집자도 본문 링크 이동 가능).
      enabled={effectiveIsEditing && !!existingReport?.can_edit && existingReport?.id != null}
      navigate={navigate}
      addLink={linkedReports.addLink}
      blockIndex={blockRefIndex}
      referenceableBlocks={referenceableBlocks}
      scrollToBlock={scrollToBlock}
      onBlockRefClick={onBlockRefClick}
      onDeptMentionClick={onDeptMentionClick}
    >
    <CommentsProvider
      reportId={existingReport?.id ?? null}
      reportPhase={existingReport?.phase}
      resolveBlock={resolveCommentBlock}
      navigateToBlock={navigateToCommentBlock}
    >
    <div className="flex h-full report-detail-root">
      {/* 좌측 보조 사이드바 — 같은 폴더 보고서 목록. 제목/툴바를 어지럽히지
          않도록 좌측 끝(앱 사이드바 옆)에 둔다. 닫혀 있으면 얇은 레일의 폴더
          버튼만, 열리면 세로 목록 패널. 폴더 컨텍스트 있고 편집중 아닐 때만,
          데스크톱 전용(앱 사이드바 접기와 동일 정책). */}
      {!isEditing && siblingFolderId !== undefined &&
        (folderPanelOpen ? (
          <FolderReportsPanel
            slug={slug}
            folderId={siblingFolderId}
            currentReportId={existingReport?.id}
            onClose={() => setFolderPanelOpen(false)}
          />
        ) : (
          <div className="hidden md:flex w-9 shrink-0 flex-col items-center border-r bg-card pt-2">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setFolderPanelOpen(true)}
              title="같은 폴더 보고서 목록"
            >
              <Folder className="h-4 w-4" />
              <span className="sr-only">같은 폴더 보고서 목록</span>
            </Button>
          </div>
        ))}
      <div className="relative flex-1 min-w-0 flex flex-col">
        {/* 휴지통 배너 — 소프트삭제된 보고서를 열었을 때(개인 목록엔 숨지만
            게시판엔 남아 직접 열람 가능). 소유자/시스템관리자는 여기서 복구. */}
        {existingReport?.deleted_at && (
          <div className="flex items-center gap-3 border-b bg-amber-50 px-6 py-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200 print:hidden">
            <Trash2 className="h-3.5 w-3.5 shrink-0" />
            <span className="flex-1">
              이 보고서는 휴지통에 있습니다. 개인 목록에선 숨겨지지만 게시된 부서
              게시판에는 그대로 남아 있습니다.
              {existingReport?.is_mounted && (
                <> 영구 삭제하려면 먼저 게시판에서 내려야 합니다.</>
              )}
            </span>
            {existingReport?.can_trash && (
              <Button size="sm" variant="outline" className="h-7" onClick={onRestore}>
                복구
              </Button>
            )}
            {existingReport?.can_purge && (
              <Button
                size="sm"
                variant="destructive"
                className="h-7"
                onClick={onPurge}
              >
                완전 삭제
              </Button>
            )}
          </div>
        )}
        {/* 부모는 flex-wrap 없음 — 버튼 그룹이 제목 아래로 통째로 떨어지지
            않게 한다. 대신 제목은 min-w 까지만 줄고, 남는 폭이 부족하면 오른쪽
            버튼 그룹이 자기 안에서 두 줄로 감긴다(아래 그룹의 flex-wrap). */}
        <div className="flex items-start gap-3 border-b bg-background px-6 py-3 report-detail-toolbar">
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
              {/* 헤더 메타는 Phase·보고 기준일(+잠금/종합 chip)만 노출.
                  템플릿 종류·버전·페이지 수·작성/수정 정보는 과다정보라
                  아래 info(i) 버튼 팝오버로 모았다. */}
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
              {/* 작성자·작성/수정 시각 — 헤더에 직접 띄우면 과다정보라
                  info(i) 버튼 팝오버로 접었다. 보고 기준일은 위에 그대로
                  노출(편집 가능). */}
              {!isNew && existingReport && (
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      title="작성·수정 정보"
                      className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      <Info className="h-3.5 w-3.5" />
                      <span className="sr-only">작성·수정 정보</span>
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-64 p-3 space-y-2">
                    {/* 보고서 종류 + 사용 템플릿 + 페이지 수 — 헤더에서 옮겨온
                        부가정보. 멀티페이지는 현재 보고 있는 페이지의 템플릿
                        기준. 종류는 편집 중이면 draft(미저장) 값을 우선 반영. */}
                    <div className="space-y-1 text-[11px] text-muted-foreground">
                      <div>
                        <span className="text-muted-foreground/70">종류</span>{' '}
                        <span className="text-foreground/80">
                          {(draft?.report_type ?? existingReport.report_type)
                            ?.name ?? '미지정'}
                        </span>
                      </div>
                      <div>
                        <span className="text-muted-foreground/70">템플릿</span>{' '}
                        <span className="text-foreground/80">
                          {currentTemplate?.name ?? '불러오는 중…'}
                        </span>
                        {currentPageData?.template_version != null && (
                          <span className="text-muted-foreground/70">
                            {' · '}v{currentPageData.template_version}
                          </span>
                        )}
                      </div>
                      <div>
                        <span className="text-muted-foreground/70">페이지</span>{' '}
                        <span className="text-foreground/80">{pageCount}개</span>
                      </div>
                    </div>
                    <div className="border-t pt-2">
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
                    </div>
                  </PopoverContent>
                </Popover>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 ml-auto">
          {/* ─── Group 1: Navigation (왼쪽으로 빠짐) ───
              종합보고에서 진입한 경우에만 보이는 "돌아가기" 버튼. 진입 시
              location.state.fromComposite 로 어느 종합보고에서 왔는지가
              전달되고, 클릭하면 그 종합보고 페이지로 navigate. 새로고침 시
              state 가 사라져 버튼도 함께 사라진다. */}
          {location.state?.fromComposite?.id && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const fc = location.state.fromComposite
                navigate(`/w/${fc.slug ?? slug}/composites/${fc.id}`)
              }}
              title={
                location.state.fromComposite.title
                  ? `종합보고 «${location.state.fromComposite.title}» 로 돌아가기`
                  : '종합보고로 돌아가기'
              }
            >
              <Layers className="mr-1 h-3 w-3" />
              종합보고로
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              // 보던 폴더로 목록 복원(전체로 튀지 않게).
              navigate(`/w/${slug}/reports`, {
                state: listBackStateRef.current,
              })
            }
          >
            <ArrowLeft className="mr-1 h-3 w-3" />
            목록
          </Button>

          {/* (같은 폴더 보고서 네비게이션은 좌측 보조 사이드바로 이동 —
              툴바 왼쪽 끝의 폴더 버튼으로 토글) */}

          <Separator orientation="vertical" className="h-6 mx-1" />

          {/* ─── Group 2: View options ─── */}
          {/* 페이지별/전체 토글은 편집모드 전용 — 이제 보고서별로 저장되는
              설정(저자가 정하는 기본 보기 레이아웃)이라, 보기 화면에서는
              저장값(없으면 폴백)을 그대로 따른다. */}
          {isEditing && (
            <ViewModeToggle value={viewMode} onChange={handleViewModeChange} />
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={toggleReportFullscreen}
            title={reportFullscreen ? '전체화면 종료 (Esc)' : '전체화면으로 보기 (발표)'}
            aria-pressed={reportFullscreen}
          >
            {reportFullscreen ? (
              <Minimize2 className="mr-1 h-3 w-3" />
            ) : (
              <Maximize2 className="mr-1 h-3 w-3" />
            )}
            {reportFullscreen ? '축소' : '전체화면'}
          </Button>

          <Separator orientation="vertical" className="h-6 mx-1" />

          {/* ─── Group 3: Primary edit action ───
              편집 ↔ 저장/취소 토글. 편집 모드에 진입하면 "지금 해야 할 액션"
              인 저장이 default variant(primary 색)로 강조되어 시선을 끈다.
              finalized 보고서는 편집 버튼 자체가 안 보임 — 발행 취소 후 편집. */}
          {isEditing ? (
            <>
              <Button variant="default" size="sm" onClick={onSave}>
                <Save className="mr-1 h-3 w-3" />
                {isNew ? '생성' : '저장'}
              </Button>
              <Button variant="ghost" size="sm" onClick={onCancelEdit}>
                <X className="mr-1 h-3 w-3" />
                {isNew ? '나가기' : '취소'}
              </Button>
            </>
          ) : (
            existingReport?.phase !== 'finalized' && (
              <Button variant="outline" size="sm" onClick={() => onEnterEdit()}>
                <Pencil className="mr-1 h-3 w-3" />
                편집
              </Button>
            )
          )}

          {!isEditing && (
            <>
              <Separator orientation="vertical" className="h-6 mx-1" />

              {/* ─── Group 4: Collaboration / Sharing ───
                  게시 → 발행 → 제출 → 공유 → 더보기. 보고서가 다른 이해
                  관계자에게 어떻게 노출되는지를 다루는 묶음. 저빈도 액션
                  (폴더 이동·활동·수정 잠금)은 "더보기"로 접었다. */}
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
                  {existingReport?.phase === 'finalized' ? (
                    <>
                      <Undo2 className="mr-1 h-3 w-3" />
                      발행 취소
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="mr-1 h-3 w-3" />
                      발행
                    </>
                  )}
                </Button>
              )}
              {/* 종합보고에 제출 — 발행 버튼 오른쪽. 동시편집 회피를 위해
                  종합보고를 직접 안 건드리고 신청만 한다(작성자 승인 후 추가). */}
              {!isNew && existingReport?.id && (
                <SubmitToCompositeButton reportId={existingReport.id} />
              )}
              {/* 공유는 툴바 혼잡을 줄이려 "더보기" 메뉴 안으로 이동. */}
              <Separator orientation="vertical" className="h-6 mx-1" />

              {/* ─── Group 5: Report variants ───
                  복사·템플릿화·삭제. 삭제는 destructive variant 로 시각적
                  위험성을 분명히 — 복사·템플릿 같은 무해한 액션과 톤 분리. */}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCopyOpen(true)}
              >
                <Copy className="mr-1 h-3 w-3" />
                복사
              </Button>
              {/* "삭제"=소프트삭제(휴지통). 소유자/시스템관리자만(can_trash).
                  게시분은 보존되고 휴지통에서 복구 가능. 게시판에서 내리는 건
                  매니저의 '게시취소'(별도). */}
              {existingReport?.can_trash && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 className="mr-1 h-3 w-3" />
                  삭제
                </Button>
              )}
            </>
          )}

          <Separator orientation="vertical" className="h-6 mx-1" />
          {/* ─── Group 6: Output / AI ───
              AI 프롬프트 + 로컬 파일 입출력. 편집/뷰 모드와 무관하게 항상
              노출 (편집 중에도 AI 도움이나 로컬 백업이 필요할 수 있음). */}

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

          {/* 더보기 — 툴바 맨 오른쪽. 저빈도 액션(관계도·폴더 이동·활동 이력·
              재사용 저장·수정 잠금)을 접어 혼잡을 줄인다. 편집 중엔 숨김
              (보기 모드 전용 액션). */}
          {!isEditing && !isNew && existingReport?.id && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" title="더보기">
                  <MoreHorizontal className="h-4 w-4" />
                  <span className="sr-only">더보기</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {/* 공유 — 부서(하위 상속)·사용자·전체공개 + 열람/편집. 예전엔
                    툴바의 독립 버튼이었으나 혼잡을 줄이려 여기로 이동.
                    전체공개 뷰(is_public_view)에서는 공유 편집 불가라 숨김. */}
                {!existingReport?.is_public_view && (
                  <>
                    <DropdownMenuItem onSelect={() => setShareOpen(true)}>
                      <Share2 className="mr-2 h-3.5 w-3.5" />
                      공유
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuItem onSelect={() => setGraphOpen(true)}>
                  <Network className="mr-2 h-3.5 w-3.5" />
                  관계도
                </DropdownMenuItem>
                {folderPickMode && (
                  <DropdownMenuItem onSelect={() => setFolderPickOpen(true)}>
                    <Folder className="mr-2 h-3.5 w-3.5" />
                    {folderPickMode === 'org' ? '게시판 폴더 이동' : '폴더 이동'}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={() => setActivityOpen(true)}>
                  <Activity className="mr-2 h-3.5 w-3.5" />
                  활동 이력
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setVersionsOpen(true)}>
                  <History className="mr-2 h-3.5 w-3.5" />
                  수정 이력 / 되돌리기
                </DropdownMenuItem>

                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
                  재사용 저장
                </DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => setSaveTemplateOpen(true)}>
                  <FileBox className="mr-2 h-3.5 w-3.5" />
                  <span className="flex flex-col">
                    <span>템플릿으로 저장</span>
                    <span className="text-[11px] text-muted-foreground">
                      위젯 배치(구조)만
                    </span>
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setSavePresetOpen(true)}>
                  <Sparkles className="mr-2 h-3.5 w-3.5" />
                  <span className="flex flex-col">
                    <span>프리셋으로 저장</span>
                    <span className="text-[11px] text-muted-foreground">
                      내용까지 채운 프리셋
                    </span>
                  </span>
                </DropdownMenuItem>

                {existingReport?.owner_user_id === me?.user?.id && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={() => toggleAuthorLock()}
                      className={
                        existingReport?.author_lock_enabled
                          ? 'text-destructive focus:text-destructive'
                          : undefined
                      }
                    >
                      {existingReport?.author_lock_enabled ? (
                        <>
                          <LockOpen className="mr-2 h-3.5 w-3.5" />
                          수정 잠금 해제
                        </>
                      ) : (
                        <>
                          <Lock className="mr-2 h-3.5 w-3.5" />
                          수정 잠금
                        </>
                      )}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          </div>
        </div>

        {/* Phase banner — explicit signal that the report is past the
            drafting stage. 우측엔 보고서 메타(종류·관련 정보) 등록 칩이
            얹혀서 사용자가 banner 영역 한 곳에서 모두 처리 가능. drafting
            상태엔 phase 색이 없으므로 메타가 비어있을 때만 amber 전용
            banner 가 동등 위치에 뜬다 — phase 와 메타 양쪽이 같은 시각
            언어를 공유.

            data-export-exclude: 모든 banner 가 transient editor state
            ("리뷰 진행 중", "발행됨", "수정 잠금", "메타데이터 등록")
            라 export 에선 제외. */}
        {/* 조직 간 공개 — 다른 조직의 공개 보고서를 열람 중일 때. 읽기 전용:
            백엔드가 can_edit/can_comment=false 로 편집·댓글을 막고 댓글·이력은
            빈 목록으로 내려준다(조직간공개_설계.md §6·§7.3). data-export-exclude
            로 export 본문엔 안 들어간다. */}
        {existingReport?.is_public_view && (
          <div
            data-export-exclude
            className="border-b bg-sky-50 px-6 py-2 text-xs text-sky-900 flex items-center gap-2"
          >
            <span className="text-base">🌐</span>
            <span className="font-medium shrink-0">다른 조직의 공개 보고서 · 읽기 전용</span>
            <span className="flex-1 min-w-0 truncate text-sky-800/80">
              {existingReport?.owner_name
                ? `${existingReport.owner_name} 작성 — `
                : ''}
              본문과 첨부만 열람할 수 있습니다. 편집·댓글·수정 이력은 비활성화됩니다.
            </span>
          </div>
        )}
        {/* reviewing("리뷰 중")·finalized("발행됨") 상태 리본은 제거됨 —
            상태 설명은 제목 아래 PhaseChip 뱃지를 클릭하면 팝오버로 표시한다.
            그 단계의 메타 칩(종류·관련정보·연결보고서)은 아래 MetaChipsBanner
            가 같은 자리에 계속 띄운다(편집모드, 잠금 배너가 없을 때). */}

        {/* Author lock banner — sits below the toolbar so it's
            unmissable while not blocking the title. */}
        {existingReport?.author_lock_enabled && (
          <div
            data-export-exclude
            className="border-b bg-red-50 px-6 py-2 text-xs text-red-800 flex items-center gap-2"
          >
            <span className="text-base">🔒</span>
            <span className="font-medium shrink-0">
              {existingReport.owner_name || '작성자'}가(이) 수정 잠금 —
            </span>
            <span className="flex-1 min-w-0 truncate">
              {existingReport.author_lock_reason || '사유 미기재'}
            </span>
            <span className="text-[10px] opacity-70 shrink-0">작성자 외 편집 불가</span>
            <ReportMetaChips
              draft={draft}
              setDraft={setDraft}
              isEditing={effectiveIsEditing}
              tone="red"
              reportId={existingReport?.id}
              linkedReports={linkedReports}
              canEdit={existingReport?.can_edit}
            />
          </div>
        )}
        {/* 메타 칩(종류·관련정보·연결보고서) 배너 — 편집모드에서 잠금 배너가
            없을 때 모든 phase(작성/리뷰/발행)에서 같은 자리에 칩을 띄운다.
            (reviewing/finalized 의 옛 상태 리본이 품던 칩을 여기로 일원화.) */}
        <MetaChipsBanner
          existingReport={existingReport}
          draft={draft}
          setDraft={setDraft}
          isEditing={effectiveIsEditing}
          linkedReports={linkedReports}
        />

        {/* 관련 정보 배너 — 헤더와 본문 사이 고정 한 줄. 모델명·부품명 등
            태깅된 엔티티를 인라인 요약으로 항상 노출해 칩 팝오버를 열지
            않고도 바로 확인. 편집중 draft 를 우선 읽어 추가/삭제 즉시 반영.
            태그가 없으면 렌더 안 됨. */}
        <ReportEntitiesPanel
          entities={draft?.entities ?? existingReport?.entities ?? []}
          collabSlugs={
            draft?.collab_workspace_slugs ??
            existingReport?.collab_workspace_slugs ??
            []
          }
        />

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
          onReorder={reorderPages}
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
                    onAddBlock={(type, defaults) => addExtraBlock(idx, type, defaults)}
                    onRemoveBlock={(blockId) => removeBlockFromPage(idx, blockId)}
                    onChangeExtraBlockProps={(blockId, newProps) =>
                      setExtraBlockProps(idx, blockId, newProps)
                    }
                    onChangeSection={(blockId, code) => setBlockSection(idx, blockId, code)}
                    onCopyBlock={(blockId) => copyBlockToClipboard(idx, blockId)}
                    onCutBlock={(blockId) =>
                      copyBlockToClipboard(idx, blockId, { cut: true })
                    }
                    onPasteBlock={(anchorId) => pasteBlockOnPage(idx, anchorId)}
                    canPaste={!!blockClipboard}
                    pagesMeta={pagesMeta}
                    onMoveToPage={(blockId, dstIdx) =>
                      moveBlockToPage(idx, blockId, dstIdx)
                    }
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
                    onAddBlock={(type, defaults) => addExtraBlock(safeCurrent, type, defaults)}
                    onRemoveBlock={(blockId) =>
                      removeBlockFromPage(safeCurrent, blockId)
                    }
                    onChangeExtraBlockProps={(blockId, newProps) =>
                      setExtraBlockProps(safeCurrent, blockId, newProps)
                    }
                    onChangeSection={(blockId, code) =>
                      setBlockSection(safeCurrent, blockId, code)
                    }
                    onCopyBlock={(blockId) =>
                      copyBlockToClipboard(safeCurrent, blockId)
                    }
                    onCutBlock={(blockId) =>
                      copyBlockToClipboard(safeCurrent, blockId, { cut: true })
                    }
                    onPasteBlock={(anchorId) =>
                      pasteBlockOnPage(safeCurrent, anchorId)
                    }
                    canPaste={!!blockClipboard}
                    pagesMeta={pagesMeta}
                    onMoveToPage={(blockId, dstIdx) =>
                      moveBlockToPage(safeCurrent, blockId, dstIdx)
                    }
                    sectionCategories={sectionCategories}
                    sectionItemByCode={sectionItemByCode}
                    rowGapPx={draft.page_gap_px}
                    reportId={existingReport?.id ?? null}
                    reportPhase={existingReport?.phase}
                  />
                )}

            {/* 연결된 보고서 섹션 — link 가 0건이면 자체적으로 null 렌더라
                기존 레이아웃을 흩뜨리지 않음. 본문 마지막 페이지 아래에 한
                번만 노출 (paginated 든 all 이든 동일). export 에서도 보이게
                두기 — 인쇄/HTML 본에 같이 따라가야 의미 있음. */}
            <ReportLinksSection
              links={linkedReports.links}
              onRemove={linkedReports.removeLink}
              editable={effectiveIsEditing && !!existingReport?.can_edit}
            />
            {/* 편집 모드 전용 하단 여백 — 마지막 위젯 row_span 을 드래그로
                늘릴 때 보고서 컨테이너가 같이 늘어나면서 페이지가 점프하던
                불편함 해소. 50vh 확보해서 마지막 위젯의 핸들을 잡고 화면
                중간 정도까지 끌어내려도 컨테이너가 변하지 않도록.
                인쇄/뷰모드/풀스크린엔 영향 없음. */}
            {effectiveIsEditing && (
              <div className="h-[50vh] print:hidden" aria-hidden="true" />
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

        {/* Floating action cluster — anchored to the report column (not
            the viewport) so the side comment panel can sit beside it
            without overlap. The column already has `position: relative`,
            and the panel is a sibling flex child that pushes the column
            narrower when open; `absolute right-6` therefore tracks the
            panel's left edge automatically. `report-detail-floating` is
            preserved so the DOCX exporter still strips it. */}
        {isEditing && (
          <div className="report-detail-floating absolute bottom-6 right-6 z-40 print:hidden flex flex-col items-end gap-2">
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
            우상단에 작은 종료 핀을 띄운다. ESC로도 빠질 수 있다.
            같은 이유로 보고서 컬럼 기준 절대 위치 — 코멘트 패널과
            우상단에서 겹치지 않게. */}
        {reportFullscreen && (
          <div className="report-detail-floating absolute top-3 right-3 z-50 print:hidden">
            <Button
              variant="secondary"
              size="sm"
              onClick={exitReportFullscreen}
              title="전체화면 종료 (Esc)"
              className="shadow-md"
            >
              <Minimize2 className="mr-1 h-3 w-3" />
              전체화면 종료
            </Button>
          </div>
        )}
      </div>

      {/* Comment side panel — sibling of main column inside the outer
          flex row. Toggle/state lives in CommentsContext so the pin on
          each widget can open it. Hidden until reportId is known (new
          reports + template-edit don't have one). */}
      {/* 공개 열람자(is_public_view)에겐 댓글 패널을 숨긴다 — 백엔드가 댓글을
          빈 목록으로 내려주고 작성도 403 이라, 패널을 띄워봐야 빈 화면이다. */}
      {existingReport?.id && !existingReport?.is_public_view && <CommentPanel />}

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
        title="휴지통으로 이동"
        description="이 보고서를 휴지통으로 보냅니다. 게시된 부서 게시판에는 그대로 남아 있으며, 휴지통에서 복구할 수 있습니다."
        confirmLabel="휴지통으로 이동"
        variant="destructive"
        onConfirm={onDelete}
      />

      <ReportCopyDialog
        open={copyOpen}
        onOpenChange={setCopyOpen}
        sourceTitle={draft?.title ?? ''}
        onConfirm={onCopy}
      />

      <ReportSavePresetDialog
        open={savePresetOpen}
        onOpenChange={setSavePresetOpen}
        sourceTitle={draft?.title ?? ''}
        templateId={draft?.pages?.[0]?.template_id ?? null}
        templateVersion={draft?.pages?.[0]?.template_version ?? null}
        orgOptions={(me?.memberships ?? [])
          .map((m) => m.workspace_slug)
          .filter((s) => s && !s.startsWith('personal-'))
          .map((slug) => ({
            slug,
            name: (workspaces ?? []).find((w) => w.slug === slug)?.name ?? slug,
          }))}
        onConfirm={onSavePreset}
      />

      {existingReport?.id != null && (
        <ReportGraphModal
          open={graphOpen}
          onOpenChange={setGraphOpen}
          reportId={existingReport.id}
          reportTitle={draft?.title ?? existingReport.title}
        />
      )}

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

      {/* "더보기"에서 여는 controlled 표면들 — 폴더 이동 · 활동 이력. */}
      {folderPickMode && existingReport?.id && (
        <FolderPickerDialog
          open={folderPickOpen}
          onOpenChange={setFolderPickOpen}
          reportId={existingReport.id}
          mode={folderPickMode}
          {...(folderPickMode === 'org'
            ? {
                workspaceSlug: slug,
                folderId: currentMount?.folder_id,
                onChanged: (newFolderId) =>
                  setMountByWorkspace((m) => ({
                    ...m,
                    [slug]: { ...m[slug], folder_id: newFolderId },
                  })),
              }
            : {
                folderId: existingReport?.folder_id,
                onChanged: () => reloadReport(),
              })}
        />
      )}
      {existingReport?.id && (
        <ActivityTimelineDialog
          reportId={existingReport.id}
          open={activityOpen}
          onOpenChange={setActivityOpen}
        />
      )}
      {existingReport?.id && (
        <ReportVersionHistoryDialog
          reportId={existingReport.id}
          open={versionsOpen}
          onOpenChange={setVersionsOpen}
          canEdit={existingReport.can_edit !== false}
          onRestored={reloadReport}
        />
      )}
      {/* 공유 — "더보기 > 공유"로 여는 controlled Dialog. ShareEditor 는
          Dialog/Popover 양쪽 재사용용 알맹이. active 가 true 일 때 로드. */}
      {existingReport?.id && !existingReport?.is_public_view && (
        <Dialog open={shareOpen} onOpenChange={setShareOpen}>
          <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>공유</DialogTitle>
              <DialogDescription>
                부서(하위 상속)·사용자·전체 공개 대상과 열람/편집 권한을 설정합니다.
              </DialogDescription>
            </DialogHeader>
            <ShareEditor
              contentType="reports"
              contentId={existingReport.id}
              ownerUserId={existingReport.owner_user_id}
              active={shareOpen}
            />
          </DialogContent>
        </Dialog>
      )}


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
        currentRichTextPrefixes={[
          draft?.page_rich_text_prefix_d0 ?? null,
          draft?.page_rich_text_prefix_d1 ?? null,
          draft?.page_rich_text_prefix_d2 ?? null,
        ]}
        showPropertiesTab
        currentTypeId={draft?.report_type_id ?? null}
        currentType={draft?.report_type ?? null}
        currentEntities={draft?.entities ?? []}
        currentCollab={draft?.collab_workspace_slugs ?? []}
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
        onApplyRichTextPrefixes={(arr) => {
          // arr = [d0, d1, d2], 각 칸은 문자열 또는 null. null/빈문자열은
          // 그 depth 만 backend 컬럼을 NULL 로 리셋한다.
          const safe = Array.isArray(arr) ? arr : [null, null, null]
          setDraft((d) =>
            d
              ? {
                  ...d,
                  page_rich_text_prefix_d0: safe[0] ?? null,
                  page_rich_text_prefix_d1: safe[1] ?? null,
                  page_rich_text_prefix_d2: safe[2] ?? null,
                }
              : d,
          )
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
        onApplyCollab={(slugs) => {
          // 협업 부서 슬러그 배열. PATCH 의 collab_workspace_slugs 로 저장되며,
          // 저장 전에도 draft 에 반영해 배너/다이얼로그가 즉시 갱신되게.
          setDraft((d) => (d ? { ...d, collab_workspace_slugs: slugs } : d))
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

      {/* Export progress overlay — fixed full-screen dim + center card
          with spinner + step label + (when known) bar. Blocks user
          interaction during export which is desirable: clicking around
          while html2canvas captures the DOM yields garbage. Driven by
          per-exporter progress state; hidden when null. Both Word and
          HTML exports share the overlay component, distinguished by
          title. They are mutually exclusive (each setPrinting=true,
          one runs at a time) so we render at most one. */}
      {docxProgress && (
        <ExportOverlay
          title="Word 파일로 저장 중"
          progress={docxProgress}
          onCancel={() => exportAbortRef.current?.abort()}
        />
      )}
      {htmlProgress && (
        <ExportOverlay
          title="HTML 파일로 저장 중"
          progress={htmlProgress}
          onCancel={() => exportAbortRef.current?.abort()}
        />
      )}
    </div>
    </CommentsProvider>
    <ReportMentionDialog />
    {/* `#` 위젯 참조 — 화면 밖/다른 페이지 참조의 흘끗 보기 팝오버 */}
    {refPreview && (
      <BlockRefPreview
        snapshot={refPreview.snapshot}
        label={refPreview.label}
        caption={refPreview.caption}
        pageIndex={refPreview.pageIndex}
        anchorRect={refPreview.anchorRect}
        onJump={jumpFromPreview}
        onClose={() => setRefPreview(null)}
      />
    )}
    {/* 부서 @멘션 — 이동 대신 부서 정보+최근 보고서 미리보기 */}
    {deptPreview && (
      <DeptMentionPreview
        slug={deptPreview.slug}
        dept={workspaces?.find((w) => w.slug === deptPreview.slug) ?? null}
        anchorRect={deptPreview.anchorRect}
        onOpenDept={() => openDeptList(deptPreview.slug)}
        onOpenReport={(rid) => openDeptReport(deptPreview.slug, rid)}
        onClose={() => setDeptPreview(null)}
      />
    )}
    {/* 위젯으로 이동한 뒤 읽던 자리로 돌아오는 알약 */}
    {returnAnchor && (
      <button
        type="button"
        onClick={goBackFromRef}
        className="fixed bottom-6 left-1/2 z-[55] -translate-x-1/2 inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground shadow-lg ring-1 ring-primary/30 hover:bg-primary/90 print:hidden"
        title="참조를 클릭하기 전 위치로 돌아가기"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        읽던 곳으로 돌아가기
      </button>
    )}
    </ReportMentionProvider>
    </ReportStyleContext.Provider>
    </PrintScaleContext.Provider>
  )
}

/** Centered, blocking spinner shown during a long-running export
 *  (Word, HTML — anything that holds the page for >1s). Reads the
 *  progress feed from the exporter`s `onProgress` so the user sees
 *  e.g. "위젯 변환 중 (N/M)" tick instead of staring at a frozen page.
 *  `title` differentiates the export type at a glance. The progress
 *  bar shows whenever `total > 0` — phase string is only used to drive
 *  the label (exporter`s choice). */
function ExportOverlay({ title, progress, onCancel }) {
  const total = Number.isFinite(progress?.total) ? progress.total : 0
  const current = Number.isFinite(progress?.current) ? progress.current : 0
  const pct = total > 0 ? Math.round((current / total) * 100) : null
  return (
    <div
      // html2canvas captures the page within the overlay`s bounding
      // box and would otherwise bake "페이지 썸네일 생성 중 N/M" into
      // every thumbnail. The export script passes ignoreElements to
      // html2canvas matching this attribute to skip the overlay.
      data-export-overlay
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 backdrop-blur-sm"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="rounded-lg border bg-card shadow-xl px-6 py-5 min-w-[280px] max-w-sm">
        <div className="flex items-center gap-3 mb-2">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
          <div className="font-semibold text-sm">{title}</div>
        </div>
        <div className="text-xs text-muted-foreground mb-2">
          {progress?.label ?? '진행 중...'}
        </div>
        {pct != null && (
          <>
            <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-200"
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="mt-1.5 text-[11px] text-muted-foreground tabular-nums">
              {current}/{total} ({pct}%)
            </div>
          </>
        )}
        {/* 취소 버튼 — 클릭 시 AbortController.abort() 호출. exporter 의
            checkpoint 에서 AbortError 가 던져지고 핸들러가 토스트로
            "취소되었습니다" 안내. 다음 체크포인트 도달까지의 지연만 있고
            (대개 < 1 widget 캡처) 즉시 멈춤. */}
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="mt-4 w-full rounded-md border border-border bg-background text-xs text-muted-foreground hover:bg-muted hover:text-foreground py-1.5 transition-colors"
          >
            취소
          </button>
        )}
      </div>
    </div>
  )
}

/** Asks the user for the new title + 내 공간의 폴더 before kicking off a copy.
 *  Pre-fills '{원본} 사본' so the common case is one Enter; trims and rejects empty.
 *  폴더는 listFolders() (workspaceSlug 없음 → 본인 personal) 로 lazy-load. 미분류
 *  (folder_id=null) 가 기본값. onConfirm(title, folderId) 시그니처. */
function ReportCopyDialog({ open, onOpenChange, sourceTitle, onConfirm }) {
  const [title, setTitle] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [folderId, setFolderId] = useState(null) // null = 미분류
  const [folders, setFolders] = useState(null) // null = 로딩 중
  const [mode, setMode] = useState('full') // 'full' | 'content' | 'summary'

  useEffect(() => {
    if (open) {
      const base = (sourceTitle ?? '').trim()
      setTitle(base ? `${base} 사본` : '')
      setSubmitting(false)
      setFolderId(null)
      setFolders(null)
      setMode('full')
      let cancelled = false
      listFolders()
        .then(({ items }) => {
          if (!cancelled) setFolders(items)
        })
        .catch(() => {
          if (!cancelled) setFolders([])
        })
      return () => {
        cancelled = true
      }
    }
  }, [open, sourceTitle])

  // 폴더 트리를 flat (folder, depth) 로 펼침 — FolderSidebar / BulkMovePopover
  // 가 쓰는 동일 패턴. 자식 폴더는 부모 바로 아래에 depth+1 로 들여쓰기.
  const flatFolders = useMemo(() => {
    if (!folders) return []
    const byParent = new Map()
    for (const f of folders) {
      const key = f.parent_id ?? null
      if (!byParent.has(key)) byParent.set(key, [])
      byParent.get(key).push(f)
    }
    const out = []
    function walk(parentKey, depth) {
      for (const f of byParent.get(parentKey) ?? []) {
        out.push({ folder: f, depth })
        walk(f.id, depth + 1)
      }
    }
    walk(null, 0)
    return out
  }, [folders])

  async function handleSubmit(e) {
    e.preventDefault()
    const trimmed = title.trim()
    if (!trimmed) return
    setSubmitting(true)
    try {
      await onConfirm(trimmed, folderId, mode)
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
              작성인은 현재 사용자, 작성일·보고 기준일은 오늘로 설정됩니다.
              게시·댓글·이력은 복사되지 않습니다.
            </p>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">복사 범위</label>
            <div className="grid gap-1.5">
              {[
                {
                  value: 'full',
                  title: '메타데이터 포함 전체 복사',
                  desc: '본문 + 태그·종류·엔티티·연결된 보고서까지 함께',
                },
                {
                  value: 'content',
                  title: '메인 내용만 복사',
                  desc: '본문·레이아웃·표시 설정만 (부가 정보 제외)',
                },
                {
                  value: 'summary',
                  title: '요약본 만들기',
                  desc: '본문만 가져오고, 원본과 "요약 ↔ 원본"으로 연결',
                },
              ].map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setMode(opt.value)}
                  className={
                    'flex items-start gap-2 rounded-md border px-3 py-2 text-left transition-colors ' +
                    (mode === opt.value
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:bg-muted/50')
                  }
                >
                  <span
                    className={
                      'mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full border ' +
                      (mode === opt.value
                        ? 'border-primary bg-primary'
                        : 'border-muted-foreground/40')
                    }
                    aria-hidden
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{opt.title}</span>
                    <span className="block text-[11px] text-muted-foreground">
                      {opt.desc}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              복사 위치 (내 공간)
            </label>
            {folders === null ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                폴더 목록 불러오는 중...
              </div>
            ) : (
              <div className="max-h-48 overflow-y-auto rounded-md border space-y-0.5 p-1">
                <button
                  type="button"
                  onClick={() => setFolderId(null)}
                  className={
                    'flex w-full items-center gap-1.5 rounded px-2 py-1 text-sm text-left transition-colors ' +
                    (folderId === null
                      ? 'bg-primary/10 text-primary font-medium'
                      : 'hover:bg-muted')
                  }
                >
                  <Inbox className="h-3.5 w-3.5 shrink-0" />
                  <span className="flex-1 truncate">미분류</span>
                </button>
                {flatFolders.length > 0 && <div className="h-px bg-border my-1" />}
                {flatFolders.map(({ folder, depth }) => (
                  <button
                    key={folder.id}
                    type="button"
                    onClick={() => setFolderId(folder.id)}
                    className={
                      'flex w-full items-center gap-1.5 rounded px-2 py-1 text-sm text-left transition-colors ' +
                      (folderId === folder.id
                        ? 'bg-primary/10 text-primary font-medium'
                        : 'hover:bg-muted')
                    }
                    style={{ paddingLeft: 8 + depth * 12 }}
                    title={folder.name}
                  >
                    <Folder className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="flex-1 truncate">{folder.name}</span>
                  </button>
                ))}
                {flatFolders.length === 0 && (
                  <p className="px-2 py-2 text-[11px] text-muted-foreground italic">
                    등록된 폴더가 없습니다 — 미분류로 들어갑니다.
                  </p>
                )}
              </div>
            )}
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

/** "프리셋으로 저장" — 현재 보고서를 채워진 프리셋(프리셋)으로 스냅샷.
 *  이름 + 설명 + 공개 범위(전사 / 내 조직 1곳)만 받는다. 본문·태그·종류·
 *  엔티티·표시설정은 서버가 source_report_id 로 스냅샷한다. */
function ReportSavePresetDialog({
  open,
  onOpenChange,
  sourceTitle,
  templateId,
  templateVersion,
  orgOptions,
  onConfirm,
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [scope, setScope] = useState('') // '' = 전사, 그 외 = workspace slug
  const [submitting, setSubmitting] = useState(false)
  const [templateName, setTemplateName] = useState('')

  useEffect(() => {
    if (open) {
      const base = (sourceTitle ?? '').trim()
      setName(base ? `${base} 프리셋` : '')
      setDescription('')
      setScope('')
      setSubmitting(false)
    }
  }, [open, sourceTitle])

  // 이 프리셋이 묶일 템플릿명을 가져와 바인딩을 사용자에게 보여준다. 프리셋은
  // 원본 보고서의 (page0) 템플릿 버전에 묶이고, 새 보고서 작성 시 그 템플릿
  // 아래에서 보인다.
  useEffect(() => {
    if (!open || !templateId || !templateVersion) {
      setTemplateName('')
      return undefined
    }
    let cancelled = false
    getTemplateVersion(templateId, templateVersion)
      .then((t) => {
        if (!cancelled) setTemplateName(t?.name ?? '')
      })
      .catch(() => {
        if (!cancelled) setTemplateName('')
      })
    return () => {
      cancelled = true
    }
  }, [open, templateId, templateVersion])

  async function handleSubmit(e) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    setSubmitting(true)
    try {
      // 전사 = null, 특정 조직 = [slug]
      await onConfirm(trimmed, description.trim(), scope ? [scope] : null)
    } catch {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>프리셋으로 저장</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="preset-name" className="text-sm font-medium">
              프리셋 이름
            </label>
            <Input
              id="preset-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="예: 영업팀 주간보고 프리셋"
              autoFocus
              required
            />
            <p className="text-[11px] text-muted-foreground">
              현재 보고서의 본문·태그·종류·엔티티·표시 설정이 그대로 프리셋에
              담깁니다. 새 보고서를 이 프리셋으로 시작할 수 있습니다.
            </p>
          </div>
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
            이 프리셋은{' '}
            <span className="font-medium text-foreground">
              {templateName || templateId || '현재'}
            </span>
            {templateVersion ? ` (v${templateVersion})` : ''} 템플릿에 묶입니다 —
            같은 템플릿으로 새 보고서를 만들 때 이 프리셋이 보입니다.
          </div>
          <div className="space-y-1.5">
            <label htmlFor="preset-desc" className="text-sm font-medium">
              설명 (선택)
            </label>
            <Textarea
              id="preset-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="이 프리셋을 언제 쓰는지 간단히"
              rows={2}
              className="resize-none text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="preset-scope" className="text-sm font-medium">
              공개 범위
            </label>
            <select
              id="preset-scope"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
            >
              <option value="">전사 공개 (모든 조직)</option>
              {(orgOptions ?? []).map((o) => (
                <option key={o.slug} value={o.slug}>
                  {o.name}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-muted-foreground">
              특정 조직을 고르면 그 조직 트리에서만 이 프리셋이 보입니다.
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
            <Button type="submit" disabled={submitting || !name.trim()}>
              {submitting ? '저장 중...' : '프리셋으로 저장'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}


/** Rough token estimator for the AI-prompt size badge. Conservative —
 *  errs on the side of *over*-counting so users don't get blindsided by
 *  a real-AI tokenizer being stricter than we predicted. Heuristic:
 *    - Hangul (가-힣 etc.) : ~1 token per character. Modern BPE
 *      tokenizers (cl100k for GPT-4, Claude's tokenizer) usually split
 *      Korean syllables into 1-2 tokens; 1.0 is the safer floor.
 *    - Everything else (ASCII, JSON punctuation, code) : ~4 chars per
 *      token. Matches the well-known "4 chars per token" rule of thumb
 *      for English-ish prose.
 *
 *  Not a real tokenizer — the AI you paste into will report exact
 *  counts. This is just a fast in-dialog signal so users can decide
 *  whether to trim widgets before pasting. */
function estimatePromptTokens(text) {
  if (!text) return 0
  let hangul = 0
  let other = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    // U+AC00–U+D7A3 = Hangul syllables (가–힣)
    // U+1100–U+11FF = Hangul jamo
    // U+3130–U+318F = Hangul compatibility jamo
    if (
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0x1100 && code <= 0x11ff) ||
      (code >= 0x3130 && code <= 0x318f)
    ) {
      hangul++
    } else {
      other++
    }
  }
  return Math.round(hangul + other / 4)
}

/** Classify a token estimate into a tier with a user-facing label,
 *  icon, color class, and detail explanation. Thresholds reflect the
 *  practical AI input limits authors will hit in 2026 when pasting
 *  into a chat UI:
 *
 *    < 16k   safe : 거의 모든 모델 (GPT-3.5 16k, Claude Haiku, Gemini Flash 포함)
 *    < 32k   ok   : 무료 ChatGPT 기준 위험 임계 접근 — 단순 호출은 OK
 *    < 128k  warn : GPT-4o(128k) / Claude Sonnet(200k) / Gemini 같은 큰 모델 필요
 *    < 200k  large: Claude(200k) / Gemini(1M) 권장
 *    >=200k  huge : Gemini long-context 만 안전, 다른 대부분 잘림
 *
 *  Anchored on input-window limits (not output) because the user pastes
 *  the prompt — output budget is a separate concern surfaced as the
 *  "AI 가 응답이 잘렸다" symptom. */
function classifyTokenTier(tokens) {
  if (tokens < 16000) {
    return {
      tier: 'safe',
      icon: '🟢',
      label: '안전',
      color: 'text-emerald-600',
      detail: '거의 모든 AI 모델에서 동작합니다 (GPT-3.5 16k 포함).',
    }
  }
  if (tokens < 32000) {
    return {
      tier: 'ok',
      icon: '🟢',
      label: '일반',
      color: 'text-emerald-600',
      detail: '일반적인 무료 AI 에서 안전합니다 (GPT-4o-mini · Claude Sonnet · Gemini 등).',
    }
  }
  if (tokens < 128000) {
    return {
      tier: 'warn',
      icon: '🟡',
      label: '주의 — 일부 무료 AI 한계',
      color: 'text-amber-600',
      detail:
        '구형 무료 AI (GPT-3.5 16k · 일부 챗봇) 에서는 입력이 잘릴 수 있습니다. GPT-4o (128k) · Claude Sonnet (200k) · Gemini 권장.',
    }
  }
  if (tokens < 200000) {
    return {
      tier: 'large',
      icon: '🟠',
      label: '큰 모델 필요',
      color: 'text-orange-600',
      detail:
        '128k 이상 context 가 필요합니다. Claude Sonnet (200k) · Gemini 만 안전, GPT-4o (128k) 도 한계 접근.',
    }
  }
  return {
    tier: 'huge',
    icon: '🔴',
    label: '거의 모든 AI 초과',
    color: 'text-red-600',
    detail:
      '200k 초과 — Gemini 1M+ 같은 초장-context 모델만 처리 가능. 위젯을 줄이거나 페이지를 나누어 작성하세요.',
  }
}

/** Compact thousands/millions formatter for the token badge — keeps
 *  the dialog footer scannable instead of showing 6-digit raw counts. */
function formatTokenCount(n) {
  if (n < 1000) return String(n)
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`
  if (n < 1000000) return `${Math.round(n / 1000)}k`
  return `${(n / 1000000).toFixed(1)}M`
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
  const tokenEstimate = useMemo(() => estimatePromptTokens(text), [text])
  const tokenTier = classifyTokenTier(tokenEstimate)

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
        <div className="flex flex-col gap-1 pt-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] text-muted-foreground">
              {charCount.toLocaleString()} 자 · {charCountKb} KB · ~
              {formatTokenCount(tokenEstimate)} 토큰 (추정)
            </span>
            <span
              className={`text-[11px] font-medium ${tokenTier.color}`}
              title={tokenTier.detail}
            >
              {tokenTier.icon} {tokenTier.label}
            </span>
            {interactive && excludedTypes.size > 0 && (
              <span className="text-[11px] text-amber-600">
                ({excludedTypes.size}개 위젯 제외 중)
              </span>
            )}
            <div className="flex-1" />
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              닫기
            </Button>
            <Button size="sm" onClick={handleCopy} disabled={!text}>
              <Copy className="mr-1 h-3 w-3" />
              복사
            </Button>
          </div>
          {tokenTier.tier !== 'safe' && tokenTier.tier !== 'ok' && (
            <p
              className={`text-[10px] leading-relaxed ${tokenTier.color}`}
            >
              ↳ {tokenTier.detail}
              {interactive && (
                <>
                  {' '}
                  <span className="text-muted-foreground">
                    (왼쪽 사이드바에서 위젯을 체크 해제해 줄일 수 있습니다.)
                  </span>
                </>
              )}
            </p>
          )}
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
          체크 해제는 <code>&#123;&#123;widget_catalog&#125;&#125;</code>,
          {' '}<code>&#123;&#123;widget_examples&#125;&#125;</code>,
          {' '}<code>&#123;&#123;template_blocks&#125;&#125;</code> 토큰에 적용 — 해제한 타입의 페이지 블록도 목록에서 빠집니다.
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
 * Axis catalog cache — the entity-type list (모델명/부품명/시험 ...) is small
 * and stable, so we fetch it once per session and share it across every
 * report's 관련 정보 panel rather than re-hitting the API on each detail open.
 * On failure we clear the promise so the next mount can retry; the panel
 * falls back to showing raw type_slug labels until the catalog loads.
 */
let _entityTypesPromise = null
function loadEntityTypesCached() {
  if (!_entityTypesPromise) {
    _entityTypesPromise = listEntityTypes()
      .then((res) => res?.items ?? [])
      .catch((e) => {
        _entityTypesPromise = null
        throw e
      })
  }
  return _entityTypesPromise
}

/**
 * 헤더의 "관련 정보" 접이식 패널 — 보고서에 태깅된 엔티티(모델명·부품명·
 * 시험 ...)를 축별로 묶어 한눈에 보여준다. 보기·편집 모드 모두 노출되어,
 * 종류 칩 팝오버를 열지 않고도 "이게 어떤 모델에 적용된 보고서인지" 바로
 * 확인할 수 있다. 실제 태그 추가·삭제는 편집모드 칩(ReportMetaChips)에서
 * 하고, 이 패널은 읽기 전용 요약이다. 태그가 없으면 렌더하지 않는다.
 */
function ReportEntitiesPanel({ entities, collabSlugs }) {
  const [open, setOpen] = useState(false)
  const [types, setTypes] = useState(null) // 축 catalog (label·순서) — null=미로딩
  const { all: workspaces } = useWorkspace()

  useEffect(() => {
    let cancelled = false
    loadEntityTypesCached()
      .then((items) => {
        if (!cancelled) setTypes(items)
      })
      .catch(() => {
        if (!cancelled) setTypes([]) // 실패 시 slug fallback — 패널은 계속 동작
      })
    return () => {
      cancelled = true
    }
  }, [])

  const list = Array.isArray(entities) ? entities : []
  // 축별 그룹 — catalog 순서를 따르고, catalog 에 없는 slug 는 뒤에 붙인다.
  const groups = useMemo(() => {
    const bySlug = new Map()
    for (const e of list) {
      const slug = e?.type_slug ?? ''
      if (!bySlug.has(slug)) bySlug.set(slug, [])
      bySlug.get(slug).push(e)
    }
    const labelFor = new Map((types ?? []).map((t) => [t.slug, t.label]))
    const orderOf = new Map((types ?? []).map((t, i) => [t.slug, i]))
    return [...bySlug.entries()]
      .map(([slug, items]) => ({
        slug,
        label: labelFor.get(slug) ?? slug ?? '기타',
        items,
        ord: orderOf.has(slug) ? orderOf.get(slug) : Number.MAX_SAFE_INTEGER,
      }))
      .sort((a, b) => a.ord - b.ord)
  }, [list, types])

  // 협업 부서 — 슬러그를 워크스페이스 이름/색으로 해석. 기준정보(엔티티)와
  // 달리 부서 트리(workspaces)에서 직접 온다. 미해석 슬러그는 슬러그 그대로.
  const collabDepts = useMemo(() => {
    const slugs = Array.isArray(collabSlugs) ? collabSlugs : []
    if (slugs.length === 0) return []
    const bySlug = new Map((workspaces ?? []).map((w) => [w.slug, w]))
    return slugs.map((s) => {
      const w = bySlug.get(s)
      return { slug: s, name: w?.name ?? s, color: w?.color ?? null }
    })
  }, [collabSlugs, workspaces])

  if (list.length === 0 && collabDepts.length === 0) return null

  // 본문 상단 고정 배너 — 헤더와 페이지 사이 한 줄. 닫혀 있을 땐 축별
  // 값을 인라인 요약("모델명 SM6·QM6 | 부품명 브레이크패드")으로 항상
  // 보여줘 클릭 없이도 어떤 모델·부품에 대한 보고서인지 바로 확인된다.
  // 클릭하면 값이 많아 한 줄에 안 들어갈 때를 위해 축별 표로 펼친다.
  // 화면 전용(인쇄·내보내기 제외) — 본문 콘텐츠가 아니라 탐색용 UI다.
  return (
    <div
      data-export-exclude
      className="border-b bg-muted/20 px-6 py-1.5 text-xs print:hidden"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-1.5 text-left"
        title="이 보고서에 태깅된 모델·부품·시험 등 관련 정보 — 클릭하면 펼치기"
      >
        {open ? (
          <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-60" />
        ) : (
          <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-60" />
        )}
        <span className="inline-flex shrink-0 items-center gap-1 font-medium text-muted-foreground">
          <Info className="h-3 w-3" />
          관련 정보
        </span>
        {!open && (
          <span className="flex min-w-0 flex-1 flex-wrap gap-x-3 gap-y-0.5">
            {groups.map((g) => (
              <span key={g.slug || '기타'} className="inline-flex gap-1">
                <span className="text-muted-foreground">{g.label}</span>
                <span className="text-foreground/80">
                  {g.items.map((e) => e.value).join(' · ')}
                </span>
              </span>
            ))}
            {collabDepts.length > 0 && (
              <span className="inline-flex gap-1">
                <span className="text-muted-foreground">협업 부서</span>
                <span className="text-foreground/80">
                  {collabDepts.map((d) => d.name).join(' · ')}
                </span>
              </span>
            )}
          </span>
        )}
      </button>
      {open && (
        <dl className="ml-5 mt-1.5 flex flex-col gap-1.5">
          {groups.map((g) => (
            <div key={g.slug || '기타'} className="flex items-start gap-3">
              <dt className="w-20 shrink-0 pt-0.5 text-muted-foreground">
                {g.label}
              </dt>
              <dd className="flex min-w-0 flex-1 flex-wrap gap-1">
                {g.items.map((e) => (
                  <span
                    key={e.id}
                    className={cn(
                      'inline-flex items-center rounded-full border px-2 py-0.5',
                      e.status === 'inactive'
                        ? 'border-dashed text-muted-foreground'
                        : 'bg-background text-foreground/80',
                    )}
                    title={
                      e.status === 'inactive'
                        ? '비활성화된 값이지만 이 보고서에 태깅되어 있음'
                        : undefined
                    }
                  >
                    {e.value}
                  </span>
                ))}
              </dd>
            </div>
          ))}
          {collabDepts.length > 0 && (
            <div className="flex items-start gap-3">
              <dt className="w-20 shrink-0 pt-0.5 text-muted-foreground">
                협업 부서
              </dt>
              <dd className="flex min-w-0 flex-1 flex-wrap gap-1">
                {collabDepts.map((d) => (
                  <span
                    key={d.slug}
                    className="inline-flex items-center rounded-full border px-2 py-0.5"
                    style={
                      d.color
                        ? {
                            backgroundColor: `${d.color}22`,
                            color: d.color,
                            borderColor: `${d.color}55`,
                          }
                        : undefined
                    }
                  >
                    {d.name}
                  </span>
                ))}
              </dd>
            </div>
          )}
        </dl>
      )}
    </div>
  )
}

/**
 * 좌측 보조 사이드바 — 같은 폴더의 보고서 목록을 세로로 보여준다(상단 툴바의
 * 폴더 버튼으로 토글). 현재 워크스페이스/폴더의 보고서 목록을 listReports 로
 * 한 번 받아 목록 화면과 같은 정렬(번호 내림차순)로 나열하고, 현재 보고서를
 * 강조한다. 클릭하면 그 보고서로 이동. 자체 데이터 로딩(useAsync)을 품어
 * 부모(거대한 ReportDetailPage)의 hook 순서에 영향을 주지 않는다.
 * (예전 헤더의 FolderSiblingNav = 이전/다음 + 팝오버를 대체.)
 */
function FolderReportsPanel({ slug, folderId, currentReportId, onClose }) {
  const navigate = useNavigate()
  const { data: siblings } = useAsync(
    () =>
      slug && folderId !== undefined
        ? listReports({ folderId })
        : Promise.resolve([]),
    [slug, folderId],
  )
  // 목록 페이지 기본 정렬(DataTable defaultSort = 번호 내림차순)과 동일하게.
  const list = useMemo(() => {
    const arr = Array.isArray(siblings) ? [...siblings] : []
    arr.sort((a, b) => (b.id ?? 0) - (a.id ?? 0))
    return arr
  }, [siblings])

  return (
    <aside className="hidden md:flex w-60 shrink-0 flex-col border-r bg-card">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate text-sm font-medium">같은 폴더 보고서</span>
        <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">
          {list.length}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0"
          onClick={onClose}
          title="목록 닫기"
        >
          <X className="h-3.5 w-3.5" />
          <span className="sr-only">목록 닫기</span>
        </Button>
      </div>
      <ScrollArea className="flex-1">
        <ul className="flex flex-col p-1">
          {list.length === 0 ? (
            <li className="px-2 py-3 text-xs text-muted-foreground">
              이 폴더에 보고서가 없습니다.
            </li>
          ) : (
            list.map((r, i) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => navigate(`/w/${slug}/reports/${r.id}`)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted',
                    r.id === currentReportId &&
                      'bg-muted font-semibold text-foreground',
                  )}
                  title={r.title || '(제목 없음)'}
                >
                  <span className="w-5 shrink-0 tabular-nums text-muted-foreground">
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {r.title || '(제목 없음)'}
                  </span>
                  {r.report_date && (
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {r.report_date}
                    </span>
                  )}
                </button>
              </li>
            ))
          )}
        </ul>
      </ScrollArea>
    </aside>
  )
}

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
// 제목 아래 상태 뱃지. 옛 상단 상태 리본을 대체 — 뱃지를 클릭하면 그 단계의
// 설명이 팝오버로 뜬다(hover 로는 title 힌트도 제공).
function PhaseChip({ phase }) {
  const meta = PHASE_META[phase] ?? PHASE_META.drafting
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="상태 설명 보기"
          className="inline-flex cursor-pointer rounded-full focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Badge variant={meta.variant}>{meta.label}</Badge>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-3">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          {meta.emoji && <span>{meta.emoji}</span>}
          <span>{meta.label}</span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{meta.description}</p>
      </PopoverContent>
    </Popover>
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
    emoji: '✏️',
    description:
      '아직 외부 리뷰가 시작되지 않은 상태입니다. 자유롭게 편집할 수 있습니다.',
  },
  reviewing: {
    label: '리뷰 중',
    variant: 'default',
    emoji: '👀',
    description:
      '외부 코멘트가 달렸거나 조직 게시판에 게시된 상태입니다. 코멘트 패널을 우측에 펼쳐 의견을 확인하세요. 편집은 여전히 가능합니다.',
  },
  finalized: {
    label: '발행됨',
    variant: 'outline',
    emoji: '✅',
    description:
      "작성자가 발행을 완료한 보고서입니다. 편집은 차단되며, 수정하려면 '발행 취소' 후 작성 모드로 돌아가세요.",
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

/** draft.page_rich_text_prefix_dN 값을 backend 로 보낼 형태로 정규화.
 *  string non-empty → trim, 그 외 → null. backend 는 null 로 받으면 그
 *  depth 컬럼만 NULL 리셋 → 프런트가 기본 글리프로 폴백. */
function normalizeRichTextPrefix(v) {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t === '' ? null : t
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
  onReorder,
  isEditing,
  viewMode,
}) {
  // 페이지 순서 드래그&드롭 — dragIdx: 끌고 있는 chip, dragOverIdx: 드롭
  // 대상 chip. 편집 모드에서만 동작. 드롭 시 onReorder(dragIdx, dragOverIdx).
  const [dragIdx, setDragIdx] = useState(null)
  const [dragOverIdx, setDragOverIdx] = useState(null)
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
              className={cn(
                'shrink-0 group relative',
                isEditing && !isRenaming && 'cursor-grab active:cursor-grabbing',
                dragIdx === idx && 'opacity-40',
              )}
              ref={isActive ? activeChipRef : undefined}
              draggable={isEditing && !isRenaming}
              onDragStart={
                isEditing && !isRenaming
                  ? (e) => {
                      setDragIdx(idx)
                      e.dataTransfer.effectAllowed = 'move'
                      e.dataTransfer.setData('text/plain', String(idx))
                    }
                  : undefined
              }
              onDragOver={
                isEditing && dragIdx !== null
                  ? (e) => {
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                      if (dragOverIdx !== idx) setDragOverIdx(idx)
                    }
                  : undefined
              }
              onDrop={
                isEditing && dragIdx !== null
                  ? (e) => {
                      e.preventDefault()
                      if (dragIdx !== idx) onReorder?.(dragIdx, idx)
                      setDragIdx(null)
                      setDragOverIdx(null)
                    }
                  : undefined
              }
              onDragEnd={() => {
                setDragIdx(null)
                setDragOverIdx(null)
              }}
            >
              {/* 드롭 위치 표시 — 끌고 있는 chip 이 다른 chip 위로 오면 그 chip
                  왼쪽에 세로선(여기에 끼워짐). */}
              {isEditing &&
                dragIdx !== null &&
                dragOverIdx === idx &&
                dragIdx !== idx && (
                  <div className="absolute -left-1.5 top-0 bottom-0 z-10 w-0.5 rounded bg-primary" />
                )}
              <button
                type="button"
                onClick={(e) => handleChipClick(e, idx)}
                onKeyDown={(e) => handleChipKeyDown(e, idx)}
                data-page-chip-idx={idx}
                title="드래그: 순서 변경 · 클릭: 이동 · Ctrl/Shift+클릭: 다중 선택 · Ctrl+C/V: 복사·붙여넣기 · F2: 이름 변경"
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
        {/* 맨 끝 드롭존 — 마지막 chip 과 "페이지 추가" 사이. 여기에 놓으면
            끌던 페이지를 맨 뒤로 보낸다("대상 chip 앞 삽입" 규칙으론 닿을 수
            없는 위치). 드래그 중에만 나타나 평소엔 자리를 거의 안 먹는다. */}
        {isEditing && dragIdx !== null && (
          <div
            onDragOver={(e) => {
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              if (dragOverIdx !== pages.length) setDragOverIdx(pages.length)
            }}
            onDrop={(e) => {
              e.preventDefault()
              onReorder?.(dragIdx, pages.length)
              setDragIdx(null)
              setDragOverIdx(null)
            }}
            className={cn(
              'shrink-0 self-stretch relative rounded transition-all',
              dragOverIdx === pages.length ? 'w-7 bg-primary/10' : 'w-3',
            )}
            title="맨 뒤로 보내기"
          >
            {dragOverIdx === pages.length && (
              <div className="absolute left-0 top-0 bottom-0 w-0.5 rounded bg-primary" />
            )}
          </div>
        )}
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
          data-page-strip-toggle
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
          <span data-page-strip-toggle-label>
            {expanded ? '접기' : '펼치기'}
          </span>
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
// --- 보고서 메타 (보고서 종류 + 관련 정보) 칩 / banner ---------------- //
//
// 사용자가 「⚙ 설정 → 속성 탭 → 스크롤」 3-hop 깊이까지 들어가야 만지던
// 「보고서 종류」 와 「관련 정보」 두 필드를, 보고서 화면 상단의 phase
// banner 영역 우측 (또는 전용 amber banner) 에 chip 으로 노출해 1-클릭
// 발견성을 확보한다.
//
//   - 둘 다 채워져 있고 phase banner 가 없으면 → 아무것도 안 보임 (편집
//     완료된 보고서는 노이즈 0)
//   - 비어있고 phase banner 가 있으면      → 그 banner 의 우측에 amber
//     CTA chip 으로 얹힘
//   - 비어있고 phase banner 가 없으면      → 그 자리에 「📋 보고서
//     메타데이터」 전용 amber banner 한 줄
//
// chip 클릭 → 작은 Popover 가 떠서 기존 ReportTypePicker /
// EntityTagsSection 컴포넌트를 그대로 사용 — 「⚙ 설정」 경로의 정식
// editor 와 동일한 UI 라 학습 비용 0.

/** Phase banner 우측에 얹히는 메타 등록 chip 2개. 편집모드일 때만 노출.
 *
 *  두 chip 모두 항상 표시 — 뷰 모드에선 어차피 안 보이고, 편집모드에서
 *  채워진 값도 클릭 한 번으로 변경/추가/제거할 수 있어야 하므로 사라지면
 *  접근성이 떨어짐. fill 상태에 따라 톤만 바꿈:
 *    - 비어있음 → amber CTA "+ 보고서 종류" / "+ 관련 정보"
 *    - 등록됨 → muted "🏷 {종류명}" / "🏷 관련 정보 N건"
 *
 *  tone prop 은 amber CTA 상태일 때만 호스트 banner 색에 매칭. muted
 *  상태는 호스트와 무관한 중립 톤. */
function ReportMetaChips({
  draft,
  setDraft,
  isEditing,
  tone = 'amber',
  // 페이지에서 lift 한 link 상태. 새 보고서 작성 단계 (reportId 없음) 면
  // linkedReports.links 는 빈 배열이고 칩은 그냥 "0건" 표시 + 추가는 저장
  // 후로 미뤄짐 (백엔드가 reportId 를 모르므로 폼 비활성).
  reportId,
  linkedReports,
  canEdit,
}) {
  if (!isEditing || !draft) return null
  const hasType = !!draft.report_type_id
  const hasEntities =
    Array.isArray(draft.entities) && draft.entities.length > 0
  const hasCollab =
    Array.isArray(draft.collab_workspace_slugs) &&
    draft.collab_workspace_slugs.length > 0
  // "관련 정보" 칩은 엔티티 + 협업 부서를 합쳐 표시(둘 다 이 모달에서 등록).
  const hasRelated = hasEntities || hasCollab
  const relatedCount =
    (draft.entities?.length ?? 0) + (draft.collab_workspace_slugs?.length ?? 0)
  const ctaTones = {
    amber: 'border-amber-400 bg-amber-100/70 text-amber-900 hover:bg-amber-200/70',
    blue:  'border-blue-400  bg-blue-100/70  text-blue-900  hover:bg-blue-200/70',
    red:   'border-red-400   bg-red-100/70   text-red-900   hover:bg-red-200/70',
  }
  const ctaCls = ctaTones[tone] || ctaTones.amber
  const mutedCls =
    'border-border bg-background/80 text-foreground/80 hover:bg-muted'
  const typeName = draft.report_type?.name ?? '보고서 종류'
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors',
              hasType ? mutedCls : ctaCls,
            )}
            title={hasType ? '보고서 종류 변경' : '이 보고서의 종류를 등록'}
          >
            {hasType ? (
              <Tag className="h-3 w-3" />
            ) : (
              <Plus className="h-3 w-3" />
            )}
            <span className="max-w-[140px] truncate">
              {hasType ? typeName : '보고서 종류'}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[420px] p-3" align="end">
          <ReportTypePicker
            value={draft.report_type_id}
            currentType={draft.report_type}
            onChange={(t) => {
              if (t) {
                setDraft((d) =>
                  d ? { ...d, report_type_id: t.id, report_type: t } : d,
                )
              } else {
                setDraft((d) =>
                  d ? { ...d, report_type_id: null, report_type: null } : d,
                )
              }
            }}
          />
        </PopoverContent>
      </Popover>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors',
              hasRelated ? mutedCls : ctaCls,
            )}
            title={
              hasRelated
                ? '관련 정보 추가/편집 (협업 부서 포함)'
                : '모델·부품·시험·협업 부서 등 관련 정보'
            }
          >
            {hasRelated ? (
              <Tag className="h-3 w-3" />
            ) : (
              <Plus className="h-3 w-3" />
            )}
            {hasRelated ? `관련 정보 ${relatedCount}건` : '관련 정보'}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[480px] p-3" align="end">
          <div className="space-y-3">
            <EntityTagsSection
              entities={draft.entities ?? []}
              onChange={(entities) =>
                setDraft((d) => (d ? { ...d, entities } : d))
              }
            />
            {/* 협업 부서 — 기준정보(엔티티)와 달리 부서 트리에서 직접 선택.
                "관련 정보" 안에 같이 둬서 한곳에서 등록되게 한다. */}
            <div className="border-t pt-2">
              <div className="mb-1.5 text-[11px] font-semibold text-muted-foreground">
                협업 부서
              </div>
              <CollabDeptSection
                value={draft.collab_workspace_slugs ?? []}
                onChange={(slugs) =>
                  setDraft((d) =>
                    d ? { ...d, collab_workspace_slugs: slugs } : d,
                  )
                }
              />
            </div>
          </div>
        </PopoverContent>
      </Popover>
      {/* 연결된 보고서 — 저장된 보고서 (reportId 있음) 일 때만 의미가 있다.
          새 보고서 작성 중엔 link 를 걸 수 없으므로 칩 자체를 숨김. */}
      {reportId != null && linkedReports && (
        <LinkedReportsChip
          reportId={reportId}
          links={linkedReports.links}
          loading={linkedReports.loading}
          onAdd={linkedReports.addLink}
          onRemove={linkedReports.removeLink}
          editable={!!canEdit}
          tone={tone}
        />
      )}
    </div>
  )
}

/** 메타 chip(보고서 종류·관련정보·연결된 보고서)을 헤더 아래 같은 위치에
 *  호스팅하는 전용 row. 편집모드에서 항상 유지된다(phase 무관). 톤만 fill
 *  상태에 따라 토글:
 *    - 둘 중 하나라도 비어있음 → amber (등록 prompt)
 *    - 둘 다 등록 완료 → muted (chip 은 여전히 클릭 가능, 시각 부담 ↓)
 *
 *  잠금(author_lock) banner 만 자체 우측에 chip 을 얹으므로, 그때만 양보해
 *  중복 노출을 피한다. (reviewing/finalized 의 옛 상태 리본은 제거됐다 —
 *  상태 설명은 PhaseChip 팝오버로.) */
function MetaChipsBanner({
  existingReport,
  draft,
  setDraft,
  isEditing,
  linkedReports,
}) {
  if (!isEditing || !draft) return null
  // 잠금 배너가 떠 있을 때만 그쪽에 칩을 양보(중복 방지).
  if (existingReport?.author_lock_enabled) return null
  const hasType = !!draft.report_type_id
  const hasEntities =
    Array.isArray(draft.entities) && draft.entities.length > 0
  const isAmber = !hasType || !hasEntities
  const bannerCls = isAmber
    ? 'bg-amber-50 text-amber-900'
    : 'bg-muted/30 text-muted-foreground'
  const descCls = isAmber ? 'text-amber-800/80' : ''
  const descText = isAmber
    ? '종류와 관련 정보를 등록하면 검색·집계·필터 정확도가 올라갑니다.'
    : '추가/변경은 우측 칩 클릭.'
  return (
    <div
      data-export-exclude
      className={cn(
        'border-b px-6 py-2 text-xs flex items-center gap-2',
        bannerCls,
      )}
    >
      <span className="text-base">📋</span>
      <span className="font-medium shrink-0">보고서 메타데이터</span>
      <span className={cn('flex-1 min-w-0 truncate', descCls)}>{descText}</span>
      <ReportMetaChips
        draft={draft}
        setDraft={setDraft}
        isEditing={isEditing}
        tone="amber"
        reportId={existingReport?.id}
        linkedReports={linkedReports}
        canEdit={existingReport?.can_edit}
      />
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
  // 빈 페이지(블록 0개) 상태에서 보여줄 "+위젯 추가" 버튼이 호출하는
  // 콜백. onAddExtraBlockAt 와 달리 anchor 가 없으므로 페이지 끝(=첫
  // 자리)에 새 위젯을 추가한다. 부모(ReportDetailPage) 의 addExtraBlock
  // 을 그대로 wrap 해 전달.
  onAddBlock,
  onRemoveBlock,
  onChangeExtraBlockProps,
  onChangeSection,
  // 위젯 복사/잘라내기/붙여넣기 콜백. 부모(ReportDetailPage) 가
  // clipboard state 와 핸들러를 들고 있고, 이 PageSection 은 우클릭
  // 컨텍스트 메뉴에 연결만 한다. `canPaste` 는 클립보드에 뭔가
  // 들어있는지 boolean 으로 받아 메뉴의 disabled 상태를 결정.
  onCopyBlock,
  onCutBlock,
  onPasteBlock,
  canPaste,
  // 다른 페이지로 옮기기 — `pagesMeta` 는 컨텍스트 메뉴의 페이지 선택
  // 단계가 보여줄 (idx, label) 목록. onMoveToPage(blockId, dstPageIdx)
  // 가 실제 이동을 수행. 현재 페이지 자신은 메뉴 측에서 자동으로 제외.
  pagesMeta,
  onMoveToPage,
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
  // 리사이즈 중인 블록의 *실시간* 가로 폭(col_span) — RGL onResize 가 매
  // 프레임 전달. 드래그 핸들 바의 폭 뱃지(예: "50%")가 끌면서 실시간으로
  // 바뀌어, 50%·25% 같은 등분 폭을 눈으로 맞추기 쉽게 한다. {i, w} 또는 null.
  const [liveResize, setLiveResize] = useState(null)
  // 리사이즈 중 "실시간 폭 %" 뱃지를 *React 리렌더 없이* 갱신하기 위한 ref.
  // onResize 가 매 이동마다 이 span 의 textContent 만 직접 쓴다 — state 를
  // 건드리면 PageSection 이 리렌더되며 다른 위젯까지 다시 그려져 랙이 된다
  // (가로 리사이즈가 느렸던 원인). 플레이스홀더 안의 span 에 연결된다.
  const resizeBadgeRef = useRef(null)
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
  // 편집 모달을 열 때 위젯의 *실제 렌더 폭*(px) — 카드 클릭 시점에 측정.
  // 모달 안에서 표/비교표를 이 폭으로 제한해 편집 ↔ 화면 폭을 맞춘다(WYSIWYG).
  const [contentEditWidthPx, setContentEditWidthPx] = useState(null)
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

  // 리사이즈 핸들을 잡아 드래그를 시작할 때, 해당 블록이 자동맞춤(auto_fit)
  // 상태면 즉시 꺼서 사용자가 끌어서 크기 조정을 할 수 있게 한다. 한 번의
  // 마찰 없는 액션으로 끝나도록 — 자동맞춤이 켜진 줄 모르고 핸들만 잡았다
  // 가 동작 안 하는 케이스가 가장 흔한 발견성 문제였다. 의도와 다르게
  // 꺼졌으면 토스트의 "되돌리기" 버튼으로 한 번에 복구 가능.
  const handleResizeStart = useCallback(
    (_layout, oldItem) => {
      const blockId = oldItem?.i
      // 리사이즈 시작 즉시 가벼운 플레이스홀더로 교체한다. 예전엔 첫 격자
      // 경계를 넘어 col_span 이 바뀔 때(onResize)에야 플레이스홀더가 떠서,
      // 그 전까지 무거운 위젯(차트/Plotly)이 매 픽셀 reflow 하며 마우스를
      // 못 따라오는 랙이 있었다. 시작점에서 바로 빼면 제스처 내내 가볍다.
      if (blockId && Number.isFinite(oldItem?.w)) {
        setLiveResize((prev) =>
          prev && prev.i === blockId && prev.w === oldItem.w
            ? prev
            : { i: blockId, w: oldItem.w },
        )
      }
      if (!isEditing || !onToggleAutoFit) return
      if (!blockId) return
      const block = blocks.find((b) => b.id === blockId)
      if (!block) return
      const isAutoFit = autoFitForBlock(block, effectiveLayouts[blockId])
      if (!isAutoFit) return
      onToggleAutoFit(blockId, false)
      toast.info('자동맞춤을 껐습니다 — 이제 크기를 조정할 수 있어요.', {
        action: {
          label: '되돌리기',
          onClick: () => onToggleAutoFit(blockId, true),
        },
      })
    },
    [isEditing, onToggleAutoFit, blocks, effectiveLayouts],
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
          <CardContent className="py-12 flex flex-col items-center gap-3 text-sm text-muted-foreground">
            <span>템플릿에 블록이 없습니다.</span>
            {isEditing && onAddBlock && (
              <EmptyStateAddWidget onAdd={onAddBlock} />
            )}
          </CardContent>
        </Card>
      ) : (
        <ResizableGrid
          items={rglItems}
          onLayoutChange={isEditing ? onLayoutChange : undefined}
          onResizeStart={isEditing ? handleResizeStart : undefined}
          // onResize(매 이동)에서는 절대 React state 를 건드리지 않는다. 예전엔
          // col_span 변화마다 setLiveResize 를 호출했는데, 그게 PageSection 을
          // 리렌더 → 모든 블록 엘리먼트를 새로 만들어 *다른 무거운 위젯(차트
          // 등)까지 매번 다시 그리게* 했다(가로 리사이즈가 느렸던 원인). 대신
          // 실시간 폭 %는 플레이스홀더 안 span 의 textContent 를 직접 써서
          // 보여준다 — 리렌더가 없어 랙이 없다. 플레이스홀더 교체 자체는
          // onResizeStart 에서 한 번만 켜고(제스처 내내 유지), 실제 셀 크기는
          // 라이브러리가 픽셀 단위로 부드럽게 그린다. 최종 크기는
          // onResizeStop→onLayoutChange 로 저장. (콜백 시그니처는 v2
          // GridItemCallback (id, w, h, data) 와 EventCallback 두 형태 흡수.)
          onResize={
            isEditing
              ? (arg0, arg1, arg2) => {
                  if (!resizeBadgeRef.current) return
                  let w
                  if (typeof arg0 === 'string') {
                    w = arg1
                  } else {
                    const it = arg2 || arg1
                    w = it?.w
                  }
                  if (Number.isFinite(w)) {
                    const cols = Math.max(1, Math.round(w))
                    const pct = Math.round((cols / REPORT_GRID_COLS) * 100)
                    resizeBadgeRef.current.textContent = `${cols}/12 · ${pct}%`
                  }
                }
              : undefined
          }
          onResizeStop={isEditing ? () => setLiveResize(null) : undefined}
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
            // 리사이즈 중이면 실시간 폭(liveResize.w)을, 아니면 저장된 col_span.
            const blockColSpan =
              liveResize?.i === block.id
                ? liveResize.w
                : effectiveLayouts[block.id]?.col_span ?? REPORT_GRID_COLS
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
                {liveResize?.i === block.id ? (
                  // 리사이즈 중엔 무거운 위젯 대신 가벼운 붉은 플레이스홀더만
                  // 그린다 — 위젯 콘텐츠 reflow 비용을 없애 드래그가 마우스를
                  // 그대로 따라온다. 박스 크기는 라이브러리가 픽셀 단위로 부드럽게
                  // 그린다. 폭 % span 은 onResize 가 textContent 만 직접 갱신해
                  // (리렌더 없이) 실시간으로 보여준다. 초기값은 시작 col_span.
                  <div className="h-full w-full rounded-md border-2 border-dashed border-red-400/70 bg-red-400/10 flex items-center justify-center gap-2 text-xs font-medium text-red-500 select-none">
                    <span className="uppercase tracking-wider">
                      {block.type}
                    </span>
                    <span ref={resizeBadgeRef} className="tabular-nums">
                      {blockColSpan}/12 ·{' '}
                      {Math.round((blockColSpan / REPORT_GRID_COLS) * 100)}%
                    </span>
                  </div>
                ) : (
                <BlockEditorCard
                  block={block}
                  colSpan={blockColSpan}
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
                  onOpenSection={
                    // 우클릭 컨텍스트 메뉴 대비 발견성이 떨어진다는
                    // 피드백 → 편집모드에서 드래그 핸들 바에 명시적
                    // 「단락 구분」버튼 노출. 컨텍스트 메뉴와 동일하게
                    // onChangeSection 핸들러가 부모에 있어야 의미가
                    // 있으므로 그 prop 유무로 가드.
                    isEditing && onChangeSection
                      ? () => setSectionEditingId(block.id)
                      : undefined
                  }
                  onOpenContentEdit={
                    isEditing && !INLINE_EDITABLE_WIDGETS.has(block.type)
                      ? (widthPx) => {
                          setContentEditingId(block.id)
                          setContentEditWidthPx(
                            Number.isFinite(widthPx) ? widthPx : null,
                          )
                        }
                      : undefined
                  }
                  onMeasureContentHeight={(px) =>
                    onMeasureContentHeight?.(block.id, px)
                  }
                  onMeasureEditHeight={(px) => handleMeasureEdit(block.id, px)}
                />
                )}
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
          onCopy={
            onCopyBlock
              ? () => {
                  onCopyBlock(contextMenu.blockId)
                  setContextMenu(null)
                }
              : undefined
          }
          onCut={
            onCutBlock
              ? () => {
                  onCutBlock(contextMenu.blockId)
                  setContextMenu(null)
                }
              : undefined
          }
          onPaste={
            onPasteBlock
              ? () => {
                  // 우클릭 → 붙여넣기: 이 위젯 바로 아래 새 행에 paste.
                  // 마우스 기반 사용자가 "여기서 paste 하자" 라고 의도한
                  // 위치가 anchor 의 바로 아래라는 게 가장 자연스러움.
                  onPasteBlock(contextMenu.blockId)
                  setContextMenu(null)
                }
              : undefined
          }
          canPaste={!!canPaste}
          movePages={
            onMoveToPage
              ? (pagesMeta ?? []).filter((p) => p.idx !== pageIdx)
              : null
          }
          onMoveToPage={
            onMoveToPage
              ? (dstPageIdx) => {
                  onMoveToPage(contextMenu.blockId, dstPageIdx)
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
            renderWidthPx={contentEditWidthPx}
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

/** Wrap JSON.parse with two pre-parse repair passes that absorb the
 *  most common AI output quirks:
 *
 *  1. **Code-fence / prose wrappers** — Despite "JSON only, no fences"
 *     instructions, Claude/GPT still emit ```json ... ``` blocks (or
 *     leading "Here's the JSON:" preambles) ~5-10% of the time. The
 *     literal backtick then surfaces as `Unexpected token '\`'` to the
 *     user. stripCodeFences pulls the JSON out before parsing.
 *  2. **Single-backslash LaTeX** — Equation widget bodies frequently
 *     come back as `"\sigma"` / `"\frac{...}"` instead of the
 *     JSON-correct `"\\sigma"`. JSON.parse fails on `\s`
 *     (Bad escaped character) and silently corrupts `\f` (form feed) /
 *     `\b` (backspace) into control chars, which then breaks KaTeX
 *     rendering downstream. escapeUnescapedLatexBackslashes patches
 *     these in a single pass.
 *
 *  If the repaired text still won't parse, we fall back to the
 *  fence-stripped (but not LaTeX-repaired) text so the user sees the
 *  original error class, not a derived one from our heuristics. */
function parseJsonWithLatexFix(text) {
  const stripped = stripCodeFences(text)
  const dekeyed = fixMarkdownConfusedKeys(stripped)
  const repaired = escapeUnescapedLatexBackslashes(dekeyed)
  try {
    return JSON.parse(repaired)
  } catch (e1) {
    try {
      return JSON.parse(dekeyed)
    } catch {
      // Surface the repaired-version error — it's typically more
      // diagnostic because the LaTeX issues have already been
      // factored out.
      throw e1
    }
  }
}

/** Patch known underscore-prefixed JSON keys that some AIs auto-render
 *  as Markdown italics (`_type` → `*type`). The collision is rare in
 *  hand-typed JSON because `*` makes a string non-conforming when used
 *  as a bare identifier — but as a quoted key the parse still succeeds,
 *  it just fails our `_type === "..."` shape check downstream with a
 *  confusing "지원하지 않는 형식" message. Patching back at the parse
 *  boundary lets users keep pasting AI output unmodified.
 *
 *  Conservative scope: only the exact quoted-key form `"*type"` (with
 *  optional whitespace before the colon). Free-form text containing
 *  `*type` is left untouched. */
function fixMarkdownConfusedKeys(text) {
  if (!text || typeof text !== 'string') return text
  return text.replace(/"\*type"(\s*:)/g, '"_type"$1')
}

/** Strip Markdown code-fence wrappers and prose preamble/postamble that
 *  AIs sometimes emit despite explicit "JSON only" instructions. Handles:
 *    "```json\n{...}\n```"          ← fence + language hint
 *    "```\n{...}\n```"              ← bare fence
 *    "Here's the JSON:\n```json\n{...}\n```\nLet me know..." ← prose + fence
 *    "Here is the JSON:\n{...}\n"   ← bare prose around plain JSON
 *  Returns the text unchanged when none of these patterns apply (so a
 *  clean payload is never truncated by accident). All branches return
 *  trimmed text. */
function stripCodeFences(text) {
  if (!text || typeof text !== 'string') return text
  const s = text.trim()
  // Case 1 — full triple-backtick wrap around the entire payload.
  // Optional `json` / `JSON` language hint and surrounding whitespace.
  const fullFence = s.match(/^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```\s*$/)
  if (fullFence) return fullFence[1].trim()
  // Case 2 — fence in the middle of prose (AI added a preamble or
  // postamble). Take everything between the first and last ```, drop
  // the optional language hint right after the opening fence.
  if (s.includes('```')) {
    const open = s.indexOf('```')
    const close = s.lastIndexOf('```')
    if (close > open) {
      let inner = s.slice(open + 3, close)
      inner = inner.replace(/^[ \t]*(?:json|JSON)?\s*\n?/, '')
      return inner.trim()
    }
  }
  // Case 3 — no fence but extra prose around plain JSON. Only kick in
  // when the trimmed text doesn't already look like raw JSON, so a
  // clean `{...}` payload skips this branch entirely. Conservative:
  // only takes the first `{` … last `}` slice (or `[` … `]`).
  if (s[0] !== '{' && s[0] !== '[') {
    const firstObj = s.indexOf('{')
    const lastObj = s.lastIndexOf('}')
    if (firstObj !== -1 && lastObj > firstObj) {
      return s.slice(firstObj, lastObj + 1)
    }
    const firstArr = s.indexOf('[')
    const lastArr = s.lastIndexOf(']')
    if (firstArr !== -1 && lastArr > firstArr) {
      return s.slice(firstArr, lastArr + 1)
    }
  }
  return s
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
function BlockContextMenu({
  x,
  y,
  onClose,
  onEditProps,
  onEditSection,
  onCopy,
  onCut,
  onPaste,
  canPaste,
  // 다른 페이지로 옮기기 — `movePages` 가 비어있거나 null 이면 메뉴 항목
  // 자체를 숨김 (페이지가 한 개뿐인 보고서, 또는 prop 미주입). 클릭 시
  // 메뉴 내부 stage 가 picker 로 전환되고, 페이지를 고르면 onMoveToPage
  // 가 호출된다.
  movePages,
  onMoveToPage,
  onRemove,
}) {
  // 메뉴 stage — `null` 이면 기본 메뉴, `'move'` 면 페이지 선택 단계.
  // 같은 popup 안에서 단계 전환해서 별도 sub-menu 컴포넌트 없이 처리.
  const [stage, setStage] = useState(null)
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
  const canMove =
    Array.isArray(movePages) && movePages.length > 0 && !!onMoveToPage
  return (
    <div
      className="fixed z-50 min-w-[200px] max-h-[70vh] overflow-y-auto rounded-md border bg-popover py-1 shadow-md"
      style={{ left: x, top: y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {stage === 'move' ? (
        <>
          <button
            type="button"
            onClick={() => setStage(null)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted text-left"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            뒤로
          </button>
          <div className="my-1 h-px bg-border" aria-hidden="true" />
          <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            옮길 페이지 선택
          </div>
          {movePages.map((p) => (
            <button
              key={p.idx}
              type="button"
              onClick={() => onMoveToPage(p.idx)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted text-left"
            >
              <span className="text-[10px] text-muted-foreground tabular-nums w-5 text-right shrink-0">
                {p.idx + 1}.
              </span>
              <span className="truncate">{p.label}</span>
            </button>
          ))}
        </>
      ) : (
      <>
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
      {/* 복사/잘라내기/붙여넣기 — clipboard-based widget transfer. 단축키
          Ctrl+C / Ctrl+X / Ctrl+V 가 동일 동작을 수행. 붙여넣기는
          클립보드가 비어있을 땐 disabled 상태로 표시 (사용자가 "지금
          paste 할게 없음"을 알 수 있도록). */}
      <div className="my-1 h-px bg-border" aria-hidden="true" />
      {onCopy && (
        <button
          type="button"
          onClick={onCopy}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted text-left"
        >
          <Copy className="h-3.5 w-3.5" />
          <span className="flex-1">복사</span>
          <span className="text-[10px] text-muted-foreground">Ctrl+C</span>
        </button>
      )}
      {onCut && (
        <button
          type="button"
          onClick={onCut}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted text-left"
        >
          <Scissors className="h-3.5 w-3.5" />
          <span className="flex-1">잘라내기</span>
          <span className="text-[10px] text-muted-foreground">Ctrl+X</span>
        </button>
      )}
      {onPaste && (
        <button
          type="button"
          onClick={canPaste ? onPaste : undefined}
          disabled={!canPaste}
          className={cn(
            'flex w-full items-center gap-2 px-3 py-1.5 text-sm text-left',
            canPaste ? 'hover:bg-muted' : 'opacity-40 cursor-not-allowed',
          )}
        >
          <ClipboardPaste className="h-3.5 w-3.5" />
          <span className="flex-1">붙여넣기</span>
          <span className="text-[10px] text-muted-foreground">Ctrl+V</span>
        </button>
      )}
      {canMove && (
        <button
          type="button"
          onClick={(e) => {
            // 클릭이 바깥으로 전파되어 menu 가 자동 닫히는 걸 방지 —
            // 우리는 같은 menu 안에서 단계만 바꾼다.
            e.stopPropagation()
            setStage('move')
          }}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted text-left"
        >
          <ArrowRightLeft className="h-3.5 w-3.5" />
          <span className="flex-1">다른 페이지로 옮기기</span>
          <ChevronRight className="h-3 w-3 text-muted-foreground" />
        </button>
      )}
      {onRemove && (
        <>
          <div className="my-1 h-px bg-border" aria-hidden="true" />
          <button
            type="button"
            onClick={onRemove}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-destructive/10 text-destructive text-left"
          >
            <Trash2 className="h-3.5 w-3.5" />
            위젯 제거
          </button>
        </>
      )}
      </>
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
  renderWidthPx,
  initialContent,
  initialPropsOverride,
  onApply,
  onClose,
}) {
  const renderer = getRenderer(block.type)
  const Editor = renderer?.Editor
  // 표/비교표는 폭이 레이아웃의 핵심이라, 모달이 80vw 로 넓으면 편집 폭 ≠ 실제
  // 화면 폭이 되어 열 비율을 맞추기 어렵다. 측정한 실제 렌더 폭(renderWidthPx)
  // 으로 편집 surface 를 제한해 WYSIWYG. 좁아서 불편하면 토글로 전체 폭 사용.
  const isWidthSensitive = block.type === 'table' || block.type === 'comparison'
  const [fitWidth, setFitWidth] = useState(true)
  const fitWidthActive =
    isWidthSensitive && fitWidth && Number.isFinite(renderWidthPx)
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
  const editorNode = (
    <Editor
      props={editorProps ?? effectiveProps}
      content={draftContent}
      onChange={setDraftContent}
      onChangePropsOverride={(patch) => setDraftPropsOverride(patch)}
      // autoFit is meaningful only for the in-grid cell sizing pipeline.
      autoFit={false}
      readOnly={false}
    />
  )
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
            {isWidthSensitive && Number.isFinite(renderWidthPx) && (
              <label
                className="ml-auto flex items-center gap-1.5 text-[11px] font-normal text-muted-foreground cursor-pointer select-none"
                title="화면에서 이 위젯이 차지하는 실제 폭으로 편집 영역을 맞춰, 열 비율을 화면 그대로 조절할 수 있게 합니다."
              >
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5"
                  checked={fitWidth}
                  onChange={(e) => setFitWidth(e.target.checked)}
                />
                실제 폭에 맞추기 ({Math.round(renderWidthPx)}px)
              </label>
            )}
          </DialogTitle>
        </DialogHeader>
        {/* No outer scroll wrapper — widgets that need horizontal /
            vertical scrolling own that internally (Chart splits into
            its own left/right panel with the right panel scrollable;
            table widgets use their own overflow-x-auto wrappers). A
            blanket overflow-y-auto here collapsed `flex: 1` heights
            for chart-like widgets that need to fit-to-container. */}
        <div className="flex-1 min-h-0 flex flex-col report-widget-body">
          {fitWidthActive ? (
            // 표/비교표: 실제 렌더 폭으로 제한해 편집 ↔ 화면 폭 일치(WYSIWYG).
            // 세로로 길면 스크롤. 좁아도 화면에 보일 모습 그대로라 비율 맞추기 쉬움.
            <div className="flex-1 min-h-0 overflow-auto">
              <div
                className="mx-auto"
                style={{ maxWidth: `${Math.round(renderWidthPx)}px` }}
              >
                {editorNode}
              </div>
            </div>
          ) : (
            editorNode
          )}
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
              // z-30: 각 변 중앙의 추가 버튼이 변 전체에 깔린 리사이즈
              // 선(z-20) 위에 오도록 — 중앙은 추가, 나머지 변은 크기조절.
              'absolute z-30 flex h-9 w-9 items-center justify-center rounded-full',
              'border bg-background text-muted-foreground shadow-md',
              'opacity-0 transition-opacity pointer-events-none',
              'hover:bg-primary hover:text-primary-foreground hover:border-primary',
              'group-hover/insert:opacity-100 group-hover/insert:pointer-events-auto',
              positionClass,
            )}
          >
            <Icon className="h-5 w-5" />
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
        positionClass="-top-[18px] left-1/2 -translate-x-1/2"
        side="top"
        align="center"
      />
      <Arrow
        direction="down"
        icon={ChevronDown}
        positionClass="-bottom-[18px] left-1/2 -translate-x-1/2"
        side="bottom"
        align="center"
      />
      {canInsertHorizontally && (
        <Arrow
          direction="left"
          icon={ChevronLeft}
          positionClass="top-1/2 -left-[18px] -translate-y-1/2"
          side="left"
          align="center"
        />
      )}
      {canInsertHorizontally && (
        <Arrow
          direction="right"
          icon={ChevronRight}
          positionClass="top-1/2 -right-[18px] -translate-y-1/2"
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

/** Sibling of FloatingAddWidget — sized for inline use inside the empty
 *  state Card (no widget on the page yet). Same popover + WidgetPicker
 *  pattern as the floating button, but a normal-sized outline button so
 *  it fits naturally inside the centered "empty" placeholder instead of
 *  reading like a misplaced floating action. */
function EmptyStateAddWidget({ onAdd }) {
  const { catalog, loading } = useWidgetCatalog()
  const [open, setOpen] = useState(false)
  if (loading) return null
  const widgets = catalog?.widgets ?? []
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline" className="gap-1">
          <Plus className="h-3.5 w-3.5" />
          위젯 추가
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="center"
        side="bottom"
        sideOffset={8}
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
  colSpan,
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
  // 우클릭 → 컨텍스트 메뉴 → 단락 구분 경로가 사용자한테 안 보이는
  // 진입점이라는 피드백을 받아, 드래그 핸들 바에 같은 동작을 여는
  // 명시적 버튼을 추가했다. 이 prop 이 있으면 핸들 바에 「단락 구분」
  // 버튼이 노출되고, 클릭 시 SectionPickerDialog 가 뜬다.
  onOpenSection,
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
  // Pair the right-side comment panel with a visible marker on the
  // body widget that the focused thread is anchored to. focusedAnchor
  // is null when the panel is closed or no thread is selected, so the
  // ring only appears on click — no permanent noise.
  const { focusedAnchor } = useComments()
  const isCommentFocused =
    !!focusedAnchor &&
    focusedAnchor.pageIndex === (pageIndex ?? 0) &&
    focusedAnchor.blockId === block.id

  // Cross-reference label ("그림 3") for this block, from the whole-report
  // numbering index. Provided down to CaptionInput so the figure/table caption
  // shows its number — matching how the body's `#` references read.
  const mentionCtx = useReportMention()
  const blockRefLabel =
    mentionCtx?.blockIndex?.get(blockRefKey(pageIndex ?? 0, block.id))?.label ?? null

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
  // 표 위젯의 "전체 펼치기" 토글 상태. autoFit 측정용 mirror Editor 와
  // 본체 Editor 두 인스턴스가 같은 expanded 를 봐야 mirror 가 같이 자라고
  // 컨테이너 row_span 도 따라서 늘어난다. Card 전체를 TableViewContext.
  // Provider 로 감싸서 두 곳 모두 같은 state 참조. 비-table 위젯은 이
  // Context 를 무시한다.
  // 표의 저장된 기본 펼침(content.expanded, 미설정=펼침)으로 시작. mirror·본체
  // 가 같은 Provider 값을 보므로, 보기 화면에서 곧바로 펼친 상태로 뜬다(예전엔
  // 항상 false 라 매번 '펼치기'를 눌러야 했음). 독자는 토글로 변경 가능.
  const [tableExpanded, setTableExpanded] = useState(() =>
    block.type === 'table' ? (content?.expanded ?? true) : false,
  )
  // 작성자가 '기본 펼침'을 토글하면 content.expanded 가 바뀌므로 즉시 동기화 —
  // 새로고침 없이 보기 화면에 반영된다. 독자의 수동 펼침/접기 토글은
  // content.expanded 를 건드리지 않아(읽기 state 만 변경) 이 effect 가 그걸
  // 덮어쓰지 않는다(deps = content.expanded 값).
  useEffect(() => {
    if (block.type === 'table') setTableExpanded(content?.expanded ?? true)
  }, [block.type, content?.expanded])
  const tableViewValue = useMemo(
    () => ({ expanded: tableExpanded, setExpanded: setTableExpanded }),
    [tableExpanded],
  )
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
      // 측정 자체는 wantsSquare 든 아니든 동일: clientWidth + chrome.
      // 그래프 위젯은 autoFit 분기에서 자기 container.clientWidth 를 그대로
      // height 로 박으므로, 셀이 (그 height + chrome) 만큼 잡혀야 widget
      // 이 안 넘침. 예전엔 wantsSquare 일 때만 grid item 외곽 width 를
      // 그대로 전달했는데 (perfect external square) → widget 이 그보다
      // 살짝 크게 (chrome 차이만큼) 자라 컨테이너 밖으로 튀어나오는
      // overflow 가 생겼음. clientWidth + chrome 으로 일관 처리하면
      // 외곽이 약 chrome 차 (보통 20-50px) 만큼 가로보다 길지만 widget
      // 은 깔끔히 안에 들어맞음.
      const reported = wantsSquare ? el.clientWidth || el.offsetWidth : el.scrollHeight
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
      // 위 measureRef effect 와 동일 사유 — widget 의 자기-width-as-height
      // 와 셀 chrome 을 한꺼번에 더해 보내 overflow 방지.
      const reported = wantsSquare ? el.clientWidth || el.offsetWidth : el.scrollHeight
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

  // 가로 폭 비율(전체 12칸 대비). 리사이즈 중엔 부모가 실시간 col_span 을
  // 넘겨주므로 끌면서 % 가 바뀐다. 100/75/50/33/25% = 12/9/6/4/3 칸 등 "딱
  // 떨어지는" 등분일 때 강조해, 50%·25% 같은 폭을 눈으로 맞추기 쉽게 한다.
  const widthCols = colSpan ?? REPORT_GRID_COLS
  const widthPct = Math.round((widthCols / REPORT_GRID_COLS) * 100)
  const isNiceWidth = [12, 9, 6, 4, 3].includes(widthCols)

  const dragHandle = showDragHandle ? (
    <div className="block-drag-handle absolute inset-x-0 top-0 z-10 cursor-move px-2 py-0.5 bg-muted/60 backdrop-blur-sm border-b flex items-center gap-2 rounded-t-md">
      <GripVertical className="h-3 w-3 text-muted-foreground" />
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {block.type}
      </span>
      {/* 가로 폭 % 뱃지 — 리사이즈 중 실시간 갱신. */}
      <span
        className={cn(
          'flex items-center rounded px-1 py-0.5 text-[10px] font-semibold tabular-nums',
          isNiceWidth
            ? 'bg-primary/15 text-primary'
            : 'bg-background/70 text-muted-foreground',
        )}
        title={`가로 폭 ${widthCols}/12 칸 = ${widthPct}%`}
      >
        {widthPct}%
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
      {onOpenSection && (
        <button
          type="button"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onOpenSection()
          }}
          className={cn(
            // sectionItem 이 이미 있으면 카테고리 컬러를 가볍게 띄워서
            // "지정됨" 상태를 한눈에. 없으면 회색-호버 톤 — 그래도
            // 단순 회색 아이콘만 두는 것보다 텍스트가 옆에 있으면
            // 발견성이 훨씬 좋아진다 (사용자 피드백).
            'flex items-center gap-1 rounded px-1 py-0.5 text-[10px] font-medium select-none',
            sectionItem
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            !onToggleAutoFit && 'ml-auto',
          )}
          title={sectionItem ? '단락 구분 변경 (또는 우클릭)' : '단락 구분 추가 (또는 우클릭)'}
          aria-label={sectionItem ? '단락 구분 변경' : '단락 구분 추가'}
        >
          <Bookmark className="h-3 w-3" />
          단락 구분
        </button>
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
            !onToggleAutoFit && !onOpenSection && !onRemove && 'ml-auto',
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
            !onToggleAutoFit && !onOpenSection && !onOpenProps && 'ml-auto',
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
          // Mirror the right-panel focus on the body widget — amber to
          // match the comment-pin color vocabulary (border-amber-300
          // when threads exist).
          isCommentFocused && 'ring-2 ring-amber-400 rounded-md',
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
            No fullscreen for headings (nothing to expand). In edit mode
            the drag-handle bar owns the top strip (and its right side
            holds the trash button), so drop the pin below it. */}
        {reportId && (
          <div className={cn(
            'absolute right-2 z-10 flex items-center gap-1',
            showDragHandle ? 'top-8' : 'top-2',
          )}>
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
    // 단일 클릭은 "선택"만 한다 — 예전엔 여기서 모달을 바로 열었는데,
    // 드래그 이동/크기 조정 중 실수로 편집창이 열리는 문제가 있어서
    // 모달 진입은 호버 "편집" 버튼 또는 더블클릭으로만(아래) 분리했다.
    onActivate?.(e)
  }
  // 모달 편집 진입 — 위젯의 실제 렌더 폭을 함께 넘겨 모달이 그 폭으로 편집
  // surface 를 맞춘다(표/비교표 WYSIWYG). el 은 폭 측정의 기준 카드 요소.
  function openContentEditorFrom(el) {
    if (!opensModalEditor) return
    const card =
      el?.closest?.('[data-report-widget-card="true"]') ?? el ?? null
    onOpenContentEdit(card?.getBoundingClientRect?.().width ?? null)
  }
  function handleCardDoubleClick(e) {
    if (!opensModalEditor) return
    e.stopPropagation()
    openContentEditorFrom(e.currentTarget)
  }
  return (
    <CurrentBlockRefContext.Provider value={blockRefLabel}>
    <TableViewContext.Provider value={tableViewValue}>
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
      onDoubleClick={handleCardDoubleClick}
      className={cn(
        'group relative h-full flex flex-col',
        autoFit ? 'overflow-visible' : 'overflow-hidden',
        active && !readOnly && 'ring-2 ring-primary/30',
        // Mirror the right-panel focus on the body widget — amber to
        // match the comment-pin color vocabulary. Wins over the
        // primary-tinted active ring so a focused comment is always
        // visually distinguishable from a merely-selected block.
        isCommentFocused && 'ring-2 ring-amber-400',
        // Hover hint that this card is editable — modal entry is via the
        // hover "편집" button / double-click (not a bare single click),
        // so no cursor-pointer on the whole card anymore.
        opensModalEditor && 'hover:ring-2 hover:ring-primary/20'
      )}
    >
      {dragHandle}
      {/* 호버 시 떠오르는 "편집" 버튼 — 비인라인 위젯의 모달 진입점. 단일
          클릭(선택)·드래그·리사이즈와 분리돼 실수로 편집창이 열리지 않는다.
          오버레이는 pointer-events-none 이라 평소 내용 조작을 막지 않고,
          버튼만 pointer-events-auto 로 살린다. */}
      {opensModalEditor && (
        <div className="pointer-events-none absolute inset-0 z-[6] flex items-center justify-center bg-background/10 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              openContentEditorFrom(e.currentTarget)
            }}
            className="pointer-events-auto inline-flex items-center gap-2 rounded-lg border-2 border-primary bg-background px-5 py-2.5 text-sm font-semibold text-primary shadow-lg hover:bg-primary hover:text-primary-foreground"
            title="이 위젯 편집 (더블클릭으로도 열림)"
          >
            <Pencil className="h-4 w-4" />
            편집
          </button>
        </div>
      )}
      {viewModeSectionHeader}
      {/* Pin + fullscreen group — anchored top-right, horizontally
          stacked so they never overlap. Each child positions inline.
          Pin appears for any widget with a comment-able report context;
          fullscreen only for view-mode widgets that benefit from it.
          In edit mode the drag-handle bar owns the top strip and holds
          the trash button on its right side, so push this group below
          the bar to avoid stacking the pin on top of the trash icon. */}
      {(reportId || canFullscreen) && (
        <div className={cn(
          'absolute right-2 z-10 flex items-center gap-1',
          showDragHandle ? 'top-10' : 'top-2',
        )}>
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
    </TableViewContext.Provider>
    </CurrentBlockRefContext.Provider>
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
// 28 fine rows ≈ 332px — 그래프 위젯이 기본 OFF 인 자동맞춤 상태에서도
// 의미 있는 크기로 떠서 바로 데이터 보임. 텍스트성 위젯은 첫 frame 후
// scrollHeight 가 들어오면서 자기 자연 height 로 줄어들기 때문에 큰
// 초깃값도 사용성에 부담 없음. (예전 12 ≈ 140px 는 신규 차트가 한 줄짜리
// strip 처럼 보여 매번 사용자가 수동으로 키워야 했음.)
const AUTO_FIT_INITIAL_ROWS = 28

// 위젯을 드래그로 너무 얇은 strip 으로 만들지 못하게 하는 세로 최소 높이.
// px 로 정의하고 행(row) 수로 환산해 두면 rowHeight/gap 이 바뀌어도 의도한
// 픽셀 높이가 유지된다. 이 값은 리사이즈 핸들에만 적용되고
// (applySizeConstraints 가 minH 로 클램프), 콘텐츠가 자연히 더 작은
// 자동맞춤 위젯의 *표시* 높이를 부풀리지는 않는다 — RGL correctBounds 는
// h 를 minH 로 보정하지 않기 때문(가로 x/w 만 보정).
const REPORT_MIN_HEIGHT_PX = 56
const REPORT_MIN_ROW_SPAN = Math.max(
  1,
  Math.ceil(
    (REPORT_MIN_HEIGHT_PX + REPORT_ROW_GAP) / (REPORT_ROW_HEIGHT + REPORT_ROW_GAP),
  ),
)

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
  'mind_map',
  'pie',
  'waffle',
  'box',
  'density',
  'radar',
  'sankey',
  'quadrant',
  'cad_3d',
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
  'treemap',
  'packing',
  'tree',
  'network',
  'mind_map',
  'pie',
  'waffle',
  'box',
  'density',
  'radar',
  'sankey',
  'quadrant',
  'cad_3d',
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
  'mind_map',
  'pie',
  'waffle',
  'box',
  'density',
  'radar',
  'sankey',
  'quadrant',
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
    // x 우선순위:
    //  1) layout.col_offset 가 명시되어 있으면 그 값 그대로 (지그재그
    //     2-column 같은 외톨이 row 의 위치 복원에 필수).
    //  2) 없으면 같은 row 의 형제들 col_span 누적 — 한 row 에 여러
    //     블록이 왼→오른쪽으로 채워진 기본 케이스.
    let x
    if (Number.isFinite(layout.col_offset)) {
      x = layout.col_offset
    } else {
      const sameRow = byRow.get(layout.row) ?? []
      x = 0
      for (const sib of sameRow) {
        if (sib.id === b.id) break
        const sibLayout = effectiveLayouts[sib.id] ?? { col_span: REPORT_GRID_COLS }
        x += clamp(sibLayout.col_span ?? REPORT_GRID_COLS, 1, REPORT_GRID_COLS)
      }
    }
    const item = {
      i: b.id,
      x: Math.min(x, REPORT_GRID_COLS - 1),
      y: layout.row - 1,
      w: clamp(layout.col_span ?? REPORT_GRID_COLS, 1, REPORT_GRID_COLS),
      h: Math.max(1, layout.row_span ?? 2),
      minW: 1,
      maxW: REPORT_GRID_COLS,
      // 드래그 리사이즈로 내려갈 수 있는 세로 최소치. 1행(≈8px)까지 얇아져
      // strip 처럼 보이던 문제를 막는다. 표시 height(h)는 그대로 두므로
      // 자연히 더 작은 자동맞춤 위젯이 부풀지 않는다(위 상수 주석 참고).
      minH: REPORT_MIN_ROW_SPAN,
    }
    // 자동맞춤 블록도 일반 블록과 동일하게 기본 핸들(코너) 노출 — 이전엔
    // height 가 content-driven 이라는 의미로 east 핸들만 남겼는데, "리사이즈
    // 하려는데 핸들이 안 보인다" 가 가장 흔한 발견성 문제였다. 사용자가
    // 코너 핸들을 잡는 순간 ResizableGrid 의 onResizeStart 가 자동맞춤을
    // 꺼주고 정상 드래그로 이어진다 (의도가 아니면 토스트의 "되돌리기").
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
  onResizeStart,
  onResize,
  onResizeStop,
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
            // 아래·좌·우 변(변 전체를 잡는 "선") + 아래 두 모서리(점)만 노출.
            // 위쪽(n/ne/nw)은 의도적으로 뺐다 — compactType:"vertical" 레이아웃은
            // 위젯 위에 빈칸을 허용하지 않아, 위 핸들로 줄이면 매 move마다
            // moveElement 가 내려놓은 y 를 compact 가 다시 위로 끌어올려 위젯이
            // 떨린다(아래 핸들은 h 만 바꾸고 y 를 안 건드려 매끄러움). 즉
            // "위에서 줄이기"는 이 레이아웃 모델과 근본적으로 충돌하므로 제외.
            // 모서리를 배열 뒤에 둬 코너에서 엣지 선 위에 그려지게 함. 기본값 ['se'].
            handles: ['s', 'e', 'w', 'se', 'sw'],
          }}
          onLayoutChange={onLayoutChange}
          onResizeStart={onResizeStart}
          onResize={onResize}
          onResizeStop={onResizeStop}
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
    // col_offset 도 비교 — 없으면 0 으로 normalize.
    if ((x.col_offset ?? 0) !== (y.col_offset ?? 0)) return false
  }
  return true
}
