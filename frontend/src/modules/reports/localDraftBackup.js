// 보고서 편집 중 작성 내용을 브라우저 IndexedDB 에 주기적으로 백업해, 탭/
// 브라우저가 크래시(오류·강제종료·전원차단)로 죽어도 다음 진입 시 복구할 수
// 있게 한다. 서버에는 아무것도 보내지 않으므로 게시본·revision·편집락 모델과
// 완전히 독립적이다 — 어디까지나 "마지막에 보던 화면을 잃지 않게" 하는 로컬
// 안전망이다.
//
// 저장 단위는 보고서 1건의 전체 draft 스냅샷(JSON 직렬화 가능한 평범한 객체).
// 키는 사용자+보고서별로 분리해, 같은 PC 를 공유해도 남의 백업을 보지 않는다.
//
// IndexedDB 를 쓰는 이유: 보고서 payload 가 큰 경우(차트 데이터·다중 페이지)
// 1~2MB 까지 가서 localStorage(약 5MB·동기 blocking)보다 안전하고, 비동기라
// 타이핑을 막지 않는다. 저장공간 없음/시크릿 모드 등으로 실패해도 백업은
// best-effort 라 조용히 포기한다(throw 하지 않음).

const DB_NAME = 'reportarchive'
const STORE = 'draft_backups'
const DB_VERSION = 1

let _dbPromise = null

function openDB() {
  if (_dbPromise) return _dbPromise
  _dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return _dbPromise
}

/**
 * 백업 키 — 사용자+보고서 단위. 기존 보고서는 id 로, 아직 저장 전 새 보고서는
 * 템플릿+버전으로(같은 URL 로 다시 들어오면 복구되도록) 식별한다. 둘 다 없으면
 * 백업 불가(null).
 */
export function buildBackupKey({ userId, reportId, templateId, version }) {
  const u = userId ?? 'anon'
  if (reportId) return `rb:${u}:r:${reportId}`
  if (templateId) return `rb:${u}:n:${templateId}@${version ?? ''}`
  return null
}

/** draft 스냅샷 1건 저장(덮어쓰기). record = {key, savedAt, reportId, title,
 *  revision, draft}. 실패는 조용히 무시. */
export async function putLocalDraft(record) {
  try {
    const db = await openDB()
    await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, 'readwrite')
      t.objectStore(STORE).put(record)
      t.oncomplete = () => resolve()
      t.onerror = () => reject(t.error)
      t.onabort = () => reject(t.error)
    })
  } catch {
    // best-effort — 저장 실패해도 편집 흐름을 막지 않는다.
  }
}

/** 키로 백업 1건 조회. 없거나 실패하면 null. */
export async function getLocalDraft(key) {
  if (!key) return null
  try {
    const db = await openDB()
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, 'readonly')
      const req = t.objectStore(STORE).get(key)
      req.onsuccess = () => resolve(req.result ?? null)
      req.onerror = () => reject(req.error)
    })
  } catch {
    return null
  }
}

/** 키로 백업 1건 삭제. 실패는 조용히 무시. */
export async function delLocalDraft(key) {
  if (!key) return
  try {
    const db = await openDB()
    await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, 'readwrite')
      t.objectStore(STORE).delete(key)
      t.oncomplete = () => resolve()
      t.onerror = () => reject(t.error)
      t.onabort = () => reject(t.error)
    })
  } catch {
    // best-effort
  }
}
