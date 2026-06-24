// 인터랙티브/정적 HTML export 의 "자산 굽기" 헬퍼.
//
// exportReportToHtml 은 렌더된 DOM 을 통째로 클론한 뒤 포터블 파일로 만든다.
// 이때 <img>/<canvas>/Plotly 는 본체(exportReportToHtml.js)에서 data URI·PNG·
// 재렌더로 구워 넣지만, 다음 위젯들은 런타임 blob URL / 인증 fetch / 서버
// 상대경로에 의존해서 저장 파일에선 깨진다:
//
//   - video      : <video src="blob:..."> — blob URL 은 export 후 revoke·직렬화
//                  불가. (Video.jsx 가 data-export-file-id 를 심어둔다.)
//   - attachment : 다운로드가 JS onClick(downloadFile) 버튼뿐 — 저장 HTML 엔
//                  핸들러도 바이트도 없다. (Attachment.jsx 가 버튼에
//                  data-export-attachment-file-id 를 심어둔다.)
//   - html_embed : 번들 모드 <iframe src="/api/embed/{id}/index.html"> — 서버
//                  상대경로라 오프라인에서 404. (단일 srcdoc 모드는 이미 동작.)
//
// 아래 inline* 들이 클론을 받아 각 자산을 원본 바이트로 받아 data URI / srcdoc /
// <a download> 로 치환한다. 모두 `<img>` 인라인과 동일하게 **인터랙티브·정적
// 모드 양쪽**에서 동작한다(스크립트 불필요).
//
// 정책: 용량 제한 없이 전부 인라인한다(2026-06 사용자 결정). 큰 동영상은
// HTML 을 수십~수백 MB 로 키울 수 있으나, "저장하면 무조건 재생/회수 가능"을
// 우선한다.

import { apiClient } from '@/shared/api/client'
import { fetchFileBlob } from '@/shared/api/files'

function blobToDataUri(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

// --- video ------------------------------------------------------------ //
//
// Video.jsx 의 <video> 에 data-export-file-id(+ data-export-mime)를 심어두면,
// 클론은 blob URL 대신 그 file_id 로 원본을 직접 받아 data URI 로 굽는다.
// controls/autoplay/loop/muted 같은 부울 속성은 클론에 그대로 남아 정적 파일
// 에서도 네이티브 컨트롤로 재생된다.
export async function inlineVideos(rootEl) {
  const vids = Array.from(rootEl.querySelectorAll('video[data-export-file-id]'))
  await Promise.all(
    vids.map(async (video) => {
      const fileId = video.getAttribute('data-export-file-id')
      if (!fileId) return
      try {
        const blob = await fetchFileBlob(fileId)
        const dataUri = await blobToDataUri(blob)
        video.setAttribute('src', dataUri)
        // 자동재생을 켰다면 정적 파일에서도 브라우저가 막지 않도록 muted 보강.
        if (video.hasAttribute('autoplay')) video.setAttribute('muted', '')
      } catch (err) {
        // 한 동영상 실패로 전체 export 를 깨지 않는다 — 빈 플레이어로 남긴다.
        console.warn('[html-export] video inline failed', fileId, err)
      } finally {
        video.removeAttribute('data-export-file-id')
        video.removeAttribute('data-export-mime')
      }
    }),
  )
}

// --- attachment ------------------------------------------------------- //
//
// Attachment.jsx 의 다운로드 버튼에 심어둔 data-export-attachment-file-id /
// -name 을 읽어, 죽은 <button>(JS onClick) 을 실제로 동작하는
// <a href="data:..." download="파일명"> 로 교체한다. 버튼의 자식(아이콘)은
// 그대로 옮겨와 모양을 유지한다.
export async function inlineAttachments(rootEl) {
  const btns = Array.from(
    rootEl.querySelectorAll('[data-export-attachment-file-id]'),
  )
  await Promise.all(
    btns.map(async (btn) => {
      const fileId = btn.getAttribute('data-export-attachment-file-id')
      const filename =
        btn.getAttribute('data-export-attachment-name') || 'download'
      if (!fileId) return
      try {
        const blob = await fetchFileBlob(fileId)
        const dataUri = await blobToDataUri(blob)
        const a = document.createElement('a')
        a.setAttribute('href', dataUri)
        a.setAttribute('download', filename)
        a.setAttribute('title', '다운로드')
        // 버튼의 클래스(모양)·내부 아이콘을 그대로 가져온다.
        if (btn.className) a.className = btn.className
        while (btn.firstChild) a.appendChild(btn.firstChild)
        btn.replaceWith(a)
      } catch (err) {
        // 실패 시 버튼만 비활성 흔적으로 남긴다(마커 제거).
        console.warn('[html-export] attachment inline failed', fileId, err)
        btn.removeAttribute('data-export-attachment-file-id')
        btn.removeAttribute('data-export-attachment-name')
      }
    }),
  )
}

// --- html_embed (번들/단일, 카드/인라인 모두) ------------------------- //
//
// HtmlEmbed.jsx 가 표시 루트(카드·인라인 공통)에 심은 data-export-embed-* 마커를
// 읽어, 임베드 HTML 을 **자기완결형으로 받아** 두 가지로 재구성한다:
//   1) 본문에 바로 보이는 <iframe srcdoc>  (카드 모드도 내용이 보이게)
//   2) "HTML 다운로드" 링크(data: URI, download)  ← 파일로 저장
//
// 왜 이렇게 하나(오프라인 제약):
//   - 라이브의 "새 탭" 은 /api/embed/... 서버 URL 이라 오프라인에서 404.
//   - data:text/html 을 새 탭으로 직접 여는 것은 최신 브라우저가 차단.
//   - 카드 모드는 export DOM 에 iframe 이 아예 없다(전체화면 portal 안에만 있음).
//   그래서 내용을 직접 받아 srcdoc 인라인 + 다운로드로 제공하는 게 가장 확실하다.
//
// 번들은 진입 HTML 의 상대 <link>/<script>/<img> 하위 자산까지 인라인한다(1단계).
// 런타임 fetch/XHR 로 자산을 끌어오는 임베드는 오프라인에선 제한될 수 있다.

async function fetchFileText(fileId) {
  const res = await apiClient.get(`/api/files/${fileId}`, {
    responseType: 'text',
  })
  return typeof res.data === 'string' ? res.data : String(res.data ?? '')
}

export async function inlineEmbeds(rootEl) {
  const nodes = Array.from(rootEl.querySelectorAll('[data-export-embed]'))
  for (const el of nodes) {
    const bundleId = el.getAttribute('data-export-embed-bundle-id') || ''
    const fileId = el.getAttribute('data-export-embed-file-id') || ''
    const entry = el.getAttribute('data-export-embed-entry') || 'index.html'
    const filenameRaw = el.getAttribute('data-export-embed-filename') || 'embed'
    const height = el.getAttribute('data-export-embed-height') || '70vh'
    if (!bundleId && !fileId) continue
    try {
      // 자기완결형 HTML 확보: 번들=진입+자산 인라인, 단일=파일 텍스트(원래 자기완결).
      const html = bundleId
        ? await inlineBundleAssets(
            await fetchBundleText(bundleId, entry),
            bundleId,
            entry,
          )
        : await fetchFileText(fileId)

      const dataUri = await blobToDataUri(
        new Blob([html], { type: 'text/html;charset=utf-8' }),
      )
      const filename = filenameRaw.replace(/\.html?$/i, '') + '.html'

      // 카드의 표지/죽은 버튼, 인라인의 src iframe 등을 모두 걷어내고 재구성.
      el.innerHTML = ''
      el.removeAttribute('data-export-embed')

      const bar = document.createElement('div')
      bar.style.cssText =
        'display:flex;justify-content:flex-end;margin-bottom:6px'
      const a = document.createElement('a')
      a.setAttribute('href', dataUri)
      a.setAttribute('download', filename)
      a.textContent = '⬇ HTML 다운로드'
      a.style.cssText =
        'font-size:12px;color:#2563eb;text-decoration:none;border:1px solid #e4e4e7;border-radius:6px;padding:2px 8px;background:#fff'
      bar.appendChild(a)

      const iframe = document.createElement('iframe')
      // 라이브와 동일하게 격리 + 스크립트 허용(null origin).
      iframe.setAttribute('sandbox', 'allow-scripts')
      iframe.setAttribute('srcdoc', html)
      iframe.setAttribute('title', filename)
      iframe.style.cssText =
        'width:100%;border:1px solid #e4e4e7;border-radius:6px;background:#fff;height:' +
        height
      el.appendChild(bar)
      el.appendChild(iframe)
    } catch (err) {
      console.warn('[html-export] embed inline failed', bundleId || fileId, err)
    }
  }
}

async function fetchBundleText(bundleId, relPath) {
  const clean = String(relPath || '').replace(/^\/+/, '')
  const res = await apiClient.get(`/api/embed/${bundleId}/${clean}`, {
    responseType: 'text',
  })
  return typeof res.data === 'string' ? res.data : String(res.data ?? '')
}

async function fetchBundleDataUri(bundleId, relPath) {
  const clean = String(relPath || '').replace(/^\/+/, '')
  const res = await apiClient.get(`/api/embed/${bundleId}/${clean}`, {
    responseType: 'blob',
  })
  return blobToDataUri(res.data)
}

// entryPath 의 디렉터리 기준으로 상대경로를 정규화(. / .. 처리).
function resolveRelative(entryPath, ref) {
  const baseDir = String(entryPath).replace(/[^/]*$/, '') // 마지막 세그먼트 제거
  const stack = baseDir.split('/').filter(Boolean)
  for (const seg of String(ref).split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') stack.pop()
    else stack.push(seg)
  }
  return stack.join('/')
}

function isExternalRef(ref) {
  return (
    !ref ||
    /^(https?:|data:|blob:|mailto:|#|\/\/)/i.test(ref) ||
    ref.startsWith('/')
  )
}

// 진입 HTML 의 상대 <link rel=stylesheet> / <script src> / <img src> 를 번들에서
// 받아 인라인한다. (한 단계 — css 안의 url() 중첩 인라인까진 가지 않는다.)
async function inlineBundleAssets(html, bundleId, entryPath) {
  let doc
  try {
    doc = new DOMParser().parseFromString(html, 'text/html')
  } catch {
    return html // 파싱 실패 시 원문 그대로(상대경로는 깨질 수 있음)
  }

  const tasks = []

  doc.querySelectorAll('link[rel~="stylesheet"][href]').forEach((link) => {
    const href = link.getAttribute('href')
    if (isExternalRef(href)) return
    tasks.push(
      (async () => {
        try {
          const css = await fetchBundleText(
            bundleId,
            resolveRelative(entryPath, href),
          )
          const style = doc.createElement('style')
          style.textContent = css
          link.replaceWith(style)
        } catch (err) {
          console.warn('[html-export] embed css inline failed', href, err)
        }
      })(),
    )
  })

  doc.querySelectorAll('script[src]').forEach((script) => {
    const src = script.getAttribute('src')
    if (isExternalRef(src)) return
    tasks.push(
      (async () => {
        try {
          const js = await fetchBundleText(
            bundleId,
            resolveRelative(entryPath, src),
          )
          const inline = doc.createElement('script')
          // type 등 속성 보존(src 만 제거).
          for (const attr of Array.from(script.attributes)) {
            if (attr.name !== 'src') inline.setAttribute(attr.name, attr.value)
          }
          inline.textContent = js
          script.replaceWith(inline)
        } catch (err) {
          console.warn('[html-export] embed script inline failed', src, err)
        }
      })(),
    )
  })

  doc.querySelectorAll('img[src]').forEach((img) => {
    const src = img.getAttribute('src')
    if (isExternalRef(src)) return
    tasks.push(
      (async () => {
        try {
          const dataUri = await fetchBundleDataUri(
            bundleId,
            resolveRelative(entryPath, src),
          )
          img.setAttribute('src', dataUri)
          img.removeAttribute('srcset')
        } catch (err) {
          console.warn('[html-export] embed img inline failed', src, err)
        }
      })(),
    )
  })

  await Promise.all(tasks)
  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML
}
