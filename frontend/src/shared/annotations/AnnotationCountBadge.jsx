/**
 * Small `n/200` chip shown next to the annotation toolbar. Turns
 * amber past the SOFT_LIMIT so the user is nudged toward fewer
 * marks before render perf starts to noticeably degrade — but never
 * blocks them (the backend's hard cap is 200, this is just a hint).
 */
const SOFT_LIMIT = 50
const HARD_LIMIT = 200

export function AnnotationCountBadge({ count }) {
  const over = count > SOFT_LIMIT
  return (
    <span
      title={
        over
          ? `${count}개 — ${SOFT_LIMIT}개를 넘으면 렌더링이 느려질 수 있습니다 (최대 ${HARD_LIMIT}개)`
          : `${count}개 / 최대 ${HARD_LIMIT}개`
      }
      className={
        over
          ? 'text-[10px] text-amber-600 font-semibold'
          : 'text-[10px] text-muted-foreground'
      }
    >
      {count}/{HARD_LIMIT}
      {over && ' ⚠'}
    </span>
  )
}
