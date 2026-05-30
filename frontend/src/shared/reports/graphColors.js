// 관계도 노드 색 매핑 (지식그래프 Phase 2) — 범주(보고서 종류/작성자 등)별
// 색을 빈도순으로 배정한다. 색 수가 팔레트보다 많으면 상위 빈도만 색을 받고
// 나머지는 「기타」 회색으로 묶어 가독성을 지킨다 (12색 넘어가면 사람이 색을
// 구분 못 함).
//
// <canvas> 에서 쓰므로 Tailwind 클래스가 아닌 raw hex. linkKinds.colorHex 와
// 별개 팔레트 — 저쪽은 link kind 의 고정 색, 이쪽은 범주 자동 배정용.

// 12색 범주형 팔레트 (Tailwind -500 계열에서 시각 구분이 잘 되는 순서).
const PALETTE = [
  '#3b82f6', // blue
  '#ef4444', // red
  '#22c55e', // green
  '#a855f7', // purple
  '#f59e0b', // amber
  '#06b6d4', // cyan
  '#ec4899', // pink
  '#84cc16', // lime
  '#f97316', // orange
  '#14b8a6', // teal
  '#8b5cf6', // violet
  '#64748b', // slate
]

// 팔레트를 못 받은 범주(상위 빈도 밖) + 키 없는 노드의 색.
export const OTHER_COLOR = '#cbd5e1' // slate-300

// entity(관련정보) 노드 색 — axis(slug) 별 고정. report 노드의 자동 범주색과
// 달리, axis 는 종류가 적고 의미가 고정이라 슬러그를 해시해 팔레트에 안정적으로
// 매핑한다(세션·필터와 무관하게 같은 axis 는 늘 같은 색). slug 없으면 회색.
export function axisColor(slug) {
  if (!slug) return OTHER_COLOR
  let h = 0
  for (let i = 0; i < slug.length; i += 1) h = (h * 31 + slug.charCodeAt(i)) | 0
  return PALETTE[Math.abs(h) % PALETTE.length]
}

/**
 * 노드별 범주 키 배열을 받아 색 맵 + 범례를 만든다.
 *
 *   @param {Array<string|number>} keys  노드마다 하나씩 (중복 가능)
 *   @returns {{
 *     colorOf: Map<string|number, string>,   // 키 → hex (상위 빈도만)
 *     legend: Array<{key, color, count}>,     // 색 받은 범주 (빈도순)
 *     capped: boolean,                        // 팔레트 초과로 「기타」 묶음 발생
 *   }}
 */
export function buildCategoricalColors(keys) {
  const counts = new Map()
  for (const k of keys) counts.set(k, (counts.get(k) || 0) + 1)
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
  const colorOf = new Map()
  const legend = []
  sorted.forEach(([k, count], i) => {
    if (i < PALETTE.length) {
      colorOf.set(k, PALETTE[i])
      legend.push({ key: k, color: PALETTE[i], count })
    }
    // 팔레트 밖 키는 colorOf 에 안 넣음 → 조회 시 OTHER_COLOR 폴백.
  })
  return { colorOf, legend, capped: sorted.length > PALETTE.length }
}
