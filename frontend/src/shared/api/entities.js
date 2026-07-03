import { apiClient, extractData } from './client'

const TYPES_BASE = '/api/entity-types'
const BASE = '/api/entities'
const RELATION_TYPES_BASE = '/api/relation-types'

/**
 * 관계 종류 레지스트리(p55). 관계 추가 picker(타입 선택)·관리 UI가 읽는다.
 *   { items: [{ slug, label, inverse_label, directed, transitive, acyclic,
 *               src_axis_slugs, dst_axis_slugs, sort_order, description }] }
 */
export async function listRelationTypes() {
  const res = await apiClient.get(RELATION_TYPES_BASE)
  return extractData(res)
}

/** Admin-only — 새 관계 종류 등록. */
export async function createRelationType(payload) {
  const res = await apiClient.post(RELATION_TYPES_BASE, payload)
  return extractData(res)
}

/** Admin-only — 관계 종류 메타 수정(slug 불변). */
export async function updateRelationType(slug, payload) {
  const res = await apiClient.patch(`${RELATION_TYPES_BASE}/${slug}`, payload)
  return extractData(res)
}

/** Admin-only — 관계 종류 삭제(사용 중이면 거부). */
export async function deleteRelationType(slug) {
  const res = await apiClient.delete(`${RELATION_TYPES_BASE}/${slug}`)
  return extractData(res)
}

/**
 * List the axes (모델 / 부품 / BOM / 단계 / 불량 / 시험 / 시뮬레이션 등).
 * 시드된 7개 + admin 이 직접 추가한 것까지 포함. 세션 동안 큰 변동은
 * 없지만 admin 페이지에서 축을 추가하면 즉시 다시 받아야 한다.
 *
 *   { items: EntityTypeRead[] }
 */
export async function listEntityTypes() {
  const res = await apiClient.get(TYPES_BASE)
  return extractData(res)
}

/**
 * Admin-only — add a new axis. `sortOrder` 생략 시 백엔드가 max+1 로
 * 채워 새 축이 탭 strip 의 가장 오른쪽에 붙는다.
 */
export async function createEntityType({
  slug,
  label,
  icon = '',
  multi = true,
  sortOrder,
  description = '',
} = {}) {
  const body = { slug, label, icon, multi, description }
  if (sortOrder !== undefined) body.sort_order = sortOrder
  const res = await apiClient.post(TYPES_BASE, body)
  return extractData(res)
}

/**
 * Admin-only — 축의 입력 거버넌스 수정 (p53). entryPolicy: 'open'|'closed',
 * valuePattern: 정규식 문자열(빈 문자열/null 이면 제약 해제). 보낸 필드만 반영.
 */
export async function updateEntityType(
  id,
  { entryPolicy, valuePattern, temporalKind } = {},
) {
  const body = {}
  if (entryPolicy !== undefined) body.entry_policy = entryPolicy
  if (valuePattern !== undefined) body.value_pattern = valuePattern
  // 시간 차원 정책 (p56): evergreen|lifecycle|yearly|derived.
  if (temporalKind !== undefined) body.temporal_kind = temporalKind
  const res = await apiClient.patch(`${TYPES_BASE}/${id}`, body)
  return extractData(res)
}

/**
 * Admin-only — delete an axis. 백엔드가 값이 등록돼 있으면 400 으로 거절
 * 하므로 호출 전에 값 개수를 0 으로 만들어두어야 한다 (개별 값 삭제 또는
 * 다른 축으로 머지).
 */
export async function deleteEntityType(id) {
  const res = await apiClient.delete(`${TYPES_BASE}/${id}`)
  return extractData(res)
}

/** Admin-only — 엔티티의 별칭(다른 표기) 목록. `{ items: [{id, entity_id, alias, created_at}] }`. */
export async function listEntityAliases(entityId) {
  const res = await apiClient.get(`${BASE}/${entityId}/aliases`)
  return extractData(res)
}

/** Admin-only — 별칭 추가. 같은 축의 다른 값/별칭과 충돌하면 400. */
export async function addEntityAlias(entityId, alias) {
  const res = await apiClient.post(`${BASE}/${entityId}/aliases`, { alias })
  return extractData(res)
}

/** Admin-only — 별칭 삭제. 이후 그 표기는 자동 흡수되지 않는다. */
export async function deleteEntityAlias(entityId, aliasId) {
  const res = await apiClient.delete(`${BASE}/${entityId}/aliases/${aliasId}`)
  return extractData(res)
}

/**
 * Admin-only — 이 엔티티의 part_of 관계.
 *   `{ parents: [...], children: [...] }` (각 항목 { relation_id, relation, entity_id, value, type_id, type_slug, code })
 * parents = 이 값이 속한 상위들, children = 이 값에 묶인 하위들.
 */
export async function listEntityRelations(entityId) {
  const res = await apiClient.get(`${BASE}/${entityId}/relations`)
  return extractData(res)
}

/** Admin-only — 상위(part_of) 추가. entityId 가 자식, dstEntityId 가 부모. */
export async function addEntityRelation(entityId, dstEntityId, relation = 'part_of') {
  const res = await apiClient.post(`${BASE}/${entityId}/relations`, {
    dst_entity_id: dstEntityId,
    relation,
  })
  return extractData(res)
}

/** Admin-only — 관계 삭제(자식·부모 어느 쪽 화면에서든). */
export async function deleteEntityRelation(entityId, relationId) {
  const res = await apiClient.delete(`${BASE}/${entityId}/relations/${relationId}`)
  return extractData(res)
}

/**
 * 이 엔티티 주변 서브그래프(노드+엣지, D-2). 관계도 시각화용.
 *   { nodes: [{id, value, type_id, type_slug}], edges: [{src, dst, relation}] }
 * `relations`(배열) 로 따라갈 관계 종류 제한(미지정=전체), `depth` hop 수(기본 2).
 */
export async function getEntityGraph(entityId, { relations, depth = 2 } = {}) {
  const params = new URLSearchParams({ depth: String(depth) })
  if (Array.isArray(relations)) {
    for (const r of relations) params.append('relations', r)
  }
  const res = await apiClient.get(`${BASE}/${entityId}/graph?${params.toString()}`)
  return extractData(res)
}

/**
 * Picker list of entity values. Defaults to active-only; admin pages
 * pass `includeDeprecated=true` to see the full set.
 *
 *   { items: EntityRead[] }
 *
 * `typeId` filters to one axis (the picker's normal usage); omitting
 * it returns across all axes (mostly useful for global search later).
 */
export async function listEntities({
  typeId,
  q,
  includeDeprecated = false,
  limit = 200,
  withUsage = false,
  relatedTo,
  year,
} = {}) {
  // URLSearchParams 로 직접 조립 — related_to 는 반복 파라미터
  // (related_to=1&related_to=2) 라야 FastAPI list[int] 에 바인딩된다.
  // axios 기본 배열 직렬화(related_to[]=1)는 안 맞음.
  const params = new URLSearchParams()
  params.set('limit', String(limit))
  if (typeId != null) params.set('type_id', String(typeId))
  if (q && q.trim()) params.set('q', q.trim())
  if (includeDeprecated) params.set('include_deprecated', 'true')
  if (withUsage) params.set('with_usage', 'true')
  if (Array.isArray(relatedTo)) {
    for (const id of relatedTo) if (id != null) params.append('related_to', String(id))
  }
  // 연도 필터 (p56) — 축의 temporal_kind 에 따라 서버가 해석. 미지정=전체.
  if (year != null) params.set('year', String(year))
  const res = await apiClient.get(`${BASE}?${params.toString()}`)
  return extractData(res)
}

/**
 * Create a new entity value within an axis. Any authenticated user can
 * call this — the server collapses case-insensitive duplicates to the
 * existing canonical row, so the picker's "+ 새로 추가" can fire
 * optimistically without a pre-check.
 */
export async function createEntity({
  type_id,
  value,
  code,
  description = '',
  properties,
} = {}) {
  const body = { type_id, value, description }
  if (code !== undefined) body.code = code
  if (properties !== undefined) body.properties = properties
  const res = await apiClient.post(BASE, body)
  return extractData(res)
}

/** Admin-only: rename / restamp / deprecate / restore + lifecycle 유효구간(p56).
 * validFromYear/validToYear 에 null 을 명시하면 해제(개방), undefined 면 미변경.
 * properties 를 보내면 축 스키마로 검증 후 통째로 교체(A0). */
export async function updateEntity(
  id,
  { value, code, description, status, validFromYear, validToYear, properties } = {},
) {
  const body = {}
  if (value !== undefined) body.value = value
  if (code !== undefined) body.code = code
  if (description !== undefined) body.description = description
  if (status !== undefined) body.status = status
  if (validFromYear !== undefined) body.valid_from_year = validFromYear
  if (validToYear !== undefined) body.valid_to_year = validToYear
  if (properties !== undefined) body.properties = properties
  const res = await apiClient.patch(`${BASE}/${id}`, body)
  return extractData(res)
}

// ─── 속성 정의 (property_defs) — 축의 객체 속성 스키마 (온톨로지 강화 A0) ──── #

/** 축의 속성 정의 목록(인증만). 프론트가 동적 속성 폼을 렌더하는 데 쓴다. */
export async function listTypeProperties(typeId) {
  const res = await apiClient.get(`${TYPES_BASE}/${typeId}/properties`)
  return extractData(res)
}

/** Admin-only: 축에 속성 정의 추가. */
export async function createTypeProperty(typeId, payload) {
  const res = await apiClient.post(`${TYPES_BASE}/${typeId}/properties`, payload)
  return extractData(res)
}

/** Admin-only: 속성 정의 수정(보낸 필드만). */
export async function updateTypeProperty(typeId, defId, payload) {
  const res = await apiClient.patch(
    `${TYPES_BASE}/${typeId}/properties/${defId}`,
    payload,
  )
  return extractData(res)
}

/** Admin-only: 속성 정의 삭제. */
export async function deleteTypeProperty(typeId, defId) {
  const res = await apiClient.delete(`${TYPES_BASE}/${typeId}/properties/${defId}`)
  return extractData(res)
}

/**
 * yearly 축(모델 등) 값에 배정된 연도 세트 (p56). `{ years: [int] }`(오름차순).
 * 인증만 필요(읽기).
 */
export async function getEntityYears(id) {
  const res = await apiClient.get(`${BASE}/${id}/years`)
  return extractData(res)
}

/** Admin-only — 연도 세트 전체 교체(replace). 빈 배열이면 전부 해제. */
export async function setEntityYears(id, years) {
  const res = await apiClient.put(`${BASE}/${id}/years`, { years })
  return extractData(res)
}

/** Admin-only: re-link every report tagged with `id` to `intoId`, then drop the source. */
export async function mergeEntity(id, intoId) {
  const res = await apiClient.post(`${BASE}/${id}/merge`, { into_id: intoId })
  return extractData(res)
}

/**
 * Admin-only — 축의 중복/동의어 후보 클러스터 스캔(엔티티머지보조_설계.md).
 * 온디맨드(저장 안 함). 반환: { clusters, scanned, truncated, backend, threshold }.
 */
export async function scanMergeCandidates(typeId) {
  const res = await apiClient.post(`${TYPES_BASE}/${typeId}/merge-candidates`)
  return extractData(res)
}

/**
 * Admin-only — 한 클러스터를 LLM 검증자에게 보내 판정(Phase 2). 반환:
 * { backend, duplicate_ids, canonical_id, outlier_ids, reason }. mock 이면 verdict 없음.
 */
export async function validateMergeCluster(typeId, entityIds) {
  const res = await apiClient.post(
    `${TYPES_BASE}/${typeId}/merge-validate`,
    { entity_ids: entityIds },
    { timeout: 600000 }, // LLM 생성 — 길게(CPU/재시도 대비).
  )
  return extractData(res)
}

/** Admin-only — 후보 쌍을 "중복 아님"으로 기각(다음 스캔부터 제외). */
export async function dismissMergePair(typeId, entityIdA, entityIdB) {
  const res = await apiClient.post(`${TYPES_BASE}/${typeId}/merge-dismiss`, {
    entity_id_a: entityIdA,
    entity_id_b: entityIdB,
  })
  return extractData(res)
}

/**
 * Admin-only — slim list of reports currently tagged with this entity.
 * Workspace-agnostic by design so the admin dialogs always show every
 * blocker, regardless of the admin's active workspace. Used by:
 *   - the row's "사용 N건" cell popover
 *   - the delete dialog (to list blockers + disable when N > 0)
 *   - the merge dialog (to preview which reports will be re-linked)
 *
 *   { items: [{ id, title, workspace_slug, updated_at }] }
 */
export async function listEntityUsage(id) {
  const res = await apiClient.get(`${BASE}/${id}/usage`)
  return extractData(res)
}

/**
 * Admin-only — drop the link between this entity and one specific
 * report. The entity row itself stays. Idempotent: removing a link
 * that doesn't exist returns success.
 */
export async function unlinkEntityFromReport(entityId, reportId) {
  const res = await apiClient.delete(`${BASE}/${entityId}/usage/${reportId}`)
  return extractData(res)
}

/**
 * Admin-only — drop every link this entity has across all reports.
 * After this the entity has 0 usage and can be hard-deleted; the
 * entity itself stays unless the admin explicitly deletes it next.
 */
export async function unlinkEntityFromAllReports(entityId) {
  const res = await apiClient.delete(`${BASE}/${entityId}/usage`)
  return extractData(res)
}

/** Admin-only hard delete. Server returns 400 when the entity is still in use. */
export async function deleteEntity(id) {
  const res = await apiClient.delete(`${BASE}/${id}`)
  return extractData(res)
}
