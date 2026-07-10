import { useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { GripVertical, Save, Settings2, Trash2, X } from 'lucide-react'
import GridLayout, { useContainerWidth } from 'react-grid-layout'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Textarea } from '@/shared/components/ui/textarea'
import { Label } from '@/shared/components/ui/label'
import { Card, CardContent } from '@/shared/components/ui/card'
import { Badge } from '@/shared/components/ui/badge'
import { Separator } from '@/shared/components/ui/separator'
import { PageHeader } from '@/shared/components/PageHeader'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { ErrorState } from '@/shared/components/ErrorState'
import { ScrollArea } from '@/shared/components/ui/scroll-area'
import { WorkspaceTreeSelect } from '@/shared/components/WorkspaceTreeSelect'
import { useAsync } from '@/shared/hooks/useAsync'
import { useAuth } from '@/shared/auth/AuthContext'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import { useWidgetCatalog } from '@/shared/hooks/useWidgetCatalog'
import {
  getLatestTemplate,
  createTemplate,
  publishNewVersion,
  setTemplateScope,
} from '@/shared/api/templates'
import { listTemplateCategories } from '@/shared/api/templateCategories'
import {
  GRID_COLS,
  draftToSchema,
  newBlock,
  newEmptyDraft,
  preflightDraft,
  schemaToDraft,
} from './widgetBuilder'
import { getRenderer } from './widgets'
import { WidgetPicker } from './WidgetPicker'
import { BlockMetaEditor } from './widgets/_shared'
import {
  DEFAULT_REPORT_WIDTH_PX,
  DEFAULT_REPORT_GAP_PX,
  ReportSettingsDialog,
} from '@/modules/reports/ReportSettingsDialog'
import { SectionPickerDialog } from '@/modules/reports/SectionPickerDialog'
import { findItemInCategories } from '@/modules/reports/sections'
import { useSectionTaxonomy } from '@/shared/hooks/useSectionTaxonomy'
import { toast } from 'sonner'

const ROW_HEIGHT = 50

/** owner_workspace_slugs 동치 비교(순서·중복 무시, null≈[]). 수정 저장 때
 *  공유 범위가 실제로 바뀐 경우에만 /scope 를 호출하려고 쓴다. */
function sameOwners(a, b) {
  const na = [...new Set((a ?? []).filter(Boolean))].sort()
  const nb = [...new Set((b ?? []).filter(Boolean))].sort()
  return na.length === nb.length && na.every((x, i) => x === nb[i])
}

export default function TemplateEditorPage() {
  const { templateId } = useParams()
  const navigate = useNavigate()
  const { me } = useAuth()
  const { all: workspaces, slug } = useWorkspace()
  const isEdit = Boolean(templateId)

  // Gate on `slug` — backend requires X-Workspace-Slug for template GETs,
  // and WorkspaceProvider sets it asynchronously after first render.
  const { data: existing, loading, error } = useAsync(
    () => (isEdit && slug ? getLatestTemplate(templateId) : Promise.resolve(null)),
    [isEdit, templateId, slug]
  )
  const { data: categories } = useAsync(() => listTemplateCategories(), [])
  const { catalog, loading: catalogLoading, error: catalogError } = useWidgetCatalog()

  const [draft, setDraft] = useState(() => newEmptyDraft())
  // Auto-generated UUID for new templates — produced once at mount and
  // shown read-only. UUIDs match the backend's id pattern
  // (`^[a-z0-9][a-z0-9-]*$`) so no extra normalization is needed.
  const [templateIdInput] = useState(() =>
    isEdit ? '' : (globalThis.crypto?.randomUUID?.() ?? fallbackUuid())
  )
  const [selectedBlockId, setSelectedBlockId] = useState(null)
  const [saving, setSaving] = useState(false)
  // 개인(비공개) 템플릿 — 소유=personal-{me}. 작성 picker 에서 본인만 보지만,
  // 그 템플릿으로 게시한 보고서는 누구에게나 렌더된다(렌더는 by-id 개방).
  const [isPrivate, setIsPrivate] = useState(false)
  // Same dialog the report editor uses — opened from the 보고서 설정
  // button below. Writes back to draft.report_defaults so the settings
  // travel with the template version on publish.
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false)

  useEffect(() => {
    if (isEdit && existing) {
      const next = schemaToDraft(existing)
      setDraft(next)
      // 기존 스코프로 가시성 블록 프리필 — 소유가 personal-* 뿐이면 개인(비공개).
      const owners = existing.owner_workspace_slugs ?? []
      setIsPrivate(
        owners.length > 0 && owners.every((s) => String(s).startsWith('personal-')),
      )
      // Don't auto-select on load — the right panel stays closed until the
      // user clicks a block. Adding a new block via palette still auto-
      // selects (handled in addBlock).
    }
  }, [isEdit, existing])

  // IMPORTANT: all hooks must run on every render in the same order. Keep
  // hooks above any early returns so React doesn't see hook count change
  // between "loading" and "loaded" states.
  const rglItems = useMemo(() => buildRglItems(draft.blocks), [draft.blocks])

  // 매니저는 보이는 템플릿 전반을, 일반 멤버는 자기 부서 템플릿을 만들/고칠 수
  // 있다(소유 검증은 백엔드가 강제). 외부 열람자/역할 없음은 차단.
  const role = me?.role
  const isManager = role === 'manager'
  const canManageTemplates = isManager || role === 'user'
  if (!canManageTemplates) {
    return (
      <div className="p-6">
        <ErrorState
          title="권한 없음"
          description="템플릿 편집은 매니저 또는 부서 멤버만 가능합니다."
          action={
            <Button asChild variant="outline">
              <Link to="/templates">목록으로</Link>
            </Button>
          }
        />
      </div>
    )
  }

  if ((isEdit && loading) || catalogLoading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-96" />
      </div>
    )
  }

  if (isEdit && error) {
    return (
      <div className="p-6">
        <ErrorState description={error.message} />
      </div>
    )
  }

  if (catalogError) {
    return (
      <div className="p-6">
        <ErrorState
          title="위젯 카탈로그를 불러오지 못했습니다"
          description={catalogError.message}
        />
      </div>
    )
  }

  const selectedBlock = draft.blocks.find((b) => b.id === selectedBlockId) ?? null

  function addBlock(widgetType) {
    const widget = catalog.byType[widgetType]
    if (!widget) return
    const block = newBlock(widget, draft.blocks)
    setDraft({ ...draft, blocks: [...draft.blocks, block] })
    setSelectedBlockId(block.id)
  }

  function updateBlock(blockId, patch) {
    setDraft({
      ...draft,
      blocks: draft.blocks.map((b) => (b.id === blockId ? { ...b, ...patch } : b)),
    })
  }

  function removeBlock(blockId) {
    const next = draft.blocks.filter((b) => b.id !== blockId)
    setDraft({ ...draft, blocks: next })
    if (selectedBlockId === blockId) {
      setSelectedBlockId(next[0]?.id ?? null)
    }
  }

  /**
   * RGL fires onLayoutChange any time positions/sizes change. We translate
   * back into our schema's {row, col_span, row_span} and reorder blocks
   * within each row by their x position. (`rglItems` — the input shape
   * for react-grid-layout — is computed via useMemo near the top of the
   * function so hook order stays stable across loading states.)
   */
  function handleLayoutChange(rglLayout) {
    const byId = new Map(rglLayout.map((it) => [it.i, it]))
    // Group rows by y (RGL's vertical position) → assign row indexes 1..N
    const sortedYs = [...new Set(rglLayout.map((it) => it.y))].sort((a, b) => a - b)
    const yToRow = new Map(sortedYs.map((y, i) => [y, i + 1]))

    // Build a new block list ordered by (row, x) so that left-to-right
    // packing is reflected in the array order.
    const annotated = draft.blocks.map((b) => {
      const it = byId.get(b.id)
      if (!it) return { block: b, row: 0, x: 0 }
      return { block: b, row: yToRow.get(it.y), x: it.x, w: it.w, h: it.h }
    })
    annotated.sort((a, b) => a.row - b.row || a.x - b.x)

    const nextBlocks = annotated.map((a) => ({
      ...a.block,
      layout: {
        row: a.row || 1,
        col_span: clamp(a.w ?? a.block.layout?.col_span ?? GRID_COLS, 1, GRID_COLS),
        row_span: Math.max(1, a.h ?? a.block.layout?.row_span ?? 2),
      },
    }))

    // Avoid feedback loops — only update if something actually changed.
    if (!sameLayouts(draft.blocks, nextBlocks)) {
      setDraft((d) => ({ ...d, blocks: nextBlocks }))
    }
  }

  async function onSave() {
    const errors = preflightDraft(draft)
    if (errors.length > 0) {
      toast.error(errors[0])
      return
    }

    setSaving(true)
    try {
      const schema = draftToSchema(draft)
      if (isEdit) {
        await publishNewVersion(templateId, {
          name: draft.name,
          description: draft.description,
          category: draft.category,
          schema,
        })
        // 공유 범위(가시성)는 버전과 별개 메타 — 매니저가 바꿨을 때만 /scope 로
        // 반영한다. 개인(비공개)=personal-{me}, 아니면 선택 부서(없으면 전사=null).
        // 전사 템플릿을 좁히는 등 서버가 막는 경우(403)는 버전 발행은 그대로 두고
        // 경고만 띄운다.
        if (isManager) {
          const orgOwners = (draft.owner_workspace_slugs ?? []).filter(
            (s) => !String(s).startsWith('personal-'),
          )
          const desired = isPrivate
            ? [`personal-${me?.user?.id}`]
            : orgOwners.length
              ? orgOwners
              : null
          if (!sameOwners(existing?.owner_workspace_slugs, desired)) {
            try {
              await setTemplateScope(templateId, desired)
            } catch (e) {
              toast.warning(
                '새 버전은 발행됐지만 공유 범위 변경은 실패했습니다: ' +
                  (e?.message || ''),
              )
              navigate('/templates')
              return
            }
          }
        }
        toast.success('새 버전이 발행되었습니다.')
      } else {
        await createTemplate({
          template_id: templateIdInput,
          name: draft.name,
          description: draft.description,
          category: draft.category,
          schema,
          // 개인(비공개) 선택 시 본인 personal 소유. 아니면 매니저는 선택 부서,
          // 일반 멤버는 자기 부서 단독 소유.
          owner_workspace_slugs: isPrivate
            ? [`personal-${me?.user?.id}`]
            : isManager
              ? draft.owner_workspace_slugs
              : [slug],
        })
        toast.success('템플릿이 생성되었습니다.')
      }
      navigate('/templates')
    } catch (err) {
      toast.error(err.message || '저장 실패')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col h-screen">
      <div className="px-6 py-4 border-b shrink-0">
        <PageHeader
          title={isEdit ? `${draft.name || templateId} — 편집` : '신규 템플릿'}
          description={
            isEdit
              ? '편집 후 저장하면 새 버전이 발행됩니다. 기존 버전은 유지되어 과거 보고서가 그대로 동작합니다.'
              : '위젯을 조합해 템플릿을 만듭니다. v1으로 발행됩니다.'
          }
          breadcrumbs={[
            { label: '템플릿', to: '/templates' },
            { label: isEdit ? '편집' : '신규' },
          ]}
          actions={
            <>
              <Button variant="outline" asChild>
                <Link to="/templates">취소</Link>
              </Button>
              <Button onClick={onSave} disabled={saving}>
                <Save className="mr-2 h-4 w-4" />
                {isEdit ? '새 버전 발행' : 'v1 발행'}
              </Button>
            </>
          }
        />
      </div>

      <div className="flex-1 grid grid-cols-12 min-h-0">
        {/* Left: 템플릿 설정 + 위젯 팔레트 (always open) */}
        <aside className="col-span-3 border-r bg-muted/10 min-h-0">
          <ScrollArea className="h-full">
            <div className="p-3 space-y-5">
              {/* 템플릿 설정 — single column */}
              <section className="space-y-3">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground px-1">
                  템플릿 설정
                </div>
                {!isEdit && (
                  <div>
                    <Label className="text-xs">템플릿 ID</Label>
                    <Input
                      value={templateIdInput}
                      readOnly
                      className="mt-1 h-9 font-mono text-[11px] bg-muted/40"
                    />
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      자동 발급된 UUID. 발행 후 변경 불가.
                    </p>
                  </div>
                )}
                <div>
                  <Label className="text-xs">이름</Label>
                  <Input
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    placeholder="개발 주간 보고"
                    className="mt-1 h-9"
                  />
                </div>
                <div>
                  <Label className="text-xs">설명</Label>
                  <Textarea
                    value={draft.description}
                    onChange={(e) =>
                      setDraft({ ...draft, description: e.target.value })
                    }
                    placeholder="템플릿 용도"
                    className="mt-1"
                    rows={2}
                  />
                </div>
                <div>
                  <Label className="text-xs">카테고리</Label>
                  <select
                    value={draft.category}
                    onChange={(e) =>
                      setDraft({ ...draft, category: e.target.value })
                    }
                    className="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                  >
                    {(categories ?? []).map((c) => (
                      <option key={c.slug} value={c.slug}>
                        {c.name}
                      </option>
                    ))}
                    {draft.category &&
                      !(categories ?? []).some((c) => c.slug === draft.category) && (
                        <option value={draft.category}>
                          {draft.category} (삭제됨)
                        </option>
                      )}
                  </select>
                </div>
                {/* 가시성(공유 범위) — 생성은 종전대로, 수정 시에도 노출.
                    매니저는 편집 가능(저장 시 /scope 로 반영), 비매니저는 현재
                    공유 범위 읽기전용(서버도 매니저 전용이라 일치). */}
                <div>
                  <Label className="text-xs">가시성</Label>
                  {!isEdit || isManager ? (
                    <>
                      {/* 개인(비공개) 토글 — 켜면 나만 보는 템플릿이 된다
                          (게시한 보고서는 그래도 모두에게 렌더됨). */}
                      <label className="mt-1 flex items-start gap-2 rounded-md border p-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={isPrivate}
                          onChange={(e) => setIsPrivate(e.target.checked)}
                          className="mt-0.5"
                        />
                        <span className="text-[11px] leading-snug">
                          <span className="font-medium">개인(비공개)</span> — 나만
                          사용하는 템플릿. 다른 사용자의 템플릿 목록엔 보이지 않지만,
                          이 템플릿으로 게시한 보고서는 모두에게 정상 표시됩니다.
                        </span>
                      </label>
                      {!isPrivate &&
                        (isManager ? (
                          <>
                            <div className="mt-2">
                              <WorkspaceTreeSelect
                                orgWorkspaces={(workspaces ?? []).filter(
                                  (w) => w.kind === 'org' && !w.virtual,
                                )}
                                selected={new Set(draft.owner_workspace_slugs ?? [])}
                                onToggle={(wsSlug) => {
                                  const cur = draft.owner_workspace_slugs ?? []
                                  const next = cur.includes(wsSlug)
                                    ? cur.filter((s) => s !== wsSlug)
                                    : [...cur, wsSlug]
                                  setDraft({
                                    ...draft,
                                    owner_workspace_slugs: next.length ? next : null,
                                  })
                                }}
                                autoExpandSlugs={draft.owner_workspace_slugs ?? []}
                                searchPlaceholder="부서명 / slug 검색 (비우면 트리 보기)"
                                maxHeightClass="max-h-52"
                              />
                            </div>
                            <p className="mt-1 text-[10px] text-muted-foreground">
                              여러 부서 선택 가능. 비워두면 전사 공유.
                              {isEdit &&
                                ' (전사 공개 템플릿의 범위 축소는 관리자 영역이라 막힐 수 있습니다.)'}
                            </p>
                          </>
                        ) : (
                          // 일반 멤버(생성): 자기 부서 단독 소유로 고정.
                          <p className="mt-2 text-[11px] text-muted-foreground">
                            자기 부서(
                            {(workspaces ?? []).find((w) => w.slug === slug)?.name ??
                              slug}
                            )에만 생성됩니다. 전사 공개·다른 부서 공유는 매니저에게 문의하세요.
                          </p>
                        ))}
                    </>
                  ) : (
                    // 수정 + 비매니저 — 현재 공유 범위 읽기전용.
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      현재{' '}
                      {isPrivate
                        ? '개인(비공개)'
                        : draft.owner_workspace_slugs?.length
                          ? `공유 부서: ${draft.owner_workspace_slugs
                              .map(
                                (s) =>
                                  (workspaces ?? []).find((w) => w.slug === s)?.name ??
                                  s,
                              )
                              .join(', ')}`
                          : '전사 공개'}
                      . 공유 범위 변경은 매니저에게 문의하세요.
                    </p>
                  )}
                </div>
                <div>
                  <Label className="text-xs">보고서 기본 설정</Label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-1 w-full justify-start"
                    onClick={() => setSettingsDialogOpen(true)}
                  >
                    <Settings2 className="mr-2 h-3.5 w-3.5" />
                    보고서 설정
                  </Button>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    이 템플릿으로 새 보고서를 만들 때 적용될 기본값
                    (폭·위젯 간격 등). 보고서 작성 중에는 각자 다시 조절할
                    수 있습니다.
                    {Number.isFinite(draft.report_defaults?.page_width_px)
                      ? ` 폭: ${draft.report_defaults.page_width_px} px.`
                      : ' 폭: 기본값.'}
                    {Number.isFinite(draft.report_defaults?.page_gap_px)
                      ? ` 위젯 간격: ${draft.report_defaults.page_gap_px} px.`
                      : ' 위젯 간격: 기본값.'}
                  </p>
                </div>
                {isEdit && (
                  <div className="text-[11px] text-muted-foreground border-l-2 border-amber-400 bg-amber-50 dark:bg-amber-900/10 p-2 rounded-r">
                    저장 시 <strong>새 버전</strong>으로 발행됩니다. 기존
                    v{existing?.version}은 immutable.
                  </div>
                )}
              </section>

              <Separator />

              {/* 위젯 팔레트 */}
              <section>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground px-1 pb-1">
                  위젯 팔레트
                </div>
                <WidgetPicker
                  widgets={catalog?.widgets ?? []}
                  onSelect={(w) => addBlock(w.type)}
                  layout="list"
                  autoFocusSearch={false}
                />
                <p className="text-[10px] text-muted-foreground px-1 pt-2">
                  클릭 시 새 행에 추가. 캔버스에서 드래그·리사이즈로 배치.
                </p>
              </section>
            </div>
          </ScrollArea>
        </aside>

        {/* Middle: Block grid canvas. Width adapts to right-panel state. */}
        <main
          className={`${selectedBlock ? 'col-span-6' : 'col-span-9'} min-h-0 ${
            selectedBlock ? 'border-r' : ''
          }`}
        >
          <ScrollArea className="h-full">
            <div className="p-6 space-y-4">
              <div className="flex items-center justify-between px-1">
                <h2 className="text-sm font-semibold text-muted-foreground">
                  블록 ({draft.blocks.length}개) — 드래그·리사이즈로 배치
                </h2>
              </div>
              {draft.blocks.length === 0 ? (
                <Card className="border-dashed">
                  <CardContent className="py-12 text-center text-sm text-muted-foreground">
                    좌측 팔레트에서 위젯을 클릭해 추가하세요.
                  </CardContent>
                </Card>
              ) : (
                <MeasuredGrid
                  items={rglItems}
                  onLayoutChange={handleLayoutChange}
                >
                  {draft.blocks.map((block) => (
                    <div key={block.id}>
                      <BlockCard
                        block={block}
                        selected={selectedBlockId === block.id}
                        onSelect={() => setSelectedBlockId(block.id)}
                        onRemove={() => removeBlock(block.id)}
                      />
                    </div>
                  ))}
                </MeasuredGrid>
              )}
            </div>
          </ScrollArea>
        </main>

        {/* Right: block props panel — only mounted when a block is selected. */}
        {selectedBlock && (
          <aside className="col-span-3 min-h-0 bg-muted/10">
            <ScrollArea className="h-full">
              <div className="p-4">
                <BlockPropsEditor
                  block={selectedBlock}
                  catalog={catalog}
                  onChange={(patch) => updateBlock(selectedBlock.id, patch)}
                  onClose={() => setSelectedBlockId(null)}
                />
              </div>
            </ScrollArea>
          </aside>
        )}
      </div>

      <ReportSettingsDialog
        open={settingsDialogOpen}
        currentWidthPx={draft.report_defaults?.page_width_px ?? null}
        defaultWidthPx={DEFAULT_REPORT_WIDTH_PX}
        currentGapPx={draft.report_defaults?.page_gap_px ?? null}
        defaultGapPx={DEFAULT_REPORT_GAP_PX}
        currentRichTextPrefixes={[
          draft.report_defaults?.page_rich_text_prefix_d0 ?? null,
          draft.report_defaults?.page_rich_text_prefix_d1 ?? null,
          draft.report_defaults?.page_rich_text_prefix_d2 ?? null,
        ]}
        onClose={() => setSettingsDialogOpen(false)}
        onApplyWidth={(px) => {
          setDraft((d) => {
            // Drop the key entirely when set back to default so the
            // saved schema doc stays minimal and old templates that
            // never opened the dialog don't gain noise.
            const next = { ...(d.report_defaults ?? {}) }
            if (px == null) delete next.page_width_px
            else next.page_width_px = px
            return {
              ...d,
              report_defaults: Object.keys(next).length === 0 ? null : next,
            }
          })
          // Dialog handles its own close after "적용" — we just merge.
        }}
        onApplyGap={(px) => {
          setDraft((d) => {
            const next = { ...(d.report_defaults ?? {}) }
            if (px == null) delete next.page_gap_px
            else next.page_gap_px = px
            return {
              ...d,
              report_defaults: Object.keys(next).length === 0 ? null : next,
            }
          })
        }}
        onApplyRichTextPrefixes={(arr) => {
          // arr = [d0, d1, d2]. 빈/널은 그 depth 키를 지워 스키마를 최소로 유지
          // (다이얼로그를 안 연 옛 템플릿이 노이즈를 얻지 않게). 새 보고서가 이
          // 템플릿으로 생성될 때 page_rich_text_prefix_d0..2 로 상속된다.
          const safe = Array.isArray(arr) ? arr : [null, null, null]
          setDraft((d) => {
            const next = { ...(d.report_defaults ?? {}) }
            ;[0, 1, 2].forEach((i) => {
              const key = `page_rich_text_prefix_d${i}`
              const v =
                typeof safe[i] === 'string' && safe[i].trim()
                  ? safe[i].trim()
                  : null
              if (v == null) delete next[key]
              else next[key] = v
            })
            return {
              ...d,
              report_defaults: Object.keys(next).length === 0 ? null : next,
            }
          })
        }}
      />
    </div>
  )
}

function BlockCard({ block, selected, onSelect, onRemove }) {
  const renderer = getRenderer(block.type)
  if (!renderer) {
    return (
      <Card className="h-full border-destructive">
        <CardContent className="pt-4 text-sm text-destructive">
          미지의 위젯 타입: {block.type}
        </CardContent>
      </Card>
    )
  }
  const { Preview, Icon } = renderer
  return (
    <Card
      onClick={onSelect}
      className={`h-full overflow-hidden flex flex-col transition-colors ${
        selected ? 'ring-2 ring-primary' : ''
      }`}
    >
      <div className="flex items-center gap-2 px-3 py-1.5 border-b bg-muted/40 block-drag-handle cursor-move shrink-0">
        <GripVertical className="h-3 w-3 text-muted-foreground" />
        {Icon && <Icon className="h-3 w-3 text-muted-foreground" />}
        <span className="text-[11px] font-mono text-muted-foreground truncate flex-1">
          {block.id}
        </span>
        <Badge variant="outline" className="text-[10px]">
          {block.type}
        </Badge>
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5 text-destructive"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>
      {/* flex-1 + min-h-0 gives the preview an actual filled height. For
          short single-line widgets (heading) we additionally turn the
          content area into a flex row with items-center, so the lone
          child auto-centers vertically without relying on an h-full
          chain that depends on every parent passing height through. */}
      <CardContent
        className={`p-3 overflow-auto flex-1 min-h-0 ${
          block.type === 'heading' ? 'flex items-center' : ''
        }`}
      >
        <Preview props={block.props ?? {}} />
      </CardContent>
    </Card>
  )
}

function BlockPropsEditor({ block, catalog, onChange, onClose }) {
  const renderer = getRenderer(block.type)
  const widgetMeta = catalog?.byType?.[block.type]
  const { categories: sectionCategories } = useSectionTaxonomy()
  const [sectionPickerOpen, setSectionPickerOpen] = useState(false)
  if (!renderer || !widgetMeta) {
    return (
      <div className="text-sm text-destructive">미지의 위젯 타입: {block.type}</div>
    )
  }
  const { PropsPanel } = renderer
  // Resolve the current section into its display label (category + item)
  // so the row shows what's currently picked without forcing the writer
  // to open the picker. Falls back to the raw code if the taxonomy was
  // edited after this template was saved and the code no longer matches.
  const sectionHit = block.section
    ? findItemInCategories(sectionCategories, block.section)
    : null
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {widgetMeta.label}
          </div>
          <div className="text-[11px] text-muted-foreground mt-0.5">
            {widgetMeta.description}
          </div>
        </div>
        {onClose && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 -mt-1 -mr-1"
            onClick={onClose}
            title="닫기"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      <Separator />

      <div>
        <Label className="text-xs">블록 ID</Label>
        <Input
          value={block.id}
          onChange={(e) => onChange({ id: e.target.value.toLowerCase() })}
          className="mt-1 h-9 font-mono text-xs"
        />
        <p className="mt-1 text-[10px] text-muted-foreground">
          영문 소문자/숫자/언더스코어. 보고서 content의 키로 사용됨.
        </p>
      </div>

      <div className="text-[11px] text-muted-foreground border-l-2 border-blue-400 bg-blue-50 dark:bg-blue-900/10 p-2 rounded-r">
        layout: row {block.layout?.row}, col_span {block.layout?.col_span}, row_span{' '}
        {block.layout?.row_span ?? 1}
      </div>

      <Separator />

      <PropsPanel
        props={block.props ?? {}}
        onChange={(props) => onChange({ props })}
      />

      <Separator />

      <div>
        <Label className="text-xs">단락 구분 (기본값)</Label>
        <button
          type="button"
          onClick={() => setSectionPickerOpen(true)}
          className="mt-1 flex h-9 w-full items-center gap-2 rounded-md border border-input bg-background px-3 text-left text-xs hover:bg-muted transition-colors"
        >
          {sectionHit ? (
            <>
              <span
                className="h-2.5 w-2.5 rounded-full shrink-0"
                style={{ backgroundColor: sectionHit.category.color }}
              />
              <span className="truncate" style={{ color: sectionHit.category.color }}>
                {sectionHit.item.label}
              </span>
              <span className="ml-auto text-[10px] text-muted-foreground">
                {sectionHit.category.name}
              </span>
            </>
          ) : block.section ? (
            <span className="truncate text-muted-foreground">
              {block.section} <span className="italic">(분류 변경됨)</span>
            </span>
          ) : (
            <span className="text-muted-foreground">설정 안 함</span>
          )}
        </button>
        <p className="mt-1 text-[10px] text-muted-foreground">
          이 템플릿으로 새 보고서를 만들 때 이 블록에 기본으로 붙는 단락 구분.
          보고서 편집 모드에서 작성자가 재설정·삭제할 수 있습니다.
        </p>
      </div>

      <Separator />

      <details className="group">
        <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-wider text-muted-foreground py-1 hover:text-foreground select-none">
          메타데이터 (선택)
        </summary>
        <div className="mt-2">
          <BlockMetaEditor
            value={block.meta}
            onChange={(meta) => onChange({ meta })}
          />
        </div>
      </details>

      {sectionPickerOpen && (
        <SectionPickerDialog
          open
          categories={sectionCategories}
          currentSection={block.section ?? null}
          onPick={(code) => onChange({ section: code })}
          onClear={() => onChange({ section: null })}
          onClose={() => setSectionPickerOpen(false)}
        />
      )}
    </div>
  )
}

/**
 * Wraps GridLayout with `useContainerWidth` since react-grid-layout v2
 * dropped the WidthProvider HOC in favor of this hook.
 *
 * IMPORTANT: useContainerWidth returns `containerRef` (not `ref`) and
 * `mounted`. If the wrong key is destructured, the ref never attaches and
 * width stays at the hook's initialWidth (1280px) forever, causing the
 * canvas to overflow on narrow screens and underfill on wide ones.
 *
 * `measureBeforeMount: true` defers the first render until the parent has
 * been measured — combined with the `mounted` gate below this avoids the
 * 1280px flash entirely.
 */
function MeasuredGrid({ items, onLayoutChange, children }) {
  const { containerRef, width, mounted } = useContainerWidth({
    measureBeforeMount: true,
  })
  return (
    <div ref={containerRef} className="w-full">
      {mounted && width > 0 && (
        <GridLayout
          className="layout"
          layout={items}
          width={width}
          gridConfig={{
            cols: GRID_COLS,
            rowHeight: ROW_HEIGHT,
            margin: [8, 8],
          }}
          dragConfig={{ handle: '.block-drag-handle' }}
          onLayoutChange={onLayoutChange}
        >
          {children}
        </GridLayout>
      )}
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Helpers
// --------------------------------------------------------------------------- //
function buildRglItems(blocks) {
  // Group blocks by row, pack each row's blocks left-to-right by array order.
  const byRow = new Map()
  for (const b of blocks) {
    const row = b.layout?.row ?? 1
    if (!byRow.has(row)) byRow.set(row, [])
    byRow.get(row).push(b)
  }
  // For RGL, convert row 1..N to y values 0..N-1 in row order. We use the
  // configured row directly since gaps are fine (they collapse with vertical
  // compaction) but layout.row stays as authored.
  const items = []
  for (const b of blocks) {
    const row = b.layout?.row ?? 1
    const colSpan = clamp(b.layout?.col_span ?? GRID_COLS, 1, GRID_COLS)
    const rowSpan = Math.max(1, b.layout?.row_span ?? 2)
    // x = sum of col_spans of earlier same-row blocks
    const sameRow = byRow.get(row) ?? []
    let x = 0
    for (const sib of sameRow) {
      if (sib.id === b.id) break
      x += clamp(sib.layout?.col_span ?? GRID_COLS, 1, GRID_COLS)
    }
    items.push({
      i: b.id,
      x: Math.min(x, GRID_COLS - 1),
      y: row - 1,
      w: colSpan,
      h: rowSpan,
      minW: 1,
      maxW: GRID_COLS,
      minH: 1,
    })
  }
  return items
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n))
}

/**
 * RFC 4122 v4 UUID fallback for environments without `crypto.randomUUID`.
 * Modern browsers (Chrome 92+, Firefox 95+, Safari 15.4+) all expose the
 * native API, so this is just defensive — the output format is identical.
 */
function fallbackUuid() {
  const hex = '0123456789abcdef'
  const out = new Array(36)
  for (let i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      out[i] = '-'
    } else if (i === 14) {
      out[i] = '4'
    } else if (i === 19) {
      out[i] = hex[(Math.random() * 4) | 0 | 8]
    } else {
      out[i] = hex[(Math.random() * 16) | 0]
    }
  }
  return out.join('')
}

function sameLayouts(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    const la = a[i].layout ?? {}
    const lb = b[i].layout ?? {}
    if (a[i].id !== b[i].id) return false
    if (la.row !== lb.row || la.col_span !== lb.col_span || la.row_span !== lb.row_span) {
      return false
    }
  }
  return true
}
