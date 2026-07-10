import * as React from 'react'
import { useAuth } from '@/shared/auth/AuthContext'

/**
 * 조직 스코프 즐겨찾기 — 자주 고르는 조직(부서) slug 를 계정별로 서버에 저장한다
 * (me.preferences.orgScope.pinned). 기기/브라우저가 바뀌어도 따라온다.
 * ScopeCategorySidebar 의 조직 드릴다운 위에 "즐겨찾기"로 노출돼, 깊은 트리를
 * 매번 파고들지 않고 자주 쓰는 부서로 바로 점프하게 해준다.
 *
 * useWorkspacePrefs 의 pinned 패턴과 동일: updatePreferences 가 로컬 me 를
 * 낙관적으로 갱신 + 서버 PATCH(깊은 병합). 배열은 통째로 교체된다.
 */
export function useOrgScopeFavorites() {
  const { me, updatePreferences } = useAuth()
  const server = me?.preferences?.orgScope?.pinned
  const favorites = React.useMemo(
    () => (Array.isArray(server) ? server : []),
    [server],
  )
  // 동기적으로 연속 호출되는 토글이 최신 목록을 보도록 ref 로 미러링 —
  // 두 개를 빠르게 토글할 때 한쪽이 다른 쪽의 낙관적 갱신을 덮어쓰는 레이스 방지.
  const ref = React.useRef(favorites)
  ref.current = favorites

  const toggleFavorite = React.useCallback(
    (slug) => {
      if (!slug) return
      const cur = ref.current
      const next = cur.includes(slug)
        ? cur.filter((s) => s !== slug)
        : [...cur, slug]
      ref.current = next
      updatePreferences?.({ orgScope: { pinned: next } })
    },
    [updatePreferences],
  )

  const isFavorite = React.useCallback(
    (slug) => favorites.includes(slug),
    [favorites],
  )

  return { favorites, toggleFavorite, isFavorite }
}
