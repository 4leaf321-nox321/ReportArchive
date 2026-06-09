import { useLocation, useNavigate } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'

/**
 * 본문 @멘션(보고서·부서)으로 다른 화면에 이동해 왔을 때, 읽던 화면으로
 * 한 번에 돌아가는 떠있는 알약. 멘션 클릭이 `navigate(to, { state:
 * { fromMention } })` 로 메타를 실어 보내고(RichText.handleMentionClick),
 * 도착 라우트에서 그 state 가 있을 때만 표시된다.
 *
 * AppShell(모든 `/w/...` 라우트 공통 레이아웃)에 한 번 렌더하므로 보고서
 * 상세·부서 보고서 목록 등 어떤 도착지든 동일하게 동작한다.
 *
 * 복귀는 navigate(-1) — 히스토리를 되감아 브라우저의 스크롤 복원까지
 * 활용한다. 멘션 클릭은 항상 push 이므로 직전 항목이 곧 출발 화면이고,
 * 알약은 도착 화면(state 보유)에서만 보이므로 -1 이 항상 출발지를 가리킨다.
 */
export function MentionReturnBar() {
  const location = useLocation()
  const navigate = useNavigate()
  const ret = location.state?.fromMention
  if (!ret) return null
  return (
    <button
      type="button"
      onClick={() => navigate(-1)}
      className="fixed top-[4.5rem] left-1/2 z-[55] -translate-x-1/2 inline-flex items-center gap-1.5 rounded-full border bg-popover px-4 py-2 text-xs font-medium shadow-lg hover:bg-muted print:hidden"
      title="멘션을 클릭하기 전 화면으로 돌아가기"
    >
      <ArrowLeft className="h-3.5 w-3.5" />
      {ret.fromTitle ? `«${ret.fromTitle}»(으)로 돌아가기` : '이전 화면으로 돌아가기'}
    </button>
  )
}
