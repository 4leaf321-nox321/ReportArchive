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
