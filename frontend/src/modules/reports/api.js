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

// 자동태깅 — 저장된 본문에서 엔티티(축) 태그 후보를 추천. **아무것도 저장하지
// 않는다** — 제안 칩 데이터일 뿐(사용자가 수락 → entity_ids 로 PATCH 해야 태깅).
// 반환: { items: [{id, type_id, type_slug, value, code, status, source, score}], truncated }
export async function suggestReportEntities(id) {
  const res = await apiClient.post(`${BASE}/${id}/suggest-entities`)
  return extractData(res)
}

// 가산(union) 태그 적용 — 기존 태그를 두고 entity_ids 만 더한다(제거 안 함).
// 일괄 AI 태그 적용(여러 보고서 검토→수락)용. 반환: { report_id, entity_ids, added }
export async function addReportEntities(id, entityIds) {
  const res = await apiClient.post(`${BASE}/${id}/entities/add`, {
    entity_ids: entityIds,
  })
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
  {
    limit = 30,
    offset = 0,
    location = 'all',
    board = '',
    // 엔티티 태그 필터(D-2) — 축별 AND / 축내 OR. entityRollup 이면 part_of 자손까지.
    entityIds,
    entityRollup,
    // 자료 연도 — 보고서 작성연도(report_date) 필터(p56). 엔티티 적용연도와 독립.
    year,
  } = {},
) {
  // entity_ids 는 반복 키(FastAPI list[int]) — URLSearchParams.append 로.
  const params = new URLSearchParams({
    q: q ?? '',
    limit: String(limit),
    offset: String(offset),
    location,
    board: board ?? '',
  })
  if (Array.isArray(entityIds)) {
    for (const id of entityIds) params.append('entity_ids', String(id))
  }
  if (entityRollup && Array.isArray(entityIds) && entityIds.length) {
    params.append('entity_rollup', 'true')
  }
  if (year != null) params.set('year', String(year))
  const res = await apiClient.get(`${BASE}/search?${params.toString()}`)
  return extractData(res)
}

// 의미(시맨틱) 검색 — 임베딩(report_chunks) 기반. mode=hybrid(기본)는 벡터+키워드를
// RRF 로 융합, mode=semantic 은 벡터 유사도만. 운영 Ollama 가 없으면 하이브리드가
// 키워드로 자연 degrade 한다(임계값 게이트). 서버 응답은 flat({report_id,title,...})
// 이므로 키워드 검색과 동일한 { results:[{report, snippet}], total } 형태로 정규화해
// SearchPage 가 두 모드를 같은 렌더 경로로 다루게 한다. 페이지네이션 없음(total=길이).
export async function semanticSearchReports(
  q,
  { mode = 'hybrid', limit = 30, entityIds, entityRollup, year } = {},
) {
  const params = new URLSearchParams({
    q: q ?? '',
    mode,
    limit: String(limit),
  })
  if (Array.isArray(entityIds)) {
    for (const id of entityIds) params.append('entity_ids', String(id))
  }
  if (entityRollup && Array.isArray(entityIds) && entityIds.length) {
    params.append('entity_rollup', 'true')
  }
  if (year != null) params.set('year', String(year))
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

/**
 * 보고서 B300 자동 요약 + 추천 태그/분류(B). 요약 없으면 data=null. 열람 권한
 * 그대로(못 보는 보고서면 403). { summary, tags[], suggested_category, model, updated_at }
 */
export async function getReportAiSummary(id) {
  const res = await apiClient.get(`${BASE}/${id}/ai-summary`)
  return extractData(res)
}

/**
 * 선택한 보고서들의 AI 요약을 일괄 생성/갱신(force, B). 목록 다중선택 + 단건
 * "다시 생성"이 공유. 요청자가 auto_summary 권한자 + 그 문서 편집 가능해야 적재됨.
 *   { enqueued, skipped, already }
 */
export async function bulkAiSummary(reportIds) {
  const res = await apiClient.post(`${BASE}/ai-summary/bulk`, {
    report_ids: reportIds,
  })
  return extractData(res)
}

/**
 * AI 추천(요약·태그·분류)을 검토·수정 후 적용(B 후속). 편집 가능자만(서버 can_edit).
 * 보낸 필드만 반영 — summary=ReportAiSummary 갱신, tags=report.tags 합산,
 * setReportType=true 면 reportTypeId 로 보고서 종류 설정.
 */
export async function applyAiSummary(
  id,
  { summary, tags, reportTypeId, setReportType = false } = {},
) {
  const res = await apiClient.post(`${BASE}/${id}/ai-summary/apply`, {
    summary,
    tags,
    report_type_id: reportTypeId ?? null,
    set_report_type: setReportType,
  })
  return extractData(res)
}

/**
 * 연결된 local LLM(B300)으로 보고서 내용 생성(report_authoring 권한 필요).
 * instructions=작성할 내용 지시. 본인 작성 중(drafting) 보고서에 적용. 성공 시
 * 보고서가 갱신되므로 호출부가 reload 해야 한다.
 */
export async function llmAuthorReport(
  id,
  { instructions, page = 1, signal } = {},
) {
  // LLM 생성은 느리다(특히 CPU 백엔드 + 형식 실패 시 자동 재시도 — 백엔드
  // llm_timeout_s × llm_author_max_attempts 까지). 공유 클라이언트 기본 60초로는
  // 끊기므로 이 호출만 길게(10분) 잡는다.
  // signal: AbortController.signal — 사용자가 "중단"하면 요청을 끊고, 서버도
  // 연결 끊김을 감지해 LLM 생성을 멈춘다.
  const res = await apiClient.post(
    `${BASE}/${id}/llm-author`,
    { instructions, page },
    { timeout: 600000, signal },
  )
  return extractData(res)
}

/**
 * 검색 '질문하기'·'에이전트' 답변을 구조화 보고서 초안으로 저장(report_authoring
 * 권한 필요). 서버가 2차 LLM 패스로 위젯(본문·표·차트)을 만들어 작성자 개인 공간에
 * drafting 초안을 생성한다. 반환: { report, warnings, url }. signal 로 중단.
 */
export async function createReportFromAnswer({
  question = '',
  answer,
  citations = [],
  objects = [],
  includeSources = true,
  signal,
} = {}) {
  // llm-author 와 동일하게 LLM 호출이 느려 이 호출만 길게(10분) 잡는다.
  const res = await apiClient.post(
    `${BASE}/from-answer`,
    { question, answer, citations, objects, include_sources: includeSources },
    { timeout: 600000, signal },
  )
  return extractData(res)
}

/**
 * 연결된 local LLM 으로 현재 문서의 위젯 '단락 구분'(section)을 자동 지정
 * (report_authoring 권한 필요). overwrite=true 면 기존 수동 지정도 재지정,
 * false 면 빈 위젯만. 본인 작성 중(drafting) 보고서에 적용 → 성공 시 reload.
 * 반환: { assigned, total, warnings }.
 */
export async function llmAssignSections(
  id,
  { overwrite = false, instructions = '', signal } = {},
) {
  // 작성과 동일하게 LLM 호출이 느려 이 호출만 길게(10분) 잡는다. signal 로 중단.
  const res = await apiClient.post(
    `${BASE}/${id}/llm-sections`,
    { overwrite, instructions },
    { timeout: 600000, signal },
  )
  return extractData(res)
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

// 제목만 바꾸는 가벼운 갱신 — 목록에서 상세 진입 없이 즉시 변경(inline rename).
// 편집 잠금을 잡지 않으므로 updateReport 와 달리 lock 에러 매핑이 없다.
// 서버가 can_edit + 발행 전(finalized 제외)을 재확인한다. 반환: {id, title}.
export async function renameReport(id, title) {
  const res = await apiClient.patch(`${BASE}/${id}/rename`, { title })
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
