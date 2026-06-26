import {
  lazy,
  Suspense,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Loader2 } from 'lucide-react'
import { axisColor } from '@/shared/reports/graphColors'

// react-force-graph-2d 는 무겁고 이 뷰에서만 쓰므로 lazy 로 분리(LinkGraphCanvas 패턴).
const ForceGraph2D = lazy(() => import('react-force-graph-2d'))

const EDGE_COLOR = 'rgba(148,163,184,0.55)' // slate-400
const LABEL_COLOR = '#64748b' // slate-500 — 라이트/다크 캔버스 둘 다 가독
const CENTER_RING = '#f59e0b' // amber — 중심(조회한) 엔티티 강조

// 컨테이너 크기 추적 — ForceGraph2D 는 명시적 width/height 필요. Radix Dialog
// 안에서 초기 측정 0 으로 갇히는 걸 동기측정+rAF+ResizeObserver 3중 보강.
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
 * 엔티티 서브그래프 force 뷰. 노드=축 색 다이아몬드(+값 라벨), 엣지=방향 화살표
 * (+관계 종류 라벨, hover). 중심(조회한) 엔티티는 앰버 링으로 강조.
 *
 * props:
 *   graph: { nodes:[{id,value,type_slug}], edges:[{src,dst,relation}] } | null
 *   centerId: number   강조할 중심 엔티티 id
 *   relTypeLabels: Map<slug,label>   엣지 라벨용(없으면 slug)
 *   active: boolean    크기 측정 활성(모달 open 등)
 *   onNodeClick(node)
 */
export function EntityGraphView({
  graph,
  centerId,
  relTypeLabels,
  active = true,
  onNodeClick,
}) {
  const [containerRef, size] = useElementSize(active)

  // 라이브러리가 node/link 객체를 변형(x,y 주입)하므로 graph 가 바뀔 때마다 새 객체로.
  const graphData = useMemo(() => {
    if (!graph) return { nodes: [], links: [] }
    return {
      nodes: (graph.nodes ?? []).map((n) => ({
        id: n.id,
        label: n.value,
        axis: n.type_slug,
        isCenter: n.id === centerId,
      })),
      links: (graph.edges ?? []).map((e) => ({
        source: e.src,
        target: e.dst,
        relation: e.relation,
      })),
    }
  }, [graph, centerId])

  function paintNode(node, ctx, globalScale) {
    const r = node.isCenter ? 6 : 5
    ctx.beginPath()
    ctx.moveTo(node.x, node.y - r)
    ctx.lineTo(node.x + r, node.y)
    ctx.lineTo(node.x, node.y + r)
    ctx.lineTo(node.x - r, node.y)
    ctx.closePath()
    ctx.fillStyle = axisColor(node.axis)
    ctx.fill()
    if (node.isCenter) {
      ctx.lineWidth = 2 / globalScale
      ctx.strokeStyle = CENTER_RING
      ctx.stroke()
    }
    if (globalScale > 0.7) {
      const fontSize = Math.min(12, 11 / globalScale)
      ctx.font = `${node.isCenter ? '600 ' : ''}${fontSize}px sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      ctx.fillStyle = LABEL_COLOR
      ctx.fillText(node.label || '', node.x, node.y + r + 1.5)
    }
  }

  const hasNodes = graphData.nodes.length > 0

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden rounded-md border bg-muted/10"
    >
      {!hasNodes && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
          연결된 관계가 없습니다.
        </div>
      )}
      {hasNodes && size.width > 0 && (
        <Suspense
          fallback={
            <div className="absolute inset-0 flex items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          }
        >
          <ForceGraph2D
            graphData={graphData}
            width={size.width}
            height={size.height}
            nodeRelSize={5}
            nodeCanvasObject={paintNode}
            nodeLabel={(n) => n.label ?? ''}
            nodePointerAreaPaint={(node, color, ctx) => {
              const r = 6
              ctx.fillStyle = color
              ctx.beginPath()
              ctx.moveTo(node.x, node.y - r)
              ctx.lineTo(node.x + r, node.y)
              ctx.lineTo(node.x, node.y + r)
              ctx.lineTo(node.x - r, node.y)
              ctx.closePath()
              ctx.fill()
            }}
            linkColor={() => EDGE_COLOR}
            linkDirectionalArrowLength={3.5}
            linkDirectionalArrowRelPos={1}
            linkLabel={(l) =>
              relTypeLabels?.get(l.relation) ?? l.relation ?? ''
            }
            cooldownTicks={80}
            onNodeClick={onNodeClick}
          />
        </Suspense>
      )}
    </div>
  )
}
