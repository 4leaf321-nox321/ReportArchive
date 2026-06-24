import { apiClient, extractData } from '@/shared/api/client'

const BASE = '/api/reports'

export async function listReports({
  entityIds,
  // 관계(part_of) 롤업 — true 면 entityIds 필터를 자손까지 넓힌다
  // (모델 필터 → 그 부품 보고서까지 포함). 관계 없으면 효과 없음.
  entityRollup,
  folderId,
  includePublic,
  includeDescendants,
  // 이 호출에 한해 워크스페이스 컨텍스트를 덮어쓴다(부서 멘션 미리보기가
  // 현재 부서가 아닌 *멘션된* 부서의 보고서를 조회할 때). 비우면 전역 컨텍스트.
  workspaceSlug,
  // 휴지통 보기 — 개인 공간에서 소프트삭제된 보고서만.
  trashed,
} = {}) {
  // Build via URLSearchParams instead of axios's default params object:
  // axios 1.x serializes arrays as `entity_ids[]=1&entity_ids[]=2`, but
  // FastAPI's `Query(default=None)` over `list[int]` expects repeated
  // keys with no brackets (`entity_ids=1&entity_ids=2`). URLSearchParams'
  // append() produces exactly that form.
  const params = new URLSearchParams()
  if (Array.isArray(entityIds)) {
    for (const id of entityIds) params.append('entity_ids', String(id))
  }
  if (entityRollup && Array.isArray(entityIds) && entityIds.length) {
    params.append('entity_rollup', 'true')
  }
  if (folderId !== undefined && folderId !== null && folderId !== '') {
    // folderId can be an integer or the special "uncategorized" string —
    // backend handles the dispatch.
    params.append('folder_id', String(folderId))
  }
  // 조직 간 공개 탐색(opt-in) — org 컨텍스트에서만 의미. 기본 목록은 안 보냄.
  if (includePublic) params.append('include_public', 'true')
  // 하위 부서(자손) 게시판까지 포함 — 종합보고 안건 picker 등에서만 사용.
  if (includeDescendants) params.append('include_descendants', 'true')
  // 휴지통 보기(개인 공간 한정).
  if (trashed) params.append('trashed', 'true')
  const qs = params.toString()
  const cfg = workspaceSlug
    ? { headers: { 'X-Workspace-Slug': workspaceSlug } }
    : undefined
  const res = await apiClient.get(qs ? `${BASE}?${qs}` : BASE, cfg)
  return extractData(res)
}

export async function getReport(id) {
  const res = await apiClient.get(`${BASE}/${id}`)
  return extractData(res)
}

// 수정 이력 — 메타만(최신순, cursor=beforeId). 반환: [{id, seq, revision, author_user_id,
// author_name, source, created_at, body_bytes, label, is_pinned}]
export async function listReportVersions(id, { limit = 50, beforeId } = {}) {
  const params = new URLSearchParams({ limit: String(limit) })
  if (beforeId != null) params.set('before_id', String(beforeId))
  const res = await apiClient.get(`${BASE}/${id}/versions?${params.toString()}`)
  return extractData(res)
}

// 특정 버전 — 미리보기용 본문 포함. 반환: { version, body:{title,pages,content,...} }
export async function getReportVersion(id, versionId) {
  const res = await apiClient.get(`${BASE}/${id}/versions/${versionId}`)
  return extractData(res)
}

// 이 버전으로 비파괴 되돌리기. 반환: 갱신된 ReportRead.
export async function restoreReportVersion(id, versionId) {
  try {
    const res = await apiClient.post(`${BASE}/${id}/versions/${versionId}/restore`)
    return extractData(res)
  } catch (err) {
    _maybeThrowLockError(err)
    throw err
  }
}

// 본문 전문검색 — 제목 + 모든 위젯 텍스트(서버 search_text, 부분일치). 가시 범위
// 내에서만 결과가 온다. 반환: { results: [{report, snippet}], total, limit, offset }.
export async function searchReports(
  q,
  { limit = 30, offset = 0, location = 'all', board = '' } = {},
) {
  const params = new URLSearchParams({
    q: q ?? '',
    limit: String(limit),
    offset: String(offset),
    location,
    board: board ?? '',
  })
  const res = await apiClient.get(`${BASE}/search?${params.toString()}`)
  return extractData(res)
}

// 의미(시맨틱) 검색 — 임베딩(report_chunks) 기반. mode=hybrid(기본)는 벡터+키워드를
// RRF 로 융합, mode=semantic 은 벡터 유사도만. 운영 Ollama 가 없으면 하이브리드가
// 키워드로 자연 degrade 한다(임계값 게이트). 서버 응답은 flat({report_id,title,...})
// 이므로 키워드 검색과 동일한 { results:[{report, snippet}], total } 형태로 정규화해
// SearchPage 가 두 모드를 같은 렌더 경로로 다루게 한다. 페이지네이션 없음(total=길이).
export async function semanticSearchReports(q, { mode = 'hybrid', limit = 30 } = {}) {
  const params = new URLSearchParams({
    q: q ?? '',
    mode,
    limit: String(limit),
  })
  const res = await apiClient.get(`${BASE}/search/semantic?${params.toString()}`)
  const data = extractData(res)
  const results = (data.results ?? []).map((r) => ({
    report: {
      id: r.report_id,
      title: r.title,
      workspace_slug: r.workspace_slug,
    },
    snippet: r.snippet,
    // 왜 이 결과가 떴는지 표시용(하이브리드에서 의미/키워드 매칭 배지).
    score: r.rrf_score ?? r.score,
    inSemantic: r.in_semantic ?? true,
    inKeyword: r.in_keyword ?? false,
  }))
  return { results, total: results.length, mode: data.mode ?? mode }
}

/** Metadata-only folder placement — no lock required. Owner-only. */
export async function moveReportToFolder(id, folderId) {
  const res = await apiClient.put(`${BASE}/${id}/folder`, {
    folder_id: folderId,
  })
  return extractData(res)
}

/** Owner-only: phase → finalized. */
export async function publishReport(id) {
  const res = await apiClient.post(`${BASE}/${id}/publish`)
  return extractData(res)
}

/** Owner-only: finalized → drafting. */
export async function unpublishReport(id) {
  const res = await apiClient.post(`${BASE}/${id}/unpublish`)
  return extractData(res)
}

/** Toggle author hard lock. Owner only (system admin can force-unset). */
export async function setAuthorLock(id, { enabled, reason }) {
  const res = await apiClient.put(`${BASE}/${id}/author-lock`, {
    enabled,
    reason: reason ?? '',
  })
  return extractData(res)
}

export async function createReport(payload) {
  const res = await apiClient.post(BASE, payload)
  return extractData(res)
}

/** Duplicate an existing report into the caller's personal space.
 *  `mode`: 'content' (본문+표시설정만) | 'full' (메타·연결까지). The server
 *  decides exactly what travels — see backend ReportCopy / copy_report. */
export async function copyReport(sourceId, { title, folder_id = null, mode = 'full' }) {
  const res = await apiClient.post(`${BASE}/${sourceId}/copy`, {
    title,
    folder_id,
    mode,
  })
  return extractData(res)
}

export async function updateReport(id, payload) {
  try {
    const res = await apiClient.patch(`${BASE}/${id}`, payload)
    return extractData(res)
  } catch (err) {
    _maybeThrowLockError(err)
    throw err
  }
}

export async function deleteReport(id) {
  const res = await apiClient.delete(`${BASE}/${id}`)
  return extractData(res)
}

// 소프트삭제(휴지통으로) — 평소 "삭제"는 이걸 쓴다. 개인 목록에서 숨지만
// 게시된 부서 게시판엔 남고, restoreReport 로 복구 가능.
export async function trashReport(id) {
  const res = await apiClient.post(`${BASE}/${id}/trash`)
  return extractData(res)
}

export async function restoreReport(id) {
  const res = await apiClient.post(`${BASE}/${id}/restore`)
  return extractData(res)
}

// --------------------------------------------------------------------- //
// Edit-lock endpoints                                                   //
//                                                                       //
// The three calls below mirror POST/POST-heartbeat/DELETE on the same   //
// path. They re-throw the raw axios error after annotating it with the  //
// backend's `code` string so callers can dispatch on it (e.g.           //
// lock_held_by_other → takeover dialog, lock_not_held → exit edit mode, //
// revision_mismatch → reload prompt) without re-parsing the envelope.   //
// --------------------------------------------------------------------- //

export class LockConflictError extends Error {
  constructor({ code, message, holder }) {
    super(message || 'Lock conflict')
    this.name = 'LockConflictError'
    this.code = code || 'lock_error'
    this.holder = holder ?? null
  }
}

function _maybeThrowLockError(err) {
  // The standard error envelope is `{success:false, message, errors:[...]}`.
  // For 409s, errors[0] carries our structured lock payload.
  if (err?.response?.status !== 409) return
  const detail = err.response.data?.errors?.[0]
  if (!detail || typeof detail !== 'object' || !detail.code) return
  throw new LockConflictError(detail)
}

export async function acquireReportLock(id, { force = false } = {}) {
  try {
    const res = await apiClient.post(
      `${BASE}/${id}/lock`,
      null,
      { params: force ? { force: true } : undefined },
    )
    return extractData(res)
  } catch (err) {
    _maybeThrowLockError(err)
    throw err
  }
}

export async function heartbeatReportLock(id) {
  try {
    const res = await apiClient.post(`${BASE}/${id}/lock/heartbeat`)
    return extractData(res)
  } catch (err) {
    _maybeThrowLockError(err)
    throw err
  }
}

export async function releaseReportLock(id) {
  try {
    const res = await apiClient.delete(`${BASE}/${id}/lock`)
    return extractData(res)
  } catch (err) {
    // Release is best-effort — even a 4xx shouldn't propagate; the
    // server-side TTL will reclaim the lock anyway.
    return null
  }
}
