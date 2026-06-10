import { useAuth } from '@/shared/auth/AuthContext'

const PREF_KEY = 'widget_caption_skip_autofill'

/**
 * 위젯 "제목 생략"(content.caption_skip_autofill)의 새-위젯 기본값을 사용자별 ·
 * 위젯 type별로 기억한다. user preference(서버 저장)에 보관해 기기가 바뀌어도
 * 따라온다.
 *
 *   - getSkip(type)        : 그 type 의 기억된 기본값(없으면 false)
 *   - rememberSkip(type, v): 사용자가 토글을 바꿀 때 그 값을 기본값으로 저장
 *                            (낙관적 — 로컬 즉시 반영 + 백그라운드 PATCH)
 *
 * 새 위젯 생성 지점에서 getSkip 으로 초기값을 넣고, 토글이 바뀌는 지점에서
 * rememberSkip 으로 갱신한다. heading 처럼 caption 이 없는 위젯은 호출되지 않음.
 */
export function useCaptionSkipPref() {
  const { me, updatePreferences } = useAuth()
  const map = me?.preferences?.[PREF_KEY] ?? {}

  function getSkip(type) {
    return map[type] === true
  }
  function rememberSkip(type, value) {
    if (!type) return
    // 이미 같은 값이면 불필요한 PATCH 생략.
    if ((map[type] === true) === !!value) return
    updatePreferences?.({ [PREF_KEY]: { [type]: !!value } })
  }

  return { getSkip, rememberSkip }
}
