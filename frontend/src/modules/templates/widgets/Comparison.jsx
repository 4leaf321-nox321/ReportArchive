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
  AutoGrowTextarea,
  CaptionInput,
  computeMergeMap,
  DEFAULT_BODY_FONT_PX,
  EditorOptionBar,
  EditorOptionNumber,
  EditorOptionToggle,
  LabelField,
  normalizeMerges,
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
  useGridNavigation,
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
  // 셀 병합 side-table. 비교표 좌표계:
  //   c = 0      → 행 라벨 컬럼
  //   c = 1..M   → case 컬럼 (cases[c-1])
  // 행 라벨 ↔ case 구역 cross-zone 병합은 정규화 단계에서 자동 dissolve.
  // 빈 배열/없음이면 기존 렌더와 100% 동일.
  const merges = Array.isArray(content?.merges) ? content.merges : []
  const totalColCount = cases.length + 1 // row label + each case
  const mergeMap = computeMergeMap(merges, rows.length, totalColCount)
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
  // 마지막 CASE 핸들 드래그 중 표 전체 폭 프리뷰 — mouseup 에 commit.
  const [tableResizePreview, setTableResizePreview] = useState(null) // px | null
  const effTableWidthPx = tableResizePreview ?? tableWidthPx
  const tableBoxStyle = effTableWidthPx
    ? { width: `${effTableWidthPx}px`, maxWidth: '100%' }
    : undefined
  // 셀간 화살표 네비게이션. 컬럼 좌표: 0 = 행 라벨, 1..M = case 셀.
  // 행 좌표: 0..N-1 = 데이터 행 (헤더는 Tab 으로만 이동).
  const grid = useGridNavigation()

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
  function pasteGrid(startRowIdx, startCaseIdx, text) {
    const tsv = parseTsv(text)
    if (tsv.length === 0) return
    const width = Math.max(...tsv.map((r) => r.length))
    const { nextCases, nextRows } = ensureSize(
      startCaseIdx + width,
      startRowIdx + tsv.length,
    )
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
      }
      nextRows[startRowIdx + r] = { ...row, values }
    }
    patch({ cases: nextCases, rows: nextRows })
    maybeWarnMaxCases(nextCases.length)
  }
  /** 행 라벨 칸에 붙여넣기 — 엑셀에서 "라벨 + CASE 값" 표를 통째로 붙일 때.
   *  TSV col0 → 행 라벨, col1.. → CASE0.. 값. 좌상단부터 표 전체 붙이기. */
  function pasteFromRowLabel(startRowIdx, text) {
    const tsv = parseTsv(text)
    if (tsv.length === 0) return
    const width = Math.max(...tsv.map((r) => r.length))
    const { nextCases, nextRows } = ensureSize(
      Math.max(cases.length, width - 1),
      startRowIdx + tsv.length,
    )
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
        }
      }
      nextRows[startRowIdx + r] = next
    }
    patch({ cases: nextCases, rows: nextRows })
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
      }
      nextRows[r - 1] = { ...row, values }
    }
    patch({ cases: nextCases, rows: nextRows })
    maybeWarnMaxCases(nextCases.length)
  }

  // ─── 셀 병합 / 분할 ──────────────────────────────────────────────
  // 비교표 좌표계: c=0 → 행 라벨 컬럼, c=1..M → cases[c-1]. 행 라벨
  // 컬럼과 case 구역을 가로지르는 cross-zone 병합은 시각적으로
  // 의미가 모호하므로 차단 — selection 범위가 그 경계를 넘으면 합치기
  // 버튼이 비활성화된다. 합치기 후엔 normalizeMerges 가 다시 한번
  // grid clamp / overlap dissolve / 1×1 drop 까지 보정.
  const selection = useCellSelection({
    rowCount: rows.length,
    colCount: cases.length + 1,
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
      cases.length + 1,
    )
    patch({ merges: nextMerges })
    selection.clear()
  }
  function unmergeSelection() {
    const r = selection.rect
    if (!r) return
    const kept = (merges ?? []).filter((m) => {
      const last_r = m.r + m.rs - 1
      const last_c = m.c + m.cs - 1
      return !(m.r <= r.r2 && last_r >= r.r1 && m.c <= r.c2 && last_c >= r.c1)
    })
    patch({
      merges: normalizeMerges(kept, rows.length, cases.length + 1),
    })
    selection.clear()
  }
  const selectionRect_ = selection.rect
  const selectionCrossesZone =
    selectionRect_ != null &&
    selectionRect_.c1 === 0 &&
    selectionRect_.c2 >= 1
  const selectionHasMerge = (() => {
    const r = selectionRect_
    if (!r) return false
    return (merges ?? []).some((m) => {
      const last_r = m.r + m.rs - 1
      const last_c = m.c + m.cs - 1
      return m.r <= r.r2 && last_r >= r.r1 && m.c <= r.c2 && last_c >= r.c1
    })
  })()
  const selectionSpansMultiple =
    !!selectionRect_ &&
    (selectionRect_.r2 > selectionRect_.r1 ||
      selectionRect_.c2 > selectionRect_.c1)
  // 선택이 2개 이상 열에 걸쳤나 — "폭을 균일하게" 버튼 노출 조건.
  const selectionSpansCols =
    !!selectionRect_ && selectionRect_.c2 > selectionRect_.c1

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
            style={tableBoxStyle}
          >
            <table
              className={cn(
                'text-sm w-full table-fixed',
                horizontalScroll && 'w-max min-w-full',
              )}
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
              </thead>
              <tbody>
                {rows.map((row, ri) => {
                  // 좌표 c=0 → 행 라벨, c=1..M → cases[c-1]. covered 셀
                  // 출력 skip + anchor 에만 rowSpan/colSpan.
                  const labelKey = `${ri},0`
                  const labelCovered = mergeMap.covered.has(labelKey)
                  const labelSpan = mergeMap.anchors.get(labelKey)
                  return (
                    <tr key={ri} className="border-b last:border-b-0">
                      {!labelCovered && (
                        <td
                          {...(labelSpan?.rs > 1 ? { rowSpan: labelSpan.rs } : {})}
                          {...(labelSpan?.cs > 1 ? { colSpan: labelSpan.cs } : {})}
                          style={{ fontSize: bodyFontPx }}
                          className="px-2 py-1.5 font-medium border-r bg-muted/20 align-top whitespace-pre-wrap break-words"
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
                        return (
                          <td
                            key={ci}
                            {...(span?.rs > 1 ? { rowSpan: span.rs } : {})}
                            {...(span?.cs > 1 ? { colSpan: span.cs } : {})}
                            className="px-2 py-1.5 align-top"
                          >
                            <ReadOnlyCell
                              row={row}
                              caseKey={c.key}
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
          className="flex justify-end items-center gap-2"
          // outside-click 핸들러가 액션 바 클릭으로 selection 을 지우지
          // 못하게 면역 영역으로 표시.
          data-cell-selection-allow
        >
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
            )}
          >
            <colgroup>
              <col style={rowLabelColStyle()} />
              {cases.map((c) => (
                <col key={c.key} style={caseColStyle(c.key)} />
              ))}
            </colgroup>
            <thead className="bg-muted/40">
              <tr>
                <th className="px-1 py-1 text-center font-medium text-xs text-muted-foreground border-b border-r relative">
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
                    className="px-1 py-1 text-center font-medium text-xs text-muted-foreground border-b group relative"
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
            </thead>
            <tbody>
              {rows.map((row, ri) => {
                // 편집모드에서도 covered 셀은 skip + anchor 에만 span attr.
                // 좌표: c=0 → 행 라벨, c=1..M → cases[c-1].
                const labelKey = `${ri},0`
                const labelCovered = mergeMap.covered.has(labelKey)
                const labelSpan = mergeMap.anchors.get(labelKey)
                return (
                  <tr key={row.key ?? ri} className="border-b last:border-b-0 group">
                    {!labelCovered && (
                      <td
                        data-cell-coord={`${ri},0`}
                        // 일반 클릭은 input focus 그대로. 드래그가 셀
                        // 경계를 넘으면 hook 이 promote 해 multi-cell 전환.
                        onMouseDown={(e) =>
                          selection.handleMouseDown(e, ri, 0)
                        }
                        onMouseEnter={() => selection.handleMouseEnter(ri, 0)}
                        onMouseLeave={() => selection.handleMouseLeave(ri, 0)}
                        {...(labelSpan?.rs > 1 ? { rowSpan: labelSpan.rs } : {})}
                        {...(labelSpan?.cs > 1 ? { colSpan: labelSpan.cs } : {})}
                        className={cn(
                          'px-1 py-1 align-top border-r bg-muted/10',
                          selection.isCellSelected(ri, 0) &&
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
                              pasteFromRowLabel(ri, text)
                            }}
                            data-grid-cell={`${ri}:0`}
                            placeholder="행 이름"
                            style={{ fontSize: bodyFontPx }}
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
                      const selected = selection.isCellSelected(ri, ci + 1)
                      return (
                        <td
                          key={ci}
                          data-cell-coord={`${ri},${ci + 1}`}
                          onMouseDown={(e) =>
                            selection.handleMouseDown(e, ri, ci + 1)
                          }
                          onMouseEnter={() =>
                            selection.handleMouseEnter(ri, ci + 1)
                          }
                          onMouseLeave={() =>
                            selection.handleMouseLeave(ri, ci + 1)
                          }
                          {...(span?.rs > 1 ? { rowSpan: span.rs } : {})}
                          {...(span?.cs > 1 ? { colSpan: span.cs } : {})}
                          className={cn(
                            'px-1 py-1 align-top',
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
                              onChange={(v) => setCellText(ri, c.key, v)}
                              onKeyDown={(e) => grid.handleKey(e, ri, ci + 1)}
                              onMultiPaste={(text) => pasteGrid(ri, ci, text)}
                              gridCellKey={`${ri}:${ci + 1}`}
                              fontSizePx={bodyFontPx}
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
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Cell editors                                                                //
// --------------------------------------------------------------------------- //

function TextCellEditor({
  value,
  onChange,
  onKeyDown,
  gridCellKey,
  fontSizePx = DEFAULT_BODY_FONT_PX,
  onMultiPaste,
}) {
  // `value` is a plain string for text rows. We render a multi-line textarea
  // so writers can compare longer descriptions side by side without
  // truncating; rows naturally grow as content gets longer. Enter inserts a
  // newline; arrow keys at the cell boundary jump to the neighbor cell
  // (wired via the `useGridNavigation` hook on the editor).
  return (
    <textarea
      value={typeof value === 'string' ? value : ''}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      onPaste={(e) => {
        // 엑셀에서 복사한 여러 셀(TSV)이면 그리드로 채운다. 단일 셀은 기본
        // 붙여넣기(textarea)에 맡긴다.
        const text = e.clipboardData?.getData('text/plain')
        if (!isMultiCellPaste(text)) return
        e.preventDefault()
        onMultiPaste?.(text)
      }}
      data-grid-cell={gridCellKey}
      rows={2}
      placeholder="텍스트 / 숫자"
      style={{ fontSize: fontSizePx }}
      className="w-full min-h-[2.5rem] resize-y rounded-md border border-input bg-background px-2 py-1 leading-snug focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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

function ReadOnlyCell({
  row,
  caseKey,
  imageMaxHeightPx = DEFAULT_IMAGE_MAX_HEIGHT_PX,
  fontSizePx = DEFAULT_BODY_FONT_PX,
}) {
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
    <div
      className="whitespace-pre-wrap break-words"
      style={{ fontSize: fontSizePx }}
    >
      {String(value)}
    </div>
  )
}
