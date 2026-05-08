import { useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, GripVertical, Pencil, Save, Sparkles, FileText, Trash2, X, PanelRightOpen, PanelRightClose } from 'lucide-react'
import GridLayout, { useContainerWidth } from 'react-grid-layout'
import { Button } from '@/shared/components/ui/button'
import { Badge } from '@/shared/components/ui/badge'
import { Separator } from '@/shared/components/ui/separator'
import { Card, CardContent } from '@/shared/components/ui/card'
import { ScrollArea } from '@/shared/components/ui/scroll-area'
import { Sheet, SheetContent, SheetTrigger } from '@/shared/components/ui/sheet'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { Input } from '@/shared/components/ui/input'
import { AIDock } from '@/shared/components/AIDock'
import { ConfirmDialog } from '@/shared/components/ConfirmDialog'
import { ErrorState } from '@/shared/components/ErrorState'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import { useAsync } from '@/shared/hooks/useAsync'
import { usePersistedState } from '@/shared/hooks/usePersistedState'
import { getReport, createReport, updateReport, deleteReport } from './api'
import { getTemplateVersion } from '@/shared/api/templates'
import { STATUS_LABEL, STATUS_VARIANT } from './constants'
import { getRenderer } from '@/modules/templates/widgets'
import { toast } from 'sonner'

/**
 * Two entry modes:
 *   /reports/new/:templateId/:version  → blank report seeded from a template
 *   /reports/:reportId                 → existing report
 */
export default function ReportDetailPage() {
  const { reportId, templateId, version } = useParams()
  const navigate = useNavigate()
  const { slug } = useWorkspace()
  const isNew = Boolean(templateId)

  const [aiOpen, setAiOpen] = usePersistedState('ra:ai-dock-open:v1', true)
  const [confirmDelete, setConfirmDelete] = useState(false)
  // edit mode flag — new reports start in edit, existing ones default to
  // view-only (no inputs / placeholders / save button shown until the
  // user explicitly clicks "편집").
  const [isEditing, setIsEditing] = useState(isNew)

  // For 신규 모드: fetch the template to get its sections.
  // Gate on `slug` so we don't fire before WorkspaceProvider has set the
  // X-Workspace-Slug header on the API client (which the backend requires).
  const { data: template, loading: tplLoading, error: tplError } = useAsync(
    () => (isNew && slug ? getTemplateVersion(templateId, Number(version)) : Promise.resolve(null)),
    [isNew, templateId, version, slug]
  )
  // For 기존 모드: fetch the report.
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

  // Local working copy of the report (so edits don't mutate fetched data).
  const [draft, setDraft] = useState(null)
  useEffect(() => {
    if (isNew && template) {
      setDraft({
        title: '새 보고서',
        template_id: template.template_id,
        template_version: template.version,
        period: '',
        tags: [],
        content: seedContentFromTemplate(template),
        layout_overrides: null,
      })
    } else if (!isNew && existingReport) {
      setDraft({
        ...existingReport,
        content: existingReport.content ?? {},
        tags: existingReport.tags ?? [],
        layout_overrides: existingReport.layout_overrides ?? null,
      })
    }
  }, [isNew, template, existingReport])

  // Section list for the editor — derived from template (new) or fetched alongside (existing).
  const { data: existingTemplate } = useAsync(
    () =>
      !isNew && existingReport && slug
        ? getTemplateVersion(existingReport.template_id, existingReport.template_version)
        : Promise.resolve(null),
    [isNew, existingReport?.template_id, existingReport?.template_version, slug]
  )

  const sourceSchema = isNew ? template?.schema : existingTemplate?.schema
  const blocks = extractBlocks(sourceSchema)
  const sections = blocks // AIDock still wants `sections` shape (id, title)
  const [activeBlock, setActiveBlock] = useState(null)
  useEffect(() => {
    if (!activeBlock && blocks[0]) setActiveBlock(blocks[0].id)
  }, [blocks, activeBlock])

  function updateBlockContent(blockId, value) {
    setDraft((d) => ({
      ...d,
      content: { ...(d.content ?? {}), [blockId]: value },
    }))
  }

  // Each block's *effective* layout = report-side override OR template default.
  // Drives both view-mode CSS Grid and edit-mode react-grid-layout.
  const effectiveLayouts = useMemo(() => {
    const overrides = draft?.layout_overrides ?? {}
    const out = {}
    for (const b of blocks) {
      out[b.id] = overrides[b.id] ?? b.layout ?? null
    }
    return out
  }, [blocks, draft?.layout_overrides])

  // RGL items derived from effective layouts. x is reconstructed by packing
  // same-row blocks left-to-right in template order.
  const rglItems = useMemo(() => buildRglItems(blocks, effectiveLayouts), [blocks, effectiveLayouts])

  // When the user drags/resizes, RGL emits a new layout. We diff it against
  // each block's *template* layout — only blocks that differ get persisted
  // as overrides, so unchanged ones keep flowing from the template.
  function handleLayoutChange(rglLayout) {
    const sortedYs = [...new Set(rglLayout.map((it) => it.y))].sort((a, b) => a - b)
    const yToRow = new Map(sortedYs.map((y, i) => [y, i + 1]))
    const overrides = {}
    for (const it of rglLayout) {
      const block = blocks.find((b) => b.id === it.i)
      if (!block) continue
      const newLayout = {
        row: yToRow.get(it.y) ?? 1,
        col_span: clamp(it.w ?? 12, 1, 12),
        row_span: Math.max(1, it.h ?? 2),
      }
      const tpl = block.layout
      if (
        !tpl ||
        tpl.row !== newLayout.row ||
        tpl.col_span !== newLayout.col_span ||
        tpl.row_span !== newLayout.row_span
      ) {
        overrides[block.id] = newLayout
      }
    }
    const next = Object.keys(overrides).length === 0 ? null : overrides
    if (!sameOverrides(draft?.layout_overrides, next)) {
      setDraft((d) => ({ ...d, layout_overrides: next }))
    }
  }

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

  async function onSave() {
    try {
      if (isNew) {
        const created = await createReport({
          template_id: draft.template_id,
          template_version: draft.template_version,
          title: draft.title,
          period: draft.period || '',
          tags: draft.tags ?? [],
          content: draft.content ?? {},
          layout_overrides: draft.layout_overrides ?? null,
        })
        toast.success('보고서가 생성되었습니다.')
        navigate(`/w/${slug}/reports/${created.id}`, { replace: true })
      } else {
        await updateReport(draft.id, {
          title: draft.title,
          period: draft.period,
          tags: draft.tags,
          content: draft.content,
          layout_overrides: draft.layout_overrides ?? null,
        })
        toast.success('저장되었습니다.')
        reloadReport()
        // After saving an existing report, drop back to view-only.
        setIsEditing(false)
      }
    } catch (err) {
      toast.error(err.message || '저장 실패')
    }
  }

  function onCancelEdit() {
    // Discard pending changes by re-seeding the draft from the latest
    // server data (or, for new reports, navigate back to the list since
    // there's nothing to revert to).
    if (isNew) {
      navigate(`/w/${slug}/reports`)
      return
    }
    if (existingReport) {
      setDraft({
        ...existingReport,
        content: existingReport.content ?? {},
        tags: existingReport.tags ?? [],
      })
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

  return (
    <div className="flex h-full">
      {/* 좌측: 섹션 목차 */}
      <aside className="w-56 shrink-0 border-r bg-card hidden md:flex flex-col">
        <div className="border-b p-3">
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2"
            onClick={() => navigate(`/w/${slug}/reports`)}
          >
            <ArrowLeft className="mr-1 h-3 w-3" />
            목록
          </Button>
        </div>
        <div className="p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            섹션
          </div>
        </div>
        <ScrollArea className="flex-1">
          <ul className="px-2 pb-4 space-y-1">
            {blocks.map((s) => {
              const renderer = getRenderer(s.type)
              const Icon = renderer?.Icon ?? FileText
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setActiveBlock(s.id)
                      const el = document.getElementById(`block-${s.id}`)
                      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
                    }}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors ${
                      activeBlock === s.id
                        ? 'bg-primary/10 text-primary font-medium'
                        : 'hover:bg-muted text-foreground/80'
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    <span className="truncate">{s.title}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </ScrollArea>
      </aside>

      {/* 중앙: 본문 */}
      <div className="flex-1 min-w-0 flex flex-col">
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
            <div className="mt-0.5 text-xs text-muted-foreground flex items-center gap-2">
              {/* Show the template's display name. The raw template_id is a
                  UUID — meaningless to readers — so we don't fall back to it.
                  While the template is still loading, show a quiet placeholder. */}
              <span>
                {(isNew ? template : existingTemplate)?.name ?? (
                  <span className="italic">템플릿 불러오는 중…</span>
                )}
              </span>
              <span>v{draft.template_version}</span>
              {!isNew && (
                <Badge variant={STATUS_VARIANT[draft.status]}>{STATUS_LABEL[draft.status]}</Badge>
              )}
            </div>
          </div>

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

          <Button
            variant={aiOpen ? 'secondary' : 'default'}
            size="sm"
            onClick={() => setAiOpen((v) => !v)}
            className="hidden lg:inline-flex"
            aria-pressed={aiOpen}
          >
            {aiOpen ? (
              <PanelRightClose className="mr-1 h-3 w-3" />
            ) : (
              <Sparkles className="mr-1 h-3 w-3" />
            )}
            AI
          </Button>

          <Sheet>
            <SheetTrigger asChild>
              <Button size="sm" className="lg:hidden">
                <Sparkles className="mr-1 h-3 w-3" />
                AI
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-full max-w-md p-0">
              <AIDock sections={sections} className="h-full" />
            </SheetContent>
          </Sheet>
        </div>

        <ScrollArea className="flex-1">
          {/* Use the full available width — the surrounding flex layout
              already bounds us between the section sidebar and the AI dock,
              so an extra max-width here just leaves dead space. */}
          <div className="p-6">
            {blocks.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center text-sm text-muted-foreground">
                  템플릿에 블록이 없습니다.
                </CardContent>
              </Card>
            ) : (
              <ResizableGrid
                items={rglItems}
                onLayoutChange={isEditing ? handleLayoutChange : undefined}
                isStatic={!isEditing}
              >
                {blocks.map((block) => (
                  <div key={block.id} className="min-w-0 h-full">
                    <BlockEditorCard
                      block={block}
                      content={draft.content?.[block.id]}
                      active={activeBlock === block.id}
                      readOnly={!isEditing}
                      showDragHandle={isEditing}
                      onActivate={() => setActiveBlock(block.id)}
                      onChange={(value) => updateBlockContent(block.id, value)}
                    />
                  </div>
                ))}
              </ResizableGrid>
            )}
          </div>
        </ScrollArea>
      </div>

      {/* 우측: AI 도크 */}
      {aiOpen ? (
        <aside className="hidden lg:flex w-[360px] shrink-0 border-l">
          <AIDock sections={sections} className="w-full" onClose={() => setAiOpen(false)} />
        </aside>
      ) : (
        <aside className="hidden lg:flex w-10 shrink-0 border-l flex-col items-center bg-card">
          <Button
            variant="ghost"
            size="icon"
            className="h-10 w-10 rounded-none"
            onClick={() => setAiOpen(true)}
            aria-label="AI 도크 열기"
          >
            <PanelRightOpen className="h-4 w-4" />
          </Button>
          <div className="mt-2 flex flex-col items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground [writing-mode:vertical-rl] rotate-180 py-2">
            <Sparkles className="h-3 w-3" />
            <span>AI 도크</span>
          </div>
        </aside>
      )}

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

/**
 * Reads blocks from a widget-v1 template schema. Each block becomes a
 * navigable card in the report editor. The shape returned here also
 * satisfies the AIDock's `sections` contract ({id, title}).
 */

function extractBlocks(schema) {
  const blocks = Array.isArray(schema?.blocks) ? schema.blocks : []
  return blocks.map((b) => ({
    id: b.id,
    // Sidebar / nav title — uses template-time prop labels. Heading shows
    // its own (live) text inline; other widgets carry props.label.
    title: b.props?.label || b.props?.default_text || b.id,
    type: b.type,
    props: b.props ?? {},
    // Forward layout so the report grid can honor col_span / row placement.
    // Missing → falls back to full-width single-column stacking.
    layout: b.layout,
  }))
}

/**
 * For a brand-new report, copy any per-widget defaults into `content` so
 * the user opens the editor with placeholders pre-populated and partial
 * draft saves don't lose those values. Only widgets with a known default
 * are seeded; others stay empty.
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

function BlockEditorCard({ block, content, active, readOnly, showDragHandle, onActivate, onChange }) {
  const renderer = getRenderer(block.type)
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
    <div className="block-drag-handle cursor-move px-2 py-1 border-b bg-muted/40 flex items-center gap-2 shrink-0">
      <GripVertical className="h-3 w-3 text-muted-foreground" />
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {block.type}
      </span>
    </div>
  ) : null

  // Heading renders inline (no card chrome) so it actually looks like
  // a section heading in the page flow. In edit-with-resize mode we still
  // need a draggable wrapper, so the heading gets a thin handle bar
  // above it; in plain view mode it stays bare.
  if (block.type === 'heading') {
    const { Editor: HE } = renderer
    if (showDragHandle) {
      return (
        <div
          id={`block-${block.id}`}
          onClick={onActivate}
          className={`h-full overflow-hidden rounded-md border bg-card flex flex-col ${
            active && !readOnly ? 'ring-2 ring-primary/30' : ''
          }`}
        >
          {dragHandle}
          <div className="p-3 flex-1 min-h-0 flex items-center">
            <HE props={block.props} content={content} onChange={onChange} readOnly={readOnly} />
          </div>
        </div>
      )
    }
    return (
      <div
        id={`block-${block.id}`}
        onClick={onActivate}
        className={active && !readOnly ? 'ring-2 ring-primary/30 rounded-md' : ''}
      >
        <HE
          props={block.props}
          content={content}
          onChange={onChange}
          readOnly={readOnly}
        />
      </div>
    )
  }

  const { Editor } = renderer

  // Every non-heading widget now carries its own block-level caption
  // (rendered inline by the widget's Editor). The card no longer paints
  // an external <h2> — the caption input IS the title, with the template's
  // `props.label` showing through as a placeholder hint when empty.
  return (
    <Card
      id={`block-${block.id}`}
      onClick={onActivate}
      className={`h-full overflow-hidden flex flex-col ${
        active && !readOnly ? 'ring-2 ring-primary/30' : ''
      }`}
    >
      {dragHandle}
      <CardContent className="pt-4 pb-4 flex-1 min-h-0 overflow-auto">
        {Editor ? (
          <Editor
            props={block.props}
            content={content}
            onChange={onChange}
            readOnly={readOnly}
          />
        ) : (
          <p className="text-xs text-muted-foreground italic">
            이 위젯은 보고서에서 입력하지 않습니다.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

// --------------------------------------------------------------------------- //
// Layout helpers — drive the edit-mode react-grid-layout
// --------------------------------------------------------------------------- //

const REPORT_GRID_COLS = 12
const REPORT_ROW_HEIGHT = 60
// Vertical gap between rows. Matches react-grid-layout's marginY in the
// editor so the same row_span produces identical block heights in both
// modes (px-perfect WYSIWYG).
const REPORT_ROW_GAP = 12

/**
 * Translate blocks + effective layouts into the {i, x, y, w, h} shape RGL
 * wants. Missing layouts default to a full-width row appended at the end.
 */
function buildRglItems(blocks, effectiveLayouts) {
  // Group block ids by row so we can pack x positions left-to-right.
  const byRow = new Map()
  for (const b of blocks) {
    const layout = effectiveLayouts[b.id] ?? { row: 99, col_span: REPORT_GRID_COLS, row_span: 2 }
    if (!byRow.has(layout.row)) byRow.set(layout.row, [])
    byRow.get(layout.row).push(b)
  }
  const items = []
  for (const b of blocks) {
    const layout = effectiveLayouts[b.id] ?? { row: 99, col_span: REPORT_GRID_COLS, row_span: 2 }
    const sameRow = byRow.get(layout.row) ?? []
    let x = 0
    for (const sib of sameRow) {
      if (sib.id === b.id) break
      const sibLayout = effectiveLayouts[sib.id] ?? { col_span: REPORT_GRID_COLS }
      x += clamp(sibLayout.col_span ?? REPORT_GRID_COLS, 1, REPORT_GRID_COLS)
    }
    items.push({
      i: b.id,
      x: Math.min(x, REPORT_GRID_COLS - 1),
      y: layout.row - 1,
      w: clamp(layout.col_span ?? REPORT_GRID_COLS, 1, REPORT_GRID_COLS),
      h: Math.max(1, layout.row_span ?? 2),
      minW: 1,
      maxW: REPORT_GRID_COLS,
      minH: 1,
    })
  }
  return items
}

/**
 * Wraps GridLayout with `useContainerWidth` (RGL v2). Used for BOTH edit
 * and view modes — view mode just sets `isStatic` so blocks aren't
 * draggable/resizable. Sharing one library guarantees identical block
 * heights across modes (the previous CSS-Grid view path computed sizes
 * subtly differently and the chart's recharts-surface ended up roughly
 * half the edit-mode height).
 */
function ResizableGrid({ items, onLayoutChange, children, isStatic = false }) {
  const { containerRef, width, mounted } = useContainerWidth({ measureBeforeMount: true })
  // RGL v2 honors per-item `static: true` more reliably than the
  // grid-level isDraggable/isResizable in some cases, so we lock both.
  // The `key` on GridLayout also forces a remount when the mode flips,
  // clearing any stale interaction state.
  const finalItems = isStatic ? items.map((it) => ({ ...it, static: true })) : items
  return (
    <div ref={containerRef} className="w-full">
      {mounted && width > 0 && (
        <GridLayout
          key={isStatic ? 'static' : 'editable'}
          className="layout"
          layout={finalItems}
          cols={REPORT_GRID_COLS}
          rowHeight={REPORT_ROW_HEIGHT}
          margin={[REPORT_ROW_GAP, REPORT_ROW_GAP]}
          onLayoutChange={onLayoutChange}
          draggableHandle=".block-drag-handle"
          compactType="vertical"
          preventCollision={false}
          width={width}
          isDraggable={!isStatic}
          isResizable={!isStatic}
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
  }
  return true
}
