/** 표 위젯 → pptxgenjs 네이티브 표 변환 (PPT 내보내기).
 *
 *  table / raci_matrix / comparison 을 이미지가 아니라 편집 가능한 PPT 표로
 *  만든다. 렌더된 <table> DOM 을 그대로 파싱하면 병합(colspan/rowspan)·셀 색·
 *  정렬·다중행 헤더가 이미 풀려 있어 거의 1:1 로 옮길 수 있다(HTML 표는 병합에
 *  가려진 셀을 생략하는데, pptxgenjs 도 같은 모델이라 <tr>/<td> 순회가 맞는다).
 *
 *  한계: PPT 표 셀에는 이미지를 못 넣는다 → 셀에 <img>/<canvas>/<svg> 가 있으면
 *  (비교표의 이미지 행 등) null 을 돌려 호출부가 이미지 캡처로 폴백하게 한다.
 *  셀 안 부분(per-char) 색은 셀 단위 색으로 평탄화된다(셀 전체 색은 보존).
 */
import { cssColorToHex } from './exportCapture'

export const NATIVE_TABLE_TYPES = new Set(['table', 'raci_matrix', 'comparison', 'fmea'])

/** autoFit 측정용 mirror 가 아닌 *보이는* <table>. */
function findVisibleTable(blockEl) {
  const tables = blockEl.querySelectorAll('table')
  for (const t of tables) {
    if (!t.closest('.report-autofit-mirror')) return t
  }
  return tables[0] || null
}

/** 셀 텍스트 추출 — 숨은 tooltip/액션은 빼고 <br>·블록 경계는 줄바꿈으로. */
function cellText(td) {
  const clone = td.cloneNode(true)
  clone.querySelectorAll('[role="tooltip"], [data-export-skip]').forEach((n) => n.remove())
  clone.querySelectorAll('br').forEach((br) => br.replaceWith('\n'))
  clone.querySelectorAll('p, div').forEach((b) => {
    if (b.nextSibling) b.after('\n')
  })
  return (clone.textContent ?? '')
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

function alignOf(textAlign) {
  if (textAlign === 'right' || textAlign === 'end') return 'right'
  if (textAlign === 'center') return 'center'
  return 'left'
}

/** 렌더된 표 → { rows, colW } (pptxgenjs addTable 용). 이미지 셀이 있거나 표가
 *  없으면 null. ctx: { ptPerPx, tableWidthIn }. */
export function buildPptxTable(blockEl, ctx) {
  const table = findVisibleTable(blockEl)
  if (!table) return null
  // 표 셀에 이미지가 들어가면 네이티브 표로 못 옮김 → 폴백.
  if (table.querySelector('img, canvas, svg')) return null

  const trs = Array.from(table.querySelectorAll('tr')).filter((tr) =>
    Array.from(tr.children).some((c) => /^(td|th)$/i.test(c.tagName)),
  )
  if (trs.length === 0) return null

  const ptPerPx = Number.isFinite(ctx?.ptPerPx) && ctx.ptPerPx > 0 ? ctx.ptPerPx : 1
  const toPt = (px) => Math.max(6, Math.round((px || 14) * ptPerPx))

  const rows = trs.map((tr) => {
    const cells = Array.from(tr.children).filter((c) => /^(td|th)$/i.test(c.tagName))
    return cells.map((td) => {
      const cs = window.getComputedStyle(td)
      const opt = {
        fontSize: toPt(parseFloat(cs.fontSize)),
        align: alignOf(cs.textAlign),
        valign: 'middle',
      }
      const fg = cssColorToHex(cs.color)
      if (fg) opt.color = fg
      const bg = cssColorToHex(cs.backgroundColor, { compositeWhite: true })
      if (bg) opt.fill = { color: bg }
      if (td.tagName.toLowerCase() === 'th' || Number(cs.fontWeight) >= 600) {
        opt.bold = true
      }
      const colspan = parseInt(td.getAttribute('colspan') || '1', 10)
      const rowspan = parseInt(td.getAttribute('rowspan') || '1', 10)
      if (colspan > 1) opt.colspan = colspan
      if (rowspan > 1) opt.rowspan = rowspan
      return { text: cellText(td), options: opt }
    })
  })

  // 컬럼 폭 — colgroup 의 col 비율로(있을 때). 합이 표 폭(인치)이 되게 정규화.
  let colW
  const cols = Array.from(table.querySelectorAll('colgroup > col'))
  const tableWidthIn = Number.isFinite(ctx?.tableWidthIn) ? ctx.tableWidthIn : null
  if (cols.length > 0 && tableWidthIn) {
    const widths = cols.map((c) => c.getBoundingClientRect().width || 0)
    const sum = widths.reduce((s, w) => s + w, 0)
    if (sum > 0) colW = widths.map((w) => (w / sum) * tableWidthIn)
  }

  return { rows, colW }
}
