// 관계도 entity(관련정보) 필터 (지식그래프 Phase 2) — axis 별로 entity 값을
// 골라 보고서를 좁힌다. 선택은 axis 별 AND, 같은 axis 안에서는 OR (백엔드
// build_global_link_graph 의 ent_groups 규칙과 짝). 검색은 listEntities 의
// q 파라미터(전 axis 횡단)를 그대로 쓰고, 결과를 axis(type_slug) 별로 묶어
// 보여 준다. 선택된 값은 검색 결과 밖이어도 항상 위에 칩으로 떠 해제 가능.
import { useEffect, useMemo, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/shared/components/ui/popover'
import { listEntities } from '@/shared/api/entities'

/**
 * @param {object} props
 * @param {Array<{id:number, value:string, type_slug:string}>} props.selected
 * @param {(next:Array)=>void} props.onChange
 */
export function EntityFilter({ selected, onChange }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)

  // 팝오버가 열려 있을 때만 검색 — 입력에 디바운스(250ms).
  useEffect(() => {
    if (!open) return undefined
    let cancelled = false
    setLoading(true)
    const t = setTimeout(() => {
      listEntities({ q: q.trim() || undefined, limit: 50 })
        .then((res) => {
          if (!cancelled) setResults(res?.items ?? [])
        })
        .catch(() => {
          if (!cancelled) setResults([])
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [open, q])

  const selectedIds = useMemo(
    () => new Set(selected.map((e) => e.id)),
    [selected],
  )

  const toggle = (ent) => {
    if (selectedIds.has(ent.id)) {
      onChange(selected.filter((e) => e.id !== ent.id))
    } else {
      onChange([
        ...selected,
        { id: ent.id, value: ent.value, type_slug: ent.type_slug },
      ])
    }
  }

  // 검색 결과를 axis(type_slug) 별로 묶는다. 이미 선택된 항목은 칩에서
  // 따로 보여 주므로 목록에서도 체크 표시만 유지.
  const grouped = useMemo(() => {
    const map = new Map()
    for (const ent of results) {
      const key = ent.type_slug || '기타'
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(ent)
    }
    return [...map.entries()]
  }, [results])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1 rounded-md border bg-background px-2 text-[11px]"
        >
          <span className="text-muted-foreground">관련정보</span>
          <span
            className={
              selected.length ? 'text-foreground' : 'text-muted-foreground'
            }
          >
            {selected.length ? `${selected.length}개` : '전체'}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[280px] p-2" align="start">
        {/* 선택된 값 칩 — 검색과 무관하게 항상 보이고 바로 해제 가능 */}
        {selected.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1">
            {selected.map((e) => (
              <button
                key={e.id}
                type="button"
                onClick={() => toggle(e)}
                className="inline-flex items-center gap-1 rounded-full border bg-muted px-1.5 py-0.5 text-[11px] hover:bg-muted/70"
                title="제거"
              >
                <span className="opacity-60">{e.type_slug}</span>
                <span className="font-medium">{e.value}</span>
                <X className="h-3 w-3" />
              </button>
            ))}
          </div>
        )}

        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="관련정보 검색…"
          className="mb-2 h-7 w-full rounded-md border bg-background px-2 text-xs"
        />

        <div className="max-h-[260px] space-y-2 overflow-y-auto">
          {loading ? (
            <div className="grid place-items-center py-4">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : grouped.length === 0 ? (
            <p className="px-1 py-2 text-[11px] text-muted-foreground italic">
              {q.trim() ? '검색 결과 없음' : '관련정보 없음'}
            </p>
          ) : (
            grouped.map(([axis, items]) => (
              <div key={axis}>
                <p className="px-1 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {axis}
                </p>
                <div className="space-y-0.5">
                  {items.map((ent) => (
                    <label
                      key={ent.id}
                      className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted"
                    >
                      <input
                        type="checkbox"
                        checked={selectedIds.has(ent.id)}
                        onChange={() => toggle(ent)}
                        className="accent-indigo-500"
                      />
                      <span className="truncate">{ent.value}</span>
                      {ent.code && (
                        <span className="ml-auto text-[10px] text-muted-foreground">
                          {ent.code}
                        </span>
                      )}
                    </label>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>

        {selected.length > 0 && (
          <button
            type="button"
            onClick={() => onChange([])}
            className="mt-2 w-full rounded border px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted"
          >
            선택 해제
          </button>
        )}
      </PopoverContent>
    </Popover>
  )
}
