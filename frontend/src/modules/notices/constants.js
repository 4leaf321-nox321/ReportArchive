// 공지 시간 표시 — 서버가 UTC(+00:00 오프셋 포함)로 내려주므로 new Date 로
// 파싱하면 사용자 로컬(KST)로 변환된다. (VOC constants 와 동일 규칙.)
const pad2 = (n) => String(n).padStart(2, '0')

/** "2026-06-25 14:30" — 로컬 기준 분 단위 일시. */
export function noticeDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** "06-25" — 로컬 기준 월-일(목록의 좁은 칸용). */
export function noticeMonthDay(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}
