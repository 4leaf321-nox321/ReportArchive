import { createContext, useContext, useState } from 'react'
import { Maximize2, Minimize2 } from 'lucide-react'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { AutoGrowTextarea, CaptionInput, DataTableActions, DEFAULT_BODY_FONT_PX, FieldItemListEditor, LabelField, PreviewLabel, TextStyleField, captionSkipProps, computeMergeMap, normalizeMerges, shiftMergesForCol, shiftMergesForRow, textStyleToClassName, textStyleToInlineStyle, toTsv, useCellSelection, useGridNavigation } from './_shared'

/**
 * "표 전체 펼치기" 토글의 공유 state. BlockEditorCard 가 위젯마다
 * Provider 로 감싸서, 자동맞춤 측정용 mirror 와 사용자가 보는 본체 두
 * TableEditor 인스턴스가 같은 expanded 값을 보게 한다. 같은 인스턴스를
 * 두 번 렌더하는 widget 측정 패턴 때문에 로컬 useState 로는 동기화가
 * 안 돼서 (본체만 펴지고 mirror 는 compact 유지 → 측정된 높이가 그대로
 * → 컨테이너가 안 자람) Context 로 끌어올렸음.
 *
 * Provider 없는 일반적인 렌더(예: 다이얼로그 미리보기, InlineReportView)
 * 에서는 default value 가 적용 — local useState 와 동일한 fallback 으로
 * 동작한다. */
export const TableViewContext = createContext(null)

function useTableExpanded() {
  const ctx = useContext(TableViewContext)
  // Provider 가 없으면 컴포넌트 내부 useState 로 폴백. Hook 호출 위치는
  // 컴포넌트 함수 본문 한 곳이라 React 의 Rules of Hooks 와 충돌 안 함.
  // (ctx 가 null/undefined 인 경우에만 useState 가 의미 있는 값을 들고
  // 가고, ctx 가 있으면 useState 의 setter 는 그냥 무시된다.)
  const local = useState(false)
  if (ctx) return [ctx.expanded, ctx.setExpanded]
  return local
}

export function TablePropsPanel({ props, onChange }) {
  return (
    <div className="space-y-4">
      <LabelField
        label="라벨"
        value={props.label}
        onChange={(v) => onChange({ ...props, label: v })}
        placeholder="이슈 / 리스크"
      />
      <div>
        <Label className="text-xs">열</Label>
        <p className="text-[10px] text-muted-foreground mt-0.5 mb-2">
          템플릿이 열을 잠그고, 보고서가 행을 채웁니다.
        </p>
        <FieldItemListEditor
          items={props.columns ?? []}
          onChange={(columns) => onChange({ ...props, columns })}
          addLabel="열 추가"
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-xs">최소 행 수</Label>
          <Input
            type="number"
            min={0}
            value={props.min_rows ?? ''}
            onChange={(e) =>
              onChange({
                ...props,
                min_rows: e.target.value === '' ? undefined : Number(e.target.value),
              })
            }
            className="mt-1 h-9"
          />
        </div>
        <div>
          <Label className="text-xs">최대 행 수</Label>
          <Input
            type="number"
            min={1}
            value={props.max_rows ?? ''}
            onChange={(e) =>
              onChange({
                ...props,
                max_rows: e.target.value === '' ? undefined : Number(e.target.value),
              })
            }
            className="mt-1 h-9"
          />
        </div>
      </div>
      <TextStyleField
        value={props.text_style}
        onChange={(text_style) => onChange({ ...props, text_style })}
        defaultSizePx={DEFAULT_BODY_FONT_PX}
      />
    </div>
  )
}

import { ChevronDown, ChevronUp, Plus, X } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'

// 열 폭(px) 허용 범위 — 헤더 드래그·균등 분배에 공통 적용.
const COL_WIDTH_MIN_PX = 48
const COL_WIDTH_MAX_PX = 1200

export function TableEditor({ props, content, onChange, readOnly }) {
  // Effective columns: per-report override (content.columns) takes precedence
  // over template defaults (props.columns). Once the report writer touches
  // columns, content.columns becomes the full column list for this report.
  const templateCols = props.columns ?? []
  const overrideCols = content?.columns
  const cols = Array.isArray(overrideCols) ? overrideCols : templateCols
  const caption = content?.caption ?? ''
  const rows = content?.rows ?? []
  // 셀 병합 side-table. `merges = [{r,c,rs,cs}]` 형태. 빈 배열/없음이면
  // 기존 렌더와 100% 동일하게 동작. anchor 가 아닌 covered 셀은 출력 단계
  // 에서 건너뛰고, anchor 에만 rowSpan/colSpan attr 가 붙는다.
  const merges = Array.isArray(content?.merges) ? content.merges : []
  const mergeMap = computeMergeMap(merges, rows.length, cols.length)
  const bodyTextClass = textStyleToClassName(props.text_style)
  const bodyTextStyle = textStyleToInlineStyle(props.text_style)
  // 읽기 모드 전용 — "전체 펼치기" 토글. 기본은 compact (셀이 잘림 +
  // 호버 시 툴팁). 펼치면 모든 셀이 줄바꿈으로 풀려서 길어진 행도 한
  // 눈에 보인다. BlockEditorCard 가 Provider 로 감싸서 측정용 mirror 와
  // 본체가 같은 expanded 를 공유 — 그래야 펼침 시 컨테이너 높이도 같이
  // 자란다.
  const [expanded, setExpanded] = useTableExpanded()
  // 셀간 화살표 네비게이션 — 텍스트 셀은 boundary 기준, 그 외 입력
  // (number/date/select) 은 left/right boundary 이동만 (up/down 은 native).
  const grid = useGridNavigation()
  // ── 열 폭 조절 (content.column_widths) ───────────────────────────────
  // 헤더 우측 핸들을 드래그해 px 로 저장. 빠진 열은 자동(나머지 폭 균등
  // 분배). 편집/뷰 두 모드 공용 <colgroup> 으로 적용. resizePreview 는 드래그
  // 중 임시 폭 — mouseup 에 한 번만 commit.
  const columnWidths =
    content?.column_widths && typeof content.column_widths === 'object'
      ? content.column_widths
      : {}
  const [resizePreview, setResizePreview] = useState(null) // {key, px} | null

  function patch(next) {
    const merged = {
      ...(content ?? {}),
      ...(caption ? { caption } : {}),
      ...(overrideCols ? { columns: overrideCols } : {}),
      rows,
      ...next,
    }
    if (!merged.caption) delete merged.caption
    if (!merged.columns) delete merged.columns
    if (!merged.caption_skip_autofill) delete merged.caption_skip_autofill
    // 빈 폭 맵은 저장 안 함 — override 가 다시 0개가 되면 키 자체를 제거.
    if (
      !merged.column_widths ||
      Object.keys(merged.column_widths).length === 0
    ) {
      delete merged.column_widths
    }
    onChange(merged)
  }

  function setCols(nextCols) {
    patch({ columns: nextCols })
  }

  // ── 열 폭 핸들러 ──────────────────────────────────────────────────────
  function commitColumnWidth(key, px) {
    if (!Number.isFinite(px)) return
    const clamped = Math.min(
      Math.max(COL_WIDTH_MIN_PX, Math.round(px)),
      COL_WIDTH_MAX_PX,
    )
    patch({ column_widths: { ...columnWidths, [key]: clamped } })
  }
  /** <col> 인라인 스타일 — 드래그 프리뷰 > 저장값 > 자동(undefined).
   *  width 를 안 주면 table-fixed 가 "고정 폭을 뺀 나머지를 자동 열끼리
   *  균등 분배" 하므로, 일부 열만 px 로 고정하고 나머지는 자동이 된다. */
  function colStyle(key) {
    if (resizePreview?.key === key) return { width: `${resizePreview.px}px` }
    const stored = columnWidths[key]
    return Number.isFinite(stored) ? { width: `${stored}px` } : undefined
  }
  function resetColWidth(key) {
    if (!(key in columnWidths)) return
    const keep = { ...columnWidths }
    delete keep[key]
    patch({ column_widths: keep })
  }
  /** 헤더 우측 핸들 드래그 — 진행 중엔 resizePreview 로 화면만, mouseup 에
   *  commit. window 리스너로 셀 밖으로 끌어도 추적. */
  function startColResize(key, thEl, startEvent) {
    if (!thEl) return
    const startWidth = thEl.offsetWidth
    const startX = startEvent.clientX
    const clampPx = (px) =>
      Math.min(Math.max(COL_WIDTH_MIN_PX, Math.round(px)), COL_WIDTH_MAX_PX)
    function onMove(ev) {
      setResizePreview({ key, px: clampPx(startWidth + (ev.clientX - startX)) })
    }
    function onUp(ev) {
      const next = clampPx(startWidth + (ev.clientX - startX))
      setResizePreview(null)
      commitColumnWidth(key, next)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  if (readOnly) {
    if (!caption && rows.length === 0) return null
    return (
      <div className="space-y-2">
        <CaptionInput
          value={caption}
          readOnly
          placeholder={props.label}
          skipAutofill={content?.caption_skip_autofill}
        />
        {rows.length > 0 && cols.length > 0 && (
          <>
            <div className="flex justify-end" data-export-skip="table-expand-toggle">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setExpanded((v) => !v)}
                className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                title={
                  expanded
                    ? '셀 내용 압축 (긴 글은 ...로 줄임)'
                    : '셀 내용 전체 펼치기 (긴 글도 모두 표시)'
                }
              >
                {expanded ? (
                  <>
                    <Minimize2 className="mr-1 h-3 w-3" /> 압축
                  </>
                ) : (
                  <>
                    <Maximize2 className="mr-1 h-3 w-3" /> 전체 펼치기
                  </>
                )}
              </Button>
            </div>
            <div className={`overflow-x-auto rounded-md border ${bodyTextClass}`} style={bodyTextStyle}>
              {/* No trailing column here — edit mode reserves an action column
                  for row buttons, but in view mode that would just leave a
                  blank ~80px gap on the right. Data columns fill the full
                  width instead; widths differ slightly between modes by the
                  action column's size. */}
              <table className="w-full text-sm table-fixed">
                <colgroup>
                  {cols.map((c, i) => (
                    <col key={i} style={colStyle(c.key)} />
                  ))}
                </colgroup>
                <thead className="bg-muted/40">
                  <tr>
                    {cols.map((c, i) => (
                      <th
                        key={i}
                        className="px-2 py-1.5 text-center font-medium text-xs text-muted-foreground border-b"
                      >
                        {c.label || c.key}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, ri) => (
                    <tr key={ri} className="border-b last:border-b-0">
                      {cols.map((c, ci) => {
                        // covered cell — 이미 다른 anchor 의 rowSpan/colSpan
                        // 영역에 흡수되었으므로 출력 자체를 건너뜀.
                        if (mergeMap.covered.has(`${ri},${ci}`)) return null
                        const span = mergeMap.anchors.get(`${ri},${ci}`)
                        return (
                          <ReadOnlyCell
                            key={ci}
                            value={row[c.key]}
                            expanded={expanded}
                            rowSpan={span?.rs}
                            colSpan={span?.cs}
                          />
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    )
  }
  function updateCell(rowIdx, key, value) {
    const nextRows = rows.map((r, i) => (i === rowIdx ? { ...r, [key]: value } : r))
    patch({ rows: nextRows })
  }
  function addRow() {
    // 끝에 추가는 merges 영향 없음 (모든 anchor 가 이미 작은 r 인덱스).
    patch({ rows: [...rows, {}] })
  }
  function removeRow(rowIdx) {
    // merges 의 r 축 재배치 — anchor 가 그 행에 있으면 한 행 아래로
    // 미루거나 (rs>1), 1×1 이 되어버리면 drop.
    const nextMerges = shiftMergesForRow(
      merges,
      'remove',
      rowIdx,
      rows.length,
      cols.length,
    )
    patch({
      rows: rows.filter((_, i) => i !== rowIdx),
      ...(merges.length || nextMerges.length ? { merges: nextMerges } : {}),
    })
  }
  function moveRow(rowIdx, dir) {
    // 행 위/아래로 이동 — 두 행의 r 인덱스만 바뀌므로 merges 도
    // 따라가야 함. 단순화: anchor 가 두 행 중 하나에 있으면 그 anchor 도
    // 같이 이동. 영역이 두 행을 동시에 덮는 multi-row merge 면 의미가
    // 모호하니 그대로 둠 (= 시각상 동일 위치 유지).
    const newIdx = rowIdx + dir
    if (newIdx < 0 || newIdx >= rows.length) return
    const next = [...rows]
    const [item] = next.splice(rowIdx, 1)
    next.splice(newIdx, 0, item)
    const swapped = (merges ?? []).map((m) => {
      if (m.r === rowIdx) return { ...m, r: newIdx }
      if (m.r === newIdx) return { ...m, r: rowIdx }
      return m
    })
    patch({
      rows: next,
      ...(merges.length || swapped.length
        ? { merges: normalizeMerges(swapped, rows.length, cols.length) }
        : {}),
    })
  }

  function addColumn() {
    // 끝에 추가 → 모든 anchor 의 c 인덱스는 이미 작아 영향 없음.
    const existing = new Set(cols.map((c) => c.key))
    let n = cols.length + 1
    while (existing.has(`col_${n}`)) n += 1
    setCols([...cols, { key: `col_${n}`, label: `열 ${n}`, type: 'text' }])
  }
  function renameColumn(idx, label) {
    setCols(cols.map((c, i) => (i === idx ? { ...c, label } : c)))
  }
  function removeColumn(idx) {
    const removed = cols[idx]
    const nextCols = cols.filter((_, i) => i !== idx)
    // Strip the removed column's data from every row so saved content
    // doesn't carry orphaned keys.
    const nextRows = rows.map((r) => {
      const { [removed.key]: _drop, ...rest } = r
      return rest
    })
    const nextMerges = shiftMergesForCol(
      merges,
      'remove',
      idx,
      rows.length,
      cols.length,
    )
    patch({
      columns: nextCols,
      rows: nextRows,
      ...(merges.length || nextMerges.length ? { merges: nextMerges } : {}),
    })
  }

  // ─── 셀 병합 / 분할 ──────────────────────────────────────────────
  // 셀 안 텍스트 편집과 셀 단위 선택이 같은 마우스 동작을 두고 충돌하지만
  // 명시적 토글 없이 처리 — mousedown 한 셀 안에서 드래그하면 텍스트가
  // 선택되고, 셀 경계를 넘어가는 순간 useCellSelection 이 자동으로
  // promote 해 multi-cell 선택으로 전환된다.
  // 사용자가 드래그/Shift+클릭으로 만든 사각형 selection 을 기반으로
  // anchor 셀에만 rs/cs 부여 — 나머지 셀은 자동으로 covered 처리되어
  // 렌더 단계에서 skip 된다. 데이터 (각 셀 값) 자체는 보존 — anchor 가
  // 변경되지 않는 한 unmerge 시 같은 자리에 같은 값이 복원됨.
  const selection = useCellSelection({
    rowCount: rows.length,
    colCount: cols.length,
  })
  function mergeSelection() {
    const r = selection.rect
    if (!r) return
    const rs = r.r2 - r.r1 + 1
    const cs = r.c2 - r.c1 + 1
    if (rs === 1 && cs === 1) return
    const nextMerges = normalizeMerges(
      [...(merges ?? []), { r: r.r1, c: r.c1, rs, cs }],
      rows.length,
      cols.length,
    )
    patch({ merges: nextMerges })
    selection.clear()
  }
  function unmergeSelection() {
    const r = selection.rect
    if (!r) return
    // 선택 영역에 (anchor 가 또는 covered 가) 겹치는 모든 merge 제거.
    const kept = (merges ?? []).filter((m) => {
      const last_r = m.r + m.rs - 1
      const last_c = m.c + m.cs - 1
      const overlaps =
        m.r <= r.r2 && last_r >= r.r1 && m.c <= r.c2 && last_c >= r.c1
      return !overlaps
    })
    patch({ merges: normalizeMerges(kept, rows.length, cols.length) })
    selection.clear()
  }
  // 액션 바 상태 — 선택 영역 안에 기존 merge 가 있으면 「분할」, 없으면
  // 사각형이 2셀 이상일 때만 「합치기」.
  const selectionHasMerge = (() => {
    const r = selection.rect
    if (!r) return false
    return (merges ?? []).some((m) => {
      const last_r = m.r + m.rs - 1
      const last_c = m.c + m.cs - 1
      return m.r <= r.r2 && last_r >= r.r1 && m.c <= r.c2 && last_c >= r.c1
    })
  })()
  const selectionSpansMultiple = (() => {
    const r = selection.rect
    if (!r) return false
    return r.r2 > r.r1 || r.c2 > r.c1
  })()
  // 선택이 2개 이상 열에 걸쳤나 — "열 폭 균등" 버튼 노출 조건.
  const selectionSpansCols = (() => {
    const r = selection.rect
    return !!r && r.c2 > r.c1
  })()
  /** 선택한 열들(c1..c2)의 폭을 같게 — 현재 렌더된 폭 합을 등분해 각 열에
   *  px 로 고정한다. 헤더 th 의 offsetWidth(현재 폭)로 측정하므로 자동 열도
   *  포함해 정확히 균등해진다. 2열 이상 선택일 때만. */
  function equalizeSelectedCols() {
    const r = selection.rect
    if (!r || r.c2 <= r.c1) return
    const root = selection.containerRef.current
    if (!root) return
    const ths = root.querySelectorAll('th[data-col-idx]')
    let total = 0
    let count = 0
    for (let ci = r.c1; ci <= r.c2; ci++) {
      const th = ths[ci]
      if (th) {
        total += th.offsetWidth
        count += 1
      }
    }
    if (count < 2 || total <= 0) return
    const each = Math.min(
      Math.max(COL_WIDTH_MIN_PX, Math.round(total / count)),
      COL_WIDTH_MAX_PX,
    )
    const next = { ...columnWidths }
    for (let ci = r.c1; ci <= r.c2; ci++) {
      if (cols[ci]) next[cols[ci].key] = each
    }
    patch({ column_widths: next })
    selection.clear()
  }

  /**
   * Paste landing on a column header. The first TSV row becomes column
   * labels (extending columns when needed); the remaining rows fill data
   * rows starting at row 0. Mirrors Excel's "paste with headers" feel.
   */
  function pasteOntoHeader(startCol, text) {
    const grid = parseTsv(text)
    if (grid.length === 0) return
    const incomingWidth = Math.max(...grid.map((r) => r.length))
    const neededCols = startCol + incomingWidth

    let nextCols = [...cols]
    if (neededCols > nextCols.length) {
      const existing = new Set(nextCols.map((c) => c.key))
      while (nextCols.length < neededCols) {
        let n = nextCols.length + 1
        let key = `col_${n}`
        while (existing.has(key)) {
          n += 1
          key = `col_${n}`
        }
        existing.add(key)
        nextCols.push({ key, label: '', type: 'text' })
      }
    }

    // First TSV row → column labels.
    const labels = grid[0]
    for (let c = 0; c < labels.length; c += 1) {
      const idx = startCol + c
      if (nextCols[idx]) {
        nextCols[idx] = { ...nextCols[idx], label: labels[c] }
      }
    }

    // Remaining rows → data rows from row 0.
    const dataGrid = grid.slice(1)
    let nextRows = [...rows]
    while (nextRows.length < dataGrid.length) nextRows.push({})
    for (let r = 0; r < dataGrid.length; r += 1) {
      const target = { ...nextRows[r] }
      for (let c = 0; c < dataGrid[r].length; c += 1) {
        const col = nextCols[startCol + c]
        if (!col) continue
        target[col.key] = coerceCellValue(col, dataGrid[r][c])
      }
      nextRows[r] = target
    }

    patch({ columns: nextCols, rows: nextRows })
  }

  /**
   * Excel/Google Sheets paste — clipboard text is TSV (tab between cells,
   * newline between rows). When the pasted block extends past existing
   * rows or columns we auto-extend both. Each value is coerced to the
   * target column's type best-effort; non-numeric values pasted into a
   * number column are kept as strings (validation will surface that).
   */
  function pasteGrid(startRow, startCol, text) {
    const grid = parseTsv(text)
    if (grid.length === 0) return
    const incomingWidth = Math.max(...grid.map((r) => r.length))
    const neededCols = startCol + incomingWidth
    const neededRows = startRow + grid.length

    // Extend columns to fit the paste width.
    let nextCols = cols
    if (neededCols > cols.length) {
      const existing = new Set(cols.map((c) => c.key))
      nextCols = [...cols]
      while (nextCols.length < neededCols) {
        let n = nextCols.length + 1
        let key = `col_${n}`
        while (existing.has(key)) {
          n += 1
          key = `col_${n}`
        }
        existing.add(key)
        nextCols.push({ key, label: `열 ${n}`, type: 'text' })
      }
    }

    // Extend rows.
    let nextRows = [...rows]
    while (nextRows.length < neededRows) nextRows.push({})

    // Fill values.
    for (let r = 0; r < grid.length; r += 1) {
      const target = { ...nextRows[startRow + r] }
      for (let c = 0; c < grid[r].length; c += 1) {
        const col = nextCols[startCol + c]
        if (!col) continue
        target[col.key] = coerceCellValue(col, grid[r][c])
      }
      nextRows[startRow + r] = target
    }

    patch({ columns: nextCols, rows: nextRows })
  }

  if (cols.length === 0) {
    return (
      <div className="space-y-2">
        <CaptionInput
          value={caption}
          onChange={(v) => patch({ caption: v })}
          placeholder={props.label}
          {...captionSkipProps({ content, patch })}
        />
        <p className="text-xs text-muted-foreground italic">열이 없습니다.</p>
        <Button variant="outline" size="sm" onClick={addColumn}>
          <Plus className="mr-1 h-3 w-3" />
          열 추가
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <CaptionInput
        value={caption}
        onChange={(v) => patch({ caption: v })}
        placeholder={props.label}
        {...captionSkipProps({ content, patch })}
      />
      <div
        className="flex justify-end items-center gap-2"
        // outside-click 핸들러가 액션 바 클릭으로 selection 을 지우지
        // 못하게 면역 영역으로 표시.
        data-cell-selection-allow
      >
        {/* 선택 영역 액션 — 사각형이 2셀 이상이거나 선택 영역에 기존
            merge 가 걸쳐 있으면 합치기 / 분할 버튼이 나옴. */}
        {(selectionSpansMultiple || selectionHasMerge) && (
          <div className="flex items-center gap-1 rounded-md border bg-muted/40 px-1.5 py-0.5">
            {selectionHasMerge && (
              <Button
                variant="ghost"
                size="sm"
                onClick={unmergeSelection}
                className="h-6 px-2 text-[11px]"
                title="선택한 영역의 셀 병합을 해제"
              >
                셀 분할
              </Button>
            )}
            {!selectionHasMerge && selectionSpansMultiple && (
              <Button
                variant="ghost"
                size="sm"
                onClick={mergeSelection}
                className="h-6 px-2 text-[11px]"
                title="선택한 사각형을 한 셀로 합치기"
              >
                셀 합치기
              </Button>
            )}
            {selectionSpansCols && (
              <Button
                variant="ghost"
                size="sm"
                onClick={equalizeSelectedCols}
                className="h-6 px-2 text-[11px]"
                title="선택한 열들의 폭을 같게 맞춤"
              >
                열 폭 균등
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={selection.clear}
              className="h-6 px-1.5 text-[11px] text-muted-foreground"
              title="선택 해제"
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        )}
        <DataTableActions
          label="표 데이터"
          onCopy={() => {
            const header = cols.map((c) => c.label || c.key)
            const body = rows.map((row) => cols.map((c) => row[c.key]))
            return toTsv([header, ...body])
          }}
          onClear={() => patch({ rows: [] })}
        />
      </div>
      <div
        ref={(el) => {
          // 두 훅 모두 같은 wrapper 를 root 로 씀 — grid 키보드 nav 는
          // 셀 querySelector 용, selection 은 바깥 클릭 감지용.
          grid.gridRef.current = el
          selection.containerRef.current = el
        }}
        className={`overflow-x-auto rounded-md border ${bodyTextClass} ${
          selection.crossCellDragging ? 'select-none cursor-cell' : ''
        }`}
        style={bodyTextStyle}
        onMouseUp={selection.handleMouseUp}
      >
        {/* Edit mode: same column structure as the read-only render. Row
            action buttons (move/delete) and per-column delete render as
            hover overlays inside the existing cells, so neither view nor
            edit mode reserves space for them — both modes have identical
            data column widths. */}
        <table className="w-full text-sm table-fixed">
          <colgroup>
            {cols.map((c, i) => (
              <col key={i} style={colStyle(c.key)} />
            ))}
          </colgroup>
          <thead className="bg-muted/40">
            <tr>
              {cols.map((c, i) => (
                <th
                  key={i}
                  data-col-idx={i}
                  className="px-1 py-1 text-center font-medium text-xs text-muted-foreground border-b group relative"
                >
                  <div className="flex items-center gap-1">
                    <input
                      type="text"
                      value={c.label || ''}
                      onChange={(e) => renameColumn(i, e.target.value)}
                      onPaste={(e) => {
                        const text = e.clipboardData?.getData('text/plain')
                        if (!text) return
                        if (text.indexOf('\t') === -1 && text.indexOf('\n') === -1) return
                        e.preventDefault()
                        pasteOntoHeader(i, text)
                      }}
                      placeholder={c.key}
                      className="bg-transparent border-0 outline-none focus:ring-1 focus:ring-ring rounded px-1 py-0.5 text-xs text-center flex-1 min-w-0"
                    />
                    {c.required && <span className="text-destructive">*</span>}
                  </div>
                  {/* Column delete — hover overlay on the right edge of
                      the header cell. No reserved space when idle. */}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="absolute right-0.5 top-1/2 -translate-y-1/2 h-5 w-5 opacity-0 group-hover:opacity-100 text-destructive bg-background/90 border shadow-sm"
                    onClick={() => removeColumn(i)}
                    title="열 삭제"
                  >
                    <X className="h-3 w-3" />
                  </Button>
                  {/* 우측 가장자리 드래그 핸들 — 끌어서 열 폭 조절. 더블클릭 =
                      자동(기본 폭). 항상 보이는 2px 바 + 6px hit area. */}
                  <div
                    role="separator"
                    aria-orientation="vertical"
                    title="끌어서 열 폭 조절 · 더블클릭하면 자동"
                    onMouseDown={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      startColResize(c.key, e.currentTarget.closest('th'), e)
                    }}
                    onDoubleClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      resetColWidth(c.key)
                    }}
                    className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize flex items-center justify-end group/handle z-20"
                  >
                    <span className="block w-0.5 h-1/2 bg-border group-hover/handle:bg-primary transition-colors" />
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIdx) => (
              <tr key={rowIdx} className="border-b last:border-b-0 group">
                {cols.map((c, ci) => {
                  // 편집모드에서도 covered 셀은 출력하지 않음 — 옆 anchor 의
                  // rowSpan/colSpan 이 자리를 덮음. 단 행 끝 action overlay
                  // 가 사라지지 않게 isLast 판정은 *원래* 마지막 컬럼 기준.
                  if (mergeMap.covered.has(`${rowIdx},${ci}`)) return null
                  const span = mergeMap.anchors.get(`${rowIdx},${ci}`)
                  const isLast = ci === cols.length - 1
                  const selected = selection.isCellSelected(rowIdx, ci)
                  return (
                    <td
                      key={ci}
                      data-cell-coord={`${rowIdx},${ci}`}
                      // 일반 클릭은 input focus 가 그대로 — 셀 안 텍스트
                      // 편집/커서 이동 정상. 드래그가 셀 경계를 넘는 순간
                      // hook 이 promote 해서 multi-cell 선택으로 전환.
                      onMouseDown={(e) =>
                        selection.handleMouseDown(e, rowIdx, ci)
                      }
                      onMouseEnter={() =>
                        selection.handleMouseEnter(rowIdx, ci)
                      }
                      onMouseLeave={() =>
                        selection.handleMouseLeave(rowIdx, ci)
                      }
                      {...(span?.rs > 1 ? { rowSpan: span.rs } : {})}
                      {...(span?.cs > 1 ? { colSpan: span.cs } : {})}
                      className={`px-1 py-1 ${isLast ? 'relative' : ''} ${
                        selected ? 'bg-primary/10 ring-1 ring-primary/40' : ''
                      }`}
                    >
                      <CellInput
                        column={c}
                        value={row[c.key]}
                        onChange={(v) => updateCell(rowIdx, c.key, v)}
                        onMultiPaste={(text) => pasteGrid(rowIdx, ci, text)}
                        rowIdx={rowIdx}
                        colIdx={ci}
                        onKeyDown={(e) => grid.handleKey(e, rowIdx, ci)}
                      />
                      {/* Row action overlay — only on the last cell of a row.
                          Hidden until the row is hovered, then floats over
                          the right side of the cell on a small pop-out card
                          with a backdrop so it stays readable. No layout
                          impact at idle, so widths match view mode. */}
                      {isLast && (
                        <div className="absolute right-0.5 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5 bg-background/95 rounded border shadow-sm px-0.5">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            disabled={rowIdx === 0}
                            onClick={() => moveRow(rowIdx, -1)}
                          >
                            <ChevronUp className="h-3 w-3" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            disabled={rowIdx === rows.length - 1}
                            onClick={() => moveRow(rowIdx, 1)}
                          >
                            <ChevronDown className="h-3 w-3" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-destructive"
                            onClick={() => removeRow(rowIdx)}
                          >
                            <X className="h-3 w-3" />
                          </Button>
                        </div>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={cols.length}
                  className="px-2 py-3 text-center text-xs text-muted-foreground italic"
                >
                  아직 행이 없습니다.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <Button
          variant="outline"
          size="sm"
          onClick={addRow}
          disabled={props.max_rows != null && rows.length >= props.max_rows}
        >
          <Plus className="mr-1 h-3 w-3" />
          행 추가
        </Button>
        <Button variant="outline" size="sm" onClick={addColumn}>
          <Plus className="mr-1 h-3 w-3" />
          열 추가
        </Button>
      </div>
    </div>
  )
}

function CellInput({ column, value, onChange, onMultiPaste, rowIdx, colIdx, onKeyDown }) {
  const t = column.type
  // 그리드 네비게이션이 querySelector 로 셀을 찾을 때 키. focusCell 의
  // 셀렉터와 1:1 매칭 — 형식이 바뀌면 useGridNavigation 도 같이 고쳐야 함.
  const gridCellKey = `${rowIdx}:${colIdx}`

  // Intercept clipboard pastes that look like TSV (tab/newline → multi-cell).
  // Single-value pastes fall through to the normal input behavior.
  function handlePaste(e) {
    if (!onMultiPaste) return
    const text = e.clipboardData?.getData('text/plain')
    if (!text) return
    if (text.indexOf('\t') === -1 && text.indexOf('\n') === -1) return
    e.preventDefault()
    onMultiPaste(text)
  }

  if (t === 'select') {
    // Native <select> 의 ArrowUp/Down 은 option 선택 동작이라 셀 이동을
    // 강제하지 않는다 — Tab 이동만으로 충분. data-grid-cell 은 타깃이
    // 되도록만 달아 둠 (이웃 셀에서 화살표로 도달했을 때 focus 가 가도록).
    return (
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || undefined)}
        data-grid-cell={gridCellKey}
        className="flex h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-xs text-center"
      >
        <option value="">—</option>
        {(column.options ?? []).map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    )
  }
  if (t === 'date') {
    return (
      <Input
        type="date"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || undefined)}
        onPaste={handlePaste}
        onKeyDown={onKeyDown}
        data-grid-cell={gridCellKey}
        className="h-8 text-xs text-center"
      />
    )
  }
  if (t === 'number' || t === 'integer') {
    return (
      <Input
        type="number"
        step={t === 'integer' ? 1 : 'any'}
        value={value ?? ''}
        onChange={(e) =>
          onChange(e.target.value === '' ? undefined : Number(e.target.value))
        }
        onPaste={handlePaste}
        onKeyDown={onKeyDown}
        data-grid-cell={gridCellKey}
        className="h-8 text-xs text-center"
      />
    )
  }
  // 텍스트 셀 — multi-line textarea. Enter 로 줄바꿈, 화살표로 셀 이동
  // (boundary 기준). 행 높이는 내용에 따라 auto-grow.
  return (
    <AutoGrowTextarea
      value={value ?? ''}
      onChange={(v) => onChange(v || undefined)}
      onPaste={handlePaste}
      onKeyDown={onKeyDown}
      data-grid-cell={gridCellKey}
      className="w-full min-h-[2rem] resize-none rounded-md border border-input bg-background px-2 py-1 text-xs leading-snug text-center focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring whitespace-pre-wrap break-words"
    />
  )
}

/**
 * Parse Excel / Sheets clipboard payload (TSV). Tabs separate cells; CRLF
 * or LF separates rows. We intentionally don't handle quoted cells with
 * embedded tabs/newlines — those are rare in spreadsheet clipboard data
 * and add a lot of parser complexity. Trailing blank line dropped.
 */
function parseTsv(text) {
  const trimmed = text.replace(/\r?\n$/, '')
  if (!trimmed) return []
  return trimmed.split(/\r?\n/).map((line) => line.split('\t'))
}

/**
 * Best-effort coercion when pasting a string into a typed column. Bad
 * conversions fall through as the raw string — the loose content schema
 * accepts that, and the report writer can clean up after the paste.
 */
function coerceCellValue(column, raw) {
  if (raw === undefined || raw === null) return undefined
  const s = typeof raw === 'string' ? raw.trim() : raw
  if (s === '') return undefined
  const t = column.type
  if (t === 'number') {
    const n = Number(s)
    return Number.isFinite(n) ? n : s
  }
  if (t === 'integer') {
    const n = parseInt(s, 10)
    return Number.isFinite(n) ? n : s
  }
  return s
}

/** 읽기 모드 표 셀.
 *
 *  Compact 모드 (default): 셀이 한 줄로 truncate 되고, 호버 시 fade-in
 *  되는 작은 popover 가 셀 아래에 떠서 전체 내용 보여줌. 빈 셀에는 — 만
 *  보이고 호버 popover 도 안 뜸. native `title` 도 같이 박아 접근성
 *  보조 도구 / 키보드 focus 에서도 잡히도록.
 *
 *  Expanded 모드: 전체 펼치기 토글이 켜진 상태 — 셀이 줄바꿈 되어 자연
 *  스럽게 늘어남. 이미 다 보이므로 hover popover 는 띄우지 않는다. */
function ReadOnlyCell({ value, expanded, rowSpan, colSpan }) {
  const isEmpty = value === undefined || value === null || value === ''
  const text = isEmpty ? '' : String(value)
  // rowSpan / colSpan 은 1 일 땐 HTML attr 자체를 비워둠 — DOM 상 깔끔.
  const spanAttrs = {
    ...(rowSpan && rowSpan > 1 ? { rowSpan } : {}),
    ...(colSpan && colSpan > 1 ? { colSpan } : {}),
  }
  if (isEmpty) {
    return (
      <td
        {...spanAttrs}
        className="px-2 py-1.5 text-center text-muted-foreground"
      >
        —
      </td>
    )
  }
  if (expanded) {
    return (
      <td
        {...spanAttrs}
        className="px-2 py-1.5 text-center whitespace-pre-wrap break-words align-top"
      >
        {text}
      </td>
    )
  }
  return (
    <td
      {...spanAttrs}
      className="px-2 py-1.5 text-center truncate relative group"
    >
      <span title={text} className="block truncate">
        {text}
      </span>
      {/* 호버 popover — Tailwind group-hover 만으로 동작. 셀 아래에 떠서
          row 위로 z-index 올림. 긴 글도 줄바꿈 / 폭 제한으로 깔끔하게
          표시. pointer-events: none 이라 popover 자체가 다른 호버를
          방해하지 않음. */}
      <span
        role="tooltip"
        className="pointer-events-none invisible group-hover:visible opacity-0 group-hover:opacity-100 transition-opacity absolute left-1/2 -translate-x-1/2 top-full mt-1 z-50 max-w-[min(28rem,80vw)] min-w-[8rem] whitespace-pre-wrap break-words rounded-md border bg-popover text-popover-foreground shadow-md px-2 py-1.5 text-xs text-left"
      >
        {text}
      </span>
    </td>
  )
}

export function TablePreview({ props }) {
  const cols = props.columns ?? []
  return (
    <div className="space-y-2">
      <PreviewLabel>{props.label || '(라벨 없음)'}</PreviewLabel>
      {cols.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">열 없음</p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-xs">
            <thead className="bg-muted/40">
              <tr>
                {cols.map((c, i) => (
                  <th
                    key={i}
                    className="px-2 py-1.5 text-center font-medium text-muted-foreground border-b"
                  >
                    {c.label || c.key || '(라벨 없음)'}
                    {c.required && <span className="text-destructive ml-0.5">*</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td
                  colSpan={cols.length}
                  className="px-2 py-3 text-center text-[11px] text-muted-foreground italic"
                >
                  보고서 작성 시 행이 추가됩니다
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
