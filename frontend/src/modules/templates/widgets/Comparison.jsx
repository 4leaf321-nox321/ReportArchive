import { useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ImageIcon,
  Loader2,
  Plus,
  Type as TypeIcon,
  Upload,
  X,
} from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { AuthedImage } from '@/shared/components/AuthedImage'
import { uploadFile } from '@/shared/api/files'
import { toast } from 'sonner'
import { cn } from '@/shared/lib/utils'
import {
  CaptionInput,
  DEFAULT_BODY_FONT_PX,
  EditorOptionBar,
  EditorOptionNumber,
  EditorOptionToggle,
  LabelField,
  PreviewLabel,
  TextStyleField,
  captionSkipProps,
  effectiveBool,
  effectiveNumber,
  pruneOverrideKeys,
  textStyleToClassName,
  textStyleToInlineStyle,
} from './_shared'

// Hard guards for the optional layout props — match the backend's
// props_schema (minimum / maximum). Used both in the props panel and
// the editor so the writer can never exceed the schema bounds.
const DEFAULT_MAX_CASES = 6
const MAX_CASES_MIN = 2
const MAX_CASES_MAX = 30
const DEFAULT_IMAGE_MAX_HEIGHT_PX = 240
const IMAGE_MAX_HEIGHT_PX_MIN = 80
const IMAGE_MAX_HEIGHT_PX_MAX = 600
// Per-case min-width applied only when horizontal_scroll is on, so each
// case stays readable as the table overflows horizontally. Sized to fit
// a small thumbnail comfortably.
const SCROLL_CASE_MIN_WIDTH_PX = 200
// Row-label (left) column width — used only by the editor view, where
// the cell hosts an input + hover controls (move/delete) and needs a
// stable width. The read-only report view shrinks the column to its
// label content instead (see the readOnly branch below).
const ROW_LABEL_WIDTH = '7rem'

function clampMaxCases(raw) {
  if (!Number.isFinite(raw)) return DEFAULT_MAX_CASES
  return Math.min(Math.max(MAX_CASES_MIN, raw | 0), MAX_CASES_MAX)
}

function clampImageMaxHeightPx(raw) {
  if (!Number.isFinite(raw)) return DEFAULT_IMAGE_MAX_HEIGHT_PX
  return Math.min(
    Math.max(IMAGE_MAX_HEIGHT_PX_MIN, raw | 0),
    IMAGE_MAX_HEIGHT_PX_MAX,
  )
}

// --------------------------------------------------------------------------- //
// Helpers — case/row key generation.                                          //
//                                                                             //
// Each row/case carries a stable slug `key` that survives label edits.        //
// Cell values are stored under `row.values[caseKey]` so renaming the          //
// case label doesn't orphan its data.                                         //
// --------------------------------------------------------------------------- //
function uniqueKey(items, seed) {
  const existing = new Set(items.map((it) => it.key))
  if (!existing.has(seed)) return seed
  let n = 2
  while (existing.has(`${seed}_${n}`)) n += 1
  return `${seed}_${n}`
}

function nextRowKey(rows) {
  return uniqueKey(rows, `row_${rows.length + 1}`)
}

function nextCaseKey(cases) {
  return uniqueKey(cases, `case_${cases.length + 1}`)
}

// --------------------------------------------------------------------------- //
// PropsPanel — template designer picks the default CASE columns.              //
// Writers can add / rename / remove cases per-report via the inline editor.   //
// --------------------------------------------------------------------------- //
export function ComparisonPropsPanel({ props, onChange }) {
  const cases = Array.isArray(props.cases) ? props.cases : []
  // PropsPanel edits template-level defaults — read from props only.
  const horizontalScroll = effectiveBool(null, props, 'horizontal_scroll', false)
  const maxCases = clampMaxCases(
    effectiveNumber(null, props, 'max_cases', DEFAULT_MAX_CASES),
  )
  const imageMaxHeightPx = clampImageMaxHeightPx(
    effectiveNumber(null, props, 'image_max_height_px', DEFAULT_IMAGE_MAX_HEIGHT_PX),
  )

  function patch(next) {
    onChange({ ...props, ...next })
  }
  function addCase() {
    // Designer-time guard mirrors the editor: with horizontal_scroll
    // off, the designer can't seed more cases than max_cases (otherwise
    // a fresh template would already overflow on first open).
    if (!horizontalScroll && cases.length >= maxCases) {
      toast.error(
        `가로 스크롤이 꺼져 있어 CASE는 최대 ${maxCases}개까지만 추가할 수 있습니다.`,
      )
      return
    }
    patch({ cases: [...cases, { key: nextCaseKey(cases), label: '' }] })
  }
  function updateCase(idx, p) {
    patch({
      cases: cases.map((c, i) => (i === idx ? { ...c, ...p } : c)),
    })
  }
  function removeCase(idx) {
    patch({ cases: cases.filter((_, i) => i !== idx) })
  }
  function moveCase(idx, dir) {
    const newIdx = idx + dir
    if (newIdx < 0 || newIdx >= cases.length) return
    const next = [...cases]
    const [item] = next.splice(idx, 1)
    next.splice(newIdx, 0, item)
    patch({ cases: next })
  }

  return (
    <div className="space-y-4">
      <LabelField
        label="라벨"
        value={props.label}
        onChange={(v) => patch({ label: v })}
        placeholder="비교 표"
      />
      <div>
        <Label className="text-xs">기본 CASE 열 (초깃값)</Label>
        <p className="text-[10px] text-muted-foreground mt-0.5 mb-2">
          보고서마다 자유롭게 추가·이름변경·삭제할 수 있습니다.
        </p>
        <div className="space-y-1.5">
          {cases.map((c, idx) => (
            <div key={idx} className="flex items-center gap-1">
              <Input
                value={c.key ?? ''}
                onChange={(e) =>
                  updateCase(idx, {
                    key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''),
                  })
                }
                placeholder="key"
                maxLength={64}
                className="h-7 text-[11px] w-24 font-mono"
              />
              <Input
                value={c.label ?? ''}
                onChange={(e) => updateCase(idx, { label: e.target.value })}
                placeholder="CASE 라벨 (예: AS-IS)"
                maxLength={200}
                className="h-7 text-xs flex-1"
              />
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6"
                onClick={() => moveCase(idx, -1)}
                disabled={idx === 0}
              >
                <ChevronUp className="h-3 w-3" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6"
                onClick={() => moveCase(idx, 1)}
                disabled={idx === cases.length - 1}
              >
                <ChevronDown className="h-3 w-3" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6 text-destructive"
                onClick={() => removeCase(idx)}
                disabled={cases.length <= 1}
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={addCase}
          className="mt-2 h-7 text-xs"
        >
          <Plus className="mr-1 h-3 w-3" />
          CASE 추가
        </Button>
      </div>

      <div className="rounded-md border bg-muted/10 p-2 space-y-2">
        <Label className="text-xs">레이아웃</Label>
        <label className="flex items-start gap-2 text-xs">
          <input
            type="checkbox"
            checked={horizontalScroll}
            onChange={(e) =>
              patch({ horizontal_scroll: e.target.checked || undefined })
            }
            className="mt-0.5"
          />
          <span className="flex-1">
            <span className="font-medium">가로 스크롤 허용</span>
            <span className="block text-[10px] text-muted-foreground mt-0.5 leading-snug">
              켜면 CASE를 많이 추가해도 표가 가로로 스크롤됩니다. 끄면
              화면 너비에 맞춰 CASE가 균등 분할되고 개수가 제한됩니다.
            </span>
          </span>
        </label>
        {!horizontalScroll && (
          <div>
            <Label className="text-[10px] uppercase">최대 CASE 개수</Label>
            <Input
              type="number"
              min={MAX_CASES_MIN}
              max={MAX_CASES_MAX}
              value={maxCases}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (!Number.isFinite(v)) return
                patch({
                  max_cases: Math.min(
                    Math.max(MAX_CASES_MIN, v | 0),
                    MAX_CASES_MAX,
                  ),
                })
              }}
              className="mt-0.5 h-8 text-xs w-20"
            />
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              {MAX_CASES_MIN}~{MAX_CASES_MAX}. 가로 스크롤이 켜지면 제한이 사라집니다.
            </p>
          </div>
        )}
        <div>
          <Label className="text-[10px] uppercase">이미지 행 높이 (px)</Label>
          <Input
            type="number"
            min={IMAGE_MAX_HEIGHT_PX_MIN}
            max={IMAGE_MAX_HEIGHT_PX_MAX}
            step={20}
            value={imageMaxHeightPx}
            onChange={(e) => {
              const v = Number(e.target.value)
              if (!Number.isFinite(v)) return
              patch({
                image_max_height_px: Math.min(
                  Math.max(IMAGE_MAX_HEIGHT_PX_MIN, v | 0),
                  IMAGE_MAX_HEIGHT_PX_MAX,
                ),
              })
            }}
            className="mt-0.5 h-8 text-xs w-24"
          />
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            이미지 셀의 최대 높이. 전체화면에서도 이 높이를 넘지 않습니다.
          </p>
        </div>
      </div>

      <TextStyleField
        value={props.text_style}
        onChange={(text_style) => patch({ text_style })}
        defaultSizePx={DEFAULT_BODY_FONT_PX}
      />
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Preview — render the case columns + a placeholder row of each kind so the   //
// designer sees what the report writer will fill in.                          //
// --------------------------------------------------------------------------- //
export function ComparisonPreview({ props }) {
  const cases = Array.isArray(props.cases) ? props.cases : []
  return (
    <div className="space-y-2">
      <PreviewLabel
        hint={cases.length > 0 ? `${cases.length}개 CASE` : ''}
      >
        {props.label || '(라벨 없음)'}
      </PreviewLabel>
      {cases.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">CASE 열 없음</p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-xs table-fixed">
            <thead className="bg-muted/40">
              <tr>
                <th className="px-2 py-1.5 text-center font-medium text-muted-foreground border-b w-28" />
                {cases.map((c, i) => (
                  <th
                    key={i}
                    className="px-2 py-1.5 text-center font-medium text-muted-foreground border-b"
                  >
                    {c.label || c.key || '(이름 없음)'}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="border-b">
                <td className="px-2 py-1.5 text-[11px] font-medium text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <TypeIcon className="h-3 w-3" /> 텍스트 행
                  </span>
                </td>
                {cases.map((c, i) => (
                  <td
                    key={i}
                    className="px-2 py-1.5 text-center text-[11px] text-muted-foreground italic"
                  >
                    텍스트 / 숫자
                  </td>
                ))}
              </tr>
              <tr>
                <td className="px-2 py-1.5 text-[11px] font-medium text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <ImageIcon className="h-3 w-3" /> 이미지 행
                  </span>
                </td>
                {cases.map((c, i) => (
                  <td key={i} className="px-2 py-1.5">
                    <div className="aspect-video bg-muted/40 border border-dashed rounded-sm flex items-center justify-center text-muted-foreground">
                      <ImageIcon className="h-4 w-4" />
                    </div>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[10px] text-muted-foreground italic">
        보고서에서 텍스트 행 또는 이미지 행을 자유롭게 추가하여 채웁니다.
      </p>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Editor                                                                      //
// --------------------------------------------------------------------------- //
export function ComparisonEditor({ props, content, onChange, readOnly }) {
  const caption = content?.caption ?? ''
  // Effective cases — content.cases wins once the writer has touched the
  // header. Presence check (not length) so an explicitly emptied list
  // doesn't silently revert to template defaults. Matches the
  // raci_matrix `content.roles` pattern.
  const cases = Array.isArray(content?.cases)
    ? content.cases
    : Array.isArray(props.cases)
      ? props.cases
      : []
  const rows = Array.isArray(content?.rows) ? content.rows : []
  const textClass = textStyleToClassName(props.text_style)
  const textStyle = textStyleToInlineStyle(props.text_style)
  // Layout knobs — content (per-report) wins over props (template);
  // clamp here so a stray value can't break the layout.
  const horizontalScroll = effectiveBool(
    content,
    props,
    'horizontal_scroll',
    false,
  )
  const maxCases = clampMaxCases(
    effectiveNumber(content, props, 'max_cases', DEFAULT_MAX_CASES),
  )
  const imageMaxHeightPx = clampImageMaxHeightPx(
    effectiveNumber(
      content,
      props,
      'image_max_height_px',
      DEFAULT_IMAGE_MAX_HEIGHT_PX,
    ),
  )
  const canAddCase = horizontalScroll || cases.length < maxCases

  function patch(next) {
    const merged = {
      ...(content ?? {}),
      ...(caption ? { caption } : {}),
      cases,
      rows,
      ...next,
    }
    if (!merged.caption) delete merged.caption
    if (!merged.rows || merged.rows.length === 0) delete merged.rows
    if (!merged.cases || merged.cases.length === 0) delete merged.cases
    if (!merged.caption_skip_autofill) delete merged.caption_skip_autofill
    // Layout overrides — strip when undefined or when matching the
    // template default, so per-report content stays small and a
    // template default change still reaches reports that never
    // overrode the field.
    pruneOverrideKeys(merged, props, {
      horizontal_scroll: false,
      max_cases: DEFAULT_MAX_CASES,
      image_max_height_px: DEFAULT_IMAGE_MAX_HEIGHT_PX,
    })
    onChange(merged)
  }

  // ─── Case (column) handlers ──────────────────────────────────────────
  function addCase() {
    if (!horizontalScroll && cases.length >= maxCases) {
      toast.error(
        `가로 스크롤이 꺼져 있어 CASE는 최대 ${maxCases}개까지만 추가할 수 있습니다. 더 추가하려면 위젯 설정에서 가로 스크롤을 켜세요.`,
      )
      return
    }
    const key = nextCaseKey(cases)
    patch({ cases: [...cases, { key, label: '' }] })
  }
  function updateCase(idx, p) {
    const current = cases[idx]
    let nextKey
    if (p.key !== undefined && p.key !== current.key) {
      // Strip illegal chars, then dedupe so concurrent renames can't
      // collide with another case's key.
      const cleaned = p.key
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '')
        .replace(/^[^a-z]+/, '') || `case_${idx + 1}`
      nextKey = uniqueKey(
        cases.filter((_, i) => i !== idx),
        cleaned,
      )
    }
    const nextCases = cases.map((c, i) =>
      i === idx ? { ...c, ...p, ...(nextKey ? { key: nextKey } : {}) } : c,
    )
    let nextRows = rows
    if (nextKey) {
      const oldKey = current.key
      nextRows = rows.map((row) => {
        if (!row.values || !(oldKey in row.values)) return row
        const v = row.values[oldKey]
        const { [oldKey]: _drop, ...keep } = row.values
        return { ...row, values: { ...keep, [nextKey]: v } }
      })
    }
    patch({ cases: nextCases, rows: nextRows })
  }
  function removeCase(idx) {
    if (cases.length <= 1) return
    const removedKey = cases[idx].key
    const nextCases = cases.filter((_, i) => i !== idx)
    const nextRows = rows.map((row) => {
      if (!row.values || !(removedKey in row.values)) return row
      const { [removedKey]: _drop, ...keep } = row.values
      return { ...row, values: keep }
    })
    patch({ cases: nextCases, rows: nextRows })
  }
  function moveCase(idx, dir) {
    const newIdx = idx + dir
    if (newIdx < 0 || newIdx >= cases.length) return
    const next = [...cases]
    const [item] = next.splice(idx, 1)
    next.splice(newIdx, 0, item)
    patch({ cases: next })
  }

  // ─── Row handlers ────────────────────────────────────────────────────
  function addRow(kind) {
    const key = nextRowKey(rows)
    patch({ rows: [...rows, { key, kind, label: '', values: {} }] })
  }
  function updateRow(idx, p) {
    patch({
      rows: rows.map((r, i) => (i === idx ? { ...r, ...p } : r)),
    })
  }
  function removeRow(idx) {
    patch({ rows: rows.filter((_, i) => i !== idx) })
  }
  function moveRow(idx, dir) {
    const newIdx = idx + dir
    if (newIdx < 0 || newIdx >= rows.length) return
    const next = [...rows]
    const [item] = next.splice(idx, 1)
    next.splice(newIdx, 0, item)
    patch({ rows: next })
  }
  function setCellText(rowIdx, caseKey, text) {
    patch({
      rows: rows.map((r, i) => {
        if (i !== rowIdx) return r
        const nextValues = { ...(r.values ?? {}) }
        if (text === '' || text == null) delete nextValues[caseKey]
        else nextValues[caseKey] = text
        return { ...r, values: nextValues }
      }),
    })
  }
  function setCellImage(rowIdx, caseKey, fileMeta) {
    patch({
      rows: rows.map((r, i) => {
        if (i !== rowIdx) return r
        const nextValues = { ...(r.values ?? {}) }
        if (!fileMeta) delete nextValues[caseKey]
        else nextValues[caseKey] = fileMeta
        return { ...r, values: nextValues }
      }),
    })
  }

  // ─── Read-only render ────────────────────────────────────────────────
  if (readOnly) {
    if (!caption && rows.length === 0) return null
    return (
      <div className={`space-y-2 ${textClass}`} style={textStyle}>
        <CaptionInput
          value={caption}
          readOnly
          placeholder={props.label}
          skipAutofill={content?.caption_skip_autofill}
        />
        {rows.length > 0 && cases.length > 0 && (
          <div
            className={cn(
              'rounded-md border',
              horizontalScroll ? 'overflow-x-auto' : 'overflow-x-hidden',
            )}
          >
            <table
              className={cn(
                'text-sm w-full',
                horizontalScroll && 'w-max min-w-full',
              )}
            >
              <colgroup>
                {/* Row-label column: width:0 + whitespace-nowrap on the
                    td below makes the column shrink to the longest row
                    label's intrinsic width. CASE columns then split the
                    remaining space evenly via percentage widths. */}
                <col style={{ width: 0 }} />
                {cases.map((_, i) => (
                  <col
                    key={i}
                    style={
                      horizontalScroll
                        ? { minWidth: `${SCROLL_CASE_MIN_WIDTH_PX}px` }
                        : { width: `${100 / cases.length}%` }
                    }
                  />
                ))}
              </colgroup>
              <thead className="bg-muted/40">
                <tr>
                  <th className="px-2 py-1.5 text-center font-medium text-xs text-muted-foreground border-b" />
                  {cases.map((c, i) => (
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
                    <td className="px-2 py-1.5 text-xs font-medium border-r bg-muted/20 whitespace-nowrap">
                      {row.label || (
                        <span className="text-muted-foreground italic">
                          (이름 없음)
                        </span>
                      )}
                    </td>
                    {cases.map((c, ci) => (
                      <td
                        key={ci}
                        className="px-2 py-1.5 align-top"
                      >
                        <ReadOnlyCell
                          row={row}
                          caseKey={c.key}
                          imageMaxHeightPx={imageMaxHeightPx}
                        />
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

  // ─── Edit render ─────────────────────────────────────────────────────
  return (
    <div className={`space-y-3 ${textClass}`} style={textStyle}>
      <CaptionInput
        value={caption}
        onChange={(v) => patch({ caption: v })}
        placeholder={props.label}
        {...captionSkipProps({ content, patch })}
      />
      <EditorOptionBar title="레이아웃">
        <EditorOptionToggle
          label="가로 스크롤"
          value={horizontalScroll}
          onChange={(v) => patch({ horizontal_scroll: v })}
        />
        {!horizontalScroll && (
          <EditorOptionNumber
            label="최대 CASE"
            value={maxCases}
            min={MAX_CASES_MIN}
            max={MAX_CASES_MAX}
            onChange={(v) => patch({ max_cases: v })}
            suffix={`(현재 ${cases.length}개)`}
            width="w-14"
          />
        )}
        <EditorOptionNumber
          label="이미지 행 높이"
          value={imageMaxHeightPx}
          min={IMAGE_MAX_HEIGHT_PX_MIN}
          max={IMAGE_MAX_HEIGHT_PX_MAX}
          step={20}
          onChange={(v) => patch({ image_max_height_px: v })}
          suffix="px"
        />
      </EditorOptionBar>
      {cases.length === 0 ? (
        <div className="rounded-md border border-dashed bg-muted/20 px-3 py-4 text-center text-xs text-muted-foreground">
          비교할 CASE 열이 없습니다.
          <Button
            size="sm"
            variant="outline"
            onClick={addCase}
            className="ml-2 h-7 text-xs"
          >
            <Plus className="mr-1 h-3 w-3" />첫 CASE 추가
          </Button>
        </div>
      ) : (
        <div
          className={cn(
            'rounded-md border',
            horizontalScroll ? 'overflow-x-auto' : 'overflow-x-hidden',
          )}
        >
          <table
            className={cn(
              'text-sm',
              horizontalScroll ? 'w-max min-w-full' : 'w-full table-fixed',
            )}
          >
            <colgroup>
              <col style={{ width: ROW_LABEL_WIDTH }} />
              {cases.map((_, i) => (
                <col
                  key={i}
                  style={
                    horizontalScroll
                      ? { minWidth: `${SCROLL_CASE_MIN_WIDTH_PX}px` }
                      : undefined
                  }
                />
              ))}
            </colgroup>
            <thead className="bg-muted/40">
              <tr>
                <th className="px-1 py-1 text-center font-medium text-xs text-muted-foreground border-b border-r">
                  <span className="text-[10px]">행 / CASE</span>
                </th>
                {cases.map((c, ci) => (
                  <th
                    key={ci}
                    className="px-1 py-1 text-center font-medium text-xs text-muted-foreground border-b group relative"
                  >
                    <div className="flex items-center gap-0.5">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-5 w-5 opacity-0 group-hover:opacity-100"
                        disabled={ci === 0}
                        onClick={() => moveCase(ci, -1)}
                        title="왼쪽으로"
                      >
                        <ChevronLeft className="h-3 w-3" />
                      </Button>
                      <input
                        type="text"
                        value={c.label || ''}
                        onChange={(e) =>
                          updateCase(ci, { label: e.target.value })
                        }
                        placeholder={c.key}
                        className="bg-transparent border-0 outline-none focus:ring-1 focus:ring-ring rounded px-1 py-0.5 text-xs text-center flex-1 min-w-0 font-semibold"
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-5 w-5 opacity-0 group-hover:opacity-100"
                        disabled={ci === cases.length - 1}
                        onClick={() => moveCase(ci, 1)}
                        title="오른쪽으로"
                      >
                        <ChevronRight className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-5 w-5 opacity-0 group-hover:opacity-100 text-destructive"
                        onClick={() => removeCase(ci)}
                        disabled={cases.length <= 1}
                        title="CASE 삭제"
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={row.key ?? ri} className="border-b last:border-b-0 group">
                  <td className="px-1 py-1 align-top border-r bg-muted/10">
                    <div className="flex items-start gap-0.5">
                      <span
                        className="mt-1 text-muted-foreground shrink-0"
                        title={row.kind === 'image' ? '이미지 행' : '텍스트 행'}
                      >
                        {row.kind === 'image' ? (
                          <ImageIcon className="h-3 w-3" />
                        ) : (
                          <TypeIcon className="h-3 w-3" />
                        )}
                      </span>
                      <Input
                        value={row.label ?? ''}
                        onChange={(e) =>
                          updateRow(ri, { label: e.target.value })
                        }
                        placeholder="행 이름"
                        className="h-7 text-xs flex-1 min-w-0"
                      />
                      <div className="flex flex-col">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-5 w-5 opacity-0 group-hover:opacity-100"
                          disabled={ri === 0}
                          onClick={() => moveRow(ri, -1)}
                        >
                          <ChevronUp className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-5 w-5 opacity-0 group-hover:opacity-100"
                          disabled={ri === rows.length - 1}
                          onClick={() => moveRow(ri, 1)}
                        >
                          <ChevronDown className="h-3 w-3" />
                        </Button>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-5 w-5 opacity-0 group-hover:opacity-100 text-destructive"
                        onClick={() => removeRow(ri)}
                        title="행 삭제"
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  </td>
                  {cases.map((c, ci) => (
                    <td key={ci} className="px-1 py-1 align-top">
                      {row.kind === 'image' ? (
                        <ImageCellEditor
                          value={row.values?.[c.key]}
                          onChange={(v) => setCellImage(ri, c.key, v)}
                          maxHeightPx={imageMaxHeightPx}
                        />
                      ) : (
                        <TextCellEditor
                          value={row.values?.[c.key]}
                          onChange={(v) => setCellText(ri, c.key, v)}
                        />
                      )}
                    </td>
                  ))}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td
                    colSpan={cases.length + 1}
                    className="px-2 py-3 text-center text-xs text-muted-foreground italic"
                  >
                    아직 비교 행이 없습니다. 아래 버튼으로 텍스트 또는
                    이미지 행을 추가하세요.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        <Button
          variant="outline"
          size="sm"
          onClick={() => addRow('text')}
          disabled={cases.length === 0}
        >
          <TypeIcon className="mr-1 h-3 w-3" />텍스트 행 추가
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => addRow('image')}
          disabled={cases.length === 0}
        >
          <ImageIcon className="mr-1 h-3 w-3" />이미지 행 추가
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={addCase}
          disabled={!canAddCase}
          title={
            canAddCase
              ? undefined
              : `가로 스크롤이 꺼져 있어 최대 ${maxCases}개까지만 가능합니다.`
          }
        >
          <Plus className="mr-1 h-3 w-3" />CASE 추가
          {!horizontalScroll && (
            <span className="ml-1 text-[10px] text-muted-foreground">
              {cases.length}/{maxCases}
            </span>
          )}
        </Button>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Cell editors                                                                //
// --------------------------------------------------------------------------- //

function TextCellEditor({ value, onChange }) {
  // `value` is a plain string for text rows. We render a multi-line textarea
  // so writers can compare longer descriptions side by side without
  // truncating; rows naturally grow as content gets longer.
  return (
    <textarea
      value={typeof value === 'string' ? value : ''}
      onChange={(e) => onChange(e.target.value)}
      rows={2}
      placeholder="텍스트 / 숫자"
      className="w-full min-h-[2.5rem] resize-y rounded-md border border-input bg-background px-2 py-1 text-xs leading-snug focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    />
  )
}

function ImageCellEditor({ value, onChange, maxHeightPx = DEFAULT_IMAGE_MAX_HEIGHT_PX }) {
  const fileId =
    value && typeof value === 'object' && typeof value.file_id === 'string'
      ? value.file_id
      : null
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef(null)
  // The cell uses a fixed height (not aspect-video) so wider tables —
  // e.g. report-fullscreen mode that drops the page max-width — don't
  // make image rows grow vertically and create a viewport scroll. The
  // image itself stays scaled via object-contain so its native ratio
  // is preserved within the bounded box.
  const cellHeightStyle = { height: `${maxHeightPx}px` }

  async function handleFiles(fileList) {
    const incoming = Array.from(fileList || [])
    if (incoming.length === 0) return
    const file = incoming[0]
    if (!file.type.startsWith('image/')) {
      toast.error(`이미지 파일만 가능: ${file.name}`)
      return
    }
    setUploading(true)
    try {
      const meta = await uploadFile(file)
      onChange({ file_id: meta.id, alt: file.name })
    } catch (err) {
      toast.error(err.message || '업로드 실패')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  function onDrop(e) {
    e.preventDefault()
    handleFiles(e.dataTransfer.files)
  }
  function onPaste(e) {
    const items = Array.from(e.clipboardData?.items ?? [])
    const imageFiles = items
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter(Boolean)
    if (imageFiles.length === 0) return
    e.preventDefault()
    handleFiles(imageFiles)
  }
  function clear() {
    onChange(null)
  }

  if (fileId) {
    return (
      <div
        className="relative group/cell rounded-md overflow-hidden border bg-muted/20"
        style={cellHeightStyle}
      >
        <AuthedImage
          fileId={fileId}
          alt={value?.alt}
          className="absolute inset-0 w-full h-full object-contain"
        />
        <Button
          variant="ghost"
          size="icon"
          className="absolute top-0.5 right-0.5 h-6 w-6 bg-background/90 border shadow-sm text-destructive opacity-0 group-hover/cell:opacity-100"
          onClick={clear}
          title="이미지 제거"
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
    )
  }

  return (
    <div
      tabIndex={0}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
      onPaste={onPaste}
      style={cellHeightStyle}
      className="border-2 border-dashed rounded-md flex flex-col items-center justify-center gap-1 px-1 text-center hover:bg-muted/20 focus:bg-muted/30 focus:outline-none focus:ring-2 focus:ring-primary/40 transition-colors"
    >
      {uploading ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : (
        <>
          <Upload className="h-4 w-4 text-muted-foreground" />
          <div className="text-[10px] text-muted-foreground leading-tight">
            드래그 / 붙여넣기
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 text-[10px] px-1.5"
            onClick={(e) => {
              e.stopPropagation()
              fileInputRef.current?.click()
            }}
          >
            파일 선택
          </Button>
        </>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
    </div>
  )
}

function ReadOnlyCell({ row, caseKey, imageMaxHeightPx = DEFAULT_IMAGE_MAX_HEIGHT_PX }) {
  const value = row.values?.[caseKey]
  if (value == null || value === '') {
    return <span className="text-muted-foreground italic">—</span>
  }
  if (row.kind === 'image') {
    if (typeof value !== 'object' || !value.file_id) {
      return <span className="text-muted-foreground italic">—</span>
    }
    // Same bounded-height box as the editor — keeps the read view
    // consistent with what the writer saw, and prevents the
    // report-fullscreen mode (no page width cap) from making image
    // rows balloon vertically.
    return (
      <div
        className="relative rounded-md overflow-hidden border bg-muted/10"
        style={{ height: `${imageMaxHeightPx}px` }}
      >
        <AuthedImage
          fileId={value.file_id}
          alt={value.alt}
          className="absolute inset-0 w-full h-full object-contain"
        />
      </div>
    )
  }
  // Text rows: preserve newlines but keep things readable.
  return (
    <div className="text-xs whitespace-pre-wrap break-words">
      {String(value)}
    </div>
  )
}
