// 종합보고 종류 (kind) — single source of truth for labels/colors.
// 'recurring' = 정기 (period-anchored), 'theme' = 주제 (time-independent).
export const KINDS = [
  { value: 'recurring', label: '정기', variant: 'default'   },
  { value: 'theme',     label: '주제', variant: 'secondary' },
]

export const KIND_LABEL = Object.fromEntries(KINDS.map((k) => [k.value, k.label]))
export const KIND_VARIANT = Object.fromEntries(KINDS.map((k) => [k.value, k.variant]))
