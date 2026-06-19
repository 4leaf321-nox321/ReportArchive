import { useEffect, useRef } from 'react'
import { putLocalDraft, delLocalDraft } from './localDraftBackup'

// 편집이 멈춘 뒤 이 시간(ms)이 지나면 한 번 백업한다. 타이핑마다 쓰지 않고
// "마지막 편집 후 잠깐 쉴 때"만 써서, 큰 보고서에서도 직렬화 비용이 몰리지
// 않게 한다.
const BACKUP_DEBOUNCE_MS = 2500

/**
 * 편집 중 draft 를 디바운스로 IndexedDB 에 백업하는 훅.
 *
 * - `enabled` 이고 `backupKey` 가 있을 때만 동작(편집 모드 한정).
 * - draft 가 바뀔 때마다 타이머를 리셋하고, 멈춘 뒤 `getIsDirty()` 가 true
 *   (=서버에 저장된 기준과 다름)일 때만 실제로 쓴다. 손대지 않은 보고서는
 *   백업하지 않아 불필요한 복구 배너가 뜨지 않는다.
 * - `clear()` 는 저장/생성 성공·명시적 포기 시 호출해 백업을 지운다.
 */
export function useLocalDraftBackup({
  enabled,
  backupKey,
  draft,
  getIsDirty,
  reportId = null,
}) {
  const timerRef = useRef(null)
  // getIsDirty 는 매 렌더 새 함수라 deps 에 넣으면 타이머가 매 렌더 리셋된다.
  // ref 로 최신값만 읽어, 타이머는 draft 변경(=실제 편집)에만 리셋되게 한다.
  const dirtyRef = useRef(getIsDirty)
  dirtyRef.current = getIsDirty

  useEffect(() => {
    if (!enabled || !backupKey || !draft) return undefined
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      // dirty 판정(JSON 직렬화 비교)은 디바운스 후 한 번만 — 타이핑마다가
      // 아니라 멈췄을 때만 돌므로 큰 보고서에서도 부담이 적다.
      const isDirty = dirtyRef.current
      if (isDirty && !isDirty()) return
      putLocalDraft({
        key: backupKey,
        savedAt: Date.now(),
        reportId,
        title: draft.title ?? '',
        revision: draft.revision ?? null,
        draft,
      })
    }, BACKUP_DEBOUNCE_MS)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
    // getIsDirty 는 ref 로 읽으므로 deps 에서 의도적으로 제외.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, backupKey, draft, reportId])

  return {
    clear() {
      if (timerRef.current) clearTimeout(timerRef.current)
      delLocalDraft(backupKey)
    },
  }
}
