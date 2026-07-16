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

// ─── 관계 종류(링크)의 속성 정의 (A0.2) ─────────────────────────────────── #
// 엔티티 축의 /properties 와 대칭. owner_kind='relation_type', slug 로 조회.
// 여기 정의한 스키마로 그 종류 링크의 properties 가 검증된다.

/** 관계 종류의 링크 속성 정의 목록(인증만) — 링크 속성 폼 렌더용. */
export async function listRelationTypeProperties(slug) {
  const res = await apiClient.get(`${RELATION_TYPES_BASE}/${slug}/properties`)
  return extractData(res)
}

/** Admin-only — 관계 종류에 링크 속성 정의 추가. */
export async function createRelationTypeProperty(slug, payload) {
  const res = await apiClient.post(
    `${RELATION_TYPES_BASE}/${slug}/properties`,
    payload,
  )
  return extractData(res)
}

/** Admin-only — 링크 속성 정의 수정(보낸 필드만). */
export async function updateRelationTypeProperty(slug, defId, payload) {
  const res = await apiClient.patch(
    `${RELATION_TYPES_BASE}/${slug}/properties/${defId}`,
    payload,
  )
  return extractData(res)
}

/** Admin-only — 링크 속성 정의 삭제(기존 링크 값은 보존). */
export async function deleteRelationTypeProperty(slug, defId) {
  const res = await apiClient.delete(
    `${RELATION_TYPES_BASE}/${slug}/properties/${defId}`,
  )
  return extractData(res)
}

/**
 * List the axes (모델 / 부품 / BOM / 단계 / 불량 / 시험 / 시뮬레이션 등).
 * 시드된 7개 + admin 이 직접 추가한 것까지 포함. 세션 동안 큰 변동은
 * 없지만 admin 페이지에서 축을 추가하면 즉시 다시 받아야 한다.
 *
 *   { items: EntityTypeRead[] }
 */
/**
 * 축 목록. 기본은 **system 축(부서 등, A0.3) 제외** — 그것들은 값을 담지 않는
 * 투영 표식이라 태깅 picker·값 관리·탐색에 나오면 안 된다. cross-kind 링크 대상
 * 판단이 필요한 곳(관계 다이얼로그)만 `includeSystem: true` 로 전체를 받는다.
 */
export async function listEntityTypes({ includeSystem = false } = {}) {
  const res = await apiClient.get(TYPES_BASE)
  const data = extractData(res)
  if (includeSystem) return data
  return {
    ...data,
    items: (data?.items ?? []).filter((t) => t.kind_class !== 'system'),
  }
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
  {
    label,
    icon,
    description,
    sortOrder,
    entryPolicy,
    valuePattern,
    temporalKind,
    kindClass,
  } = {},
) {
  const body = {}
  if (label !== undefined) body.label = label
  if (icon !== undefined) body.icon = icon
  if (description !== undefined) body.description = description
  if (sortOrder !== undefined) body.sort_order = sortOrder
  if (entryPolicy !== undefined) body.entry_policy = entryPolicy
  if (valuePattern !== undefined) body.value_pattern = valuePattern
  // 시간 차원 정책 (p56): evergreen|lifecycle|yearly|derived.
  if (temporalKind !== undefined) body.temporal_kind = temporalKind
  // 객체 분류 (A0.3): reference|record|system.
  if (kindClass !== undefined) body.kind_class = kindClass
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

/**
 * Admin-only — 관계 추가. entityId 가 src, dstEntityId 가 dst.
 * A0.2: 링크 속성(`properties`)·근거(`evidenceReportId`/`evidenceNote`)를
 * 함께 실을 수 있다(미지정=각각 {} / NULL).
 */
export async function addEntityRelation(
  entityId,
  dstEntityId,
  relation = 'part_of',
  { properties, evidenceReportId, evidenceNote } = {},
) {
  const body = { dst_entity_id: dstEntityId, relation }
  if (properties !== undefined) body.properties = properties
  if (evidenceReportId !== undefined) body.evidence_report_id = evidenceReportId
  if (evidenceNote !== undefined) body.evidence_note = evidenceNote
  const res = await apiClient.post(`${BASE}/${entityId}/relations`, body)
  return extractData(res)
}

/**
 * Admin-only — 링크 속성/근거 수정 (A0.2). `patch` 에 담긴 키만 반영:
 *   { properties?, evidence_report_id?, evidence_note? }
 * properties 를 보내면 관계 종류 스키마로 검증 후 통째로 교체. evidence_report_id
 * 를 명시적 null 로 보내면 근거 해제.
 */
export async function updateEntityRelation(entityId, relationId, patch) {
  const res = await apiClient.patch(
    `${BASE}/${entityId}/relations/${relationId}`,
    patch,
  )
  return extractData(res)
}

/** Admin-only — 관계 삭제(자식·부모 어느 쪽 화면에서든). */
export async function deleteEntityRelation(entityId, relationId) {
  const res = await apiClient.delete(`${BASE}/${entityId}/relations/${relationId}`)
  return extractData(res)
}

/**
 * 객체 중심 검색 (Phase C) — 타입 + 이름 + 속성(JSONB) + 관계 필터로 객체를 찾는다.
 *   filters: { type_id, q, props:[{key,op,value}], relations:[{relation,dst_id}],
 *             year, include_deprecated, sort, limit, offset }
 *   → { items: EntityRead[], total }
 */
export async function searchEntities(filters = {}) {
  const res = await apiClient.post(`${BASE}/search`, filters)
  return extractData(res)
}

/** 벌크 임포트 — 업로드 시트의 헤더+샘플(열 매핑 UI용). 관리자 전용.
 *  → { columns:[str], sample:[{header:value}], row_count } */
export async function inspectEntityImport(file) {
  const form = new FormData()
  form.append('file', file)
  const res = await apiClient.post(`${BASE}/import/inspect`, form)
  return extractData(res)
}

/** 벌크 임포트 실행 — 시트 + 매핑(JSON). mapping.dry_run=true 면 미리보기(쓰기 없음).
 *  → { summary:{total,create,update,error,linked,link_unresolved,committed},
 *      rows:[{row,value,status,messages,relations}] } */
export async function runEntityImport(file, mapping) {
  const form = new FormData()
  form.append('file', file)
  form.append('mapping', JSON.stringify(mapping))
  const res = await apiClient.post(`${BASE}/import`, form)
  return extractData(res)
}

/** 붙여넣기(표) 임포트 — 파일 없이 columns(합성 헤더)/rows + 매핑. 응답은
 *  runEntityImport 와 동일. mapping.dry_run 으로 미리보기/커밋. */
export async function importEntityRows({ columns, rows, mapping }) {
  const res = await apiClient.post(`${BASE}/import/rows`, { columns, rows, mapping })
  return extractData(res)
}

/**
 * 객체 프로필(Phase A) — 인증-only 조합. 흩어진 정보를 한 번에:
 *   {
 *     entity, aliases:[{id,alias}], years:[int],
 *     relations:{ parents:[EntityRelationItem], children:[EntityRelationItem] },
 *     reports:[{id,title,workspace_slug,updated_at}],  // 가시성 필터됨
 *     report_count,                                    // 필터 후 총계
 *   }
 * 관계도는 별도 `getEntityGraph` 를 프로필 화면이 따로 호출한다(중복 방지).
 */
export async function getEntityProfile(entityId) {
  const res = await apiClient.get(`${BASE}/${entityId}/profile`)
  return extractData(res)
}

// ─── cross-kind 링크 (A0.3 스텝2) — object_links + ObjectRef ─────────────── #

/** 어떤 종류 객체든 균일한 표시형(ObjectRef)으로 해석. `{type,id,kind_class,label,url,icon,deleted}`. */
export async function resolveObject(type, id) {
  const res = await apiClient.get(`/api/objects/${type}/${encodeURIComponent(id)}`)
  return extractData(res)
}

/** 이 엔티티의 cross-kind 링크(해석됨) 목록. `{ items: ObjectLinkItem[] }`. */
export async function listObjectLinks(entityId) {
  const res = await apiClient.get(`${BASE}/${entityId}/object-links`)
  return extractData(res)
}

/**
 * 어떤 객체든(부서 포함) 그 객체의 cross-kind 링크(양방향, 해석됨).
 *   `{ object: ObjectRef, items: ObjectLinkItem[] }`
 * 부서로 부르면 incoming = '이 부서가 담당한 과제들'(역방향). 일반 객체 프로필용.
 */
export async function getObjectLinks(type, id) {
  const res = await apiClient.get(
    `/api/objects/${type}/${encodeURIComponent(id)}/links`,
  )
  return extractData(res)
}

/** Admin-only — 이 엔티티(src) → system 객체(dstType/dstId) 링크 추가. */
export async function addObjectLink(
  entityId,
  { dstType, dstId, relation, properties, evidenceReportId, evidenceNote } = {},
) {
  const body = { dst_type: dstType, dst_id: String(dstId), relation }
  if (properties !== undefined) body.properties = properties
  if (evidenceReportId !== undefined) body.evidence_report_id = evidenceReportId
  if (evidenceNote !== undefined) body.evidence_note = evidenceNote
  const res = await apiClient.post(`${BASE}/${entityId}/object-links`, body)
  return extractData(res)
}

/** Admin-only — cross-kind 링크 삭제. */
export async function deleteObjectLink(entityId, linkId) {
  const res = await apiClient.delete(`${BASE}/${entityId}/object-links/${linkId}`)
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
  offset = 0,
  withUsage = false,
  relatedTo,
  year,
} = {}) {
  // URLSearchParams 로 직접 조립 — related_to 는 반복 파라미터
  // (related_to=1&related_to=2) 라야 FastAPI list[int] 에 바인딩된다.
  // axios 기본 배열 직렬화(related_to[]=1)는 안 맞음.
  const params = new URLSearchParams()
  params.set('limit', String(limit))
  if (offset) params.set('offset', String(offset))
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

/** 서버 limit 상한(500) — 이보다 크게 요청하면 422. 페이지 크기로 쓴다. */
const LIST_PAGE_MAX = 500

/**
 * 축의 값을 **전부** 가져온다(페이지를 끝까지 넘겨 합침).
 *
 * listEntities 한 번은 최대 500건이라, 값이 그보다 많은 축은 관리 화면이 조용히
 * 잘려 보였다(마지막 페이지가 꽉 차지 않을 때까지 반복해서 이어붙인다).
 *
 * maxRecords 는 폭주 방지선 — 넘으면 거기서 멈추고 truncated=true 로 알린다.
 * 조용히 자르지 않기 위한 것이므로 호출부가 반드시 표시해야 한다.
 */
export async function listAllEntities({ maxRecords = 20000, ...opts } = {}) {
  const items = []
  for (let offset = 0; ; offset += LIST_PAGE_MAX) {
    const page = await listEntities({ ...opts, limit: LIST_PAGE_MAX, offset })
    const got = page?.items ?? []
    items.push(...got)
    if (got.length < LIST_PAGE_MAX) return { items, truncated: false }
    if (items.length >= maxRecords) return { items, truncated: true }
  }
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

/**
 * Admin-only. Move reports tagged with `entityId` to `intoId` (same axis),
 * keeping the source entity — the "move" counterpart of unlink-all. Pass
 * `reportIds` to move only that subset (partial move); omit/null moves all.
 * Server 400s if the target is on a different axis. Returns `{ moved_count }`.
 */
export async function moveEntityTaggings(entityId, intoId, reportIds = null) {
  const res = await apiClient.post(`${BASE}/${entityId}/move-taggings`, {
    into_id: intoId,
    ...(reportIds != null ? { report_ids: reportIds } : {}),
  })
  return extractData(res)
}

/** Admin-only hard delete. Server returns 400 when the entity is still in use. */
export async function deleteEntity(id) {
  const res = await apiClient.delete(`${BASE}/${id}`)
  return extractData(res)
}

/**
 * Admin-only bulk hard delete. Entities still in use are skipped (not an
 * error) — the response splits `deleted_ids` from `skipped` (each with a
 * reason) so the caller can report partial success.
 */
export async function bulkDeleteEntities(entityIds) {
  const res = await apiClient.post(`${BASE}/bulk-delete`, {
    entity_ids: entityIds,
  })
  return extractData(res)
}

/**
 * Admin-only bulk axis reassignment. Moves the given entities to
 * `targetTypeId`; taggings follow automatically (they key on entity_id).
 * Response splits `moved_ids` (axis changed in place) from `merged_ids`
 * (target axis already had the value → absorbed + source deleted) and
 * `skipped` (pattern mismatch / already on target / not found).
 */
export async function bulkReassignAxis(entityIds, targetTypeId) {
  const res = await apiClient.post(`${BASE}/bulk-reassign-axis`, {
    entity_ids: entityIds,
    target_type_id: targetTypeId,
  })
  return extractData(res)
}
