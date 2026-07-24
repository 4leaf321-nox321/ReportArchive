import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Copy,
  FileType2,
  Globe,
  GripVertical,
  Layers,
  Loader2,
  Pencil,
  Plus,
  Save,
  Send,
  Trash2,
  X,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu'
import { notifyIfStaleChunk } from '@/shared/lib/staleChunk'
import { cn } from '@/shared/lib/utils'
import { toast } from 'sonner'
import { Badge } from '@/shared/components/ui/badge'
import { Button } from '@/shared/components/ui/button'
import { Card, CardContent } from '@/shared/components/ui/card'
import { Input } from '@/shared/components/ui/input'
import { Textarea } from '@/shared/components/ui/textarea'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { ConfirmDialog } from '@/shared/components/ConfirmDialog'
import { SharePopover } from '@/shared/components/SharePopover'
import { ErrorState } from '@/shared/components/ErrorState'
import { WorkspaceTreeSelect } from '@/shared/components/WorkspaceTreeSelect'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import { useAuth } from '@/shared/auth/AuthContext'
import { useAsync } from '@/shared/hooks/useAsync'
import { useSectionTaxonomy } from '@/shared/hooks/useSectionTaxonomy'
import {
  createComposite,
  deleteComposite,
  getComposite,
  publishComposite,
  unpublishComposite,
  updateComposite,
} from '@/shared/api/composites'
import { createCompositePreset } from '@/shared/api/compositePresets'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import { KIND_LABEL, KIND_VARIANT, KINDS } from './constants'
import { ItemPickerDialog } from './ItemPickerDialog'
import { InlineCompositeView, InlineReportView } from './InlineReportView'
import { CompositeSummary } from './CompositeSummary'
import { PendingRequestsPanel } from './PendingRequestsPanel'
import { SubmitCompositeItemsDialog } from './SubmitToCompositeDialog'

export default function CompositeDetailPage() {
  const { compositeId } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const { slug, all: workspaces } = useWorkspace()
  const { me } = useAuth()

  // Gate the fetch on `slug` too — on a hard reload the URL gives us
  // `compositeId` immediately but the workspace context's
  // `setCurrentWorkspace()` runs in an effect, so firing the request
  // before that lands sends it without the `X-Workspace-Slug` header
  // → backend returns 400. ReportDetailPage uses the same gate.
  const { data: composite, loading, error, reload } = useAsync(
    () =>
      compositeId && slug
        ? getComposite(Number(compositeId))
        : Promise.resolve(null),
    [compositeId, slug],
  )

  // 생성 직후엔 바로 편집 모드로 — CompositesListPage 가 navigate 시
  // state.startEditing 을 실어 보낸다(ReportDetailPage 와 동일 패턴). composite
  // 로드 전엔 위 early-return 이 스켈레톤을 그리므로 true 로 시작해도 안전.
  const [isEditing, setIsEditing] = useState(
    Boolean(location.state?.startEditing),
  )
  const [draft, setDraft] = useState(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [addGroupOpen, setAddGroupOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [copyOpen, setCopyOpen] = useState(false)
  const [savePresetOpen, setSavePresetOpen] = useState(false)
  // Drag-and-drop state for item reorder. Declared up here with the
  // other hooks (not next to the reorderItems handler below) because
  // hooks must run in the same order every render — the component has
  // early returns for loading/error, so deferring these would skip
  // them on first render and surface as "Rendered more hooks than
  // during the previous render".
  const [draggingIdx, setDraggingIdx] = useState(null)
  const [dropOverIdx, setDropOverIdx] = useState(null)
  // 그룹(섹션) 드래그 상태 — 안건 드래그(draggingIdx)와 분리해 서로 간섭하지
  // 않게 한다. 그룹은 헤더의 grip 핸들로만 잡히고, 안건은 행 전체로 잡힌다.
  const [draggingGroup, setDraggingGroup] = useState(null)
  const [dropOverGroup, setDropOverGroup] = useState(null)
  // DOCX export progress (same reason as drag state — must run on every
  // render). `null` when not exporting; otherwise the latest progress
  // event from exportCompositeToDocx.
  const [docxProgress, setDocxProgress] = useState(null)
  // HTML export progress — same {phase, current, total, label} shape
  // so the ExportOverlay reads both.
  const [htmlProgress, setHtmlProgress] = useState(null)
  // Abort controller for the running export (Word or HTML — mutually
  // exclusive because both disable their buttons while either runs).
  // Wired to the overlay`s 취소 button; exporter throws AbortError at
  // its next polled checkpoint.
  const exportAbortRef = useRef(null)
  // Per-item expansion state, keyed by row index. Reset when the draft is
  // rebuilt so newly-added items start collapsed.
  const [expanded, setExpanded] = useState(new Set())
  // 화면 보기 모드 — 'single'(단일) | 'two_col'(2단) | 'list'(리스트와 함께
  // 보기: 좌측 안건 목록 + 우측 상세). 저장되어 새로고침해도 유지된다.
  const [viewMode, setViewMode] = useState('single')
  const twoColPreview = viewMode === 'two_col'
  const listView = viewMode === 'list'
  // 리스트와 함께 보기에서 우측에 띄울 안건의 index. 선택이 사라지지 않게
  // 안건 수가 바뀌면 0 으로 클램프(아래 effect).
  const [selectedListIdx, setSelectedListIdx] = useState(0)
  // 알려진 그룹 목록 = 현재 items 안의 distinct non-empty group_name +
  // 사용자가 "그룹 추가" 로 만들어둔 빈 그룹(아직 안건이 안 들어간). 빈
  // 그룹은 로컬 state 라 저장 후엔 사라짐 — 사용자가 빈 그룹을 만든 뒤
  // 적어도 한 안건을 그쪽으로 옮겨야 영구 보존.
  // 이 두 hook 은 반드시 early-return 위에 있어야 한다 — draft 가 아직
  // null 인 첫 render 와 로드된 두 번째 render 사이에서 hook 수가 달라지면
  // React 의 "Rendered more hooks than during the previous render" 가 터짐.
  // 양식에서 시작한 경우 — NewCompositeDialog 가 navigate 시 state.seedGroups
  // 로 빈 그룹 골격을 실어 보낸다(빈 그룹은 DB 에 못 들어가 pendingGroups 로만
  // 존재). 사용자가 각 그룹에 안건을 채우고 저장하면 그제서야 영구 보존된다.
  const [pendingGroups, setPendingGroups] = useState(
    () => location.state?.seedGroups ?? [],
  )
  const knownGroups = useMemo(() => {
    const set = new Set()
    for (const it of draft?.items ?? []) {
      if (it.group_name) set.add(it.group_name)
    }
    for (const g of pendingGroups) set.add(g)
    return [...set]
  }, [draft, pendingGroups])

  // Workspace section taxonomy — used by the DOCX exporter so long-text
  // widgets emit "[단락구분] : 제목" headers (same convention as the
  // single-report exporter). Without this, the composite export would
  // collapse to bare titles because the renderer's section lookup map
  // is empty.
  const { itemByCode: sectionItemByCode } = useSectionTaxonomy()

  // Snapshot existing → draft when the row loads or after a successful save.
  useEffect(() => {
    if (composite) {
      // 보기 모드는 저장값으로 복원 — view_mode 우선, 없으면 레거시
      // two_col_view 로 폴백(true → 2단). 새로고침해도 유지.
      const restoredViewMode =
        composite.view_mode ??
        (composite.two_col_view ? 'two_col' : 'single')
      setViewMode(restoredViewMode)
      // "모두 펼치기/접기" 상태 복원 — default_expanded 가 true 면 모든 안건을
      // 펼친 상태로 시작. 인라인 펼침은 단일·2단 보기에서 쓰이고(리스트는
      // 좌목록+우상세라 해당 없음). 새로고침 후에도 유지.
      if (composite.default_expanded && restoredViewMode !== 'list') {
        setExpanded(new Set(composite.items.map((_, i) => i)))
      } else {
        setExpanded(new Set())
      }
      // 저장된 그룹 골격(빈 그룹 포함)을 pendingGroups 로 복원한다. 빈 그룹은
      // 어떤 안건도 참조하지 않아 items 만으로는 못 살리므로 여기서 시딩.
      // 현재 로컬 pendingGroups(미저장 추가분)와 합집합으로 둬 로드 중에도
      // 안 잃게 한다. knownGroups 가 다시 distinct 처리하므로 중복은 무해.
      if (Array.isArray(composite.groups)) {
        setPendingGroups((prev) => {
          const merged = new Set([...composite.groups, ...prev])
          return [...merged]
        })
      }
      setDraft({
        title: composite.title,
        kind: composite.kind,
        period_date: composite.period_date ?? '',
        description: composite.description ?? '',
        summary_widgets: composite.summary_widgets ?? [],
        items: composite.items.map((it) => ({
          // Server-side `id` is preserved on round-trip; new items omit it.
          note: it.note ?? '',
          ref_report_id: it.item_type === 'report' ? it.ref_report?.id : null,
          ref_composite_id: it.item_type === 'composite' ? it.ref_composite?.id : null,
          display_column: it.display_column ?? 1,
          group_name: it.group_name ?? null,
          // Cached display info for the table (not sent on save).
          _display: it,
        })),
      })
    }
  }, [composite])

  const workspaceName = useMemo(() => {
    const map = new Map((workspaces ?? []).map((w) => [w.slug, w.name]))
    return (s) => map.get(s) ?? s
  }, [workspaces])

  // "다른 종합보고에 제출" 다이얼로그. 제출 큐는 보고서 기반 안건만 받으므로
  // (중첩 종합보고·원본삭제 안건은 제외) 후보를 여기서 미리 추려 둔다.
  const [submitItemsOpen, setSubmitItemsOpen] = useState(false)
  const submittableItems = useMemo(() => {
    return (draft?.items ?? [])
      .map((it) => {
        const m = itemMeta(it, workspaceName)
        const reportId = it.ref_report_id ?? m.ref?.id ?? null
        if (!m.isReport || m.sourceDeleted || !reportId) return null
        const bits = [m.dept, m.author, m.date].filter(Boolean)
        return {
          reportId,
          title: m.title ?? `보고서 #${reportId}`,
          subtitle: bits.join(' · ') || null,
        }
      })
      .filter(Boolean)
  }, [draft?.items, workspaceName])

  // 리스트 보기 선택 index 를 안건 수 범위로 클램프(삭제 등으로 깨지지 않게).
  const itemCount = draft?.items?.length ?? 0
  useEffect(() => {
    setSelectedListIdx((i) => (itemCount === 0 ? 0 : Math.min(i, itemCount - 1)))
  }, [itemCount])

  if (loading || !draft || !composite) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-48" />
      </div>
    )
  }
  if (error) {
    return (
      <div className="p-6">
        <ErrorState description={error.message} onRetry={reload} />
      </div>
    )
  }

  async function onSave() {
    try {
      await updateComposite(composite.id, {
        title: draft.title,
        kind: draft.kind,
        period_date: draft.kind === 'recurring' ? draft.period_date || null : null,
        description: draft.description ?? '',
        view_mode: viewMode,
        // 레거시 boolean 도 함께 동기화(혹시 모를 구버전 리더 대비).
        two_col_view: viewMode === 'two_col',
        summary_widgets: draft.summary_widgets ?? [],
        // 그룹 골격(빈 그룹 포함) — knownGroups 는 안건의 group_name +
        // 사용자가 만든 빈 그룹(pendingGroups). 이걸 보내야 안건 없는 빈
        // 그룹도 저장·복원된다(예전엔 item group_name 으로만 존재해 휘발).
        groups: knownGroups,
        items: draft.items.map((it) => ({
          note: it.note,
          ref_report_id: it.ref_report_id,
          ref_composite_id: it.ref_composite_id,
          display_column: it.display_column ?? 1,
          group_name: it.group_name || null,
        })),
        // 낙관적 동시성 — 내가 불러온 revision. 그 사이 다른 사람이 안건을
        // 추가/정리했으면 서버가 409 로 거절(덮어쓰기 방지).
        expected_revision: composite.revision,
      })
      toast.success('저장되었습니다.')
      setIsEditing(false)
      reload()
    } catch (err) {
      // 409 = 다른 사람이 먼저 저장 — 최신본을 다시 불러오게 안내.
      if (err?.response?.status === 409) {
        toast.error(
          '다른 사용자가 먼저 저장했습니다. 최신 내용을 다시 불러옵니다 — 변경분을 확인 후 다시 저장하세요.',
        )
        setIsEditing(false)
        reload()
        return
      }
      toast.error(err?.response?.data?.message || err.message || '저장 실패')
    }
  }

  async function onDelete() {
    try {
      await deleteComposite(composite.id)
      toast.success('삭제되었습니다.')
      navigate(`/w/${slug}/composites`)
    } catch (err) {
      toast.error(err.message || '삭제 실패')
    }
  }

  /** Clone the current composite into a new draft owned by the current
   *  user. Items (ref_report_id / ref_composite_id / note / display_column)
   *  carry over verbatim — published snapshots intentionally do NOT, so the
   *  copy starts as a live composite even when the source was 발행됨.
   *  period_date for recurring resets to today (same convention as report
   *  copy resetting report_date). New title comes from the dialog input;
   *  workspace stays the same as the source so the copy lives next to the
   *  original. After creation we navigate to the new composite. */
  async function onCopy(newTitle) {
    if (!composite) return
    try {
      const created = await createComposite({
        workspace_slug: composite.workspace_slug,
        title: newTitle,
        kind: composite.kind,
        period_date:
          composite.kind === 'recurring'
            ? new Date().toISOString().slice(0, 10)
            : null,
        description: composite.description ?? '',
        summary_widgets: composite.summary_widgets ?? [],
        // 보기 설정도 복사본에 그대로 — 모두 펼치기/접기 기본값 유지.
        default_expanded: composite.default_expanded ?? false,
        // 빈 그룹 골격도 복사본에 그대로 — 안건 없는 그룹이 사라지지 않게.
        groups: composite.groups ?? [],
        items: composite.items.map((it) => ({
          note: it.note ?? '',
          ref_report_id:
            it.item_type === 'report' ? it.ref_report?.id : null,
          ref_composite_id:
            it.item_type === 'composite' ? it.ref_composite?.id : null,
          display_column: it.display_column ?? 1,
          group_name: it.group_name || null,
        })),
      })
      toast.success('종합보고가 복사되었습니다.')
      setCopyOpen(false)
      // Navigate using the server-returned slug — same defensive move
      // ReportDetailPage uses, since the copy could land in a different
      // workspace if the user's permissions changed mid-request.
      navigate(`/w/${created.workspace_slug}/composites/${created.id}`)
    } catch (err) {
      toast.error(err?.response?.data?.message || err.message || '복사 실패')
      throw err
    }
  }

  /** Snapshot the 요약(summary widgets) + 그룹 골격 + 보기설정 into a reusable
   *  양식. 안건(item refs) are intentionally not captured. `knownGroups`
   *  carries empty scaffold groups (pendingGroups) too, so the skeleton
   *  survives even when a group has no items yet. 요약·보기설정·설명은
   *  서버가 저장된 종합보고(source_composite_id)에서 읽으므로, 미저장 편집이
   *  있으면 먼저 저장한 뒤 양식으로 저장한다. */
  async function onSavePreset(name, description, ownerWorkspaceSlugs) {
    if (!composite) return
    try {
      await createCompositePreset({
        source_composite_id: composite.id,
        name,
        description: description ?? '',
        owner_workspace_slugs: ownerWorkspaceSlugs,
        groups: knownGroups,
      })
      toast.success('양식으로 저장되었습니다.')
      setSavePresetOpen(false)
    } catch (err) {
      toast.error(err?.response?.data?.message || err.message || '양식 저장 실패')
      throw err
    }
  }

  function addItems(newItems) {
    const existingKeys = new Set(
      draft.items.map((it) =>
        it.ref_report_id
          ? `r:${it.ref_report_id}`
          : `c:${it.ref_composite_id}`,
      ),
    )
    const additions = newItems.filter((it) => {
      const k = it.ref_report_id ? `r:${it.ref_report_id}` : `c:${it.ref_composite_id}`
      return !existingKeys.has(k)
    })
    // Auto-assign display_column alternating 1 ↔ 2 so a multi-item
    // add fills both Word-export columns instead of stacking
    // everything in col 1. Seed from the last existing item's column
    // so a prior manual reassignment is respected on the next add
    // (last in col 2 → next added starts at col 1, and so on).
    const lastCol =
      draft.items.length > 0
        ? (draft.items[draft.items.length - 1].display_column ?? 1)
        : 2 // sentinel so the very first added item lands in col 1
    let nextCol = lastCol === 1 ? 2 : 1
    const additionsWithCol = additions.map((it) => {
      const placed = {
        ...it,
        display_column: it.display_column ?? nextCol,
      }
      nextCol = nextCol === 1 ? 2 : 1
      return placed
    })
    setDraft({ ...draft, items: [...draft.items, ...additionsWithCol] })
  }
  function removeItem(idx) {
    setDraft({ ...draft, items: draft.items.filter((_, i) => i !== idx) })
  }
  function moveItem(idx, dir) {
    const next = [...draft.items]
    const j = idx + dir
    if (j < 0 || j >= next.length) return
    ;[next[idx], next[j]] = [next[j], next[idx]]
    setDraft({ ...draft, items: next })
  }
  // Drag-and-drop reorder (HTML5 native — same pattern as FolderSidebar
  // for consistency with the rest of the app). "Drop on row X" = insert
  // before X; dragging down through the splice math is the only edge
  // case worth noting. (State for this lives up with the other useState
  // calls — see comment there about hook order vs early returns.)
  // 안건 위에 드롭 → 그 위치로 이동 + 그 안건의 그룹을 따라간다(targetGroup).
  // 그룹 안건 위에 떨어뜨리면 그 그룹에 합류하고, 그룹 없는 안건 위면 그룹
  // 해제 — "떨어뜨린 곳의 그룹을 가진다"는 일관된 모델.
  function reorderItems(fromIdx, toIdx, targetGroup) {
    if (fromIdx === toIdx) return
    setDraft((d) => {
      if (!d) return d
      const next = [...d.items]
      const [moved] = next.splice(fromIdx, 1)
      // splice removal shifts later indices down by 1, so when moving
      // down (from < to) the target idx loses 1. Without this, dragging
      // A → C in [A, B, C, D] lands as [B, C, A, D] instead of [B, A,
      // C, D] which is what "drop on C" means visually.
      const adjustedToIdx = fromIdx < toIdx ? toIdx - 1 : toIdx
      next.splice(adjustedToIdx, 0, { ...moved, group_name: targetGroup ?? null })
      return { ...d, items: next }
    })
  }
  function setItemNote(idx, note) {
    const next = draft.items.map((it, i) => (i === idx ? { ...it, note } : it))
    setDraft({ ...draft, items: next })
  }
  function setItemColumn(idx, col) {
    const next = draft.items.map((it, i) =>
      i === idx ? { ...it, display_column: col } : it,
    )
    setDraft({ ...draft, items: next })
  }
  // 2단 미리보기 전용 드롭 — 다른 안건 위에 떨어뜨리면 그 안건의 열·그룹을
  // 함께 따라간다(display_column + group_name).
  function reorderItemsToColumn(fromIdx, toIdx, targetCol, targetGroup) {
    if (fromIdx == null) return
    setDraft((d) => {
      if (!d) return d
      const next = [...d.items]
      const [moved] = next.splice(fromIdx, 1)
      const adjustedToIdx = fromIdx < toIdx ? toIdx - 1 : toIdx
      next.splice(adjustedToIdx, 0, {
        ...moved,
        display_column: targetCol,
        group_name: targetGroup ?? null,
      })
      return { ...d, items: next }
    })
  }
  // 빈 그룹 박스(또는 그룹 영역)에 드롭 → 그 그룹으로 합류. 그 그룹의 마지막
  // 안건 뒤(연속 그룹 유지)에, 비어 있으면 맨 끝에 삽입.
  function assignDraggedToGroup(groupName) {
    if (draggingIdx == null) return
    const from = draggingIdx
    setDraft((d) => {
      if (!d) return d
      const items = [...d.items]
      const [moved] = items.splice(from, 1)
      let insertAt = items.length
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].group_name === groupName) {
          insertAt = i + 1
          break
        }
      }
      items.splice(insertAt, 0, { ...moved, group_name: groupName })
      return { ...d, items }
    })
    setDraggingIdx(null)
    setDropOverIdx(null)
  }
  // 2단 미리보기 전용 — 빈 열(또는 열의 빈 영역)에 떨어뜨리면 그 열로
  // 옮긴다. 드롭한 열이 속한 섹션의 그룹(groupName)을 함께 받아 그 그룹의
  // 마지막 안건 뒤에 삽입한다 — 그래야 안건이 다른 섹션 끝이 아니라 실제로
  // 그 빈 열에 들어간다. 그 그룹에 안건이 하나도 없으면 맨 끝에.
  function handleDropToColumn(col, groupName = null) {
    if (draggingIdx == null) return
    const from = draggingIdx
    const targetGroup = groupName || null
    setDraft((d) => {
      if (!d) return d
      const items = [...d.items]
      const [moved] = items.splice(from, 1)
      let insertAt = items.length
      for (let i = items.length - 1; i >= 0; i--) {
        if ((items[i].group_name || null) === targetGroup) {
          insertAt = i + 1
          break
        }
      }
      items.splice(insertAt, 0, {
        ...moved,
        display_column: col,
        group_name: targetGroup,
      })
      return { ...d, items }
    })
    setDraggingIdx(null)
    setDropOverIdx(null)
  }
  function setItemGroup(idx, groupName) {
    // 빈 문자열은 null 로 정규화 — backend 가 동일 의미 (그룹 없음) 로 처리.
    const normalized = groupName && groupName.trim() ? groupName.trim() : null
    const next = draft.items.map((it, i) =>
      i === idx ? { ...it, group_name: normalized } : it,
    )
    setDraft({ ...draft, items: next })
  }

  // 안건 열기 — 보고서/하위 종합보고 상세로 네비게이션. 항상 종합보고의
  // 워크스페이스(slug)로 보낸다(보고서 home 은 personal 이라 비소유자는 못
  // 봄; 종합보고는 공유 워크스페이스라 안전). 보고서엔 fromComposite 컨텍스트
  // 를 실어 "종합보고로 돌아가기" 버튼이 뜨게 한다.
  function openItem(it) {
    if (it.ref_report_id) {
      navigate(`/w/${slug}/reports/${it.ref_report_id}`, {
        state: {
          fromComposite: { id: composite.id, slug, title: composite.title },
        },
      })
    } else if (it.ref_composite_id) {
      const ws = it._display?.ref_composite?.workspace_slug ?? slug
      navigate(`/w/${ws}/composites/${it.ref_composite_id}`)
    }
  }

  // 보기 모드 전환 — 즉시 저장(새로고침 후 유지). 리스트 보기는 좌목록+우상세라
  // 인라인 펼침이 없어 모두 접는다. 단일·2단은 인라인 펼침을 쓰므로 저장된
  // 펼침 기본값(default_expanded)을 적용한다.
  async function changeViewMode(mode) {
    if (mode === viewMode) return
    setViewMode(mode)
    if (mode === 'list') {
      setExpanded(new Set())
    } else {
      setExpanded(
        composite.default_expanded
          ? new Set(draft.items.map((_, i) => i))
          : new Set(),
      )
    }
    try {
      await updateComposite(composite.id, {
        view_mode: mode,
        two_col_view: mode === 'two_col',
      })
    } catch {
      /* 화면 상태는 유지 */
    }
  }

  // "모두 펼치기/접기" — 즉시 저장(새로고침 후 유지). 현재 전부 펼쳐져 있으면
  // 접고, 아니면 모두 편다. 저장 실패(열람 전용 등)해도 화면 상태는 바뀐다.
  async function toggleExpandAll() {
    const willExpand = expanded.size !== draft.items.length
    setExpanded(
      willExpand ? new Set(draft.items.map((_, i) => i)) : new Set(),
    )
    try {
      await updateComposite(composite.id, { default_expanded: willExpand })
    } catch {
      /* 화면 상태는 유지 */
    }
  }

  // 그룹 순서 변경 — 같은 group_name 연속 블록(섹션) 단위로 인접 섹션과
  // 통째로 swap 한다. dir=-1(위)/+1(아래). 그룹 사이에 "그룹 없음" 구간이
  // 있으면 그 구간과 먼저 swap 되는데, 한 번 더 누르면 다음 그룹을 넘는다.
  function moveGroup(groupName, dir) {
    setDraft((d) => {
      if (!d) return d
      const sections = []
      let cur = null
      for (const it of d.items) {
        const gn = it.group_name || null
        if (!cur || cur.gn !== gn) {
          cur = { gn, items: [] }
          sections.push(cur)
        }
        cur.items.push(it)
      }
      const si = sections.findIndex((s) => s.gn === groupName)
      if (si < 0) return d
      const sj = si + dir
      if (sj < 0 || sj >= sections.length) return d
      ;[sections[si], sections[sj]] = [sections[sj], sections[si]]
      return { ...d, items: sections.flatMap((s) => s.items) }
    })
  }

  // 그룹 순서 드래그 변경 — fromGroup 섹션 블록 전체를 toGroup 자리로 옮긴다.
  // moveGroup(화살표)과 같은 "섹션 = 연속 group_name 블록" 모델이되 인접이 아닌
  // 임의 위치로 바로 이동한다(안건 reorderItems 와 같은 splice 보정). 둘 다 실제
  // 안건이 있는 그룹이어야 함(빈 그룹은 items 에 블록이 없어 순서 개념이 없음).
  function reorderGroups(fromGroup, toGroup) {
    if (!fromGroup || !toGroup || fromGroup === toGroup) return
    setDraft((d) => {
      if (!d) return d
      const sections = []
      let cur = null
      for (const it of d.items) {
        const gn = it.group_name || null
        if (!cur || cur.gn !== gn) {
          cur = { gn, items: [] }
          sections.push(cur)
        }
        cur.items.push(it)
      }
      const fi = sections.findIndex((s) => s.gn === fromGroup)
      const ti = sections.findIndex((s) => s.gn === toGroup)
      if (fi < 0 || ti < 0) return d
      const [moved] = sections.splice(fi, 1)
      const adjusted = fi < ti ? ti - 1 : ti
      sections.splice(adjusted, 0, moved)
      return { ...d, items: sections.flatMap((s) => s.items) }
    })
  }

  // (pendingGroups / knownGroups hooks 는 위쪽 — early-return 앞 — 에 정의)
  function addGroup(name) {
    const trimmed = (name || '').trim()
    if (!trimmed) return
    if (knownGroups.includes(trimmed)) {
      toast.info(`이미 있는 그룹: ${trimmed}`)
      return
    }
    setPendingGroups((prev) => [...prev, trimmed])
  }

  // 그룹 해제 — 그룹 묶음만 없애고 안건 자체는 보존한다. 빈(pending)
  // 그룹이면 로컬 목록에서 빼고, 안건이 들어 있던 그룹이면 그 안건들의
  // group_name 을 null 로 되돌려 "그룹 없음" 으로 흘려보낸다. 안건은
  // 그대로 리스트에 남으므로 비파괴적 — 별도 확인 다이얼로그 없이 처리.
  function removeGroup(name) {
    if (!name) return
    const count = (draft?.items ?? []).filter(
      (it) => it.group_name === name,
    ).length
    setPendingGroups((prev) => prev.filter((g) => g !== name))
    setDraft((d) =>
      d
        ? {
            ...d,
            items: d.items.map((it) =>
              it.group_name === name ? { ...it, group_name: null } : it,
            ),
          }
        : d,
    )
    toast.success(
      count > 0
        ? `그룹 «${name}» 해제 — 안건 ${count}건은 그룹 없음으로 이동`
        : `그룹 «${name}» 삭제`,
    )
  }

  // 그룹 이름 변경 — 같은 group_name 안건들 + pending 그룹을 새 이름으로 일괄
  // 갱신. 빈 이름·동일 이름·기존 그룹과 충돌이면 무시.
  function renameGroup(oldName, newName) {
    const trimmed = (newName || '').trim()
    if (!oldName || !trimmed || trimmed === oldName) return
    if (knownGroups.includes(trimmed)) {
      toast.info(`이미 있는 그룹: ${trimmed}`)
      return
    }
    setPendingGroups((prev) => prev.map((g) => (g === oldName ? trimmed : g)))
    setDraft((d) =>
      d
        ? {
            ...d,
            items: d.items.map((it) =>
              it.group_name === oldName ? { ...it, group_name: trimmed } : it,
            ),
          }
        : d,
    )
  }

  // Phase 5A — publish state + handlers. theme composites stay live by
  // design so we don't surface publish UI for them (publish would only
  // stamp `published_at` without freezing anything — cosmetic only).
  const isPublished = Boolean(composite?.published_at)
  // (docxProgress state lives up top with the other useState calls —
  // see comment there about hook order vs early returns.)

  async function handleExportDocx(layoutChoice) {
    if (!composite) return
    exportAbortRef.current?.abort()
    const controller = new AbortController()
    exportAbortRef.current = controller
    setDocxProgress({ phase: 'start', label: '준비 중...' })
    try {
      const { exportCompositeToDocx } = await import('./exportCompositeToDocx')
      await exportCompositeToDocx({
        composite,
        layout: layoutChoice,
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
      setDocxProgress(null)
      if (exportAbortRef.current === controller) exportAbortRef.current = null
    }
  }

  // HTML export — captures the composite DOM with every item expanded
  // and bundles the cloned tree into a single self-contained .html.
  // Forces all items into the expanded state before capture so the
  // InlineReportView for each item is actually mounted; otherwise the
  // saved file would just show the collapsed item header rows.
  async function handleExportHtml() {
    if (!composite) return
    exportAbortRef.current?.abort()
    const controller = new AbortController()
    exportAbortRef.current = controller
    setHtmlProgress({ phase: 'expand', label: '안건 펼치는 중...' })
    // Force ALL items expanded. Even if some were already expanded,
    // this is a no-op for them and the React commit just adds the rest.
    setExpanded(new Set(draft.items.map((_, i) => i)))
    try {
      // Let React commit the expansion + each InlineReportView mount
      // its content + nested chart widgets do their initial paint. Two
      // RAFs guarantee the commit; the chart-settle poll waits out the
      // ResizeObserver debounce that fires on first paint.
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)),
      )
      if (controller.signal.aborted) throw new DOMException('Export cancelled', 'AbortError')
      setHtmlProgress({ phase: 'settle', label: '차트 렌더링 안정화 중...' })
      await waitForChartsToSettle(5000, controller.signal)
      if (controller.signal.aborted) throw new DOMException('Export cancelled', 'AbortError')
      setHtmlProgress({ phase: 'load', label: '내보내기 모듈 로드 중...' })
      const { exportCompositeToHtml } = await import('./exportCompositeToHtml')
      await exportCompositeToHtml({
        composite,
        title: draft.title,
        onProgress: setHtmlProgress,
        signal: controller.signal,
      })
      toast.success('HTML 파일로 저장했습니다.')
    } catch (err) {
      if (err?.name === 'AbortError') {
        toast.info('HTML 내보내기를 취소했습니다.')
      } else {
        console.error(err)
        // 배포로 청크가 사라진 경우엔 코드 오류가 아니라 낡은 페이지 문제다.
        if (!notifyIfStaleChunk(err, toast, { context: 'HTML 저장' })) {
          toast.error(`HTML 저장 실패: ${err?.message ?? err}`)
        }
      }
    } finally {
      setHtmlProgress(null)
      if (exportAbortRef.current === controller) exportAbortRef.current = null
    }
  }

  // Poll the live DOM at 100ms intervals until no widget is showing
  // the "크기 조정 중…" placeholder. Same logic as the report
  // exporter — composite embeds InlineReportView which mounts the
  // same chart widgets that flash this placeholder during initial
  // ResizeObserver debounce.
  async function waitForChartsToSettle(budgetMs, signal) {
    const root = document.querySelector('.composite-detail-root')
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
        await new Promise((r) => setTimeout(r, 250))
        if (!isResizing()) {
          await new Promise((r) => requestAnimationFrame(r))
          return
        }
        continue
      }
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  const isOwner = me?.user?.id && composite?.owner_user_id === me.user.id
  const isSysAdmin = me?.is_system_admin === true
  const canPublish =
    composite?.kind === 'recurring' && (isOwner || isSysAdmin)
  // 외부 공개/공유 열람자(공유 경로로만 보이는 중)면 백엔드가
  // is_public_view=true / can_edit=false 로 내려준다.
  const isPublicView = composite?.is_public_view === true

  async function handlePublish() {
    try {
      await publishComposite(composite.id)
      toast.success('발행되었습니다. 모든 안건이 현 시점으로 박제됩니다.')
      reload()
    } catch (err) {
      toast.error(err?.response?.data?.message || err.message || '발행 실패')
    }
  }

  async function handleUnpublish() {
    try {
      await unpublishComposite(composite.id)
      toast.success('발행이 취소되었습니다.')
      reload()
    } catch (err) {
      toast.error(err?.response?.data?.message || err.message || '발행 취소 실패')
    }
  }

  return (
    <div className="p-6 space-y-6 composite-detail-root">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          {isEditing ? (
            <Input
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              placeholder="제목"
              className="border-0 px-0 text-2xl font-semibold focus-visible:ring-0 h-auto py-0"
            />
          ) : (
            <h1 className="text-2xl font-semibold truncate">{draft.title}</h1>
          )}
          <div className="mt-1 flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
            <Layers className="h-3 w-3" />
            {isEditing ? (
              <KindToggle
                value={draft.kind}
                onChange={(v) => setDraft({ ...draft, kind: v })}
              />
            ) : (
              <Badge variant={KIND_VARIANT[draft.kind]} className="text-[10px]">
                {KIND_LABEL[draft.kind] ?? draft.kind}
              </Badge>
            )}
            {draft.kind === 'recurring' && (
              <span className="inline-flex items-center gap-1">
                <span>기준일</span>
                {isEditing ? (
                  <Input
                    type="date"
                    value={draft.period_date || ''}
                    onChange={(e) => setDraft({ ...draft, period_date: e.target.value })}
                    className="h-6 w-[140px] px-1.5 text-[11px] font-mono"
                  />
                ) : (
                  <span className="font-mono text-foreground/80">
                    {draft.period_date || '—'}
                  </span>
                )}
              </span>
            )}
            <span>· {workspaceName(composite.workspace_slug)}</span>
            <span>· 안건 {draft.items.length}건</span>
            {composite.is_public && (
              <span
                className="inline-flex items-center gap-1 text-sky-600"
                title="전체 공개됨 (사내 모든 사용자 읽기 가능)"
              >
                · <Globe className="h-3 w-3" /> 전체 공개
              </span>
            )}
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            작성 {composite.owner_name ?? '—'} · {composite.created_at?.slice(0, 10)}
            {composite.updated_at && composite.updated_at !== composite.created_at && (
              <> · 최근 수정 {composite.updated_by_name ?? '—'} · {composite.updated_at?.slice(0, 10)}</>
            )}
          </div>
        </div>
        {/* 액션 버튼 그룹 — HTML export 시 통째로 제거. 편집기 전용
            chrome (목록 이동·편집·발행·Word/HTML 저장·복사·삭제) 은
            저장된 아카이브에서 의미가 없음. */}
        <div data-export-exclude className="flex items-center gap-2 flex-wrap">
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            // 보던 종합보고의 주차/종류로 목록을 복원 — 정기면 그 period_date
            // 주차로, 주제면 주제 탭으로 돌아간다(현재 주차로 튀지 않게).
            navigate(`/w/${slug}/composites`, {
              state: {
                listAnchorDate: composite.period_date ?? null,
                listKind: composite.kind,
              },
            })
          }
        >
          <ArrowLeft className="mr-1 h-3 w-3" />
          목록
        </Button>
        {isEditing ? (
          <>
            <Button variant="outline" size="sm" onClick={onSave}>
              <Save className="mr-1 h-3 w-3" />
              저장
            </Button>
            <Button variant="ghost" size="sm" onClick={() => { setIsEditing(false); reload() }}>
              <X className="mr-1 h-3 w-3" />
              취소
            </Button>
          </>
        ) : (
          <>
            {/* 편집 — recurring 발행 후엔 차단 (보고서 finalized 와 동일
                패턴). 발행 취소 후 편집해야 한다는 흐름을 강제. theme
                은 publish 개념이 없어 항상 편집 가능. 외부 공개 열람자
                (읽기전용)에겐 숨김. */}
            {!isPublicView && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIsEditing(true)}
                disabled={isPublished && composite?.kind === 'recurring'}
                title={
                  isPublished && composite?.kind === 'recurring'
                    ? '발행된 종합보고는 편집할 수 없습니다. 발행 취소 후 수정하세요.'
                    : undefined
                }
              >
                <Pencil className="mr-1 h-3 w-3" />
                편집
              </Button>
            )}
            {/* 발행 / 발행 취소 — recurring + 작성자(또는 sys admin) 만.
                publish 는 그 시점 모든 item 의 ref_report content 를 박제
                → 6개월 뒤 봐도 발행 시점 그대로 보임. */}
            {canPublish && (
              <Button
                variant={isPublished ? 'secondary' : 'default'}
                size="sm"
                onClick={isPublished ? handleUnpublish : handlePublish}
              >
                {isPublished ? '발행 취소' : '발행'}
              </Button>
            )}
            {/* 공유 — 부서(하위 상속)·사용자·전체공개 + 열람/편집. 클릭하면
                팝오버로 그 자리에서 편집, 뱃지로 현재 공유 대상 표시. */}
            {!isPublicView && (
              <SharePopover
                contentType="composites"
                contentId={composite.id}
                ownerUserId={composite.owner_user_id}
                label="공유"
                onChanged={reload}
                triggerClassName="h-8 rounded-md border border-input bg-background px-2.5 hover:bg-accent hover:text-accent-foreground"
              />
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" disabled={Boolean(docxProgress) || Boolean(htmlProgress)}>
                  <FileType2 className="mr-1 h-3 w-3" />
                  Word로 저장
                  <ChevronDown className="ml-1 h-3 w-3 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => handleExportDocx('portrait-1col')}>
                  A4 세로 (한 열)
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => handleExportDocx('landscape-2col')}>
                  A4 가로 (두 열)
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {/* HTML 저장 — 모든 안건을 펼친 상태로 단일 자족 HTML 로
                내보냄. 발행 시점 박제(snapshot_content)나 라이브 fetch
                결과를 그 시점 그대로 보존. */}
            <Button
              variant="outline"
              size="sm"
              onClick={handleExportHtml}
              disabled={Boolean(docxProgress) || Boolean(htmlProgress)}
            >
              <FileType2 className="mr-1 h-3 w-3" />
              HTML로 저장
            </Button>
            {/* 복사 — 일반 보고서의 복사 패턴과 동일. 발행 여부와 무관하게
                항상 가능 (발행은 원본의 상태이고, 사본은 새 draft 로 시작).
                외부 공개 열람자는 자기 부서에 쓰기 권한이 없어 숨김. */}
            {!isPublicView && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCopyOpen(true)}
              >
                <Copy className="mr-1 h-3 w-3" />
                복사
              </Button>
            )}
            {/* 양식으로 저장 — 요약·그룹 골격·보기설정을 이름 붙인 양식으로
                저장해, 새 종합보고를 그 골격으로 시작할 수 있게 한다(보고서
                프리셋과 동형). 안건은 담지 않는다. */}
            {!isPublicView && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSavePresetOpen(true)}
              >
                <Layers className="mr-1 h-3 w-3" />
                양식으로 저장
              </Button>
            )}
            {!isPublicView && (
              <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setConfirmDelete(true)}>
                <Trash2 className="mr-1 h-3 w-3" />
                삭제
              </Button>
            )}
          </>
        )}
        </div>
      </div>

      {/* 조직 간 공개 — 다른 조직의 공개 종합보고를 열람 중일 때. 읽기 전용:
          백엔드가 can_edit=false 로 편집·삭제·복사를 막는다(보고서 공개 배너와
          동형). data-export-exclude 로 export 본문엔 안 들어간다. */}
      {isPublicView && (
        <div
          data-export-exclude
          className="rounded-md border border-sky-200 bg-sky-50 dark:bg-sky-950/30 dark:border-sky-900 px-4 py-2.5 text-sm flex items-center gap-2"
        >
          <span className="text-base">🌐</span>
          <span className="font-medium shrink-0 text-sky-900 dark:text-sky-100">
            다른 조직의 공개 종합보고 · 읽기 전용
          </span>
          <span className="flex-1 min-w-0 truncate text-sky-800/80 dark:text-sky-200/70 text-xs">
            {composite?.owner_name ? `${composite.owner_name} 작성 — ` : ''}
            내용만 열람할 수 있습니다. 편집·복사·삭제는 비활성화됩니다.
          </span>
        </div>
      )}

      {/* 공개 상태 배너 — 멤버가 자기 종합보고의 공개 여부를 한눈에. */}
      {/* 발행 배너 — recurring 발행 후만. 보고서의 phase=finalized 배너와
          비슷한 패턴. 발행 시각 + 누가 발행했는지 + 박제 의미 안내. */}
      {isPublished && composite?.kind === 'recurring' && (
        <div className="rounded-md border border-blue-200 bg-blue-50 dark:bg-blue-950/30 dark:border-blue-900 px-4 py-2.5 text-sm">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className="text-[10px]">발행됨</Badge>
            <span className="text-foreground/80">
              {composite.published_at?.slice(0, 16).replace('T', ' ')}
              {composite.published_by_name &&
                ` · ${composite.published_by_name}`}
            </span>
            <span className="text-xs text-muted-foreground">
              이 시점의 안건 내용이 박제되어 있어 원본이 수정되어도 여기 표시는 그대로 유지됩니다.
            </span>
          </div>
        </div>
      )}

      <Card>
        <CardContent className="pt-5 space-y-2">
          <div className="text-xs font-semibold text-muted-foreground">설명</div>
          {isEditing ? (
            <Textarea
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              placeholder="이 종합보고의 맥락·요약을 자유롭게 작성하세요"
              rows={4}
            />
          ) : draft.description ? (
            <div className="text-sm whitespace-pre-wrap">{draft.description}</div>
          ) : (
            <div className="text-sm text-muted-foreground italic">설명 없음</div>
          )}
        </CardContent>
      </Card>

      {/* 요약 페이지 — 설명과 포함된 안건 사이. 보기 모드에서 위젯이 없으면
          (CompositeSummary 내부에서) 카드째 숨겨 빈 영역이 생기지 않게 한다. */}
      {(isEditing || (draft.summary_widgets ?? []).length > 0) && (
        <Card>
          <CardContent className="pt-5 space-y-2">
            <div className="text-xs font-semibold text-muted-foreground">
              요약
            </div>
            <CompositeSummary
              widgets={draft.summary_widgets ?? []}
              editing={isEditing}
              onChange={(next) =>
                setDraft((d) => ({ ...d, summary_widgets: next }))
              }
            />
          </CardContent>
        </Card>
      )}

      {/* 제출 대기 — 보고서 쪽에서 올라온 안건 신청을 작성자가 승인/반려.
          pending 이 없으면 패널 자체가 렌더 안 됨. */}
      <PendingRequestsPanel
        compositeId={composite.id}
        canDecide={Boolean(composite.can_decide_requests)}
        onAfterAccept={reload}
      />

      <Card>
        <CardContent className="pt-5 space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <div className="text-sm font-semibold">포함된 안건</div>
              <div className="text-[11px] text-muted-foreground">
                보고서를 선택해 추가
              </div>
            </div>
            <div data-export-exclude className="flex items-center gap-2">
              {draft.items.length > 0 && (
                <>
                  {/* 보기 모드 전환(단일/2단/리스트)은 편집모드에서만 — 보기
                      모드에서 바꿀 수 있으면 "설정"인지 "임시"인지 헷갈린다.
                      저장된 view_mode 로 보기 모드에선 그대로 렌더만 한다. */}
                  {isEditing && (
                    <div className="inline-flex rounded-md border p-0.5">
                      {[
                        { v: 'single', label: '단일' },
                        { v: 'two_col', label: '2단' },
                        { v: 'list', label: '리스트' },
                      ].map((opt) => (
                        <button
                          key={opt.v}
                          type="button"
                          onClick={() => changeViewMode(opt.v)}
                          className={cn(
                            'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                            viewMode === opt.v
                              ? 'bg-primary text-primary-foreground'
                              : 'text-muted-foreground hover:bg-muted',
                          )}
                          title={
                            opt.v === 'single'
                              ? '단일 보기 — 안건을 한 열로'
                              : opt.v === 'two_col'
                                ? '2단 보기 — 1열/2열 배치를 좌·우 그리드로'
                                : '리스트와 함께 보기 — 좌측 목록 + 우측 상세'
                          }
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  )}
                  {!listView && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={toggleExpandAll}
                  >
                    {expanded.size === draft.items.length ? (
                      <>
                        <ChevronRight className="mr-1 h-3 w-3" />
                        모두 접기
                      </>
                    ) : (
                      <>
                        <ChevronDown className="mr-1 h-3 w-3" />
                        모두 펼치기
                      </>
                    )}
                  </Button>
                  )}
                </>
              )}
              {/* 다른 종합보고에 제출 — 이 종합보고의 보고서 기반 안건 중
                  몇 개를 골라 상위/다른 종합보고에 안건으로 올린다(승인 큐).
                  편집모드와 무관(출발 종합보고는 안 바뀜). 외부 공개 열람자는
                  제외, 후보 안건이 하나도 없으면 숨김. */}
              {submittableItems.length > 0 && !isPublicView && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setSubmitItemsOpen(true)}
                  title="이 종합보고의 안건을 골라 다른 종합보고에 제출"
                >
                  <Send className="mr-1 h-3 w-3" />
                  다른 종합보고에 제출
                </Button>
              )}
              {isEditing && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setAddGroupOpen(true)}
                    title="안건들을 묶을 그룹 (Word 출력 시 [그룹명] 헤더로 표시)"
                  >
                    <Plus className="mr-1 h-3 w-3" />
                    그룹 추가
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setPickerOpen(true)}>
                    <Plus className="mr-1 h-3 w-3" />
                    안건 추가
                  </Button>
                </>
              )}
            </div>
          </div>
          {draft.items.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              아직 추가된 안건이 없습니다.
            </p>
          ) : listView ? (
            <CompositeListView
              items={draft.items}
              editing={isEditing}
              workspaceName={workspaceName}
              selectedIdx={selectedListIdx}
              onSelect={setSelectedListIdx}
              onOpenItem={openItem}
              onMoveGroup={moveGroup}
              onRenameGroup={renameGroup}
              onRemoveGroup={removeGroup}
              draggingGroup={draggingGroup}
              dropOverGroup={dropOverGroup}
              onReorderGroups={reorderGroups}
              setDraggingGroup={setDraggingGroup}
              setDropOverGroup={setDropOverGroup}
            />
          ) : (
            <ItemsListContainer
              twoColPreview={twoColPreview}
              items={draft.items}
              editing={isEditing}
              pendingGroups={pendingGroups}
              onRemoveGroup={removeGroup}
              onRenameGroup={renameGroup}
              onMoveGroup={moveGroup}
              onAssignToGroup={assignDraggedToGroup}
              draggingIdx={draggingIdx}
              onDropToColumn={handleDropToColumn}
              draggingGroup={draggingGroup}
              dropOverGroup={dropOverGroup}
              onReorderGroups={reorderGroups}
              setDraggingGroup={setDraggingGroup}
              setDropOverGroup={setDropOverGroup}
            >
              {draft.items.map((it, idx) => (
                <ItemRow
                  key={`${it.ref_report_id ?? ''}-${it.ref_composite_id ?? ''}-${idx}`}
                  item={it}
                  index={idx}
                  // 2단 미리보기에서는 행이 카드처럼 보이도록 inline-card
                  // 스타일로 분기. 단일 보기는 기존 divide-y 동작 유지.
                  compactCard={twoColPreview}
                  editing={isEditing}
                  expanded={expanded.has(idx)}
                  onToggleExpand={() => {
                    setExpanded((prev) => {
                      const next = new Set(prev)
                      if (next.has(idx)) next.delete(idx)
                      else next.add(idx)
                      return next
                    })
                  }}
                  workspaceName={workspaceName}
                  onMoveUp={() => moveItem(idx, -1)}
                  onMoveDown={() => moveItem(idx, +1)}
                  onRemove={() => removeItem(idx)}
                  onChangeNote={(n) => setItemNote(idx, n)}
                  displayColumn={it.display_column ?? 1}
                  onSetColumn={(c) => setItemColumn(idx, c)}
                  groupName={it.group_name ?? null}
                  knownGroups={knownGroups}
                  onSetGroup={(g) => setItemGroup(idx, g)}
                  isDragging={draggingIdx === idx}
                  itemDragActive={draggingIdx !== null}
                  isDropTarget={
                    dropOverIdx === idx &&
                    draggingIdx !== null &&
                    draggingIdx !== idx
                  }
                  onDragStart={() => setDraggingIdx(idx)}
                  onDragOver={() => {
                    if (draggingIdx !== null && dropOverIdx !== idx) {
                      setDropOverIdx(idx)
                    }
                  }}
                  onDrop={() => {
                    if (draggingIdx !== null) {
                      // 대상 안건의 그룹(+2단이면 열)을 따라가도록 함께 이동.
                      const targetGroup = it.group_name ?? null
                      if (twoColPreview) {
                        reorderItemsToColumn(
                          draggingIdx,
                          idx,
                          it.display_column === 2 ? 2 : 1,
                          targetGroup,
                        )
                      } else {
                        reorderItems(draggingIdx, idx, targetGroup)
                      }
                    }
                    setDraggingIdx(null)
                    setDropOverIdx(null)
                  }}
                  onDragEnd={() => {
                    setDraggingIdx(null)
                    setDropOverIdx(null)
                  }}
                  onOpen={() => openItem(it)}
                  total={draft.items.length}
                />
              ))}
            </ItemsListContainer>
          )}
        </CardContent>
      </Card>

      <ItemPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        existingItems={draft.items}
        onPick={(items) => {
          addItems(items)
          setPickerOpen(false)
        }}
      />

      {/* 안건 → 다른 종합보고 제출. 신청 큐라 출발 종합보고 자체는 안 바뀌어
          reload 불필요 — 닫기만. 현재 종합보고는 대상 목록에서 제외. */}
      {submitItemsOpen && submittableItems.length > 0 && (
        <SubmitCompositeItemsDialog
          items={submittableItems}
          excludeCompositeId={composite.id}
          onClose={() => setSubmitItemsOpen(false)}
        />
      )}

      <AddGroupDialog
        open={addGroupOpen}
        onOpenChange={setAddGroupOpen}
        existingGroups={knownGroups}
        onAdd={(name) => {
          addGroup(name)
          setAddGroupOpen(false)
        }}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="종합보고 삭제"
        description="이 종합보고를 삭제하시겠습니까? 묶인 안건의 원본 보고서는 그대로 유지됩니다."
        confirmLabel="삭제"
        variant="destructive"
        onConfirm={onDelete}
      />

      <CompositeCopyDialog
        open={copyOpen}
        onOpenChange={setCopyOpen}
        sourceTitle={composite.title}
        sourceKind={composite.kind}
        onConfirm={onCopy}
      />

      <CompositeSavePresetDialog
        open={savePresetOpen}
        onOpenChange={setSavePresetOpen}
        sourceTitle={composite.title}
        groupCount={knownGroups.length}
        summaryCount={(draft.summary_widgets ?? []).length}
        orgWorkspaces={(workspaces ?? []).filter(
          (w) => w.kind === 'org' && !w.virtual,
        )}
        onConfirm={onSavePreset}
      />

      {docxProgress && (
        <DocxExportOverlay
          title="Word 파일로 저장 중"
          progress={docxProgress}
          onCancel={() => exportAbortRef.current?.abort()}
        />
      )}
      {htmlProgress && (
        <DocxExportOverlay
          title="HTML 파일로 저장 중"
          progress={htmlProgress}
          onCancel={() => exportAbortRef.current?.abort()}
        />
      )}
    </div>
  )
}

/** Asks the user for the new title before kicking off a copy. Pre-fills
 *  '{원본} 사본' so the common case is one Enter; trims and rejects empty.
 *  Mirrors ReportDetailPage's ReportCopyDialog — kept local to the
 *  composites module since the wording / hint copy differs slightly
 *  (recurring 의 period_date 도 오늘로 리셋된다는 안내). */
function CompositeCopyDialog({ open, onOpenChange, sourceTitle, sourceKind, onConfirm }) {
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
          <DialogTitle>종합보고 복사</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="composite-copy-title" className="text-sm font-medium">
              새 종합보고 제목
            </label>
            <Input
              id="composite-copy-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="새 제목"
              autoFocus
              required
            />
            <p className="text-[11px] text-muted-foreground">
              안건·설명·열 배치는 그대로 복사되며, 작성인은 현재 사용자로
              설정됩니다.
              {sourceKind === 'recurring'
                ? ' 정기 기준일은 오늘로, 발행 상태는 초기화됩니다.'
                : ''}
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

/** "양식으로 저장" — 요약·그룹 골격·보기설정을 이름 붙인 양식으로 스냅샷.
 *  ReportSavePresetDialog 와 동형이되 템플릿 바인딩 안내가 없다(종합보고는
 *  템플릿에 묶이지 않음). 공개 범위는 전사(null) 또는 특정 조직 트리([slug]). */
function CompositeSavePresetDialog({
  open,
  onOpenChange,
  sourceTitle,
  groupCount,
  summaryCount,
  orgWorkspaces,
  onConfirm,
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  // 공개 범위 = 소유 조직 slug 집합. 비어 있으면 전사 공개(모든 조직).
  const [scopeSlugs, setScopeSlugs] = useState(() => new Set())
  const toggleScope = (slug) =>
    setScopeSlugs((prev) => {
      const next = new Set(prev)
      if (next.has(slug)) next.delete(slug)
      else next.add(slug)
      return next
    })
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (open) {
      const base = (sourceTitle ?? '').trim()
      setName(base ? `${base} 양식` : '')
      setDescription('')
      setScopeSlugs(new Set())
      setSubmitting(false)
    }
  }, [open, sourceTitle])

  async function handleSubmit(e) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    setSubmitting(true)
    try {
      // 전사 = null, 특정 조직(들) = slug 배열
      await onConfirm(
        trimmed,
        description.trim(),
        scopeSlugs.size ? [...scopeSlugs] : null,
      )
    } catch {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>양식으로 저장</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="composite-preset-name" className="text-sm font-medium">
              양식 이름
            </label>
            <Input
              id="composite-preset-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="예: 개발본부 주간 종합 양식"
              autoFocus
              required
            />
            <p className="text-[11px] text-muted-foreground">
              현재 종합보고의 요약 {summaryCount}개 · 그룹 {groupCount}개 골격과
              보기 설정이 양식에 담깁니다. 안건은 포함되지 않습니다 — 새 종합보고를
              이 양식으로 시작할 수 있습니다.
            </p>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="composite-preset-desc" className="text-sm font-medium">
              설명 (선택)
            </label>
            <Textarea
              id="composite-preset-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="이 양식을 언제 쓰는지 간단히"
              rows={2}
              className="resize-none text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <span className="text-sm font-medium">공개 범위</span>
            <WorkspaceTreeSelect
              orgWorkspaces={orgWorkspaces}
              selected={scopeSlugs}
              onToggle={toggleScope}
              autoExpandSlugs={[...scopeSlugs]}
              searchPlaceholder="부서명 / slug 검색 (비우면 트리 보기)"
              maxHeightClass="max-h-52"
            />
            <p className="text-[11px] text-muted-foreground">
              고른 조직(들)의 트리에서만 이 양식이 보입니다. 아무 것도 고르지 않으면 전사 공개(모든 조직).
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
              {submitting ? '저장 중...' : '양식으로 저장'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Centered blocking spinner during a long-running composite export
 *  (Word or HTML). Same shape as ReportDetailPage`s overlay — pulled
 *  inline to avoid cross-module import. `title` differentiates the
 *  exporter; progress bar shows whenever `total > 0`.
 *  data-export-overlay marker keeps the overlay out of any DOM clone
 *  (HTML exporter strips matching elements) so the saved file doesn`t
 *  carry the spinner / dim backdrop. */
function DocxExportOverlay({ title, progress, onCancel }) {
  const total = Number.isFinite(progress?.total) ? progress.total : 0
  const current = Number.isFinite(progress?.current) ? progress.current : 0
  const pct = total > 0 ? Math.round((current / total) * 100) : null
  return (
    <div
      data-export-overlay
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 backdrop-blur-sm"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="rounded-lg border bg-card shadow-xl px-6 py-5 min-w-[280px] max-w-sm">
        <div className="flex items-center gap-3 mb-2">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
          <div className="font-semibold text-sm">{title ?? '저장 중'}</div>
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
        {/* 취소 버튼 — 클릭 시 AbortController.abort() → exporter 의
            checkpoint 에서 AbortError. 다음 체크포인트까지의 지연만
            (대개 < 1 widget 캡처) 있고 즉시 멈춤. */}
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

function KindToggle({ value, onChange }) {
  return (
    <div className="inline-flex rounded border bg-background overflow-hidden h-6">
      {KINDS.map((k) => (
        <button
          key={k.value}
          type="button"
          onClick={() => onChange(k.value)}
          className={
            'px-2 text-[11px] transition-colors ' +
            (value === k.value
              ? 'bg-primary/10 text-primary font-medium'
              : 'text-muted-foreground hover:bg-muted')
          }
        >
          {k.label}
        </button>
      ))}
    </div>
  )
}

/** 그룹 추가 다이얼로그 — 이름 입력 → 부모의 addGroup 호출. 동일 이름
 *  중복 / 빈 문자열은 부모쪽 addGroup 에서 처리. dialog 자체는 단순
 *  text input + 엔터/제출 버튼. */
function AddGroupDialog({ open, onOpenChange, existingGroups, onAdd }) {
  const [name, setName] = useState('')
  useEffect(() => {
    if (open) setName('')
  }, [open])
  function submit(e) {
    e?.preventDefault?.()
    const trimmed = name.trim()
    if (!trimmed) return
    onAdd?.(trimmed)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>그룹 추가</DialogTitle>
          <DialogDescription>
            안건들을 묶을 그룹 이름을 입력하세요. Word 출력 시 그 그룹의
            첫 안건 직전에 <code className="font-mono text-xs">[그룹명]</code>
            한 줄이 헤더로 들어갑니다.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="예: 1팀 주간 / 본부 종합 / 기획"
            maxLength={128}
            autoFocus
          />
          {existingGroups && existingGroups.length > 0 && (
            <div className="text-[11px] text-muted-foreground">
              기존 그룹: {existingGroups.join(' · ')}
            </div>
          )}
          <DialogFooter className="pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              취소
            </Button>
            <Button type="submit" disabled={!name.trim()}>
              추가
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** 안건 리스트 컨테이너 — 토글에 따라 두 가지 레이아웃:
 *
 *  - twoColPreview=false (기본): `<ul className="divide-y">` 단일 칼럼.
 *    기존 동작 그대로.
 *  - twoColPreview=true: `grid grid-cols-2` — display_column 기준으로
 *    children 을 좌/우 두 칼럼에 분배. 각 칼럼 안에서는 원래 순서 유지.
 *    Word 가로 2단 출력과 동일한 흐름 시각화.
 *
 *  children 의 순서/index 는 부모가 보내준 그대로 (원본 items 배열의
 *  index) — 각 ItemRow 의 displayColumn prop 를 보고 분배. ItemRow 자체
 *  의 moveItem 콜백은 원본 index 를 쓰므로 미리보기 모드에서 ↑↓ 클릭도
 *  여전히 전체 순서를 기준으로 동작한다. */
function ItemsListContainer({
  twoColPreview,
  items,
  children,
  editing,
  pendingGroups,
  onRemoveGroup,
  onRenameGroup,
  onMoveGroup,
  onAssignToGroup,
  draggingIdx,
  onDropToColumn,
  draggingGroup,
  dropOverGroup,
  onReorderGroups,
  setDraggingGroup,
  setDropOverGroup,
}) {
  // 그룹 섹션(헤더)에 붙일 드롭 핸들러 — 다른 그룹을 이 그룹 위로 끌어오면
  // 그 자리로 이동. 안건 드래그(draggingIdx)와 겹치지 않도록 draggingGroup 로만
  // 활성화한다.
  const groupDropProps = (gn) =>
    editing && draggingGroup && draggingGroup !== gn
      ? {
          onDragOver: (e) => {
            e.preventDefault()
            if (dropOverGroup !== gn) setDropOverGroup?.(gn)
          },
          onDrop: (e) => {
            e.preventDefault()
            onReorderGroups?.(draggingGroup, gn)
            setDraggingGroup?.(null)
            setDropOverGroup?.(null)
          },
        }
      : {}
  // 그룹 헤더 grip 에 붙일 드래그 핸들 props.
  const groupDragHandle = (gn) =>
    editing && onReorderGroups
      ? {
          onDragStart: () => setDraggingGroup?.(gn),
          onDragEnd: () => {
            setDraggingGroup?.(null)
            setDropOverGroup?.(null)
          },
        }
      : null
  // 2단 보기에서 열의 빈 영역에 드롭하면 그 열로 옮기는 핸들러. 안건 위에
  // 직접 드롭한 경우는 ItemRow 가 stopPropagation 하므로 여기로 안 온다.
  const colDropProps = (col, groupName = null) =>
    editing && draggingIdx != null
      ? {
          onDragOver: (e) => e.preventDefault(),
          onDrop: (e) => {
            e.preventDefault()
            onDropToColumn?.(col, groupName)
          },
        }
      : {}
  const arr = Array.isArray(children) ? children : [children]

  // 안건을 "연속된 같은 group_name" 단위 섹션으로 묶는다(group_name=null 은
  // 그룹 없는 구간). 각 그룹 섹션은 하나의 박스로 그려서 (a) 어떤 안건이 그
  // 그룹에 속하는지 한눈에 보이게 하고, (b) 2단 보기에서도 그룹이 둘로
  // 쪼개지지 않게 한다 — 헤더는 박스에 한 번, 안건만 박스 안에서 좌/우 2열로
  // 나뉜다.
  const sections = []
  let curSection = null
  for (let i = 0; i < arr.length; i++) {
    const gn = items[i]?.group_name || null
    if (!curSection || curSection.gn !== gn) {
      curSection = { gn, idxs: [] }
      sections.push(curSection)
    }
    curSection.idxs.push(i)
  }

  // 한 섹션의 안건들을 단일(1열) 또는 2열(display_column 기준)로 렌더.
  // groupName 은 이 섹션이 속한 그룹(없으면 null) — 빈 열 드롭이 그 그룹·열로
  // 정확히 들어가도록 colDropProps 에 넘긴다.
  function renderSectionItems(idxs, groupName = null) {
    if (!twoColPreview) {
      return <ul className="divide-y">{idxs.map((i) => arr[i])}</ul>
    }
    const left = idxs.filter((i) => (items[i]?.display_column ?? 1) !== 2)
    const right = idxs.filter((i) => items[i]?.display_column === 2)
    // 빈 열 힌트 — 드래그 중엔 열 전체 높이를 채워(드롭 영역 확보) 안내한다.
    const emptyHint = (col) => (
      <p className="flex h-full min-h-[2.5rem] items-center justify-center py-3 text-center text-[11px] italic text-muted-foreground">
        {editing && draggingIdx != null ? `여기에 놓으면 ${col}열로` : '(비어 있음)'}
      </p>
    )
    return (
      <div className="grid grid-cols-2 gap-x-3">
        <div className="space-y-1 border-r pr-3" {...colDropProps(1, groupName)}>
          {left.length > 0 ? left.map((i) => arr[i]) : emptyHint(1)}
        </div>
        <div className="space-y-1" {...colDropProps(2, groupName)}>
          {right.length > 0 ? right.map((i) => arr[i]) : emptyHint(2)}
        </div>
      </div>
    )
  }

  const usedGroups = new Set(items.map((it) => it.group_name).filter(Boolean))
  const emptyGroups = editing
    ? (pendingGroups ?? []).filter((g) => !usedGroups.has(g))
    : []

  return (
    <div className="space-y-2">
      {sections.map((s, si) =>
        s.gn ? (
          <div
            key={`sec-${si}-${s.gn}`}
            className={cn(
              'overflow-hidden rounded-md border border-primary/25 bg-primary/[0.03] transition-colors',
              editing && draggingGroup === s.gn && 'opacity-40',
              editing &&
                draggingGroup &&
                draggingGroup !== s.gn &&
                dropOverGroup === s.gn &&
                'ring-2 ring-primary',
            )}
            {...groupDropProps(s.gn)}
          >
            <GroupSectionHeader
              name={s.gn}
              count={s.idxs.length}
              editing={editing}
              onRename={onRenameGroup}
              onRemove={onRemoveGroup ? () => onRemoveGroup(s.gn) : undefined}
              onMoveUp={
                onMoveGroup && si > 0
                  ? () => onMoveGroup(s.gn, -1)
                  : undefined
              }
              onMoveDown={
                onMoveGroup && si < sections.length - 1
                  ? () => onMoveGroup(s.gn, +1)
                  : undefined
              }
              dragHandleProps={groupDragHandle(s.gn)}
            />
            <div className="px-3 py-1">{renderSectionItems(s.idxs, s.gn)}</div>
          </div>
        ) : (
          <div key={`sec-${si}-none`}>{renderSectionItems(s.idxs, s.gn)}</div>
        ),
      )}
      {/* 아직 비어 있는 그룹 — 사용자가 그룹을 만들었다는 신호. */}
      {emptyGroups.map((g) => (
        <div
          key={`empty-grp-${g}`}
          className={cn(
            'rounded-md border border-dashed border-primary/30 bg-primary/[0.02]',
            editing && draggingIdx != null && 'ring-2 ring-primary/40',
          )}
          {...(editing && draggingIdx != null
            ? {
                onDragOver: (e) => e.preventDefault(),
                onDrop: (e) => {
                  e.preventDefault()
                  onAssignToGroup?.(g)
                },
              }
            : {})}
        >
          <GroupSectionHeader
            name={g}
            editing={editing}
            onRename={onRenameGroup}
            onRemove={onRemoveGroup ? () => onRemoveGroup(g) : undefined}
          />
          <p className="px-3 pb-2 text-[11px] italic text-muted-foreground">
            {editing && draggingIdx != null
              ? '여기에 안건을 놓으면 이 그룹에 추가됩니다'
              : '(비어 있음 — 위 안건들의 그룹 selector 에서 이 그룹을 선택하세요)'}
          </p>
        </div>
      ))}
    </div>
  )
}

/** 그룹 섹션 헤더 — [그룹명] + 건수 + 드래그 핸들 + 순서이동(↑↓) + 이름 수정 +
 *  그룹 해제. dragHandleProps 가 있으면 왼쪽에 grip 핸들을 그려 그 그룹 섹션을
 *  끌어(HTML5 native) 순서를 바꾼다. ↑↓ 화살표도 함께 유지(정밀·키보드용). */
function GroupSectionHeader({
  name,
  count,
  editing,
  onRename,
  onRemove,
  onMoveUp,
  onMoveDown,
  dragHandleProps,
}) {
  const [renaming, setRenaming] = useState(false)
  const [value, setValue] = useState(name)

  function start() {
    setValue(name)
    setRenaming(true)
  }
  function commit() {
    const t = value.trim()
    if (t && t !== name) onRename?.(name, t)
    setRenaming(false)
  }

  return (
    <div className="flex items-center gap-2 border-b border-primary/20 bg-primary/5 px-3 py-1.5">
      {renaming ? (
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            else if (e.key === 'Escape') setRenaming(false)
          }}
          onBlur={commit}
          placeholder="그룹 이름"
          className="h-6 flex-1 rounded border bg-background px-1.5 text-[11px] font-semibold text-primary"
        />
      ) : (
        <>
          {editing && dragHandleProps && (
            <span
              draggable
              onDragStart={dragHandleProps.onDragStart}
              onDragEnd={dragHandleProps.onDragEnd}
              title="끌어서 그룹 순서 변경"
              className="-ml-1 shrink-0 cursor-grab text-primary/50 hover:text-primary active:cursor-grabbing"
            >
              <GripVertical className="h-3.5 w-3.5" />
            </span>
          )}
          <span className="text-[11px] font-semibold text-primary">[{name}]</span>
          {count != null && (
            <span className="text-[10px] text-muted-foreground">{count}건</span>
          )}
          <span className="flex-1" />
          {editing && (onMoveUp || onMoveDown) && (
            <>
              <button
                type="button"
                onClick={onMoveUp}
                disabled={!onMoveUp}
                title="그룹 위로"
                className="shrink-0 rounded px-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
              >
                ↑
              </button>
              <button
                type="button"
                onClick={onMoveDown}
                disabled={!onMoveDown}
                title="그룹 아래로"
                className="shrink-0 rounded px-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
              >
                ↓
              </button>
            </>
          )}
          {editing && onRename && (
            <button
              type="button"
              onClick={start}
              title="그룹 이름 수정"
              className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Pencil className="h-3 w-3" />
            </button>
          )}
          {editing && onRemove && (
            <button
              type="button"
              onClick={onRemove}
              title="그룹 해제 — 안건은 그대로 두고 그룹 묶음만 제거합니다"
              className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </>
      )}
    </div>
  )
}

/** 안건의 표시용 ref(보고서/하위종합)와 소속·작성자·제목을 뽑아 준다. */
function itemMeta(it, workspaceName) {
  const isReport =
    it._display?.item_type === 'report' || Boolean(it.ref_report_id)
  const ref = isReport ? it._display?.ref_report : it._display?.ref_composite
  const deptSlug = isReport ? ref?.owner_dept_slug : ref?.workspace_slug
  return {
    isReport,
    ref,
    // 분리된 발행 안건은 ref 가 없으니 스냅샷 제목으로 폴백.
    title: ref?.title ?? it._display?.snapshot_content?.title ?? null,
    sourceDeleted: Boolean(it._display?.source_deleted),
    dept: deptSlug ? workspaceName(deptSlug) : null,
    author: ref?.owner_name ?? null,
    date: isReport ? ref?.report_date : ref?.period_date,
  }
}

/** 리스트와 함께 보기 — 좌측 그룹별 안건 목록 + 우측에 선택한 안건의 상세.
 *  목록은 group_name 연속 블록을 섹션으로 묶고, 편집모드에선 섹션 헤더의
 *  ↑↓ 로 그룹 순서를 바꾼다. 선택은 화면 상태(저장 안 함)라 보기 모드에서도
 *  자유롭게 클릭해 우측 상세를 갈아끼울 수 있다. */
function CompositeListView({
  items,
  editing,
  workspaceName,
  selectedIdx,
  onSelect,
  onOpenItem,
  onMoveGroup,
  onRenameGroup,
  onRemoveGroup,
  draggingGroup,
  dropOverGroup,
  onReorderGroups,
  setDraggingGroup,
  setDropOverGroup,
}) {
  const sections = []
  let cur = null
  items.forEach((it, i) => {
    const gn = it.group_name || null
    if (!cur || cur.gn !== gn) {
      cur = { gn, idxs: [] }
      sections.push(cur)
    }
    cur.idxs.push(i)
  })

  // 그룹 섹션 드래그 순서 변경 — ItemsListContainer 와 동일한 native HTML5 모델.
  const groupDropProps = (gn) =>
    editing && draggingGroup && draggingGroup !== gn
      ? {
          onDragOver: (e) => {
            e.preventDefault()
            if (dropOverGroup !== gn) setDropOverGroup?.(gn)
          },
          onDrop: (e) => {
            e.preventDefault()
            onReorderGroups?.(draggingGroup, gn)
            setDraggingGroup?.(null)
            setDropOverGroup?.(null)
          },
        }
      : {}
  const groupDragHandle = (gn) =>
    editing && onReorderGroups
      ? {
          onDragStart: () => setDraggingGroup?.(gn),
          onDragEnd: () => {
            setDraggingGroup?.(null)
            setDropOverGroup?.(null)
          },
        }
      : null

  const selected = items[selectedIdx] ?? items[0]
  const selMeta = selected ? itemMeta(selected, workspaceName) : null

  function ListRow({ i }) {
    const m = itemMeta(items[i], workspaceName)
    const active = i === selectedIdx
    return (
      <button
        type="button"
        onClick={() => onSelect(i)}
        className={cn(
          'flex w-full items-start gap-2 rounded px-2 py-1.5 text-left transition-colors',
          active
            ? 'bg-primary/10 ring-1 ring-primary/30'
            : 'hover:bg-muted',
        )}
      >
        <span className="mt-0.5 w-5 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
          {i + 1}.
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">
            {m.title ?? `#${items[i].ref_report_id ?? items[i].ref_composite_id}`}
          </span>
          {(m.dept || m.author) && (
            <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
              {m.dept}
              {m.dept && m.author && (
                <span className="text-muted-foreground/40"> · </span>
              )}
              {m.author}
            </span>
          )}
        </span>
      </button>
    )
  }

  return (
    // 데스크톱에선 컨테이너 높이를 거의 화면 가득(뷰포트-여백)으로 고정해
    // 좌·우 패널이 각자 내부에서 스크롤되게 한다(min-h-0 가 grid item 의 기본
    // min-height:auto 를 풀어 자식 overflow 가 동작하게 하는 핵심). 모바일
    // (단일 컬럼)에선 높이 고정을 풀어 페이지 흐름대로 쌓이게 둔다.
    <div className="grid grid-cols-1 gap-3 md:h-[calc(100vh-12rem)] md:min-h-[26rem] md:grid-cols-[minmax(13rem,18rem)_1fr]">
      {/* 좌: 그룹별 안건 목록 — 길어지면 이 패널 안에서만 스크롤 */}
      <div className="min-h-0 space-y-2 overflow-y-auto md:pr-1">
        {sections.map((s, si) =>
          s.gn ? (
            <div
              key={`sec-${si}-${s.gn}`}
              className={cn(
                'overflow-hidden rounded-md border border-primary/25 bg-primary/[0.03] transition-colors',
                editing && draggingGroup === s.gn && 'opacity-40',
                editing &&
                  draggingGroup &&
                  draggingGroup !== s.gn &&
                  dropOverGroup === s.gn &&
                  'ring-2 ring-primary',
              )}
              {...groupDropProps(s.gn)}
            >
              <GroupSectionHeader
                name={s.gn}
                count={s.idxs.length}
                editing={editing}
                onRename={onRenameGroup}
                onRemove={onRemoveGroup ? () => onRemoveGroup(s.gn) : undefined}
                onMoveUp={
                  onMoveGroup && si > 0 ? () => onMoveGroup(s.gn, -1) : undefined
                }
                onMoveDown={
                  onMoveGroup && si < sections.length - 1
                    ? () => onMoveGroup(s.gn, +1)
                    : undefined
                }
                dragHandleProps={groupDragHandle(s.gn)}
              />
              <div className="space-y-0.5 p-1">
                {s.idxs.map((i) => (
                  <ListRow key={i} i={i} />
                ))}
              </div>
            </div>
          ) : (
            <div key={`sec-${si}-none`} className="space-y-0.5">
              {s.idxs.map((i) => (
                <ListRow key={i} i={i} />
              ))}
            </div>
          ),
        )}
      </div>

      {/* 우: 선택 안건 상세 — 헤더는 고정, 본문(메인 컨텐츠)만 내부 스크롤 */}
      <div className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-md border bg-card">
        {selected && selMeta ? (
          <>
            <div className="flex shrink-0 items-start justify-between gap-3 border-b p-3">
              <div className="min-w-0">
                <button
                  type="button"
                  onClick={() => onOpenItem(selected)}
                  className="block max-w-full truncate text-left text-base font-semibold hover:underline"
                >
                  {selMeta.title ??
                    `#${selected.ref_report_id ?? selected.ref_composite_id}`}
                </button>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground">
                  {(() => {
                    const fields = []
                    if (selMeta.dept)
                      fields.push(<MetaField key="d" label="소속" value={selMeta.dept} />)
                    if (selMeta.author)
                      fields.push(<MetaField key="a" label="작성" value={selMeta.author} />)
                    if (selMeta.date)
                      fields.push(<MetaField key="t" label="기준" value={selMeta.date} />)
                    return fields.map((node, i) => (
                      <Fragment key={node.key}>
                        {i > 0 && <span className="text-muted-foreground/30">·</span>}
                        {node}
                      </Fragment>
                    ))
                  })()}
                </div>
                {selected.note && (
                  <div className="mt-1 text-xs italic text-muted-foreground">
                    메모: {selected.note}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => onOpenItem(selected)}
                className="shrink-0 whitespace-nowrap text-xs text-primary hover:underline"
              >
                열기 ↗
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {selected.ref_report_id || selected.snapshot_content ? (
                // 분리된 발행 안건(원본 삭제)도 snapshot 으로 렌더.
                <InlineReportView
                  reportId={selected.ref_report_id}
                  snapshot={selected.snapshot_content ?? undefined}
                />
              ) : selected.ref_composite_id ? (
                <InlineCompositeView compositeId={selected.ref_composite_id} />
              ) : null}
            </div>
          </>
        ) : (
          <p className="p-6 text-center text-sm text-muted-foreground">
            왼쪽 목록에서 안건을 선택하세요.
          </p>
        )}
      </div>
    </div>
  )
}

/** 안건 메타 한 항목 — "라벨 값" 형태. 라벨은 muted, 값은 진하게 두어
 *  소속·작성·기준 등 서로 다른 정보가 한 줄에서도 깔끔히 구분된다. */
function MetaField({ label, value }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <span className="text-muted-foreground/55">{label}</span>
      <span className="text-foreground/75">{value}</span>
    </span>
  )
}

function ItemRow({
  item,
  index,
  total,
  editing,
  expanded,
  onToggleExpand,
  workspaceName,
  onMoveUp,
  onMoveDown,
  onRemove,
  onChangeNote,
  onOpen,
  // Drag-and-drop reorder. Wired only when `editing` so view mode
  // stays read-only. `isDragging` dims the source row; `isDropTarget`
  // draws a primary-colored top border to show where the drop will
  // land (= insert before this row).
  isDragging,
  // 안건 드래그가 진행 중인지. 그룹 드래그 중(false)엔 행이 드롭을 가로채지
  // 않아야(preventDefault·stopPropagation 금지) 이벤트가 그룹 섹션 컨테이너로
  // 버블돼 그룹 드롭이 성립한다.
  itemDragActive = false,
  isDropTarget,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  // Per-item layout column (1 = left, 2 = right). Only meaningful in
  // the landscape-2col DOCX export; portrait/1-col ignores it.
  displayColumn,
  onSetColumn,
  // 그룹 지정 — null = 그룹 없음. knownGroups 는 dropdown 옵션.
  groupName,
  knownGroups,
  onSetGroup,
  // 2단 미리보기 — true 면 행을 카드(테두리/패딩) 로 감싸 좁은 그리드
  // 셀 안에서도 시각적으로 분리되어 보이도록.
  compactCard = false,
}) {
  // 분리된 발행 안건은 ref_report_id 가 NULL 이라도 'report'(스냅샷만). 백엔드
  // item_type 을 우선 신뢰하고, 없으면 ref_report_id 로 판정.
  const isReport =
    item._display?.item_type === 'report' || Boolean(item.ref_report_id)
  const ref = isReport ? item._display?.ref_report : item._display?.ref_composite
  // 원본이 영구삭제돼 분리된 안건(스냅샷으로만 렌더).
  const sourceDeleted = Boolean(item._display?.source_deleted)
  const snapshot = item._display?.snapshot_content ?? item.snapshot_content ?? null
  // 게시 부서 이름 — 서버 projection 은 mounted_org_names(문자열 배열), picker
  // 로 막 추가한 _display 는 mount_workspaces(객체 배열)라 둘 다 받아준다.
  const mountNames =
    ref?.mounted_org_names ?? (ref?.mount_workspaces ?? []).map((m) => m.name)
  return (
    <li
      // Whole row is draggable while editing. Buttons/inputs inside
      // still fire their own click/focus events; HTML5 distinguishes
      // click (mousedown+up no movement) from drag (mousedown+move).
      // Setting draggable={false} explicitly on input prevents text-
      // selection-drag from hijacking the row drag.
      draggable={editing}
      onDragStart={editing ? onDragStart : undefined}
      onDragOver={
        editing && itemDragActive
          ? (e) => {
              // preventDefault on dragover enables the drop. Required
              // by HTML5 spec — without it the browser refuses drop.
              e.preventDefault()
              onDragOver?.()
            }
          : undefined
      }
      onDrop={
        editing && itemDragActive
          ? (e) => {
              e.preventDefault()
              // 안건 위에 직접 드롭한 경우 — 부모 컬럼의 drop zone 까지
              // 버블되어 두 번 처리되지 않도록 차단.
              e.stopPropagation()
              onDrop?.()
            }
          : undefined
      }
      onDragEnd={editing ? onDragEnd : undefined}
      className={cn(
        compactCard
          ? 'rounded-md border bg-card px-2 py-2 transition-colors'
          : 'py-3 transition-colors',
        editing && 'cursor-grab active:cursor-grabbing',
        isDragging && 'opacity-40',
        // Drop-target marker: thick primary top border = "drop lands
        // here, inserting before this row".
        isDropTarget &&
          (compactCard
            ? 'ring-2 ring-primary'
            : 'border-t-2 border-primary -mt-px'),
      )}
    >
      <div className="flex items-start gap-1.5">
        {editing && (
          <span
            data-export-exclude
            className="mt-0.5 shrink-0 text-muted-foreground/60 hover:text-muted-foreground h-5 w-5 flex items-center justify-center"
            aria-hidden="true"
            title="끌어서 순서 변경"
          >
            <GripVertical className="h-3.5 w-3.5" />
          </span>
        )}
        {/* 펼치기/접기 토글 — HTML export 시 모든 안건은 펼쳐진 상태
            로 캡처되고 정적 파일에선 toggle 동작이 불가능하므로 제거 */}
        <button
          type="button"
          data-export-exclude
          onClick={onToggleExpand}
          className="mt-0.5 shrink-0 rounded hover:bg-muted h-5 w-5 flex items-center justify-center text-muted-foreground"
          aria-label={expanded ? '접기' : '펼치기'}
          aria-expanded={expanded}
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
        <span className="text-xs text-muted-foreground w-5 tabular-nums pt-0.5 shrink-0 text-right">
          {index + 1}.
        </span>
        {/* 액션 버튼 그룹 — 안건명 앞으로 옮겨 카드 가로폭과 무관하게
            번호 옆에 붙어 보이도록. 사용자 피드백: 카드 폭이 넓을 때
            오른쪽 끝의 버튼이 안건명과 시각적으로 멀어 어떤 행에 속하는지
            한눈에 안 잡힘. */}
        {editing && (
          <div data-export-exclude className="flex items-center gap-0.5 shrink-0 mt-0">
            {/* 1열 / 2열 토글 — 가로 2단 Word 내보내기에서 이 안건이 좌/우
                어느 컬럼에 들어갈지. 단일 column 내보내기에선 영향 없음
                이지만 사전 설정해 두면 편함. 클릭 한 번에 1↔2 토글. */}
            <button
              type="button"
              onClick={() => onSetColumn?.(displayColumn === 2 ? 1 : 2)}
              className={cn(
                'h-6 w-6 rounded border text-[10px] font-medium tabular-nums transition-colors flex items-center justify-center',
                displayColumn === 2
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border bg-background text-muted-foreground hover:bg-muted',
              )}
              title={
                displayColumn === 2
                  ? '2열 (클릭하면 1열로) · 2단 Word 출력 시 오른쪽 컬럼'
                  : '1열 (클릭하면 2열로) · 2단 Word 출력 시 왼쪽 컬럼'
              }
              aria-label="2단 내보내기 열 선택"
            >
              {displayColumn === 2 ? '2' : '1'}
            </button>
            {/* 그룹 selector — 옵션: [그룹 없음] + knownGroups. 같은
                그룹의 연속 안건들이 Word export 에서 [그룹명] 헤더로
                묶임. dropdown 폭이 너무 늘어나지 않게 max-w 제한. */}
            <select
              value={groupName ?? ''}
              onChange={(e) => onSetGroup?.(e.target.value || null)}
              className={cn(
                'h-6 rounded border bg-background px-1 text-[10px] max-w-[7rem] truncate transition-colors',
                groupName
                  ? 'border-primary text-primary font-medium'
                  : 'border-border text-muted-foreground',
              )}
              title={
                groupName
                  ? `그룹: ${groupName} · Word 에서 [${groupName}] 헤더로 묶임`
                  : '그룹 없음'
              }
            >
              <option value="">(그룹 없음)</option>
              {(knownGroups ?? []).map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={onMoveUp}
              disabled={index === 0}
              aria-label="위로"
            >
              ↑
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={onMoveDown}
              disabled={index === total - 1}
              aria-label="아래로"
            >
              ↓
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-destructive"
              onClick={onRemove}
              aria-label="제거"
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        )}
        <div className="flex-1 min-w-0">
          {/* 제목 + 모든 정보를 한 줄에. "보고서" 뱃지는 제거(이제 안건은
              보고서뿐이라 중복). 각 정보는 라벨(소속·작성·기준·게시)을 muted
              로 앞에 붙이고 값은 진하게, 사이는 가는 · 로 구분해 깔끔하게.
              편집 모드에선 제목을 위에 두고 메타를 아래 줄로 내린다(메모
              입력칸과의 간섭을 줄이려). */}
          <div
            className={cn(
              'flex min-w-0 gap-x-2 gap-y-0.5 flex-wrap',
              editing ? 'flex-col' : 'items-baseline',
            )}
          >
            <button
              type="button"
              onClick={onOpen}
              className="font-medium text-sm hover:underline text-left truncate max-w-full shrink-0"
            >
              {ref?.title ??
                snapshot?.title ??
                (isReport
                  ? `report #${item.ref_report_id ?? '—'}`
                  : `composite #${item.ref_composite_id}`)}
            </button>
            {sourceDeleted && (
              <span
                className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                title="원본 보고서가 삭제되어 발행 시점 스냅샷으로 표시됩니다."
              >
                원본 삭제됨
              </span>
            )}
            <div className="text-[11px] text-muted-foreground flex items-center gap-x-1.5 gap-y-0.5 flex-wrap min-w-0">
              {(() => {
                // 표기 순서: 소속 → 작성자 → 기준일 → 게시. 보고서는 작성자
                // 소속(home) 부서를, 종합(legacy)은 자체 org 워크스페이스를 쓴다.
                const fields = []
                if (isReport) {
                  if (ref?.owner_dept_slug)
                    fields.push(
                      <MetaField key="dept" label="소속" value={workspaceName(ref.owner_dept_slug)} />,
                    )
                  if (ref?.owner_name)
                    fields.push(<MetaField key="author" label="작성" value={ref.owner_name} />)
                  if (ref?.report_date)
                    fields.push(<MetaField key="date" label="기준" value={ref.report_date} />)
                  if (mountNames.length > 0)
                    fields.push(
                      <span key="mount" className="inline-flex items-center gap-1 whitespace-nowrap">
                        <span className="text-muted-foreground/55">게시</span>
                        <span
                          className={cn(
                            'text-foreground/75',
                            mountNames.length > 1 &&
                              'cursor-help underline decoration-dotted underline-offset-2',
                          )}
                          title={
                            mountNames.length > 1
                              ? `게시 부서 (${mountNames.length}):\n${mountNames.join('\n')}`
                              : `게시: ${mountNames[0]}`
                          }
                        >
                          {mountNames[0]}
                          {mountNames.length > 1 ? ` 외 ${mountNames.length - 1}` : ''}
                        </span>
                      </span>,
                    )
                  else if (!ref?.owner_dept_slug)
                    fields.push(
                      <span key="unpub" className="italic text-muted-foreground/60">미게시</span>,
                    )
                } else {
                  if (ref?.workspace_slug)
                    fields.push(
                      <MetaField key="dept" label="소속" value={workspaceName(ref.workspace_slug)} />,
                    )
                  if (ref?.owner_name)
                    fields.push(<MetaField key="author" label="작성" value={ref.owner_name} />)
                  if (ref?.period_date)
                    fields.push(<MetaField key="date" label="기준" value={ref.period_date} />)
                }
                return fields.map((node, i) => (
                  <Fragment key={node.key}>
                    {i > 0 && <span className="text-muted-foreground/30">·</span>}
                    {node}
                  </Fragment>
                ))
              })()}
            </div>
          </div>
          {(editing || item.note) && (
            <div className="mt-2">
              {editing ? (
                <Input
                  value={item.note}
                  onChange={(e) => onChangeNote(e.target.value)}
                  placeholder="이 안건에 대한 메모 (선택)"
                  className="h-8 text-xs"
                />
              ) : (
                <div className="text-xs text-muted-foreground italic">
                  메모: {item.note}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {expanded && (
        <div className="mt-3 ml-12 pl-4 border-l-2">
          {isReport && (item.ref_report_id || snapshot) ? (
            // Phase 5A — pass snapshot when present. Published recurring
            // composites freeze each item's content into snapshot_content
            // so the as-of-publish state survives later edits to the
            // source report. Theme + unpublished recurring leave snapshot
            // NULL → live fetch via reportId. 원본이 삭제돼 분리된 안건은
            // ref_report_id 가 NULL 이라도 snapshot 으로 렌더한다.
            <InlineReportView
              reportId={item.ref_report_id}
              snapshot={snapshot ?? undefined}
              // §7.4 위젯 delta — 이전 회차에서 이 안건이 동결된 시각을 기준점으로
              // 넘긴다(백엔드가 회차 resolver 로 채움). null 이면 강조 없음.
              baselineTakenAt={item.prev_snapshot_taken_at ?? null}
            />
          ) : item.ref_composite_id ? (
            <InlineCompositeView compositeId={item.ref_composite_id} />
          ) : null}
        </div>
      )}
    </li>
  )
}
