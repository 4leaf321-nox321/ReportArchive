// 클립보드에서 "가장 고해상도" 이미지 후보를 골라내는 헬퍼.
//
// 배경: PowerPoint 등에서 슬라이드에 작게 줄인 그림을 복사하면, 클립보드에는
// 같은 이미지가 여러 포맷으로 동시에 담긴다 — PPT 네이티브/EMF(벡터, 원본
// 고해상도)와 래스터 비트맵(PNG/DIB 등, 화면에 보이는 축소된 크기). 브라우저는
// 보안상 래스터 포맷만 웹에 넘기는데, 같은 복사라도 포맷마다 픽셀 크기가 다를
// 수 있다(예: image/png 480×360 + image/bmp 2000×1500). 기존 paste 핸들러는
// 먼저 잡히는 포맷을 그냥 써서 저해상도가 붙는 일이 있었다.
//
// 이 헬퍼는 (1) paste 이벤트의 동기 clipboardData 와 (2) 가능하면 비동기
// navigator.clipboard.read() 양쪽에서 이미지 후보를 모두 모아, 실제 픽셀 면적이
// 가장 큰 것을 고른다. 동시에 모든 후보의 진단 정보(포맷·크기·바이트)를 돌려줘
// "원본 2000×1500인데 붙은 건 480×360" 같은 상황을 바로 확인할 수 있게 한다.

// Blob 을 디코드해 자연(intrinsic) 픽셀 크기를 잰다. 이미지로 못 읽으면 null.
async function measureImage(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(blob)
      const size = { width: bmp.width, height: bmp.height }
      bmp.close?.()
      return size
    } catch {
      /* SVG 등 createImageBitmap 미지원 포맷 → <img> 로 폴백 */
    }
  }
  if (typeof Image === 'undefined' || typeof URL === 'undefined') return null
  return await new Promise((resolve) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight })
      URL.revokeObjectURL(url)
    }
    img.onerror = () => {
      resolve(null)
      URL.revokeObjectURL(url)
    }
    img.src = url
  })
}

// paste 이벤트의 동기 clipboardData 에서 이미지 blob 을 모은다. 반드시 첫 await
// 이전에 동기로 호출해야 한다 — 이벤트가 소비되면 getAsFile() 이 빈다.
function collectFromEvent(e) {
  const out = []
  const items = Array.from(e.clipboardData?.items ?? [])
  for (const it of items) {
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      const f = it.getAsFile()
      if (f) out.push({ blob: f, type: it.type, source: 'event' })
    }
  }
  return out
}

// 비동기 Clipboard API — 이벤트가 노출하지 않은 포맷을 줄 수도 있다(브라우저에
// 따라 PNG 로 재인코딩만 줄 수도). 권한 거부/미지원이면 조용히 빈 배열.
async function collectFromAsyncClipboard() {
  const out = []
  try {
    if (!navigator.clipboard?.read) return out
    const items = await navigator.clipboard.read()
    for (const item of items) {
      for (const type of item.types) {
        if (!type.startsWith('image/')) continue
        try {
          const blob = await item.getType(type)
          out.push({ blob, type, source: 'async' })
        } catch {
          /* 개별 포맷 읽기 실패는 무시 */
        }
      }
    }
  } catch {
    /* 권한 거부 / 비보안 컨텍스트 / 미지원 — 무시 */
  }
  return out
}

/**
 * paste 이벤트에서 가장 고해상도인 이미지 후보를 고른다.
 *
 * 반환: { chosen, candidates }
 *  - chosen: { blob, type, source, width, height, area } | null
 *  - candidates: 면적 내림차순으로 측정된 모든 후보(진단용)
 *
 * 주의: 호출부는 이 함수를 부르기 *전에* (동기로) e.preventDefault() 를 해야
 * 하고, 동기 후보 수집이 첫 await 전에 끝나도록 이 함수가 설계돼 있다.
 */
export async function pickBestPastedImage(e) {
  // 동기 수집부터 — 이벤트가 살아있을 때.
  const eventCandidates = collectFromEvent(e)
  // 그 다음 비동기 클립보드도 시도(있으면 보너스 후보).
  const asyncCandidates = await collectFromAsyncClipboard()

  // 같은 내용 중복 제거(이벤트/비동기가 겹칠 수 있음). type+byte 크기로 키.
  const seen = new Set()
  const unique = []
  for (const c of [...eventCandidates, ...asyncCandidates]) {
    const key = `${c.type}:${c.blob.size}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(c)
  }

  // 각 후보의 실제 픽셀 크기 측정.
  const measured = []
  for (const c of unique) {
    const size = await measureImage(c.blob)
    measured.push({
      ...c,
      width: size?.width ?? 0,
      height: size?.height ?? 0,
      area: size ? size.width * size.height : 0,
    })
  }
  // 면적 큰 순. 동률이면 바이트 큰 순(같은 크기면 덜 압축된 쪽).
  measured.sort((a, b) => b.area - a.area || b.blob.size - a.blob.size)

  return { chosen: measured[0] ?? null, candidates: measured }
}

/** 후보 목록을 사람이 읽는 한 줄들로 — 진단 토스트/콘솔용. */
export function describePastedImageCandidates(candidates) {
  if (!candidates?.length) return '이미지 후보 없음'
  return candidates
    .map(
      (c) =>
        `${c.type} ${c.width}×${c.height} (${Math.round(c.blob.size / 1024)}KB, ${c.source})`,
    )
    .join('\n')
}

/**
 * 진단 로그 — 붙여넣기 때 클립보드에 어떤 포맷이 어떤 픽셀 크기로 들어왔고
 * 무엇을 골랐는지 콘솔에 표로 찍는다. 저해상도(원본이 작게 복사된 경우)인지
 * 환경별로 확인하는 용도. 한 줄 요약 문자열도 돌려줘 토스트에 쓸 수 있게 한다.
 */
export function logPastedImageDiagnostics(candidates, chosen) {
  try {
    const rows = (candidates ?? []).map((c) => ({
      포맷: c.type,
      가로: c.width,
      세로: c.height,
      KB: Math.round(c.blob.size / 1024),
      출처: c.source,
      선택: chosen && c === chosen ? '✓' : '',
    }))
    // eslint-disable-next-line no-console
    console.groupCollapsed(
      `[붙여넣기 이미지] 후보 ${rows.length}개 → 선택 ${
        chosen ? `${chosen.width}×${chosen.height}` : '없음'
      }`,
    )
    // eslint-disable-next-line no-console
    if (console.table) console.table(rows)
    // eslint-disable-next-line no-console
    else console.log(rows)
    // eslint-disable-next-line no-console
    console.groupEnd()
  } catch {
    /* 콘솔 진단 실패는 무시 */
  }
  if (!chosen) return '클립보드에서 이미지를 찾지 못했습니다.'
  const others = (candidates?.length ?? 0) - 1
  return `붙여넣기 이미지 ${chosen.width}×${chosen.height} 선택${
    others > 0 ? ` (후보 ${candidates.length}개 중 최대 해상도)` : ''
  }`
}

// 이보다 긴 변(px)이 작으면 "저해상도"로 보고 경고. 문서/PPT 용도로 흔히
// 흐릿하게 보이는 경계. 의도적으로 작은 아이콘은 오탐일 수 있으나, 경고는
// 가볍게(닫으면 그만) 띄우고 붙여넣기는 정상 진행한다.
export const LOW_RES_LONG_EDGE_PX = 800

/**
 * 고른 이미지가 저해상도면 사용자에게 보여줄 경고 문구를 돌려준다(아니면 null).
 * 클립보드 한계상 PPT 등에서 작게 복사하면 화질이 낮게 붙는데, 그때 원본 파일
 * 업로드를 권하는 안내.
 */
export function lowResWarning(chosen) {
  if (!chosen) return null
  const longEdge = Math.max(chosen.width || 0, chosen.height || 0)
  if (longEdge > 0 && longEdge < LOW_RES_LONG_EDGE_PX) {
    return (
      `붙여넣은 이미지 해상도가 낮습니다 (${chosen.width}×${chosen.height}). ` +
      `고화질이 필요하면 원본 이미지 파일을 직접 올리거나(드래그 또는 파일 선택), ` +
      `PPT에서 복사한 경우 PPT 안에서 이미지 크기를 키운 뒤 복사해 붙여넣으세요.`
    )
  }
  return null
}

/** chosen.blob 을 업로드용 File 로 — 이미 File 이면 그대로. */
export function pastedImageToFile(chosen) {
  if (!chosen?.blob) return null
  if (typeof File !== 'undefined' && chosen.blob instanceof File) return chosen.blob
  const ext = (chosen.type.split('/')[1] || 'png').replace('+xml', '')
  const name = `pasted-${Date.now()}.${ext}`
  try {
    return new File([chosen.blob], name, { type: chosen.blob.type || chosen.type })
  } catch {
    // 구형 브라우저: Blob 도 FormData 에 그대로 append 가능.
    return chosen.blob
  }
}
