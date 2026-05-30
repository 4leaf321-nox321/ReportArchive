// 보고서 link 의 의미 유형 매핑 — 카탈로그 자체는 백엔드 DB
// (`report_link_kinds` 테이블) 가 권위, 이 파일은 색 클래스 매핑과 같은
// "표시" 관련 정적 자산만 가진다.
//
// 새 색을 도입하려면:
//   1. 백엔드 `app/shared/link_kinds.py` 의 ALLOWED_COLORS 에 추가
//   2. 여기 COLOR_CLASSES 에도 같은 키로 Tailwind 클래스 추가
//      (Tailwind purge 가 정적 분석에 의존 — 동적 키워드로 만들면 빌드
//      산출물에서 클래스가 빠진다.)

const COLOR_CLASSES = {
  blue: 'bg-blue-50 text-blue-700 border-blue-200',
  green: 'bg-green-50 text-green-700 border-green-200',
  purple: 'bg-purple-50 text-purple-700 border-purple-200',
  amber: 'bg-amber-50 text-amber-700 border-amber-200',
  slate: 'bg-slate-50 text-slate-700 border-slate-200',
  rose: 'bg-rose-50 text-rose-700 border-rose-200',
  sky: 'bg-sky-50 text-sky-700 border-sky-200',
  teal: 'bg-teal-50 text-teal-700 border-teal-200',
  orange: 'bg-orange-50 text-orange-700 border-orange-200',
  pink: 'bg-pink-50 text-pink-700 border-pink-200',
}

export const ALLOWED_COLORS = Object.keys(COLOR_CLASSES)

// Canvas (관계도) 용 raw hex — Tailwind 클래스는 <canvas> 에서 못 쓰므로
// 같은 팔레트의 -500 톤을 직접 들고 있는다. COLOR_CLASSES 와 키가 1:1.
// 새 색을 추가하면 여기도 같은 키로 채워 줄 것.
const COLOR_HEX = {
  blue: '#3b82f6',
  green: '#22c55e',
  purple: '#a855f7',
  amber: '#f59e0b',
  slate: '#64748b',
  rose: '#f43f5e',
  sky: '#0ea5e9',
  teal: '#14b8a6',
  orange: '#f97316',
  pink: '#ec4899',
}

/**
 * 색 키 → hex. <canvas> 렌더(관계도 엣지/노드)용. 모르는 키는 slate.
 * @param {string} color
 */
export function colorHex(color) {
  return COLOR_HEX[color] ?? COLOR_HEX.slate
}

/**
 * @param {string} color  서버가 내려준 색 키 (blue / green / ...)
 */
export function colorClasses(color) {
  return COLOR_CLASSES[color] ?? COLOR_CLASSES.slate
}

/**
 * 카탈로그 row 와 direction 으로부터 사용자에게 보일 라벨을 결정.
 * - outgoing: from → to → forward_label ("참조")
 * - incoming: to ← from → reverse_label ("참조됨")
 */
export function labelForKind(kindRow, direction) {
  if (!kindRow) return ''
  return direction === 'incoming'
    ? kindRow.reverse_label
    : kindRow.forward_label
}
