import { useEffect, useMemo, useState } from 'react'
import { Plus, Sparkles, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { Textarea } from '@/shared/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import { Badge } from '@/shared/components/ui/badge'
import { Separator } from '@/shared/components/ui/separator'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/shared/components/ui/popover'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/shared/components/ui/tabs'
import { useWidgetCatalog } from '@/shared/hooks/useWidgetCatalog'
import { useSectionTaxonomy } from '@/shared/hooks/useSectionTaxonomy'
import {
  createPrompt,
  deletePrompt,
  demotePrompt,
  promotePrompt,
  updatePrompt,
} from '@/shared/api/prompts'
import { detectWidgetCoverage } from '@/shared/ai/promptTokens'
import { buildPromptContext, renderPrompt } from '@/shared/ai/promptRenderer'
import {
  BUILDER_MODES,
  assemblePromptBody,
  normalizeBuilderState,
} from '@/shared/ai/promptSkeletons'
import { PromptStatusBadge } from './PromptsTab'

// Mock template blocks injected into the preview when the body uses
// {{template_blocks}}. They're fake but shaped right so the author can
// see how the page-context section will look in real reports.
const _PREVIEW_TEMPLATE_BLOCKS = [
  {
    id: 'summary',
    type: 'heading',
    props: { level: 2, default_text: '요약' },
  },
  {
    id: 'body_text',
    type: 'rich_text',
    props: {},
  },
  {
    id: 'metrics',
    type: 'key_value',
    props: { label: '핵심 수치' },
  },
]

/**
 * Create + edit dialog for prompts. Mode is determined by the `mode`
 * prop ('create' / 'edit'). The non-admin / non-owner path renders the
 * form fields disabled but still surfaces the body for read access —
 * the same dialog doubles as a viewer so we don't need a separate
 * "view" affordance.
 *
 * settings JSON is edited as raw text (with parse-on-save). It's free
 * form so a structured editor isn't worth the complexity right now;
 * Phase 4 may flip this to a typed form once we know which keys matter.
 */
export function PromptEditDialog({
  mode,
  prompt,
  initialBody,
  initialBuilder,
  isAdmin,
  currentUserId,
  onClose,
  onSaved,
  onDeleted,
}) {
  const isEdit = mode === 'edit'
  const ownerUnofficial =
    !!prompt &&
    prompt.status === 'unofficial' &&
    prompt.created_by?.id === currentUserId
  const canEdit = !isEdit || isAdmin || ownerUnofficial
  const canPromoteDemoteDelete = isEdit && isAdmin

  // ── Easy/Advanced tab plumbing ──────────────────────────────────────
  //
  // The Easy form drives the body via assemblePromptBody(builder). We
  // store both `builder` (form state) and `body` (textarea value) so
  // Advanced can edit body directly without losing the form state on
  // tab switches. On save:
  //   - Easy tab  → builder is the truth. body is re-assembled, and
  //                 settings.builder is persisted so the form restores
  //                 next time.
  //   - Advanced  → body is the truth. settings.builder is stripped so
  //                 the next open lands on Advanced (the form would no
  //                 longer match the hand-edited body).
  //
  // Initial tab selection on open:
  //   - create mode + caller passed initialBuilder → Easy
  //   - create mode + caller passed initialBody    → Advanced (raw start)
  //   - edit mode + prompt.settings.builder exists → Easy
  //   - else                                       → Advanced
  const promptBuilder = prompt?.settings?.builder ?? null
  const initialTab =
    mode === 'create'
      ? initialBuilder
        ? 'easy'
        : 'advanced'
      : promptBuilder
        ? 'easy'
        : 'advanced'

  const [tab, setTab] = useState(initialTab)
  const [builder, setBuilder] = useState(() =>
    normalizeBuilderState(
      mode === 'create' ? initialBuilder : promptBuilder,
    ),
  )

  const [name, setName] = useState(prompt?.name ?? '')
  const [description, setDescription] = useState(prompt?.description ?? '')
  // In create mode, prefer the caller-supplied initialBody (from the
  // starting-point picker) so the textarea isn't a blank canvas. When
  // landing on Easy mode, the body field is irrelevant on save (we
  // re-assemble) but we still keep it in sync so a glance at Advanced
  // shows what's getting saved.
  const seedAdvancedBody = (() => {
    if (mode === 'edit') return prompt?.body ?? ''
    if (initialBuilder) return assemblePromptBody(initialBuilder)
    return initialBody ?? ''
  })()
  const [body, setBody] = useState(seedAdvancedBody)
  // settings is rendered as JSON text so users can pre-fill the schema
  // they want; parse failures surface as a toast on save. Default empty
  // object renders as "{}" so the field isn't blank-feeling. The
  // builder sub-key is stripped from this view — it's managed
  // structurally via the Easy form, not as raw JSON the user edits.
  const [settingsText, setSettingsText] = useState(
    JSON.stringify(_stripBuilder(prompt?.settings ?? {}), null, 2),
  )
  const [submitting, setSubmitting] = useState(false)
  // 편집 vs 미리보기 — preview renders the body with mock context via
  // renderPrompt so authors can see what the AI will actually receive.
  // Only meaningful on the Advanced tab.
  const [bodyView, setBodyView] = useState('edit')

  // Re-seed local state whenever the dialog opens with a different row
  // (the parent re-mounts on close, but explicit sync keeps prop changes
  // safe in case we ever switch to a persistent mount).
  useEffect(() => {
    setName(prompt?.name ?? '')
    setDescription(prompt?.description ?? '')
    const seededBuilder = normalizeBuilderState(
      mode === 'create' ? initialBuilder : prompt?.settings?.builder ?? null,
    )
    setBuilder(seededBuilder)
    if (mode === 'edit') {
      setBody(prompt?.body ?? '')
    } else if (initialBuilder) {
      setBody(assemblePromptBody(initialBuilder))
    } else {
      setBody(initialBody ?? '')
    }
    setSettingsText(
      JSON.stringify(_stripBuilder(prompt?.settings ?? {}), null, 2),
    )
    setTab(
      mode === 'create'
        ? initialBuilder
          ? 'easy'
          : 'advanced'
        : prompt?.settings?.builder
          ? 'easy'
          : 'advanced',
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt?.id, mode, initialBody, initialBuilder])

  // When on Easy tab, keep `body` in sync with the assembled output so
  // (a) save handler can just read `body` regardless of which tab is
  // active, and (b) flipping to Advanced shows the same text the AI
  // would receive. The assembly is cheap (pure string format).
  useEffect(() => {
    if (tab === 'easy') {
      setBody(assemblePromptBody(builder))
    }
  }, [tab, builder])

  const coverage = useMemo(() => detectWidgetCoverage(body), [body])

  function handleSwitchToAdvanced() {
    if (tab === 'advanced') return
    // Easy → Advanced is a one-way door: once the user hand-edits, the
    // form state can no longer be considered authoritative. Confirm so
    // they don't lose form linkage by accident.
    const ok = confirm(
      '고급 편집으로 전환하면 Easy 폼이 더 이상 본문과 동기화되지 않습니다.\n' +
        '저장 시 본문(고급 탭의 텍스트)이 그대로 저장되고, 다음에 열 때도 고급 탭으로 시작합니다.\n' +
        '계속하시겠어요?',
    )
    if (!ok) return
    setTab('advanced')
  }

  async function handleSave() {
    const trimmedName = name.trim()
    if (!trimmedName) {
      toast.error('이름은 비워둘 수 없습니다.')
      return
    }
    let parsedSettings = {}
    try {
      parsedSettings = settingsText.trim() ? JSON.parse(settingsText) : {}
      if (
        parsedSettings == null ||
        typeof parsedSettings !== 'object' ||
        Array.isArray(parsedSettings)
      ) {
        throw new Error('settings 은 JSON 객체여야 합니다.')
      }
    } catch (e) {
      toast.error('settings JSON 파싱 실패', {
        description: String(e?.message ?? e),
      })
      return
    }
    // Body + builder reconciliation per active tab:
    //  - Easy   : body = assemble(builder), settings.builder = builder
    //  - Advanced: body = current textarea text, drop settings.builder
    //              so next open lands on Advanced.
    let finalBody
    let finalSettings
    if (tab === 'easy') {
      // Curated mode requires ≥ 1 widget. The assembler renders a
      // placeholder warning otherwise, but block save explicitly so
      // the author doesn't ship a broken prompt.
      if (builder.mode === 'curated' && builder.widgets.length === 0) {
        toast.error('위젯 큐레이션 모드는 최소 1개 위젯을 선택해야 합니다.')
        return
      }
      finalBody = assemblePromptBody(builder)
      finalSettings = { ...parsedSettings, builder }
    } else {
      finalBody = body
      // strip builder so the next edit-open lands on Advanced (the
      // form would no longer reflect the hand-edited body anyway)
      finalSettings = _stripBuilder(parsedSettings)
    }
    setSubmitting(true)
    try {
      if (isEdit) {
        await updatePrompt(prompt.id, {
          name: trimmedName,
          description,
          body: finalBody,
          settings: finalSettings,
        })
        toast.success('프롬프트가 저장되었습니다.')
      } else {
        const created = await createPrompt({
          name: trimmedName,
          description,
          body: finalBody,
          settings: finalSettings,
        })
        toast.success(
          created.status === 'unofficial'
            ? '비공식으로 등록되었습니다 — 관리자 승인 후 모든 사용자에게 노출됩니다.'
            : '프롬프트가 등록되었습니다.',
        )
      }
      onSaved?.()
    } catch (e) {
      toast.error('저장 실패', {
        description: String(e?.response?.data?.detail ?? e?.message ?? e),
      })
    } finally {
      setSubmitting(false)
    }
  }

  async function handlePromote() {
    try {
      await promotePrompt(prompt.id)
      toast.success('공식 프롬프트로 승격되었습니다.')
      onSaved?.()
    } catch (e) {
      toast.error('승격 실패', {
        description: String(e?.response?.data?.detail ?? e?.message ?? e),
      })
    }
  }

  async function handleDemote() {
    try {
      await demotePrompt(prompt.id)
      toast.success('비공식으로 되돌렸습니다.')
      onSaved?.()
    } catch (e) {
      toast.error('되돌리기 실패', {
        description: String(e?.response?.data?.detail ?? e?.message ?? e),
      })
    }
  }

  async function handleDelete() {
    if (!confirm(`'${prompt.name}' 을(를) 삭제할까요? 되돌릴 수 없습니다.`)) {
      return
    }
    try {
      await deletePrompt(prompt.id)
      toast.success('삭제되었습니다.')
      onDeleted?.()
    } catch (e) {
      toast.error('삭제 실패', {
        description: String(e?.response?.data?.detail ?? e?.message ?? e),
      })
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[90vw] max-w-[1100px] h-[85vh] max-h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" />
            {isEdit ? (
              <span className="flex items-center gap-2">
                프롬프트 편집
                <PromptStatusBadge status={prompt.status} />
              </span>
            ) : (
              '새 프롬프트'
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-1 min-h-0 gap-3">
          <div className="flex flex-1 min-h-0 flex-col gap-3 overflow-y-auto pr-1">
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">이름</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={!canEdit || submitting}
                maxLength={128}
                placeholder="예: 주간 보고용 — extra blocks 자유 조합"
                className="h-9"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">설명</Label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={!canEdit || submitting}
                maxLength={2000}
                rows={2}
                placeholder="이 프롬프트가 어떤 상황에 어울리는지 짧게 설명해 두면 다른 사람도 알기 쉽습니다."
              />
            </div>

            <Tabs
              value={tab}
              onValueChange={(v) =>
                v === 'advanced' ? handleSwitchToAdvanced() : setTab(v)
              }
              className="flex flex-1 min-h-0 flex-col gap-2"
            >
              <TabsList className="self-start">
                <TabsTrigger value="easy">Easy 폼</TabsTrigger>
                <TabsTrigger value="advanced">고급 (raw)</TabsTrigger>
              </TabsList>
              <TabsContent value="easy" className="flex-1 min-h-0 mt-0">
                <PromptEasyForm
                  value={builder}
                  onChange={setBuilder}
                  disabled={!canEdit || submitting}
                />
              </TabsContent>
              <TabsContent value="advanced" className="flex-1 min-h-0 mt-0">
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <Label className="text-xs">
                      본문 (placeholder 토큰 사용 가능)
                    </Label>
                    <div className="flex items-center gap-1">
                      <BodyViewToggle value={bodyView} onChange={setBodyView} />
                      {canEdit && bodyView === 'edit' && (
                        <ContextTokenInsertButton
                          onInsert={(tok) => setBody((b) => b + tok)}
                        />
                      )}
                    </div>
                  </div>
                  {bodyView === 'edit' ? (
                    <Textarea
                      value={body}
                      onChange={(e) => setBody(e.target.value)}
                      disabled={!canEdit || submitting}
                      maxLength={200000}
                      rows={18}
                      placeholder="당신은 ReportArchive 보고서 작성 도우미입니다. ... {{widget:bulleted_list}} ..."
                      className="font-mono text-[12px] leading-relaxed"
                    />
                  ) : (
                    <BodyPreview body={body} />
                  )}
                </div>
                <div className="flex flex-col gap-1.5 mt-3">
                  <Label className="text-xs">
                    settings (JSON) — model / temperature 등 향후 API 호출 시 사용
                  </Label>
                  <Textarea
                    value={settingsText}
                    onChange={(e) => setSettingsText(e.target.value)}
                    disabled={!canEdit || submitting}
                    rows={5}
                    placeholder='{ "model": "claude-sonnet-4-6", "temperature": 0.3 }'
                    className="font-mono text-[12px] leading-relaxed"
                  />
                </div>
              </TabsContent>
            </Tabs>
          </div>

          <CoverageSidebar coverage={coverage} />
        </div>

        <DialogFooter className="shrink-0 gap-2 sm:gap-2 border-t pt-3 mt-2">
          {canPromoteDemoteDelete && (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleDelete}
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="mr-1 h-3.5 w-3.5" />
                삭제
              </Button>
              {prompt.status === 'unofficial' ? (
                <Button variant="outline" size="sm" onClick={handlePromote}>
                  공식으로 승격
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={handleDemote}>
                  비공식으로 되돌리기
                </Button>
              )}
            </>
          )}
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={onClose}>
            {canEdit ? '취소' : '닫기'}
          </Button>
          {canEdit && (
            <Button size="sm" onClick={handleSave} disabled={submitting}>
              {submitting ? '저장 중...' : '저장'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Right-hand sidebar that surfaces, in real time as the body changes,
 *  which widgets the prompt currently covers. Mirrors what the picker
 *  will eventually show next to each card so the author can confirm the
 *  coverage matches their intent. */
function CoverageSidebar({ coverage }) {
  const { catalog } = useWidgetCatalog()
  const catalogTypes = useMemo(
    () => new Set((catalog?.widgets ?? []).map((w) => w.type)),
    [catalog],
  )
  const { widgetTypes, wildcardAll, pageContext } = coverage

  // Split detected widget tokens into "in catalog" vs "unknown" so typos
  // (e.g. `{{widget:bullet_list}}` instead of `bulleted_list`) surface
  // immediately rather than failing silently at AI invocation time.
  const known = widgetTypes.filter((t) => catalogTypes.has(t))
  const unknown = widgetTypes.filter((t) => !catalogTypes.has(t))

  // Mode classification — drives the badge stack at the top of the
  // sidebar. The three modes are not mutually exclusive (a body can
  // mix wildcard + page_context for an "edit-with-full-catalog" prompt)
  // so we render whichever ones apply. The "위젯 큐레이션" mode kicks
  // in only when neither wildcard nor page-context are set but the
  // author has wired at least one {{widget:foo}} token — a deliberate
  // narrow-scope prompt.
  const modes = []
  if (wildcardAll) {
    modes.push({
      label: '전체 위젯',
      tone: 'default',
      effect:
        '사용자가 AI 다이얼로그에서 위젯을 체크 해제 가능 (포함 위젯만 AI 가 봄). 가장 일반적인 모드.',
    })
  }
  if (pageContext) {
    modes.push({
      label: '페이지 편집',
      tone: 'violet',
      effect:
        '보고서 화면에서 현재 페이지의 블록 목록을 함께 보내고, AI 가 기존 블록 content 만 채웁니다.',
    })
  }
  if (!wildcardAll && !pageContext && known.length > 0) {
    modes.push({
      label: '위젯 큐레이션',
      tone: 'secondary',
      effect:
        '본문에 {{widget:foo}} 로 박힌 위젯들로만 한정됩니다. 사용자는 체크 해제로 줄일 수 없습니다.',
    })
  }
  if (modes.length === 0) {
    modes.push({
      label: '모드 미지정',
      tone: 'outline',
      effect:
        '컨텍스트 토큰이 하나도 없습니다. 위 + 토큰 으로 widget_catalog / template_blocks 중 적어도 하나는 넣는 게 보통입니다.',
    })
  }

  return (
    <div className="w-56 shrink-0 flex flex-col gap-2 rounded-md border bg-muted/20 p-3 text-xs overflow-y-auto">
      <div className="font-semibold">프롬프트 모드</div>
      <div className="flex flex-col gap-1.5">
        {modes.map((m) => (
          <ModeBadgeRow key={m.label} badge={m} />
        ))}
      </div>
      <Separator className="my-1" />
      <div className="font-semibold">검출된 위젯</div>
      {known.length === 0 && !wildcardAll && (
        <p className="text-[10px] text-muted-foreground">
          본문에 <code>&#123;&#123;widget:foo&#125;&#125;</code> 토큰을 넣으면 여기에 표시됩니다.
        </p>
      )}
      {wildcardAll && (
        <p className="text-[10px] text-muted-foreground">
          전체 위젯 모드라 카탈로그 전체가 펼쳐집니다. 개별 chip 은 생략.
        </p>
      )}
      {known.length > 0 && !wildcardAll && (
        <div className="flex flex-wrap gap-1">
          {known.map((t) => (
            <Badge key={t} variant="secondary" className="text-[10px]">
              {t}
            </Badge>
          ))}
        </div>
      )}
      {unknown.length > 0 && (
        <>
          <Separator className="my-1" />
          <div className="font-semibold text-destructive">
            미등록 토큰 ({unknown.length})
          </div>
          <p className="text-[10px] text-muted-foreground">
            카탈로그에 없는 위젯 타입입니다. 오타이거나 더 이상 존재하지 않는 위젯일 수 있어요.
          </p>
          <div className="flex flex-wrap gap-1">
            {unknown.map((t) => (
              <Badge
                key={t}
                variant="outline"
                className="border-destructive text-destructive text-[10px]"
              >
                {t}
              </Badge>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/** Single mode-badge row in the sidebar — pill on top, one-line effect
 *  description below. The effect line is the whole point of the badge:
 *  it teaches first-time authors what runtime behavior the token combo
 *  in their body actually unlocks (체크 해제 패널 vs 페이지 편집 모드 등). */
function ModeBadgeRow({ badge }) {
  const variant =
    badge.tone === 'outline'
      ? 'outline'
      : badge.tone === 'secondary'
        ? 'secondary'
        : 'default'
  const cls =
    badge.tone === 'violet'
      ? 'w-fit bg-violet-600 hover:bg-violet-600/90'
      : 'w-fit'
  return (
    <div>
      <Badge variant={variant} className={cls}>
        {badge.label}
      </Badge>
      <p className="mt-1 text-[10px] text-muted-foreground leading-relaxed">
        {badge.effect}
      </p>
    </div>
  )
}

/** 편집 ↔ 미리보기 segmented toggle. Compact so it fits next to the
 *  token-insert buttons in the body header row. */
function BodyViewToggle({ value, onChange }) {
  const base = 'h-7 px-2 text-[11px] rounded-sm transition-colors'
  return (
    <div className="flex items-center rounded-md border bg-muted/40 p-0.5">
      <button
        type="button"
        onClick={() => onChange('edit')}
        className={`${base} ${value === 'edit' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
      >
        편집
      </button>
      <button
        type="button"
        onClick={() => onChange('preview')}
        className={`${base} ${value === 'preview' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
      >
        미리보기
      </button>
    </div>
  )
}

/** Read-only render of the body with {{...}} tokens expanded against
 *  representative mock context. Lets the author confirm what the AI
 *  will actually receive before saving — most importantly, that the
 *  catalog/examples chunks land where the author thinks they will.
 *
 *  Mock data:
 *   - widgetCatalog : real catalog (loaded via useWidgetCatalog)
 *   - sectionCategories : real taxonomy (via useSectionTaxonomy)
 *   - templateBlocks : 3 mock blocks (heading + rich_text + key_value) so
 *     {{template_blocks}} produces a non-empty section
 *   - templateId / version : fixed PREVIEW values
 *   - excludedWidgetTypes : none — the AiPromptDialog handles exclusion
 *     at use-time, this is just an authoring preview
 */
function BodyPreview({ body }) {
  const { catalog } = useWidgetCatalog()
  const { categories } = useSectionTaxonomy()
  const rendered = useMemo(() => {
    if (!body) {
      return '(본문이 비어 있습니다. 편집 탭에서 작성하세요.)'
    }
    const context = buildPromptContext({
      widgetCatalog: catalog,
      sectionCategories: categories,
      templateBlocks: _PREVIEW_TEMPLATE_BLOCKS,
      templateId: 'PREVIEW_TEMPLATE_ID',
      templateVersion: 1,
    })
    return renderPrompt(body, context)
  }, [body, catalog, categories])

  const charCount = rendered.length
  const kb = Math.round(charCount / 102.4) / 10

  return (
    <div className="flex flex-col gap-1">
      <div className="text-[10px] text-muted-foreground">
        실제 보고서에서는 현재 페이지의 템플릿 블록 목록과 위젯 카탈로그가 들어갑니다.
        여기는 작성용 미리보기라 페이지 블록은 mock 3개 (heading / rich_text / key_value)
        로 고정. AiPromptDialog 의 위젯 체크 해제 효과는 여기서 시뮬레이트하지 않습니다.
      </div>
      <Textarea
        readOnly
        value={rendered}
        onClick={(e) => e.currentTarget.select()}
        rows={18}
        className="font-mono text-[12px] leading-relaxed bg-muted/20"
      />
      <div className="text-[10px] text-muted-foreground">
        {charCount.toLocaleString()} 자 · {kb} KB
      </div>
    </div>
  )
}

/** Catalog popover for inserting non-widget context tokens — the
 *  wildcard ({{widget_catalog}}, {{widget_examples}}), the page-context
 *  ({{template_blocks}}), and the simple variable substitutions
 *  ({{template_id}}, {{template_version}}, {{section_taxonomy}}).
 *
 *  Each entry carries a one-line effect description so the author
 *  knows what's getting pasted and what runtime behavior it unlocks
 *  (e.g., the wildcard tokens enable the user's widget-checkbox panel
 *  in AiPromptDialog at use-time). */
function ContextTokenInsertButton({ onInsert }) {
  const [open, setOpen] = useState(false)

  const groups = [
    {
      title: '컨텍스트 (자동 펼침)',
      items: [
        {
          token: '{{widget_catalog}}',
          label: '전체 위젯 카탈로그',
          desc:
            '모든 위젯의 props_schema 를 펼침. 사용자 다이얼로그에서 위젯 체크 해제가 가능해집니다 (전체 위젯 모드).',
        },
        {
          token: '{{widget_examples}}',
          label: '전체 위젯 예시',
          desc:
            '하드코딩된 위젯별 props/content 예시 모음. widget_catalog 와 짝지어 쓰는 게 일반적.',
        },
        {
          token: '{{template_blocks}}',
          label: '현재 페이지 블록 목록',
          desc:
            '이 토큰이 있으면 페이지 편집 모드. AI 가 현재 페이지의 기존 블록 id 들을 보고 content 를 채웁니다.',
        },
      ],
    },
    {
      title: '단순 치환',
      items: [
        {
          token: '{{template_id}}',
          label: '현재 페이지 템플릿 id',
          desc: 'pages[].template_id 골격에 그대로 박아 두면 됩니다.',
        },
        {
          token: '{{template_version}}',
          label: '현재 페이지 템플릿 version',
          desc: 'pages[].template_version 골격 값.',
        },
        {
          token: '{{section_taxonomy}}',
          label: '단락 구분 taxonomy',
          desc:
            '관리자 등록 단락 코드들. block_sections 매핑 지시할 때 사용.',
        },
      ],
    },
  ]

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-7">
          + 토큰
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-96 p-2" align="end">
        <div className="space-y-3 max-h-96 overflow-y-auto">
          {groups.map((g) => (
            <div key={g.title}>
              <div className="text-[10px] font-semibold text-muted-foreground px-1 mb-1">
                {g.title}
              </div>
              <div className="space-y-0.5">
                {g.items.map((it) => (
                  <button
                    key={it.token}
                    type="button"
                    onClick={() => {
                      onInsert(`\n${it.token}\n`)
                      setOpen(false)
                    }}
                    className="block w-full rounded-sm px-2 py-1.5 text-left hover:bg-accent"
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[11px]">{it.token}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {it.label}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[10px] text-muted-foreground leading-relaxed">
                      {it.desc}
                    </p>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** Return a shallow copy of settings with the `builder` sub-key removed.
 *  Used both when seeding the settings textarea (so users editing raw
 *  JSON don't see + accidentally clobber the form state) and when
 *  switching Easy→Advanced (so the form state doesn't shadow the
 *  hand-edited body). */
function _stripBuilder(settings) {
  if (!settings || typeof settings !== 'object') return {}
  // eslint-disable-next-line no-unused-vars
  const { builder, ...rest } = settings
  return rest
}

/** ─── Easy 폼 ────────────────────────────────────────────────────────
 *  Drives the prompt body via assemblePromptBody(state). The author
 *  fills in 5 fields and the dialog re-renders the assembled body in
 *  Advanced/preview behind the scenes — no need to see 80 lines of
 *  raw text.
 *
 *  Field set:
 *   - mode          : 새 보고서 / 템플릿 채우기 / 위젯 큐레이션
 *   - purpose       : free-text 1줄 — "이 프롬프트는 ~~ 용입니다"
 *   - extra_rules   : list of extra rules appended to 작성 규칙 numbered list
 *   - extra_donts   : list of extra don'ts appended to 절대 하지 말 것
 *   - widgets       : (curated mode only) widget type multi-select
 */
function PromptEasyForm({ value, onChange, disabled }) {
  const { catalog } = useWidgetCatalog()
  const widgets = catalog?.widgets ?? []

  function patch(p) {
    onChange({ ...value, ...p })
  }
  function addRule() {
    patch({ extra_rules: [...value.extra_rules, ''] })
  }
  function updateRule(i, v) {
    const next = [...value.extra_rules]
    next[i] = v
    patch({ extra_rules: next })
  }
  function removeRule(i) {
    patch({ extra_rules: value.extra_rules.filter((_, j) => j !== i) })
  }
  function addDont() {
    patch({ extra_donts: [...value.extra_donts, ''] })
  }
  function updateDont(i, v) {
    const next = [...value.extra_donts]
    next[i] = v
    patch({ extra_donts: next })
  }
  function removeDont(i) {
    patch({ extra_donts: value.extra_donts.filter((_, j) => j !== i) })
  }
  function toggleWidget(type) {
    const has = value.widgets.includes(type)
    patch({
      widgets: has
        ? value.widgets.filter((t) => t !== type)
        : [...value.widgets, type],
    })
  }

  return (
    <div className="flex flex-col gap-4">
      {/* ── 모드 선택 ─────────────────────────────────────────────── */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs">모드</Label>
        <div className="grid gap-1.5 sm:grid-cols-3">
          {BUILDER_MODES.map((m) => {
            const active = value.mode === m.key
            return (
              <button
                key={m.key}
                type="button"
                disabled={disabled}
                onClick={() => patch({ mode: m.key })}
                className={
                  'flex flex-col items-start gap-1 rounded-md border p-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ' +
                  (active
                    ? 'border-primary bg-primary/5'
                    : 'hover:bg-accent')
                }
              >
                <div className="flex items-center gap-1.5">
                  <span className="font-medium text-xs">{m.label}</span>
                  {active && (
                    <Badge className="h-4 px-1.5 text-[10px] font-normal">
                      선택됨
                    </Badge>
                  )}
                </div>
                <p className="text-[10px] text-muted-foreground leading-relaxed line-clamp-3">
                  {m.desc}
                </p>
              </button>
            )
          })}
        </div>
      </div>

      {/* ── 용도 ───────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs">
          용도 한 줄 <span className="text-muted-foreground">(선택)</span>
        </Label>
        <Input
          value={value.purpose}
          onChange={(e) => patch({ purpose: e.target.value })}
          disabled={disabled}
          maxLength={500}
          placeholder="예: 주간 업무 보고서를 사용자 메모만 보고 빠르게 만들기"
          className="h-9"
        />
        <p className="text-[10px] text-muted-foreground">
          본문 상단에 “이 프롬프트의 용도” 섹션으로 들어갑니다. AI 가 컨텍스트를 잡는 데 도움.
        </p>
      </div>

      {/* ── 추가 지시사항 ─────────────────────────────────────────── */}
      <RuleList
        label="추가 지시사항"
        hint="작성 규칙 번호 목록의 끝에 한 줄씩 덧붙입니다. 예: “한국어로 답해”, “한 페이지를 넘기지 마”."
        items={value.extra_rules}
        onAdd={addRule}
        onUpdate={updateRule}
        onRemove={removeRule}
        placeholder="규칙 한 줄"
        disabled={disabled}
      />

      {/* ── 추가 금지사항 ─────────────────────────────────────────── */}
      <RuleList
        label="추가 금지사항"
        hint="“절대 하지 말 것” 체크리스트에 한 줄씩 덧붙입니다. 예: “표 위주로만 작성하지 마”, “이미지 위젯 생성 금지”."
        items={value.extra_donts}
        onAdd={addDont}
        onUpdate={updateDont}
        onRemove={removeDont}
        placeholder="금지사항 한 줄"
        disabled={disabled}
      />

      {/* ── 위젯 선택 (큐레이션 모드 한정) ───────────────────────── */}
      {value.mode === 'curated' && (
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">
            허용 위젯 <span className="text-destructive">*</span>
          </Label>
          <p className="text-[10px] text-muted-foreground">
            큐레이션 모드는 여기서 선택한 위젯들만 사용 가능합니다. 사용자가 다이얼로그에서 이 목록을 줄일 수는 있어도 늘릴 수는 없습니다 (의도적 잠금). 최소 1개 필수.
          </p>
          <div className="rounded-md border bg-muted/20 p-2 max-h-56 overflow-y-auto">
            {widgets.length === 0 && (
              <p className="text-[10px] text-muted-foreground p-2">
                위젯 카탈로그를 불러오는 중입니다.
              </p>
            )}
            <div className="grid gap-1 sm:grid-cols-2">
              {widgets.map((w) => {
                const checked = value.widgets.includes(w.type)
                return (
                  <label
                    key={w.type}
                    className={
                      'flex items-center gap-2 rounded-sm px-2 py-1 text-xs cursor-pointer hover:bg-accent ' +
                      (disabled ? 'pointer-events-none opacity-50' : '')
                    }
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleWidget(w.type)}
                      disabled={disabled}
                      className="h-3.5 w-3.5"
                    />
                    <span className="font-mono">{w.type}</span>
                    <span className="ml-auto text-muted-foreground text-[10px]">
                      {w.label}
                    </span>
                  </label>
                )
              })}
            </div>
          </div>
          <div className="text-[10px] text-muted-foreground">
            선택 {value.widgets.length} 개
          </div>
        </div>
      )}

      <p className="text-[10px] text-muted-foreground border-t pt-2">
        저장 시 본문은 위 입력을 기반으로 자동 조립됩니다. 조립된 본문은
        “고급 (raw)” 탭에서 확인할 수 있습니다 (전환 시 Easy 폼과의 연결은
        끊깁니다).
      </p>
    </div>
  )
}

/** Reusable add/edit/remove list of one-line strings — used by both the
 *  추가 지시사항 and 추가 금지사항 sections so they stay visually
 *  consistent and the two arrays share the same UX.  */
function RuleList({
  label,
  hint,
  items,
  onAdd,
  onUpdate,
  onRemove,
  placeholder,
  disabled,
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs">
        {label} <span className="text-muted-foreground">(선택)</span>
      </Label>
      <p className="text-[10px] text-muted-foreground">{hint}</p>
      <div className="flex flex-col gap-1">
        {items.length === 0 && (
          <p className="text-[10px] text-muted-foreground italic px-1">
            (없음)
          </p>
        )}
        {items.map((v, i) => (
          <div key={i} className="flex items-center gap-1">
            <Input
              value={v}
              onChange={(e) => onUpdate(i, e.target.value)}
              disabled={disabled}
              maxLength={500}
              placeholder={placeholder}
              className="h-8 text-xs"
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onRemove(i)}
              disabled={disabled}
              className="h-8 w-8 p-0 shrink-0 text-muted-foreground hover:text-destructive"
              title="삭제"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onAdd}
        disabled={disabled}
        className="h-7 self-start text-xs"
      >
        <Plus className="mr-1 h-3 w-3" />
        한 줄 추가
      </Button>
    </div>
  )
}
