// @멘션의 "관련 정보(엔티티)" 선택 picker — 단일 선택.
//
// 축(EntityType)은 관리자가 런타임에 추가할 수 있어 종류가 늘어난다. 그래서
// 축 목록을 listEntityTypes() 로 받아 드롭다운을 데이터 주도로 그리고, 값은
// listEntities({typeId, q}) 로 검색한다. 축이 늘어나도 이 컴포넌트는 코드
// 변경 없이 자동 반영된다.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Input } from '@/shared/components/ui/input'
import { cn } from '@/shared/lib/utils'
import { listEntities, listEntityTypes } from '@/shared/api/entities'

/**
 *  @param {object} props
 *  @param {object|null} props.selected  선택된 엔티티(EntityRead) | null
 *  @param {(e:object|null)=>void} props.onSelect
 */
export function EntityMentionPicker({ selected, onSelect }) {
  const [axes, setAxes] = useState([])
  const [axisId, setAxisId] = useState(null)
  const [q, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [loadingAxes, setLoadingAxes] = useState(false)
  const [loadingList, setLoadingList] = useState(false)

  // 축 목록 로드 — 첫 축을 기본 선택.
  useEffect(() => {
    let cancelled = false
    setLoadingAxes(true)
    listEntityTypes()
      .then((data) => {
        if (cancelled) return
        const items = Array.isArray(data?.items) ? data.items : []
        setAxes(items)
        if (items.length > 0) setAxisId((cur) => cur ?? items[0].id)
      })
      .catch((err) => console.warn('listEntityTypes failed', err))
      .finally(() => {
        if (!cancelled) setLoadingAxes(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 값 검색 — 축/검색어 변경 시 디바운스 후 조회.
  const debounceRef = useRef(null)
  useEffect(() => {
    if (axisId == null) return undefined
    let cancelled = false
    setLoadingList(true)
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      listEntities({ typeId: axisId, q, limit: 50 })
        .then((data) => {
          if (cancelled) return
          setResults(Array.isArray(data?.items) ? data.items : [])
        })
        .catch((err) => console.warn('listEntities failed', err))
        .finally(() => {
          if (!cancelled) setLoadingList(false)
        })
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(debounceRef.current)
    }
  }, [axisId, q])

  const axisOptions = useMemo(
    () => axes.map((a) => ({ id: a.id, label: a.label })),
    [axes],
  )

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <select
          value={axisId ?? ''}
          onChange={(e) => {
            setAxisId(Number(e.target.value))
            onSelect?.(null)
          }}
          disabled={loadingAxes || axisOptions.length === 0}
          className="h-8 shrink-0 rounded-md border bg-background px-2 text-xs"
          title="축(종류)"
        >
          {axisOptions.length === 0 && <option value="">축 없음</option>}
          {axisOptions.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
        <Input
          value={q}
          onChange={(e) => {
            setQuery(e.target.value)
            onSelect?.(null)
          }}
          placeholder="값 검색 (예: A1234)"
          className="h-8 flex-1 text-xs"
        />
      </div>
      <div className="text-[10px] text-muted-foreground px-0.5">
        {loadingList ? (
          <span className="inline-flex items-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin" /> 불러오는 중…
          </span>
        ) : (
          `${results.length}건`
        )}
      </div>
      <ul className="max-h-[200px] overflow-y-auto rounded border bg-muted/30">
        {results.length === 0 ? (
          <li className="px-2 py-1 text-[11px] text-muted-foreground italic">
            {loadingList ? ' ' : '일치하는 값이 없습니다.'}
          </li>
        ) : (
          results.map((ent) => (
            <li key={ent.id}>
              <button
                type="button"
                onClick={() => onSelect?.(ent)}
                className={cn(
                  'flex w-full items-center justify-between gap-2 px-2 py-1 text-left text-[11px]',
                  selected?.id === ent.id
                    ? 'bg-primary/15 text-foreground'
                    : 'hover:bg-muted/70',
                  ent.status === 'deprecated' && 'opacity-60',
                )}
              >
                <span className="truncate font-medium">{ent.value}</span>
                {ent.code && (
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {ent.code}
                  </span>
                )}
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  )
}
