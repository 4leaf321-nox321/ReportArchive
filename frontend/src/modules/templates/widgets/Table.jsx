import { createContext, useContext, useState, useRef, useCallback } from 'react'
import { AlignCenter, Grid3x3, Maximize2, Minimize2, Palette, Type } from 'lucide-react'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/shared/components/ui/popover'
import { AutoGrowTextarea, CaptionInput, DataTableActions, DEFAULT_BODY_FONT_PX, FieldItemListEditor, LabelField, NoteInput, PreviewLabel, TextStyleField, captionSkipProps, CellAlignControl, computeMergeMap, hAlignClass, normalizeMerges, parseHtmlTableMerges, shiftMergesForCol, shiftMergesForRow, textStyleToClassName, textStyleToInlineStyle, toTsv, useCellSelection, useGridNavigation, vAlignClass, _richIsEmpty, _richSeed, sanitizeCaptionHtml } from './_shared'
import { RichTextRowEditor, RichTextFormatToolbarBody, MIXED_FONT_SIZE } from './RichTextRowEditor'
import { ColorSwatchPicker, bgTokenClass, colorTokenClass, normalizeToken } from '@/shared/text-color'

// 셀 색상 사이드테이블 키 — `${rowIndex}::${colKey}`. (열 key 는 안정적이라
// 열 reorder 영향 없음; 행 인덱스는 삭제/이동 시 아래 헬퍼로 시프트.)
const _cellKey = (r, colKey) => `${r}::${colKey}`

function _shiftCellStylesRowRemove(styles, removedIdx) {
  const out = {}
  for (const [k, v] of Object.entries(styles)) {
    const [rStr, colKey] = k.split('::')
    const r = Number(rStr)
    if (r === removedIdx) continue
    out[`${r > removedIdx ? r - 1 : r}::${colKey}`] = v
  }
  return out
}

function _shiftCellStylesRowSwap(styles, a, b) {
  const out = {}
  for (const [k, v] of Object.entries(styles)) {
    const [rStr, colKey] = k.split('::')
    const r = Number(rStr)
    const nr = r === a ? b : r === b ? a : r
    out[`${nr}::${colKey}`] = v
  }
  return out
}

// 헤더에서 작성자가 고를 수 있는 열 타입 — 텍스트/숫자/날짜/선택지. 선택지는
// 옵션 목록이 필요하므로 그 타입일 때만 옆에 '선택지 편집' 팝오버가 따로 뜬다.
const _COL_TYPE_OFFER = [
  { value: 'text', label: '텍스트' },
  { value: 'number', label: '숫자' },
  { value: 'date', label: '날짜' },
  { value: 'select', label: '선택지' },
]
const _COL_TYPE_LABEL = {
  text: '텍스트',
  number: '숫자',
  integer: '정수',
  date: '날짜',
  select: '선택지',
}

function ColumnTypeSelect({ value, onChange, options, onOptionsChange }) {
  const cur = value ?? 'text'
  const opts = [..._COL_TYPE_OFFER]
  // 현재 타입이 제안 목록에 없으면(정수 등) 맨 앞에 끼워 현재값을 그대로
  // 표시 — 그래야 select 가 빈칸으로 안 보이고, 다른 타입으로 바꿀 수도.
  if (!opts.some((o) => o.value === cur)) {
    opts.unshift({ value: cur, label: _COL_TYPE_LABEL[cur] ?? cur })
  }
  return (
    <div className="flex items-center gap-0.5">
      <select
        value={cur}
        // th 의 셀-선택 mousedown 으로 번지지 않게 — 클릭은 타입 변경만.
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => onChange(e.target.value)}
        title="이 열의 입력 형식 — 텍스트(서식·자유 입력) / 숫자 / 날짜 / 선택지"
        className="h-5 rounded border border-input bg-background/95 px-0.5 text-[10px] leading-none shadow-sm"
      >
        {opts.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {/* 선택지 타입일 때만 옵션(드롭다운 항목) 편집 팝오버. */}
      {cur === 'select' && onOptionsChange && (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              title="드롭다운 선택지 편집 (쉼표로 구분)"
              className="h-5 rounded border border-input bg-background/95 px-1 text-[10px] leading-none shadow-sm hover:bg-muted"
            >
              선택지{options?.length ? ` ${options.length}` : ''}
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-56 p-2"
            data-cell-selection-allow
          >
            <div className="text-[10px] uppercase text-muted-foreground mb-1">
              선택지 (쉼표로 구분)
            </div>
            <Input
              // 비제어(defaultValue) — 입력 중 trailing 쉼표가 잘려 다음 항목을
              // 못 치는 걸 막는다. 팝오버를 열 때마다 현재 옵션으로 다시 초기화.
              defaultValue={(options ?? []).join(', ')}
              onMouseDown={(e) => e.stopPropagation()}
              onChange={(e) =>
                onOptionsChange(
                  e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                )
              }
              placeholder="높음, 보통, 낮음"
              className="h-8 text-xs"
            />
          </PopoverContent>
        </Popover>
      )}
    </div>
  )
}

// 다중 셀 일괄 서식 툴바의 정적 state — 선택 영역이 여러 셀이라 "현재 활성
// 서식"이라는 개념이 없으므로 전부 비활성. 클릭하면 적용(set)만 한다.
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

function useTableExpanded(initial = false) {
  const ctx = useContext(TableViewContext)
  // Provider 가 없으면 컴포넌트 내부 useState 로 폴백. Hook 호출 위치는
  // 컴포넌트 함수 본문 한 곳이라 React 의 Rules of Hooks 와 충돌 안 함.
  // (ctx 가 null/undefined 인 경우에만 useState 가 의미 있는 값을 들고
  // 가고, ctx 가 있으면 useState 의 setter 는 그냥 무시된다.)
  // initial = content.expanded — 보고서에 저장된 기본 펼침 상태로 시작하고,
  // 독자가 토글로 일시 변경 가능(저장값은 안 바뀜).
  const local = useState(initial)
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
// 표 전체 폭(px) 허용 범위 — 마지막 열 핸들 드래그·표 폭 입력 공통. 백엔드
// table_width_px 검증(120~4000)과 일치.
const TABLE_WIDTH_MIN_PX = 120
const TABLE_WIDTH_MAX_PX = 4000

export function TableEditor({ props, content, onChange, readOnly }) {
  // Effective columns: per-report override (content.columns) takes precedence
  // over template defaults (props.columns). Once the report writer touches
  // columns, content.columns becomes the full column list for this report.
  const templateCols = props.columns ?? []
  const overrideCols = content?.columns
  const cols = Array.isArray(overrideCols) ? overrideCols : templateCols
  const caption = content?.caption ?? ''
  const note = content?.note ?? ''
  const rawRows = content?.rows ?? []
  // 편집 모드에서 행이 하나도 없으면 빈 행 한 줄을 기본으로 보여준다 — 어디에
  // 입력/붙여넣기 해야 할지 바로 알 수 있게. 저장값(content.rows)은 그대로 비어
  // 있고, 첫 입력·붙여넣기 때 실제 행이 생긴다. 읽기 모드는 영향 없음(빈 표는
  // 그대로 숨김 — readOnly 분기의 rows.length===0 가 유지됨).
  const rows = !readOnly && rawRows.length === 0 ? [{}] : rawRows
  // 셀 병합 side-table. `merges = [{r,c,rs,cs}]` 형태. 빈 배열/없음이면
  // 기존 렌더와 100% 동일하게 동작. anchor 가 아닌 covered 셀은 출력 단계
  // 에서 건너뛰고, anchor 에만 rowSpan/colSpan attr 가 붙는다.
  const merges = Array.isArray(content?.merges) ? content.merges : []
  const mergeMap = computeMergeMap(merges, rows.length, cols.length)
  // 셀별 배경/글자 색(토큰). 값 모델과 분리된 사이드테이블.
  const cellStyles =
    content?.cell_styles && typeof content.cell_styles === 'object'
      ? content.cell_styles
      : {}
  function cellStyleClass(r, colKey) {
    const s = cellStyles[_cellKey(r, colKey)]
    if (!s) return ''
    return `${bgTokenClass(s.bg)} ${colorTokenClass(s.fg)}`.trim()
  }
  // 셀 단위 글자 크기(px 문자열, 예: '20px') — 숫자/날짜/선택 셀은 인라인
  // 마크업이 없어 이걸로 크기를 준다. 없으면 undefined.
  function cellSizePx(r, colKey) {
    return cellStyles[_cellKey(r, colKey)]?.size
  }
  // 셀별 rich 마크업(긴 글처럼 per-char 색·서식). 평문 값(rows)과 분리된
  // 사이드테이블 — 키는 cell_styles 와 동일한 `${r}::${colKey}`.
  const cellHtml =
    content?.cell_html && typeof content.cell_html === 'object'
      ? content.cell_html
      : {}
  // ── 다중행·병합 헤더(선택) ───────────────────────────────────────────
  // header 가 있으면 (row_count × 열수) 작은 그리드를 thead 로 렌더 — 데이터
  // 셀과 같은 키 포맷("행::열key")·머지·색·rich 를 재사용. 없으면 기존
  // columns[].label 한 줄 헤더로 폴백(하위호환).
  const header =
    content?.header && typeof content.header === 'object' ? content.header : null
  const headerRowCount = header
    ? Math.max(1, Math.min(8, Number(header.row_count) || 1))
    : 0
  const headerCells =
    header?.cells && typeof header.cells === 'object' ? header.cells : {}
  const headerMerges = Array.isArray(header?.merges) ? header.merges : []
  const headerMergeMap = computeMergeMap(headerMerges, headerRowCount, cols.length)
  function headerCellClass(r, colKey) {
    const s = headerCells[_cellKey(r, colKey)]
    if (!s || (!s.bg && !s.fg)) return ''
    return `${bgTokenClass(s.bg)} ${colorTokenClass(s.fg)}`.trim()
  }
  const bodyTextClass = textStyleToClassName(props.text_style)
  const bodyTextStyle = textStyleToInlineStyle(props.text_style)
  // 읽기 모드 전용 — "전체 펼치기" 토글. 기본은 compact (셀이 잘림 +
  // 호버 시 툴팁). 펼치면 모든 셀이 줄바꿈으로 풀려서 길어진 행도 한
  // 눈에 보인다. BlockEditorCard 가 Provider 로 감싸서 측정용 mirror 와
  // 본체가 같은 expanded 를 공유 — 그래야 펼침 시 컨테이너 높이도 같이
  // 자란다.
  // 기본값은 '펼침' — 미설정(신규 표 포함)이면 펼친 상태로 시작. 작성자가
  // 토글로 명시적 압축(false)을 저장한 표만 compact 로 본다.
  const [expanded, setExpanded] = useTableExpanded(content?.expanded ?? true)
  // 셀간 화살표 네비게이션 — 텍스트 셀은 boundary 기준, 그 외 입력
  // (number/date/select) 은 left/right boundary 이동만 (up/down 은 native).
  const grid = useGridNavigation()
  // 표 셀 기본 글자 크기(px) — 버블/일괄 툴바의 "기본 (Npx)" 라벨용. 템플릿이
  // text_style.font_size_px 를 지정했으면 그 값, 아니면 본문 기본(18px).
  const cellDefaultSizePx = Number.isFinite(props.text_style?.font_size_px)
    ? props.text_style.font_size_px
    : DEFAULT_BODY_FONT_PX
  // 각 텍스트 셀(헤더 포함)의 RichTextRowEditor imperative handle 등록소.
  // 키: 데이터 셀 `${rowIdx}:${colIdx}` (gridCellKey 와 동일), 헤더 셀
  // `h-${hr}-${ci}`. 다중 셀 일괄 서식이 셀별 에디터에 직접 명령을 적용·수확
  // 하려고 모아 둔다. 콜백 ref 라 언마운트 시 자동 정리(null).
  const cellEditorsRef = useRef(new Map())
  const registerEditor = useCallback((key, api) => {
    const m = cellEditorsRef.current
    if (api) m.set(key, api)
    else m.delete(key)
  }, [])
  // ── 열 폭 조절 (content.column_widths) ───────────────────────────────
  // 헤더 우측 핸들을 드래그해 px 로 저장. 빠진 열은 자동(나머지 폭 균등
  // 분배). 편집/뷰 두 모드 공용 <colgroup> 으로 적용. resizePreview 는 드래그
  // 중 임시 폭 — mouseup 에 한 번만 commit.
  const columnWidths =
    content?.column_widths && typeof content.column_widths === 'object'
      ? content.column_widths
      : {}
  const [resizePreview, setResizePreview] = useState(null) // {key, px} | null
  // 표 전체 절대 폭(px) — 설정 시 표가 이 폭으로 좌측 정렬되어 편집·뷰가
  // 일치(가로 cell 을 다 안 채움). null = 전체 폭(기존 동작).
  const tableWidthPx = Number.isFinite(content?.table_width_px)
    ? content.table_width_px
    : null
  // 격자 테두리 옵션 — 켜면 표 <table> 에 .rt-grid 클래스 + CSS 변수를 주입해
  // 모든 셀에 균일 격자선(행·열)을 그린다. 굵기(1/2/3px)·색(토큰)도 함께.
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
  // 마지막 열 핸들 드래그 중 표 전체 폭 프리뷰 — mouseup 에 commit.
  const [tableResizePreview, setTableResizePreview] = useState(null) // px | null
  const effTableWidthPx = tableResizePreview ?? tableWidthPx
  const tableBoxStyle = effTableWidthPx
    ? { width: `${effTableWidthPx}px`, maxWidth: '100%' }
    : undefined

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
    if (
      !merged.cell_styles ||
      Object.keys(merged.cell_styles).length === 0
    ) {
      delete merged.cell_styles
    }
    if (!merged.cell_html || Object.keys(merged.cell_html).length === 0) {
      delete merged.cell_html
    }
    // 빈 폭 맵은 저장 안 함 — override 가 다시 0개가 되면 키 자체를 제거.
    if (
      !merged.column_widths ||
      Object.keys(merged.column_widths).length === 0
    ) {
      delete merged.column_widths
    }
    if (!Number.isFinite(merged.table_width_px)) delete merged.table_width_px
    // 격자 옵션 정리 — 꺼져 있으면 굵기·색까지 제거, 켜져 있어도 기본값
    // (1px·테마색)은 저장 안 함.
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
    if (!merged.note || !merged.note.trim()) delete merged.note
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
    if (!caption && rows.length === 0 && !note.trim()) return null
    return (
      <div className="space-y-2">
        <CaptionInput
          value={caption}
          readOnly
          placeholder={props.label}
          skipAutofill={content?.caption_skip_autofill}
          color={content?.caption_color}
          html={content?.caption_html}
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
            <div
              className={`overflow-x-auto rounded-md border ${bodyTextClass}`}
              style={{ ...bodyTextStyle, ...tableBoxStyle }}
            >
              {/* No trailing column here — edit mode reserves an action column
                  for row buttons, but in view mode that would just leave a
                  blank ~80px gap on the right. Data columns fill the full
                  width instead; widths differ slightly between modes by the
                  action column's size. */}
              <table className={`w-full text-sm table-fixed ${gridClass}`} style={gridVars}>
                <colgroup>
                  {cols.map((c, i) => (
                    <col key={i} style={colStyle(c.key)} />
                  ))}
                </colgroup>
                <thead className="bg-muted/40">
                  {headerRowCount > 0 ? (
                    Array.from({ length: headerRowCount }).map((_, hr) => (
                      <tr key={hr}>
                        {cols.map((c, ci) => {
                          if (headerMergeMap.covered.has(`${hr},${ci}`)) return null
                          const span = headerMergeMap.anchors.get(`${hr},${ci}`)
                          const cell = headerCells[_cellKey(hr, c.key)]
                          const html = cell?.html
                          const hasRich = html && !_richIsEmpty(html)
                          return (
                            <th
                              key={ci}
                              rowSpan={span?.rs}
                              colSpan={span?.cs}
                              className={`px-2 py-1.5 ${hAlignClass(cell?.align)} ${vAlignClass(cell?.valign)} font-medium text-xs text-muted-foreground border-b border-r last:border-r-0 ${headerCellClass(hr, c.key)}`.trim()}
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
                      {cols.map((c, i) => (
                        <th
                          key={i}
                          className="px-2 py-1.5 text-center font-medium text-xs text-muted-foreground border-b"
                        >
                          {c.label || c.key}
                        </th>
                      ))}
                    </tr>
                  )}
                </thead>
                <tbody>
                  {rows.map((row, ri) => (
                    <tr key={ri} className="border-b last:border-b-0">
                      {cols.map((c, ci) => {
                        // covered cell — 이미 다른 anchor 의 rowSpan/colSpan
                        // 영역에 흡수되었으므로 출력 자체를 건너뜀.
                        if (mergeMap.covered.has(`${ri},${ci}`)) return null
                        const span = mergeMap.anchors.get(`${ri},${ci}`)
                        const cs = cellStyles[_cellKey(ri, c.key)]
                        return (
                          <ReadOnlyCell
                            key={ci}
                            value={row[c.key]}
                            html={cellHtml[_cellKey(ri, c.key)]}
                            expanded={expanded}
                            rowSpan={span?.rs}
                            colSpan={span?.cs}
                            alignH={cs?.align}
                            alignV={cs?.valign}
                            cellClass={cellStyleClass(ri, c.key)}
                            cellSize={cellSizePx(ri, c.key)}
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
        <NoteInput value={note} readOnly color={content?.note_color} html={content?.note_html} />
      </div>
    )
  }
  function updateCell(rowIdx, key, value) {
    const nextRows = rows.map((r, i) => (i === rowIdx ? { ...r, [key]: value } : r))
    // 평문으로 덮어쓰면(붙여넣기·비텍스트 입력) 그 셀의 rich 마크업은 버린다.
    const k = _cellKey(rowIdx, key)
    if (cellHtml[k]) {
      const { [k]: _drop, ...rest } = cellHtml
      patch({ rows: nextRows, cell_html: rest })
    } else {
      patch({ rows: nextRows })
    }
  }
  // 텍스트 셀의 rich 편집 — 평문 text(rows)와 rich(cell_html)를 함께 동기화.
  function updateCellRich(rowIdx, key, html, text) {
    const nextRows = rows.map((r, i) =>
      i === rowIdx ? { ...r, [key]: text || undefined } : r,
    )
    const k = _cellKey(rowIdx, key)
    let nextHtml
    if (_richIsEmpty(html)) {
      const { [k]: _drop, ...rest } = cellHtml
      nextHtml = rest
    } else {
      nextHtml = { ...cellHtml, [k]: html }
    }
    patch({ rows: nextRows, cell_html: nextHtml })
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
      cell_styles: _shiftCellStylesRowRemove(cellStyles, rowIdx),
      cell_html: _shiftCellStylesRowRemove(cellHtml, rowIdx),
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
      cell_styles: _shiftCellStylesRowSwap(cellStyles, rowIdx, newIdx),
      cell_html: _shiftCellStylesRowSwap(cellHtml, rowIdx, newIdx),
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
  // 보고서 작성자가 헤더에서 이 열의 입력 형식을 바꾼다(텍스트↔숫자 등).
  // 비텍스트로 바꾸면 그 열의 rich 마크업은 의미가 없어 버리고, 숫자/정수
  // 로 바꾸면 기존 값을 best-effort 로 숫자 변환한다. content.columns 를
  // override 로 굳히는 효과(작성자가 명시적으로 손댔으므로).
  function setColumnType(idx, type) {
    const col = cols[idx]
    if (!col || (col.type ?? 'text') === type) return
    const nextCols = cols.map((c, i) => (i === idx ? { ...c, type } : c))
    const out = { columns: nextCols }
    if (type !== 'text') {
      out.cell_html = Object.fromEntries(
        Object.entries(cellHtml).filter(([k]) => k.split('::')[1] !== col.key),
      )
    }
    if (type === 'number' || type === 'integer') {
      out.rows = rows.map((r) => {
        const v = r[col.key]
        if (v === undefined || v === null || v === '') return r
        return { ...r, [col.key]: coerceCellValue({ type }, v) }
      })
    }
    patch(out)
  }
  // 선택지 열의 드롭다운 항목(options)을 갱신. 빈 배열이면 키를 떼 깔끔하게.
  function setColumnOptions(idx, options) {
    const nextCols = cols.map((c, i) => {
      if (i !== idx) return c
      const next = { ...c }
      if (options && options.length) next.options = options
      else delete next.options
      return next
    })
    patch({ columns: nextCols })
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
      cell_styles: Object.fromEntries(
        Object.entries(cellStyles).filter(
          ([k]) => k.split('::')[1] !== removed.key,
        ),
      ),
      cell_html: Object.fromEntries(
        Object.entries(cellHtml).filter(
          ([k]) => k.split('::')[1] !== removed.key,
        ),
      ),
      // 다중행 헤더가 있으면 그 셀/머지도 같은 열 기준으로 정리.
      ...(header
        ? {
            header: {
              ...header,
              cells: Object.fromEntries(
                Object.entries(headerCells).filter(
                  ([k]) => k.split('::')[1] !== removed.key,
                ),
              ),
              merges: shiftMergesForCol(
                headerMerges,
                'remove',
                idx,
                headerRowCount,
                cols.length,
              ),
            },
          }
        : {}),
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
  // ── 통일 selection (헤더 band + 데이터) ──────────────────────────────
  // 헤더 행(0..headerOffset-1)을 데이터 위에 얹어 *하나의* selection 좌표로
  // 다룬다. 데이터 행은 headerOffset 만큼 아래로.
  // 헤더가 명시적 band 가 아니어도(=content.header 없는 기본 1줄 라벨 헤더)
  // 그 라벨 행을 헤더 행 0 으로 쳐서 드래그·선택이 되게 한다(min 1). 선택만
  // 으론 아무 것도 안 생기고, 색/정렬/병합을 *적용*하는 순간 ensureHeader 가
  // 라벨을 header.cells 로 승격(1줄 헤더 band 로 전환)한다.
  const headerOffset = Math.max(1, headerRowCount)
  const selection = useCellSelection({
    rowCount: headerOffset + rows.length,
    colCount: cols.length,
  })
  // 헤더가 없으면 현재 columns 라벨로 1행짜리 header 를 만들어 반환(머터리얼).
  function ensureHeader() {
    if (header) return header
    const cells = {}
    cols.forEach((c) => {
      if (c.label) cells[_cellKey(0, c.key)] = { text: c.label }
    })
    return { row_count: 1, cells, merges: [] }
  }
  function patchHeader(nextHeader) {
    patch({ header: nextHeader })
  }
  // 헤더 셀 rich 편집 — 평문 text + rich html(+ bg/fg 보존).
  function updateHeaderCellRich(hr, colKey, html, text) {
    const h = ensureHeader()
    const k = _cellKey(hr, colKey)
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
  // 헤더 행을 맨 위에 한 줄 삽입(그룹 헤더용). 기존 셀/머지는 한 줄 아래로.
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
      cols.length,
    )
    patchHeader({ row_count: h.row_count + 1, cells, merges: mergesNext })
    selection.clear()
  }
  // 맨 위 헤더 행 제거. 마지막 1줄까지 줄이면 header 자체를 떼고 기존
  // columns[].label 1줄 헤더로 복귀.
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
      cols.length,
    )
    patchHeader({ row_count: h.row_count - 1, cells, merges: mergesNext })
    selection.clear()
  }

  // 선택 영역의 모든 셀에 배경(bg)/글자(fg) 토큰 적용 — band 별로 라우팅.
  function applyCellColor(field, token) {
    const r = selection.rect
    if (!r) return
    const nextStyles = { ...cellStyles }
    let hObj = header
    let hCells = header ? { ...(header.cells || {}) } : null
    let hTouched = false
    for (let rr = r.r1; rr <= r.r2; rr++) {
      for (let ci = r.c1; ci <= r.c2; ci++) {
        const col = cols[ci]
        if (!col) continue
        if (rr < headerOffset) {
          if (!hCells) {
            hObj = ensureHeader()
            hCells = { ...(hObj.cells || {}) }
          }
          const k = _cellKey(rr, col.key)
          const cur = { ...(hCells[k] || {}) }
          if (token) cur[field] = token
          else delete cur[field]
          if (cur.text || cur.html || cur.bg || cur.fg || cur.align || cur.valign)
            hCells[k] = cur
          else delete hCells[k]
          hTouched = true
        } else {
          const k = _cellKey(rr - headerOffset, col.key)
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
  // 셀 에디터에서 실행할 명령(예: selectAll → setMark). 비텍스트 셀(숫자/
  // 날짜/선택)은 에디터가 없으므로 인라인 서식은 건너뛰되, `cellStyleFn`
  // 이 주어지면 그 셀의 cell_styles 항목을 (cur)=>next 로 변환해 셀 단위
  // 글자색/크기를 적용한다(헤더 셀은 항상 에디터라 이 경로를 안 탄다).
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
    for (let rr = r.r1; rr <= r.r2; rr++) {
      for (let ci = r.c1; ci <= r.c2; ci++) {
        const col = cols[ci]
        if (!col) continue
        if (rr < headerOffset) {
          // ── 헤더 band ── 헤더 셀은 항상 RichTextRowEditor 라 api 가 있다.
          const api = reg.get(`h-${rr}-${ci}`)
          if (!api?.applyAndCapture) continue
          const { html, text } = api.applyAndCapture((ed) => run(ed))
          if (!hCells) hCells = {}
          const k = _cellKey(rr, col.key)
          const cur = { ...(hCells[k] || {}) }
          if (text) cur.text = text
          else delete cur.text
          if (_richIsEmpty(html)) delete cur.html
          else cur.html = html
          if (cur.text || cur.html || cur.bg || cur.fg) hCells[k] = cur
          else delete hCells[k]
          hTouched = true
        } else {
          // ── 데이터 band ──
          const rowIdx = rr - headerOffset
          const api = reg.get(`${rowIdx}:${ci}`)
          if (api?.applyAndCapture) {
            const { html, text } = api.applyAndCapture((ed) => run(ed))
            const k = _cellKey(rowIdx, col.key)
            nextRows = nextRows.map((row, i) =>
              i === rowIdx ? { ...row, [col.key]: text || undefined } : row,
            )
            if (_richIsEmpty(html)) delete nextHtml[k]
            else nextHtml[k] = html
          } else if (cellStyleFn) {
            // 숫자/날짜/선택 셀 — 인라인 서식은 없지만 셀 단위 색/크기는 가능.
            const k = _cellKey(rowIdx, col.key)
            const next = cellStyleFn({ ...(nextStyles[k] || {}) }) || {}
            if (next.bg || next.fg || next.size || next.align || next.valign)
              nextStyles[k] = next
            else delete nextStyles[k]
            stylesTouched = true
          }
        }
      }
    }
    const next = { rows: nextRows, cell_html: nextHtml }
    if (stylesTouched) next.cell_styles = nextStyles
    if (hTouched) next.header = { ...(header || ensureHeader()), cells: hCells }
    patch(next)
  }

  // 일괄 서식 툴바 액션 — 각 텍스트 셀에서 전체 선택 후 서식을 set(토글이
  // 아니라 적용). 색은 비텍스트 셀까지 셀 단위로 함께 칠한다.
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
        // 비텍스트 셀(숫자/날짜/선택)은 셀 단위 글자 크기로.
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
        // 비텍스트 셀은 셀 단위 글자색으로.
        (cur) => {
          if (c) cur.fg = c
          else delete cur.fg
          return cur
        },
      ),
  }
  // "서식 지우기" — 선택한 텍스트 셀의 인라인 서식을 전부 해제하고, 비텍스트
  // 셀의 셀-레벨 글자색도 함께 해제.
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
      // 비텍스트 셀의 셀 단위 글자색·크기도 함께 해제(배경색은 유지).
      (cur) => {
        delete cur.fg
        delete cur.size
        return cur
      },
    )
  }

  // 선택 영역(드래그)의 현재 글자 크기 — '글자 서식' 팝오버의 크기 드롭다운에
  // 표시한다. 선택한 셀이 전부 같은 크기면 그 값, 제각각이면 MIXED_FONT_SIZE
  // (공란), 전부 기본(서식 없음)이면 ''(기본 라벨). 텍스트 셀은 에디터의
  // per-char 서식을, 숫자/날짜/선택 셀은 cell_styles.size 를 본다. selection
  // HasMerge 처럼 매 렌더 계산(IIFE) — 선택/내용이 바뀌면 자동으로 갱신.
  const selectionFontSize = (() => {
    const r = selection.rect
    if (!r) return ''
    const reg = cellEditorsRef.current
    const sizes = new Set()
    for (let rr = r.r1; rr <= r.r2 && sizes.size <= 1; rr++) {
      for (let ci = r.c1; ci <= r.c2 && sizes.size <= 1; ci++) {
        const col = cols[ci]
        if (!col) continue
        if (rr < headerOffset) {
          // 헤더 band — 헤더 셀은 항상 에디터(있을 때만 읽는다).
          const api = reg.get(`h-${rr}-${ci}`)
          if (api?.getFontSizeSet) api.getFontSizeSet().forEach((s) => sizes.add(s))
        } else {
          const rowIdx = rr - headerOffset
          const api = reg.get(`${rowIdx}:${ci}`)
          if (api?.getFontSizeSet) api.getFontSizeSet().forEach((s) => sizes.add(s))
          // 숫자/날짜/선택 셀 — 셀 단위 글자 크기(없으면 기본=null).
          else sizes.add(cellStyles[_cellKey(rowIdx, col.key)]?.size || null)
        }
      }
    }
    if (sizes.size === 0) return ''
    if (sizes.size > 1) return MIXED_FONT_SIZE
    return [...sizes][0] || ''
  })()

  function mergeSelection() {
    const r = selection.rect
    if (!r) return
    const rs = r.r2 - r.r1 + 1
    const cs = r.c2 - r.c1 + 1
    if (rs === 1 && cs === 1) return
    if (r.r2 < headerOffset) {
      // 헤더 band — header.merges 에.
      const h = ensureHeader()
      const nm = normalizeMerges(
        [...(h.merges || []), { r: r.r1, c: r.c1, rs, cs }],
        h.row_count,
        cols.length,
      )
      patchHeader({ ...h, merges: nm })
      selection.clear()
    } else if (r.r1 >= headerOffset) {
      const nm = normalizeMerges(
        [...(merges ?? []), { r: r.r1 - headerOffset, c: r.c1, rs, cs }],
        rows.length,
        cols.length,
      )
      patch({ merges: nm })
      selection.clear()
    }
    // 헤더+데이터를 가로지르는 선택은 병합 불가 — no-op.
  }
  function unmergeSelection() {
    const r = selection.rect
    if (!r) return
    const overlaps = (m, r1, r2, c1, c2) => {
      const lr = m.r + m.rs - 1
      const lc = m.c + m.cs - 1
      return m.r <= r2 && lr >= r1 && m.c <= c2 && lc >= c1
    }
    if (r.r2 < headerOffset && header) {
      const kept = (header.merges || []).filter(
        (m) => !overlaps(m, r.r1, r.r2, r.c1, r.c2),
      )
      patchHeader({
        ...header,
        merges: normalizeMerges(kept, header.row_count, cols.length),
      })
      selection.clear()
    } else if (r.r1 >= headerOffset) {
      const dr1 = r.r1 - headerOffset
      const dr2 = r.r2 - headerOffset
      const kept = (merges ?? []).filter(
        (m) => !overlaps(m, dr1, dr2, r.c1, r.c2),
      )
      patch({ merges: normalizeMerges(kept, rows.length, cols.length) })
      selection.clear()
    }
  }
  // 액션 바 상태 — 선택 영역 안에 기존 merge 가 있으면 「분할」, 없으면
  // 사각형이 2셀 이상일 때만 「합치기」.
  const selectionHasMerge = (() => {
    const r = selection.rect
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

  /** 마지막 열 우측 핸들 = 표 오른쪽 경계. 끌면 표 전체 폭(table_width_px)을
   *  조절한다(개별 열 폭이 아니라). 그래야 마지막 열을 줄여 표 자체를 좁힐
   *  수 있다. 래퍼(selection.containerRef) offsetWidth 기준. mouseup 에 commit. */
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
  function pasteGrid(startRow, startCol, text, pasteMerges) {
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

    // Fill values. 붙여넣어 덮어쓴 셀의 기존 rich 마크업은 평문으로 대체되니
    // cell_html 에서 제거한다.
    const nextHtml = { ...cellHtml }
    for (let r = 0; r < grid.length; r += 1) {
      const target = { ...nextRows[startRow + r] }
      for (let c = 0; c < grid[r].length; c += 1) {
        const col = nextCols[startCol + c]
        if (!col) continue
        target[col.key] = coerceCellValue(col, grid[r][c])
        delete nextHtml[_cellKey(startRow + r, col.key)]
      }
      nextRows[startRow + r] = target
    }

    // 엑셀 셀 병합(rowspan/colspan) 재현 — 붙인 위치(startRow/startCol)만큼
    // 오프셋해 데이터 merges 에 더하고 정규화(범위 클램프·겹침 last-wins).
    const next = { columns: nextCols, rows: nextRows, cell_html: nextHtml }
    if (pasteMerges?.length) {
      const shifted = pasteMerges.map((m) => ({
        r: startRow + m.r,
        c: startCol + m.c,
        rs: m.rs,
        cs: m.cs,
      }))
      next.merges = normalizeMerges(
        [...merges, ...shifted],
        nextRows.length,
        nextCols.length,
      )
    }
    patch(next)
  }

  /**
   * 다중행 헤더 셀에 붙여넣기. 헤더 band(절대행 0..headerRowCount-1)와 데이터
   * band 를 하나의 좌표계로 보고 (startHeaderRow, startCol) 부터 TSV 를
   * 흩뿌린다 — 헤더 줄 수를 넘는 행은 그대로 아래 데이터 행으로 이어 붙어서,
   * 엑셀에서 "머리글 + 본문" 을 통째로 복사해 헤더 셀에 붙여도 셀별로 나뉜다.
   * 평문 붙여넣기라 덮어쓴 헤더 셀의 rich(html)·데이터 셀의 cell_html 은
   * 평문으로 대체된다. (한 줄 헤더=columns[].label `<input>` 경로는
   * pasteOntoHeader 가 따로 담당.)
   */
  function pasteIntoHeader(startHeaderRow, startCol, text, pasteMerges) {
    const grid = parseTsv(text)
    if (grid.length === 0) return
    const incomingWidth = Math.max(...grid.map((r) => r.length))
    const neededCols = startCol + incomingWidth

    // 열 확장 — 데이터 셀 붙여넣기(pasteGrid)와 동일 규칙.
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

    const h = ensureHeader()
    const headerCellsNext = { ...(h.cells || {}) }
    const nextRows = [...rows]
    const nextHtml = { ...cellHtml }

    for (let r = 0; r < grid.length; r += 1) {
      const absRow = startHeaderRow + r
      if (absRow < headerRowCount) {
        // 헤더 band — 헤더 셀 text 로 채우고 기존 색(bg/fg)은 보존.
        for (let c = 0; c < grid[r].length; c += 1) {
          const col = nextCols[startCol + c]
          if (!col) continue
          const k = _cellKey(absRow, col.key)
          const cur = { ...(headerCellsNext[k] || {}) }
          const v = grid[r][c]
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
        while (nextRows.length <= dataRow) nextRows.push({})
        const target = { ...nextRows[dataRow] }
        for (let c = 0; c < grid[r].length; c += 1) {
          const col = nextCols[startCol + c]
          if (!col) continue
          target[col.key] = coerceCellValue(col, grid[r][c])
          delete nextHtml[_cellKey(dataRow, col.key)]
        }
        nextRows[dataRow] = target
      }
    }

    const next = {
      columns: nextCols,
      header: { ...h, cells: headerCellsNext },
      rows: nextRows,
      cell_html: nextHtml,
    }
    // 엑셀 셀 병합 재현 — 헤더/데이터는 별도 merges 배열·좌표원점이라, 한
    // band 안에 온전히 들어가는 병합만 각자 배열에 넣는다(밴드를 가로지르는
    // 병합은 우리 모델로 표현 불가 → 버림). 헤더 band 의 r 원점은 절대
    // 헤더행, 데이터 band 는 -headerRowCount.
    if (pasteMerges?.length) {
      const headerAdds = []
      const dataAdds = []
      for (const m of pasteMerges) {
        const top = startHeaderRow + m.r
        const bottom = top + m.rs - 1
        const c = startCol + m.c
        if (bottom < headerRowCount) {
          headerAdds.push({ r: top, c, rs: m.rs, cs: m.cs })
        } else if (top >= headerRowCount) {
          dataAdds.push({ r: top - headerRowCount, c, rs: m.rs, cs: m.cs })
        }
        // straddler(헤더↔데이터 경계 가로지름) → skip
      }
      if (headerAdds.length) {
        next.header = {
          ...next.header,
          merges: normalizeMerges(
            [...headerMerges, ...headerAdds],
            headerRowCount,
            nextCols.length,
          ),
        }
      }
      if (dataAdds.length) {
        next.merges = normalizeMerges(
          [...merges, ...dataAdds],
          nextRows.length,
          nextCols.length,
        )
      }
    }
    patch(next)
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
        {/* 정렬 — 선택한 셀들의 가로(왼쪽/가운데/오른쪽)·세로(위/가운데/아래)
            정렬을 일괄 지정. 색과 동일하게 applyCellColor 로 cell_styles 에 저장. */}
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
        {/* 글자 서식 — 선택한 셀들의 글자 굵기/기울임/크기/글꼴/색을 한꺼번에.
            텍스트 셀은 글자 내부 서식으로, 숫자/날짜/선택 셀은 색만 셀 단위로
            함께 적용된다. */}
        {selection.rect && (
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[11px] rounded-md border bg-muted/40"
                title="선택한 셀들의 글자 서식(굵기·크기·글꼴·색)을 일괄 변경"
              >
                <Type className="mr-1 h-3 w-3" />글자 서식
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="w-auto p-2 space-y-2"
              data-cell-selection-allow
            >
              <div className="flex items-center gap-1 flex-wrap">
                <RichTextFormatToolbarBody
                  state={{ ..._BULK_TOOLBAR_STATE, fontSize: selectionFontSize }}
                  actions={bulkFormatActions}
                  defaultSizePx={cellDefaultSizePx}
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
        {/* 표 전체 폭(px) — 비우면 전체 폭. 설정 시 좌측 정렬이라 "왼쪽
            절반만" 같은 부분 폭도 가능하고, 편집·뷰 폭이 일치한다. 빈 칸에서
            벗어날 때(blur)·Enter 에 commit 해 입력 중 clamp 점프를 막는다. */}
        {/* 헤더(제목) 행 수 — + 로 맨 위에 그룹 헤더 행을 얹고, 헤더 셀을
            드래그 선택해 위 액션바의 '셀 합치기'·'셀 색'으로 병합·색 지정. */}
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
        {/* 기본 펼침 — 읽기 시 셀을 펼친 상태(Enter 줄바꿈·긴 글 모두 보임)로
            저장. 끄면 compact(요약 + 호버 전체보기). 독자는 따로 토글 가능. */}
        {/* 기본값은 펼침 — 미설정이면 펼침으로 본다. 토글은 명시적 true/false
            를 저장(끄면 그 표만 compact). */}
        <button
          type="button"
          onClick={() => patch({ expanded: !(content?.expanded ?? true) })}
          className={`flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] ${
            (content?.expanded ?? true)
              ? 'border-primary/40 bg-primary/10 text-foreground'
              : 'bg-muted/40 text-muted-foreground'
          }`}
          title="읽기 시 셀을 펼친 상태로 저장(Enter 줄바꿈·긴 글 모두 보임). 끄면 요약(compact)."
          data-cell-selection-allow
        >
          {(content?.expanded ?? true) ? (
            <Maximize2 className="h-3 w-3" />
          ) : (
            <Minimize2 className="h-3 w-3" />
          )}
          기본 펼침
        </button>
        {/* 격자 테두리 — 켜면 행·열 전체에 격자선. 켜진 동안 굵기(얇게/보통/
            굵게)·색을 함께 고른다. 끄면 기존 형태(행 구분선만). */}
        <div
          className="flex items-center gap-1 rounded-md border bg-muted/40 px-1.5 py-0.5 text-[11px]"
          data-cell-selection-allow
        >
          <button
            type="button"
            onClick={() => patch({ bordered: !bordered })}
            className={`flex items-center gap-1 rounded px-1 py-0.5 ${
              bordered
                ? 'bg-primary/10 text-foreground'
                : 'text-muted-foreground'
            }`}
            title="셀 격자 테두리(행·열). 끄면 기존 형태(행 구분선만)."
          >
            <Grid3x3 className="h-3 w-3" />
            테두리
          </button>
          {bordered && (
            <>
              {/* 굵기 — 얇게(1)/보통(2)/굵게(3) px */}
              {[
                { px: 1, label: '얇게' },
                { px: 2, label: '보통' },
                { px: 3, label: '굵게' },
              ].map((opt) => (
                <button
                  key={opt.px}
                  type="button"
                  onClick={() => patch({ border_width: opt.px })}
                  className={`rounded px-1 py-0.5 ${
                    borderWidth === opt.px
                      ? 'bg-primary/10 text-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                  title={`테두리 굵기 ${opt.px}px`}
                >
                  {opt.label}
                </button>
              ))}
              {/* 색 — 토큰 팔레트(기본=테마색) */}
              <ColorSwatchPicker
                value={borderColorTok}
                onChange={(t) => patch({ border_color: t || undefined })}
                size={16}
              />
            </>
          )}
        </div>
        <label
          className="flex items-center gap-1 rounded-md border bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground"
          title="표 전체 폭(px). 비우면 전체 폭. 좌측 정렬이라 절반 폭 등으로 만들 수 있습니다."
          data-cell-selection-allow
        >
          표 폭
          <input
            type="number"
            min={120}
            max={4000}
            step={20}
            key={tableWidthPx ?? 'auto'}
            defaultValue={tableWidthPx ?? ''}
            placeholder="전체"
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
            }}
            onBlur={(e) => {
              const v = e.target.value.trim()
              if (v === '') {
                patch({ table_width_px: undefined })
                return
              }
              const n = Math.min(Math.max(120, Math.round(Number(v))), 4000)
              patch({ table_width_px: Number.isFinite(n) ? n : undefined })
            }}
            className="w-14 bg-transparent border-0 outline-none text-right tabular-nums focus:ring-1 focus:ring-ring rounded"
          />
          px
          {tableWidthPx != null && (
            <button
              type="button"
              onClick={() => patch({ table_width_px: undefined })}
              className="ml-0.5 hover:text-foreground"
              title="전체 폭으로"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </label>
        <DataTableActions
          label="표 데이터"
          onCopy={() => {
            const header = cols.map((c) => c.label || c.key)
            const body = rows.map((row) => cols.map((c) => row[c.key]))
            return toTsv([header, ...body])
          }}
          onPaste={(text, html) =>
            pasteGrid(0, 0, text, parseHtmlTableMerges(html))
          }
          onClear={() => patch({ rows: [] })}
        />
      </div>
      {/* 표 폭 핸들이 항상 보이도록, 폭(tableBoxStyle)은 relative 외곽 div 가
          갖고, 핸들은 overflow 박스 *바깥*에 둔다(안에 두면 잘려 사라짐). */}
      <div className="relative" style={tableBoxStyle}>
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
        <table className={`w-full text-sm table-fixed ${gridClass}`} style={gridVars}>
          <colgroup>
            {cols.map((c, i) => (
              <col key={i} style={colStyle(c.key)} />
            ))}
          </colgroup>
          <thead className="bg-muted/40">
            {headerRowCount > 0
              ? // 다중행·병합 헤더 그리드 — 각 셀은 RichTextRowEditor(색·서식),
                // 드래그 선택으로 병합/색(상단 액션바). 열 삭제·폭핸들은 *맨 아래*
                // 헤더 행(열과 1:1)에만 얹는다.
                Array.from({ length: headerRowCount }).map((_, hr) => (
                  <tr key={hr}>
                    {cols.map((c, ci) => {
                      if (headerMergeMap.covered.has(`${hr},${ci}`)) return null
                      const span = headerMergeMap.anchors.get(`${hr},${ci}`)
                      const isBottom = hr === headerRowCount - 1
                      const selH = selection.isCellSelected(hr, ci)
                      const hcell = headerCells[_cellKey(hr, c.key)]
                      return (
                        <th
                          key={ci}
                          {...(isBottom ? { 'data-col-idx': ci } : {})}
                          data-cell-coord={`${hr},${ci}`}
                          onMouseDown={(e) => selection.handleMouseDown(e, hr, ci)}
                          onMouseEnter={() => selection.handleMouseEnter(hr, ci)}
                          onMouseLeave={() => selection.handleMouseLeave(hr, ci)}
                          {...(span?.rs > 1 ? { rowSpan: span.rs } : {})}
                          {...(span?.cs > 1 ? { colSpan: span.cs } : {})}
                          className={`px-1 py-1 ${hAlignClass(hcell?.align)} ${vAlignClass(hcell?.valign)} font-medium text-xs text-muted-foreground border-b border-r last:border-r-0 group relative ${headerCellClass(hr, c.key)} ${selH ? 'bg-primary/10 ring-1 ring-primary/40' : ''}`.trim()}
                        >
                          <div className="outline-rich-row">
                            <RichTextRowEditor
                              ref={(api) => registerEditor(`h-${hr}-${ci}`, api)}
                              html={_richSeed(hcell?.html, hcell?.text)}
                              onChange={(html, text) =>
                                updateHeaderCellRich(hr, c.key, html, text)
                              }
                              onPastePlain={(text, html) =>
                                pasteIntoHeader(hr, ci, text, parseHtmlTableMerges(html))
                              }
                              gridCellKey={`h-${hr}-${ci}`}
                              defaultSizePx={cellDefaultSizePx}
                              // 가로 정렬은 th 의 text-align 을 상속(여기서 text-center
                              // 를 박지 않음 — 셀 정렬 지정이 먹히도록).
                              className="w-full min-h-[1.5rem] rounded px-1 py-0.5 text-xs whitespace-pre-wrap break-words"
                            />
                          </div>
                          {/* 열 입력 형식(텍스트/숫자) — 맨 아래 헤더 행(열과
                              1:1)에만, 호버 시 좌상단에. */}
                          {isBottom && (
                            <div
                              className="absolute left-0.5 top-0.5 opacity-0 group-hover:opacity-100 transition-opacity z-20"
                              data-cell-selection-allow
                            >
                              <ColumnTypeSelect
                                value={c.type}
                                onChange={(t) => setColumnType(ci, t)}
                                options={c.options}
                                onOptionsChange={(o) => setColumnOptions(ci, o)}
                              />
                            </div>
                          )}
                          {isBottom && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="absolute right-0.5 top-1/2 -translate-y-1/2 h-5 w-5 opacity-0 group-hover:opacity-100 text-destructive bg-background/90 border shadow-sm"
                              onClick={() => removeColumn(ci)}
                              title="열 삭제"
                            >
                              <X className="h-3 w-3" />
                            </Button>
                          )}
                          {isBottom && ci < cols.length - 1 && (
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
                          )}
                        </th>
                      )
                    })}
                  </tr>
                ))
              : // 헤더 없음 — 기존 1줄 라벨 입력 행(하위호환). 단, 셀 선택
                // 좌표상 헤더 행 0 으로 취급해 드래그·선택이 되게 한다(색/정렬/
                // 병합 적용 시 ensureHeader 로 header band 승격).
                <tr>
                  {cols.map((c, i) => {
                    const selH = selection.isCellSelected(0, i)
                    return (
                    <th
                      key={i}
                      data-col-idx={i}
                      data-cell-coord={`0,${i}`}
                      onMouseDown={(e) => selection.handleMouseDown(e, 0, i)}
                      onMouseEnter={() => selection.handleMouseEnter(0, i)}
                      onMouseLeave={() => selection.handleMouseLeave(0, i)}
                      className={`px-1 py-1 text-center font-medium text-xs text-muted-foreground border-b group relative ${selH ? 'bg-primary/10 ring-1 ring-primary/40' : ''}`}
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
                      {/* 열 입력 형식(텍스트/숫자) — 호버 시 좌상단. */}
                      <div
                        className="absolute left-0.5 top-0.5 opacity-0 group-hover:opacity-100 transition-opacity z-20"
                        data-cell-selection-allow
                      >
                        <ColumnTypeSelect
                          value={c.type}
                          onChange={(t) => setColumnType(i, t)}
                          options={c.options}
                          onOptionsChange={(o) => setColumnOptions(i, o)}
                        />
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="absolute right-0.5 top-1/2 -translate-y-1/2 h-5 w-5 opacity-0 group-hover:opacity-100 text-destructive bg-background/90 border shadow-sm"
                        onClick={() => removeColumn(i)}
                        title="열 삭제"
                      >
                        <X className="h-3 w-3" />
                      </Button>
                      {i < cols.length - 1 && (
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
                      )}
                    </th>
                    )
                  })}
                </tr>}
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
                  // 통일 selection 좌표 — 데이터 행은 headerOffset 만큼 아래.
                  const sr = headerOffset + rowIdx
                  const selected = selection.isCellSelected(sr, ci)
                  const cstyle = cellStyles[_cellKey(rowIdx, c.key)]
                  return (
                    <td
                      key={ci}
                      data-cell-coord={`${sr},${ci}`}
                      // 일반 클릭은 input focus 가 그대로 — 셀 안 텍스트
                      // 편집/커서 이동 정상. 드래그가 셀 경계를 넘는 순간
                      // hook 이 promote 해서 multi-cell 선택으로 전환.
                      onMouseDown={(e) => selection.handleMouseDown(e, sr, ci)}
                      onMouseEnter={() => selection.handleMouseEnter(sr, ci)}
                      onMouseLeave={() => selection.handleMouseLeave(sr, ci)}
                      {...(span?.rs > 1 ? { rowSpan: span.rs } : {})}
                      {...(span?.cs > 1 ? { colSpan: span.cs } : {})}
                      // 세로 정렬은 td 가 담당(셀 지정 우선, 없으면 병합 시 가운데).
                      className={`px-1 py-1 ${vAlignClass(cstyle?.valign, span?.rs > 1 ? 'align-middle' : '')} ${cellStyleClass(rowIdx, c.key)} ${
                        isLast ? 'relative' : ''
                      } ${selected ? 'bg-primary/10 ring-1 ring-primary/40' : ''}`}
                    >
                      <CellInput
                        column={c}
                        value={row[c.key]}
                        html={cellHtml[_cellKey(rowIdx, c.key)]}
                        onChange={(v) => updateCell(rowIdx, c.key, v)}
                        onChangeRich={(html, text) =>
                          updateCellRich(rowIdx, c.key, html, text)
                        }
                        onMultiPaste={(text, html) =>
                          pasteGrid(rowIdx, ci, text, parseHtmlTableMerges(html))
                        }
                        alignClass={hAlignClass(cstyle?.align)}
                        rowIdx={rowIdx}
                        colIdx={ci}
                        onKeyDown={(e) => grid.handleKey(e, rowIdx, ci)}
                        registerEditor={registerEditor}
                        defaultSizePx={cellDefaultSizePx}
                        cellSize={cellSizePx(rowIdx, c.key)}
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
      {/* 하단 참고 내용 — ※ 프리픽스로 표시. */}
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

function CellInput({ column, value, html, onChange, onChangeRich, onMultiPaste, alignClass = 'text-center', rowIdx, colIdx, onKeyDown, registerEditor, defaultSizePx, cellSize }) {
  const t = column.type
  // 네이티브 입력칸은 text-xs 가 크기를 고정하므로, 셀 단위 크기는 인라인
  // style 로 덮어써야 먹는다(인라인 > 클래스). 없으면 undefined → text-xs 유지.
  const sizeStyle = cellSize ? { fontSize: cellSize } : undefined
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
    // text/html 도 함께 넘긴다 — 엑셀 셀 병합 재현용.
    onMultiPaste(text, e.clipboardData?.getData('text/html') || '')
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
        style={sizeStyle}
        className={`flex h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-xs ${alignClass}`}
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
        style={sizeStyle}
        className={`h-8 text-xs ${alignClass}`}
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
        style={sizeStyle}
        className={`h-8 text-xs ${alignClass}`}
      />
    )
  }
  // 텍스트 셀 — rich 에디터(긴 글처럼 텍스트 선택 → 버블 메뉴로 색·서식).
  // 평문 값(rows)도 onChangeRich 가 함께 동기화. 엑셀 붙여넣기(TSV)는
  // onPastePlain 으로 가로채 여러 셀로 펼친다. data-grid-cell 로 그리드 포커스
  // 타깃·Tab 이동 유지(화살표 셀 점프는 캐럿 이동으로 대체).
  return (
    <div className="outline-rich-row w-full">
      <RichTextRowEditor
        ref={registerEditor ? (api) => registerEditor(gridCellKey, api) : undefined}
        html={_richSeed(html, value)}
        onChange={onChangeRich}
        onKeyDown={onKeyDown}
        onPastePlain={onMultiPaste}
        gridCellKey={gridCellKey}
        defaultSizePx={defaultSizePx}
        className={`w-full min-h-[2rem] rounded-md border border-input bg-background px-2 py-1 text-xs leading-snug ${alignClass} whitespace-pre-wrap break-words`}
      />
    </div>
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
function ReadOnlyCell({ value, html, expanded, rowSpan, colSpan, alignH, alignV, cellClass = '', cellSize }) {
  const hasRich = !_richIsEmpty(html)
  // 셀 단위 글자 크기(숫자/날짜/선택 셀) — 읽기 모드 td 에 인라인으로.
  const sizeStyle = cellSize ? { fontSize: cellSize } : undefined
  const isEmpty =
    !hasRich && (value === undefined || value === null || value === '')
  const text = value === undefined || value === null ? '' : String(value)
  // rich 마크업이 있으면 그걸 우선 렌더(긴 글처럼 부분 색). 없으면 평문.
  const richNode = hasRich ? (
    <span
      // 펼침 모드면 문단을 block 으로 쌓아 Enter 줄바꿈을 보존, compact 모드는
      // 한 줄(inline) 미리보기로 truncate.
      className={expanded ? '[&_p]:m-0' : '[&_p]:m-0 [&_p]:inline'}
      dangerouslySetInnerHTML={{ __html: sanitizeCaptionHtml(html) }}
    />
  ) : null
  // rowSpan / colSpan 은 1 일 땐 HTML attr 자체를 비워둠 — DOM 상 깔끔.
  const spanAttrs = {
    ...(rowSpan && rowSpan > 1 ? { rowSpan } : {}),
    ...(colSpan && colSpan > 1 ? { colSpan } : {}),
  }
  // 가로 정렬: 셀 지정(alignH) 우선, 없으면 기본 가운데. 세로 정렬: 셀
  // 지정(alignV) 우선, 없으면 세로 병합이면 가운데, 아니면 모드별 기본
  // (compact/empty=브라우저 기본 middle, expanded=align-top).
  const tall = rowSpan && rowSpan > 1
  const hCls = hAlignClass(alignH)
  if (isEmpty) {
    return (
      <td
        {...spanAttrs}
        style={sizeStyle}
        className={`px-2 py-1.5 text-muted-foreground ${hCls} ${vAlignClass(alignV, tall ? 'align-middle' : '')} ${cellClass}`}
      >
        —
      </td>
    )
  }
  if (expanded) {
    return (
      <td
        {...spanAttrs}
        style={sizeStyle}
        className={`px-2 py-1.5 whitespace-pre-wrap break-words ${hCls} ${vAlignClass(alignV, tall ? 'align-middle' : 'align-top')} ${cellClass}`}
      >
        {richNode ?? text}
      </td>
    )
  }
  return (
    <td
      {...spanAttrs}
      style={sizeStyle}
      className={`px-2 py-1.5 truncate relative group ${hCls} ${vAlignClass(alignV, tall ? 'align-middle' : '')} ${cellClass}`}
    >
      <span title={text} className="block truncate">
        {richNode ?? text}
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
