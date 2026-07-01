// 붙여넣기 → 여러 위젯 분해(④). 붙여넣은 텍스트(마크다운/워드 평문/엑셀 TSV)를
// 세그먼트로 나눠 heading / rich_text / table 위젯 descriptor 로 변환한다.
//
// 반환: [{ type, content, kind, preview }]
//   - type    : 'heading' | 'rich_text' | 'table' (위젯 레지스트리 키)
//   - content : 각 위젯의 page.content[blockId] 에 시드할 값
//   - kind    : 미리보기 뱃지용 사람이 읽는 분류('제목'|'문단'|'목록'|'표')
//   - preview : 미리보기 한 줄 요약
//
// 위젯 경계를 넘는 자동 분해는 여기서만 하고, rich_text 위젯 *내부*의 여러 행은
// RichText.jsx 의 아웃라인 모델({ items:[{depth,text}] })을 그대로 따른다.

const MAX_DEPTH = 5

// 머리표 → 깊이(글자). RichText.PREFIX_TO_DEPTH 와 취지를 맞춘다.
const BULLET_RE = /^([-*•·◦▪▸➔→–])\s+/

/** 한 줄에서 (깊이, 텍스트) 추출. 앞 공백/탭(들여쓰기)과 머리표를 깊이로 흡수. */
function lineToItem(rawLine) {
  // 탭 1개 = 2칸으로 환산해 들여쓰기 깊이 계산.
  const expanded = rawLine.replace(/\t/g, '  ')
  const leading = expanded.length - expanded.trimStart().length
  let depth = Math.floor(leading / 2)
  let text = expanded.trim()
  // 마크다운/불릿 목록 머리표 제거 — 있으면 최소 깊이 1.
  const bullet = BULLET_RE.exec(text)
  if (bullet) {
    text = text.slice(bullet[0].length)
    depth = Math.max(depth, 1)
  } else {
    // 번호 목록(1. / 1)) 머리표 제거.
    const numbered = /^\d+[.)]\s+/.exec(text)
    if (numbered) {
      text = text.slice(numbered[0].length)
      depth = Math.max(depth, 1)
    }
  }
  return { depth: Math.min(MAX_DEPTH, Math.max(0, depth)), text }
}

/** 마크다운 구분줄(---|:--:| 등)인가 — 표 헤더/본문 사이 줄. */
function isTableSeparator(line) {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && /-/.test(line)
}

/** 표처럼 보이는 줄인가 — 마크다운 파이프 또는 탭 구분(엑셀/시트). */
function looksTabular(line) {
  if (isTableSeparator(line)) return true
  if (line.includes('\t')) return true
  // 파이프가 2개 이상이면 마크다운 표 행으로 본다(단일 | 인 문장 오검출 방지).
  return (line.match(/\|/g) || []).length >= 2
}

/** 표 행 한 줄 → 셀 배열. 마크다운(파이프)·TSV(탭) 모두 처리. */
function splitTableRow(line) {
  if (line.includes('\t') && !line.includes('|')) {
    return line.split('\t').map((c) => c.trim())
  }
  let s = line.trim()
  s = s.replace(/^\|/, '').replace(/\|$/, '')
  return s.split('|').map((c) => c.trim())
}

/** 표 세그먼트(줄 배열) → table content { columns, rows }. Table.jsx 의
 *  col_N 열키/행 객체 구조를 그대로 따른다. 첫 줄을 헤더로 쓴다. */
function buildTable(lines) {
  const rows = lines.filter((l) => !isTableSeparator(l)).map(splitTableRow)
  if (rows.length === 0) return null
  const colCount = rows.reduce((m, r) => Math.max(m, r.length), 0)
  if (colCount === 0) return null
  const header = rows[0]
  const columns = Array.from({ length: colCount }, (_, i) => ({
    key: `col_${i + 1}`,
    label: header[i]?.trim() || `열 ${i + 1}`,
    type: 'text',
  }))
  const bodyRows = rows.slice(1).map((r) => {
    const obj = {}
    columns.forEach((c, i) => {
      obj[c.key] = r[i] ?? ''
    })
    return obj
  })
  return { columns, rows: bodyRows }
}

/** 텍스트 그룹(연속 문단/목록 줄) → rich_text content { items }. */
function buildRichText(lines) {
  const items = lines
    .filter((l) => l.trim() !== '')
    .map(lineToItem)
  if (items.length === 0) return null
  return { items }
}

/** 위젯 미리보기 한 줄 요약(최대 40자). */
function summarize(s) {
  if (s.type === 'heading') return s.content.text
  if (s.type === 'table') {
    const c = s.content
    return `${c.columns.length}열 × ${c.rows.length + 1}행`
  }
  const first = s.content.items?.[0]?.text ?? ''
  const n = s.content.items?.length ?? 0
  return n > 1 ? `${first} … (${n}줄)` : first
}

/**
 * 붙여넣은 텍스트를 위젯 descriptor 배열로 분해한다.
 * @param {string} text 붙여넣은 평문(마크다운 포함)
 * @returns {Array<{type, content, kind, preview}>}
 */
export function parseTextToWidgets(text) {
  const src = (text ?? '').replace(/\r\n?/g, '\n')
  const lines = src.split('\n')
  const segments = []

  // 현재 누적 중인 텍스트(문단/목록) 그룹.
  let textBuf = []
  // 현재 누적 중인 표 줄 그룹.
  let tableBuf = []

  function flushText() {
    if (textBuf.length === 0) return
    const content = buildRichText(textBuf)
    textBuf = []
    if (!content) return
    // 들여쓰기(depth>0)가 있으면 '목록', 아니면 '문단'(여러 줄이어도 평문 문단).
    const isList = content.items.some((it) => it.depth > 0)
    segments.push({
      type: 'rich_text',
      content,
      kind: isList ? '목록' : '문단',
      preview: '',
    })
  }
  function flushTable() {
    if (tableBuf.length === 0) return
    const content = buildTable(tableBuf)
    tableBuf = []
    if (!content) return
    segments.push({ type: 'table', content, kind: '표', preview: '' })
  }

  for (const line of lines) {
    const trimmed = line.trim()
    // 빈 줄 → 현재 그룹 경계.
    if (trimmed === '') {
      flushText()
      flushTable()
      continue
    }
    // 표 행(파이프/탭) — 텍스트 그룹을 닫고 표 그룹에 누적.
    if (looksTabular(line)) {
      flushText()
      tableBuf.push(line)
      continue
    }
    // 표 그룹 진행 중 표 아닌 줄을 만나면 표를 닫는다.
    if (tableBuf.length > 0) flushTable()
    // 마크다운 제목 — 독립 heading 세그먼트.
    const h = /^(#{1,6})\s+(.+)$/.exec(trimmed)
    if (h) {
      flushText()
      segments.push({
        type: 'heading',
        content: { text: h[2].trim(), level: Math.min(3, h[1].length) },
        kind: '제목',
        preview: '',
      })
      continue
    }
    // 그 외 — 문단/목록 텍스트로 누적.
    textBuf.push(line)
  }
  flushText()
  flushTable()

  return segments.map((s) => ({ ...s, preview: summarize(s) }))
}
