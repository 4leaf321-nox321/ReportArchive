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

function loadToken() {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY) || null
  } catch {
    return null
  }
}

function persistToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token)
    else localStorage.removeItem(TOKEN_STORAGE_KEY)
  } catch {
    /* ignore */
  }
}

export function setAccessToken(token) {
  accessToken = token
  persistToken(token)
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
  if (currentWorkspaceSlug) {
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
