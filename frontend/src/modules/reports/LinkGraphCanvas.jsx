// 관계도 Canvas — 로컬 모달(Phase 1a)과 글로벌 페이지(Phase 1b)가 함께
// 쓰는 재사용 그래프 뷰. force-graph 렌더 + 노드/엣지 페인트 + 컨테이너
// 크기 측정 + 화면 맞춤(zoom) 로직을 모두 여기로 모았다. 데이터 fetch /
// 필터 UI / 빈·에러 메시지는 각 호스트(모달·페이지)가 담당한다.
//
// 시각 규약 (Phase 1a/1b):
//   - 노드: report 만, 회색 단색 (종류색 매핑은 Phase 2). 중심 노드만 강조.
//   - 크기 = degree, 엣지 = link kind 별 색 + 화살표
//   - hover → 미니카드(tooltip), 클릭 → onNodeClick(node)
//
// react-force-graph-2d 는 무겁고 이 화면에서만 쓰므로 lazy 로 분리한다.
// 라이브러리가 graphData 의 node/link 객체를 직접 변형(x,y,vx… 주입,
// source/target 를 노드 ref 로 치환)하므로 응답을 매번 새 객체로 클론한다.
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Loader2, Download } from 'lucide-react'
import { polygonHull } from 'd3-polygon'
import { colorHex } from '@/shared/reports/linkKinds'
import { axisColor } from '@/shared/reports/graphColors'
import { useLinkKinds } from './ReportLinks'

const ForceGraph2D = lazy(() => import('react-force-graph-2d'))

// 노드 색 — 회색 단색. 중심 보고서(로컬 그래프)만 짙은 톤 + 링으로 강조.
const NODE_FILL = '#94a3b8' // slate-400
const NODE_CENTER_FILL = '#475569' // slate-600
const NODE_CENTER_RING = '#6366f1' // indigo-500
const LABEL_COLOR = '#1e293b' // slate-800
const ENTITY_LABEL_COLOR = '#475569' // slate-600 — entity 라벨은 살짝 옅게
const HAS_TAG_COLOR = '#cbd5e1' // slate-300 — report→entity 엣지(회색 실선)
const COMPOSITE_FILL = '#f59e0b' // amber-500 — 종합보고 hub(사각형)
const COMPOSITE_EDGE = '#fbbf24' // amber-400 — composite_member 엣지(점선)
const CANVAS_BG = '#f8fafc' // slate-50
const DIM_ALPHA = 0.1 // 타임바 기간 밖 노드 흐리기
const DIM_EDGE_COLOR = 'rgba(148,163,184,0.1)' // 기간 밖 엣지(아주 옅게)
// 스윔레인(타임라인+레인) 시각 상수 — world 단위.
const LANE_ROW_H = 30 // 레인 안 서브행(겹침 회피용) 높이
const LANE_GAP = 18 // 레인 사이 간격
const LANE_MIN_GAP = 28 // 같은 서브행에 둘 수 있는 최소 가로 간격
const GRID_LINE_COLOR = '#e2e8f0' // slate-200 — 시간 눈금선
const GRID_LABEL_COLOR = '#94a3b8' // slate-400 — 눈금 날짜 라벨
const LANE_LABEL_COLOR = '#475569' // slate-600 — 레인 이름
const LANE_BAND_COLOR = 'rgba(148,163,184,0.06)' // 교대 레인 배경
// 화면 맞춤(zoomToFit) 후 허용할 최대 배율 — 노드가 적을 때 과확대 방지.
const MAX_FIT_ZOOM = 2.4
// fit 후 살짝 확대해서 들어간다 — 전체가 꽉 차 보이게(여백 줄임). MAX 로 상한.
const FIT_ZOOM_BOOST = 1.6
// 노드 간 기본 간격 — d3 force 를 튜닝해 더 벌린다. charge 는 노드끼리 미는
// 힘(음수일수록 강하게 밀어냄), link.distance 는 연결된 노드 사이 목표 거리.
const CHARGE_STRENGTH = -180
const LINK_DISTANCE = 80
// 클러스터 외곽선(§11.4 4b) — convex hull 채움/외곽선 투명도 + 노드 바깥 패딩.
const HULL_FILL_ALPHA = 0.09
const HULL_STROKE_ALPHA = 0.5
const HULL_PAD = 12 // world 단위, 노드 반지름 위에 더해 원을 감싸게
const HULL_MIN_NODES = 3 // 이 미만 커뮤니티는 hull 안 그림

// hex(#rrggbb) → rgba(). 외곽선은 ctx.globalAlpha 대신 색 자체에 알파를 실어
// 채움/선 알파를 따로 준다.
function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

function nodeRadius(node) {
  // degree 가 큰 노드일수록 크게 — sqrt 로 완만하게. 중심은 최소 크기 보장.
  // entity(관련정보) 노드는 보조 레이어라 report 보다 작게.
  if (node.type === 'entity') return 3.5 + Math.sqrt(node.degree || 0) * 1.5
  // composite(종합보고)는 hub 라 크게 — 묶은 안건 수에 비례.
  if (node.type === 'composite') return 7 + Math.sqrt(node.degree || 0) * 2.4
  const base = node.is_center ? 7 : 5
  return base + Math.sqrt(node.degree || 0) * 2.2
}

// 엣지 끝점 id — force-graph 가 source/target 을 노드 객체로 치환하기 전(문자열)
// 후(객체) 모두에서 id 를 꺼낸다.
function idOf(end) {
  return end && typeof end === 'object' ? end.id : end
}

// 타임라인 축 캡션용 — epoch ms → 'YYYY-MM-DD'.
function fmtAxisDate(ms) {
  const d = new Date(ms)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

// 스윔레인 시간 눈금 — 기간 길이에 맞춰 연/분기/월/주 단위 tick 생성.
// 너무 촘촘하지 않게 단위를 자동 선택한다 (KronoGraph/간트 축과 같은 발상).
function genTimeTicks(minMs, maxMs) {
  const DAY = 86400000
  const rangeDays = (maxMs - minMs) / DAY
  const ticks = []
  const pad2 = (n) => String(n).padStart(2, '0')
  if (rangeDays > 365 * 3) {
    const endY = new Date(maxMs).getFullYear()
    for (let y = new Date(minMs).getFullYear(); y <= endY; y += 1) {
      ticks.push({ ms: new Date(y, 0, 1).getTime(), label: String(y) })
    }
  } else if (rangeDays > 200) {
    const s = new Date(minMs)
    let d = new Date(s.getFullYear(), Math.floor(s.getMonth() / 3) * 3, 1)
    while (d.getTime() <= maxMs) {
      ticks.push({ ms: d.getTime(), label: `${d.getFullYear()} Q${Math.floor(d.getMonth() / 3) + 1}` })
      d = new Date(d.getFullYear(), d.getMonth() + 3, 1)
    }
  } else if (rangeDays > 45) {
    const s = new Date(minMs)
    let d = new Date(s.getFullYear(), s.getMonth(), 1)
    while (d.getTime() <= maxMs) {
      ticks.push({ ms: d.getTime(), label: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}` })
      d = new Date(d.getFullYear(), d.getMonth() + 1, 1)
    }
  } else {
    const d = new Date(minMs)
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7)) // 직전 월요일로
    let cur = d
    while (cur.getTime() <= maxMs) {
      ticks.push({ ms: cur.getTime(), label: `${cur.getMonth() + 1}/${cur.getDate()}` })
      cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 7)
    }
  }
  return ticks
}

// nodeLabel 은 HTML 문자열로 들어가므로 사용자 입력(제목/이름)을 이스케이프.
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// 컨테이너 크기를 추적 — ForceGraph2D 는 명시적 width/height 가 필요하다.
// Radix Dialog(portal + open 애니메이션) 안에서는 ResizeObserver 초기 측정이
// 0 으로 갇힐 수 있어, (1) 동기 getBoundingClientRect (2) 다음 프레임 재측정
// (3) 이후 ResizeObserver 로 3중 보강한다. `active` 가 false 면 측정 안 함.
function useElementSize(active) {
  const ref = useRef(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    if (!active) return undefined
    const el = ref.current
    if (!el) return undefined
    const measure = () => {
      const rect = el.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        setSize((prev) =>
          prev.width === rect.width && prev.height === rect.height
            ? prev
            : { width: rect.width, height: rect.height },
        )
      }
    }
    measure()
    const raf = requestAnimationFrame(measure)
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [active])
  return [ref, size]
}

/**
 * @param {object}   props
 * @param {object|null} props.graph   서버 응답 {nodes, edges, ...} (null 가능)
 * @param {(node:object)=>void=} props.onNodeClick
 * @param {boolean=} props.active     크기 측정 활성화 (모달은 open, 페이지는 true)
 * @param {React.ReactNode=} props.overlay  캔버스 위에 절대배치할 오버레이
 *                                           (호스트가 빈/에러/로딩 메시지 렌더)
 * @param {(node:object)=>string=} props.nodeColor  노드 채움색 결정 (Phase 2
 *                                  색 매핑). 없으면 회색 단색(중심만 강조).
 * @param {boolean=} props.timeline  타임라인 정렬 모드 (Phase 3) — report 노드
 *                                   x 를 report_date 로 고정(fx), 좌→우 시간 흐름.
 * @param {(node:object)=>{key:any,label:string}|null=} props.laneOf  스윔레인
 *                                   기준 (Phase 3 (2)). timeline 과 함께 주면
 *                                   y 를 카테고리 레인으로 고정 + 시간 눈금 표시.
 * @param {{from:number,to:number}|null=} props.timeFilter  타임바 기간 (Phase 3
 *                                   (3)). 이 기간 밖 report 노드·엣지를 흐리게.
 * @param {string=} props.searchQuery  검색어 (Phase 4). 제목/라벨이 매칭되는
 *                                   노드만 또렷하게, 나머지는 흐리게.
 * @param {{keyOf:(node:object)=>any, colorOf:Map<any,string>}|null=} props.clusters
 *                                   클러스터 외곽선 (§11.4 4b). keyOf 가 커뮤니티
 *                                   키를 주는 report 노드를 묶어 convex hull 을
 *                                   colorOf 색으로 그린다. timeline 모드에선 무시.
 */
export function LinkGraphCanvas({
  graph,
  onNodeClick,
  active = true,
  overlay = null,
  nodeColor = null,
  timeline = false,
  laneOf = null,
  timeFilter = null,
  searchQuery = '',
  clusters = null,
}) {
  const fgRef = useRef(null)
  const [containerRef, size] = useElementSize(active)
  const { byKey } = useLinkKinds()

  // d3 force 를 더 벌어지게 튜닝. lazy 로딩이라 첫 마운트 시점이 늦으므로
  // ref 콜백에서 인스턴스가 생기는 즉시 한 번 적용한다(이후 그래프 변경은
  // 아래 effect 가 재적용 + 재가열).
  const applyForces = useCallback((fg) => {
    if (!fg) return
    fg.d3Force('charge')?.strength(CHARGE_STRENGTH)
    fg.d3Force('link')?.distance(LINK_DISTANCE)
  }, [])
  const setFgRef = useCallback(
    (inst) => {
      fgRef.current = inst
      applyForces(inst)
    },
    [applyForces],
  )

  // 자동 화면맞춤은 "데이터 로드당 한 번"만. 노드를 드래그하면 시뮬레이션이
  // 다시 가열됐다 식으며 onEngineStop 이 또 발화하는데, 그때마다 zoomToFit 을
  // 돌리면 줌이 튀어(축소→확대→축소) 깜빡인다. graph 가 바뀔 때만 리셋.
  //
  // ready: 시뮬레이션이 식어 화면맞춤이 끝나기 전까지 캔버스를 숨긴다. force
  // 시뮬레이션은 모든 노드를 중심에 겹쳐 놓고 cooldownTicks 동안 펼치는데, 그
  // "펼쳐지는" 과정이 화면엔 확대→축소처럼 보여 깜빡인다. 펼침이 끝나고 한 번에
  // 최종 배율로 자리잡은 뒤 보여 주면 그 움직임이 안 보인다.
  const didFitRef = useRef(false)
  const [ready, setReady] = useState(false)
  // graph 뿐 아니라 timeline 토글에도 리셋 — fx 가 바뀌어 레이아웃이 새로
  // 펼쳐지므로 다시 숨겼다 맞춤.
  useEffect(() => {
    didFitRef.current = false
    setReady(false)
    // 그래프가 바뀌면 force 를 다시 걸고 재가열 — 새 데이터로 다시 펼치도록.
    applyForces(fgRef.current)
    fgRef.current?.d3ReheatSimulation?.()
  }, [graph, timeline, laneOf, applyForces])

  // 클러스터 외곽선(§11.4 4b)은 onRenderFramePre 로 그리는데, 이 prop 은
  // force-graph 의 linkedProps 가 아니라 토글만 바뀌면 idle 상태(시뮬레이션이
  // 식은 뒤)에선 needsRedraw 가 안 켜져 다음 인터랙션까지 다시 안 그려진다.
  // 줌을 같은 값으로 재설정해 needsRedraw 를 켜 한 프레임 다시 그리게 한다
  // (스케일 변화 없음 → 화면은 그대로, hull 만 즉시 반영).
  useEffect(() => {
    const fg = fgRef.current
    if (!fg || !ready) return
    const z = fg.zoom?.()
    if (z) fg.zoom(z)
  }, [clusters, ready])

  // 타임라인 축 — report 노드들의 report_date 범위. timeline ON 일 때만 계산.
  const timeAxis = useMemo(() => {
    if (!timeline || !graph?.nodes?.length) return null
    const times = []
    for (const n of graph.nodes) {
      if (n.type === 'report' && n.report_date) {
        const t = Date.parse(n.report_date)
        if (!Number.isNaN(t)) times.push(t)
      }
    }
    if (!times.length) return null
    const reportCount = graph.nodes.filter((n) => n.type === 'report').length
    // span = 시간축 가로 폭(world 단위). 노드 수에 비례해 충분히 벌린다.
    const span = Math.max(600, reportCount * 40)
    // gutter = 왼쪽 레인 이름 전용 여백. 레인 모드에서만(없으면 0). span 에
    // 비례해 두면 fit 줌에서 화면상 폭이 거의 일정해 라벨이 안 잘린다.
    return { min: Math.min(...times), max: Math.max(...times), span, gutter: laneOf ? span * 0.16 : 0 }
  }, [timeline, graph, laneOf])

  // 날짜(ms) → world x. [min,max] 를 [-span/2+gutter, span/2] 로 선형 매핑 —
  // 레인 모드면 왼쪽 gutter 만큼 비워 노드가 레인 이름과 안 겹치게 한다.
  const xOf = useCallback(
    (ms) => {
      if (!timeAxis) return 0
      const { min, max, span, gutter } = timeAxis
      const plotLeft = -0.5 * span + gutter
      const plotRight = 0.5 * span
      const norm = max > min ? (ms - min) / (max - min) : 0.5
      return plotLeft + norm * (plotRight - plotLeft)
    },
    [timeAxis],
  )

  // 스윔레인 레이아웃 (Phase 3 (2)) — laneOf 가 있을 때만. report 노드를
  // 카테고리(레인)별로 묶고, 레인 안에서 날짜 순으로 서브행에 패킹해 y 를 고정.
  // 같은 레인·비슷한 시점 노드가 겹치지 않게 greedy 로 서브행을 늘린다.
  const laneLayout = useMemo(() => {
    if (!timeline || !laneOf || !timeAxis || !graph?.nodes?.length) return null
    const reportNodes = graph.nodes.filter(
      (n) => n.type === 'report' && n.report_date && !Number.isNaN(Date.parse(n.report_date)),
    )
    if (!reportNodes.length) return null
    // 레인 그룹핑
    const groups = new Map()
    for (const n of reportNodes) {
      const { key, label } = laneOf(n) || { key: '__none__', label: '미지정' }
      if (!groups.has(key)) groups.set(key, { key, label, nodes: [] })
      groups.get(key).nodes.push(n)
    }
    const ordered = [...groups.values()].sort((a, b) => b.nodes.length - a.nodes.length)
    const posY = new Map()
    const lanes = []
    let cursor = 0
    for (const g of ordered) {
      const sorted = [...g.nodes].sort(
        (a, b) => xOf(Date.parse(a.report_date)) - xOf(Date.parse(b.report_date)),
      )
      const rowLastX = [] // 서브행별 마지막 노드 x
      const rowOf = new Map()
      for (const n of sorted) {
        const x = xOf(Date.parse(n.report_date))
        let row = rowLastX.findIndex((lx) => x - lx >= LANE_MIN_GAP)
        if (row === -1) {
          row = rowLastX.length
          rowLastX.push(x)
        } else rowLastX[row] = x
        rowOf.set(n.id, row)
      }
      const rows = Math.max(1, rowLastX.length)
      const y0 = cursor
      for (const n of sorted) posY.set(n.id, y0 + (rowOf.get(n.id) + 0.5) * LANE_ROW_H)
      lanes.push({ key: g.key, label: g.label, y0, y1: y0 + rows * LANE_ROW_H, count: g.nodes.length })
      cursor = y0 + rows * LANE_ROW_H + LANE_GAP
    }
    return {
      posY,
      lanes,
      totalHeight: Math.max(0, cursor - LANE_GAP),
      ticks: genTimeTicks(timeAxis.min, timeAxis.max),
    }
  }, [timeline, laneOf, timeAxis, graph, xOf])

  const graphData = useMemo(() => {
    if (!graph) return { nodes: [], links: [] }
    const nodes = (graph.nodes || []).map((n) => ({ ...n }))
    // 타임라인 모드: report 노드 x 를 날짜로 고정(fx). 레인 모드면 y 도 고정(fy).
    // 날짜 없는 노드·entity 는 미설정 → 링크에 끌려 자유롭게 배치.
    if (timeAxis) {
      for (const n of nodes) {
        if (n.type === 'report' && n.report_date) {
          const t = Date.parse(n.report_date)
          if (!Number.isNaN(t)) {
            n.fx = xOf(t)
            if (laneLayout?.posY.has(n.id)) n.fy = laneLayout.posY.get(n.id)
          }
        }
      }
    }
    return {
      nodes,
      links: (graph.edges || []).map((e) => ({ ...e })),
    }
  }, [graph, timeAxis, laneLayout, xOf])

  // 스윔레인 배경 — 노드 아래(onRenderFramePre)에 레인 띠·구분선·이름 +
  // 시간 눈금선·날짜 라벨을 그린다. ctx 는 world 좌표(팬/줌 변환 적용됨)라
  // 선 굵기·폰트는 globalScale 로 나눠 화면상 일정 두께를 유지한다.
  const paintBackground = useCallback(
    (ctx, globalScale) => {
      if (!laneLayout || !timeAxis) return
      const { lanes, totalHeight, ticks } = laneLayout
      const xLeft = -0.5 * timeAxis.span
      const xRight = 0.5 * timeAxis.span
      const topY = -8
      const botY = totalHeight + 8
      // 데이터 범위 [min,max] 안의 눈금만 — 범위 밖(특히 min 직전 월/분기 시작)
      // 은 plotLeft 왼쪽 gutter 로 들어가 레인 이름과 겹친다.
      const visTicks = ticks.filter((t) => t.ms >= timeAxis.min && t.ms <= timeAxis.max)
      ctx.save()
      // 레인 교대 배경 띠
      lanes.forEach((lane, i) => {
        if (i % 2 === 1) {
          ctx.fillStyle = LANE_BAND_COLOR
          ctx.fillRect(xLeft, lane.y0, xRight - xLeft, lane.y1 - lane.y0)
        }
      })
      // 시간 눈금선 (세로)
      ctx.lineWidth = 1 / globalScale
      ctx.strokeStyle = GRID_LINE_COLOR
      ctx.beginPath()
      for (const t of visTicks) {
        const x = xOf(t.ms)
        ctx.moveTo(x, topY)
        ctx.lineTo(x, botY)
      }
      ctx.stroke()
      // 눈금 날짜 라벨 (아래쪽)
      ctx.fillStyle = GRID_LABEL_COLOR
      ctx.font = `${10 / globalScale}px sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      for (const t of visTicks) ctx.fillText(t.label, xOf(t.ms), botY + 4 / globalScale)
      // 레인 이름 — 왼쪽 gutter 안에만. 긴 이름이 노드 영역(plotLeft)으로
      // 넘치지 않게 gutter 폭으로 clip 한다.
      const plotLeft = xLeft + timeAxis.gutter
      const labelPad = 4 / globalScale
      ctx.save()
      ctx.beginPath()
      ctx.rect(xLeft, topY, timeAxis.gutter - labelPad, botY - topY)
      ctx.clip()
      ctx.font = `600 ${11 / globalScale}px sans-serif`
      ctx.fillStyle = LANE_LABEL_COLOR
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      for (const lane of lanes) {
        ctx.fillText(lane.label, xLeft + labelPad, (lane.y0 + lane.y1) / 2)
      }
      ctx.restore()
      // gutter 와 plot 경계선 (레인 이름 영역 구분)
      ctx.lineWidth = 1 / globalScale
      ctx.strokeStyle = GRID_LINE_COLOR
      ctx.beginPath()
      ctx.moveTo(plotLeft, topY)
      ctx.lineTo(plotLeft, botY)
      ctx.stroke()
      ctx.restore()
    },
    [laneLayout, timeAxis, xOf],
  )

  // 타임바 기간 필터 — report 노드가 [from,to] 안인지. 날짜 없는 노드·entity
  // 는 항상 표시(true). timeFilter 없으면 전부 표시.
  const inWindow = useCallback(
    (node) => {
      if (!timeFilter || !node || node.type !== 'report' || !node.report_date)
        return true
      const t = Date.parse(node.report_date)
      return Number.isNaN(t) || (t >= timeFilter.from && t <= timeFilter.to)
    },
    [timeFilter],
  )
  // 엣지는 양 끝 report 가 모두 기간 안일 때만 활성 (paint 시 source/target 은
  // 노드 객체로 치환돼 있어 그 report_date 를 본다).
  const edgeInWindow = useCallback(
    (link) => inWindow(link.source) && inWindow(link.target),
    [inWindow],
  )

  // ── 강조(Phase 4): hover 이웃 + 검색 매칭 ────────────────────────────────
  const [hoveredId, setHoveredId] = useState(null)
  // 인접 맵 — graph.edges 의 source/target(문자열 id)로 양방향 구성.
  const adjacency = useMemo(() => {
    const m = new Map()
    const add = (a, b) => {
      if (!m.has(a)) m.set(a, new Set())
      m.get(a).add(b)
    }
    for (const e of graph?.edges || []) {
      add(idOf(e.source), idOf(e.target))
      add(idOf(e.target), idOf(e.source))
    }
    return m
  }, [graph])
  // 검색 매칭 집합 (제목/라벨에 부분일치). 빈 검색이면 null.
  const matchSet = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return null
    const s = new Set()
    for (const n of graph?.nodes || []) {
      const text = `${n.title || ''} ${n.label || ''}`.toLowerCase()
      if (text.includes(q)) s.add(n.id)
    }
    return s
  }, [searchQuery, graph])
  // hover 강조 집합 = 그 노드 + 직접 이웃. hover 가 검색보다 우선.
  const hoverSet = useMemo(() => {
    if (!hoveredId) return null
    const s = new Set([hoveredId])
    for (const id of adjacency.get(hoveredId) || []) s.add(id)
    return s
  }, [hoveredId, adjacency])
  const focusSet = hoverSet || matchSet // null = 강조 없음(전부 또렷)

  // 노드/엣지가 흐려져야 하나 — 타임바 기간 밖이거나 강조 대상 밖이면.
  const dimNode = useCallback(
    (node) => {
      if (timeFilter && !inWindow(node)) return true
      if (focusSet && !focusSet.has(node.id)) return true
      return false
    },
    [timeFilter, inWindow, focusSet],
  )
  const dimEdge = useCallback(
    (link) => {
      if (timeFilter && !edgeInWindow(link)) return true
      if (focusSet && !(focusSet.has(idOf(link.source)) && focusSet.has(idOf(link.target))))
        return true
      return false
    },
    [timeFilter, edgeInWindow, focusSet],
  )

  // ── 클러스터 외곽선(§11.4 4b) ────────────────────────────────────────────
  // 같은 커뮤니티 report 노드를 convex hull 로 감싼다. 매 프레임 노드의 현재
  // x,y 로 hull 을 다시 계산(force 가 위치를 갱신). timeline 모드는 노드를 시간
  // 순으로 재배열해 hull 이 무의미하므로 건너뛴다. dim(검색·hover·타임바)되면
  // hull 도 함께 옅게.
  const paintHulls = useCallback(
    (ctx, globalScale) => {
      if (!clusters || timeline) return
      const groups = new Map()
      for (const n of graphData.nodes) {
        if (n.type !== 'report' || typeof n.x !== 'number') continue
        const key = clusters.keyOf(n)
        if (key == null) continue
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(n)
      }
      for (const [key, ns] of groups) {
        if (ns.length < HULL_MIN_NODES) continue
        const color = clusters.colorOf.get(key)
        if (!color) continue
        // 각 노드 둘레 8방향 점을 더해 hull 이 노드 원을 감싸게(패딩).
        const pts = []
        for (const n of ns) {
          const r = nodeRadius(n) + HULL_PAD
          const d = r * 0.7071
          pts.push(
            [n.x + r, n.y],
            [n.x - r, n.y],
            [n.x, n.y + r],
            [n.x, n.y - r],
            [n.x + d, n.y + d],
            [n.x - d, n.y + d],
            [n.x + d, n.y - d],
            [n.x - d, n.y - d],
          )
        }
        const hull = polygonHull(pts)
        if (!hull || hull.length < 3) continue
        // 멤버가 전부 흐림이면 hull 도 더 옅게(강조 맥락 보존).
        const k = ns.some((n) => !dimNode(n)) ? 1 : 0.3
        ctx.beginPath()
        ctx.moveTo(hull[0][0], hull[0][1])
        for (let i = 1; i < hull.length; i += 1) ctx.lineTo(hull[i][0], hull[i][1])
        ctx.closePath()
        ctx.fillStyle = hexToRgba(color, HULL_FILL_ALPHA * k)
        ctx.fill()
        ctx.strokeStyle = hexToRgba(color, HULL_STROKE_ALPHA * k)
        ctx.lineWidth = 1.5 / globalScale
        ctx.stroke()
      }
    },
    [clusters, timeline, graphData, dimNode],
  )

  // onRenderFramePre 합성 — 클러스터 hull(아래) + 스윔레인 배경(위). 둘은 모드가
  // 배타적(hull=평소, 레인=타임라인)이라 실제로 겹치진 않는다.
  const handleRenderFramePre = useCallback(
    (ctx, globalScale) => {
      paintHulls(ctx, globalScale)
      paintBackground(ctx, globalScale)
    },
    [paintHulls, paintBackground],
  )

  // 엣지 색 — report↔report 는 link kind 색, has_tag 회색, composite_member
  // 앰버. 흐림 대상(기간 밖·강조 밖)이면 아주 옅게.
  const linkColor = useCallback(
    (link) => {
      if (dimEdge(link)) return DIM_EDGE_COLOR
      if (link.kind === 'has_tag') return HAS_TAG_COLOR
      if (link.kind === 'composite_member') return COMPOSITE_EDGE
      return colorHex(byKey[link.kind]?.color)
    },
    [byKey, dimEdge],
  )
  // composite_member 는 점선(소속 관계), 나머지는 실선.
  const linkLineDash = useCallback(
    (link) => (link.kind === 'composite_member' ? [4, 3] : null),
    [],
  )
  // 방향 화살표는 explicit link 에만 (has_tag·composite_member 는 무방향).
  const linkArrowLength = useCallback(
    (link) =>
      link.kind === 'has_tag' || link.kind === 'composite_member' ? 0 : 4,
    [],
  )

  const paintNode = useCallback((node, ctx, globalScale) => {
    const r = nodeRadius(node)
    // 기간 밖·강조 밖이면 흐리게. save/restore 로 globalAlpha 가 다음 노드에
    // 새지 않게 한다.
    ctx.save()
    if (dimNode(node)) ctx.globalAlpha = DIM_ALPHA
    // entity(관련정보) 노드 — axis 색 다이아몬드로 report 원과 모양 구분.
    if (node.type === 'entity') {
      ctx.beginPath()
      ctx.moveTo(node.x, node.y - r)
      ctx.lineTo(node.x + r, node.y)
      ctx.lineTo(node.x, node.y + r)
      ctx.lineTo(node.x - r, node.y)
      ctx.closePath()
      ctx.fillStyle = axisColor(node.axis)
      ctx.fill()
      if (globalScale > 1.1) {
        const fontSize = Math.min(12, 11 / globalScale)
        ctx.font = `${fontSize}px sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.fillStyle = ENTITY_LABEL_COLOR
        ctx.fillText(node.label || '', node.x, node.y + r + 1.5)
      }
      ctx.restore()
      return
    }
    // composite(종합보고) 노드 — 앰버 사각형(hub). report 원·entity 다이아와 구분.
    if (node.type === 'composite') {
      const s = r * 1.6 // 사각형 한 변 ≈ 지름
      ctx.fillStyle = COMPOSITE_FILL
      ctx.fillRect(node.x - s / 2, node.y - s / 2, s, s)
      if (globalScale > 0.9) {
        const fontSize = Math.min(13, 12 / globalScale)
        ctx.font = `600 ${fontSize}px sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.fillStyle = LABEL_COLOR
        ctx.fillText(node.title || '', node.x, node.y + s / 2 + 1.5)
      }
      ctx.restore()
      return
    }
    ctx.beginPath()
    ctx.arc(node.x, node.y, r, 0, 2 * Math.PI, false)
    // 색 매핑(Phase 2)이 주어지면 그걸로, 아니면 회색 단색(중심만 짙게).
    ctx.fillStyle = nodeColor
      ? nodeColor(node)
      : node.is_center
        ? NODE_CENTER_FILL
        : NODE_FILL
    ctx.fill()
    if (node.is_center) {
      ctx.lineWidth = 2 / globalScale
      ctx.strokeStyle = NODE_CENTER_RING
      ctx.stroke()
    }
    // 라벨 — 확대됐을 때만(작게 줌아웃하면 글자 잡음). 노드 아래 가운데.
    if (globalScale > 0.9) {
      const fontSize = Math.min(13, 12 / globalScale)
      ctx.font = `${node.is_center ? '600 ' : ''}${fontSize}px sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      ctx.fillStyle = LABEL_COLOR
      ctx.fillText(node.title || '', node.x, node.y + r + 1.5)
    }
    ctx.restore()
  }, [nodeColor, dimNode])

  // hit area = 그린 원과 동일하게. (커스텀 paint 를 쓰면 기본 히트영역이
  // 안 맞아 hover/click 이 어긋난다.)
  const paintPointerArea = useCallback((node, color, ctx) => {
    const r = nodeRadius(node)
    ctx.beginPath()
    ctx.arc(node.x, node.y, r + 2, 0, 2 * Math.PI, false)
    ctx.fillStyle = color
    ctx.fill()
  }, [])

  // 데이터가 안정되면 화면에 맞춰 줌. 노드가 적은 그래프는 zoomToFit 이
  // 과확대하므로 fit 후 배율을 MAX_FIT_ZOOM 으로 한 번 눌러 준다.
  //
  // 둘 다 즉시(0ms) 적용한다 — 애니메이션(zoomToFit→다시 clamp)을 쓰면 화면
  // 진입 때 "축소→확대→축소" 줌이 눈에 보여 깜빡인다. 즉시 적용하면 시뮬레이션이
  // 멈춘 한 프레임에 최종 배율로 한 번에 자리잡아 그 깜빡임이 사라진다.
  const handleEngineStop = useCallback(() => {
    const fg = fgRef.current
    if (!fg || didFitRef.current) return // 드래그 재가열로 인한 재발화 무시
    didFitRef.current = true
    // 레인 모드는 눈금·레인 라벨이 노드 바깥(아래·왼쪽)에 있어 여백을 더 준다.
    fg.zoomToFit(0, laneLayout ? 90 : 60)
    // fit 배율에서 살짝 더 확대(BOOST)해 들어가되, 과확대는 MAX 로 막는다.
    // 타임라인 모드는 가로로 넓어 BOOST 하면 양끝이 잘리므로 fit 그대로 둔다.
    if (!timeline) {
      const target = Math.min(fg.zoom() * FIT_ZOOM_BOOST, MAX_FIT_ZOOM)
      fg.zoom(target, 0)
    }
    setReady(true) // 최종 배율로 자리잡은 뒤에야 캔버스를 드러낸다
  }, [timeline, laneLayout])

  // PNG 내보내기 (Phase 4) — force-graph 의 보이는 canvas 를 그대로 저장.
  const exportPng = useCallback(() => {
    const canvas = containerRef.current?.querySelector('canvas')
    if (!canvas) return
    const d = new Date()
    const p2 = (n) => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`
    const a = document.createElement('a')
    a.href = canvas.toDataURL('image/png')
    a.download = `관계도_${stamp}.png`
    a.click()
  }, [containerRef])

  const hasNodes = graphData.nodes.length > 0

  return (
    <div ref={containerRef} className="relative flex-1 min-h-0 w-full bg-slate-50">
      {/* PNG 내보내기 (Phase 4) — 노드가 있고 화면이 자리잡은 뒤에만 */}
      {hasNodes && ready && (
        <button
          type="button"
          onClick={exportPng}
          className="absolute right-2 top-2 z-10 inline-flex h-7 items-center gap-1 rounded-md border bg-background/90 px-2 text-[11px] text-muted-foreground shadow-sm backdrop-blur hover:bg-muted"
          title="현재 화면을 PNG 로 저장"
        >
          <Download className="h-3.5 w-3.5" />
          PNG
        </button>
      )}
      {hasNodes && (
        <Suspense
          fallback={
            <div className="absolute inset-0 grid place-items-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          }
        >
          {/* 시뮬레이션이 식어 화면맞춤이 끝날 때까지(ready) 숨긴다 — 노드가
              펼쳐지는 과정이 확대→축소 깜빡임으로 보이는 걸 막는다.
              측정이 아직(0)이어도 폴백 치수로 일단 그려서 빈 패널을 피한다 —
              ResizeObserver 가 곧 실제 크기로 보정. */}
          <div
            className="absolute inset-0 transition-opacity duration-200"
            style={{ opacity: ready ? 1 : 0 }}
          >
            <ForceGraph2D
              ref={setFgRef}
              width={size.width || 800}
              height={size.height || 480}
              graphData={graphData}
              backgroundColor={CANVAS_BG}
              nodeRelSize={5}
              nodeCanvasObject={paintNode}
              nodePointerAreaPaint={paintPointerArea}
              nodeLabel={(n) => {
                if (n.type === 'entity') {
                  return `<div style="font:12px sans-serif;max-width:240px">
                       <div style="font-weight:600">${escapeHtml(n.label)}</div>
                       <div style="color:#64748b">${escapeHtml(
                         n.axis_label || '관련정보',
                       )}</div>
                     </div>`
                }
                const sub =
                  n.type === 'composite'
                    ? `종합보고 · ${escapeHtml(n.owner_name || '')}`
                    : escapeHtml(
                        [n.owner_name, n.report_date].filter(Boolean).join(' · '),
                      )
                return `<div style="font:12px sans-serif;max-width:240px">
                       <div style="font-weight:600">${escapeHtml(n.title)}</div>
                       <div style="color:#64748b">${sub}</div>
                     </div>`
              }}
              onNodeClick={onNodeClick}
              linkColor={linkColor}
              linkLineDash={linkLineDash}
              linkWidth={1.5}
              linkDirectionalArrowLength={linkArrowLength}
              linkDirectionalArrowRelPos={1}
              linkDirectionalParticles={0}
              cooldownTicks={80}
              onRenderFramePre={handleRenderFramePre}
              onNodeHover={(node) => setHoveredId(node?.id ?? null)}
              onEngineStop={handleEngineStop}
            />
          </div>
          {/* 펼치는 동안엔 로더만 — 빈 슬레이트 배경 대신 진행 표시 */}
          {!ready && (
            <div className="absolute inset-0 grid place-items-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}
          {/* 타임라인 축 안내 — 좌=과거, 우=최근. 레인 모드는 눈금이 대신하므로
              평소 타임라인(레인 없음)일 때만 캡션을 띄운다. */}
          {timeline && timeAxis && !laneLayout && ready && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between border-t border-slate-200/70 bg-slate-50/80 px-3 py-1 text-[10px] tabular-nums text-muted-foreground">
              <span>← 과거 · {fmtAxisDate(timeAxis.min)}</span>
              <span>{fmtAxisDate(timeAxis.max)} · 최근 →</span>
            </div>
          )}
        </Suspense>
      )}
      {overlay}
    </div>
  )
}
