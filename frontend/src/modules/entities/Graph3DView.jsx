import {
  lazy,
  Suspense,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Loader2, Home } from 'lucide-react'
import * as THREE from 'three'
import SpriteText from 'three-spritetext'
import { axisColor } from '@/shared/reports/graphColors'

// react-force-graph-3d 는 무겁고(three 기반) 3D 모드에서만 쓰므로 lazy 로 분리.
// EntityGraphView(2D)와 같은 props·데이터 shape 를 받는 3D 버전 — 공간을 이동/회전하며
// 더 넓게 조망하기 위함. three 는 이미 프로젝트 의존성.
const ForceGraph3D = lazy(() => import('react-force-graph-3d'))

const EDGE_COLOR = 'rgba(148,163,184,0.55)'
const DIM_EDGE_COLOR = 'rgba(100,116,139,0.08)' // focus 시 관련 없는 엣지
const CENTER_COLOR = '#f59e0b' // amber — 중심(조회한) 객체
const SYSTEM_COLOR = '#9ca3af' // gray — system 객체(부서 등)
const BG_COLOR = '#0b1020' // 어두운 우주 배경
const LABEL_COLOR = '#e5e7eb' // gray-200
const LABEL_CENTER = '#fbbf24' // amber — 중심 라벨

function nodeColorOf(n) {
  if (n.isCenter) return CENTER_COLOR
  if (n.kind === 'system') return SYSTEM_COLOR
  return axisColor(n.axis)
}

// 엣지 끝점 id — force-graph 가 source/target 을 노드 객체로 치환하기 전/후 모두 대응.
const endId = (e) => (e && typeof e === 'object' ? e.id : e)

// 소프트 글로우 헤일로 텍스처(방사 그라데이션) — 한 번만 만들어 공유(색은 material.color 틴트).
let _haloTex = null
function haloTexture() {
  if (_haloTex) return _haloTex
  const size = 64
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0, 'rgba(255,255,255,0.85)')
  g.addColorStop(0.35, 'rgba(255,255,255,0.25)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  _haloTex = new THREE.CanvasTexture(c)
  return _haloTex
}

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
 * 엔티티 서브그래프 3D force 뷰(관계도 3D). 노드=발광 구+헤일로+라벨, 엣지=방향
 * 화살표+흐르는 파티클. 항해(P2): 클릭=fly-to+focus(이웃만 밝게), 더블클릭=이동(순회),
 * 홈=리셋. props 는 EntityGraphView(2D)와 동일.
 */
export function Graph3DView({
  graph,
  centerId,
  relTypeLabels,
  active = true,
  onNodeClick,
}) {
  const [containerRef, size] = useElementSize(active)
  const fgRef = useRef(null)
  const clickRef = useRef({ id: null, t: 0 })
  const [focusId, setFocusId] = useState(null)

  const graphData = useMemo(() => {
    if (!graph) return { nodes: [], links: [] }
    const degree = {}
    for (const e of graph.edges ?? []) {
      degree[e.src] = (degree[e.src] || 0) + 1
      degree[e.dst] = (degree[e.dst] || 0) + 1
    }
    return {
      nodes: (graph.nodes ?? []).map((n) => ({
        id: n.id,
        label: n.value,
        axis: n.type_slug,
        isCenter: n.id === centerId,
        kind: n.kind ?? 'entity',
        refType: n.ref_type,
        refId: n.ref_id,
        degree: degree[n.id] || 0,
      })),
      links: (graph.edges ?? []).map((e) => ({
        source: e.src,
        target: e.dst,
        relation: e.relation,
      })),
    }
  }, [graph, centerId])

  // focus 노드의 이웃 집합(focus 자신 포함) — 나머지는 페이드.
  const focusSet = useMemo(() => {
    if (focusId == null) return null
    const s = new Set([focusId])
    for (const l of graphData.links) {
      const a = endId(l.source)
      const b = endId(l.target)
      if (a === focusId) s.add(b)
      if (b === focusId) s.add(a)
    }
    return s
  }, [focusId, graphData])

  const isDim = useCallback((id) => focusSet != null && !focusSet.has(id), [focusSet])

  const nodeThreeObject = useCallback(
    (n) => {
      const dim = isDim(n.id)
      const r = n.isCenter ? 5 : Math.max(2, 2 + Math.sqrt(n.degree || 0) * 1.2)
      const color = nodeColorOf(n)
      const group = new THREE.Group()
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(r, 24, 24),
        new THREE.MeshStandardMaterial({
          color,
          emissive: color,
          emissiveIntensity: dim ? 0.08 : n.isCenter ? 0.75 : 0.5,
          roughness: 0.3,
          metalness: 0.0,
          transparent: true,
          opacity: dim ? 0.25 : 1,
        }),
      )
      group.add(sphere)
      const halo = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: haloTexture(),
          color,
          transparent: true,
          opacity: dim ? 0.05 : n.isCenter ? 0.6 : 0.42,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      )
      halo.scale.set(r * 4.5, r * 4.5, 1)
      group.add(halo)
      // 라벨 — focus 중이면 이웃만 표시(soup 방지), depthTest=false 로 항상 최앞.
      if (!dim) {
        const label = new SpriteText(n.label || '')
        label.color = n.isCenter ? LABEL_CENTER : LABEL_COLOR
        label.textHeight = n.isCenter ? 4.5 : 3
        label.fontWeight = n.isCenter ? '600' : '400'
        label.material.depthTest = false
        label.material.depthWrite = false
        label.renderOrder = 10
        label.position.set(0, r + 4, 0)
        group.add(label)
      }
      return group
    },
    [isDim],
  )

  const linkColor = useCallback(
    (l) => (isDim(endId(l.source)) || isDim(endId(l.target)) ? DIM_EDGE_COLOR : EDGE_COLOR),
    [isDim],
  )

  const flyTo = useCallback((node) => {
    const fg = fgRef.current
    if (!fg || node.x == null) return
    const dist = 90
    const hyp = Math.hypot(node.x, node.y, node.z || 0) || 1
    const ratio = 1 + dist / hyp
    fg.cameraPosition(
      { x: node.x * ratio, y: node.y * ratio, z: (node.z || 0) * ratio },
      node,
      800,
    )
  }, [])

  const handleNodeClick = useCallback(
    (node) => {
      const now = Date.now()
      const prev = clickRef.current
      if (prev.id === node.id && now - prev.t < 350) {
        // 더블클릭 → 이동(순회).
        clickRef.current = { id: null, t: 0 }
        onNodeClick?.(node)
        return
      }
      clickRef.current = { id: node.id, t: now }
      // 단일클릭 → focus + fly-to(제자리 탐색).
      setFocusId(node.id)
      flyTo(node)
    },
    [onNodeClick, flyTo],
  )

  const resetView = useCallback(() => {
    setFocusId(null)
    fgRef.current?.zoomToFit(500, 40)
  }, [])

  const hasNodes = graphData.nodes.length > 0

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
        <>
          <div className="absolute left-2 top-2 z-10 flex items-center gap-2">
            <button
              type="button"
              onClick={resetView}
              className="inline-flex items-center gap-1 rounded-md border border-white/20 bg-black/40 px-2 py-1 text-[11px] text-white/90 backdrop-blur hover:bg-black/60"
              title="전체 보기로 리셋"
            >
              <Home className="h-3.5 w-3.5" />홈
            </button>
            {focusId != null && (
              <span className="rounded-md bg-black/40 px-2 py-1 text-[11px] text-white/70 backdrop-blur">
                집중 모드 · 더블클릭으로 이동
              </span>
            )}
          </div>
          <Suspense
            fallback={
              <div className="absolute inset-0 flex items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            }
          >
            <ForceGraph3D
              ref={fgRef}
              graphData={graphData}
              width={size.width}
              height={size.height}
              backgroundColor={BG_COLOR}
              nodeLabel={(n) => n.label ?? ''}
              nodeThreeObject={nodeThreeObject}
              linkColor={linkColor}
              linkOpacity={0.5}
              linkWidth={0.5}
              linkDirectionalArrowLength={3}
              linkDirectionalArrowRelPos={1}
              linkDirectionalParticles={(l) =>
                isDim(endId(l.source)) || isDim(endId(l.target)) ? 0 : 1
              }
              linkDirectionalParticleWidth={1.4}
              linkLabel={(l) => relTypeLabels?.get(l.relation) ?? l.relation ?? ''}
              onNodeClick={handleNodeClick}
              onBackgroundClick={() => setFocusId(null)}
              cooldownTicks={100}
            />
          </Suspense>
        </>
      )}
    </div>
  )
}
