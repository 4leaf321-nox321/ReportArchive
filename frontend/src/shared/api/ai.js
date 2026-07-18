import {
  apiClient,
  extractData,
  getAccessToken,
  getCurrentWorkspace,
} from './client'

/** 현재 LLM 설정 요약(비밀 제외) — 진단 탭 상태 카드. 시스템 관리자 전용 엔드포인트. */
export async function getAiDiagConfig() {
  const res = await apiClient.get('/api/ai/diag/config')
  return extractData(res)
}

/** 서버가 B300 에 짧은 chat 1회 → 연결/지연/모델 확인. 실패 시 502(axios throw). */
export async function pingAi() {
  const res = await apiClient.post('/api/ai/diag/ping')
  return extractData(res)
}

/** 임의 프롬프트 → 원응답(content/reasoning/usage/latency). reasoningEffort 미지정 시 서버 기본값. */
export async function chatAiDiag({ prompt, reasoningEffort = null }) {
  const res = await apiClient.post('/api/ai/diag/chat', {
    prompt,
    reasoning_effort: reasoningEffort,
  })
  return extractData(res)
}

/**
 * 아카이브 RAG Q&A (§A) — 질문 → 검색 → 출처 인용 답변.
 *   { answer, citations:[{n, report_id, title, workspace_slug, block_id, page_idx,
 *                         snippet, used, author, date, graph, objects}],
 *     no_evidence, model, backend, seeds:[{id, value, type_slug, type_label, via}] }
 * 'rag_qa' 엔티틀먼트 없으면 403, 근거 약하면 no_evidence=true.
 *   graph=true → GraphRAG(온톨로지 그래프 근거 블렌드): seeds(다룬 객체) + 출처에
 *   작성자·날짜, 그래프 근거엔 연결 객체(objects)·graph 플래그가 실린다.
 */
export async function askAi({
  query, limit = 8, graph = false, rerank, hyde, verify, signal,
} = {}) {
  // signal: AbortController.signal — 사용자가 "중단"하면 요청을 끊고, 서버도
  // 연결 끊김을 감지해 LLM 생성을 멈춘다.
  // rerank/hyde/verify: 요청별 override. 지정 안 하면(undefined) 서버 기본값.
  const body = { query, limit, graph }
  if (rerank !== undefined && rerank !== null) body.rerank = rerank
  if (hyde !== undefined && hyde !== null) body.hyde = hyde
  if (verify !== undefined && verify !== null) body.verify = verify
  const res = await apiClient.post('/api/ai/ask', body, { signal })
  return extractData(res)
}

/**
 * 객체 스코프 Q&A — 이 객체를 태깅한 (가시) 보고서로만 근거를 한정해 답한다.
 * 응답 형태는 askAi 와 동일(citations 등). rag_qa 권한 필요. graph 는 서버가 강제 off.
 */
export async function askEntity(entityId, { query, limit = 6, rerank, hyde, verify, signal } = {}) {
  const body = { query, limit }
  if (rerank !== undefined && rerank !== null) body.rerank = rerank
  if (hyde !== undefined && hyde !== null) body.hyde = hyde
  if (verify !== undefined && verify !== null) body.verify = verify
  const res = await apiClient.post(`/api/ai/entities/${entityId}/ask`, body, { signal })
  return extractData(res)
}

/**
 * 객체 요약 — 이 객체의 메타 + 태깅 보고서 초록을 LLM 이 종합.
 *   { summary, model, backend, report_count, no_evidence }
 * 온디맨드(캐시 없음). rag_qa 권한 필요.
 */
export async function getEntitySummary(entityId, { signal } = {}) {
  const res = await apiClient.post(`/api/ai/entities/${entityId}/summary`, {}, { signal })
  return extractData(res)
}

/** Q&A 검색 옵션 기본값(프론트 토글 초기화용). { graph, rerank, hyde, *_available } */
export async function getAskOptions() {
  const res = await apiClient.get('/api/ai/ask/options')
  return extractData(res)
}

/**
 * 온톨로지 에이전트(tool-calling) — LLM이 온톨로지 도구를 스스로 호출해 다단계
 * 조사 후 근거·추론과정과 함께 답변.
 *   { answer, citations:[{n, report_id, title, workspace_slug}],
 *     objects:[{type, id, label}], trace:[{hop, tool, args, summary}],
 *     no_evidence, model, backend }
 * 'rag_qa' 엔티틀먼트 재사용. LLM이 tools 미지원이면 도구 없이 1턴으로 degrade.
 */
export async function askAgent({ query, history = [], maxHops = 6, signal } = {}) {
  // history: 대화 이전 턴 [{role:'user'|'assistant', content}] — 서버가 후속 질문을
  // 독립형으로 재작성하는 데 쓴다(대화형 검색). 서버는 stateless(세션 없음).
  const res = await apiClient.post(
    '/api/ai/agent',
    { query, max_hops: maxHops, history },
    { signal },
  )
  return extractData(res)
}

// SSE 스트리밍 에이전트 — axios(단일응답)로는 스트림을 못 받아 fetch+ReadableStream 을
// 쓴다. onEvent(evt) 로 {type:'rewrite'|'progress'|'token'|'done'|'error', ...} 를 순차 전달.
// signal 로 중단(연결 끊김 → 서버 생성 중단). resolve 는 스트림 종료 시.
export async function askAgentStream({
  query,
  history = [],
  maxHops = 6,
  signal,
  onEvent,
} = {}) {
  const base = import.meta.env.VITE_API_BASE_URL || ''
  const token = getAccessToken()
  const ws = getCurrentWorkspace()
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  if (ws) headers['X-Workspace-Slug'] = ws

  const resp = await fetch(`${base}/api/ai/agent/stream`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, max_hops: maxHops, history }),
    signal,
  })
  if (!resp.ok || !resp.body) {
    throw new Error(`스트리밍 시작 실패 (${resp.status})`)
  }

  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let sep
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, sep)
      buf = buf.slice(sep + 2)
      for (const line of chunk.split('\n')) {
        const s = line.trim()
        if (!s.startsWith('data:')) continue
        const data = s.slice(5).trim()
        if (!data) continue
        try {
          onEvent?.(JSON.parse(data))
        } catch {
          /* 파싱 실패한 청크는 무시 */
        }
      }
    }
  }
}

// --- 대화형 검색 — 저장된 대화 CRUD(사용자별 private) ------------------------

/** 내 대화 목록. `{ items: [{id, title, updated_at, turns}] }` (최신순). */
export async function listConversations() {
  const res = await apiClient.get('/api/ai/conversations')
  return extractData(res)
}

/** 대화 전체(메시지 포함). `{ id, title, messages, updated_at }`. */
export async function getConversation(id) {
  const res = await apiClient.get(`/api/ai/conversations/${id}`)
  return extractData(res)
}

/** 새 대화 저장 → `{ id, ... }`. */
export async function createConversation({ title, messages }) {
  const res = await apiClient.post('/api/ai/conversations', { title, messages })
  return extractData(res)
}

/** 대화 갱신(메시지/제목 통째). */
export async function updateConversation(id, { title, messages } = {}) {
  const res = await apiClient.put(`/api/ai/conversations/${id}`, { title, messages })
  return extractData(res)
}

/** 대화 삭제(멱등). */
export async function deleteConversation(id) {
  const res = await apiClient.delete(`/api/ai/conversations/${id}`)
  return extractData(res)
}

// --- B300 접근 제어(엔티틀먼트, §E) — 전부 시스템 관리자 전용 -------------------

/** 모든 B300 기능 grant 목록. `{ items: [{id, feature, subject_kind, user_id,
 *  workspace_slug, include_descendants, enabled, note, subject_label}] }`. */
export async function listAiEntitlements() {
  const res = await apiClient.get('/api/ai/entitlements')
  return extractData(res)
}

/** grant 생성. subject_kind='user'면 userId, 'workspace'면 workspaceSlug 필수. */
export async function createAiEntitlement({
  feature,
  subjectKind,
  userId,
  workspaceSlug,
  includeDescendants = false,
  note,
}) {
  const res = await apiClient.post('/api/ai/entitlements', {
    feature,
    subject_kind: subjectKind,
    user_id: subjectKind === 'user' ? userId : null,
    workspace_slug: subjectKind === 'workspace' ? workspaceSlug : null,
    include_descendants: includeDescendants,
    note: note || null,
  })
  return extractData(res)
}

/** grant 해제(행 삭제). 멱등. */
export async function deleteAiEntitlement(id) {
  const res = await apiClient.delete(`/api/ai/entitlements/${id}`)
  return extractData(res)
}

// --- 런타임 튜닝 설정(.env 기본값 + DB override) — 시스템 관리자 전용 -----------

/** 튜닝 설정 목록. `{ settings:[{key,value,default,overridden,type,label,desc,
 *  group,min,max,step,requires_reindex}] }`. */
export async function getAiSettings() {
  const res = await apiClient.get('/api/ai/settings')
  return extractData(res)
}

/** override 적용(재시작 불필요). changes={key:value}. 반환 {applied, requires_reindex}. */
export async function updateAiSettings(changes) {
  const res = await apiClient.put('/api/ai/settings', { changes })
  return extractData(res)
}

/** 한 설정을 .env 기본값으로 되돌림(override 삭제). */
export async function resetAiSetting(key) {
  const res = await apiClient.delete(`/api/ai/settings/${key}`)
  return extractData(res)
}

// --- RAG 검색 평가(골든셋 + 실행) — 시스템 관리자 전용 --------------------------

/** 평가 케이스 목록. `{ cases:[{id,query,expect_report_ids,expect_entities,graph}] }`. */
export async function listEvalCases() {
  const res = await apiClient.get('/api/ai/eval/cases')
  return extractData(res)
}
export async function createEvalCase(body) {
  const res = await apiClient.post('/api/ai/eval/cases', body)
  return extractData(res)
}
export async function updateEvalCase(id, body) {
  const res = await apiClient.put(`/api/ai/eval/cases/${id}`, body)
  return extractData(res)
}
export async function deleteEvalCase(id) {
  const res = await apiClient.delete(`/api/ai/eval/cases/${id}`)
  return extractData(res)
}
/** 평가 실행. opts={k,graph,rerank,hyde} → {cases:[...], aggregate:{...}, config}. */
export async function runEval(opts = {}) {
  const res = await apiClient.post('/api/ai/eval/run', { k: 5, ...opts })
  return extractData(res)
}
/** 정답 보고서 픽커용 간단 검색 → [{id,title,workspace_slug}]. */
export async function searchReportsForPicker(q, limit = 8) {
  const res = await apiClient.get('/api/reports/search', { params: { q, limit } })
  const data = extractData(res)
  return (data?.results || []).map((r) => r.report || r)
}

// --- QA 피드백(👍/👎) — 수집 + 골든셋 승격 --------------------------------------

/** 답변 피드백 저장. rating: 1=👍 / -1=👎. report_ids=인용 보고서. */
export async function submitFeedback({ query, rating, reportIds = [] }) {
  const res = await apiClient.post('/api/ai/feedback', {
    query, rating, report_ids: reportIds,
  })
  return extractData(res)
}
/** 관리자 요약 {up,down,promotable}. */
export async function getFeedbackSummary() {
  const res = await apiClient.get('/api/ai/feedback/summary')
  return extractData(res)
}
/** 👍 피드백을 평가 골든셋으로 승격 → {created}. (관리자) */
export async function promoteFeedbackToGolden() {
  const res = await apiClient.post('/api/ai/eval/from-feedback')
  return extractData(res)
}
