import { apiClient, extractData } from './client'

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
 *   { answer, citations:[{n, report_id, title, workspace_slug, block_id, page_idx, snippet, used}],
 *     no_evidence, model, backend }
 * 'rag_qa' 엔티틀먼트 없으면 403, 근거 약하면 no_evidence=true.
 */
export async function askAi({ query, limit = 8, signal } = {}) {
  // signal: AbortController.signal — 사용자가 "중단"하면 요청을 끊고, 서버도
  // 연결 끊김을 감지해 LLM 생성을 멈춘다.
  const res = await apiClient.post('/api/ai/ask', { query, limit }, { signal })
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
