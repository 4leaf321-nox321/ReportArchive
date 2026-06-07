/** 공유 대상 요약 뱃지 — 게시판/폴더 공유 옆에 붙여 "어디에 공유됐나"를 한눈에.
 *
 *  grants: [{ principal_type, principal_label, level }] (백엔드 GrantRead 형태).
 *  - 칩에 공유 개수, all_org 가 있으면 지구본을 표시.
 *  - 호버(title)하면 대상별 줄로 "대상 — 열람/편집" 을 보여준다(멀티라인 — 사이드바
 *    스크롤 컨테이너에서 잘리지 않게 네이티브 title 사용).
 *  공유가 없으면 아무것도 렌더하지 않는다.
 */
import { Globe, Share2 } from 'lucide-react'

function levelLabel(level) {
  return level === 'edit' ? '편집' : '열람'
}

export function ShareBadge({ grants }) {
  const list = grants || []
  if (list.length === 0) return null
  const hasPublic = list.some((g) => g.principal_type === 'all_org')
  const summary = list
    .map((g) => `· ${g.principal_label ?? g.principal_ref} — ${levelLabel(g.level)}`)
    .join('\n')
  return (
    <span
      className="inline-flex items-center gap-0.5 rounded-full bg-sky-100 px-1.5 py-px text-[10px] font-medium text-sky-700 dark:bg-sky-950/50 dark:text-sky-300 shrink-0"
      title={`공유 대상 (${list.length})\n${summary}`}
    >
      {hasPublic ? (
        <Globe className="h-2.5 w-2.5" />
      ) : (
        <Share2 className="h-2.5 w-2.5" />
      )}
      {list.length}
    </span>
  )
}
