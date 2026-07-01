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

// 머리표 → 깊이(글자). 워드·PPT·마크다운이 쓰는 다양한 불릿 글리프를 폭넓게
// 잡아 제거한다 — 여기서 원문 불릿을 못 떼면, 위젯이 자기 depth 글리프(■/-/·)를
// 또 붙여 "불릿이 두 개" 로 보인다. RichText.PREFIX_TO_DEPTH 와 취지를 맞춘다.
const BULLET_RE = /^([-*•◦▪‣⁃●○·・–—■□▢▷◆◇▸➔→§❖])\s+/

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
  // 앞뒤 공백을 뗀 뒤에도 탭이 남아 있으면(=값 사이 구분 탭) 표 행으로 본다.
  // PPT·워드의 "들여쓰기용 앞쪽 탭"만 있는 줄은 표로 오인하지 않는다.
  if (line.trim().includes('\t')) return true
  // 파이프가 2개 이상이면 마크다운 표 행으로 본다(단일 | 인 문장 오검출 방지).
  return (line.match(/\|/g) || []).length >= 2
}

/** 표 행 한 줄 → 셀 배열. 마크다운(파이프)·TSV(탭) 모두 처리. */
function splitTableRow(line) {
  const trimmed = line.trim()
  if (trimmed.includes('\t') && !trimmed.includes('|')) {
    return trimmed.split('\t').map((c) => c.trim())
  }
  const s = trimmed.replace(/^\|/, '').replace(/\|$/, '')
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
  if (s.type === 'heading') return s.content?.text ?? ''
  if (s.type === 'image') return s.alt || '이미지'
  if (s.type === 'table') {
    const c = s.content
    return `${c.columns.length}열 × ${c.rows.length + 1}행`
  }
  const first = s.content?.items?.[0]?.text ?? ''
  const n = s.content?.items?.length ?? 0
  return n > 1 ? `${first} … (${n}줄)` : first
}

/**
 * 붙여넣은 텍스트를 위젯 descriptor 배열로 분해한다.
 * @param {string} text 붙여넣은 평문(마크다운 포함)
 * @returns {Array<{type, content, kind, preview}>}
 */
export function parseTextToWidgets(text) {
  const src = (text ?? '')
    .replace(/\r\n?/g, '\n')
    // PPT·일부 앱은 줄바꿈에 세로탭(\v)·폼피드(\f)·줄/문단 분리자(U+2028/2029)·
    // NEL(U+0085)을 쓴다. 이걸 개행으로 정규화하지 않으면 여러 줄이 한 덩어리로
    // 붙어 붙여넣기→위젯 분해가 제대로 안 된다.
    .replace(/[\v\f\u2028\u2029\u0085]/g, '\n')
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

// --------------------------------------------------------------------------- //
// HTML(text/html) 파서 — 워드·PPT·웹에서 복사한 서식 있는 붙여넣기용            //
// --------------------------------------------------------------------------- //
// PPT 텍스트박스(도형)를 복사하면 text/plain 이 비어 text/html 만 온다. 워드는
// 문단·목록·표·이미지 구조를 text/html 로 준다. 그래서 html 이 있으면 이걸
// 우선 파싱해 세그먼트(heading/rich_text/table/image)로 만든다. 이미지 세그먼트는
// { type:'image', src } 로 두고, 위젯 생성 시점에 업로드한다.

const _BLOCKISH = /^(H[1-6]|P|DIV|SECTION|ARTICLE|BLOCKQUOTE|LI|UL|OL|TABLE|IMG|BR|HR|FIGURE)$/

/** 이 요소 안에 블록 구조가 더 있는지(있으면 재귀, 없으면 textContent 한 덩어리). */
function hasBlockDescendant(el) {
  return !!el.querySelector('h1,h2,h3,h4,h5,h6,ul,ol,table,img,p,div,li')
}

export function parseHtmlToWidgets(html) {
  if (!html || typeof window === 'undefined' || !window.DOMParser) return []
  let doc
  try {
    doc = new DOMParser().parseFromString(html, 'text/html')
  } catch {
    return []
  }
  if (!doc?.body) return []

  const segments = []
  let textBuf = [] // { depth, text }

  function flushText() {
    const items = textBuf.filter((it) => (it.text ?? '').trim() !== '')
    textBuf = []
    if (!items.length) return
    const isList = items.some((it) => it.depth > 0)
    segments.push({ type: 'rich_text', content: { items }, kind: isList ? '목록' : '문단', preview: '' })
  }
  function pushHeading(el, level) {
    const text = (el.textContent || '').trim()
    if (!text) return
    flushText()
    segments.push({ type: 'heading', content: { text, level: Math.min(3, Math.max(1, level)) }, kind: '제목', preview: '' })
  }
  function pushImage(el) {
    const src = el.getAttribute('src') || ''
    if (!src) return
    flushText()
    segments.push({ type: 'image', src, alt: el.getAttribute('alt') || '', kind: '이미지', preview: '' })
  }
  function pushTable(el) {
    const rows = Array.from(el.querySelectorAll('tr'))
      .map((tr) => Array.from(tr.querySelectorAll('th,td')).map((c) => (c.textContent || '').replace(/\s+/g, ' ').trim()))
      .filter((r) => r.length > 0)
    if (!rows.length) return
    flushText()
    const colCount = rows.reduce((m, r) => Math.max(m, r.length), 0)
    const header = rows[0]
    const columns = Array.from({ length: colCount }, (_, i) => ({
      key: `col_${i + 1}`,
      label: header[i] || `열 ${i + 1}`,
      type: 'text',
    }))
    const body = rows.slice(1).map((r) => {
      const o = {}
      columns.forEach((c, i) => {
        o[c.key] = r[i] ?? ''
      })
      return o
    })
    segments.push({ type: 'table', content: { columns, rows: body }, kind: '표', preview: '' })
  }
  function walkList(listEl, depth) {
    for (const li of Array.from(listEl.children)) {
      if (li.tagName !== 'LI') continue
      // li 직속 텍스트만 모으고, 중첩 목록은 depth+1 로 재귀.
      let text = ''
      const nestedLists = []
      for (const node of Array.from(li.childNodes)) {
        if (node.nodeType === 3) text += node.textContent
        else if (node.nodeType === 1) {
          if (node.tagName === 'UL' || node.tagName === 'OL') nestedLists.push(node)
          else if (node.tagName === 'IMG') pushImage(node)
          else text += node.textContent
        }
      }
      text = text.replace(/\s+/g, ' ').trim()
      if (text) textBuf.push({ depth: Math.min(MAX_DEPTH, Math.max(1, depth)), text })
      for (const n of nestedLists) walkList(n, depth + 1)
    }
  }
  function walk(node) {
    for (const el of Array.from(node.children)) {
      const tag = el.tagName
      if (/^H[1-6]$/.test(tag)) pushHeading(el, Number(tag[1]))
      else if (tag === 'UL' || tag === 'OL') walkList(el, 1)
      else if (tag === 'TABLE') pushTable(el)
      else if (tag === 'IMG') pushImage(el)
      else if (tag === 'BR' || tag === 'HR') {
        /* 문단 경계 — 텍스트 버퍼는 유지(줄바꿈은 문단 내부로 흡수) */
      } else if (_BLOCKISH.test(tag)) {
        if (hasBlockDescendant(el)) {
          walk(el)
        } else {
          // lineToItem 으로 워드 mso-list 문단의 앞 불릿 글리프(·•– 등)를 제거해
          // 위젯 depth 글리프와 이중 표기되는 걸 막는다.
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim()
          if (text) textBuf.push(lineToItem(text))
          for (const img of Array.from(el.querySelectorAll('img'))) pushImage(img)
        }
      } else {
        // span/a/b 등 인라인 컨테이너 — 블록이 더 있으면 재귀, 아니면 텍스트.
        if (hasBlockDescendant(el)) walk(el)
        else {
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim()
          if (text) textBuf.push(lineToItem(text))
        }
      }
    }
  }

  walk(doc.body)
  flushText()
  return segments.map((s) => ({ ...s, preview: summarize(s) }))
}

/** data:/blob:/http(s) 이미지 src 는 fetch 로 바이트를 얻어 업로드할 수 있다.
 *  file:// 등 접근 불가한 로컬 경로는 브라우저 보안상 못 읽으므로 건너뛴다. */
export function isFetchableImageSrc(src) {
  return /^(data:|blob:|https?:)/i.test(src || '')
}

/** SVG(image/svg+xml) 텍스트 → 위젯 세그먼트. PowerPoint 는 텍스트박스/도형을
 *  복사할 때 text/plain·text/html 없이 image/svg+xml + 래스터 이미지만 클립보드에
 *  담는데, SVG 는 XML 이라 <text>/<tspan> 안에 실제 글자가 들어 있다. 이를 뽑아
 *  문단/목록으로 만든다(글자가 없으면 [] → 호출부가 이미지로 폴백). */
const _BULLET_GLYPH_RE = /^[•◦▪‣⁃●○·・∙◆◇▸➔→§❖–—-]$/

/** <text> 의 화면 좌표(x,y) — PPT 는 transform="translate(x y)" 로 배치한다. */
function _svgTextPos(el) {
  const tr = el.getAttribute('transform') || ''
  const m = /translate\(\s*(-?[\d.]+)[ ,]+(-?[\d.]+)/.exec(tr)
  if (m) return { x: parseFloat(m[1]) || 0, y: parseFloat(m[2]) || 0 }
  return {
    x: parseFloat(el.getAttribute('x') || '0') || 0,
    y: parseFloat(el.getAttribute('y') || '0') || 0,
  }
}

export function parseSvgToWidgets(svgText) {
  if (!svgText || typeof window === 'undefined' || !window.DOMParser) return []
  let doc
  try {
    doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
  } catch {
    return []
  }
  if (!doc || doc.getElementsByTagName('parsererror').length) return []

  // 각 <text> 를 run(좌표+글자)으로. PPT 는 한 시각적 줄을 여러 <text> 로 쪼갠다
  // (특히 불릿 글리프 "•" 를 텍스트와 별도 <text> 로) → y 로 줄을 묶고 x 로 정렬.
  const runs = Array.from(doc.getElementsByTagName('text'))
    .map((el) => {
      const { x, y } = _svgTextPos(el)
      return { x, y, text: (el.textContent || '').replace(/\s+/g, ' ').trim() }
    })
    .filter((r) => r.text)
  if (!runs.length) return []
  runs.sort((a, b) => a.y - b.y || a.x - b.x)

  const Y_TOL = 8 // 같은 줄로 볼 y 오차(px)
  const groups = []
  let cur = null
  for (const r of runs) {
    if (cur && Math.abs(r.y - cur.y) <= Y_TOL) cur.runs.push(r)
    else {
      cur = { y: r.y, runs: [r] }
      groups.push(cur)
    }
  }

  const lines = []
  for (const g of groups) {
    g.runs.sort((a, b) => a.x - b.x)
    let bulleted = false
    const parts = []
    for (const r of g.runs) {
      // 줄 맨 앞의 단독 불릿 글리프는 마커로 취급(텍스트에서 뺀다 → 목록 depth).
      if (parts.length === 0 && _BULLET_GLYPH_RE.test(r.text)) {
        bulleted = true
        continue
      }
      parts.push(r.text)
    }
    const text = parts.join(' ').replace(/\s+/g, ' ').trim()
    if (!text) continue
    // 불릿 줄은 "- " 를 붙여 parseTextToWidgets 가 depth 1 로 잡게 한다.
    lines.push((bulleted ? '- ' : '') + text)
  }
  if (!lines.length) return []
  return parseTextToWidgets(lines.join('\n'))
}

