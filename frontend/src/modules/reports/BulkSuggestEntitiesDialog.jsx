import { useEffect, useMemo, useRef, useState } from 'react'
import { Sparkles, Loader2, Check } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import { Button } from '@/shared/components/ui/button'
import { ScrollArea } from '@/shared/components/ui/scroll-area'
import { cn } from '@/shared/lib/utils'
import { listEntityTypes } from '@/shared/api/entities'
import { suggestReportEntities, addReportEntities } from './api'

// 추천 수집 동시성 — 유사도 레이어가 Ollama 임베딩을 돌려 보고서당 수초 걸릴 수
// 있어, 한꺼번에 다 던지지 않고 소수만 병렬로 굴린다.
const FETCH_CONCURRENCY = 4

// 3열 그리드 — 보고서 | 기존 태그 | 추천 태그. 헤더/각 행이 동일 템플릿을 공유한다.
const GRID_COLS =
  'grid grid-cols-[minmax(180px,1fr)_minmax(0,1.3fr)_minmax(0,1.6fr)] gap-3'

/** items 를 동시성 limit 으로 worker(item, index) 에 흘린다. 각 완료마다
 *  점진적으로 화면을 갱신할 수 있게 한다. */
async function runPool(items, limit, worker) {
  let cursor = 0
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (cursor < items.length) {
        const i = cursor++
        await worker(items[i], i)
      }
    },
  )
  await Promise.all(runners)
}

/**
 * 여러 보고서에 대해 AI 태그 추천을 한꺼번에 수집해 **보고서별로 검토·수락**하는
 * 다이얼로그. 한 행에 [보고서 | 기존 태그 | 추천 태그]를 나란히 보여줘 중복 추가를
 * 피하게 한다. 결정적(본문 정확 매칭) 후보는 기본 선택, 유사도(✨) 후보는 기본
 * 해제 상태로 띄운다 — 사람이 최종 결정한 것만 가산(union) 적용한다.
 *
 * props:
 *   reports: [{ id, title }]   선택된 보고서들
 *   onClose()                  닫기
 *   onDone()                   적용 성공 후(선택 해제 등 후처리)
 */
export function BulkSuggestEntitiesDialog({ reports, onClose, onDone }) {
  // reportId → { status: 'loading'|'done'|'error', items, current }
  const [perReport, setPerReport] = useState(() => {
    const init = {}
    for (const r of reports) init[r.id] = { status: 'loading', items: [], current: [] }
    return init
  })
  // reportId → Set(선택된 suggestion entity id)
  const [selected, setSelected] = useState(() => {
    const init = {}
    for (const r of reports) init[r.id] = new Set()
    return init
  })
  const [doneCount, setDoneCount] = useState(0)
  const [applying, setApplying] = useState(false)
  // slug → label(예: model → 모델명). 칩에 사람이 읽는 축 이름을 보이려고 한 번 조회.
  const [axisLabels, setAxisLabels] = useState(() => new Map())
  const cancelledRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    listEntityTypes()
      .then((res) => {
        if (cancelled) return
        const m = new Map()
        for (const t of res?.items ?? []) m.set(t.slug, t.label)
        setAxisLabels(m)
      })
      .catch(() => {}) // 라벨은 보조 정보 — 실패해도 slug 로 폴백.
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    cancelledRef.current = false
    runPool(reports, FETCH_CONCURRENCY, async (r) => {
      try {
        const res = await suggestReportEntities(r.id)
        if (cancelledRef.current) return
        const items = res?.items ?? []
        setPerReport((prev) => ({
          ...prev,
          [r.id]: { status: 'done', items, current: res?.current ?? [] },
        }))
        // 결정적 후보는 기본 선택(정확 매칭이라 안전), 유사도는 기본 해제.
        setSelected((prev) => ({
          ...prev,
          [r.id]: new Set(
            items.filter((s) => s.source === 'deterministic').map((s) => s.id),
          ),
        }))
      } catch (e) {
        if (cancelledRef.current) return
        setPerReport((prev) => ({
          ...prev,
          [r.id]: { status: 'error', items: [], current: [], error: e },
        }))
      } finally {
        if (!cancelledRef.current) setDoneCount((n) => n + 1)
      }
    })
    return () => {
      cancelledRef.current = true
    }
    // reports 는 다이얼로그 오픈 시 한 번 고정 — 의존성 비움(재수집 방지).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const titleById = useMemo(() => {
    const m = new Map()
    for (const r of reports) m.set(r.id, r.title)
    return m
  }, [reports])

  const collecting = doneCount < reports.length
  const totalSelected = useMemo(
    () => Object.values(selected).reduce((n, s) => n + s.size, 0),
    [selected],
  )
  const reportsWithSelection = useMemo(
    () => Object.values(selected).filter((s) => s.size > 0).length,
    [selected],
  )

  function toggle(reportId, sid) {
    setSelected((prev) => {
      const next = new Set(prev[reportId])
      if (next.has(sid)) next.delete(sid)
      else next.add(sid)
      return { ...prev, [reportId]: next }
    })
  }

  // 한 보고서의 추천 전체 선택/해제 토글 — 검토 속도용.
  function toggleAll(reportId, items, on) {
    setSelected((prev) => ({
      ...prev,
      [reportId]: on ? new Set(items.map((s) => s.id)) : new Set(),
    }))
  }

  async function handleApply() {
    const targets = reports.filter((r) => (selected[r.id]?.size ?? 0) > 0)
    if (targets.length === 0) return
    setApplying(true)
    try {
      let added = 0
      const results = await Promise.allSettled(
        targets.map((r) =>
          addReportEntities(r.id, [...selected[r.id]]).then((res) => {
            added += res?.added ?? 0
          }),
        ),
      )
      const ok = results.filter((x) => x.status === 'fulfilled').length
      const fail = results.length - ok
      if (fail === 0) {
        toast.success(`${ok}개 보고서에 태그 ${added}개 추가`)
      } else {
        const firstErr = results.find((x) => x.status === 'rejected')?.reason
        toast.warning(`${ok}개 적용, ${fail}개 실패`, {
          description:
            firstErr?.response?.data?.message || firstErr?.message || undefined,
        })
      }
      onDone?.()
      onClose?.()
    } finally {
      setApplying(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !applying && onClose()}>
      <DialogContent className="flex h-[80vh] max-h-[80vh] w-[80vw] max-w-[80vw] flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" />
            AI 태그 추천 — {reports.length}개 보고서
          </DialogTitle>
          <DialogDescription>
            본문에서 찾은 태그 후보입니다. 정확 매칭은 기본 선택, 유사도(
            <Sparkles className="inline h-3 w-3" />) 추천은 해제 상태입니다. 기존
            태그는 가운데 칼럼에서 확인하세요(추천에서는 이미 제외됨). 칩을 눌러
            선택을 바꾼 뒤 적용하면 기존 태그에 더하기만 합니다.
          </DialogDescription>
        </DialogHeader>

        {/* 칼럼 헤더 — 행과 같은 그리드 템플릿을 공유해 정렬을 맞춘다. */}
        <div
          className={cn(
            GRID_COLS,
            'shrink-0 border-y bg-muted/30 px-2 py-1.5 text-[11px] font-semibold text-muted-foreground',
          )}
        >
          <span>보고서</span>
          <span>기존 태그</span>
          <span>추천 태그 — 클릭해 선택</span>
        </div>

        <ScrollArea className="-mx-1 flex-1 px-1">
          <div className="divide-y">
            {reports.map((r) => (
              <ReportSuggestionRow
                key={r.id}
                title={titleById.get(r.id)}
                state={perReport[r.id]}
                selected={selected[r.id]}
                axisLabels={axisLabels}
                onToggle={(sid) => toggle(r.id, sid)}
                onToggleAll={(on) =>
                  toggleAll(r.id, perReport[r.id]?.items ?? [], on)
                }
              />
            ))}
          </div>
        </ScrollArea>

        <DialogFooter className="shrink-0 items-center gap-2 border-t pt-3 sm:justify-between">
          <span className="text-xs text-muted-foreground">
            {collecting
              ? `추천 수집 중… ${doneCount}/${reports.length}`
              : `${reportsWithSelection}개 보고서 · 태그 ${totalSelected}개 선택됨`}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={applying}>
              취소
            </Button>
            <Button
              size="sm"
              onClick={handleApply}
              disabled={applying || totalSelected === 0}
              className="gap-1"
            >
              {applying ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
              적용
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 한 보고서 = 한 행: [보고서 제목 | 기존 태그 | 추천 태그(토글)]. */
function ReportSuggestionRow({
  title,
  state,
  selected,
  axisLabels,
  onToggle,
  onToggleAll,
}) {
  const status = state?.status ?? 'loading'
  const items = state?.items ?? []
  const current = state?.current ?? []
  const allOn = items.length > 0 && items.every((s) => selected?.has(s.id))

  function axisName(slug) {
    return axisLabels?.get(slug) ?? slug
  }

  return (
    <div className={cn(GRID_COLS, 'items-start px-2 py-2.5')}>
      {/* 1) 보고서 */}
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium" title={title}>
            {title || '(제목 없음)'}
          </span>
          {status === 'loading' && (
            <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
          )}
        </div>
        {status === 'done' && items.length > 0 && (
          <button
            type="button"
            className="mt-1 text-[10px] text-muted-foreground hover:text-foreground"
            onClick={() => onToggleAll(!allOn)}
          >
            {allOn ? '전체 해제' : '전체 선택'}
          </button>
        )}
      </div>

      {/* 2) 기존 태그 (읽기 전용) */}
      <div className="min-w-0">
        {current.length === 0 ? (
          <span className="text-[11px] text-muted-foreground/70">없음</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {current.map((e) => (
              <span
                key={e.id}
                className="inline-flex items-center gap-1 rounded-full border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground"
                title={`${axisName(e.type_slug)} · 이미 태깅됨`}
              >
                <span className="text-[9px] opacity-70">
                  {axisName(e.type_slug)}
                </span>
                {e.value}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* 3) 추천 태그 (토글) */}
      <div className="min-w-0">
        {status === 'loading' && (
          <span className="text-[11px] text-muted-foreground">추천을 찾는 중…</span>
        )}
        {status === 'error' && (
          <span className="text-[11px] text-destructive">
            추천을 불러오지 못했습니다.
          </span>
        )}
        {status === 'done' && items.length === 0 && (
          <span className="text-[11px] text-muted-foreground/70">
            추천할 태그가 없습니다.
          </span>
        )}
        {status === 'done' && items.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {items.map((s) => {
              const on = selected?.has(s.id)
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onToggle(s.id)}
                  title={
                    s.source === 'similarity'
                      ? `유사도 추천 (${Math.round((s.score ?? 0) * 100)}%)`
                      : '본문에 등장(정확 매칭)'
                  }
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors',
                    on
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'bg-background text-muted-foreground hover:border-primary/50',
                  )}
                >
                  {on ? (
                    <Check className="h-3 w-3 text-primary" />
                  ) : (
                    s.source === 'similarity' && (
                      <Sparkles className="h-3 w-3 text-muted-foreground" />
                    )
                  )}
                  {s.type_slug && (
                    <span className="text-[10px] text-muted-foreground">
                      {axisName(s.type_slug)}
                    </span>
                  )}
                  <span>{s.value}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
