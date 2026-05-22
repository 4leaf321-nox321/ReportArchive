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
