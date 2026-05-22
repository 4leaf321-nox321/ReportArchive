import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Plus, Search, ShieldCheck, ShieldQuestion, X } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { Textarea } from '@/shared/components/ui/textarea'
import { Badge } from '@/shared/components/ui/badge'
import { toast } from 'sonner'
import { cn } from '@/shared/lib/utils'
import {
  listReportTypes,
  createReportType,
} from '@/shared/api/reportTypes'

/**
 * Inline searchable report-type picker. Drops into a parent dialog tab
 * (no modal-in-modal); the parent handles open/close + the eventual
 * "save" of the selected id back into the report draft.
 *
 * Two view modes:
 *   - 'list'   : search + results + a "+ '{q}' 새로 추가" affordance when
 *                the query doesn't exactly match an existing entry.
 *   - 'create' : a small inline form for entering a description before
 *                the new type is materialized. Submitting calls
 *                createReportType and immediately selects the result.
 *
 * Non-admin callers always end up creating *unofficial* entries (server
 * enforces this) — we surface that via a small inline note so they know
 * the entry won't be visible to others until an admin promotes it.
 */
export function ReportTypePicker({ value, onChange, currentType, autoFocus = true, className }) {
  const [query, setQuery] = useState('')
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState('list') // 'list' | 'create'
  const [draftName, setDraftName] = useState('')
  const [draftDesc, setDraftDesc] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const debounceRef = useRef(null)
  const inputRef = useRef(null)

  // Auto-focus the search input so keyboard-driven users can type
  // immediately on dialog open.
  useEffect(() => {
    if (autoFocus && mode === 'list') {
      const t = setTimeout(() => inputRef.current?.focus(), 30)
      return () => clearTimeout(t)
    }
  }, [autoFocus, mode])

  // Debounced server search. 250ms is fast enough that the list feels
  // live but cuts ~80% of keystroke round-trips. The first load (q='')
  // runs immediately so the empty-input state shows official types.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const fire = async () => {
      setLoading(true)
      try {
        const res = await listReportTypes({ q: query || undefined, limit: 100 })
        setItems(res?.items ?? [])
      } catch (e) {
        toast.error('보고서 종류 불러오기 실패', {
          description: String(e?.message ?? e),
        })
      } finally {
        setLoading(false)
      }
    }
    debounceRef.current = setTimeout(fire, query ? 250 : 0)
    return () => debounceRef.current && clearTimeout(debounceRef.current)
  }, [query])

  const trimmedQuery = query.trim()
  const exactMatch = useMemo(
    () =>
      trimmedQuery
        ? items.find((it) => it.name.toLowerCase() === trimmedQuery.toLowerCase())
        : null,
    [items, trimmedQuery]
  )

  function startCreate(name) {
    setDraftName(name)
    setDraftDesc('')
    setMode('create')
  }

  async function submitCreate() {
    const name = draftName.trim()
    if (!name) return
    setSubmitting(true)
    try {
      const created = await createReportType({
        name,
        description: draftDesc.trim(),
      })
      // The server is idempotent on case-insensitive name; either we
      // created a new row or were handed back an existing one. Either
      // way we just select it.
      onChange?.(created)
      toast.success('보고서 종류가 등록되었습니다.', {
        description:
          created.status === 'unofficial'
            ? '비공식 상태로 추가되었습니다 — 관리자 승인 후 다른 사용자도 선택할 수 있습니다.'
            : `'${created.name}' 으로 설정되었습니다.`,
      })
      setMode('list')
      setQuery('')
    } catch (e) {
      toast.error('추가 실패', {
        description: String(e?.response?.data?.detail ?? e?.message ?? e),
      })
    } finally {
      setSubmitting(false)
    }
  }

  if (mode === 'create') {
    return (
      <div className={cn('space-y-3 pt-2', className)}>
        <div className="flex items-center gap-2 text-sm">
          <Plus className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium">새 보고서 종류 추가</span>
        </div>
        <div>
          <Label className="text-xs">이름</Label>
          <Input
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            maxLength={128}
            className="mt-1 h-9"
            placeholder="예: 주간 보고"
          />
        </div>
        <div>
          <Label className="text-xs">설명 (선택)</Label>
          <Textarea
            value={draftDesc}
            onChange={(e) => setDraftDesc(e.target.value)}
            maxLength={2000}
            rows={3}
            className="mt-1"
            placeholder="이 종류가 어떤 보고서에 쓰이는지 짧게 적어두면 다른 사람도 알 수 있어요."
          />
        </div>
        <p className="text-[11px] text-muted-foreground">
          관리자가 아니면 우선 <strong>비공식</strong>으로 등록되며, 관리자 승인 후
          다른 사용자에게도 노출됩니다.
        </p>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={() => setMode('list')}>
            취소
          </Button>
          <Button size="sm" onClick={submitCreate} disabled={submitting || !draftName.trim()}>
            {submitting ? '추가 중...' : '추가'}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className={cn('space-y-2 pt-2 flex flex-col min-h-0', className)}>
      <div className="relative shrink-0">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="이름이나 설명으로 검색..."
          className="pl-8 h-9"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="flex-1 min-h-[18rem] overflow-y-auto rounded-md border bg-background p-2">
        {/* Grid layout — more options visible at a glance than a stacked
            list. Column count scales with the modal width; auto-fill +
            minmax means narrow modals still get readable cards. */}
        <div
          className="grid gap-2"
          style={{
            gridTemplateColumns: 'repeat(auto-fill, minmax(13rem, 1fr))',
          }}
        >
          {/* "지정 안 함" — same card chrome as the rest so the grid
              stays visually uniform. */}
          <button
            type="button"
            onClick={() => onChange?.(null)}
            className={cn(
              'flex flex-col gap-1 rounded-md border p-2 text-left text-sm transition-colors hover:bg-accent',
              value == null
                ? 'border-primary bg-primary/5 ring-1 ring-primary/40'
                : 'border-border',
            )}
          >
            <div className="flex w-full items-center gap-1.5">
              <span className="flex-1 truncate italic text-muted-foreground">
                지정 안 함
              </span>
              {value == null && (
                <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
              )}
            </div>
          </button>

          {!loading &&
            items.map((it) => (
              <button
                type="button"
                key={it.id}
                onClick={() => onChange?.(it)}
                className={cn(
                  'flex flex-col gap-1 rounded-md border p-2 text-left transition-colors hover:bg-accent',
                  value === it.id
                    ? 'border-primary bg-primary/5 ring-1 ring-primary/40'
                    : 'border-border',
                )}
              >
                <div className="flex w-full items-center gap-1.5 min-w-0">
                  <span className="flex-1 truncate text-sm font-medium">
                    {it.name}
                  </span>
                  {value === it.id && (
                    <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                  )}
                </div>
                <div>
                  <StatusBadge status={it.status} />
                </div>
                {it.description && (
                  <p className="line-clamp-2 text-[11px] text-muted-foreground">
                    {it.description}
                  </p>
                )}
              </button>
            ))}
        </div>

        {loading && (
          <div className="px-3 py-4 text-center text-xs text-muted-foreground">
            불러오는 중...
          </div>
        )}

        {!loading && items.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            일치하는 종류가 없습니다.
          </div>
        )}
      </div>

      {/* "+ 새로 추가" — exact-match 가 없을 때만 노출 */}
      {trimmedQuery && !exactMatch && (
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-start gap-2"
          onClick={() => startCreate(trimmedQuery)}
        >
          <Plus className="h-4 w-4" />
          <span className="truncate">
            <strong>“{trimmedQuery}”</strong> 새로 추가
          </span>
        </Button>
      )}

      {currentType && (
        <div className="mt-2 rounded-md border bg-muted/30 px-3 py-2 text-xs">
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">현재 선택:</span>
            <span className="font-medium">{currentType.name}</span>
            <StatusBadge status={currentType.status} />
          </div>
          {currentType.description && (
            <p className="mt-0.5 text-muted-foreground">{currentType.description}</p>
          )}
        </div>
      )}
    </div>
  )
}

function StatusBadge({ status }) {
  if (status === 'official') {
    return (
      <Badge
        variant="secondary"
        className="h-4 gap-0.5 px-1.5 text-[10px] font-normal"
        title="공식 — 모든 사용자에게 노출됩니다"
      >
        <ShieldCheck className="h-2.5 w-2.5" />
        공식
      </Badge>
    )
  }
  return (
    <Badge
      variant="outline"
      className="h-4 gap-0.5 px-1.5 text-[10px] font-normal"
      title="비공식 — 작성자 본인과 관리자만 볼 수 있습니다"
    >
      <ShieldQuestion className="h-2.5 w-2.5" />
      비공식
    </Badge>
  )
}

export { StatusBadge as ReportTypeStatusBadge }
