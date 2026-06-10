import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import {
  getAccessToken,
  setAccessToken,
  setOnUnauthorized,
} from '@/shared/api/client'
import { login as loginApi, signup as signupApi } from '@/shared/api/auth'
import { fetchMe, updateMyPreferences } from '@/shared/api/me'

/** 중첩 dict 는 재귀 병합, 그 외는 교체 — 백엔드 _deep_merge_prefs 와 동형.
 *  preferences 부분 패치를 로컬 me 에 낙관적으로 반영할 때 쓴다. */
function deepMergePrefs(base, patch) {
  const out = { ...(base ?? {}) }
  for (const [key, val] of Object.entries(patch ?? {})) {
    out[key] =
      val && typeof val === 'object' && !Array.isArray(val) &&
      out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])
        ? deepMergePrefs(out[key], val)
        : val
  }
  return out
}

const AuthContext = React.createContext(null)

/**
 * Auth provider — owns the access token + the resolved /api/me payload.
 *
 * Lifecycle:
 *   - Token is loaded from localStorage at module load (in client.js).
 *   - On mount: if a token exists, fetch /api/me to populate `me`.
 *     A failed fetch (401) clears the token and routes to /login.
 *   - login(email, password) issues credentials, stores token, refreshes me.
 *   - logout() clears token + routes to /login.
 *
 * `loading` is true during the initial /api/me bootstrap so the app can show
 * a splash instead of flashing the login page when a valid token is in storage.
 */
export function AuthProvider({ children }) {
  const navigate = useNavigate()
  const [me, setMe] = React.useState(null)
  const [error, setError] = React.useState(null)
  // If a token exists at boot, we're "loading until /api/me resolves".
  // Otherwise we skip straight to unauthenticated state.
  const [loading, setLoading] = React.useState(() => Boolean(getAccessToken()))

  const logout = React.useCallback(
    (redirect = true) => {
      setAccessToken(null)
      setMe(null)
      setError(null)
      if (redirect) navigate('/login', { replace: true })
    },
    [navigate]
  )

  // Wire up the global 401 handler so any expired-token response triggers logout.
  React.useEffect(() => {
    setOnUnauthorized(() => logout(true))
    return () => setOnUnauthorized(null)
  }, [logout])

  const refresh = React.useCallback(async () => {
    if (!getAccessToken()) {
      setMe(null)
      setLoading(false)
      return
    }
    try {
      const data = await fetchMe()
      setMe(data)
      setError(null)
    } catch (err) {
      setError(err)
      // 401 already triggers logout via the response interceptor.
      if (err?.response?.status !== 401) {
        setMe(null)
      }
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    refresh()
  }, [refresh])

  /** 현재 사용자 환경설정 부분 패치 — 로컬 me.preferences 를 낙관적으로 깊은
   *  병합한 뒤 서버에 PATCH. 설정값은 비핵심이라 실패해도 조용히 넘어간다
   *  (다음 새로고침에 서버값으로 재동기화). */
  const updatePreferences = React.useCallback((patch) => {
    setMe((prev) =>
      prev
        ? { ...prev, preferences: deepMergePrefs(prev.preferences, patch) }
        : prev,
    )
    return updateMyPreferences(patch).catch(() => {})
  }, [])

  const login = React.useCallback(
    async ({ email, password }) => {
      const data = await loginApi({ email, password })
      setAccessToken(data.access_token)
      await refresh()
      return data
    },
    [refresh]
  )

  const signup = React.useCallback(
    async ({ email, name, password, workspaceSlug }) => {
      // Signup auto-issues an access token (the server creates the user +
      // returns LoginResponse). Treat the rest like a login.
      const data = await signupApi({ email, name, password, workspaceSlug })
      setAccessToken(data.access_token)
      await refresh()
      return data
    },
    [refresh]
  )

  const value = React.useMemo(
    () => ({
      me,
      loading,
      error,
      isAuthenticated: Boolean(me),
      login,
      signup,
      logout,
      refresh,
      updatePreferences,
    }),
    [me, loading, error, login, signup, logout, refresh, updatePreferences]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = React.useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
