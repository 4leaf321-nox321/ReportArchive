// 객체 중심 검색 (Phase C) — 타입 + 이름 + 속성 + 관계로 객체를 찾는 재사용 컴포넌트.
// 「기준정보 탐색」과 「검색」의 객체 탭이 공유한다. 결과 클릭 → 객체 프로필.
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, Loader2, X } from 'lucide-react'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { Badge } from '@/shared/components/ui/badge'
import { Combobox } from '@/shared/components/Combobox'
import { useAsync } from '@/shared/hooks/useAsync'
import {
  listEntityTypes,
  listTypeProperties,
  listRelationTypes,
  listEntities,
  searchEntities,
} from '@/shared/api/entities'

/** 값 없는 필터는 요청에서 뺀다. */
function buildProps(defs, filters) {
  const out = []
  for (const d of defs) {
    const f = filters[d.key]
    if (!f) continue
    if (['number', 'year', 'date'].includes(d.data_type)) {
      const min = f.min?.toString().trim()
      const max = f.max?.toString().trim()
      if (min && max) out.push({ key: d.key, op: 'between', value: [min, max] })
      else if (min) out.push({ key: d.key, op: 'gte', value: min })
      else if (max) out.push({ key: d.key, op: 'lte', value: max })
    } else if (d.data_type === 'bool') {
      if (f.value === 'true' || f.value === 'false')
        out.push({ key: d.key, op: 'is', value: f.value === 'true' })
    } else if (d.data_type === 'enum') {
      if (f.value) out.push({ key: d.key, op: 'eq', value: f.value })
    } else {
      // text / url
      if (f.value?.trim()) out.push({ key: d.key, op: 'contains', value: f.value.trim() })
    }
  }
  return out
}

export function ObjectSearch({ onPick }) {
  const navigate = useNavigate()
  const [axisId, setAxisId] = useState(null)
  const [q, setQ] = useState('')
  const [filters, setFilters] = useState({}) // key -> {value} | {min,max}
  const [rel, setRel] = useState(null) // { relation, dst, dstLabel }
  const [results, setResults] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)

  const { data: typesRes } = useAsync(() => listEntityTypes(), [])
  const axes = typesRes?.items ?? []

  const { data: defsRes } = useAsync(
    () => (axisId ? listTypeProperties(axisId) : Promise.resolve({ items: [] })),
    [axisId],
  )
  const defs = defsRes?.items ?? []
  // 필터 지원 data_type 만 컨트롤 노출.
  const filterableDefs = defs.filter((d) =>
    ['enum', 'number', 'year', 'date', 'bool', 'text', 'url'].includes(d.data_type),
  )

  const { data: relTypesRes } = useAsync(() => listRelationTypes(), [])
  const relTypes = relTypesRes?.items ?? []

  // 필터 바뀌면 디바운스 후 검색.
  const body = useMemo(
    () => ({
      type_id: axisId ?? undefined,
      q: q.trim() || undefined,
      props: buildProps(filterableDefs, filters),
      relations: rel?.dst ? [{ relation: rel.relation || undefined, dst_id: rel.dst }] : [],
      limit: 50,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [axisId, q, filters, rel, defsRes],
  )

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const t = setTimeout(() => {
      searchEntities(body)
        .then((res) => {
          if (cancelled) return
          setResults(res?.items ?? [])
          setTotal(res?.total ?? 0)
        })
        .catch(() => !cancelled && (setResults([]), setTotal(0)))
        .finally(() => !cancelled && setLoading(false))
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [body])

  function pick(e) {
    if (onPick) onPick(e)
    else navigate(`/entities/${e.id}`)
  }

  function setFilter(key, next) {
    setFilters((prev) => {
      const p = { ...prev }
      if (next == null) delete p[key]
      else p[key] = next
      return p
    })
  }

  const hasAnyFilter =
    q.trim() || Object.keys(filters).length > 0 || rel?.dst

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-56">
          <Label className="text-xs text-muted-foreground">객체 종류</Label>
          <Combobox
            options={axes.map((t) => ({ value: t.id, label: t.label }))}
            value={axisId}
            onChange={(id) => {
              setAxisId(Number(id))
              setFilters({})
              setRel(null)
            }}
            placeholder="전체 (이름 검색만)"
            searchPlaceholder="종류 검색..."
          />
        </div>
        <div className="relative min-w-[14rem] flex-1">
          <Label className="text-xs text-muted-foreground">이름</Label>
          <Search className="pointer-events-none absolute left-2.5 top-[1.9rem] h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="이름·코드·설명 검색…"
            className="h-9 pl-7"
          />
        </div>
      </div>

      {/* 속성 필터 (축 선택 시) */}
      {axisId != null && filterableDefs.length > 0 && (
        <div className="grid gap-x-4 gap-y-2 rounded-md border bg-muted/20 p-3 [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))]">
          {filterableDefs.map((d) => (
            <PropFilter
              key={d.id}
              def={d}
              value={filters[d.key]}
              onChange={(v) => setFilter(d.key, v)}
            />
          ))}
        </div>
      )}

      {/* 관계 필터 */}
      {axisId != null && (
        <RelationFilter relTypes={relTypes} value={rel} onChange={setRel} />
      )}

      {/* 결과 */}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {loading ? (
            <span className="inline-flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" /> 검색 중…
            </span>
          ) : (
            `${total}건${total > results.length ? ` (상위 ${results.length} 표시)` : ''}`
          )}
        </span>
        {hasAnyFilter && (
          <button
            type="button"
            onClick={() => {
              setQ('')
              setFilters({})
              setRel(null)
            }}
            className="hover:text-foreground"
          >
            필터 초기화
          </button>
        )}
      </div>
      <div className="divide-y rounded-md border">
        {results.length === 0 && !loading ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            결과가 없습니다.
          </p>
        ) : (
          results.map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => pick(e)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
            >
              <span className="min-w-0 flex-1 truncate font-medium">{e.value}</span>
              {e.code && (
                <code className="shrink-0 text-[11px] text-muted-foreground">{e.code}</code>
              )}
              <Badge variant="outline" className="shrink-0 text-[9px]">
                {e.type_slug}
              </Badge>
            </button>
          ))
        )}
      </div>
    </div>
  )
}

function PropFilter({ def, value, onChange }) {
  const label = (
    <Label className="text-xs">
      {def.label}
      {def.unit && <span className="ml-1 text-muted-foreground">({def.unit})</span>}
    </Label>
  )
  const dt = def.data_type

  if (dt === 'enum') {
    const opts = (def.enum_options ?? []).map((o) =>
      typeof o === 'object' ? o : { value: o, label: o },
    )
    return (
      <div className="space-y-1">
        {label}
        <select
          value={value?.value ?? ''}
          onChange={(e) => onChange(e.target.value ? { value: e.target.value } : null)}
          className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
        >
          <option value="">전체</option>
          {opts.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    )
  }
  if (dt === 'bool') {
    return (
      <div className="space-y-1">
        {label}
        <select
          value={value?.value ?? ''}
          onChange={(e) => onChange(e.target.value ? { value: e.target.value } : null)}
          className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
        >
          <option value="">전체</option>
          <option value="true">예</option>
          <option value="false">아니오</option>
        </select>
      </div>
    )
  }
  if (['number', 'year', 'date'].includes(dt)) {
    const type = dt === 'date' ? 'date' : 'text'
    const update = (patch) => {
      const next = { ...(value || {}), ...patch }
      onChange(next.min || next.max ? next : null)
    }
    return (
      <div className="space-y-1">
        {label}
        <div className="flex items-center gap-1">
          <Input
            type={type}
            inputMode={dt === 'date' ? undefined : 'numeric'}
            value={value?.min ?? ''}
            onChange={(e) => update({ min: e.target.value })}
            placeholder="최소"
            className="h-8"
          />
          <span className="text-muted-foreground">~</span>
          <Input
            type={type}
            inputMode={dt === 'date' ? undefined : 'numeric'}
            value={value?.max ?? ''}
            onChange={(e) => update({ max: e.target.value })}
            placeholder="최대"
            className="h-8"
          />
        </div>
      </div>
    )
  }
  // text / url
  return (
    <div className="space-y-1">
      {label}
      <Input
        value={value?.value ?? ''}
        onChange={(e) => onChange(e.target.value ? { value: e.target.value } : null)}
        placeholder="포함…"
        className="h-8"
      />
    </div>
  )
}

/** 관계 필터 — 대상 객체(검색) + (선택) 관계 종류. "이 대상에 연결된 객체". */
function RelationFilter({ relTypes, value, onChange }) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const { data } = useAsync(
    () =>
      open && q.trim()
        ? listEntities({ q: q.trim(), limit: 15 })
        : Promise.resolve({ items: [] }),
    [open, q],
  )
  const results = data?.items ?? []

  if (value?.dst) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">관계:</span>
        <select
          value={value.relation ?? ''}
          onChange={(e) => onChange({ ...value, relation: e.target.value || null })}
          className="h-8 rounded-md border bg-background px-2 text-xs"
        >
          <option value="">아무 관계</option>
          {relTypes.map((rt) => (
            <option key={rt.slug} value={rt.slug}>
              {rt.label}
            </option>
          ))}
        </select>
        <span className="text-muted-foreground">→ 대상</span>
        <Badge variant="secondary" className="gap-1 text-[11px]">
          {value.dstLabel ?? `#${value.dst}`}
          <button type="button" onClick={() => onChange(null)} aria-label="해제">
            <X className="h-3 w-3" />
          </button>
        </Badge>
      </div>
    )
  }

  return (
    <div className="relative text-xs">
      <span className="text-muted-foreground">관계 필터 — 대상 객체:</span>
      <div className="relative mt-1 max-w-xs">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="이 대상에 연결된 객체 찾기…"
          className="h-8"
        />
        {open && q.trim() && results.length > 0 && (
          <div className="absolute z-20 mt-1 max-h-40 w-full overflow-y-auto rounded-md border bg-popover shadow-md">
            {results.map((r) => (
              <button
                key={r.id}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault()
                  onChange({ relation: null, dst: r.id, dstLabel: r.value })
                  setQ('')
                  setOpen(false)
                }}
                className="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-accent"
              >
                <span className="truncate">{r.value}</span>
                <Badge variant="outline" className="shrink-0 text-[9px]">
                  {r.type_slug}
                </Badge>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
