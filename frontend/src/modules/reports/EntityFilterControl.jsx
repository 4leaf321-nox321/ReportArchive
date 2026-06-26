import { useEffect, useMemo, useState } from 'react'
import { Filter, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { Badge } from '@/shared/components/ui/badge'
import { Label } from '@/shared/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/shared/components/ui/popover'
import { listEntityTypes } from '@/shared/api/entities'
import { EntityMultiPicker } from '@/modules/entities/EntityMultiPicker'

/**
 * 엔티티 태그 필터 — "필터" 팝오버(선택 개수 배지) 안에 축별 EntityMultiPicker
 * 한 줄씩. 선택 칩은 버튼 옆에 인라인으로도 떠서 툴바만 봐도 현재 필터가 보인다.
 *
 * 보고서 목록과 전문검색 페이지가 공유(D-2) — `selected`는 EntityRefMini 배열,
 * `onChange(next)`로 위로 전달. EntityMultiPicker를 그대로 써서 "+ 새 값 추가"도
 * 라이브(목록에서 못 찾은 모델을 즉석 추가 가능).
 */
export function EntityFilterControl({
  selected,
  onChange,
  // '관련 포함'(2b) — 켜면 선택 태그를 관계 그래프로 넓혀(이행 자손 + 비이행
  // 1-hop) 부품·시험·불량까지 함께 잡는다. related/onRelatedChange 를 주면
  // 토글이 노출된다(검색·목록 두 곳이 공유). 안 주면 토글 없이 기존 동작.
  related,
  onRelatedChange,
}) {
  const [open, setOpen] = useState(false)
  const [types, setTypes] = useState(null)

  // 축 목록은 작고 안정 — 첫 팝오버 열 때 한 번 조회(페이지 초기 페인트와 분리).
  useEffect(() => {
    if (!open || types !== null) return
    let cancelled = false
    listEntityTypes()
      .then((res) => {
        if (!cancelled) setTypes(res?.items ?? [])
      })
      .catch((e) => {
        if (cancelled) return
        toast.error('축 목록 불러오기 실패', {
          description: String(e?.message ?? e),
        })
      })
    return () => {
      cancelled = true
    }
  }, [open, types])

  const byTypeSlug = useMemo(() => {
    const m = new Map()
    for (const e of selected || []) {
      const slug = e.type_slug ?? ''
      if (!m.has(slug)) m.set(slug, [])
      m.get(slug).push(e)
    }
    return m
  }, [selected])

  function setAxisValue(slug, nextList) {
    const others = (selected || []).filter((e) => (e.type_slug ?? '') !== slug)
    onChange?.([...others, ...nextList])
  }

  function removeOne(id) {
    onChange?.((selected || []).filter((e) => e.id !== id))
  }

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 gap-1 px-2 text-xs">
            <Filter className="h-3 w-3" />
            필터
            {selected.length > 0 && (
              <Badge
                variant="secondary"
                className="ml-0.5 h-4 px-1.5 text-[10px] font-normal"
              >
                {selected.length}
              </Badge>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[28rem] p-3">
          {types === null && (
            <p className="text-xs text-muted-foreground">불러오는 중...</p>
          )}
          {types !== null && types.length === 0 && (
            <p className="text-xs text-muted-foreground">등록된 축이 없습니다.</p>
          )}
          {types !== null && types.length > 0 && (
            <div className="space-y-2">
              {types.map((t) => (
                <div key={t.id} className="flex items-start gap-3">
                  <Label className="w-20 shrink-0 pt-1.5 text-xs text-muted-foreground">
                    {t.label}
                  </Label>
                  <div className="min-w-0 flex-1">
                    <EntityMultiPicker
                      type={t}
                      value={byTypeSlug.get(t.slug) ?? []}
                      onChange={(next) => setAxisValue(t.slug, next)}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </PopoverContent>
      </Popover>
      {/* 인라인 칩 — 다이얼로그 칩과 같은 모양이라 알아보기 쉽다. 선택이 있을 때만. */}
      {selected.map((e) => (
        <span
          key={e.id}
          className="inline-flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-[11px]"
          title={`${e.type_slug}: ${e.value}`}
        >
          <span className="max-w-[10rem] truncate">{e.value}</span>
          <button
            type="button"
            onClick={() => removeOne(e.id)}
            className="-mr-1 ml-0.5 rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            title="필터에서 제거"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      {/* '관련 포함' 토글 — 선택이 있을 때만. part_of 자손 + 시험·불량 등
          관계로 묶인 보고서까지 함께 검색/필터. */}
      {selected.length > 0 && onRelatedChange && (
        <label
          className="inline-flex cursor-pointer select-none items-center gap-1.5 text-xs text-muted-foreground"
          title="선택한 태그와 관계로 묶인 항목(하위 부품·걸린 시험·불량 등)이 달린 보고서까지 포함"
        >
          <input
            type="checkbox"
            checked={!!related}
            onChange={() => onRelatedChange(!related)}
            className="h-3.5 w-3.5"
          />
          <span>관련 포함</span>
        </label>
      )}
      {selected.length > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-muted-foreground"
          onClick={() => onChange?.([])}
        >
          초기화
        </Button>
      )}
    </div>
  )
}
