// 관계도 노드 색 매핑 (지식그래프 Phase 2) — 글로벌 페이지와 로컬 모달이
// 공유. report 노드를 colorBy(종류/작성자/단색) 기준으로 빈도순 색 배정하고
// 범례를 만든다. entity·composite 노드는 자체 색(축색/앰버)을 쓰므로 집계에서
// 제외한다.
import { useCallback, useMemo } from 'react'
import { cn } from '@/shared/lib/utils'
import { buildCategoricalColors, OTHER_COLOR } from '@/shared/reports/graphColors'

/**
 * @param {object} opts
 * @param {object|null} opts.graph        서버 응답 {nodes,...}
 * @param {'type'|'owner'|'community'|'none'} opts.colorBy
 * @param {Map<number,string>} opts.typeNameById  종류 id→이름 (type 범례용)
 * @param {Map<string,any>|null=} opts.communityOf  report 노드 id → 커뮤니티 키
 *                                  (community 모드, useCommunities 제공)
 * @param {Map<any,string>|null=} opts.communityLabelOf  커뮤니티 키 → 라벨
 * @returns {{colors:object|null, nodeColor:Function|null, labelFor:Function}}
 */
export function useGraphColors({
  graph,
  colorBy,
  typeNameById,
  communityOf = null,
  communityLabelOf = null,
}) {
  // 노드 → 범주 키. type 은 report_type_id(미지정 '__none__'), owner 는 이름,
  // community 는 useCommunities 가 배정한 커뮤니티 키(없으면 소규모).
  const keyOf = useCallback(
    (node) => {
      if (colorBy === 'type') return node.report_type_id ?? '__none__'
      if (colorBy === 'owner') return node.owner_name ?? '__none__'
      if (colorBy === 'community') return communityOf?.get(node.id) ?? '__small__'
      return null
    },
    [colorBy, communityOf],
  )
  const labelFor = useCallback(
    (key) => {
      if (colorBy === 'community') return communityLabelOf?.get(key) ?? '클러스터'
      if (key === '__none__') return '미지정'
      if (colorBy === 'type') return typeNameById.get(key) ?? `#${key}`
      return String(key)
    },
    [colorBy, typeNameById, communityLabelOf],
  )
  const colors = useMemo(() => {
    if (colorBy === 'none' || !graph?.nodes?.length) return null
    // community 모드인데 클러스터 미산출(노드 적음 등)이면 색 안 입힘 → 회색 단색.
    if (colorBy === 'community' && !communityOf?.size) return null
    // report 노드만 — entity/composite 노드는 자체 색이라 집계 제외.
    const reportNodes = graph.nodes.filter((n) => n.type === 'report')
    if (!reportNodes.length) return null
    return buildCategoricalColors(reportNodes.map((n) => keyOf(n)))
  }, [colorBy, graph, keyOf, communityOf])
  const nodeColor = useMemo(() => {
    if (!colors) return null
    return (node) => colors.colorOf.get(keyOf(node)) ?? OTHER_COLOR
  }, [colors, keyOf])

  return { colors, nodeColor, labelFor }
}

/** 색 범례 — 색을 받은 범주(빈도순) + 「기타」 묶음. */
export function GraphColorLegend({ colors, labelFor, className }) {
  if (!colors?.legend?.length) return null
  return (
    <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1', className)}>
      {colors.legend.map((item) => (
        <span
          key={String(item.key)}
          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"
        >
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: item.color }}
          />
          {labelFor(item.key)}
          <span className="tabular-nums opacity-60">({item.count})</span>
        </span>
      ))}
      {colors.capped && (
        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: OTHER_COLOR }}
          />
          기타
        </span>
      )}
    </div>
  )
}
