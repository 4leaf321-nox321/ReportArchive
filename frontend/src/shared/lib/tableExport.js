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
