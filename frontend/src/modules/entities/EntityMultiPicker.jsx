import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Search, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/shared/components/ui/popover'
import { cn } from '@/shared/lib/utils'
import { createEntity, listEntities } from '@/shared/api/entities'

/**
 * One-axis entity picker — compact horizontal chips + "+ 추가" popover.
 *
 * Drops into the 보고서 설정 dialog as one row per axis. Single-line by
 * design: the dialog stacks 7 of these (one per axis), so each row
 * staying short keeps the modal scannable.
 *
 * State shape — `value` is the *full* current set of selected entities
 * (slim EntityRefMini shape: `{ id, type_id, type_slug, value, code, status }`).
 * The picker is a controlled component; `onChange(nextValue)` fires
 * whenever the user picks, deselects, or adds a value.
 *
 * `multi=false` semantics (개발 단계 etc.): picking a new value REPLACES
 * the existing one; the chip-x still works to clear back to empty. We
 * trust the picker UI to enforce this — the DB does not.
 *
 * "+ '{q}' 새로 추가" fires `createEntity()` optimistically; the server
 * collapses case-insensitive duplicates to the canonical row, so racing
 * two users on the same name still converges to one entity id.
 */
export function EntityMultiPicker({
  type,
  value,
  onChange,
}) {
  const selected = Array.isArray(value) ? value : []
  const isMulti = !!type?.multi

  function pick(entity) {
    if (isMulti) {
      if (selected.some((e) => e.id === entity.id)) return
      onChange?.([...selected, toRefMini(entity, type)])
    } else {
      onChange?.([toRefMini(entity, type)])
    }
  }

  function remove(entityId) {
    onChange?.(selected.filter((e) => e.id !== entityId))
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {selected.map((e) => (
        <Chip key={e.id} entity={e} onRemove={() => remove(e.id)} />
      ))}
      <AddPopover type={type} selected={selected} onPick={pick} />
    </div>
  )
}

function toRefMini(entity, type) {
  // Normalize whichever shape we got — the popover hands back the full
  // EntityRead (from /api/entities) on pick + the new row from
  // createEntity; both have the same key names so this is mostly a
  // safety net. type_slug is what list views render off of.
  return {
    id: entity.id,
    type_id: entity.type_id ?? type.id,
    type_slug: entity.type_slug ?? type.slug,
    value: entity.value,
    code: entity.code ?? null,
    status: entity.status ?? 'active',
  }
}

function Chip({ entity, onRemove }) {
  const isDeprecated = entity.status === 'deprecated'
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs',
        isDeprecated
          ? 'border-dashed border-muted-foreground/40 bg-muted/30 text-muted-foreground'
          : 'border-border bg-background',
      )}
      title={
        isDeprecated
          ? `${entity.value} (비활성화된 값이지만 이 보고서에 태깅되어 있음)`
          : entity.value
      }
    >
      <span className="max-w-[12rem] truncate">{entity.value}</span>
      {entity.code && (
        <span className="text-[10px] text-muted-foreground">·{entity.code}</span>
      )}
      <button
        type="button"
        onClick={onRemove}
        className="-mr-1 ml-0.5 rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        title="제거"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  )
}

/**
 * Popover trigger + content. The query state lives here (not in the
 * parent) so re-mounting between dialog opens resets the search box —
 * stale half-typed queries don't carry over to the next session.
 */
function AddPopover({ type, selected, onPick }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const debounceRef = useRef(null)
  const inputRef = useRef(null)

  // Reset query/results each open so the popover doesn't show stale
  // matches from the previous axis the user touched.
  useEffect(() => {
    if (!open) {
      setQuery('')
      setItems([])
      return
    }
    const t = setTimeout(() => inputRef.current?.focus(), 30)
    return () => clearTimeout(t)
  }, [open])

  // Debounced server search — same 250ms cadence as ReportTypePicker.
  // Empty query loads the axis's active values up to limit=200; that's
  // the picker's default "what's available?" view.
  useEffect(() => {
    if (!open) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const fire = async () => {
      setLoading(true)
      try {
        const res = await listEntities({
          typeId: type.id,
          q: query || undefined,
          limit: 100,
        })
        setItems(res?.items ?? [])
      } catch (e) {
        toast.error(`${type.label} 불러오기 실패`, {
          description: String(e?.message ?? e),
        })
      } finally {
        setLoading(false)
      }
    }
    debounceRef.current = setTimeout(fire, query ? 250 : 0)
    return () => debounceRef.current && clearTimeout(debounceRef.current)
  }, [open, query, type.id, type.label])

  const trimmedQuery = query.trim()
  // Hide values already selected — re-picking the same chip would be a
  // no-op for multi axes and confusing for single axes. We still keep
  // them visible in their chip form above the popover.
  const selectedIds = useMemo(() => new Set(selected.map((s) => s.id)), [selected])
  const visibleItems = useMemo(
    () => items.filter((it) => !selectedIds.has(it.id)),
    [items, selectedIds],
  )
  const exactMatch = useMemo(
    () =>
      trimmedQuery
        ? items.find(
            (it) => it.value.trim().toLowerCase() === trimmedQuery.toLowerCase(),
          )
        : null,
    [items, trimmedQuery],
  )

  async function submitCreate() {
    const value = trimmedQuery
    if (!value) return
    setSubmitting(true)
    try {
      const created = await createEntity({ type_id: type.id, value })
      onPick(created)
      // Close the popover — for multi axes the user can re-open to add
      // another; we don't want them inadvertently double-adding the
      // same value while the chip is still rendering.
      setOpen(false)
    } catch (e) {
      toast.error('추가 실패', {
        description: String(e?.response?.data?.message ?? e?.message ?? e),
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
        >
          <Plus className="h-3 w-3" />
          {selected.length === 0 ? '추가' : ''}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-2">
        <div className="space-y-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`${type.label} 검색 또는 새로 추가...`}
              className="h-8 pl-7 text-sm"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && trimmedQuery && !exactMatch) {
                  e.preventDefault()
                  submitCreate()
                }
              }}
            />
          </div>

          <div className="max-h-60 overflow-y-auto rounded-md border bg-background">
            {loading && (
              <div className="px-3 py-2 text-center text-xs text-muted-foreground">
                불러오는 중...
              </div>
            )}
            {!loading && visibleItems.length === 0 && (
              <div className="px-3 py-3 text-center text-xs text-muted-foreground">
                {trimmedQuery
                  ? `'${trimmedQuery}' 와 일치하는 값이 없습니다.`
                  : '등록된 값이 없습니다.'}
              </div>
            )}
            {!loading &&
              visibleItems.map((it) => (
                <button
                  key={it.id}
                  type="button"
                  onClick={() => {
                    onPick(it)
                    // For multi axes leave the popover open so the user
                    // can keep selecting; for single axes close since
                    // the choice is complete.
                    if (!type.multi) setOpen(false)
                  }}
                  className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-sm hover:bg-accent"
                >
                  <span className="truncate">{it.value}</span>
                  {it.code && (
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {it.code}
                    </span>
                  )}
                </button>
              ))}
          </div>

          {trimmedQuery && !exactMatch && (
            <Button
              variant="outline"
              size="sm"
              className="w-full justify-start gap-2 text-xs"
              disabled={submitting}
              onClick={submitCreate}
            >
              <Plus className="h-3.5 w-3.5" />
              <span className="truncate">
                <strong>“{trimmedQuery}”</strong> 새 {type.label} 으로 추가
              </span>
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
