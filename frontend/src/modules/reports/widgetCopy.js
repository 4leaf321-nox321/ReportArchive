/** 뷰 모드에서 위젯 내용을 클립보드/파일로 손쉽게 내보내는 헬퍼.
 *
 *  1차 범위(요청): 긴 글(rich_text) → 글자, 표(table) → TSV, 차트·산점도
 *  (chart/scatter) → 이미지. 운영서버가 평문 HTTP 라 이미지 클립보드
 *  (navigator.clipboard.write)는 secure-context 전용으로 불가 → 차트는
 *  PNG 다운로드로 대체한다. 텍스트/표는 HTTP-safe 폴백(copyTextToClipboard).
 */
import { toast } from 'sonner'
import { copyTextToClipboard } from '@/shared/lib/clipboard'
import { toTsv } from '@/modules/templates/widgets/_shared'

const TEXT_TYPES = new Set(['rich_text'])
const TABLE_TYPES = new Set(['table'])
const IMAGE_TYPES = new Set(['chart', 'scatter'])

export function isWidgetCopyable(type) {
  return TEXT_TYPES.has(type) || TABLE_TYPES.has(type) || IMAGE_TYPES.has(type)
}

/** 버튼 아이콘/툴팁 결정용 — 'text' | 'table' | 'image' | null. */
export function widgetCopyKind(type) {
  if (IMAGE_TYPES.has(type)) return 'image'
  if (TABLE_TYPES.has(type)) return 'table'
  if (TEXT_TYPES.has(type)) return 'text'
  return null
}

function richTextToPlain(content) {
  const items = Array.isArray(content?.items) ? content.items : []
  return items
    .map((it) => {
      const depth = Math.max(0, Math.floor(Number(it?.depth) || 0))
      const text = typeof it?.text === 'string' ? it.text : ''
      return '  '.repeat(depth) + text
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function tableToTsvText(content) {
  const cols = Array.isArray(content?.columns) ? content.columns : []
  const rows = Array.isArray(content?.rows) ? content.rows : []
  if (cols.length === 0) return ''
  const header = cols.map((c) => c.label || c.key || '')
  const body = rows.map((r) => cols.map((c) => r?.[c.key]))
  return toTsv([header, ...body])
}

function safeFileName(s) {
  return (s || 'chart')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80)
}

/** 위젯 DOM(#block-<id>)을 PNG 로 떠서 다운로드. DOCX export 와 동일한
 *  html2canvas 옵션 — data-export-skip 노드(액션 버튼/단락 구분 strip)는 제외. */
async function downloadWidgetPng(blockId, label) {
  const el = document.getElementById(`block-${blockId}`)
  if (!el) throw new Error('캡처할 위젯 영역을 찾을 수 없습니다.')
  const html2canvas = (await import('html2canvas')).default
  const canvas = await html2canvas(el, {
    scale: 2,
    backgroundColor: '#ffffff',
    logging: false,
    useCORS: true,
    ignoreElements: (node) => node?.dataset?.exportSkip != null,
  })
  const blob = await new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b), 'image/png'),
  )
  if (!blob) throw new Error('이미지 생성에 실패했습니다.')
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${safeFileName(label)}.png`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // 일부 브라우저가 즉시 revoke 시 다운로드를 취소 → 잠시 뒤에 해제.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 렌더된 표(#block-<id> 안의 <table>)를 HTML 그대로 클립보드에 복사한다.
 *  선택영역 + execCommand('copy') 트릭 — text/html 과 text/plain 을 함께
 *  올려, PPT·Word 엔 "표"로, 엑셀엔 "셀"로 붙는다. ClipboardItem(text/html)
 *  과 달리 secure-context 가 필요 없어 HTTP 에서도 동작한다.
 *  화면 표가 깜빡이지 않도록 클론을 화면 밖에서 선택한다. 붙여넣을 때 표
 *  모양이 살도록 셀에 인라인 테두리를 입힌다. 성공 시 true. */
function copyRenderedTableHtml(blockId) {
  const card = document.getElementById(`block-${blockId}`)
  const table = card?.querySelector('table')
  if (!table) return false
  const clone = table.cloneNode(true)
  clone.style.borderCollapse = 'collapse'
  // 셀의 배경/글자색/굵기/정렬은 토큰 클래스로 입혀져 있어 HTML 을 붙여넣으면
  // (PPT·Word 가 외부 CSS 를 버리므로) 사라진다. 원본 셀의 *계산된* 스타일을
  // 클론 셀에 인라인으로 옮겨, 붙여넣을 때 표 모양(색·테두리)이 살게 한다.
  const origCells = table.querySelectorAll('th,td')
  const cloneCells = clone.querySelectorAll('th,td')
  origCells.forEach((oc, i) => {
    const cc = cloneCells[i]
    if (!cc) return
    const cs = window.getComputedStyle(oc)
    cc.style.border = '1px solid #999'
    cc.style.padding = '4px 8px'
    if (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)') {
      cc.style.backgroundColor = cs.backgroundColor
    }
    if (cs.color) cc.style.color = cs.color
    cc.style.fontWeight = cs.fontWeight
    cc.style.textAlign = cs.textAlign
  })
  const holder = document.createElement('div')
  holder.style.position = 'fixed'
  holder.style.left = '-9999px'
  holder.style.top = '0'
  holder.appendChild(clone)
  document.body.appendChild(holder)
  try {
    const range = document.createRange()
    range.selectNodeContents(holder)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
    const ok = document.execCommand('copy')
    sel.removeAllRanges()
    return ok
  } catch {
    return false
  } finally {
    document.body.removeChild(holder)
  }
}

/** 뷰 모드 카드의 복사 버튼 핸들러.
 *  - 긴 글: 텍스트로 클립보드 복사 (HTTP-safe).
 *  - 표: 렌더된 HTML 표로 복사 → PPT·Word 엔 표, 엑셀엔 셀. 실패 시 TSV 폴백.
 *  - 차트/산점도: PNG 다운로드 (HTTP 에선 이미지 클립보드 불가). */
export async function copyWidget({ type, content, blockId, label }) {
  try {
    if (IMAGE_TYPES.has(type)) {
      await downloadWidgetPng(blockId, label || content?.caption || type)
      toast.success('차트 이미지를 PNG로 저장했습니다.')
      return
    }
    if (TABLE_TYPES.has(type)) {
      if (copyRenderedTableHtml(blockId)) {
        toast.success('표를 복사했습니다 — PPT·Word엔 표로, 엑셀엔 셀로 붙여넣기.')
        return
      }
      // 폴백: 렌더된 표를 못 찾으면 데이터로 만든 TSV 텍스트.
      const tsv = tableToTsvText(content)
      if (!tsv.trim()) {
        toast.info('복사할 내용이 없습니다.')
        return
      }
      await copyTextToClipboard(tsv)
      toast.success('표를 복사했습니다 (엑셀 등에 붙여넣기).')
      return
    }
    const text = richTextToPlain(content)
    if (!text.trim()) {
      toast.info('복사할 내용이 없습니다.')
      return
    }
    await copyTextToClipboard(text)
    toast.success('글을 복사했습니다.')
  } catch (e) {
    toast.error('복사 실패', { description: String(e?.message ?? e) })
  }
}
