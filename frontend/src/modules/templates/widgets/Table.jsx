import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { CaptionInput, DEFAULT_BODY_FONT_PX, FieldItemListEditor, LabelField, PreviewLabel, TextStyleField, captionSkipProps, textStyleToClassName, textStyleToInlineStyle } from './_shared'

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

export function TableEditor({ props, content, onChange, readOnly }) {
  // Effective columns: per-report override (content.columns) takes precedence
  // over template defaults (props.columns). Once the report writer touches
  // columns, content.columns becomes the full column list for this report.
  const templateCols = props.columns ?? []
  const overrideCols = content?.columns
  const cols = Array.isArray(overrideCols) ? overrideCols : templateCols
  const caption = content?.caption ?? ''
  const rows = content?.rows ?? []
  const bodyTextClass = textStyleToClassName(props.text_style)
  const bodyTextStyle = textStyleToInlineStyle(props.text_style)

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
    onChange(merged)
  }

  function setCols(nextCols) {
    patch({ columns: nextCols })
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
          <div className={`overflow-x-auto rounded-md border ${bodyTextClass}`} style={bodyTextStyle}>
            {/* No trailing column here — edit mode reserves an action column
                for row buttons, but in view mode that would just leave a
                blank ~80px gap on the right. Data columns fill the full
                width instead; widths differ slightly between modes by the
                action column's size. */}
            <table className="w-full text-sm table-fixed">
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
                    {cols.map((c, ci) => (
                      <td key={ci} className="px-2 py-1.5 text-center truncate">
                        {row[c.key] === undefined || row[c.key] === ''
                          ? <span className="text-muted-foreground">—</span>
                          : String(row[c.key])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    )
  }
  function updateCell(rowIdx, key, value) {
    const nextRows = rows.map((r, i) => (i === rowIdx ? { ...r, [key]: value } : r))
    patch({ rows: nextRows })
  }
  function addRow() {
    patch({ rows: [...rows, {}] })
  }
  function removeRow(rowIdx) {
    patch({ rows: rows.filter((_, i) => i !== rowIdx) })
  }
  function moveRow(rowIdx, dir) {
    const newIdx = rowIdx + dir
    if (newIdx < 0 || newIdx >= rows.length) return
    const next = [...rows]
    const [item] = next.splice(rowIdx, 1)
    next.splice(newIdx, 0, item)
    patch({ rows: next })
  }

  function addColumn() {
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
    patch({ columns: nextCols, rows: nextRows })
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
      <div className={`overflow-x-auto rounded-md border ${bodyTextClass}`} style={bodyTextStyle}>
        {/* Edit mode: same column structure as the read-only render. Row
            action buttons (move/delete) and per-column delete render as
            hover overlays inside the existing cells, so neither view nor
            edit mode reserves space for them — both modes have identical
            data column widths. */}
        <table className="w-full text-sm table-fixed">
          <thead className="bg-muted/40">
            <tr>
              {cols.map((c, i) => (
                <th
                  key={i}
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
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIdx) => (
              <tr key={rowIdx} className="border-b last:border-b-0 group">
                {cols.map((c, ci) => {
                  const isLast = ci === cols.length - 1
                  return (
                    <td
                      key={ci}
                      className={`px-1 py-1 ${isLast ? 'relative' : ''}`}
                    >
                      <CellInput
                        column={c}
                        value={row[c.key]}
                        onChange={(v) => updateCell(rowIdx, c.key, v)}
                        onMultiPaste={(text) => pasteGrid(rowIdx, ci, text)}
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
      <div className="flex items-center gap-2">
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

function CellInput({ column, value, onChange, onMultiPaste }) {
  const t = column.type

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
    // Native <select> doesn't accept paste; nothing to wire.
    return (
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || undefined)}
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
        className="h-8 text-xs text-center"
      />
    )
  }
  return (
    <Input
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || undefined)}
      onPaste={handlePaste}
      className="h-8 text-xs text-center"
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
