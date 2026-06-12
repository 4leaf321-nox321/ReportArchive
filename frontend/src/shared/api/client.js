/**
 * Single axios instance used by every module.
 *
 * Auth flow:
 *   - On login, call setAccessToken(token); subsequent requests carry
 *     `Authorization: Bearer <token>`.
 *   - On 401, the response interceptor calls the registered onUnauthorized
 *     callback (typically: clear token, redirect to /login).
 *
 * Workspace context flows via X-Workspace-Slug — set by setCurrentWorkspace().
 */
import axios from 'axios'

const baseURL = import.meta.env.VITE_API_BASE_URL || ''
const TOKEN_STORAGE_KEY = 'ra:access_token:v1'

export const apiClient = axios.create({
  baseURL,
  timeout: 60000,
  headers: { 'Content-Type': 'application/json' },
})

// In-memory session context.
let accessToken = loadToken()
let currentWorkspaceSlug = null
let onUnauthorized = null

// 토큰은 두 저장소 중 하나에 둔다:
//   - localStorage  : '로그인 유지' ON  — 브라우저를 닫아도 유지(영구)
//   - sessionStorage: '로그인 유지' OFF — 탭/브라우저를 닫으면 사라짐
// 부팅 시엔 둘 다 확인(localStorage 우선)하고, 저장 시엔 고른 쪽에만 두고
// 반대쪽은 비워 토큰이 두 곳에 동시에 남지 않게 한다.
function loadToken() {
  try {
    return (
      localStorage.getItem(TOKEN_STORAGE_KEY) ||
      sessionStorage.getItem(TOKEN_STORAGE_KEY) ||
      null
    )
  } catch {
    return null
  }
}

function clearToken() {
  try {
    localStorage.removeItem(TOKEN_STORAGE_KEY)
    sessionStorage.removeItem(TOKEN_STORAGE_KEY)
  } catch {
    /* ignore */
  }
}

/**
 * @param {string|null} token  null 이면 로그아웃(양쪽 저장소 모두 제거).
 * @param {boolean} persist    true=localStorage(영구), false=sessionStorage(세션).
 *                             생략 시 영구(기존 동작 유지).
 */
export function setAccessToken(token, persist = true) {
  accessToken = token
  if (!token) {
    clearToken()
    return
  }
  try {
    const keep = persist ? localStorage : sessionStorage
    const drop = persist ? sessionStorage : localStorage
    drop.removeItem(TOKEN_STORAGE_KEY)
    keep.setItem(TOKEN_STORAGE_KEY, token)
  } catch {
    /* ignore */
  }
}

export function getAccessToken() {
  return accessToken
}

export function setCurrentWorkspace(slug) {
  currentWorkspaceSlug = slug
}

export function setOnUnauthorized(handler) {
  onUnauthorized = handler
}

apiClient.interceptors.request.use((config) => {
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`
  }
  // 호출 측이 X-Workspace-Slug 를 명시했으면 존중한다(예: 부서 멘션
  // 미리보기가 *다른* 부서 보고서를 일시 조회). 전역 컨텍스트는 폴백.
  if (currentWorkspaceSlug && !config.headers['X-Workspace-Slug']) {
    config.headers['X-Workspace-Slug'] = currentWorkspaceSlug
  }
  return config
})

apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    const payload = error?.response?.data
    if (payload && typeof payload === 'object' && payload.message) {
      error.message = payload.message
    }
    if (error?.response?.status === 401 && onUnauthorized) {
      // Don't trigger redirect for the login endpoint itself — that's a
      // legitimate "wrong credentials" error, not an expired session.
      const url = error.config?.url || ''
      if (!url.includes('/api/auth/login')) {
        onUnauthorized()
      }
    }
    return Promise.reject(error)
  }
)

export function extractData(response) {
  const body = response?.data
  if (body && typeof body === 'object' && 'data' in body) {
    return body.data
  }
  return body
}
