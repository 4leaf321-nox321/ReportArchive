import { useEffect, useMemo, useRef, useState } from 'react'
import { Sparkles, Trash2 } from 'lucide-react'
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
import { useWidgetCatalog } from '@/shared/hooks/useWidgetCatalog'
import {
  createPrompt,
  deletePrompt,
  demotePrompt,
  promotePrompt,
  updatePrompt,
} from '@/shared/api/prompts'
import { detectWidgetCoverage } from '@/shared/ai/promptTokens'
import { PromptStatusBadge } from './PromptsTab'

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

  const [name, setName] = useState(prompt?.name ?? '')
  const [description, setDescription] = useState(prompt?.description ?? '')
  const [body, setBody] = useState(prompt?.body ?? '')
  // settings is rendered as JSON text so users can pre-fill the schema
  // they want; parse failures surface as a toast on save. Default empty
  // object renders as "{}" so the field isn't blank-feeling.
  const [settingsText, setSettingsText] = useState(
    JSON.stringify(prompt?.settings ?? {}, null, 2),
  )
  const [submitting, setSubmitting] = useState(false)

  // Re-seed local state whenever the dialog opens with a different row
  // (the parent re-mounts on close, but explicit sync keeps prop changes
  // safe in case we ever switch to a persistent mount).
  useEffect(() => {
    setName(prompt?.name ?? '')
    setDescription(prompt?.description ?? '')
    setBody(prompt?.body ?? '')
    setSettingsText(JSON.stringify(prompt?.settings ?? {}, null, 2))
  }, [prompt?.id])

  const coverage = useMemo(() => detectWidgetCoverage(body), [body])

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
    setSubmitting(true)
    try {
      if (isEdit) {
        await updatePrompt(prompt.id, {
          name: trimmedName,
          description,
          body,
          settings: parsedSettings,
        })
        toast.success('프롬프트가 저장되었습니다.')
      } else {
        const created = await createPrompt({
          name: trimmedName,
          description,
          body,
          settings: parsedSettings,
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
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-xs">본문 (placeholder 토큰 사용 가능)</Label>
                {canEdit && (
                  <WidgetTokenInsertButton
                    onInsert={(tok) => setBody((b) => b + tok)}
                  />
                )}
              </div>
              <Textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                disabled={!canEdit || submitting}
                maxLength={200000}
                rows={18}
                placeholder="당신은 ReportArchive 보고서 작성 도우미입니다. ... {{widget:bulleted_list}} ..."
                className="font-mono text-[12px] leading-relaxed"
              />
            </div>
            <div className="flex flex-col gap-1.5">
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
  const { widgetTypes, wildcardAll } = coverage

  // Split detected widget tokens into "in catalog" vs "unknown" so typos
  // (e.g. `{{widget:bullet_list}}` instead of `bulleted_list`) surface
  // immediately rather than failing silently at AI invocation time.
  const known = widgetTypes.filter((t) => catalogTypes.has(t))
  const unknown = widgetTypes.filter((t) => !catalogTypes.has(t))

  return (
    <div className="w-56 shrink-0 flex flex-col gap-2 rounded-md border bg-muted/20 p-3 text-xs overflow-y-auto">
      <div className="font-semibold">검출된 위젯</div>
      {wildcardAll && (
        <>
          <div className="text-[10px] text-muted-foreground">
            본문에 <code>&#123;&#123;widget_catalog&#125;&#125;</code> 또는{' '}
            <code>&#123;&#123;widget_examples&#125;&#125;</code> 가 있어 전체 위젯을 다룹니다.
          </div>
          <Badge className="w-fit">전체 위젯</Badge>
          <Separator className="my-1" />
        </>
      )}
      {known.length === 0 && !wildcardAll && (
        <p className="text-[10px] text-muted-foreground">
          본문에 <code>&#123;&#123;widget:foo&#125;&#125;</code> 토큰을 넣으면 여기에 표시됩니다.
        </p>
      )}
      {known.length > 0 && (
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

/** Catalog popover for inserting `{{widget:foo}}` tokens at the end of
 *  the body. Click → appends `{{widget:type}}\n` so typing flow stays
 *  natural; users are still free to type the token manually. */
function WidgetTokenInsertButton({ onInsert }) {
  const { catalog } = useWidgetCatalog()
  const widgets = catalog?.widgets ?? []
  const [open, setOpen] = useState(false)
  const inputRef = useRef(null)
  const [filter, setFilter] = useState('')
  const filtered = widgets.filter(
    (w) =>
      !filter ||
      w.type.toLowerCase().includes(filter.toLowerCase()) ||
      (w.label ?? '').toLowerCase().includes(filter.toLowerCase()),
  )
  useEffect(() => {
    if (open) {
      setFilter('')
      setTimeout(() => inputRef.current?.focus(), 30)
    }
  }, [open])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-7">
          + 위젯 토큰
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2" align="end">
        <Input
          ref={inputRef}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="위젯 타입 검색..."
          className="h-8 mb-2"
        />
        <div className="max-h-72 overflow-y-auto space-y-0.5">
          {filtered.length === 0 && (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">
              일치하는 위젯이 없습니다.
            </p>
          )}
          {filtered.map((w) => (
            <button
              key={w.type}
              type="button"
              onClick={() => {
                onInsert(`\n{{widget:${w.type}}}\n`)
                setOpen(false)
              }}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-xs hover:bg-accent"
            >
              <span className="font-mono">{w.type}</span>
              <span className="ml-auto text-muted-foreground">{w.label}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
