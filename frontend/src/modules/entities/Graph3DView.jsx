import { lazy, Suspense, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import * as THREE from 'three'
import SpriteText from 'three-spritetext'
import { axisColor } from '@/shared/reports/graphColors'

const LABEL_COLOR = '#e5e7eb' // gray-200 — 어두운 배경 위 라벨
const LABEL_CENTER = '#fbbf24' // amber — 중심 라벨

// 소프트 글로우 헤일로 텍스처(방사 그라데이션) — 노드 뒤에 깔아 성좌처럼 은은히 빛나게.
// 한 번만 만들어 모든 노드가 공유(색은 스프라이트 material.color 로 틴트).
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
    // 노드별 연결 수(degree) — 크기·라벨 강조에. 많이 연결된 게 크게 보이면 구조가 읽힌다.
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
            nodeLabel={(n) => n.label ?? ''}
            nodeThreeObject={(n) => {
              const r = n.isCenter ? 5 : Math.max(2, 2 + Math.sqrt(n.degree || 0) * 1.2)
              const color = nodeColor(n)
              const group = new THREE.Group()
              // 발광 구 — emissive 로 어두운 배경에서 스스로 은은히 빛난다.
              const sphere = new THREE.Mesh(
                new THREE.SphereGeometry(r, 24, 24),
                new THREE.MeshStandardMaterial({
                  color,
                  emissive: color,
                  emissiveIntensity: n.isCenter ? 0.75 : 0.5,
                  roughness: 0.3,
                  metalness: 0.0,
                }),
              )
              group.add(sphere)
              // 소프트 헤일로(글로우) — 가산 블렌딩 반투명 스프라이트.
              const halo = new THREE.Sprite(
                new THREE.SpriteMaterial({
                  map: haloTexture(),
                  color,
                  transparent: true,
                  opacity: n.isCenter ? 0.6 : 0.42,
                  blending: THREE.AdditiveBlending,
                  depthWrite: false,
                }),
              )
              halo.scale.set(r * 4.5, r * 4.5, 1)
              group.add(halo)
              // 라벨 — depthTest=false 로 노드에 안 가리고 항상 최앞에.
              const label = new SpriteText(n.label || '')
              label.color = n.isCenter ? LABEL_CENTER : LABEL_COLOR
              label.textHeight = n.isCenter ? 4.5 : 3
              label.fontWeight = n.isCenter ? '600' : '400'
              label.material.depthTest = false
              label.material.depthWrite = false
              label.renderOrder = 10
              label.position.set(0, r + 4, 0) // 노드 위
              group.add(label)
              return group
            }}
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
