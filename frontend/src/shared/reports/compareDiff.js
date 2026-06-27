// 버전 비교(분할) — 좌(현재 편집본)·우(과거 버전) pages 를 페이지 인덱스·block
// 단위로 비교한다. 결과 shape:
//   { [pageIdx]: { [blockId]: 'changed' | 'added' | 'removed' } }
//     changed = 양쪽에 있으나 content 가 다름   → 좌·우 모두 강조(앰버)
//     added   = 현재(좌)에만 있음(버전 이후 추가) → 좌측 강조(에메랄드)
//     removed = 버전(우)에만 있음(이후 삭제)      → 우측 강조(로즈)
//
// 페이지는 인덱스로 매칭한다(같은 보고서의 버전이라 보통 안정적). block 은
// block_id 로 매칭 — 같은 보고서라 id 가 안정적이라 정확하다.

// JSON 안전 구조의 deep 비교 — 키 순서 무시(버전 저장 시점에 따라 순서가 달라도
// 같게 본다), 배열 순서는 반영(표 행 재정렬 = 실제 변경). 백엔드 도장 로직의
// dict != dict 와 같은 의미.
export function deepEqual(a, b) {
  if (a === b) return true
  if (a === null || b === null) return false
  if (typeof a !== 'object' || typeof b !== 'object') return false
  const aArr = Array.isArray(a)
  if (aArr !== Array.isArray(b)) return false
  if (aArr) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false
    return true
  }
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false
    if (!deepEqual(a[k], b[k])) return false
  }
  return true
}

export function computeCompareDiff(curPages, verPages) {
  const cur = Array.isArray(curPages) ? curPages : []
  const ver = Array.isArray(verPages) ? verPages : []
  const out = {}
  const n = Math.max(cur.length, ver.length)
  for (let i = 0; i < n; i++) {
    const cc = cur[i]?.content || {}
    const vc = ver[i]?.content || {}
    const map = {}
    const ids = new Set([...Object.keys(cc), ...Object.keys(vc)])
    for (const bid of ids) {
      const inC = Object.prototype.hasOwnProperty.call(cc, bid)
      const inV = Object.prototype.hasOwnProperty.call(vc, bid)
      if (inC && inV) {
        if (!deepEqual(cc[bid], vc[bid])) map[bid] = 'changed'
      } else if (inC) {
        map[bid] = 'added'
      } else {
        map[bid] = 'removed'
      }
    }
    if (Object.keys(map).length) out[i] = map
  }
  return out
}
