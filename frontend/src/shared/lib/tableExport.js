/** 표 행들을 TSV(탭 구분·줄바꿈 행) 문자열로 만든다 — 그리드 "표 복사"용.
 *
 *  탭 구분이라 엑셀/그리드 붙여넣기와 그대로 왕복(round-trip)한다. 셀 안의
 *  탭·줄바꿈은 공백으로 눌러 열/행이 깨지지 않게 한다. headers 를 주면 첫 줄에
 *  열 이름을 붙인다(내보낸 TSV 를 다시 그리드에 붙여넣을 때, 그리드의 붙여넣기
 *  핸들러가 이 헤더 줄을 건너뛰도록 되어 있으면 왕복도 깔끔하다).
 *
 *  실제 클립보드 복사는 shared/lib/clipboard 의 copyTextToClipboard 를 쓴다
 *  (HTTP 비보안 컨텍스트에서도 execCommand 폴백으로 동작).
 */
export function rowsToTsv(rows, headers = null) {
  const clean = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ')
  const lines = []
  if (headers) lines.push(headers.map(clean).join('\t'))
  for (const r of rows) lines.push(r.map(clean).join('\t'))
  return lines.join('\n')
}

/** 표 행들을 CSV 문자열로 만든다 — 파일 저장용.
 *
 *  TSV 와 달리 값을 눌러 담지 않고 **RFC 4180 로 escape** 한다: 쉼표·따옴표·
 *  줄바꿈이 든 값은 따옴표로 감싸고 내부 따옴표는 ""로 이중화. 파일로 저장돼
 *  나중에 다시 열리는 물건이라 원본을 보존하는 쪽이 맞다(클립보드 왕복용 TSV 는
 *  그리드가 열/행을 못 읽으면 곤란해서 눌러 담는 게 맞고).
 *
 *  줄바꿈은 CRLF — 엑셀이 셀 안 줄바꿈과 행 구분을 헷갈리지 않는다.
 */
export function rowsToCsv(rows, headers = null) {
  const cell = (v) => {
    const s = String(v ?? '')
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = []
  if (headers) lines.push(headers.map(cell).join(','))
  for (const r of rows) lines.push(r.map(cell).join(','))
  return lines.join('\r\n')
}

/** 텍스트를 파일로 내려받는다(브라우저 다운로드).
 *
 *  CSV 는 UTF-8 BOM 을 붙인다 — 없으면 엑셀(특히 한국어 Windows)이 CP949 로 읽어
 *  한글이 깨진다. 서버 왕복 없이 Blob 으로 만들어 받으므로 HTTP 환경에서도 동작
 *  한다(클립보드와 달리 보안 컨텍스트 제약이 없음).
 */
export function downloadTextFile(filename, text, { mime = 'text/plain', bom = false } = {}) {
  const blob = new Blob([bom ? '﻿' : '', text], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 즉시 revoke 하면 일부 브라우저에서 다운로드가 취소된다 — 다음 틱에.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
