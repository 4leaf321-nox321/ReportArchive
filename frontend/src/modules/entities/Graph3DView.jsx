import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Loader2, Home, Plus } from 'lucide-react'
import { toast } from 'sonner'
import * as THREE from 'three'
import SpriteText from 'three-spritetext'
import { axisColor } from '@/shared/reports/graphColors'
import { getEntityGraph } from '@/shared/api/entities'

// react-force-graph-3d 는 무겁고(three 기반) 3D 모드에서만 쓰므로 lazy 로 분리.
const ForceGraph3D = lazy(() => import('react-force-graph-3d'))

const EDGE_COLOR = 'rgba(148,163,184,0.55)'
const DIM_EDGE_COLOR = 'rgba(100,116,139,0.08)'
const CENTER_COLOR = '#f59e0b'
const SYSTEM_COLOR = '#9ca3af'
const BG_COLOR = '#0b1020'
const LABEL_COLOR = '#e5e7eb'
const LABEL_CENTER = '#fbbf24'
const NODE_CAP = 400 // 확장 상한(폭주 방지)

function nodeColorOf(n) {
  if (n.isCenter) return CENTER_COLOR
  if (n.kind === 'system') return SYSTEM_COLOR
  return axisColor(n.axis)
}

const endId = (e) => (e && typeof e === 'object' ? e.id : e)

// 두 서브그래프 병합(노드 id·엣지 (src,dst,relation) 기준 dedupe). 확장 누적에.
function mergeGraph(a, b) {
  const nodes = new Map()
  for (const n of a?.nodes ?? []) nodes.set(n.id, n)
  for (const n of b?.nodes ?? []) if (!nodes.has(n.id)) nodes.set(n.id, n)
  const key = (e) => `${e.src}->${e.dst}:${e.relation}`
  const edges = new Map()
  for (const e of a?.edges ?? []) edges.set(key(e), e)
  for (const e of b?.edges ?? []) if (!edges.has(key(e))) edges.set(key(e), e)
  return { nodes: [...nodes.values()], edges: [...edges.values()] }
}

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
 * 엔티티 서브그래프 3D force 뷰(관계도 3D). 발광 노드+라벨, 방향 파티클 엣지.
 * 항해(P2): 클릭=fly-to+focus, 더블클릭=이동(순회), 홈=리셋. 확장(P3): 집중한 노드의
 * 이웃을 더 로드해 제자리에서 그래프를 키움(위치 보존). props 는 EntityGraphView 와 동일.
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
  const nodeObjsRef = useRef(new Map()) // id → 노드 객체(x,y,z 보존용)
  const [focusId, setFocusId] = useState(null)
  const [extraGraph, setExtraGraph] = useState({ nodes: [], edges: [] })
  const [expandedIds, setExpandedIds] = useState(() => new Set())
  const [expanding, setExpanding] = useState(false)

  // 중심(조회 대상)이 바뀌면 확장·위치 캐시 초기화(새 그래프).
  useEffect(() => {
    setExtraGraph({ nodes: [], edges: [] })
    setExpandedIds(new Set())
    setFocusId(null)
    nodeObjsRef.current = new Map()
  }, [centerId])

  const graphData = useMemo(() => {
    const merged = mergeGraph(graph, extraGraph)
    const degree = {}
    for (const e of merged.edges) {
      degree[e.src] = (degree[e.src] || 0) + 1
      degree[e.dst] = (degree[e.dst] || 0) + 1
    }
    const cache = nodeObjsRef.current
    const nodes = merged.nodes.map((n) => {
      const fields = {
        id: n.id,
        label: n.value,
        axis: n.type_slug,
        isCenter: n.id === centerId,
        kind: n.kind ?? 'entity',
        refType: n.ref_type,
        refId: n.ref_id,
        degree: degree[n.id] || 0,
      }
      const cached = cache.get(n.id)
      if (cached) {
        Object.assign(cached, fields) // x,y,z 는 유지(재배치 안 함)
        return cached
      }
      cache.set(n.id, fields)
      return fields
    })
    const links = merged.edges.map((e) => ({
      source: e.src,
      target: e.dst,
      relation: e.relation,
    }))
    return { nodes, links }
  }, [graph, extraGraph, centerId])

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
        clickRef.current = { id: null, t: 0 }
        onNodeClick?.(node)
        return
      }
      clickRef.current = { id: node.id, t: now }
      setFocusId(node.id)
      flyTo(node)
    },
    [onNodeClick, flyTo],
  )

  const resetView = useCallback(() => {
    setFocusId(null)
    fgRef.current?.zoomToFit(500, 40)
  }, [])

  const expandNode = useCallback(
    async (node) => {
      if (!node || node.kind !== 'entity' || expanding) return
      setExpanding(true)
      try {
        const res = await getEntityGraph(node.id, { depth: 1 })
        // 현재(이미 표시된) 노드 대비 새로 추가되는 것만 셈 — 내부 노드는 이웃이
        // 이미 다 로드돼 있어 0 일 수 있다(그걸 사용자에게 알려준다).
        const known = new Set(graphData.nodes.map((n) => n.id))
        const added = (res?.nodes ?? []).filter((n) => !known.has(n.id)).length
        if (added > 0) {
          setExtraGraph((prev) =>
            mergeGraph(prev, { nodes: res?.nodes ?? [], edges: res?.edges ?? [] }),
          )
          toast.success(`이웃 ${added}개를 추가했습니다.`)
        } else {
          toast.info('이 노드의 이웃은 이미 모두 표시돼 있어요.')
        }
        setExpandedIds((prev) => new Set(prev).add(node.id))
      } catch {
        toast.error('이웃을 불러오지 못했습니다.')
      } finally {
        setExpanding(false)
      }
    },
    [expanding, graphData],
  )

  const hasNodes = graphData.nodes.length > 0
  const focusedNode =
    focusId != null ? graphData.nodes.find((n) => n.id === focusId) : null
  const canExpand =
    focusedNode &&
    focusedNode.kind === 'entity' &&
    !expandedIds.has(focusedNode.id) &&
    graphData.nodes.length < NODE_CAP

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
          <div className="absolute left-2 top-2 z-10 flex flex-wrap items-center gap-2">
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
                집중 · 더블클릭으로 이동
              </span>
            )}
            {canExpand && (
              <button
                type="button"
                onClick={() => expandNode(focusedNode)}
                disabled={expanding}
                className="inline-flex items-center gap-1 rounded-md border border-primary/40 bg-primary/80 px-2 py-1 text-[11px] font-medium text-primary-foreground backdrop-blur hover:bg-primary disabled:opacity-60"
                title="이 노드의 이웃을 더 불러와 그래프를 넓힘"
              >
                <Plus className="h-3.5 w-3.5" />
                {expanding ? '불러오는 중…' : '이웃 확장'}
              </button>
            )}
            {graphData.nodes.length >= NODE_CAP && (
              <span className="rounded-md bg-black/40 px-2 py-1 text-[11px] text-amber-300 backdrop-blur">
                노드 상한({NODE_CAP})
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
