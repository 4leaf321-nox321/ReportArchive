// VOC labels / variants — single source of truth so list page, detail
// page, and new-post dialog all stay in sync. Variants map onto our
// shadcn Badge styles.

export const VOC_CATEGORIES = [
  { value: 'bug',         label: '버그',     variant: 'destructive' },
  { value: 'feature',     label: '기능 요청', variant: 'default'     },
  { value: 'improvement', label: '개선',     variant: 'secondary'   },
  { value: 'question',    label: '질문',     variant: 'outline'     },
  { value: 'other',       label: '기타',     variant: 'outline'     },
]

export const VOC_STATUSES = [
  { value: 'open',        label: '열림',    variant: 'default'     },
  { value: 'in_progress', label: '진행 중', variant: 'secondary'   },
  { value: 'resolved',    label: '해결됨',  variant: 'outline'     },
  { value: 'wontfix',     label: '보류',    variant: 'outline'     },
]

export const VOC_PRIORITIES = [
  { value: 'low',      label: '낮음',  variant: 'outline'     },
  { value: 'normal',   label: '보통',  variant: 'secondary'   },
  { value: 'high',     label: '높음',  variant: 'default'     },
  { value: 'critical', label: '긴급',  variant: 'destructive' },
]

const toMap = (arr) => Object.fromEntries(arr.map((x) => [x.value, x]))
export const VOC_CATEGORY_BY = toMap(VOC_CATEGORIES)
export const VOC_STATUS_BY = toMap(VOC_STATUSES)
export const VOC_PRIORITY_BY = toMap(VOC_PRIORITIES)

// VOC 시간 표시 — 서버가 UTC(+00:00 오프셋 포함)로 내려주므로 new Date 로
// 파싱하면 사용자 로컬(KST)로 변환된다. 과거엔 ISO 문자열을 그대로 slice 해서
// 변환 없이 UTC 시각을 보여 9시간 어긋나 있었다.
const pad2 = (n) => String(n).padStart(2, '0')

/** "2026-06-25 14:30" — 로컬 기준 분 단위 일시. */
export function vocDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** "06-25" — 로컬 기준 월-일(목록의 좁은 칸용). */
export function vocMonthDay(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}
