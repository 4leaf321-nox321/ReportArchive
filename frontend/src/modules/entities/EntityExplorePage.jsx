// 기준정보 탐색 (D-2 B) — 일반 사용자도 모델·부품·시험 등 기준정보가 서로
// 어떻게 연결됐는지 읽기 전용으로 탐색한다. 관리자 전용 "엔티티 관리" 안에만
// 있던 관계도 시각화를 누구나 들어오는 진입점으로 연다. 백엔드가 호출자 권한에
// 따라 노출을 가르므로(비관리자=active 기준정보만), 프론트는 평범히 호출한다.
//
// 좌측: 축(모델/부품/…) 선택 + 값 검색 → 값 고르기. 우측: 그 값의 **객체 프로필**
// (속성·관련객체·관련보고서·2단계 관계도)을 인라인으로. 관련객체 칩·관계도 노드를
// 클릭하면 그 값으로 시드를 바꿔 제자리에서 이어 탐색한다(ObjectProfile 재사용).
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2, Search, Boxes, ArrowUpRight } from 'lucide-react'
import { PageHeader } from '@/shared/components/PageHeader'
import { Button } from '@/shared/components/ui/button'
import { Combobox } from '@/shared/components/Combobox'
import { cn } from '@/shared/lib/utils'
import { listEntityTypes, listEntities } from '@/shared/api/entities'
import { ObjectProfile } from './ObjectProfilePage'

const CURRENT_YEAR = new Date().getFullYear()
// 연도 드롭다운 후보 — 올해부터 9년 전까지. "전체"는 null 로 표현.
const YEAR_OPTIONS = Array.from({ length: 10 }, (_, i) => CURRENT_YEAR - i)

export default function EntityExplorePage() {
  const navigate = useNavigate()
  const [types, setTypes] = useState([]) // 축 catalog
  const [typeId, setTypeId] = useState(null) // 선택된 축
  const [q, setQ] = useState('')
  const [year, setYear] = useState(CURRENT_YEAR) // null = 전체
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [seed, setSeed] = useState(null) // {id, value} — 선택된 값(프로필 대상)

  // 축 catalog — 1회 로드.
  useEffect(() => {
    let cancelled = false
    listEntityTypes()
      .then((res) => {
        if (cancelled) return
        const items = res?.items ?? []
        setTypes(items)
        if (items.length > 0) setTypeId((cur) => cur ?? items[0].id)
      })
      .catch(() => !cancelled && setTypes([]))
    return () => {
      cancelled = true
    }
  }, [])

  // 값 검색 — 축/검색어 변화에 디바운스로 반응. 비관리자는 active 값만 받는다
  // (listEntities 기본 includeDeprecated=false).
  // 연도 필터는 evergreen 축(시험·단계 등)엔 의미가 없다 — 그 축에선 드롭다운을
  // 숨기고 서버에도 year 를 안 보낸다(보내도 무시되지만 깔끔하게). 검색 effect 가
  // deps 로 참조하므로 effect 보다 위에서 선언해야 한다(TDZ).
  const selectedType = useMemo(
    () => types.find((t) => t.id === typeId) ?? null,
    [types, typeId],
  )
  const yearApplies =
    !!selectedType && selectedType.temporal_kind !== 'evergreen'

  useEffect(() => {
    if (typeId == null) return undefined
    let cancelled = false
    setSearching(true)
    const t = setTimeout(() => {
      listEntities({
        typeId,
        q,
        limit: 50,
        year: yearApplies && year != null ? year : undefined,
      })
        .then((res) => !cancelled && setResults(res?.items ?? []))
        .catch(() => !cancelled && setResults([]))
        .finally(() => !cancelled && setSearching(false))
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [typeId, q, year, yearApplies])

  const typeLabelById = useMemo(
    () => new Map(types.map((t) => [t.id, t.label])),
    [types],
  )

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b bg-background p-4">
        <PageHeader
          title="기준정보 탐색"
          description="모델·부품·시험 등 기준정보가 서로 어떻게 연결됐는지 살펴봅니다. 값을 고르면 그 객체의 프로필(속성·관련 객체·관련 보고서·관계도)이 열리고, 칩·노드를 클릭해 이어서 탐색하세요."
        />
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 좌측 — 축 선택 + 값 검색 + 결과 목록 */}
        <aside className="flex w-72 shrink-0 flex-col border-r">
          <div className="space-y-2 border-b p-3">
            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">객체</span>
              <Combobox
                options={types.map((t) => ({ value: t.id, label: t.label }))}
                value={typeId}
                onChange={(id) => {
                  setTypeId(Number(id))
                  setResults([])
                }}
                placeholder="객체 선택..."
                searchPlaceholder="객체 검색..."
                className="h-8 text-xs"
              />
            </div>
            {yearApplies && (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                연도
                <select
                  value={year ?? 'all'}
                  onChange={(e) =>
                    setYear(
                      e.target.value === 'all' ? null : Number(e.target.value),
                    )
                  }
                  className="h-8 flex-1 rounded-md border bg-background px-2 text-xs"
                  title="이 축은 연도별로 적용 여부가 갈립니다 — 연도를 좁히거나 전체를 보세요"
                >
                  <option value="all">전체</option>
                  {YEAR_OPTIONS.map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="값 검색 (예: SM6, 브레이크패드)"
                className="h-8 w-full rounded-md border bg-background pl-7 pr-3 text-xs"
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {searching && results.length === 0 ? (
              <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> 불러오는 중…
              </div>
            ) : results.length === 0 ? (
              <p className="px-1 py-6 text-center text-xs text-muted-foreground">
                {q ? '일치하는 값이 없습니다.' : '값이 없습니다.'}
              </p>
            ) : (
              <ul className="space-y-0.5">
                {results.map((e) => (
                  <li key={e.id}>
                    <button
                      type="button"
                      onClick={() => setSeed({ id: e.id, value: e.value })}
                      className={cn(
                        'w-full truncate rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                        seed?.id === e.id
                          ? 'bg-primary/10 font-medium text-primary'
                          : 'text-foreground/80 hover:bg-muted',
                      )}
                      title={e.value}
                    >
                      {e.value}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>

        {/* 우측 — 선택한 값의 프로필(속성·관련객체·관련보고서·관계도). 관련객체
            칩·관계도 노드를 클릭하면 시드를 그 값으로 바꿔 제자리에서 이어 탐색. */}
        <div className="min-w-0 flex-1 overflow-y-auto">
          {seed == null ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
              <Boxes className="h-8 w-8 opacity-40" />
              <p>
                왼쪽에서 {typeLabelById.get(typeId) ?? '값'}을(를) 골라 프로필을
                봅니다.
              </p>
            </div>
          ) : (
            <div className="p-4">
              <div className="mb-3 flex justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigate(`/entities/${seed.id}`)}
                  title="이 프로필을 전체 화면으로 열기"
                >
                  전체 화면 <ArrowUpRight className="ml-1 h-3.5 w-3.5" />
                </Button>
              </div>
              <ObjectProfile
                entityId={seed.id}
                onOpenEntity={(id, label) => setSeed({ id, value: label })}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
