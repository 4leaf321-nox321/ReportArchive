// 관계도 노드 자동 클러스터링 (지식그래프 §11.4 4a) — 클라이언트에서 Louvain 으로
// 밀집 연결된 보고서를 커뮤니티로 묶는다. 백엔드 변경 없음.
//
// 입력 그래프 구성:
//   - 기본: report↔report explicit link 만 (안정적 backbone).
//   - includeBridges: entity 노드 + has_tag 엣지를 함께 넣어 entity 를 hub 로 둔다
//     → 같은 관련정보를 공유한 보고서가 한 커뮤니티로. 결과에선 entity 의 커뮤니티
//     배정은 버리고 report 노드만 남긴다.
//   - composite_member 는 제외(hub 가 멤버 전체를 한 덩어리로 뭉개 너무 공격적).
import { useMemo } from 'react'
import Graph from 'graphology'
import louvain from 'graphology-communities-louvain'
import { buildCategoricalColors } from '@/shared/reports/graphColors'

// 작은 그래프엔 클러스터링이 노이즈라, report 노드가 이 수 미만이면 적용 안 함.
export const COMMUNITY_MIN_NODES = 30
// 이 인원 미만 커뮤니티는 의미가 옅어 SMALL_KEY 로 묶어 회색 처리한다.
const MIN_COMMUNITY_SIZE = 3
export const SMALL_KEY = '__small__'

// 엣지 끝점 id — 서버 응답은 문자열이지만 안전하게 객체(force-graph 치환 후)도 처리.
function idOf(end) {
  return end && typeof end === 'object' ? end.id : end
}

// 고정 시드 PRNG(mulberry32) — Louvain 은 랜덤 시드를 쓰므로, 고정하지 않으면
// 리렌더마다 커뮤니티 번호(=색)가 바뀐다. 시드를 박아 안정적으로 만든다.
function seededRng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * @param {object} opts
 * @param {object|null} opts.graph        서버 응답 {nodes, edges}
 * @param {boolean} opts.enabled          colorBy==='community' 등 활성 여부
 * @param {boolean=} opts.includeBridges  entity has_tag 로 보고서를 잇는다
 * @param {Map<number,string>=} opts.typeNameById  커뮤니티 라벨(최빈 종류)용
 * @returns {{ready:boolean, communityOf:Map<string,any>|null, labelOf:Map, count:number}}
 */
export function useCommunities({ graph, enabled, includeBridges = false, typeNameById }) {
  // 1) Louvain — graph/옵션에만 의존. 라벨용 typeNameById 와 분리해 재계산 최소화.
  const base = useMemo(() => {
    if (!enabled || !graph?.nodes?.length) return null
    const reportIds = new Set(
      graph.nodes.filter((n) => n.type === 'report').map((n) => n.id),
    )
    if (reportIds.size < COMMUNITY_MIN_NODES) return { ready: false }
    const entityIds = includeBridges
      ? new Set(graph.nodes.filter((n) => n.type === 'entity').map((n) => n.id))
      : null

    const g = new Graph({ type: 'undirected', multi: false })
    for (const id of reportIds) g.mergeNode(id)
    if (entityIds) for (const id of entityIds) g.mergeNode(id)
    for (const e of graph.edges || []) {
      if (e.kind === 'composite_member') continue
      const s = idOf(e.source)
      const t = idOf(e.target)
      if (s === t) continue
      if (e.kind === 'has_tag') {
        // entity 브릿지(report↔entity). 브릿지 OFF 면 skip.
        if (!entityIds || !g.hasNode(s) || !g.hasNode(t)) continue
        if (!g.hasEdge(s, t)) g.addEdge(s, t)
        continue
      }
      // explicit link(report↔report).
      if (reportIds.has(s) && reportIds.has(t) && !g.hasEdge(s, t)) g.addEdge(s, t)
    }
    if (g.size === 0) return { ready: false } // 엣지 없음 → 클러스터링 무의미

    const mapping = louvain(g, { rng: seededRng(0x9e3779b9) })

    // report 노드만 추려 커뮤니티별 크기 집계.
    const sizeOf = new Map()
    for (const id of reportIds) {
      const c = mapping[id]
      if (c == null) continue
      sizeOf.set(c, (sizeOf.get(c) || 0) + 1)
    }
    // 작은 커뮤니티는 SMALL_KEY 로 흡수. 살아남은 커뮤니티만 색·라벨을 받는다.
    const communityOf = new Map()
    for (const id of reportIds) {
      const c = mapping[id]
      communityOf.set(id, sizeOf.get(c) >= MIN_COMMUNITY_SIZE ? c : SMALL_KEY)
    }
    const survivors = [...sizeOf.entries()]
      .filter(([, n]) => n >= MIN_COMMUNITY_SIZE)
      .sort((a, b) => b[1] - a[1])
      .map(([c]) => c)
    if (!survivors.length) return { ready: false } // 전부 소규모 → 의미 없음
    // 커뮤니티 키 → 색 (빈도순 12색 + 기타). 노드 색(4a)과 외곽선(4b)이 공유.
    const colorOf = buildCategoricalColors(
      [...communityOf.values()],
    ).colorOf
    return { ready: true, communityOf, survivors, colorOf }
  }, [enabled, graph, includeBridges])

  // 2) 라벨 — 살아남은 커뮤니티의 최빈 보고서 종류 이름("모델X 계열"). Louvain 은
  //    안 돌리고 typeNameById 변화에만 반응.
  const labelOf = useMemo(() => {
    const m = new Map([[SMALL_KEY, '소규모']])
    if (!base?.ready) return m
    const { communityOf, survivors } = base
    const byId = new Map((graph?.nodes || []).map((n) => [n.id, n]))
    const typeCount = new Map() // community -> Map(typeId -> count)
    for (const [id, c] of communityOf) {
      if (c === SMALL_KEY) continue
      const tid = byId.get(id)?.report_type_id ?? '__none__'
      if (!typeCount.has(c)) typeCount.set(c, new Map())
      const tc = typeCount.get(c)
      tc.set(tid, (tc.get(tid) || 0) + 1)
    }
    survivors.forEach((c, i) => {
      const tc = typeCount.get(c)
      let topTid = null
      let topN = -1
      if (tc) for (const [tid, n] of tc) if (n > topN) { topN = n; topTid = tid }
      const name =
        topTid != null && topTid !== '__none__' ? typeNameById?.get(topTid) : null
      m.set(c, name ? `${name} 계열` : `클러스터 ${i + 1}`)
    })
    return m
  }, [base, graph, typeNameById])

  return {
    ready: !!base?.ready,
    communityOf: base?.ready ? base.communityOf : null,
    colorOf: base?.ready ? base.colorOf : null,
    labelOf,
    count: base?.ready ? base.survivors.length : 0,
  }
}
