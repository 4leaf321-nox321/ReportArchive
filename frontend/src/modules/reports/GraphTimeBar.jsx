// 관계도 타임바 (지식그래프 Phase 3 (3)) — 평소 force 그래프는 그대로 두고
// 하단에 활동 히스토그램 + 기간 브러시 + 재생을 둔다. 노드를 시간으로 옮기는
// 타임라인 정렬과 달리, 여기선 선택한 기간 [from,to] 밖 노드/엣지를 캔버스가
// 흐리게(dim) 처리한다. ▶ 재생은 from=min 고정하고 to 를 끝까지 흘려 "관계망이
// 시간 따라 쌓이는" 걸 보여준다 (KeyLines·Linkurious·Gephi 패턴).
import { useEffect, useMemo, useRef, useState } from 'react'
import { Play, Pause } from 'lucide-react'

const BUCKETS = 48

function fmt(ms) {
  const d = new Date(ms)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/**
 * @param {object} props
 * @param {{min:number,max:number}} props.bounds  데이터 일자 범위(epoch ms)
 * @param {number[]} props.dates   report 일자들(ms) — 히스토그램용
 * @param {{from:number,to:number}|null} props.range  현재 선택 기간
 * @param {(r:{from:number,to:number})=>void} props.onRangeChange
 * @param {boolean} props.playing
 * @param {()=>void} props.onTogglePlay
 */
export function GraphTimeBar({
  bounds,
  dates,
  range,
  onRangeChange,
  playing,
  onTogglePlay,
}) {
  const trackRef = useRef(null)
  const [drag, setDrag] = useState(null) // 'from' | 'to' | null
  const { min, max } = bounds
  const span = Math.max(1, max - min)
  const r = useMemo(() => range || { from: min, to: max }, [range, min, max])

  const hist = useMemo(() => {
    const arr = new Array(BUCKETS).fill(0)
    for (const t of dates) {
      let i = Math.floor(((t - min) / span) * BUCKETS)
      if (i < 0) i = 0
      if (i >= BUCKETS) i = BUCKETS - 1
      arr[i] += 1
    }
    return { arr, peak: Math.max(1, ...arr) }
  }, [dates, min, span])

  const pct = (ms) => ((ms - min) / span) * 100

  // 핸들 드래그 — window 리스너로 트랙 밖까지 따라간다.
  useEffect(() => {
    if (!drag) return undefined
    const onMove = (e) => {
      const rect = trackRef.current?.getBoundingClientRect()
      if (!rect) return
      const x = Math.min(rect.right, Math.max(rect.left, e.clientX))
      const ms = Math.round(min + ((x - rect.left) / rect.width) * span)
      onRangeChange(
        drag === 'from'
          ? { from: Math.min(ms, r.to), to: r.to }
          : { from: r.from, to: Math.max(ms, r.from) },
      )
    }
    const onUp = () => setDrag(null)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [drag, r, min, span, onRangeChange])

  // 선택 기간에 든 보고서 수
  const inCount = useMemo(
    () => dates.filter((t) => t >= r.from && t <= r.to).length,
    [dates, r.from, r.to],
  )

  return (
    <div className="shrink-0 border-t bg-background px-3 py-2">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onTogglePlay}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full border bg-background text-indigo-600 hover:bg-indigo-50"
          title={playing ? '일시정지' : '재생 (시간순으로 쌓이며 표시)'}
        >
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </button>

        <div
          ref={trackRef}
          className="relative h-10 flex-1 select-none rounded bg-slate-50"
        >
          {/* 활동 히스토그램 */}
          <div className="absolute inset-0 flex items-end gap-px px-px">
            {hist.arr.map((c, i) => (
              <div
                key={i}
                className="flex-1 rounded-sm bg-slate-200"
                style={{ height: `${(c / hist.peak) * 100}%` }}
              />
            ))}
          </div>
          {/* 선택 기간 음영 */}
          <div
            className="absolute inset-y-0 border-x-2 border-indigo-400 bg-indigo-500/10"
            style={{ left: `${pct(r.from)}%`, right: `${100 - pct(r.to)}%` }}
          />
          {/* 핸들 — from / to */}
          {['from', 'to'].map((side) => (
            <div
              key={side}
              onPointerDown={(e) => {
                e.preventDefault()
                setDrag(side)
              }}
              className="absolute top-0 h-full w-3 -translate-x-1/2 cursor-ew-resize"
              style={{ left: `${pct(side === 'from' ? r.from : r.to)}%` }}
            >
              <div className="mx-auto h-full w-0.5 bg-indigo-500" />
            </div>
          ))}
        </div>

        <span className="shrink-0 whitespace-nowrap text-[11px] tabular-nums text-muted-foreground">
          {fmt(r.from)} ~ {fmt(r.to)} · {inCount}건
        </span>
      </div>
    </div>
  )
}
