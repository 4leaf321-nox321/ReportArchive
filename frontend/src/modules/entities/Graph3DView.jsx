import { lazy, Suspense, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { axisColor } from '@/shared/reports/graphColors'

// react-force-graph-3d 는 무겁고(three 기반) 3D 모드에서만 쓰므로 lazy 로 분리.
// EntityGraphView(2D)와 같은 props·데이터 shape 를 받는 3D 버전 — 공간을 이동/회전하며
// 더 넓게 조망하기 위함(관계도 3D §P0). three 는 이미 프로젝트 의존성.
const ForceGraph3D = lazy(() => import('react-force-graph-3d'))

const EDGE_COLOR = 'rgba(148,163,184,0.55)'
const CENTER_COLOR = '#f59e0b' // amber — 중심(조회한) 객체
const SYSTEM_COLOR = '#9ca3af' // gray — system 객체(부서 등)
const BG_COLOR = '#0b1020' // 어두운 우주 배경 — 노드 색이 살고 깊이감이 생긴다

// EntityGraphView 와 동일 — ForceGraph 는 명시적 width/height 필요.
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
 * 엔티티 서브그래프 3D force 뷰. EntityGraphView(2D)와 같은 props. 노드=축 색 구,
 * 중심은 앰버·크게, system 객체는 회색. 엣지=방향 화살표 + 흐르는 파티클(관계 방향).
 * 마우스로 궤도 회전·줌·이동. onNodeClick 으로 순회.
 */
export function Graph3DView({
  graph,
  centerId,
  relTypeLabels,
  active = true,
  onNodeClick,
}) {
  const [containerRef, size] = useElementSize(active)

  const graphData = useMemo(() => {
    if (!graph) return { nodes: [], links: [] }
    return {
      nodes: (graph.nodes ?? []).map((n) => ({
        id: n.id,
        label: n.value,
        axis: n.type_slug,
        isCenter: n.id === centerId,
        kind: n.kind ?? 'entity',
        refType: n.ref_type,
        refId: n.ref_id,
      })),
      links: (graph.edges ?? []).map((e) => ({
        source: e.src,
        target: e.dst,
        relation: e.relation,
      })),
    }
  }, [graph, centerId])

  const hasNodes = graphData.nodes.length > 0

  const nodeColor = (n) =>
    n.isCenter ? CENTER_COLOR : n.kind === 'system' ? SYSTEM_COLOR : axisColor(n.axis)

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden rounded-md border"
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
          <ForceGraph3D
            graphData={graphData}
            width={size.width}
            height={size.height}
            backgroundColor={BG_COLOR}
            nodeColor={nodeColor}
            nodeVal={(n) => (n.isCenter ? 6 : 3)}
            nodeOpacity={0.95}
            nodeLabel={(n) => n.label ?? ''}
            linkColor={() => EDGE_COLOR}
            linkOpacity={0.5}
            linkWidth={0.5}
            linkDirectionalArrowLength={3}
            linkDirectionalArrowRelPos={1}
            linkDirectionalParticles={1}
            linkDirectionalParticleWidth={1.4}
            linkLabel={(l) => relTypeLabels?.get(l.relation) ?? l.relation ?? ''}
            onNodeClick={onNodeClick}
            cooldownTicks={100}
          />
        </Suspense>
      )}
    </div>
  )
}
