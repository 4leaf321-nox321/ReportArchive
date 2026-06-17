import { useRef, useState, useCallback } from 'react'
import {
  AlignCenter,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ImageIcon,
  Loader2,
  Palette,
  Plus,
  Type as TypeIcon,
  Upload,
  X,
} from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/shared/components/ui/popover'
import { ColorSwatchPicker, bgTokenClass, colorTokenClass, normalizeToken } from '@/shared/text-color'
import { AuthedImage } from '@/shared/components/AuthedImage'
import { uploadFile } from '@/shared/api/files'
import { toast } from 'sonner'
import { cn } from '@/shared/lib/utils'
import {
  pickBestPastedImage,
  pastedImageToFile,
  logPastedImageDiagnostics,
  lowResWarning,
} from '@/shared/lib/clipboardImage'
import {
  AutoGrowTextarea,
  CaptionInput,
  CellAlignControl,
  computeMergeMap,
  DataTableActions,
  hAlignClass,
  vAlignClass,
  DEFAULT_BODY_FONT_PX,
  EditorOptionBar,
  EditorOptionNumber,
  EditorOptionToggle,
  LabelField,
  normalizeMerges,
  parseHtmlTableMerges,
  NoteInput,
  PreviewLabel,
  shiftMergesForCol,
  shiftMergesForRow,
  TextStyleField,
  captionSkipProps,
  effectiveBool,
  effectiveNumber,
  pruneOverrideKeys,
  textStyleToClassName,
  useCellSelection,
  textStyleToInlineStyle,
  toTsv,
  useGridNavigation,
  _richIsEmpty,
  _richSeed,
  sanitizeCaptionHtml,
} from './_shared'
import { RichTextRowEditor, RichTextFormatToolbarBody } from './RichTextRowEditor'

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
// 행 라벨(첫 열) 기본 폭 — 사용자가 핸들로 따로 조절하지 않았을 때 두 모드
// 모두에 적용되는 default. 사용자 지정값은 content.row_label_width 에 px 로
// 저장되고 우선 적용된다.
const ROW_LABEL_DEFAULT_PX = 112 // ≒ 7rem

// 사용자가 헤더 드래그로 직접 설정한 CASE 컬럼 폭(px)의 허용 범위.
// 컬럼이 너무 좁아 입력이 막히거나, 한 컬럼이 표 전체를 차지하는 사고
// 둘 다 막는다. backend 스키마와 같은 값.
const CASE_WIDTH_MIN_PX = 60
const CASE_WIDTH_MAX_PX = 1200
// 표 전체 폭(px) 허용 범위 — 마지막 CASE 핸들 드래그·표 폭 입력 공통(백엔드
// table_width_px 검증 120~4000 과 일치).
const TABLE_WIDTH_MIN_PX = 120
const TABLE_WIDTH_MAX_PX = 4000

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

// 엑셀/스프레드시트 클립보드(TSV) → 2차원 배열. 표 위젯과 동일 규약.
function parseTsv(text) {
  const trimmed = text.replace(/\r?\n$/, '')
  if (!trimmed) return []
  return trimmed.split(/\r?\n/).map((line) => line.split('\t'))
}
// 단일 셀(탭·줄바꿈 없음)이면 기본 붙여넣기에 맡긴다.
function isMultiCellPaste(text) {
  return !!text && (text.indexOf('\t') !== -1 || text.indexOf('\n') !== -1)
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
// 다중 셀 일괄 서식 툴바의 정적 state — 선택 영역이 여러 셀이라 "현재 활성
// 서식" 개념이 없어 전부 비활성. 클릭하면 적용(set)만 한다.
const _BULK_TOOLBAR_STATE = {
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  fontSize: '',
  fontFamily: '',
  color: null,
  reportLink: false,
}

export function ComparisonEditor({ props, content, onChange, readOnly }) {
  const caption = content?.caption ?? ''
  const note = content?.note ?? ''
  // Effective cases — content.cases wins once the writer has touched the
  // header. Presence check (not length) so an explicitly emptied list
  // doesn't silently revert to template defaults. Matches the
  // raci_matrix `content.roles` pattern.
  const cases = Array.isArray(content?.cases)
    ? content.cases
    : Array.isArray(props.cases)
      ? props.cases
      : []
  const rawRows = Array.isArray(content?.rows) ? content.rows : []
  // 편집 모드에서 행이 하나도 없으면 빈 행 한 줄을 기본으로 보여준다 — 어디에
  // 입력/붙여넣기 해야 할지 바로 알 수 있게. 저장값(content.rows)은 그대로 비어
  // 있고, 첫 입력·붙여넣기 때 실제 행이 생긴다. 읽기 모드는 영향 없음.
  const rows =
    !readOnly && rawRows.length === 0
      ? [{ key: 'row_1', kind: 'text', label: '', values: {} }]
      : rawRows
  // 셀 병합 side-table. 비교표 좌표계:
  //   c = 0      → 행 라벨 컬럼
  //   c = 1..M   → case 컬럼 (cases[c-1])
  // 행 라벨 ↔ case 구역 cross-zone 병합은 정규화 단계에서 자동 dissolve.
  // 빈 배열/없음이면 기존 렌더와 100% 동일.
  const merges = Array.isArray(content?.merges) ? content.merges : []
  const totalColCount = cases.length + 1 // row label + each case
  const mergeMap = computeMergeMap(merges, rows.length, totalColCount)
  // 셀별 배경/글자 색(토큰). 행·케이스 모두 안정적 key 라 키도 안정적.
  const cellStyles =
    content?.cell_styles && typeof content.cell_styles === 'object'
      ? content.cell_styles
      : {}
  function cellStyleClass(rowKey, colKey) {
    const s = cellStyles[`${rowKey}::${colKey}`]
    if (!s) return ''
    return `${bgTokenClass(s.bg)} ${colorTokenClass(s.fg)}`.trim()
  }
  // 셀 단위 글자 크기(px 문자열, 예: '20px') — 행 라벨/이미지 등 인라인 마크업
  // 이 없는 셀에 일괄 크기를 줄 때 사용. 없으면 undefined.
  function cellSizePx(rowKey, colKey) {
    return cellStyles[`${rowKey}::${colKey}`]?.size
  }
  // 셀별 rich 마크업(긴 글처럼 per-char 색). 키는 cell_styles 와 동일
  // ("행key::케이스key"). 평문 값(values)과 분리된 사이드테이블.
  const cellHtml =
    content?.cell_html && typeof content.cell_html === 'object'
      ? content.cell_html
      : {}
  // ── 다중행·병합 헤더(선택) ───────────────────────────────────────────
  // header 가 있으면 (row_count × totalColCount) 헤더 그리드를 thead 로 렌더.
  // 열 매핑: ci=0 → 행라벨 컬럼('__row__'), ci=1..M → cases[ci-1]. 데이터 셀과
  // 같은 키("헤더행idx::열key")·머지·색·rich 재사용. 없으면 기존 case 라벨 1줄
  // 헤더로 폴백(하위호환).
  const header =
    content?.header && typeof content.header === 'object' ? content.header : null
  const headerRowCount = header
    ? Math.max(1, Math.min(8, Number(header.row_count) || 1))
    : 0
  const headerCells =
    header?.cells && typeof header.cells === 'object' ? header.cells : {}
  const headerMerges = Array.isArray(header?.merges) ? header.merges : []
  const headerMergeMap = computeMergeMap(
    headerMerges,
    headerRowCount,
    totalColCount,
  )
  const colKeyAt = (ci) => (ci === 0 ? '__row__' : cases[ci - 1]?.key)
  function headerCellClass(hr, colKey) {
    const s = headerCells[`${hr}::${colKey}`]
    if (!s || (!s.bg && !s.fg)) return ''
    return `${bgTokenClass(s.bg)} ${colorTokenClass(s.fg)}`.trim()
  }
  const textClass = textStyleToClassName(props.text_style)
  const textStyle = textStyleToInlineStyle(props.text_style)
  // 셀(헤더·행라벨·값) 본문 글자 크기 — 긴 글(RichText)과 동일한 기본값
  // DEFAULT_BODY_FONT_PX(18px) 로 맞추고, 속성의 "텍스트 크기"
  // (text_style.font_size_px)를 그대로 반영한다. 예전엔 셀이 text-xs(12px)
  // 로 하드코딩돼 너무 작고 속성 변경도 안 먹었던 부분을 이 값으로 교체.
  const bodyFontPx = props.text_style?.font_size_px ?? DEFAULT_BODY_FONT_PX
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
  // CASE 컬럼 폭 override — 사용자가 헤더 드래그 핸들로 조절한 값.
  // key 는 case slug 와 동일하고, 빠진 key 는 자동 균등 분배로 폴백.
  // 같은 값을 편집/뷰 두 모드 모두 같이 봐서 폭이 일관되게 보임.
  const columnWidths =
    content?.column_widths && typeof content.column_widths === 'object'
      ? content.column_widths
      : {}
  // 드래그 중인 컬럼의 임시 폭 프리뷰 — 매 mousemove 마다 content 를
  // patch 하면 무거우니 로컬 state 로 화면만 갱신하다가 mouseup 시점에
  // 한 번만 commit. resizePreview 가 set 되어 있는 동안 caseColStyle /
  // rowLabelColStyle 이 그 값을 우선 사용한다. caseKey === '__row__' 면
  // 행 라벨 컬럼 드래그를 의미.
  const [resizePreview, setResizePreview] = useState(null) // { caseKey, px } | null
  // 사용자가 지정한 행 라벨 컬럼 폭 — 미지정 시 ROW_LABEL_DEFAULT_PX 폴백.
  const storedRowLabelWidth = Number.isFinite(content?.row_label_width)
    ? content.row_label_width
    : null
  // 비교표 전체 절대 폭(px) — 설정 시 좌측 정렬되어 편집·뷰 폭 일치, 부분
  // 폭(왼쪽 절반 등) 가능. null = 전체 폭.
  const tableWidthPx = Number.isFinite(content?.table_width_px)
    ? content.table_width_px
    : null
  // 격자 테두리 옵션 — 켜면 비교표 <table> 에 .rt-grid + CSS 변수를 주입해
  // 행·열 전체에 균일 격자선. 굵기(1/2/3px)·색(토큰) 함께. 기본(false)=기존.
  const bordered = content?.bordered === true
  const borderWidth = [1, 2, 3].includes(content?.border_width)
    ? content.border_width
    : 1
  const borderColorTok = normalizeToken(content?.border_color)
  const gridClass = bordered ? 'rt-grid' : ''
  const gridVars = bordered
    ? {
        '--rt-gw': `${borderWidth}px`,
        ...(borderColorTok
          ? { '--rt-gc': `var(--rt-c-${borderColorTok})` }
          : {}),
      }
    : undefined
  // 마지막 CASE 핸들 드래그 중 표 전체 폭 프리뷰 — mouseup 에 commit.
  const [tableResizePreview, setTableResizePreview] = useState(null) // px | null
  const effTableWidthPx = tableResizePreview ?? tableWidthPx
  const tableBoxStyle = effTableWidthPx
    ? { width: `${effTableWidthPx}px`, maxWidth: '100%' }
    : undefined
  // 셀간 화살표 네비게이션. 컬럼 좌표: 0 = 행 라벨, 1..M = case 셀.
  // 행 좌표: 0..N-1 = 데이터 행 (헤더는 Tab 으로만 이동).
  const grid = useGridNavigation()
  // 텍스트 셀(헤더 포함)의 RichTextRowEditor imperative handle 등록소.
  // 키: 헤더 `h-${hr}-${ci}`, 케이스 데이터 셀 `${rowIdx}:${ci+1}`
  // (= gridCellKey). 다중 셀 일괄 서식이 각 셀 에디터에 직접 명령을 적용·수확.
  const cellEditorsRef = useRef(new Map())
  const registerEditor = useCallback((key, api) => {
    const m = cellEditorsRef.current
    if (api) m.set(key, api)
    else m.delete(key)
  }, [])

  function patch(next) {
    const merged = {
      ...(content ?? {}),
      ...(caption ? { caption } : {}),
      cases,
      rows,
      ...next,
    }
    if (!merged.caption) delete merged.caption
    if (!merged.note || !merged.note.trim()) delete merged.note
    if (!merged.rows || merged.rows.length === 0) delete merged.rows
    if (!merged.cases || merged.cases.length === 0) delete merged.cases
    if (!merged.caption_skip_autofill) delete merged.caption_skip_autofill
    if (
      !merged.cell_styles ||
      Object.keys(merged.cell_styles).length === 0
    ) {
      delete merged.cell_styles
    }
    if (!merged.cell_html || Object.keys(merged.cell_html).length === 0) {
      delete merged.cell_html
    }
    if (
      !merged.column_widths ||
      Object.keys(merged.column_widths).length === 0
    ) {
      delete merged.column_widths
    }
    if (!Number.isFinite(merged.row_label_width)) {
      delete merged.row_label_width
    }
    if (!Number.isFinite(merged.table_width_px)) delete merged.table_width_px
    if (!merged.bordered) {
      delete merged.bordered
      delete merged.border_width
      delete merged.border_color
    } else {
      if (merged.border_width === 1 || ![1, 2, 3].includes(merged.border_width)) {
        delete merged.border_width
      }
      if (!merged.border_color) delete merged.border_color
    }
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

  // 행 라벨 드래그 식별자 — case slug 규칙(^[a-z]…)과 충돌하지 않는 토큰
  // 으로 골라 resizePreview / startCaseResize 가 두 종류 모두 처리.
  const ROW_LABEL_KEY = '__row__'

  /** 컬럼 폭 commit — 드래그 종료 시 한 번. 행 라벨은 별도 필드, case 는
   *  column_widths 맵에 저장. clamp 동일. */
  function commitColumnWidth(caseKey, px) {
    if (!Number.isFinite(px)) return
    const clamped = Math.min(
      Math.max(CASE_WIDTH_MIN_PX, Math.round(px)),
      CASE_WIDTH_MAX_PX,
    )
    if (caseKey === ROW_LABEL_KEY) {
      patch({ row_label_width: clamped })
      return
    }
    patch({ column_widths: { ...columnWidths, [caseKey]: clamped } })
  }

  /** 편집/뷰 모드 공용 — 한 CASE 컬럼의 <col> 인라인 스타일.
   *  우선순위:
   *    1) 드래그 중인 프리뷰 → 그 px 값
   *    2) 저장된 columnWidths[key] → 그 px 값
   *    3) horizontalScroll → minWidth (가로 스크롤 모드)
   *    4) 그 외 → width 지정 안 함 (undefined)
   *
   *  *주의* — 4번에서 굳이 `100/N%` 를 줬더니, table-fixed 안에서 px(사용
   *  자가 잡은 한 컬럼) + %(나머지) 가 섞이면 브라우저가 백분율을 더 우선
   *  시켜서 px 컬럼이 자기 값을 못 잡아가는 버그가 있었음. width 를 안
   *  주면 table-fixed 가 "explicit 합을 뺀 나머지를 width 없는 col 들끼리
   *  균등 분배" 하므로 동일한 결과 + px 컬럼은 정확히 그 px 로 고정. */
  function caseColStyle(caseKey) {
    if (resizePreview?.caseKey === caseKey) {
      return { width: `${resizePreview.px}px` }
    }
    const stored = columnWidths[caseKey]
    if (Number.isFinite(stored)) {
      return { width: `${stored}px` }
    }
    if (horizontalScroll) {
      return { minWidth: `${SCROLL_CASE_MIN_WIDTH_PX}px` }
    }
    return undefined
  }

  /** 행 라벨 컬럼 폭 — 드래그 중이면 프리뷰, 저장된 값이 있으면 그 값,
   *  없으면 기본 폴백. 편집/뷰 두 모드에 동일하게 적용. */
  function rowLabelColStyle() {
    if (resizePreview?.caseKey === ROW_LABEL_KEY) {
      return { width: `${resizePreview.px}px` }
    }
    if (storedRowLabelWidth != null) {
      return { width: `${storedRowLabelWidth}px` }
    }
    return { width: `${ROW_LABEL_DEFAULT_PX}px` }
  }

  /** 헤더 핸들 mousedown → 윈도우 mousemove/mouseup 으로 드래그 처리.
   *  진행 중엔 resizePreview 로 화면만 갱신, mouseup 에 commit. */
  function startCaseResize(caseKey, startThEl, startEvent) {
    if (!startThEl) return
    const startWidth = startThEl.offsetWidth
    const startX = startEvent.clientX
    function clamp(px) {
      return Math.min(
        Math.max(CASE_WIDTH_MIN_PX, Math.round(px)),
        CASE_WIDTH_MAX_PX,
      )
    }
    function onMove(ev) {
      const next = clamp(startWidth + (ev.clientX - startX))
      setResizePreview({ caseKey, px: next })
    }
    function onUp(ev) {
      const next = clamp(startWidth + (ev.clientX - startX))
      setResizePreview(null)
      commitColumnWidth(caseKey, next)
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

  /** "폭을 균일하게" — 셀 선택(rect)이 걸친 열들(c1..c2)을 현재 렌더 폭 합을
   *  등분해 같은 px 로 맞춘다. Comparison 좌표: c=0 행 라벨, c=1..M cases.
   *  행 라벨이 포함되면 row_label_width, case 는 column_widths 에 기록.
   *  헤더 th[c] 의 offsetWidth 로 측정(자동 열도 정확히 균등). 2열 이상일 때만. */
  function equalizeSelectedCols() {
    const r = selection.rect
    if (!r || r.c2 <= r.c1) return
    const root = selection.containerRef.current
    if (!root) return
    const ths = root.querySelectorAll('thead th')
    let total = 0
    let count = 0
    for (let c = r.c1; c <= r.c2; c++) {
      const th = ths[c]
      if (th) {
        total += th.offsetWidth
        count += 1
      }
    }
    if (count < 2 || total <= 0) return
    const each = Math.min(
      Math.max(CASE_WIDTH_MIN_PX, Math.round(total / count)),
      CASE_WIDTH_MAX_PX,
    )
    const nextCW = { ...columnWidths }
    let nextRowLabel = null
    for (let c = r.c1; c <= r.c2; c++) {
      if (c === 0) nextRowLabel = each
      else if (cases[c - 1]) nextCW[cases[c - 1].key] = each
    }
    patch({
      column_widths: nextCW,
      ...(nextRowLabel != null ? { row_label_width: nextRowLabel } : {}),
    })
    selection.clear()
  }

  /** 마지막 CASE 우측 핸들 = 표 오른쪽 경계. 끌면 표 전체 폭(table_width_px)을
   *  조절한다(개별 CASE 폭이 아니라) — 마지막 열을 줄여 표 자체를 좁히기 위함.
   *  래퍼(selection.containerRef) offsetWidth 기준. mouseup 에 commit. */
  function startTableResize(startEvent) {
    const wrapperEl = selection.containerRef.current
    if (!wrapperEl) return
    const startWidth = wrapperEl.offsetWidth
    const startX = startEvent.clientX
    const clampPx = (px) =>
      Math.min(Math.max(TABLE_WIDTH_MIN_PX, Math.round(px)), TABLE_WIDTH_MAX_PX)
    function onMove(ev) {
      setTableResizePreview(clampPx(startWidth + (ev.clientX - startX)))
    }
    function onUp(ev) {
      const next = clampPx(startWidth + (ev.clientX - startX))
      setTableResizePreview(null)
      patch({ table_width_px: next })
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
    let nextColumnWidths = columnWidths
    if (nextKey) {
      const oldKey = current.key
      nextRows = rows.map((row) => {
        if (!row.values || !(oldKey in row.values)) return row
        const v = row.values[oldKey]
        const { [oldKey]: _drop, ...keep } = row.values
        return { ...row, values: { ...keep, [nextKey]: v } }
      })
      if (oldKey in columnWidths) {
        const { [oldKey]: oldVal, ...keep } = columnWidths
        nextColumnWidths = { ...keep, [nextKey]: oldVal }
      }
    }
    patch({
      cases: nextCases,
      rows: nextRows,
      column_widths: nextColumnWidths,
    })
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
    let nextColumnWidths = columnWidths
    if (removedKey in columnWidths) {
      const { [removedKey]: _drop, ...keep } = columnWidths
      nextColumnWidths = keep
    }
    // 비교표 좌표계에서 case[idx] 는 c=idx+1 자리. merges 의 c 축
    // shift 도 그 위치로 호출 — 총 컬럼 수는 cases.length+1.
    const totalCol = cases.length + 1
    const nextMerges = shiftMergesForCol(
      merges,
      'remove',
      idx + 1,
      rows.length,
      totalCol,
    )
    patch({
      cases: nextCases,
      rows: nextRows,
      column_widths: nextColumnWidths,
      ...(merges.length || nextMerges.length ? { merges: nextMerges } : {}),
      // 다중행 헤더가 있으면 그 case 열의 셀/머지도 같이 정리.
      ...(header
        ? {
            header: {
              ...header,
              cells: Object.fromEntries(
                Object.entries(headerCells).filter(
                  ([k]) => k.split('::')[1] !== removedKey,
                ),
              ),
              merges: shiftMergesForCol(
                headerMerges,
                'remove',
                idx + 1,
                headerRowCount,
                totalCol,
              ),
            },
          }
        : {}),
    })
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
    // 비교표는 c=0 (행 라벨) + c=1..M (cases) 라 총 컬럼 수 = cases.length+1.
    // merges 의 r 축 재배치는 totalCol 과 무관한 row 차원의 일이라 그대로 호출.
    const totalCol = cases.length + 1
    const nextMerges = shiftMergesForRow(
      merges,
      'remove',
      idx,
      rows.length,
      totalCol,
    )
    patch({
      rows: rows.filter((_, i) => i !== idx),
      ...(merges.length || nextMerges.length ? { merges: nextMerges } : {}),
    })
  }
  function moveRow(idx, dir) {
    const newIdx = idx + dir
    if (newIdx < 0 || newIdx >= rows.length) return
    const next = [...rows]
    const [item] = next.splice(idx, 1)
    next.splice(newIdx, 0, item)
    // 두 행만 r 좌표 swap. multi-row anchor 가 둘에 걸치면 단순 swap 으로
    // 의미가 깨질 수 있어 normalizeMerges 가 마지막 검증.
    const totalCol = cases.length + 1
    const swapped = (merges ?? []).map((m) => {
      if (m.r === idx) return { ...m, r: newIdx }
      if (m.r === newIdx) return { ...m, r: idx }
      return m
    })
    patch({
      rows: next,
      ...(merges.length || swapped.length
        ? { merges: normalizeMerges(swapped, rows.length, totalCol) }
        : {}),
    })
  }
  function setCellText(rowIdx, caseKey, text) {
    const rowKey = rows[rowIdx]?.key
    const k = `${rowKey}::${caseKey}`
    const nextHtml = cellHtml[k] ? { ...cellHtml } : null
    if (nextHtml) delete nextHtml[k] // 평문 덮어쓰기 → 기존 rich 버림
    patch({
      rows: rows.map((r, i) => {
        if (i !== rowIdx) return r
        const nextValues = { ...(r.values ?? {}) }
        if (text === '' || text == null) delete nextValues[caseKey]
        else nextValues[caseKey] = text
        return { ...r, values: nextValues }
      }),
      ...(nextHtml ? { cell_html: nextHtml } : {}),
    })
  }
  // 텍스트 셀 rich 편집 — 평문 값(values)과 rich(cell_html)를 함께 동기화.
  function setCellRich(rowIdx, rowKey, caseKey, html, text) {
    const k = `${rowKey}::${caseKey}`
    let nextHtml
    if (_richIsEmpty(html)) {
      nextHtml = { ...cellHtml }
      delete nextHtml[k]
    } else {
      nextHtml = { ...cellHtml, [k]: html }
    }
    patch({
      rows: rows.map((r, i) => {
        if (i !== rowIdx) return r
        const nextValues = { ...(r.values ?? {}) }
        if (!text) delete nextValues[caseKey]
        else nextValues[caseKey] = text
        return { ...r, values: nextValues }
      }),
      cell_html: nextHtml,
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

  // ─── 엑셀 클립보드(TSV) 붙여넣기 ─────────────────────────────────────
  function maybeWarnMaxCases(count) {
    if (!horizontalScroll && count > maxCases) {
      toast.message(
        `CASE가 ${count}개가 됐습니다 — 좁게 보이면 위젯 설정에서 가로 스크롤을 켜세요.`,
      )
    }
  }
  // 부족하면 CASE/행을 늘린 (nextCases, nextRows) 를 만든다. 새 행은 텍스트 행.
  function ensureSize(neededCases, neededRows) {
    const nextCases = [...cases]
    while (nextCases.length < neededCases) {
      nextCases.push({ key: nextCaseKey(nextCases), label: '' })
    }
    const nextRows = [...rows]
    while (nextRows.length < neededRows) {
      nextRows.push({ key: nextRowKey(nextRows), kind: 'text', label: '', values: {} })
    }
    return { nextCases, nextRows }
  }
  /** CASE 셀(c=startCaseIdx) 에 붙여넣기 — TSV 행→비교 행, TSV 열→CASE.
   *  표 위젯 pasteGrid 와 동일한 느낌. 이미지 행은 값을 건드리지 않는다. */
  function pasteGrid(startRowIdx, startCaseIdx, text, pasteMerges) {
    const tsv = parseTsv(text)
    if (tsv.length === 0) return
    const width = Math.max(...tsv.map((r) => r.length))
    const { nextCases, nextRows } = ensureSize(
      startCaseIdx + width,
      startRowIdx + tsv.length,
    )
    const nextHtml = { ...cellHtml }
    for (let r = 0; r < tsv.length; r += 1) {
      const row = nextRows[startRowIdx + r]
      if (!row || row.kind === 'image') continue
      const values = { ...(row.values ?? {}) }
      for (let c = 0; c < tsv[r].length; c += 1) {
        const cs = nextCases[startCaseIdx + c]
        if (!cs) continue
        const v = tsv[r][c]
        if (v === '' || v == null) delete values[cs.key]
        else values[cs.key] = v
        delete nextHtml[`${row.key}::${cs.key}`] // 평문 덮어쓰기 → rich 버림
      }
      nextRows[startRowIdx + r] = { ...row, values }
    }
    const next = { cases: nextCases, rows: nextRows, cell_html: nextHtml }
    // 엑셀 셀 병합 재현. 좌표계: 열 0 = 행 라벨, 열 1.. = CASE. CASE 셀
    // 붙여넣기라 unified 열 = (startCaseIdx + 블록열) + 1 → 항상 ≥1(행 라벨
    // 열과 안 겹침). 데이터 행 r 은 startRowIdx 기준.
    if (pasteMerges?.length) {
      const shifted = pasteMerges.map((m) => ({
        r: startRowIdx + m.r,
        c: startCaseIdx + m.c + 1,
        rs: m.rs,
        cs: m.cs,
      }))
      next.merges = normalizeMerges(
        [...merges, ...shifted],
        nextRows.length,
        nextCases.length + 1,
      )
    }
    patch(next)
    maybeWarnMaxCases(nextCases.length)
  }
  /** 행 라벨 칸에 붙여넣기 — 엑셀에서 "라벨 + CASE 값" 표를 통째로 붙일 때.
   *  TSV col0 → 행 라벨, col1.. → CASE0.. 값. 좌상단부터 표 전체 붙이기. */
  function pasteFromRowLabel(startRowIdx, text, pasteMerges) {
    const tsv = parseTsv(text)
    if (tsv.length === 0) return
    const width = Math.max(...tsv.map((r) => r.length))
    const { nextCases, nextRows } = ensureSize(
      Math.max(cases.length, width - 1),
      startRowIdx + tsv.length,
    )
    const nextHtml = { ...cellHtml }
    for (let r = 0; r < tsv.length; r += 1) {
      const row = nextRows[startRowIdx + r]
      if (!row) continue
      const cells = tsv[r]
      const next = { ...row, values: { ...(row.values ?? {}) } }
      if (cells[0] != null) next.label = cells[0]
      if (row.kind !== 'image') {
        for (let c = 1; c < cells.length; c += 1) {
          const cs = nextCases[c - 1]
          if (!cs) continue
          const v = cells[c]
          if (v === '' || v == null) delete next.values[cs.key]
          else next.values[cs.key] = v
          delete nextHtml[`${row.key}::${cs.key}`]
        }
      }
      nextRows[startRowIdx + r] = next
    }
    const result = { cases: nextCases, rows: nextRows, cell_html: nextHtml }
    // 엑셀 셀 병합 재현. 블록 col0 = 행 라벨(unified 열 0), col1.. = CASE.
    // 행 라벨 열(0)과 CASE 구역(≥1)을 가로지르는 병합(c=0 && cs>1)은 우리
    // 모델에서 의미가 모호해 버린다(기존 UI 규칙과 동일).
    if (pasteMerges?.length) {
      const shifted = pasteMerges
        .filter((m) => !(m.c === 0 && m.cs > 1))
        .map((m) => ({
          r: startRowIdx + m.r,
          c: m.c,
          rs: m.rs,
          cs: m.cs,
        }))
      if (shifted.length) {
        result.merges = normalizeMerges(
          [...merges, ...shifted],
          nextRows.length,
          nextCases.length + 1,
        )
      }
    }
    patch(result)
    maybeWarnMaxCases(nextCases.length)
  }
  /** CASE 라벨 칸에 붙여넣기(표 위젯 pasteOntoHeader 대응): TSV 첫 행 → CASE
   *  라벨, 나머지 행 → 그 CASE 들의 값(행 0부터). 엑셀 헤더 포함 붙여넣기용. */
  function pasteCaseLabels(startCaseIdx, text) {
    const tsv = parseTsv(text)
    if (tsv.length === 0) return
    const width = Math.max(...tsv.map((r) => r.length))
    const { nextCases, nextRows } = ensureSize(
      startCaseIdx + width,
      tsv.length - 1,
    )
    for (let c = 0; c < tsv[0].length; c += 1) {
      const idx = startCaseIdx + c
      if (nextCases[idx] && tsv[0][c] != null) {
        nextCases[idx] = { ...nextCases[idx], label: tsv[0][c] }
      }
    }
    const nextHtml = { ...cellHtml }
    for (let r = 1; r < tsv.length; r += 1) {
      const row = nextRows[r - 1]
      if (!row || row.kind === 'image') continue
      const values = { ...(row.values ?? {}) }
      for (let c = 0; c < tsv[r].length; c += 1) {
        const cs = nextCases[startCaseIdx + c]
        if (!cs) continue
        const v = tsv[r][c]
        if (v === '' || v == null) delete values[cs.key]
        else values[cs.key] = v
        delete nextHtml[`${row.key}::${cs.key}`]
      }
      nextRows[r - 1] = { ...row, values }
    }
    patch({ cases: nextCases, rows: nextRows, cell_html: nextHtml })
    maybeWarnMaxCases(nextCases.length)
  }
  /**
   * 다중행 헤더 셀에 붙여넣기. 헤더 band(절대행 0..headerRowCount-1)와 데이터
   * band 를 하나의 좌표계로 보고 (startHeaderRow, startColIdx) 부터 TSV 를
   * 흩뿌린다 — 헤더 줄 수를 넘는 행은 그대로 아래 데이터 행으로 이어 붙는다.
   * 좌표계: 열 0 = 행 라벨, 열 1.. = CASE. 즉 데이터 band 에서 열 0 은 행 라벨,
   * 그 외는 CASE 값. 평문 붙여넣기라 덮어쓴 셀의 rich(html)는 평문으로 대체된다.
   */
  function pasteIntoHeader(startHeaderRow, startColIdx, text, pasteMerges) {
    const tsv = parseTsv(text)
    if (tsv.length === 0) return
    const width = Math.max(...tsv.map((r) => r.length))
    // 열 0(행 라벨)은 CASE 가 아니므로 needed CASE 수는 (가장 오른쪽 unified 열
    // 인덱스) = startColIdx + width - 1. 데이터 band 로 넘치는 행 수도 함께 확보.
    const neededCases = startColIdx + width - 1
    const neededRows = Math.max(
      0,
      startHeaderRow + tsv.length - headerRowCount,
    )
    const { nextCases, nextRows } = ensureSize(neededCases, neededRows)
    const h = ensureHeader()
    const headerCellsNext = { ...(h.cells || {}) }
    const nextHtml = { ...cellHtml }

    const colKeyOf = (u) => (u === 0 ? ROW_LABEL_KEY : nextCases[u - 1]?.key)

    for (let r = 0; r < tsv.length; r += 1) {
      const absRow = startHeaderRow + r
      if (absRow < headerRowCount) {
        // 헤더 band — 헤더 셀 text 로 채우고 기존 색(bg/fg)은 보존.
        for (let c = 0; c < tsv[r].length; c += 1) {
          const colKey = colKeyOf(startColIdx + c)
          if (!colKey) continue
          const k = `${absRow}::${colKey}`
          const cur = { ...(headerCellsNext[k] || {}) }
          const v = tsv[r][c]
          if (v) cur.text = v
          else delete cur.text
          delete cur.html // 평문 덮어쓰기 → rich 버림
          if (cur.text || cur.bg || cur.fg || cur.align || cur.valign)
            headerCellsNext[k] = cur
          else delete headerCellsNext[k]
        }
      } else {
        // 데이터 band — 헤더 줄 수를 넘긴 행은 데이터 행으로 이어 붙임.
        const dataRow = absRow - headerRowCount
        const row = nextRows[dataRow]
        if (!row) continue
        const next = { ...row, values: { ...(row.values ?? {}) } }
        for (let c = 0; c < tsv[r].length; c += 1) {
          const u = startColIdx + c
          const v = tsv[r][c]
          if (u === 0) {
            if (v != null) next.label = v
            continue
          }
          if (row.kind === 'image') continue // 이미지 행엔 CASE 값 없음
          const cs = nextCases[u - 1]
          if (!cs) continue
          if (v === '' || v == null) delete next.values[cs.key]
          else next.values[cs.key] = v
          delete nextHtml[`${row.key}::${cs.key}`]
        }
        nextRows[dataRow] = next
      }
    }

    const result = {
      cases: nextCases,
      rows: nextRows,
      header: { ...h, cells: headerCellsNext },
      cell_html: nextHtml,
    }
    // 엑셀 셀 병합 재현 — 헤더/데이터는 별도 merges 배열. 한 band 안에 온전히
    // 들어가는 병합만 각 배열에 넣고, 밴드를 가로지르거나 행 라벨 열(0)을
    // 넘는(c=0 && cs>1) 병합은 버린다. unified 열 = startColIdx + 블록열.
    if (pasteMerges?.length) {
      const totalCols = nextCases.length + 1
      const headerAdds = []
      const dataAdds = []
      for (const m of pasteMerges) {
        const c = startColIdx + m.c
        if (c === 0 && m.cs > 1) continue // 행 라벨↔CASE 가로지름 → 버림
        const top = startHeaderRow + m.r
        const bottom = top + m.rs - 1
        if (bottom < headerRowCount) {
          headerAdds.push({ r: top, c, rs: m.rs, cs: m.cs })
        } else if (top >= headerRowCount) {
          dataAdds.push({ r: top - headerRowCount, c, rs: m.rs, cs: m.cs })
        }
        // straddler(헤더↔데이터 경계) → skip
      }
      if (headerAdds.length) {
        result.header = {
          ...result.header,
          merges: normalizeMerges(
            [...headerMerges, ...headerAdds],
            headerRowCount,
            totalCols,
          ),
        }
      }
      if (dataAdds.length) {
        result.merges = normalizeMerges(
          [...merges, ...dataAdds],
          nextRows.length,
          totalCols,
        )
      }
    }
    patch(result)
    maybeWarnMaxCases(nextCases.length)
  }

  // ─── 셀 병합 / 분할 ──────────────────────────────────────────────
  // 비교표 좌표계: c=0 → 행 라벨 컬럼, c=1..M → cases[c-1]. 행 라벨
  // 컬럼과 case 구역을 가로지르는 cross-zone 병합은 시각적으로
  // 의미가 모호하므로 차단 — selection 범위가 그 경계를 넘으면 합치기
  // 버튼이 비활성화된다. 합치기 후엔 normalizeMerges 가 다시 한번
  // grid clamp / overlap dissolve / 1×1 drop 까지 보정.
  // ── 통일 selection (헤더 band + 데이터) ──────────────────────────────
  // 헤더 행(0..headerOffset-1)을 데이터 위에 얹어 하나의 selection 으로. 데이터
  // 행은 headerOffset 만큼 아래. content.header 가 없는 기본 1줄(행/CASE 라벨)
  // 헤더도 헤더 행 0 으로 쳐서 드래그·선택이 되게 한다(min 1). 색/정렬/병합을
  // 적용하는 순간 ensureHeader 가 라벨을 header.cells 로 승격(band 전환).
  const headerOffset = Math.max(1, headerRowCount)
  const selection = useCellSelection({
    rowCount: headerOffset + rows.length,
    colCount: totalColCount,
  })
  // 헤더가 없으면 현재 case 라벨로 1행짜리 header 를 만들어 반환.
  function ensureHeader() {
    if (header) return header
    const cells = {}
    cases.forEach((c) => {
      if (c.label) cells[`0::${c.key}`] = { text: c.label }
    })
    return { row_count: 1, cells, merges: [] }
  }
  function patchHeader(nextHeader) {
    patch({ header: nextHeader })
  }
  function updateHeaderCellRich(hr, colKey, html, text) {
    const h = ensureHeader()
    const k = `${hr}::${colKey}`
    const cells = { ...(h.cells || {}) }
    const cur = { ...(cells[k] || {}) }
    if (text) cur.text = text
    else delete cur.text
    if (_richIsEmpty(html)) delete cur.html
    else cur.html = html
    if (cur.text || cur.html || cur.bg || cur.fg) cells[k] = cur
    else delete cells[k]
    patchHeader({ ...h, cells })
  }
  function addHeaderRowTop() {
    const h = ensureHeader()
    const cells = {}
    for (const [k, v] of Object.entries(h.cells || {})) {
      const [rStr, colKey] = k.split('::')
      cells[`${Number(rStr) + 1}::${colKey}`] = v
    }
    const mergesNext = shiftMergesForRow(
      h.merges || [],
      'insert',
      0,
      h.row_count,
      totalColCount,
    )
    patchHeader({ row_count: h.row_count + 1, cells, merges: mergesNext })
    selection.clear()
  }
  function removeHeaderRowTop() {
    const h = ensureHeader()
    if (h.row_count <= 1) {
      patch({ header: undefined })
      selection.clear()
      return
    }
    const cells = {}
    for (const [k, v] of Object.entries(h.cells || {})) {
      const [rStr, colKey] = k.split('::')
      const r = Number(rStr)
      if (r === 0) continue
      cells[`${r - 1}::${colKey}`] = v
    }
    const mergesNext = shiftMergesForRow(
      h.merges || [],
      'remove',
      0,
      h.row_count,
      totalColCount,
    )
    patchHeader({ row_count: h.row_count - 1, cells, merges: mergesNext })
    selection.clear()
  }
  function mergeSelection() {
    const r = selection.rect
    if (!r) return
    const rs = r.r2 - r.r1 + 1
    const cs = r.c2 - r.c1 + 1
    if (rs === 1 && cs === 1) return
    if (r.r2 < headerOffset) {
      const h = ensureHeader()
      const nm = normalizeMerges(
        [...(h.merges || []), { r: r.r1, c: r.c1, rs, cs }],
        h.row_count,
        totalColCount,
      )
      patchHeader({ ...h, merges: nm })
      selection.clear()
    } else if (r.r1 >= headerOffset) {
      const nm = normalizeMerges(
        [...(merges ?? []), { r: r.r1 - headerOffset, c: r.c1, rs, cs }],
        rows.length,
        totalColCount,
      )
      patch({ merges: nm })
      selection.clear()
    }
  }
  function unmergeSelection() {
    const r = selection.rect
    if (!r) return
    const overlaps = (m, r1, r2) => {
      const lr = m.r + m.rs - 1
      const lc = m.c + m.cs - 1
      return m.r <= r2 && lr >= r1 && m.c <= r.c2 && lc >= r.c1
    }
    if (r.r2 < headerOffset && header) {
      const kept = (header.merges || []).filter(
        (m) => !overlaps(m, r.r1, r.r2),
      )
      patchHeader({
        ...header,
        merges: normalizeMerges(kept, header.row_count, totalColCount),
      })
      selection.clear()
    } else if (r.r1 >= headerOffset) {
      const kept = (merges ?? []).filter(
        (m) => !overlaps(m, r.r1 - headerOffset, r.r2 - headerOffset),
      )
      patch({ merges: normalizeMerges(kept, rows.length, totalColCount) })
      selection.clear()
    }
  }
  // 선택 영역의 모든 셀에 배경/글자 색 — band 별 라우팅. 좌표 c=0 → 행 라벨
  // ('__row__'), c≥1 → cases[c-1].
  function applyCellColor(field, token) {
    const r = selection.rect
    if (!r) return
    const nextStyles = { ...cellStyles }
    let hObj = header
    let hCells = header ? { ...(header.cells || {}) } : null
    let hTouched = false
    for (let rr = r.r1; rr <= r.r2; rr++) {
      for (let ci = r.c1; ci <= r.c2; ci++) {
        const colKey = colKeyAt(ci)
        if (!colKey) continue
        if (rr < headerOffset) {
          if (!hCells) {
            hObj = ensureHeader()
            hCells = { ...(hObj.cells || {}) }
          }
          const k = `${rr}::${colKey}`
          const cur = { ...(hCells[k] || {}) }
          if (token) cur[field] = token
          else delete cur[field]
          if (cur.text || cur.html || cur.bg || cur.fg || cur.align || cur.valign)
            hCells[k] = cur
          else delete hCells[k]
          hTouched = true
        } else {
          const rowKey = rows[rr - headerOffset]?.key
          if (!rowKey) continue
          const k = `${rowKey}::${colKey}`
          const cur = { ...(nextStyles[k] || {}) }
          if (token) cur[field] = token
          else delete cur[field]
          if (cur.bg || cur.fg || cur.align || cur.valign) nextStyles[k] = cur
          else delete nextStyles[k]
        }
      }
    }
    const next = { cell_styles: nextStyles }
    if (hTouched) next.header = { ...(hObj || ensureHeader()), cells: hCells }
    patch(next)
  }

  // 선택 영역의 모든 셀에 글자 서식을 일괄 적용. `run(editor)` 은 각 텍스트
  // 셀(헤더·케이스) 에디터에서 실행할 명령(예: selectAll → setMark). 에디터가
  // 없는 셀(행 라벨 textarea·이미지)은 인라인 서식은 건너뛰되 `cellStyleFn`
  // 이 있으면 cell_styles 항목을 (cur)=>next 로 변환해 셀 단위 색/크기를 준다.
  function applyRichToSelection(run, cellStyleFn) {
    const r = selection.rect
    if (!r) return
    const reg = cellEditorsRef.current
    let nextRows = rows
    const nextHtml = { ...cellHtml }
    const nextStyles = { ...cellStyles }
    let hCells = header ? { ...(header.cells || {}) } : null
    let hTouched = false
    let stylesTouched = false
    let rowsTouched = false
    for (let rr = r.r1; rr <= r.r2; rr++) {
      for (let cc = r.c1; cc <= r.c2; cc++) {
        const colKey = colKeyAt(cc)
        if (!colKey) continue
        if (rr < headerOffset) {
          // ── 헤더 band ── 헤더 셀은 항상 RichTextRowEditor.
          const api = reg.get(`h-${rr}-${cc}`)
          if (!api?.applyAndCapture) continue
          const { html, text } = api.applyAndCapture((ed) => run(ed))
          if (!hCells) hCells = {}
          const k = `${rr}::${colKey}`
          const cur = { ...(hCells[k] || {}) }
          if (text) cur.text = text
          else delete cur.text
          if (_richIsEmpty(html)) delete cur.html
          else cur.html = html
          if (cur.text || cur.html || cur.bg || cur.fg) hCells[k] = cur
          else delete hCells[k]
          hTouched = true
        } else {
          // ── 데이터 band ── c=0 행 라벨(textarea, 에디터 없음), c≥1 케이스.
          const rowIdx = rr - headerOffset
          const row = rows[rowIdx]
          if (!row) continue
          const rowKey = row.key
          const api = cc >= 1 ? reg.get(`${rowIdx}:${cc}`) : null
          if (api?.applyAndCapture) {
            const { html, text } = api.applyAndCapture((ed) => run(ed))
            const k = `${rowKey}::${colKey}`
            nextRows = nextRows.map((rw, i) => {
              if (i !== rowIdx) return rw
              const values = { ...(rw.values || {}) }
              if (text) values[colKey] = text
              else delete values[colKey]
              return { ...rw, values }
            })
            rowsTouched = true
            if (_richIsEmpty(html)) delete nextHtml[k]
            else nextHtml[k] = html
          } else if (cellStyleFn) {
            // 행 라벨/이미지 셀 — 인라인 서식은 없지만 셀 단위 색/크기는 가능.
            const k = `${rowKey}::${colKey}`
            const nx = cellStyleFn({ ...(nextStyles[k] || {}) }) || {}
            if (nx.bg || nx.fg || nx.size || nx.align || nx.valign)
              nextStyles[k] = nx
            else delete nextStyles[k]
            stylesTouched = true
          }
        }
      }
    }
    const next = { cell_html: nextHtml }
    if (rowsTouched) next.rows = nextRows
    if (stylesTouched) next.cell_styles = nextStyles
    if (hTouched) next.header = { ...(header || ensureHeader()), cells: hCells }
    patch(next)
  }

  // 일괄 서식 툴바 액션 — 각 텍스트 셀에서 전체 선택 후 서식을 set(토글이
  // 아니라 적용). 색·크기는 행 라벨/이미지 셀까지 셀 단위로 함께 적용한다.
  const bulkFormatActions = {
    toggleBold: () =>
      applyRichToSelection((ed) => ed.chain().selectAll().setMark('bold').run()),
    toggleItalic: () =>
      applyRichToSelection((ed) => ed.chain().selectAll().setMark('italic').run()),
    toggleUnderline: () =>
      applyRichToSelection((ed) =>
        ed.chain().selectAll().setMark('underline').run(),
      ),
    toggleStrike: () =>
      applyRichToSelection((ed) => ed.chain().selectAll().setMark('strike').run()),
    setFontSize: (v) =>
      applyRichToSelection(
        (ed) =>
          v
            ? ed.chain().selectAll().setFontSize(v).run()
            : ed.chain().selectAll().unsetFontSize().run(),
        (cur) => {
          if (v) cur.size = v
          else delete cur.size
          return cur
        },
      ),
    setFontFamily: (v) =>
      applyRichToSelection((ed) =>
        v
          ? ed.chain().selectAll().setFontFamily(v).run()
          : ed.chain().selectAll().unsetFontFamily().run(),
      ),
    setColor: (c) =>
      applyRichToSelection(
        (ed) =>
          c
            ? ed.chain().selectAll().setColor(c).run()
            : ed.chain().selectAll().unsetColor().run(),
        (cur) => {
          if (c) cur.fg = c
          else delete cur.fg
          return cur
        },
      ),
  }
  function clearBulkFormat() {
    applyRichToSelection(
      (ed) =>
        ed
          .chain()
          .selectAll()
          .unsetBold()
          .unsetItalic()
          .unsetUnderline()
          .unsetStrike()
          .unsetFontSize()
          .unsetFontFamily()
          .unsetColor()
          .run(),
      (cur) => {
        delete cur.fg
        delete cur.size
        return cur
      },
    )
  }

  const selectionRect_ = selection.rect
  const selectionCrossesZone =
    selectionRect_ != null &&
    selectionRect_.c1 === 0 &&
    selectionRect_.c2 >= 1
  const selectionHasMerge = (() => {
    const r = selectionRect_
    if (!r) return false
    const hit = (list, r1, r2) =>
      (list ?? []).some((m) => {
        const lr = m.r + m.rs - 1
        const lc = m.c + m.cs - 1
        return m.r <= r2 && lr >= r1 && m.c <= r.c2 && lc >= r.c1
      })
    if (r.r2 < headerOffset) return hit(header?.merges, r.r1, r.r2)
    if (r.r1 >= headerOffset)
      return hit(merges, r.r1 - headerOffset, r.r2 - headerOffset)
    return false
  })()
  const selectionSpansMultiple =
    !!selectionRect_ &&
    (selectionRect_.r2 > selectionRect_.r1 ||
      selectionRect_.c2 > selectionRect_.c1)
  // 선택이 2개 이상 열에 걸쳤나 — "폭을 균일하게" 버튼 노출 조건.
  const selectionSpansCols =
    !!selectionRect_ && selectionRect_.c2 > selectionRect_.c1

  // 다중행 헤더 편집 행(편집 모드) — 각 셀 RichTextRowEditor(색·서식), 드래그
  // 선택으로 병합/색. 맨 아래 행(열과 1:1)에 코너 폭핸들 / case 이동·삭제·폭핸들.
  function renderHeaderEditRows() {
    return Array.from({ length: headerRowCount }).map((_, hr) => (
      <tr key={hr}>
        {Array.from({ length: totalColCount }).map((_, ci) => {
          if (headerMergeMap.covered.has(`${hr},${ci}`)) return null
          const span = headerMergeMap.anchors.get(`${hr},${ci}`)
          const isBottom = hr === headerRowCount - 1
          const isCorner = ci === 0
          const colKey = colKeyAt(ci)
          const caseIdx = ci - 1
          const selH = selection.isCellSelected(hr, ci)
          const hcell = headerCells[`${hr}::${colKey}`]
          return (
            <th
              key={ci}
              data-cell-coord={`${hr},${ci}`}
              onMouseDown={(e) => selection.handleMouseDown(e, hr, ci)}
              onMouseEnter={() => selection.handleMouseEnter(hr, ci)}
              onMouseLeave={() => selection.handleMouseLeave(hr, ci)}
              {...(span?.rs > 1 ? { rowSpan: span.rs } : {})}
              {...(span?.cs > 1 ? { colSpan: span.cs } : {})}
              style={{ fontSize: bodyFontPx }}
              className={cn(
                'px-1 py-1 font-medium text-xs text-muted-foreground border-b border-r last:border-r-0 group relative',
                // 셀 지정 정렬 우선(가로 기본=가운데, 세로 기본=th 기본 middle).
                hAlignClass(hcell?.align),
                vAlignClass(hcell?.valign),
                headerCellClass(hr, colKey),
                selH && 'bg-primary/10 ring-1 ring-primary/40',
              )}
            >
              <div className="outline-rich-row">
                <RichTextRowEditor
                  ref={(api) => registerEditor(`h-${hr}-${ci}`, api)}
                  html={_richSeed(hcell?.html, hcell?.text)}
                  onChange={(html, text) =>
                    updateHeaderCellRich(hr, colKey, html, text)
                  }
                  onPastePlain={(text, html) =>
                    pasteIntoHeader(hr, ci, text, parseHtmlTableMerges(html))
                  }
                  gridCellKey={`h-${hr}-${ci}`}
                  defaultSizePx={bodyFontPx}
                  // 가로 정렬은 th 의 text-align 상속(text-center 박지 않음).
                  className="w-full min-h-[1.5rem] rounded px-1 py-0.5 whitespace-pre-wrap break-words"
                />
              </div>
              {isBottom && isCorner && (
                <div
                  role="separator"
                  aria-orientation="vertical"
                  title="끌어서 행 라벨 폭 조절"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    startCaseResize(ROW_LABEL_KEY, e.currentTarget.closest('th'), e)
                  }}
                  className="absolute right-0 top-0 h-full w-2 cursor-col-resize flex items-center justify-end group/handle z-10"
                >
                  <span className="block w-0.5 h-1/2 bg-border group-hover/handle:bg-primary transition-colors" />
                </div>
              )}
              {isBottom && !isCorner && (
                <>
                  <div className="absolute left-0.5 top-0.5 flex gap-0.5 rounded border bg-background/90 opacity-0 shadow-sm group-hover:opacity-100">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5"
                      disabled={caseIdx === 0}
                      onClick={() => moveCase(caseIdx, -1)}
                      title="왼쪽으로"
                    >
                      <ChevronLeft className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5"
                      disabled={caseIdx === cases.length - 1}
                      onClick={() => moveCase(caseIdx, 1)}
                      title="오른쪽으로"
                    >
                      <ChevronRight className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 text-destructive"
                      disabled={cases.length <= 1}
                      onClick={() => removeCase(caseIdx)}
                      title="CASE 삭제"
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                  {ci < totalColCount - 1 && (
                    <div
                      role="separator"
                      aria-orientation="vertical"
                      title="끌어서 컬럼 폭 조절"
                      onMouseDown={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        startCaseResize(colKey, e.currentTarget.closest('th'), e)
                      }}
                      className="absolute right-0 top-0 h-full w-2 cursor-col-resize flex items-center justify-end group/handle z-10"
                    >
                      <span className="block w-0.5 h-1/2 bg-border group-hover/handle:bg-primary transition-colors" />
                    </div>
                  )}
                </>
              )}
            </th>
          )
        })}
      </tr>
    ))
  }

  // ─── Read-only render ────────────────────────────────────────────────
  if (readOnly) {
    if (!caption && rows.length === 0 && !note.trim()) return null
    return (
      <div className={`space-y-2 ${textClass}`} style={textStyle}>
        <CaptionInput
          value={caption}
          readOnly
          placeholder={props.label}
          skipAutofill={content?.caption_skip_autofill}
          color={content?.caption_color}
          html={content?.caption_html}
        />
        {rows.length > 0 && cases.length > 0 && (
          <div
            className={cn(
              'rounded-md border',
              horizontalScroll ? 'overflow-x-auto' : 'overflow-x-hidden',
            )}
            style={tableBoxStyle}
          >
            <table
              className={cn(
                'text-sm w-full table-fixed',
                horizontalScroll && 'w-max min-w-full',
                gridClass,
              )}
              style={gridVars}
            >
              <colgroup>
                {/* 편집 모드와 동일한 7rem 으로 row-label 폭을 잡아 두 모드
                    의 CASE 컬럼 시작점이 정확히 일치하도록. 긴 행 이름은
                    아래 td 의 whitespace-pre-wrap break-words 로 wrap. */}
                <col style={rowLabelColStyle()} />
                {cases.map((c) => (
                  <col key={c.key} style={caseColStyle(c.key)} />
                ))}
              </colgroup>
              <thead className="bg-muted/40">
                {headerRowCount > 0 ? (
                  Array.from({ length: headerRowCount }).map((_, hr) => (
                    <tr key={hr}>
                      {Array.from({ length: totalColCount }).map((_, ci) => {
                        if (headerMergeMap.covered.has(`${hr},${ci}`)) return null
                        const span = headerMergeMap.anchors.get(`${hr},${ci}`)
                        const colKey = colKeyAt(ci)
                        const cell = headerCells[`${hr}::${colKey}`]
                        const html = cell?.html
                        const hasRich = html && !_richIsEmpty(html)
                        return (
                          <th
                            key={ci}
                            rowSpan={span?.rs > 1 ? span.rs : undefined}
                            colSpan={span?.cs > 1 ? span.cs : undefined}
                            style={{ fontSize: bodyFontPx }}
                            className={cn(
                              'px-2 py-1.5 font-medium text-muted-foreground border-b border-r last:border-r-0 whitespace-pre-wrap break-words',
                              hAlignClass(cell?.align),
                              vAlignClass(cell?.valign),
                              headerCellClass(hr, colKey),
                            )}
                          >
                            {hasRich ? (
                              <span
                                className="[&_p]:m-0"
                                dangerouslySetInnerHTML={{
                                  __html: sanitizeCaptionHtml(html),
                                }}
                              />
                            ) : (
                              cell?.text || ''
                            )}
                          </th>
                        )
                      })}
                    </tr>
                  ))
                ) : (
                  <tr>
                    <th className="px-2 py-1.5 text-center font-medium text-xs text-muted-foreground border-b" />
                    {cases.map((c, i) => (
                      <th
                        key={i}
                        style={{ fontSize: bodyFontPx }}
                        className="px-2 py-1.5 text-center font-medium text-muted-foreground border-b whitespace-pre-wrap break-words"
                      >
                        {c.label || c.key}
                      </th>
                    ))}
                  </tr>
                )}
              </thead>
              <tbody>
                {rows.map((row, ri) => {
                  // 좌표 c=0 → 행 라벨, c=1..M → cases[c-1]. covered 셀
                  // 출력 skip + anchor 에만 rowSpan/colSpan.
                  const labelKey = `${ri},0`
                  const labelCovered = mergeMap.covered.has(labelKey)
                  const labelSpan = mergeMap.anchors.get(labelKey)
                  const lstyle = cellStyles[`${row.key}::${ROW_LABEL_KEY}`]
                  return (
                    <tr key={ri} className="border-b last:border-b-0">
                      {!labelCovered && (
                        <td
                          {...(labelSpan?.rs > 1 ? { rowSpan: labelSpan.rs } : {})}
                          {...(labelSpan?.cs > 1 ? { colSpan: labelSpan.cs } : {})}
                          style={{
                            fontSize: cellSizePx(row.key, ROW_LABEL_KEY) ?? bodyFontPx,
                          }}
                          className={cn(
                            // 기본 정렬은 "표" 위젯과 동일하게 가로 중앙(셀 지정 우선).
                            'px-2 py-1.5 font-medium border-r bg-muted/20 whitespace-pre-wrap break-words',
                            hAlignClass(lstyle?.align),
                            // 세로: 셀 지정 우선, 없으면 병합 시 가운데·아니면 위.
                            vAlignClass(lstyle?.valign, labelSpan?.rs > 1 ? 'align-middle' : 'align-top'),
                            cellStyleClass(row.key, ROW_LABEL_KEY),
                          )}
                        >
                          {row.label || (
                            <span className="text-muted-foreground italic">
                              (이름 없음)
                            </span>
                          )}
                        </td>
                      )}
                      {cases.map((c, ci) => {
                        const coord = `${ri},${ci + 1}`
                        if (mergeMap.covered.has(coord)) return null
                        const span = mergeMap.anchors.get(coord)
                        const dstyle = cellStyles[`${row.key}::${c.key}`]
                        return (
                          <td
                            key={ci}
                            {...(span?.rs > 1 ? { rowSpan: span.rs } : {})}
                            {...(span?.cs > 1 ? { colSpan: span.cs } : {})}
                            className={cn(
                              // 기본 정렬은 "표" 위젯과 동일하게 가로 중앙(셀 지정 우선).
                              'px-2 py-1.5',
                              hAlignClass(dstyle?.align),
                              // 세로: 셀 지정 우선, 없으면 병합 시 가운데·아니면 위.
                              vAlignClass(dstyle?.valign, span?.rs > 1 ? 'align-middle' : 'align-top'),
                              cellStyleClass(row.key, c.key),
                            )}
                          >
                            <ReadOnlyCell
                              row={row}
                              caseKey={c.key}
                              html={cellHtml[`${row.key}::${c.key}`]}
                              imageMaxHeightPx={imageMaxHeightPx}
                              fontSizePx={bodyFontPx}
                            />
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <NoteInput value={note} readOnly color={content?.note_color} html={content?.note_html} />
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
        <EditorOptionToggle
          label="테두리"
          value={bordered}
          onChange={(v) => patch({ bordered: v || undefined })}
        />
        {bordered && (
          <div className="flex items-center gap-1 text-[11px]">
            {[
              { px: 1, label: '얇게' },
              { px: 2, label: '보통' },
              { px: 3, label: '굵게' },
            ].map((opt) => (
              <button
                key={opt.px}
                type="button"
                onClick={() => patch({ border_width: opt.px })}
                className={`rounded border px-1.5 py-0.5 ${
                  borderWidth === opt.px
                    ? 'border-primary/40 bg-primary/10 text-foreground'
                    : 'bg-muted/40 text-muted-foreground hover:text-foreground'
                }`}
                title={`테두리 굵기 ${opt.px}px`}
              >
                {opt.label}
              </button>
            ))}
            <ColorSwatchPicker
              value={borderColorTok}
              onChange={(t) => patch({ border_color: t || undefined })}
              size={16}
            />
          </div>
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
        {/* 표 전체 폭(px) — 비우면 전체 폭. 설정 시 좌측 정렬이라 "왼쪽 절반
            만" 같은 부분 폭도 가능하고 편집·뷰 폭이 일치. */}
        <EditorOptionNumber
          label="표 폭"
          value={tableWidthPx ?? undefined}
          min={120}
          max={4000}
          step={20}
          onChange={(v) => patch({ table_width_px: v })}
          suffix="px (비우면 전체)"
          width="w-16"
          hint="표 전체 절대 폭. 비우면 전체 폭을 차지. 좌측 정렬이라 절반 폭 등으로 만들 수 있습니다."
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
        <>
        <div
          className="flex justify-end items-center gap-2 flex-wrap"
          // outside-click 핸들러가 액션 바 클릭으로 selection 을 지우지
          // 못하게 면역 영역으로 표시.
          data-cell-selection-allow
        >
          {/* 데이터 복사(TSV) / 비우기 — 표 위젯과 동일. 헤더는 CASE 라벨,
              본문은 행 라벨 + 각 CASE 값. 이미지 행은 텍스트가 없어 빈 칸.
              복사는 HTTP-safe(copyTextToClipboard)라 평문 운영서버에서도 동작. */}
          <DataTableActions
            label="비교표 데이터"
            onCopy={() => {
              const header = ['', ...cases.map((c) => c.label || c.key)]
              const body = rows.map((row) => [
                row.label || '',
                ...cases.map((c) =>
                  row.kind === 'image' ? '' : row.values?.[c.key] ?? '',
                ),
              ])
              return toTsv([header, ...body])
            }}
            onPaste={(text, html) =>
              pasteFromRowLabel(0, text, parseHtmlTableMerges(html))
            }
            onClear={() => patch({ rows: [] })}
          />
          {/* 헤더(제목) 행 수 — + 로 맨 위에 그룹 헤더 행을 얹고, 헤더 셀을
              드래그 선택해 '셀 합치기'·'셀 색'으로 병합·색 지정. */}
          <div
            className="flex items-center gap-0.5 rounded-md border bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground"
            title="헤더(제목) 행 수. + 로 위에 그룹 헤더 행을 추가하고, 셀을 드래그 선택해 '셀 합치기'로 병합·색을 줄 수 있습니다."
            data-cell-selection-allow
          >
            헤더 행
            <button
              type="button"
              onClick={removeHeaderRowTop}
              className="px-1 text-sm leading-none hover:text-foreground"
              title={headerRowCount <= 1 ? '헤더를 기본(1줄)으로' : '맨 위 헤더 행 삭제'}
            >
              −
            </button>
            <span className="w-3 text-center tabular-nums">
              {headerRowCount || 1}
            </span>
            <button
              type="button"
              onClick={addHeaderRowTop}
              className="px-1 text-sm leading-none hover:text-foreground"
              title="맨 위에 헤더 행 추가(그룹 헤더)"
            >
              +
            </button>
          </div>
          {/* 셀 배경 — 선택이 있으면(1셀 포함) 배경색 지정. 글자색은 "글자
              서식"으로 옮겨 중복 제거. */}
          {selection.rect && (
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-[11px] rounded-md border bg-muted/40"
                  title="선택한 셀의 배경색"
                >
                  <Palette className="mr-1 h-3 w-3" />셀 배경
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                className="w-auto p-3"
                data-cell-selection-allow
              >
                <ColorSwatchPicker
                  value={null}
                  onChange={(t) => applyCellColor('bg', t)}
                  size={18}
                />
              </PopoverContent>
            </Popover>
          )}
          {/* 정렬 — 선택한 셀들의 가로·세로 정렬을 일괄 지정(cell_styles 에 저장). */}
          {selection.rect && (
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-[11px] rounded-md border bg-muted/40"
                  title="선택한 셀의 가로·세로 정렬"
                >
                  <AlignCenter className="mr-1 h-3 w-3" />정렬
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                className="w-auto p-2"
                data-cell-selection-allow
              >
                <CellAlignControl onApply={applyCellColor} />
              </PopoverContent>
            </Popover>
          )}
          {/* 글자 서식 — 선택한 셀들의 굵기/기울임/크기/글꼴/색을 한꺼번에.
              텍스트 셀은 글자 내부 서식으로, 행 라벨/이미지 셀은 색·크기만
              셀 단위로 함께 적용된다. */}
          {selection.rect && (
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-[11px] rounded-md border bg-muted/40"
                  title="선택한 셀들의 글자 서식(굵기·크기·글꼴·색)을 일괄 변경"
                >
                  <TypeIcon className="mr-1 h-3 w-3" />글자 서식
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                className="w-auto p-2 space-y-2"
                data-cell-selection-allow
              >
                <div className="flex items-center gap-1 flex-wrap">
                  <RichTextFormatToolbarBody
                    state={_BULK_TOOLBAR_STATE}
                    actions={bulkFormatActions}
                    defaultSizePx={bodyFontPx}
                  />
                </div>
                <button
                  type="button"
                  onClick={clearBulkFormat}
                  className="text-[11px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                  title="선택한 셀들의 글자 서식을 모두 지움"
                >
                  서식 지우기
                </button>
              </PopoverContent>
            </Popover>
          )}
          {/* 셀 병합 / 분할 액션 바 — 선택이 1셀 이상이고 의미있는
              범위일 때만 표시. cross-zone (행 라벨 ↔ case) 선택은
              비활성. */}
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
                  disabled={selectionCrossesZone}
                  title={
                    selectionCrossesZone
                      ? '행 라벨 컬럼과 CASE 컬럼은 같이 합칠 수 없습니다.'
                      : '선택한 사각형을 한 셀로 합치기'
                  }
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
                  title="선택한 셀이 속한 열들의 폭을 같게 맞춤"
                >
                  폭을 균일하게
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
        </div>
        {/* 표 폭 핸들이 항상 보이도록, 폭(tableBoxStyle)은 relative 외곽 div
            가 갖고, 핸들은 overflow 박스 *바깥*(외곽 div)에 둔다 — 안에 두면
            overflow-hidden 에 잘려 사라졌다. */}
        <div className="relative" style={tableBoxStyle}>
        <div
          ref={(el) => {
            grid.gridRef.current = el
            selection.containerRef.current = el
          }}
          className={cn(
            'rounded-md border',
            horizontalScroll ? 'overflow-x-auto' : 'overflow-x-hidden',
            selection.crossCellDragging && 'select-none cursor-cell',
          )}
          onMouseUp={selection.handleMouseUp}
        >
          <table
            className={cn(
              'text-sm w-full table-fixed',
              horizontalScroll && 'w-max min-w-full',
              gridClass,
            )}
            style={gridVars}
          >
            <colgroup>
              <col style={rowLabelColStyle()} />
              {cases.map((c) => (
                <col key={c.key} style={caseColStyle(c.key)} />
              ))}
            </colgroup>
            <thead className="bg-muted/40">
              {headerRowCount > 0 ? (
                renderHeaderEditRows()
              ) : (
              <tr>
                <th
                  data-cell-coord="0,0"
                  onMouseDown={(e) => selection.handleMouseDown(e, 0, 0)}
                  onMouseEnter={() => selection.handleMouseEnter(0, 0)}
                  onMouseLeave={() => selection.handleMouseLeave(0, 0)}
                  className={cn(
                    'px-1 py-1 text-center font-medium text-xs text-muted-foreground border-b border-r relative',
                    selection.isCellSelected(0, 0) &&
                      'bg-primary/10 ring-1 ring-primary/40',
                  )}
                >
                  <span className="text-[10px]">행 / CASE</span>
                  {/* 행 라벨 컬럼도 case 컬럼과 동일한 핸들 패턴으로 폭 조절.
                      더블클릭 시 기본 폭으로 리셋. */}
                  <div
                    role="separator"
                    aria-orientation="vertical"
                    title="끌어서 행 라벨 폭 조절 · 더블클릭하면 기본값으로"
                    onMouseDown={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      const th = e.currentTarget.closest('th')
                      startCaseResize(ROW_LABEL_KEY, th, e)
                    }}
                    onDoubleClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      if (storedRowLabelWidth == null) return
                      patch({ row_label_width: undefined })
                    }}
                    className="absolute right-0 top-0 h-full w-2 cursor-col-resize flex items-center justify-end group/handle z-10"
                  >
                    <span className="block w-0.5 h-1/2 bg-border group-hover/handle:bg-primary transition-colors" />
                  </div>
                </th>
                {cases.map((c, ci) => (
                  <th
                    key={ci}
                    data-cell-coord={`0,${ci + 1}`}
                    onMouseDown={(e) => selection.handleMouseDown(e, 0, ci + 1)}
                    onMouseEnter={() => selection.handleMouseEnter(0, ci + 1)}
                    onMouseLeave={() => selection.handleMouseLeave(0, ci + 1)}
                    className={cn(
                      'px-1 py-1 text-center font-medium text-xs text-muted-foreground border-b group relative',
                      selection.isCellSelected(0, ci + 1) &&
                        'bg-primary/10 ring-1 ring-primary/40',
                    )}
                  >
                    <div className="flex items-start gap-0.5">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-5 w-5 shrink-0 opacity-0 group-hover:opacity-100"
                        disabled={ci === 0}
                        onClick={() => moveCase(ci, -1)}
                        title="왼쪽으로"
                      >
                        <ChevronLeft className="h-3 w-3" />
                      </Button>
                      <AutoGrowTextarea
                        value={c.label || ''}
                        onChange={(v) => updateCase(ci, { label: v })}
                        onPaste={(e) => {
                          // CASE 라벨 칸: 엑셀 헤더 포함 붙여넣기 — 첫 행은
                          // CASE 이름, 나머지는 값.
                          const text = e.clipboardData?.getData('text/plain')
                          if (!isMultiCellPaste(text)) return
                          e.preventDefault()
                          pasteCaseLabels(ci, text)
                        }}
                        placeholder={c.key}
                        style={{ fontSize: bodyFontPx }}
                        className="bg-transparent border-0 outline-none focus:ring-1 focus:ring-ring rounded px-1 py-0.5 text-center flex-1 min-w-0 font-semibold resize-none whitespace-pre-wrap break-words"
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-5 w-5 shrink-0 opacity-0 group-hover:opacity-100"
                        disabled={ci === cases.length - 1}
                        onClick={() => moveCase(ci, 1)}
                        title="오른쪽으로"
                      >
                        <ChevronRight className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-5 w-5 shrink-0 opacity-0 group-hover:opacity-100 text-destructive"
                        onClick={() => removeCase(ci)}
                        disabled={cases.length <= 1}
                        title="CASE 삭제"
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                    {/* 우측 가장자리 드래그 핸들 — 개별 CASE 컬럼 폭 조절.
                        마지막 CASE 는 표 우측 경계 핸들(아래 외곽 div)이 그
                        자리를 맡으므로 헤더 핸들을 그리지 않는다(중복 방지). */}
                    {ci < cases.length - 1 && (
                      <div
                        role="separator"
                        aria-orientation="vertical"
                        title="끌어서 컬럼 폭 조절 · 더블클릭하면 기본값으로"
                        onMouseDown={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          startCaseResize(c.key, e.currentTarget.closest('th'), e)
                        }}
                        onDoubleClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          if (c.key in columnWidths) {
                            const keep = { ...columnWidths }
                            delete keep[c.key]
                            patch({ column_widths: keep })
                          }
                        }}
                        className="absolute right-0 top-0 h-full w-2 cursor-col-resize flex items-center justify-end group/handle z-10"
                      >
                        <span className="block w-0.5 h-1/2 bg-border group-hover/handle:bg-primary transition-colors" />
                      </div>
                    )}
                  </th>
                ))}
              </tr>
              )}
            </thead>
            <tbody>
              {rows.map((row, ri) => {
                // 편집모드에서도 covered 셀은 skip + anchor 에만 span attr.
                // 좌표: c=0 → 행 라벨, c=1..M → cases[c-1].
                const labelKey = `${ri},0`
                const labelCovered = mergeMap.covered.has(labelKey)
                const labelSpan = mergeMap.anchors.get(labelKey)
                const lstyle = cellStyles[`${row.key}::${ROW_LABEL_KEY}`]
                return (
                  <tr key={row.key ?? ri} className="border-b last:border-b-0 group">
                    {!labelCovered && (
                      <td
                        data-cell-coord={`${headerOffset + ri},0`}
                        // 일반 클릭은 input focus 그대로. 드래그가 셀
                        // 경계를 넘으면 hook 이 promote 해 multi-cell 전환.
                        onMouseDown={(e) =>
                          selection.handleMouseDown(e, headerOffset + ri, 0)
                        }
                        onMouseEnter={() =>
                          selection.handleMouseEnter(headerOffset + ri, 0)
                        }
                        onMouseLeave={() =>
                          selection.handleMouseLeave(headerOffset + ri, 0)
                        }
                        {...(labelSpan?.rs > 1 ? { rowSpan: labelSpan.rs } : {})}
                        {...(labelSpan?.cs > 1 ? { colSpan: labelSpan.cs } : {})}
                        className={cn(
                          // 기본 정렬은 "표" 위젯과 동일하게 가로 중앙(셀 지정 우선).
                          'px-1 py-1 border-r bg-muted/10',
                          hAlignClass(lstyle?.align),
                          // 세로: 셀 지정 우선, 없으면 병합 시 가운데·아니면 위.
                          vAlignClass(lstyle?.valign, labelSpan?.rs > 1 ? 'align-middle' : 'align-top'),
                          cellStyleClass(row.key, ROW_LABEL_KEY),
                          selection.isCellSelected(headerOffset + ri, 0) &&
                            'bg-primary/10 ring-1 ring-primary/40',
                        )}
                      >
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
                          <AutoGrowTextarea
                            value={row.label ?? ''}
                            onChange={(v) => updateRow(ri, { label: v })}
                            onKeyDown={(e) => grid.handleKey(e, ri, 0)}
                            onPaste={(e) => {
                              // 행 라벨 칸 = 표 좌상단. 엑셀 표(라벨+CASE값)를
                              // 통째로 붙일 수 있게: col0→행 라벨, col1..→CASE.
                              const text = e.clipboardData?.getData('text/plain')
                              if (!isMultiCellPaste(text)) return
                              e.preventDefault()
                              pasteFromRowLabel(
                                ri,
                                text,
                                parseHtmlTableMerges(
                                  e.clipboardData?.getData('text/html') || '',
                                ),
                              )
                            }}
                            data-grid-cell={`${ri}:0`}
                            placeholder="행 이름"
                            style={{
                              fontSize: cellSizePx(row.key, ROW_LABEL_KEY) ?? bodyFontPx,
                            }}
                            className="flex-1 min-w-0 resize-none rounded-md border border-input bg-background px-2 py-0.5 leading-snug focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring whitespace-pre-wrap break-words"
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
                    )}
                    {cases.map((c, ci) => {
                      const coord = `${ri},${ci + 1}`
                      if (mergeMap.covered.has(coord)) return null
                      const span = mergeMap.anchors.get(coord)
                      const selected = selection.isCellSelected(
                        headerOffset + ri,
                        ci + 1,
                      )
                      const dstyle = cellStyles[`${row.key}::${c.key}`]
                      return (
                        <td
                          key={ci}
                          data-cell-coord={`${headerOffset + ri},${ci + 1}`}
                          onMouseDown={(e) =>
                            selection.handleMouseDown(e, headerOffset + ri, ci + 1)
                          }
                          onMouseEnter={() =>
                            selection.handleMouseEnter(headerOffset + ri, ci + 1)
                          }
                          onMouseLeave={() =>
                            selection.handleMouseLeave(headerOffset + ri, ci + 1)
                          }
                          {...(span?.rs > 1 ? { rowSpan: span.rs } : {})}
                          {...(span?.cs > 1 ? { colSpan: span.cs } : {})}
                          className={cn(
                            // 기본 정렬은 "표" 위젯과 동일하게 가로 중앙(셀 지정 우선).
                            'px-1 py-1',
                            hAlignClass(dstyle?.align),
                            // 세로: 셀 지정 우선, 없으면 병합 시 가운데·아니면 위.
                            vAlignClass(dstyle?.valign, span?.rs > 1 ? 'align-middle' : 'align-top'),
                            cellStyleClass(row.key, c.key),
                            selected && 'bg-primary/10 ring-1 ring-primary/40',
                          )}
                        >
                          {row.kind === 'image' ? (
                            <ImageCellEditor
                              value={row.values?.[c.key]}
                              onChange={(v) => setCellImage(ri, c.key, v)}
                              maxHeightPx={imageMaxHeightPx}
                            />
                          ) : (
                            <TextCellEditor
                              value={row.values?.[c.key]}
                              html={cellHtml[`${row.key}::${c.key}`]}
                              onChangeRich={(html, text) =>
                                setCellRich(ri, row.key, c.key, html, text)
                              }
                              onKeyDown={(e) => grid.handleKey(e, ri, ci + 1)}
                              onMultiPaste={(text, html) =>
                                pasteGrid(ri, ci, text, parseHtmlTableMerges(html))
                              }
                              gridCellKey={`${ri}:${ci + 1}`}
                              fontSizePx={bodyFontPx}
                              registerEditor={registerEditor}
                            />
                          )}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
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
        {/* 표 전체 폭 드래그 핸들 — 표 박스 오른쪽 경계(외곽 div 기준)에 항상
            보이게. 끌면 table_width_px 조절, 더블클릭 = 전체 폭. */}
        <div
          role="separator"
          aria-orientation="vertical"
          title="끌어서 표 전체 폭 조절 · 더블클릭하면 전체 폭"
          onMouseDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
            startTableResize(e)
          }}
          onDoubleClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            patch({ table_width_px: undefined })
          }}
          className="absolute right-0 top-0 h-full w-2.5 cursor-col-resize flex items-center justify-center group/twh z-30"
        >
          <span className="block w-1 h-1/4 rounded bg-primary/40 group-hover/twh:bg-primary transition-colors" />
        </div>
        </div>
        </>
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
      <NoteInput
        value={note}
        onChange={(v) => patch({ note: v })}
        html={content?.note_html}
        onChangeRich={(h, t) =>
          patch({
            note_html: t?.trim() ? h : undefined,
            note: t?.trim() ? t : undefined,
          })
        }
      />
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Cell editors                                                                //
// --------------------------------------------------------------------------- //

function TextCellEditor({
  value,
  html,
  onChangeRich,
  onKeyDown,
  gridCellKey,
  fontSizePx = DEFAULT_BODY_FONT_PX,
  onMultiPaste,
  registerEditor,
}) {
  // rich 에디터 — 셀 안 텍스트 일부를 선택해 색·서식(긴 글처럼). 평문 값은
  // onChangeRich 가 함께 동기화. 엑셀 TSV 붙여넣기는 onPastePlain 으로 가로채
  // 여러 셀로 펼친다. data-grid-cell 로 그리드 포커스·Tab 이동 유지(화살표
  // 셀 점프는 캐럿 이동으로 대체).
  return (
    <div className="outline-rich-row w-full">
      <RichTextRowEditor
        ref={
          registerEditor ? (api) => registerEditor(gridCellKey, api) : undefined
        }
        html={_richSeed(html, typeof value === 'string' ? value : '')}
        onChange={onChangeRich}
        onKeyDown={onKeyDown}
        onPastePlain={onMultiPaste}
        gridCellKey={gridCellKey}
        placeholder="텍스트 / 숫자"
        defaultSizePx={fontSizePx}
        style={{ fontSize: fontSizePx }}
        className="w-full min-h-[2.5rem] rounded-md border border-input bg-background px-2 py-1 leading-snug whitespace-pre-wrap break-words"
      />
    </div>
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
  // 같은 복사라도 클립보드에 여러 포맷·해상도가 들어있을 수 있어(특히 PPT),
  // 가장 큰 해상도를 골라 올린다. preventDefault·동기 후보 수집은 await 이전.
  async function onPaste(e) {
    const hasImage = Array.from(e.clipboardData?.items ?? []).some(
      (it) => it.kind === 'file' && it.type.startsWith('image/'),
    )
    if (!hasImage) return
    e.preventDefault()
    const { chosen, candidates } = await pickBestPastedImage(e)
    logPastedImageDiagnostics(candidates, chosen)
    if (!chosen) {
      toast.error('클립보드에서 이미지를 찾지 못했습니다.')
      return
    }
    const warn = lowResWarning(chosen)
    if (warn) toast.warning(warn, { duration: 6000 })
    const file = pastedImageToFile(chosen)
    if (file) handleFiles([file])
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

function ReadOnlyCell({
  row,
  caseKey,
  html,
  imageMaxHeightPx = DEFAULT_IMAGE_MAX_HEIGHT_PX,
  fontSizePx = DEFAULT_BODY_FONT_PX,
}) {
  const value = row.values?.[caseKey]
  const hasRich = row.kind !== 'image' && !_richIsEmpty(html)
  if (!hasRich && (value == null || value === '')) {
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
  // Text rows: rich 마크업이 있으면 우선 렌더(긴 글처럼 부분 색), 없으면 평문.
  return (
    <div
      className="whitespace-pre-wrap break-words"
      style={{ fontSize: fontSizePx }}
    >
      {hasRich ? (
        <span
          className="[&_p]:m-0"
          dangerouslySetInnerHTML={{ __html: sanitizeCaptionHtml(html) }}
        />
      ) : (
        String(value)
      )}
    </div>
  )
}
