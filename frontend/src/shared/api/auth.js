import { apiClient, extractData } from './client'

export async function login({ email, password }) {
  const res = await apiClient.post('/api/auth/login', { email, password })
  return extractData(res)
}

export async function signup({ email, name, password, workspaceSlug }) {
  const res = await apiClient.post('/api/auth/signup', {
    email,
    name,
    password,
    workspace_slug: workspaceSlug,
  })
  return extractData(res)
}

export async function listPublicWorkspaces() {
  const res = await apiClient.get('/api/auth/workspaces')
  return extractData(res)
}

export async function register({ email, name, password, workspaceSlug } = {}) {
  const body = { email, name, password }
  if (workspaceSlug) body.workspace_slug = workspaceSlug
  const res = await apiClient.post('/api/auth/register', body)
  return extractData(res)
}
