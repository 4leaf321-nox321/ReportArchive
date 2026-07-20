import { apiClient, extractData } from './client'

/**
 * 외부 시스템 연계 커넥터 API — /api/connectors. 전부 시스템 관리자 전용
 * (백엔드 require_system_admin). 외부 REST/JSON 을 등록해 온톨로지에 동기화한다.
 *
 * config 구조(SourceConfig) — 커넥션 1개 + 스트림 여러 개:
 *   { connection: { base_url, auth:{type,token,header,username,password}, headers },
 *     streams: [ { label, endpoint_path, http_method, query, records_path,
 *                  target_type_id, match_key, value_path, code_path,
 *                  property_map:{slug: path}, relation_map:[{relation,target_type,path}] } ] }
 * 시크릿(connection.auth.token/password)은 응답에서 마스킹돼 온다(has_secret 로 존재만 표시).
 */

const BASE = '/api/connectors'

export async function listDataSources() {
  return extractData(await apiClient.get(BASE))
}

export async function getDataSource(id) {
  return extractData(await apiClient.get(`${BASE}/${id}`))
}

export async function createDataSource(payload) {
  return extractData(await apiClient.post(BASE, payload))
}

export async function updateDataSource(id, payload) {
  return extractData(await apiClient.put(`${BASE}/${id}`, payload))
}

export async function deleteDataSource(id) {
  return extractData(await apiClient.delete(`${BASE}/${id}`))
}

/** 저장 전 응답 샘플(필드명 확인) — 커넥션+스트림 1개로. { record_count, fields[], sample[] }
 *  저장된 소스 편집 중이면 sourceId 를 넘겨, 마스킹된 시크릿을 서버가 저장분으로
 *  채우게 한다(토큰 재입력 불필요). */
export async function probeDataSource(connection, stream, sourceId = null) {
  return extractData(
    await apiClient.post(`${BASE}/probe`, {
      connection,
      stream,
      ...(sourceId != null ? { source_id: sourceId } : {}),
    }),
  )
}

/** dry_run 동기화(검증 미리보기, 쓰기 없음) — { summary, rows }
 *  streamIndex 를 주면 그 스트림 하나만 미리본다. */
export async function previewDataSource(id, streamIndex = null) {
  const q = streamIndex != null ? `?stream=${streamIndex}` : ''
  return extractData(await apiClient.post(`${BASE}/${id}/preview${q}`))
}

/** 실제 동기화(온톨로지 upsert + 이력) — { summary, rows }
 *  streamIndex 를 주면 그 스트림 하나만 동기화한다(나머지는 건드리지 않음). */
export async function syncDataSource(id, streamIndex = null) {
  const q = streamIndex != null ? `?stream=${streamIndex}` : ''
  return extractData(await apiClient.post(`${BASE}/${id}/sync${q}`))
}

/** 오프셋 백필 진행 상태 초기화(offset 0 부터 다시). streamIndex 주면 그 스트림만.
 *  { sync_state } */
export async function resetBackfill(id, streamIndex = null) {
  const q = streamIndex != null ? `?stream=${streamIndex}` : ''
  return extractData(await apiClient.post(`${BASE}/${id}/reset-backfill${q}`))
}

/** 동기화 이력 — { items[] } */
export async function listSyncRuns(id) {
  return extractData(await apiClient.get(`${BASE}/${id}/runs`))
}

/** 객체 계보(출처) — 이 객체를 채운 소스들. 인증만.
 *  { items: [{ data_source_id, source_name, last_sync_run_id, first_seen, last_seen }] } */
export async function getObjectProvenance(entityId) {
  return extractData(await apiClient.get(`${BASE}/objects/${entityId}/provenance`))
}

/** AI 자동 매핑 — probe 결과(샘플 레코드들 + 전체 스캔 경로) + 대상 축 → 매핑 초안
 *  제안(LLM→휴리스틱 폴백, 검증됨). probeResult 를 통째로 넘기면 된다 — 1건만 보내면
 *  그 레코드에서 null 인 navigation 을 AI 가 못 본다.
 *  { value_path, property_map:{slug:path}, relation_map:[...], source:'llm'|'heuristic' } */
export async function suggestMapping(targetTypeId, probeResult) {
  const { sample = [], fields = [] } = probeResult || {}
  return extractData(
    await apiClient.post(`${BASE}/suggest-mapping`, {
      target_type_id: targetTypeId,
      samples: sample,
      fields,
    }),
  )
}
