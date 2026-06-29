import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlignCenter,
  AlignCenterHorizontal,
  AlignEndHorizontal,
  AlignLeft,
  AlignRight,
  AlignStartHorizontal,
  ChevronDown,
  ChevronUp,
  ClipboardPaste,
  Copy,
  Eraser,
  Plus,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import DOMPurify from 'dompurify'
import { cn } from '@/shared/lib/utils'
import { copyTextToClipboard, readTableFromClipboard } from '@/shared/lib/clipboard'
import { ColorSwatchPicker, colorTokenClass } from '@/shared/text-color'
import { useCurrentBlockRef } from '@/shared/reports/CurrentBlockRefContext'
import { RichTextRowEditor } from './RichTextRowEditor'

/**
 * Two-button cluster ("복사" + "비우기") that every data-grid widget
 * (Table / Chart / Scatter / Scatter3D / Heatmap / Radar / RaciMatrix)
 * pins above its grid in edit mode. Each widget supplies:
 *   - `onCopy()` → string to put on the clipboard (TSV is the default
 *     convention; the widget builds it because the row/column shape is
 *     widget-specific).
 *   - `onClear()` → fired after the confirm dialog; the widget runs
 *     `onChange(emptyContent)` itself so each widget owns its "empty"
 *     definition (rows=[] for tabular; matrix=[]+labels intact for
 *     heatmap, etc.).
 *
 * The cluster intentionally lives outside the widget files so the
 * label / icon / confirm prompt stay in sync across every grid widget
 * — that's the only consistency burden of having ~7 grids.
 */
export function DataTableActions({
  onCopy,
  onPaste,
  onClear,
  label = '데이터',
  disabled,
  className,
}) {
  async function handleCopy() {
    try {
      const text = onCopy?.()
      if (text == null || text === '') {
        toast.info(`복사할 ${label}가 없습니다.`)
        return
      }
      await copyTextToClipboard(text)
      toast.success(`${label}를 클립보드에 복사했습니다.`)
    } catch (e) {
      toast.error('클립보드 복사 실패', {
        description: String(e?.message ?? e),
      })
    }
  }
  async function handlePaste() {
    try {
      // text/html 까지 읽어서(보안 컨텍스트 한정) 엑셀 셀 병합도 재현.
      const { text, html } = await readTableFromClipboard()
      if ((text == null || text === '') && !html) {
        toast.info('클립보드가 비어 있습니다.')
        return
      }
      onPaste?.(text, html)
      toast.success(`클립보드 내용을 ${label}에 붙여넣었습니다.`)
    } catch (e) {
      // 비보안(HTTP) 컨텍스트 등 readText 불가 — 셀 직접 붙여넣기로 안내.
      toast.error('붙여넣기 실패', {
        description: String(e?.message ?? e),
      })
    }
  }
  function handleClear() {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`${label}를 모두 비울까요? 되돌릴 수 없습니다.`)) return
    onClear?.()
  }
  return (
    <div className={cn('flex items-center gap-1', className)}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-2 text-xs"
        onClick={handleCopy}
        disabled={disabled}
        title={`${label}를 TSV(탭 구분) 로 클립보드에 복사 — Excel · 시트에 그대로 붙여넣기 가능`}
      >
        <Copy className="h-3 w-3" />
        복사
      </Button>
      {onPaste && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          onClick={handlePaste}
          disabled={disabled}
          title={`클립보드의 TSV(엑셀·시트에서 복사한 표) 를 ${label} 좌상단부터 붙여넣기`}
        >
          <ClipboardPaste className="h-3 w-3" />
          붙여넣기
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-2 text-xs text-destructive hover:text-destructive"
        onClick={handleClear}
        disabled={disabled}
        title={`${label}를 모두 비웁니다 (되돌릴 수 없음)`}
      >
        <Eraser className="h-3 w-3" />
        비우기
      </Button>
    </div>
  )
}

/**
 * Serialize a 2D array of cell values to a TSV string. Cells are
 * coerced to strings; null/undefined become empty strings; tabs and
 * newlines inside cells are replaced with spaces so the resulting
 * string can be safely round-tripped to/from a spreadsheet.
 */
export function toTsv(rows2d) {
  if (!Array.isArray(rows2d) || rows2d.length === 0) return ''
  return rows2d
    .map((row) =>
      (Array.isArray(row) ? row : [row])
        .map((cell) => {
          if (cell == null) return ''
          const s = typeof cell === 'string' ? cell : String(cell)
          return s.replace(/[\t\n\r]+/g, ' ')
        })
        .join('\t'),
    )
    .join('\n')
}

/**
 * 엑셀·구글시트에서 복사한 클립보드의 `text/html` 폼에서 표의 셀 병합
 * (rowspan/colspan)만 뽑아낸다. 평문(TSV)에는 병합 정보가 없고 HTML 에만
 * 남으므로, 붙여넣기 때 값은 기존대로 TSV 로 채우고 "병합 모양"만 이걸로
 * 재현한다. 반환 좌표는 붙여넣는 블록의 좌상단(0,0) 기준 상대좌표 —
 * 호출부가 실제 붙이는 위치만큼 오프셋해서 쓴다. 표가 없거나 병합이 하나도
 * 없으면 빈 배열.
 *
 * occupancy(점유) 집합으로 위/왼쪽 셀의 span 에 이미 먹힌 칸을 추적하며 각
 * 행에서 다음 빈 열로 커서를 옮긴다 — 그래야 TSV(빈 칸까지 자리 차지)와
 * 좌표계가 일치한다.
 */
export function parseHtmlTableMerges(html) {
  if (typeof html !== 'string' || !html || typeof DOMParser === 'undefined') {
    return []
  }
  let doc
  try {
    doc = new DOMParser().parseFromString(html, 'text/html')
  } catch {
    return []
  }
  const table = doc.querySelector('table')
  if (!table) return []
  const trs = Array.from(table.querySelectorAll('tr'))
  if (trs.length === 0) return []
  const merges = []
  const occupied = new Set() // "r,c" — span 으로 가려진 칸
  for (let r = 0; r < trs.length; r += 1) {
    const cells = Array.from(trs[r].children).filter(
      (el) => el.tagName === 'TD' || el.tagName === 'TH',
    )
    let c = 0
    for (const cell of cells) {
      while (occupied.has(`${r},${c}`)) c += 1
      // rowSpan/colSpan IDL 프로퍼티(기본 1)를 우선 — 대소문자/따옴표 차이에
      // 안전. 일부 환경 폴백으로 attribute 도 본다.
      const rs = Math.max(
        1,
        Number(cell.rowSpan) || parseInt(cell.getAttribute('rowspan'), 10) || 1,
      )
      const cs = Math.max(
        1,
        Number(cell.colSpan) || parseInt(cell.getAttribute('colspan'), 10) || 1,
      )
      if (rs > 1 || cs > 1) {
        merges.push({ r, c, rs, cs })
        for (let dr = 0; dr < rs; dr += 1) {
          for (let dc = 0; dc < cs; dc += 1) {
            occupied.add(`${r + dr},${c + dc}`)
          }
        }
      }
      c += cs
    }
  }
  return merges
}

// --------------------------------------------------------------------------- //
// 셀 정렬 (가로 text-align / 세로 vertical-align)                               //
//                                                                              //
// 표 / 비교표 셀의 cell_styles 항목에 `align`('left'|'center'|'right') ·         //
// `valign`('top'|'middle'|'bottom') 로 저장. 미설정이면 호출부의 기본값으로     //
// 폴백한다(가로 기본=가운데, 세로 기본은 모드별). Tailwind purge 함정:          //
// 클래스 리터럴이 아래 맵 소스에 그대로 있어야 살아남는다(보간 금지).          //
// --------------------------------------------------------------------------- //
const _H_ALIGN_CLASS = { left: 'text-left', center: 'text-center', right: 'text-right' }
const _V_ALIGN_CLASS = { top: 'align-top', middle: 'align-middle', bottom: 'align-bottom' }

/** 가로 정렬 토큰 → Tailwind text-align 클래스. 미설정이면 fallback. */
export function hAlignClass(align, fallback = 'text-center') {
  return _H_ALIGN_CLASS[align] || fallback
}
/** 세로 정렬 토큰 → Tailwind vertical-align 클래스. 미설정이면 fallback. */
export function vAlignClass(valign, fallback = '') {
  return _V_ALIGN_CLASS[valign] || fallback
}

/**
 * 선택한 셀들의 가로·세로 정렬을 지정하는 팝오버 본문. 색(셀 배경/글자
 * 서식)과 동일하게 `onApply(field, token)` 으로 선택 영역에 일괄 적용한다 —
 * field 는 'align' | 'valign', token 은 값 또는 null(기본값으로 되돌림).
 * 헤더 셀 선택도 같은 경로(applyCellColor)라 함께 적용된다.
 */
export function CellAlignControl({ onApply }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1">
        <span className="w-7 text-[10px] uppercase text-muted-foreground">가로</span>
        <_AlignBtn onClick={() => onApply('align', 'left')} title="왼쪽 정렬">
          <AlignLeft className="h-3.5 w-3.5" />
        </_AlignBtn>
        <_AlignBtn onClick={() => onApply('align', 'center')} title="가운데 정렬">
          <AlignCenter className="h-3.5 w-3.5" />
        </_AlignBtn>
        <_AlignBtn onClick={() => onApply('align', 'right')} title="오른쪽 정렬">
          <AlignRight className="h-3.5 w-3.5" />
        </_AlignBtn>
        <_AlignBtn onClick={() => onApply('align', null)} title="가로 정렬 기본값">
          <span className="text-[10px] px-0.5">기본</span>
        </_AlignBtn>
      </div>
      <div className="flex items-center gap-1">
        <span className="w-7 text-[10px] uppercase text-muted-foreground">세로</span>
        <_AlignBtn onClick={() => onApply('valign', 'top')} title="위 정렬">
          <AlignStartHorizontal className="h-3.5 w-3.5" />
        </_AlignBtn>
        <_AlignBtn onClick={() => onApply('valign', 'middle')} title="가운데 정렬">
          <AlignCenterHorizontal className="h-3.5 w-3.5" />
        </_AlignBtn>
        <_AlignBtn onClick={() => onApply('valign', 'bottom')} title="아래 정렬">
          <AlignEndHorizontal className="h-3.5 w-3.5" />
        </_AlignBtn>
        <_AlignBtn onClick={() => onApply('valign', null)} title="세로 정렬 기본값">
          <span className="text-[10px] px-0.5">기본</span>
        </_AlignBtn>
      </div>
    </div>
  )
}
function _AlignBtn({ onClick, title, children }) {
  return (
    <button
      type="button"
      // mousedown 기본동작 막아 셀 선택(selection)이 풀리지 않게.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      title={title}
      className="flex h-7 min-w-7 items-center justify-center rounded border bg-background px-1 hover:bg-muted"
    >
      {children}
    </button>
  )
}

/**
 * Shared editor for the {key, label, type, options?, required?} item shape
 * used by both `key_value.items` and `table.columns`.
 */
const ITEM_TYPES = [
  { value: 'text', label: '텍스트' },
  { value: 'number', label: '숫자' },
  { value: 'integer', label: '정수' },
  { value: 'date', label: '날짜' },
  { value: 'select', label: '선택지' },
]

export function FieldItemListEditor({ items, onChange, addLabel = '항목 추가' }) {
  function update(idx, patch) {
    const next = items.map((it, i) => (i === idx ? { ...it, ...patch } : it))
    onChange(next)
  }
  function remove(idx) {
    onChange(items.filter((_, i) => i !== idx))
  }
  function move(idx, dir) {
    const newIdx = idx + dir
    if (newIdx < 0 || newIdx >= items.length) return
    const next = [...items]
    const [item] = next.splice(idx, 1)
    next.splice(newIdx, 0, item)
    onChange(next)
  }
  function add() {
    onChange([
      ...items,
      { key: nextItemKey(items), label: '', type: 'text', required: false },
    ])
  }

  return (
    <div className="space-y-2">
      {items.map((item, idx) => (
        <div key={idx} className="rounded-md border p-2 bg-muted/20 space-y-2">
          <div className="grid grid-cols-12 gap-2">
            <div className="col-span-3">
              <Label className="text-[10px] uppercase">키</Label>
              <Input
                value={item.key ?? ''}
                onChange={(e) => update(idx, { key: e.target.value.toLowerCase() })}
                className="mt-0.5 h-8 text-xs font-mono"
                placeholder="period"
              />
            </div>
            <div className="col-span-3">
              <Label className="text-[10px] uppercase">라벨</Label>
              <Input
                value={item.label ?? ''}
                onChange={(e) => update(idx, { label: e.target.value })}
                className="mt-0.5 h-8 text-xs"
                placeholder="보고 기간"
              />
            </div>
            <div className="col-span-2">
              <Label className="text-[10px] uppercase">타입</Label>
              <select
                value={item.type ?? 'text'}
                onChange={(e) => update(idx, { type: e.target.value })}
                className="mt-0.5 flex h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
              >
                {ITEM_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="col-span-1 flex items-center justify-center pt-4">
              <label className="flex items-center gap-1 text-[10px]">
                <input
                  type="checkbox"
                  checked={!!item.required}
                  onChange={(e) => update(idx, { required: e.target.checked })}
                />
                필수
              </label>
            </div>
            <div className="col-span-1 flex items-center justify-center pt-4">
              <label
                className="flex items-center gap-1 text-[10px]"
                title="여러 값을 입력할 수 있음 (key_value 전용 — table 열에는 영향 없음)"
              >
                <input
                  type="checkbox"
                  checked={!!item.multi}
                  onChange={(e) => update(idx, { multi: e.target.checked })}
                />
                다중값
              </label>
            </div>
            <div className="col-span-2 flex items-start gap-1 pt-4 justify-end">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                disabled={idx === 0}
                onClick={() => move(idx, -1)}
              >
                <ChevronUp className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                disabled={idx === items.length - 1}
                onClick={() => move(idx, 1)}
              >
                <ChevronDown className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-destructive"
                onClick={() => remove(idx)}
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          </div>

          {item.type === 'select' && (
            <div>
              <Label className="text-[10px] uppercase">선택지 (쉼표 구분)</Label>
              <Input
                value={(item.options ?? []).join(', ')}
                onChange={(e) =>
                  update(idx, {
                    options: e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
                className="mt-0.5 h-8 text-xs"
                placeholder="옵션1, 옵션2, 옵션3"
              />
            </div>
          )}

          <details>
            <summary className="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground select-none">
              메타 (선택)
            </summary>
            <div className="mt-1">
              <FieldMetaEditor
                value={item.meta}
                onChange={(meta) => update(idx, { meta })}
              />
            </div>
          </details>
        </div>
      ))}

      <Button variant="outline" size="sm" onClick={add}>
        <Plus className="mr-1 h-3 w-3" />
        {addLabel}
      </Button>
    </div>
  )
}

function nextItemKey(items) {
  let n = 1
  while (items.some((it) => it.key === `field_${n}`)) n += 1
  return `field_${n}`
}

/** Shared label + help row used at the top of every PropsPanel. */
export function LabelField({ label, value, onChange, placeholder, hint }) {
  return (
    <div>
      <Label className="text-xs">{label}</Label>
      <Input
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 h-9"
        placeholder={placeholder}
      />
      {hint && <p className="mt-1 text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  )
}

/** Compact section header used in Preview cards. */
export function PreviewLabel({ children, hint }) {
  return (
    <div className="flex items-baseline gap-2">
      <h4 className="text-sm font-medium">{children}</h4>
      {hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Ontology / aggregation metadata editors
//
// Meta is purely a hint layer used downstream (entity extraction, cross-
// report aggregation, AI prompt assembly). All fields are optional and
// can be left blank — the validator ignores absent meta entirely. See
// backend `validation.META_SCHEMA` for the authoritative shape.
// --------------------------------------------------------------------------- //

const META_CATEGORIES = [
  { value: '', label: '(없음)' },
  { value: 'metric', label: '지표' },
  { value: 'event', label: '이벤트' },
  { value: 'entity', label: '엔티티' },
  { value: 'note', label: '메모' },
  { value: 'reference', label: '참조' },
  { value: 'attribute', label: '속성' },
]

const META_AGGREGATIONS = [
  { value: '', label: '(없음)' },
  { value: 'sum', label: '합계' },
  { value: 'avg', label: '평균' },
  { value: 'count', label: '개수' },
  { value: 'list', label: '목록' },
  { value: 'max', label: '최대' },
  { value: 'min', label: '최소' },
  { value: 'none', label: 'none' },
]

/** Strip empty values so saved meta stays compact (no `concept: ""`). */
function pruneMeta(meta) {
  if (!meta) return undefined
  const out = {}
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined || v === null) continue
    if (typeof v === 'string' && v.trim() === '') continue
    if (Array.isArray(v) && v.length === 0) continue
    out[k] = v
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/**
 * Block-level meta editor — concept + category + aggregation + tags +
 * AI prompt. Renders inline (no card chrome) so it can sit inside the
 * BlockPropsEditor's right panel.
 */
export function BlockMetaEditor({ value, onChange }) {
  const meta = value ?? {}
  function patch(p) {
    onChange(pruneMeta({ ...meta, ...p }))
  }
  return (
    <div className="space-y-3">
      <div>
        <Label className="text-xs">개념 (concept)</Label>
        <Input
          value={meta.concept ?? ''}
          onChange={(e) => patch({ concept: e.target.value })}
          placeholder="예: MonthlyRevenue, Incident"
          className="mt-1 h-9 text-xs"
        />
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          이 블록이 표현하는 온톨로지 클래스 이름. 같은 concept끼리 집계·연결됨.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-xs">카테고리</Label>
          <select
            value={meta.category ?? ''}
            onChange={(e) => patch({ category: e.target.value || undefined })}
            className="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
          >
            {META_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label className="text-xs">집계 방식</Label>
          <select
            value={meta.aggregatable ?? ''}
            onChange={(e) =>
              patch({ aggregatable: e.target.value || undefined })
            }
            className="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
          >
            {META_AGGREGATIONS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <Label className="text-xs">태그 (쉼표 구분)</Label>
        <Input
          value={(meta.tags ?? []).join(', ')}
          onChange={(e) => {
            const tags = e.target.value
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
            patch({ tags: tags.length > 0 ? tags : undefined })
          }}
          placeholder="finance, monthly"
          className="mt-1 h-9 text-xs"
        />
      </div>
      <div>
        <Label className="text-xs">AI 프롬프트 힌트</Label>
        <textarea
          value={meta.ai_prompt ?? ''}
          onChange={(e) => patch({ ai_prompt: e.target.value || undefined })}
          placeholder="이 블록을 AI가 작성할 때 사용할 지시"
          className="mt-1 flex w-full rounded-md border border-input bg-background px-3 py-2 text-xs"
          rows={2}
        />
      </div>
    </div>
  )
}

/**
 * Compact meta editor for an individual field (key_value item, table
 * column, chart series). Smaller surface than block-level meta — only
 * the most useful fields for entity linking.
 */
export function FieldMetaEditor({ value, onChange }) {
  const meta = value ?? {}
  function patch(p) {
    onChange(pruneMeta({ ...meta, ...p }))
  }
  return (
    <div className="space-y-2 p-2 bg-muted/30 rounded">
      <div>
        <Label className="text-[10px] uppercase">개념</Label>
        <Input
          value={meta.concept ?? ''}
          onChange={(e) => patch({ concept: e.target.value })}
          placeholder="예: Team, Person"
          className="mt-0.5 h-7 text-xs"
        />
      </div>
      <label className="flex items-center gap-1 text-[11px]">
        <input
          type="checkbox"
          checked={!!meta.is_entity_id}
          onChange={(e) =>
            patch({ is_entity_id: e.target.checked || undefined })
          }
        />
        엔티티 식별자 (이 값을 entities 테이블에 promote)
      </label>
      {meta.is_entity_id && (
        <div>
          <Label className="text-[10px] uppercase">엔티티 타입</Label>
          <Input
            value={meta.linked_entity_type ?? ''}
            onChange={(e) =>
              patch({ linked_entity_type: e.target.value || undefined })
            }
            placeholder="user, team, project..."
            className="mt-0.5 h-7 text-xs font-mono"
          />
        </div>
      )}
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Text styling — designer-time controls + render-time CSS mapping              //
//                                                                              //
// Every text-bearing widget carries an optional `props.text_style` object       //
// declared in backend/app/widgets/registry.py. Render-time emits two surfaces:  //
//                                                                              //
//   * textStyleToInlineStyle(style) → React style object. Used as `style={...}` //
//     and always wins over any conflicting Tailwind class (heading levels,     //
//     widget body text-sm defaults, etc.). This is the canonical surface for   //
//     all new code.                                                            //
//                                                                              //
//   * textStyleToClassName(style) → Tailwind class string for the legacy       //
//     `size` enum only. Pre-numeric-switch templates still carry e.g.          //
//     `size: 'sm'` and we honor it via class so the report-widget-body 1.3×    //
//     boost continues to apply (matching how those templates rendered before). //
//     weight/family/align deliberately stop emitting classes — the inline      //
//     style path covers them, and emitting both would re-introduce the         //
//     cascade race we are trying to fix.                                       //
//                                                                              //
// CRITICAL: do NOT build class strings via interpolation — Tailwind purges      //
// unseen patterns. Every literal must appear in the source, hence the lookups.  //
// --------------------------------------------------------------------------- //

// Legacy size enum → Tailwind class. Only honored when `font_size_px` is unset.
const _LEGACY_SIZE_CLASS = {
  xs: 'text-xs',
  sm: 'text-sm',
  base: 'text-base',
  lg: 'text-lg',
  xl: 'text-xl',
  '2xl': 'text-2xl',
}
// Legacy size enum → px value, used by textStyleToInlineStyle when callers
// fall back through to the legacy field. Numbers match the boosted sizes
// the `.report-widget-body` overrides produced for these enum values, so a
// template saved with `size: 'sm'` renders at the same visual size after
// the switch to inline px even if its widget host loses the boost.
const _LEGACY_SIZE_PX = {
  xs: 12,
  sm: 18,
  base: 21,
  lg: 23,
  xl: 26,
  '2xl': 31,
}
const _FONT_FAMILY_CSS = {
  sans: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
}
const _WEIGHT_NUM = {
  normal: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
}

function _fontSizePx(style) {
  if (!style || typeof style !== 'object') return undefined
  if (Number.isFinite(style.font_size_px)) return style.font_size_px
  return _LEGACY_SIZE_PX[style.size]
}

/**
 * Map a text_style object to a React style object. Wins over conflicting
 * Tailwind classes — this is how Heading (text-xl) + user's pick (e.g. 18px)
 * land on the user's choice instead of whichever class Tailwind emitted last.
 *
 * Returns undefined when nothing is set so JSX can splat it without leaking
 * an empty `style={}` attribute onto the DOM.
 */
export function textStyleToInlineStyle(style) {
  if (!style || typeof style !== 'object') return undefined
  const out = {}
  const px = _fontSizePx(style)
  if (px != null) out.fontSize = `${px}px`
  if (style.font_family && _FONT_FAMILY_CSS[style.font_family]) {
    out.fontFamily = _FONT_FAMILY_CSS[style.font_family]
  }
  if (style.align) out.textAlign = style.align
  if (style.weight && _WEIGHT_NUM[style.weight] != null) {
    out.fontWeight = _WEIGHT_NUM[style.weight]
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/**
 * Legacy class string — only emits `text-{size}` for the deprecated `size`
 * enum so old templates keep rendering with the report-widget-body boost.
 * New code should prefer `textStyleToInlineStyle`; this helper exists so
 * the existing `className={textClass}` plumbing in each widget keeps
 * working without per-call site refactors.
 */
export function textStyleToClassName(style) {
  if (!style || typeof style !== 'object') return ''
  const classes = []
  // If the writer picked a numeric size, drop the legacy size class so it
  // can't race with the inline style we also emit. (Old data with no
  // font_size_px still falls through to the class so its boost-era rendering
  // survives.)
  if (!Number.isFinite(style.font_size_px)) {
    const sizeCls = _LEGACY_SIZE_CLASS[style.size]
    if (sizeCls) classes.push(sizeCls)
  }
  // Text color rides as a theme-adaptive token class (see @/shared/text-color),
  // so block text in every widget adapts to light/dark like the rich-text body.
  const colorCls = colorTokenClass(style.color)
  if (colorCls) classes.push(colorCls)
  return classes.join(' ')
}

// Curated font sizes matching the RichText inline floating toolbar so
// designers see the same vocabulary at template time and at write time.
// Kept as integers in the schema; the UI presents them in px for clarity.
const _FONT_SIZE_PX_OPTIONS = [
  { value: '', label: '기본' },
  { value: 10, label: '10 px' },
  { value: 11, label: '11 px' },
  { value: 12, label: '12 px' },
  { value: 13, label: '13 px' },
  { value: 14, label: '14 px' },
  { value: 16, label: '16 px' },
  { value: 18, label: '18 px' },
  { value: 20, label: '20 px' },
  { value: 24, label: '24 px' },
  { value: 28, label: '28 px' },
  { value: 32, label: '32 px' },
  { value: 36, label: '36 px' },
  { value: 48, label: '48 px' },
]

/**
 * Body widgets render inside `.report-widget-body`, which scales `text-sm`
 * (the widget body default) to 1.1375rem ≈ 18px. Surfaced as a named
 * constant so every widget's "기본 (18 px)" label points at the same
 * place; bump this and the index.css boost together.
 */
export const DEFAULT_BODY_FONT_PX = 18

/**
 * 위젯 헤더(caption)의 기본 글자 px. CaptionInput 은 `text-base font-semibold`
 * 로 렌더되고, `.report-widget-body .text-base` 는 index.css 에서 1.3rem
 * (≈20.8px)로 부스트된다 → 21px. 헤더 글자크기 버블 메뉴의 "기본 (N px)"
 * 표기에 쓴다. index.css 의 .text-base 부스트를 바꾸면 같이 맞춰야 한다.
 */
export const CAPTION_DEFAULT_PX = 21

/**
 * Heading level → boosted px. Mirrors `.report-widget-body .text-lg/xl/2xl`
 * from index.css so the heading props panel's "기본" hint matches what the
 * report editor actually paints.
 */
export const HEADING_DEFAULT_PX_BY_LEVEL = {
  1: 31, // text-2xl → 1.95rem
  2: 26, // text-xl  → 1.625rem
  3: 23, // text-lg  → 1.4625rem
}

/**
 * Build the font-size dropdown options with the widget's resolved default
 * surfaced inside the empty option's label. Falls back to a plain "기본"
 * row when no default was passed in, so callers that haven't been updated
 * yet still get the previous behavior.
 */
function _fontSizeOptionsWithDefault(defaultPx) {
  if (!Number.isFinite(defaultPx)) return _FONT_SIZE_PX_OPTIONS
  return _FONT_SIZE_PX_OPTIONS.map((o) =>
    o.value === '' ? { value: '', label: `기본 (${defaultPx} px)` } : o,
  )
}
const _FONT_OPTIONS = [
  { value: '', label: '기본' },
  { value: 'sans', label: '산세리프 (Sans)' },
  { value: 'serif', label: '세리프 (Serif)' },
  { value: 'mono', label: '고정폭 (Mono)' },
]
const _ALIGN_OPTIONS = [
  { value: '', label: '기본' },
  { value: 'left', label: '왼쪽' },
  { value: 'center', label: '가운데' },
  { value: 'right', label: '오른쪽' },
  { value: 'justify', label: '양쪽' },
]
const _WEIGHT_OPTIONS = [
  { value: '', label: '기본' },
  { value: 'normal', label: '보통' },
  { value: 'medium', label: '약간 굵게' },
  { value: 'semibold', label: '굵게' },
  { value: 'bold', label: '아주 굵게' },
]

/**
 * Designer-time text-style editor. Renders inside a `<details>` so it
 * stays out of the way for templates that don't customize typography.
 * Sets each field to `undefined` when "기본" is picked so the saved
 * `text_style` object stays sparse (and is pruned to `undefined` entirely
 * when every field is empty).
 */
export function TextStyleField({ value, onChange, defaultSizePx }) {
  const style = value ?? {}
  function patch(p) {
    const merged = { ...style, ...p }
    // Drop empty string / undefined entries so we don't ship noise.
    const cleaned = {}
    for (const [k, v] of Object.entries(merged)) {
      if (v === '' || v === undefined || v === null) continue
      cleaned[k] = v
    }
    onChange(Object.keys(cleaned).length === 0 ? undefined : cleaned)
  }
  // Preview reflects the current selection (inline style + legacy class) so
  // the designer sees the actual visual without saving and switching to the
  // report editor.
  const previewClass = textStyleToClassName(style) || 'text-sm text-muted-foreground'
  const previewStyle = textStyleToInlineStyle(style)
  // Legacy templates may carry only `size` (enum). Surface its mapped px
  // value in the dropdown so the designer sees the current setting; the
  // first edit upgrades the row to `font_size_px` and drops the legacy key.
  const displayFontSize = style.font_size_px ?? _LEGACY_SIZE_PX[style.size] ?? ''

  return (
    <details className="rounded-md border bg-muted/10 px-3 py-2">
      <summary className="cursor-pointer text-xs font-medium select-none">
        텍스트 스타일
        {Object.keys(style).length > 0 && (
          <span className="ml-2 text-[10px] text-muted-foreground">
            ({Object.keys(style).length}개 항목 설정됨)
          </span>
        )}
      </summary>
      <div className="mt-2 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <_TextStyleSelect
            label="글자 크기"
            value={displayFontSize === '' ? '' : String(displayFontSize)}
            options={_fontSizeOptionsWithDefault(defaultSizePx)}
            onChange={(v) =>
              patch({
                font_size_px: v === '' ? '' : Number(v),
                // Clear the legacy enum on any edit so we never carry both
                // and so old back-compat data graduates to the numeric field.
                size: '',
              })
            }
          />
          <_TextStyleSelect
            label="글꼴"
            value={style.font_family ?? ''}
            options={_FONT_OPTIONS}
            onChange={(v) => patch({ font_family: v })}
          />
          <_TextStyleSelect
            label="정렬"
            value={style.align ?? ''}
            options={_ALIGN_OPTIONS}
            onChange={(v) => patch({ align: v })}
          />
          <_TextStyleSelect
            label="굵기"
            value={style.weight ?? ''}
            options={_WEIGHT_OPTIONS}
            onChange={(v) => patch({ weight: v })}
          />
        </div>
        <div>
          <Label className="text-xs">글자 색</Label>
          <div className="mt-1">
            <ColorSwatchPicker
              value={style.color ?? null}
              onChange={(token) => patch({ color: token })}
            />
          </div>
        </div>
        <div className="rounded border bg-background p-2">
          <div className="text-[10px] uppercase text-muted-foreground mb-1">
            미리보기
          </div>
          <div className={previewClass} style={previewStyle}>
            가나다 ABC 123 — 텍스트 스타일 미리보기
          </div>
        </div>
      </div>
    </details>
  )
}

/**
 * Designer-time editor for per-depth text style overrides used by the
 * RichText widget. Exposes only the three buckets actually rendered with
 * distinct prefix glyphs (■ / – / ·); depths 3+ inherit the depth-2 style.
 *
 * Stored shape: `{ "0"?: TextStyle, "1"?: TextStyle, "2"?: TextStyle }`.
 * Each depth value is itself a sparse object — empty fields fall through
 * to the base `text_style`. When every depth has every field empty, we
 * call onChange(undefined) so the parent props stay sparse.
 *
 * NOTE: `value` here is the `depth_styles` map, not a flat TextStyle.
 */
const _DEPTH_LABELS = [
  // depth 0 glyph: `■` (current). Was `□` → `▶` → `■`; `□` is reserved
  // for the top-level 전체 과제명 marker, and `▶` was misread by AI as
  // "→ 결론" when drafting bodies, so we landed on a neutral solid square.
  { key: '0', glyph: '■', name: '대표 문장 (depth 0)' },
  { key: '1', glyph: '-', name: '상세 (depth 1)' },
  { key: '2', glyph: '·', name: '깊은 설명 (depth 2+)' },
]

export function DepthStyleField({ value, onChange, baseSizePx }) {
  const map = value ?? {}
  const setCount = _DEPTH_LABELS.reduce(
    (n, d) => n + (map[d.key] && Object.keys(map[d.key]).length > 0 ? 1 : 0),
    0,
  )

  function patchDepth(depthKey, style) {
    const next = { ...map }
    if (!style || Object.keys(style).length === 0) {
      delete next[depthKey]
    } else {
      next[depthKey] = style
    }
    onChange(Object.keys(next).length === 0 ? undefined : next)
  }

  return (
    <details className="rounded-md border bg-muted/10 px-3 py-2">
      <summary className="cursor-pointer text-xs font-medium select-none">
        깊이별 스타일
        {setCount > 0 && (
          <span className="ml-2 text-[10px] text-muted-foreground">
            ({setCount}개 깊이 설정됨)
          </span>
        )}
      </summary>
      <p className="mt-1 text-[10px] text-muted-foreground">
        깊이별로 텍스트 스타일을 따로 지정합니다. 비어 있는 항목은 위의 기본
        텍스트 스타일을 따릅니다. depth 3 이상은 depth 2의 스타일을 상속.
      </p>
      <div className="mt-2 space-y-2">
        {_DEPTH_LABELS.map((d) => (
          <_DepthRow
            key={d.key}
            depthKey={d.key}
            defaultSizePx={baseSizePx}
            glyph={d.glyph}
            name={d.name}
            style={map[d.key]}
            onChange={(s) => patchDepth(d.key, s)}
          />
        ))}
      </div>
    </details>
  )
}

function _DepthRow({ depthKey, glyph, name, style, onChange, defaultSizePx }) {
  const cur = style ?? {}
  function patch(p) {
    const merged = { ...cur, ...p }
    const cleaned = {}
    for (const [k, v] of Object.entries(merged)) {
      if (v === '' || v === undefined || v === null) continue
      cleaned[k] = v
    }
    onChange(Object.keys(cleaned).length === 0 ? undefined : cleaned)
  }
  const previewClass = textStyleToClassName(cur) || 'text-sm text-muted-foreground'
  const previewStyle = textStyleToInlineStyle(cur)
  const displayFontSize = cur.font_size_px ?? _LEGACY_SIZE_PX[cur.size] ?? ''
  return (
    <div className="rounded border bg-background p-2 space-y-2">
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm w-4 text-center text-muted-foreground">
          {glyph}
        </span>
        <span className="text-xs text-muted-foreground">{name}</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <_TextStyleSelect
          label="글자 크기"
          value={displayFontSize === '' ? '' : String(displayFontSize)}
          options={_fontSizeOptionsWithDefault(defaultSizePx)}
          onChange={(v) =>
            patch({
              font_size_px: v === '' ? '' : Number(v),
              size: '',
            })
          }
        />
        <_TextStyleSelect
          label="굵기"
          value={cur.weight ?? ''}
          options={_WEIGHT_OPTIONS}
          onChange={(v) => patch({ weight: v })}
        />
        <_TextStyleSelect
          label="글꼴"
          value={cur.font_family ?? ''}
          options={_FONT_OPTIONS}
          onChange={(v) => patch({ font_family: v })}
        />
        <_TextStyleSelect
          label="정렬"
          value={cur.align ?? ''}
          options={_ALIGN_OPTIONS}
          onChange={(v) => patch({ align: v })}
        />
      </div>
      <div className={`px-1 ${previewClass}`} style={previewStyle}>
        {glyph} 미리보기 — 가나다 ABC
      </div>
    </div>
  )
}

/**
 * Compute the effective class string for a given depth, layering:
 *   1. base `text_style` (always applied)
 *   2. `depth_styles[min(depth, 2)]` overlay (overrides base on shared keys)
 *
 * Tailwind purge concern: every class string emitted here goes through
 * `textStyleToClassName`, which reads from literal lookup tables. So all
 * classes appear in source and survive the purge.
 */
export function depthBodyClassName(textStyle, depthStyles, depth) {
  return textStyleToClassName(_mergedDepthStyle(textStyle, depthStyles, depth))
}

/**
 * Inline-style analog of `depthBodyClassName` — the per-depth merge then
 * fed through `textStyleToInlineStyle` so the resulting CSS overrides any
 * conflicting class on the same element.
 */
export function depthBodyInlineStyle(textStyle, depthStyles, depth) {
  return textStyleToInlineStyle(_mergedDepthStyle(textStyle, depthStyles, depth))
}

/**
 * 주어진 depth 의 본문 *기본* 글자 px — depth_styles 오버레이 → text_style →
 * 위젯 본문 기본(DEFAULT_BODY_FONT_PX) 순으로 해석. 작성 시 글자크기 버블
 * 메뉴의 "기본 (N px)" 표기에 쓴다(표 셀의 defaultSizePx 와 동일한 목적).
 */
export function depthBodyBaseSizePx(textStyle, depthStyles, depth) {
  const merged = _mergedDepthStyle(textStyle, depthStyles, depth)
  return Number.isFinite(merged.font_size_px)
    ? merged.font_size_px
    : DEFAULT_BODY_FONT_PX
}

function _mergedDepthStyle(textStyle, depthStyles, depth) {
  // Bucket: 0, 1, or 2 — depths 3+ collapse into "2".
  const bucket = String(Math.min(Math.max(depth | 0, 0), 2))
  const overlay = depthStyles?.[bucket]
  // If the bucket has no override, the depth inherits the base unchanged.
  // Buckets are independent — leaving "1" empty doesn't pull in "0".
  return { ...(textStyle ?? {}), ...(overlay ?? {}) }
}

function _TextStyleSelect({ label, value, options, onChange }) {
  return (
    <div>
      <Label className="text-[10px] uppercase">{label}</Label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-0.5 flex h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}

/**
 * Shared block-level caption input used by every non-heading widget's
 * Editor. Renders inline as a heading-styled text field. When set, the
 * caption replaces the block's external `<h2>` title in the report.
 *
 * Template hint behavior — `placeholder` is the value the template author
 * configured (the widget's `label` prop). When it is non-empty:
 *   - the visible hint becomes `미입력시 "X"이(가) 입력됩니다` so writers know
 *     the field auto-fills
 *   - blurring the input while the value is empty saves the hint as the
 *     caption verbatim (so view-mode renders it as a real heading)
 * Writers can opt out via the inline "제목 생략" toggle — that flips
 * `skipAutofill` on, clears the caption, and changes the placeholder to
 * "(제목 없이 표시)" so they can leave the block headerless on purpose.
 * The toggle is driven by `onChangeSkipAutofill`; widgets that don't pass
 * one stay on the legacy always-autofill behavior.
 *
 * When the template hint is empty we fall back to the legacy "제목 (선택)"
 * placeholder and no auto-fill happens, matching the prior behavior.
 *
 * When `readOnly` is true:
 *   - empty value → renders nothing (no placeholder leakage in view mode)
 *   - non-empty value → renders as static styled text
 */
/**
 * Helper that returns the props needed to wire CaptionInput's skip
 * toggle into a widget's existing `patch(next)` helper. Each widget
 * needs to make sure its `patch` round-trips `caption_skip_autofill`
 * (typically by spreading `content` into the merged object) so the
 * flag survives across unrelated edits.
 */
/**
 * Compact inline `min/max` input used by chart-like widgets for axis
 * range overrides. `value` is null when unset (Recharts auto-domain);
 * `onChange(v)` passes the numeric value or `undefined` to clear.
 *
 *   <AxisRangeInput label="X min" value={xMin} onChange={(v) => patch({ x_min: v })} />
 *
 * Shared across Chart + Scatter so the two stay visually identical.
 */
export function AxisRangeInput({ label, value, onChange }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span>{label}</span>
      <input
        type="number"
        step="any"
        value={typeof value === 'number' ? value : ''}
        onChange={(e) => {
          const v = e.target.value
          if (v === '') onChange(undefined)
          else {
            const n = Number(v)
            if (Number.isFinite(n)) onChange(n)
          }
        }}
        placeholder="auto"
        className="h-6 w-16 rounded-md border px-2 text-[11px]"
      />
    </span>
  )
}

// Inline-rich HTML sanitizer for caption / note display. The markup is
// produced by RichTextRowEditor (bold/italic/underline/strike + font-size +
// rt-c-* color spans), so the allow-list is intentionally tiny. DOMPurify
// also runs its own CSS sanitizer on `style`, blocking url()/expression().
const _CAPTION_SANITIZE = {
  ALLOWED_TAGS: ['p', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'br'],
  ALLOWED_ATTR: ['style', 'class'],
}
export function sanitizeCaptionHtml(html) {
  if (typeof html !== 'string' || html.length === 0) return ''
  return DOMPurify.sanitize(html, _CAPTION_SANITIZE)
}

// Pull the first text run's inline font-size / font-family out of caption or
// note html, so the leading marker ("그림 1." / "※") matches the size & face of
// the caption's first character instead of staying at the base size.
function _firstRunTypography(html) {
  if (typeof html !== 'string' || !html || typeof DOMParser === 'undefined') {
    return undefined
  }
  let doc
  try {
    doc = new DOMParser().parseFromString(html, 'text/html')
  } catch {
    return undefined
  }
  const p = doc.body.firstElementChild
  if (!p) return undefined
  const out = {}
  let cur = p.firstChild
  while (cur) {
    if (cur.nodeType === 3 /* TEXT_NODE */) {
      if (cur.nodeValue && cur.nodeValue.length > 0) break
      cur = cur.nextSibling
      continue
    }
    if (cur.nodeType === 1 /* ELEMENT_NODE */) {
      const s = cur.getAttribute('style') || ''
      const fm = s.match(/(^|;)\s*font-size\s*:\s*([^;]+)/i)
      const ff = s.match(/(^|;)\s*font-family\s*:\s*([^;]+)/i)
      if (fm && !out.fontSize) out.fontSize = fm[2].trim()
      if (ff && !out.fontFamily) out.fontFamily = ff[2].trim()
      cur = cur.firstChild || cur.nextSibling
    } else {
      cur = cur.nextSibling
    }
  }
  return Object.keys(out).length ? out : undefined
}

function _escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// True when rich html has no actual text (e.g. "<p></p>"). Used to fall back
// to the plain value / autofill hint.
export function _richIsEmpty(html) {
  return (
    typeof html !== 'string' ||
    html.replace(/<[^>]*>/g, '').replace(/ |&nbsp;/g, '').trim().length === 0
  )
}

// Seed html for the rich editor: prefer the stored rich html; otherwise lift
// an existing plain caption/note into a paragraph so legacy content shows up
// (and graduates to *_html on the first edit).
export function _richSeed(html, plain) {
  if (!_richIsEmpty(html)) return html
  const p = (plain ?? '').trim()
  return p ? `<p>${_escapeHtml(p)}</p>` : '<p></p>'
}

export function captionSkipProps({ content, patch }) {
  return {
    skipAutofill: content?.caption_skip_autofill === true,
    onChangeSkipAutofill: (skip) => {
      // Atomic patch: clear caption (both plain + rich) + set flag, or unset
      // the flag, in one call so the field updates can't race on a stale
      // content snapshot inside a click handler.
      if (skip) {
        patch({ caption: '', caption_html: undefined, caption_skip_autofill: true })
      } else {
        patch({ caption_skip_autofill: undefined })
      }
    },
    // Rich caption: the editor owns color/format via its selection bubble menu
    // (no always-on swatch). onChangeRich keeps the plain `caption` in sync —
    // it stays authoritative for the title role (chart titles, export, TOC).
    html: content?.caption_html ?? '',
    onChangeRich: (html, text) =>
      patch({
        caption_html: _richIsEmpty(html) ? undefined : html,
        caption: text?.trim() ? text : undefined,
      }),
    // 헤더(제목)를 내용 위/아래로 옮기는 토글. 기본(above)은 키를 비워둬 저장값이
    // 깔끔하게 유지되고, below 일 때만 'below' 를 기록한다.
    position: captionPositionOf(content),
    onChangePosition: (pos) =>
      patch({ caption_position: pos === 'below' ? 'below' : undefined }),
  }
}

/** content.caption_position 을 정규화 — 'below' 가 아니면 모두 'above'(기본).
 *  위젯이 CaptionInput 을 내용 앞/뒤 어디에 렌더할지 결정하는 데 쓴다. */
export function captionPositionOf(content) {
  return content?.caption_position === 'below' ? 'below' : 'above'
}

export function CaptionInput({
  value,
  onChange,
  placeholder,
  readOnly,
  skipAutofill,
  onChangeSkipAutofill,
  color,
  html,
  onChangeRich,
  position,
  onChangePosition,
  // 위젯이 헤더 컨트롤 줄(위/아래·제목 생략 옆)에 끼워 넣을 추가 토글. 예: 긴 글의
  // 번호↔불릿 머리표 토글. 제목 생략(skip) 상태에서도 유지되도록 두 분기 모두 렌더.
  extraControls = null,
}) {
  const skip = !!skipAutofill
  const hint = typeof placeholder === 'string' ? placeholder.trim() : ''
  const hasHint = hint.length > 0
  const hasValue = (value ?? '').trim().length > 0
  // Theme-adaptive caption color (token → class) — legacy block color, applied
  // only to the plain-text fallback. Rich html carries its own inline colors.
  const colorClass = colorTokenClass(color)
  const hasRich = !_richIsEmpty(html)
  // Cross-reference number ("그림 3") for this block, injected by the report
  // renderer. null in template editor / non-referenceable widgets.
  const refLabel = useCurrentBlockRef()
  // Effective visible text when the user hasn't typed anything:
  //   - skip ON  → blank (title row hidden entirely)
  //   - auto-fit → template hint (so the default is visible without
  //                forcing a focus-then-blur cycle)
  const fallback = skip ? '' : hint
  const effectiveText = hasValue ? value : fallback

  if (readOnly) {
    // data-export-skip → html2canvas (DOCX export) drops this title from the
    // captured PNG; the exporter emits it as a real Heading 3 above the figure.
    // Priority: rich html (per-char marks) > plain text/autofill hint.
    if (!hasRich && !effectiveText) return null
    // Match the marker ("그림 N.") to the caption's first character size/face.
    const markerStyle = hasRich ? _firstRunTypography(html) : undefined
    return (
      <div
        data-export-skip="caption"
        className="text-base font-semibold px-2 py-1"
      >
        {refLabel && (
          <span className="mr-1 text-foreground" style={markerStyle}>
            {refLabel}.
          </span>
        )}
        {hasRich ? (
          <span
            className="[&_p]:m-0 [&_p]:inline"
            dangerouslySetInnerHTML={{ __html: sanitizeCaptionHtml(html) }}
          />
        ) : (
          <span className={colorClass}>{effectiveText}</span>
        )}
      </div>
    )
  }

  // Edit + skip ON → hide the input completely. Only the small toggle
  // button remains so the user can re-enable auto-fill. Matches the
  // user's "제목부분 표기가 그냥 없어져야" expectation.
  if (skip && onChangeSkipAutofill) {
    return (
      <div className="flex items-center gap-1 px-2 py-1">
        <button
          type="button"
          onClick={() => onChangeSkipAutofill(false)}
          // Stop bubbling so the click doesn't re-activate the block
          // and steal focus back the moment we toggle.
          onMouseDown={(e) => e.stopPropagation()}
          title="자동 채움을 다시 켭니다 (템플릿 라벨로 채움)"
          className={cn(
            'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors',
            'bg-amber-100 text-amber-900 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-200',
          )}
        >
          자동 채움 켜기
        </button>
        {extraControls}
      </div>
    )
  }

  // Edit + auto-fill ON. The input uses the hint as its placeholder
  // styled like real text (high contrast) so the default value is
  // visually present without forcing the writer to focus/blur to
  // trigger an auto-fill mutation. Typing replaces; deleting back
  // to empty restores the hint as the visible default. `content.
  // caption` stays empty in that case so a later template-label
  // change still propagates.
  const showSkipToggle = Boolean(onChangeSkipAutofill) && hasHint
  const skipToggle = showSkipToggle ? (
    <button
      type="button"
      onClick={() => onChangeSkipAutofill(true)}
      onMouseDown={(e) => e.stopPropagation()}
      title="템플릿 라벨 자동 채움을 끄고 제목을 비워둡니다"
      className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
    >
      제목 생략
    </button>
  ) : null

  // 헤더 위치 토글 — 내용 위(above)/아래(below) 전환. onChangePosition 을 받은
  // 위젯에서만 노출(읽기전용엔 안 넘어옴). 위치 자체는 위젯이 CaptionInput 을
  // 내용 앞/뒤에 렌더해 반영하고, 이 버튼은 content.caption_position 만 바꾼다.
  const isBelow = position === 'below'
  const positionToggle = onChangePosition ? (
    <button
      type="button"
      onClick={() => onChangePosition(isBelow ? 'above' : 'below')}
      onMouseDown={(e) => e.stopPropagation()}
      title={isBelow ? '헤더를 내용 위로 이동' : '헤더를 내용 아래로 이동'}
      className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
    >
      {isBelow ? '헤더 ↑ 위로' : '헤더 ↓ 아래로'}
    </button>
  ) : null

  // Rich caption editor: color/format live in the selection bubble menu (no
  // always-on swatch). onChangeRich syncs both caption_html + plain caption.
  if (onChangeRich) {
    return (
      <div className="flex items-center gap-1">
        <div className="flex-1 min-w-0 outline-rich-row">
          <RichTextRowEditor
            html={_richSeed(html, value)}
            placeholder={hasHint ? hint : '제목 (선택)'}
            onChange={onChangeRich}
            defaultSizePx={CAPTION_DEFAULT_PX}
            className="text-base font-semibold px-2 py-1"
          />
        </div>
        {extraControls}
        {positionToggle}
        {skipToggle}
      </div>
    )
  }

  // Plain fallback (widgets that don't opt into rich captions).
  return (
    <div className="flex items-center gap-1">
      <input
        type="text"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={hasHint ? hint : '제목 (선택)'}
        className={cn(
          'flex-1 min-w-0 bg-transparent border-0 outline-none focus:ring-0',
          'text-base font-semibold px-2 py-1',
          // High-contrast placeholder so the hint reads like the
          // saved default rather than a faded suggestion.
          'placeholder:text-foreground/55',
          colorClass,
        )}
      />
      {extraControls}
      {positionToggle}
      {skipToggle}
    </div>
  )
}

/** 위젯 하단 참고 내용 — "※ " 프리픽스로 렌더(저장값엔 프리픽스 없음).
 *  caption(상단 제목)과 별개. 비어 있으면 뷰에선 아무것도 안 그린다. */
export function NoteInput({ value, onChange, readOnly, color, html, onChangeRich }) {
  const text = (value ?? '').trim()
  // Theme-adaptive note color (token → class) — legacy block color on the plain
  // fallback only; rich html carries its own inline colors. ※ marker stays muted.
  const colorClass = colorTokenClass(color)
  const hasRich = !_richIsEmpty(html)
  // Match the ※ marker to the note's first character size/face.
  const markerStyle = hasRich ? _firstRunTypography(html) : undefined
  if (readOnly) {
    if (hasRich) {
      return (
        <div className="flex items-start gap-1 px-2 py-1 text-xs text-muted-foreground whitespace-pre-wrap break-words">
          <span className="select-none shrink-0" style={markerStyle}>※</span>
          <span
            className="flex-1 min-w-0"
            dangerouslySetInnerHTML={{ __html: sanitizeCaptionHtml(html) }}
          />
        </div>
      )
    }
    if (!text) return null
    return (
      <div className="flex items-start gap-1 px-2 py-1 text-xs text-muted-foreground whitespace-pre-wrap break-words">
        <span className="select-none shrink-0">※</span>
        <span className={cn('flex-1 min-w-0', colorClass)}>{text}</span>
      </div>
    )
  }
  // Rich note editor: color/format via the selection bubble menu. onChangeRich
  // syncs both note_html + plain note.
  if (onChangeRich) {
    return (
      <div className="flex items-start gap-1 px-2">
        <span className="mt-1.5 select-none shrink-0 text-xs text-muted-foreground">
          ※
        </span>
        <div className="flex-1 min-w-0 outline-rich-row rounded-md border border-input bg-background px-2 py-1 text-xs leading-snug text-muted-foreground">
          <RichTextRowEditor
            html={_richSeed(html, value)}
            placeholder="참고 내용 (선택) — 하단에 ※로 표시됩니다"
            onChange={onChangeRich}
          />
        </div>
      </div>
    )
  }
  // Plain fallback.
  return (
    <div className="flex items-start gap-1 px-2">
      <span className="mt-1.5 select-none shrink-0 text-xs text-muted-foreground">
        ※
      </span>
      <textarea
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        rows={1}
        placeholder="참고 내용 (선택) — 하단에 ※로 표시됩니다"
        className={cn(
          'flex-1 min-w-0 resize-y rounded-md border border-input bg-background px-2 py-1 text-xs leading-snug text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring whitespace-pre-wrap break-words',
          colorClass,
        )}
      />
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Editor option bar — compact "위젯 편집" toolbar primitives                  //
//                                                                              //
// Convention: a widget's PropsPanel sets the *template default* for a knob;   //
// the same knob (added to content_schema_for) can be overridden per-report by //
// surfacing it in the Editor with one of these primitives. Read-time           //
// precedence is `content.<key> ?? props.<key> ?? fallback` via the             //
// effective<Type> helpers below. patch() should call pruneOverrideKeys to      //
// strip an override that matches the template default so a later template     //
// change still reaches reports that never touched the field.                  //
// --------------------------------------------------------------------------- //

/** Compact bar container that hosts EditorOption* controls. Renders an
 *  optional uppercase title chip on the left. */
export function EditorOptionBar({ title = '옵션', children, className }) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-md border bg-muted/20 px-3 py-1.5 text-xs',
        className,
      )}
    >
      {title && (
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
          {title}
        </span>
      )}
      {children}
    </div>
  )
}

/** Boolean toggle. value is coerced to bool; onChange(nextBool). */
export function EditorOptionToggle({ label, value, onChange, hint }) {
  return (
    <label className="inline-flex items-center gap-1.5 cursor-pointer" title={hint}>
      <input
        type="checkbox"
        checked={!!value}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  )
}

/** Numeric input. Clears to undefined on empty; clamps to [min, max] inside
 *  onChange so callers don't have to. Pass `step` for non-integer steps. */
export function EditorOptionNumber({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  width = 'w-16',
  suffix,
  hint,
}) {
  return (
    <label className="inline-flex items-center gap-1.5" title={hint}>
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(value) ? value : ''}
        onChange={(e) => {
          if (e.target.value === '') {
            onChange(undefined)
            return
          }
          const n = Number(e.target.value)
          if (!Number.isFinite(n)) return
          let clamped = n
          if (Number.isFinite(min)) clamped = Math.max(min, clamped)
          if (Number.isFinite(max)) clamped = Math.min(max, clamped)
          onChange(clamped)
        }}
        className={cn(
          'h-7 rounded-md border px-1.5 text-center text-xs',
          width,
        )}
      />
      {suffix && (
        <span className="text-[10px] text-muted-foreground">{suffix}</span>
      )}
    </label>
  )
}

/** Free-text input. Empty string → undefined so patch() can strip it. */
export function EditorOptionText({
  label,
  value,
  onChange,
  placeholder,
  maxLength,
  width = 'w-24',
  hint,
}) {
  return (
    <label className="inline-flex items-center gap-1.5" title={hint}>
      <span>{label}</span>
      <input
        type="text"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || undefined)}
        placeholder={placeholder}
        maxLength={maxLength}
        className={cn(
          'h-7 rounded-md border px-1.5 text-xs',
          width,
        )}
      />
    </label>
  )
}

/** Native dropdown select — better than segmented when options are 5+
 *  or contain a "기본/auto" empty choice. `options` is
 *  `[{ value, label }]`; selecting the option whose value is `''`
 *  invokes `onChange(undefined)` so patch() can strip it. */
export function EditorOptionSelect({ label, value, options, onChange, hint, width = 'w-24' }) {
  return (
    <label className="inline-flex items-center gap-1.5" title={hint}>
      <span>{label}</span>
      <select
        value={value ?? ''}
        onChange={(e) => {
          const v = e.target.value
          onChange(v === '' ? undefined : v)
        }}
        className={cn(
          'h-7 rounded-md border bg-background px-1.5 text-xs',
          width,
        )}
      >
        {options.map((opt) => (
          <option key={String(opt.value)} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  )
}

/** Date input (HTML5 yyyy-mm-dd). Empty → undefined. */
export function EditorOptionDate({ label, value, onChange, hint }) {
  return (
    <label className="inline-flex items-center gap-1.5" title={hint}>
      <span>{label}</span>
      <input
        type="date"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || undefined)}
        className="h-7 rounded-md border px-1.5 text-xs"
      />
    </label>
  )
}

/** Segmented control — small button row, one selected. options is
 *  `[{ value, label, Icon? }]`. */
export function EditorOptionSegmented({ label, value, options, onChange, hint }) {
  return (
    <div className="inline-flex items-center gap-1.5" title={hint}>
      {label && <span>{label}</span>}
      <div className="inline-flex rounded-md border bg-background overflow-hidden">
        {options.map((opt) => {
          const active = value === opt.value
          return (
            <button
              key={String(opt.value)}
              type="button"
              onClick={() => onChange(opt.value)}
              className={cn(
                'inline-flex items-center gap-1 h-7 px-2 text-xs transition-colors',
                active
                  ? 'bg-primary text-primary-foreground'
                  : 'hover:bg-muted',
              )}
            >
              {opt.Icon && <opt.Icon className="h-3 w-3" />}
              {opt.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Effective-value helpers — content (per-report override) wins over            //
// props (template default), then a hard-coded fallback. Use these inside        //
// the Editor function so reads stay consistent across read-only / edit mode.   //
// --------------------------------------------------------------------------- //

export function effectiveBool(content, props, key, fallback = false) {
  if (content && typeof content[key] === 'boolean') return content[key]
  if (props && typeof props[key] === 'boolean') return props[key]
  return fallback
}

export function effectiveNumber(content, props, key, fallback) {
  if (content && Number.isFinite(content[key])) return content[key]
  if (props && Number.isFinite(props[key])) return props[key]
  return fallback
}

export function effectiveString(content, props, key, fallback = '') {
  if (content && typeof content[key] === 'string' && content[key] !== '') {
    return content[key]
  }
  if (props && typeof props[key] === 'string' && props[key] !== '') {
    return props[key]
  }
  return fallback
}

/**
 * Strip override fields from `merged` that match the template default.
 * Mutates `merged` in place.
 *
 *   pruneOverrideKeys(merged, props, {
 *     horizontal_scroll: false,   // fallback when props doesn't carry it
 *     max_cases: 6,
 *   })
 *
 * For each key K:
 *   - if merged[K] is undefined, deletes it
 *   - if merged[K] equals `props[K] ?? defaults[K]`, deletes it
 *   - otherwise leaves it alone (genuine override)
 *
 * Arrays/objects are compared with strict equality; if you need a deep
 * compare, prune them yourself. Boolean/number/string keys are the
 * common case and work as expected.
 */
export function pruneOverrideKeys(merged, props, defaults) {
  for (const [k, fallback] of Object.entries(defaults)) {
    const v = merged[k]
    if (v === undefined) {
      delete merged[k]
      continue
    }
    const templateDefault =
      props != null && Object.prototype.hasOwnProperty.call(props, k)
        ? props[k]
        : fallback
    if (v === templateDefault) {
      delete merged[k]
    }
  }
}

/**
 * 표/비교표 셀에 쓰는 자동 grow textarea — `rows=1` 로 시작해 scrollHeight
 * 만큼 키를 맞춰 줄바꿈이 자연스럽게 보이도록 한다. `...rest` 로 들어오는
 * data-* / onKeyDown 같은 prop 은 그대로 통과시켜 그리드 네비게이션 hook
 * 과 함께 쓸 수 있다.
 */
export function AutoGrowTextarea({ value, onChange, className, rows = 1, ...rest }) {
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])
  return (
    <textarea
      ref={ref}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      rows={rows}
      className={className}
      {...rest}
    />
  )
}

/**
 * 표 / 비교표 공용 그리드 네비게이션 훅.
 *
 * 동작:
 *  - ArrowUp/Down: textarea 면 커서가 첫/마지막 줄일 때만 행 이동.
 *    input(단일행) 이면 항상 행 이동.
 *  - ArrowLeft: 커서가 0 일 때 왼쪽 셀로.
 *  - ArrowRight: 커서가 끝일 때 오른쪽 셀로.
 *  - Cmd/Ctrl/Alt 조합은 건너뜀 (브라우저 단축키 / 단어단위 이동 보호).
 *  - 대상 셀이 없으면(테두리) preventDefault 안 하고 native 동작 그대로.
 *
 * 사용:
 *   const grid = useGridNavigation()
 *   <div ref={grid.gridRef}>
 *     ...
 *     <textarea
 *       data-grid-cell={`${rowIdx}:${colIdx}`}
 *       onKeyDown={(e) => grid.handleKey(e, rowIdx, colIdx)}
 *       ...
 *     />
 *
 * 주의 — number/date input 의 ArrowUp/Down 은 native 가 값을 증감시키므로
 * 굳이 셀 이동을 강제하지 않는다 (cursor 위치를 못 읽어 결국 fall-through).
 * 그쪽은 Tab 이동을 권장.
 */
export function useGridNavigation() {
  const gridRef = useRef(null)

  const focusCell = useCallback((rowIdx, colIdx, position = 'end') => {
    const root = gridRef.current
    if (!root) return false
    if (rowIdx < 0 || colIdx < 0) return false
    const sel = `[data-grid-cell="${rowIdx}:${colIdx}"]`
    const el = root.querySelector(sel)
    if (!el) return false
    el.focus()
    try {
      const len = el.value?.length ?? 0
      const pos = position === 'start' ? 0 : len
      el.setSelectionRange?.(pos, pos)
    } catch (_) {
      /* setSelectionRange 가 number/date/select 에서 throw 하는 브라우저 — 무시 */
    }
    return true
  }, [])

  const handleKey = useCallback(
    (e, rowIdx, colIdx) => {
      if (e.defaultPrevented) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'IME') return
      const el = e.currentTarget
      // 한글 등 IME 조합 중 — 키 이벤트가 이중으로 들어와 셀이 점프하면 안 됨.
      if (e.nativeEvent?.isComposing || e.isComposing) return
      const isTextarea = el.tagName === 'TEXTAREA'
      const value = el.value ?? ''
      let selStart = null
      let selEnd = null
      try {
        selStart = el.selectionStart
        selEnd = el.selectionEnd
      } catch (_) {
        /* number/date input 등은 selection API 미지원 */
      }
      const valLen = value.length

      if (e.key === 'ArrowUp') {
        if (isTextarea && selStart != null) {
          const before = value.slice(0, selStart)
          if (before.includes('\n')) return
        }
        if (focusCell(rowIdx - 1, colIdx, 'end')) e.preventDefault()
        return
      }
      if (e.key === 'ArrowDown') {
        if (isTextarea && selEnd != null) {
          const after = value.slice(selEnd)
          if (after.includes('\n')) return
        }
        if (focusCell(rowIdx + 1, colIdx, 'start')) e.preventDefault()
        return
      }
      if (e.key === 'ArrowLeft') {
        if (selStart == null || selStart === 0) {
          if (focusCell(rowIdx, colIdx - 1, 'end')) e.preventDefault()
        }
        return
      }
      if (e.key === 'ArrowRight') {
        if (selEnd == null || selEnd === valLen) {
          if (focusCell(rowIdx, colIdx + 1, 'start')) e.preventDefault()
        }
        return
      }
    },
    [focusCell],
  )

  return { gridRef, focusCell, handleKey }
}

// --- Cell-merge utilities ------------------------------------------- //
//
// 표 / 비교표 (그리고 향후 RACI 같은 grid 위젯) 가 공유하는 셀 병합 로직.
// 데이터 모델은 side-table 한 줄:
//
//   content.merges = [
//     { r: 0, c: 2, rs: 2, cs: 3 },  // (행 0, 열 2) anchor → 2행 × 3열 사각형
//     ...
//   ]
//
// - r, c 는 0-based row / column 인덱스 (열 key 가 아니라 위치 — rename 후에도
//   안정적). col 0 부터 N-1 까지 visible 컬럼 기준.
// - rs, cs ≥ 1. rs===1 && cs===1 이면 무의미한 1×1 병합 → drop.
// - merges 가 빈 배열이거나 없으면 기존 렌더와 100% 동일 (= 폴백).
//
// 두 위젯 모두 render 시 `computeMergeMap(merges, rowCount, colCount)` 한 번
// 호출 → `{ anchors, covered }` 받아 rows.map / cells.map 안에서:
//   - covered.has(`${r},${c}`)  → 그 셀은 skip (출력 안 함, 옆 anchor 가 덮음)
//   - anchors.get(...)         → rowSpan / colSpan attr 부여
//
// 정규화는 `normalizeMerges(...)` 가 담당:
//   1) 사각형이 grid 범위 안에 들어가도록 clamp
//   2) 다른 병합과 겹치면 후행 입력 우선 (= 사용자가 합치기 다시 누른 의미)
//   3) 1×1 사각형 drop
//   4) 정렬 (r, c 순) — 직렬화 안정성
//
// JSON 직렬화 / 저장은 content.merges 그대로. 백엔드 schema 변경 0.

/** 한 셀 좌표 key — Map / Set 의 표준화된 문자열 키. */
function _mkey(r, c) {
  return `${r},${c}`
}

/**
 * @param {Array<{r:number,c:number,rs:number,cs:number}>} merges
 * @param {number} rowCount
 * @param {number} colCount
 * @returns {{
 *   anchors: Map<string, {rs:number,cs:number}>,  // "r,c" → span
 *   covered: Set<string>,                          // "r,c" 가 다른 anchor 의 영역에 포함됨
 * }}
 *
 * 렌더 hot path 라 cheap. anchors 셀 자기 자신은 covered 에 포함 안 함 (anchor
 * 가 자기 자리에서 span attr 로 렌더링됨). 잘못된 merge (범위 밖 / 1×1) 는
 * 조용히 무시 — 정규화는 호출자가 patch 시점에 한 번씩 돌리는 게 정석.
 */
export function computeMergeMap(merges, rowCount, colCount) {
  const anchors = new Map()
  const covered = new Set()
  if (!Array.isArray(merges) || merges.length === 0) {
    return { anchors, covered }
  }
  for (const m of merges) {
    if (!m) continue
    const r = Number(m.r)
    const c = Number(m.c)
    const rs = Math.max(1, Math.floor(Number(m.rs ?? 1)))
    const cs = Math.max(1, Math.floor(Number(m.cs ?? 1)))
    if (
      !Number.isFinite(r) ||
      !Number.isFinite(c) ||
      r < 0 ||
      c < 0 ||
      r >= rowCount ||
      c >= colCount
    ) {
      continue
    }
    if (rs === 1 && cs === 1) continue
    // clamp to grid edges
    const rsClamped = Math.min(rs, rowCount - r)
    const csClamped = Math.min(cs, colCount - c)
    if (rsClamped < 1 || csClamped < 1) continue
    anchors.set(_mkey(r, c), { rs: rsClamped, cs: csClamped })
    for (let dr = 0; dr < rsClamped; dr++) {
      for (let dc = 0; dc < csClamped; dc++) {
        if (dr === 0 && dc === 0) continue
        covered.add(_mkey(r + dr, c + dc))
      }
    }
  }
  return { anchors, covered }
}

/**
 * 두 병합 사각형이 겹치는지.
 */
function _mergesOverlap(a, b) {
  return (
    a.r < b.r + b.rs &&
    b.r < a.r + a.rs &&
    a.c < b.c + b.cs &&
    b.c < a.c + a.cs
  )
}

/**
 * 사용자/AI 입력을 안전한 모양으로 정규화.
 *
 *   1) 정수 + 양수 + grid 범위 내 → 통과
 *   2) 1×1 → drop (의미 없음)
 *   3) 후행 병합이 기존과 겹치면 → 기존을 dissolve (사용자가 다시 누른 의도)
 *   4) (r, c) 오름차순 정렬
 *
 * patch 시점에 한 번 호출해서 content.merges 자리에 넣으면 됨.
 */
export function normalizeMerges(merges, rowCount, colCount) {
  if (!Array.isArray(merges) || merges.length === 0) return []
  const out = []
  for (const raw of merges) {
    if (!raw) continue
    const r = Math.floor(Number(raw.r))
    const c = Math.floor(Number(raw.c))
    const rs = Math.floor(Number(raw.rs ?? 1))
    const cs = Math.floor(Number(raw.cs ?? 1))
    if (!Number.isFinite(r) || !Number.isFinite(c)) continue
    if (r < 0 || c < 0 || r >= rowCount || c >= colCount) continue
    const rsClamped = Math.max(1, Math.min(rs, rowCount - r))
    const csClamped = Math.max(1, Math.min(cs, colCount - c))
    if (rsClamped === 1 && csClamped === 1) continue
    const next = { r, c, rs: rsClamped, cs: csClamped }
    // 겹치는 기존 병합 모두 제거 (last-wins)
    for (let i = out.length - 1; i >= 0; i--) {
      if (_mergesOverlap(out[i], next)) out.splice(i, 1)
    }
    out.push(next)
  }
  out.sort((a, b) => (a.r - b.r) || (a.c - b.c))
  return out
}

/**
 * 행 삽입 / 삭제 시 merges 의 r 축을 재배치.
 *
 *   action: 'insert' | 'remove'
 *   at:     영향 받는 행 인덱스 (insert 면 그 자리에 끼움, remove 면 그 행이 사라짐)
 *
 * 정책:
 *   - insert: r >= at 인 merge 는 r += 1
 *   - remove:
 *       - anchor 가 삭제 행 위쪽에 있고 영역이 그 행을 덮는다 → rs -= 1
 *       - anchor 자체가 삭제 행이면: 영역에 따라 anchor 를 한 행 아래로 이동 + rs-=1,
 *         만약 rs 이미 1이면 그 merge 자체 drop
 *       - anchor 가 삭제 행 아래쪽 → r -= 1
 *
 * 결과는 rowCount 변화 후 grid 에 대해 재정규화 통과한 배열.
 */
export function shiftMergesForRow(merges, action, at, prevRowCount, prevColCount) {
  if (!Array.isArray(merges) || merges.length === 0) return []
  const shifted = []
  for (const m of merges) {
    if (!m) continue
    const r = m.r
    const c = m.c
    const rs = m.rs
    const cs = m.cs
    if (action === 'insert') {
      if (r >= at) {
        shifted.push({ r: r + 1, c, rs, cs })
      } else if (r + rs > at) {
        // 삽입 위치가 영역 한가운데 → 그 행 하나만큼 영역 확장 (= 빈 행이 끼움)
        shifted.push({ r, c, rs: rs + 1, cs })
      } else {
        shifted.push({ r, c, rs, cs })
      }
    } else {
      // remove
      if (r > at) {
        shifted.push({ r: r - 1, c, rs, cs })
      } else if (r === at) {
        // anchor 자체가 사라짐 → 한 행 아래로 anchor 이동
        if (rs > 1) shifted.push({ r, c, rs: rs - 1, cs })
        // else: drop
      } else if (r + rs > at) {
        // anchor 위쪽이고 영역이 삭제 행을 덮음 → rs 줄임
        shifted.push({ r, c, rs: rs - 1, cs })
      } else {
        shifted.push({ r, c, rs, cs })
      }
    }
  }
  const nextRowCount = action === 'insert' ? prevRowCount + 1 : prevRowCount - 1
  return normalizeMerges(shifted, Math.max(0, nextRowCount), prevColCount)
}

// --- useCellSelection 훅 -------------------------------------------- //
//
// 표 / 비교표 의 셀 선택 모델. data-cell-coord="r,c" 가 박혀있는 셀들에
// 대해 마우스 drag / Shift+클릭 / Shift+화살표로 사각형 선택을 만든다.
//
//   { anchor: {r,c}, head: {r,c} } | null
//     anchor = drag 시작 셀 (= 첫 클릭). 변하지 않음.
//     head   = drag 중인 현재 셀. anchor 와 함께 정규화하면 사각형.
//
// data 모델은 의도적으로 widget agnostic — anchor/head 로만 표현하고
// "어떻게 그릴지" / "어떤 셀이 선택됐는지" 는 호출자가 normalizeRange
// helper 로 계산. label-column 같은 위젯 특화 zone 제약도 호출자가
// merge 적용 시 검사.
//
// 사용 패턴:
//   const sel = useCellSelection({ rowCount, colCount, onClear })
//   <div ref={sel.containerRef} onMouseUp={sel.handleMouseUp} ...>
//     <table>
//       {rows.map((_, r) => (
//         <tr>
//           {cols.map((_, c) => (
//             <td
//               data-cell-coord={`${r},${c}`}
//               onMouseDown={(e) => sel.handleMouseDown(e, r, c)}
//               onMouseEnter={() => sel.handleMouseEnter(r, c)}
//               className={sel.isCellSelected(r, c) ? 'ring-2 ring-primary/40' : ''}
//             >...</td>
//           ))}
//         </tr>
//       ))}
//     </table>
//   </div>

/** 두 좌표를 사각형으로 정규화. (r1, c1, r2, c2) 의 minmax. */
export function selectionRect(sel) {
  if (!sel) return null
  const { anchor, head } = sel
  return {
    r1: Math.min(anchor.r, head.r),
    c1: Math.min(anchor.c, head.c),
    r2: Math.max(anchor.r, head.r),
    c2: Math.max(anchor.c, head.c),
  }
}

/** 사각형 영역에 셀이 포함되는지. */
function rectContains(rect, r, c) {
  if (!rect) return false
  return r >= rect.r1 && r <= rect.r2 && c >= rect.c1 && c <= rect.c2
}

export function useCellSelection({ rowCount, colCount, onClear } = {}) {
  const [sel, setSel] = useState(null)
  // 드래그 동안만 true — 셀 안 text 드래그가 셀 경계를 넘어가는 순간
  // promote 해서 multi-cell 선택으로 전환. select-none 클래스 등 UI
  // 신호로도 쓰여서 ref 가 아닌 state.
  const [crossCellDragging, setCrossCellDragging] = useState(false)
  // mousedown 한 셀 좌표 — handleMouseEnter 에서 "다른 셀로 넘어갔는가"
  // 판정에 사용. promote 되거나 mouseup 시점에 null 로 리셋.
  const pendingAnchorRef = useRef(null)
  const draggingRef = useRef(false)

  const containerRef = useRef(null)

  // 바깥 mousedown → 선택 해제. container 자기 자신, 혹은 명시적으로
  // `data-cell-selection-allow` 가 붙어있는 트리 (예: 합치기/분할 액션바)
  // 안의 클릭은 면역 — 액션 바가 selection container 바깥에 살아도
  // outside-handler 가 sel 을 null 로 만들어버려 그 다음 click 에서
  // mergeSelection 이 빈 사각형을 보는 버그 방지.
  useEffect(() => {
    if (!sel) return
    function onDown(e) {
      const root = containerRef.current
      if (root && root.contains(e.target)) return
      if (e.target?.closest?.('[data-cell-selection-allow]')) return
      setSel(null)
      onClear?.()
    }
    function onKey(e) {
      if (e.key === 'Escape') {
        setSel(null)
        onClear?.()
      }
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [sel, onClear])

  // 일반 mousedown 은 preventDefault 안 함 — input 이 그대로 focus 받고
  // 셀 안 텍스트 드래그도 정상. anchor 만 기록해뒀다가 mouse 가 다른 셀로
  // 진입하는 순간 multi-cell 선택으로 promote.
  const handleMouseDown = useCallback((e, r, c) => {
    if (e.button !== 0) return
    draggingRef.current = true
    if (e.shiftKey && sel) {
      // Shift+클릭 — 기존 anchor 에서 확장. 이때는 input focus 가
      // 의미없으니 preventDefault.
      e.preventDefault()
      setSel({ anchor: sel.anchor, head: { r, c } })
      pendingAnchorRef.current = null
      setCrossCellDragging(true)
      return
    }
    pendingAnchorRef.current = { r, c }
    // 새 클릭이 들어오면 이전 multi-cell 선택은 더 이상 의미 없음.
    if (sel) {
      setSel(null)
      onClear?.()
    }
  }, [sel, onClear])

  // promote 공통 처리 — 텍스트 선택 끄고 input 포커스 떼고 sel 세팅.
  const promote = useCallback((anchor, head) => {
    try {
      window.getSelection()?.removeAllRanges()
    } catch {
      /* old browsers — 무시 */
    }
    const ae = document.activeElement
    if (
      ae &&
      (ae.tagName === 'INPUT' ||
        ae.tagName === 'TEXTAREA' ||
        ae.isContentEditable)
    ) {
      ae.blur?.()
    }
    setSel({ anchor, head })
    pendingAnchorRef.current = null
    setCrossCellDragging(true)
  }, [])

  const handleMouseEnter = useCallback((r, c) => {
    if (!draggingRef.current) return
    const pending = pendingAnchorRef.current
    if (pending) {
      // 같은 셀이면 promote 안 함 — input 안에서 드래그 중일 수 있음.
      if (pending.r === r && pending.c === c) return
      // 다른 셀로 진입 — promote 후 head 를 들어온 셀로.
      promote(pending, { r, c })
      return
    }
    // 이미 promote 된 상태 — head 만 늘림.
    setSel((prev) => (prev ? { anchor: prev.anchor, head: { r, c } } : prev))
  }, [promote])

  // 드래그 중 mousedown 한 셀의 경계를 벗어나는 순간 promote — 병합된
  // 큰 셀처럼 cell-area 안에서만 움직여도 enter 가 안 잡히는 경우, 또는
  // 표 바깥으로 드래그아웃 하는 경우를 모두 처리. head 는 일단 anchor
  // 자체 (= 선택 영역에 anchor 셀 하나만 포함). 이후 다른 셀에 mouseenter
  // 하면 그쪽으로 head 가 확장됨.
  const handleMouseLeave = useCallback(
    (r, c) => {
      if (!draggingRef.current) return
      const pending = pendingAnchorRef.current
      if (!pending) return
      // mousedown 한 셀에서 빠져나갈 때만 의미가 있음. 그 외 셀의
      // mouseleave 는 무시 (promote 후의 head 이동은 enter 가 처리).
      if (pending.r !== r || pending.c !== c) return
      promote(pending, pending)
    },
    [promote],
  )

  const handleMouseUp = useCallback(() => {
    draggingRef.current = false
    pendingAnchorRef.current = null
    setCrossCellDragging(false)
  }, [])

  // 사용자가 mousedown 후 container 바깥으로 마우스를 빼고 떼면 위
  // onMouseUp 이 안 잡힘 → 글로벌로도 한 번. drag 중에만 등록해 비용 ↓.
  useEffect(() => {
    if (!draggingRef.current) return
    const onUp = () => {
      draggingRef.current = false
      pendingAnchorRef.current = null
      setCrossCellDragging(false)
    }
    window.addEventListener('mouseup', onUp)
    return () => window.removeEventListener('mouseup', onUp)
  }, [sel])

  // Shift+화살표 키로 head 확장.
  const handleKeyExpand = useCallback(
    (e) => {
      if (!sel) return false
      if (!e.shiftKey) return false
      let dr = 0
      let dc = 0
      if (e.key === 'ArrowUp') dr = -1
      else if (e.key === 'ArrowDown') dr = 1
      else if (e.key === 'ArrowLeft') dc = -1
      else if (e.key === 'ArrowRight') dc = 1
      else return false
      const nr = Math.max(0, Math.min((rowCount ?? 1) - 1, sel.head.r + dr))
      const nc = Math.max(0, Math.min((colCount ?? 1) - 1, sel.head.c + dc))
      setSel({ anchor: sel.anchor, head: { r: nr, c: nc } })
      e.preventDefault()
      return true
    },
    [sel, rowCount, colCount],
  )

  const isCellSelected = useCallback(
    (r, c) => rectContains(selectionRect(sel), r, c),
    [sel],
  )

  const clear = useCallback(() => {
    setSel(null)
    onClear?.()
  }, [onClear])

  return {
    sel,
    setSel,
    containerRef,
    handleMouseDown,
    handleMouseEnter,
    handleMouseLeave,
    handleMouseUp,
    handleKeyExpand,
    isCellSelected,
    clear,
    rect: selectionRect(sel),
    // 셀 경계를 넘긴 promote 가 일어난 시점부터 mouseup 까지만 true —
    // 위젯 wrapper 가 select-none / cursor-cell 을 켜는 신호로 사용.
    crossCellDragging,
  }
}

/**
 * 열 삽입 / 삭제 — shiftMergesForRow 와 같은 패턴의 c 축 버전.
 */
export function shiftMergesForCol(merges, action, at, prevRowCount, prevColCount) {
  if (!Array.isArray(merges) || merges.length === 0) return []
  const shifted = []
  for (const m of merges) {
    if (!m) continue
    const r = m.r
    const c = m.c
    const rs = m.rs
    const cs = m.cs
    if (action === 'insert') {
      if (c >= at) {
        shifted.push({ r, c: c + 1, rs, cs })
      } else if (c + cs > at) {
        shifted.push({ r, c, rs, cs: cs + 1 })
      } else {
        shifted.push({ r, c, rs, cs })
      }
    } else {
      if (c > at) {
        shifted.push({ r, c: c - 1, rs, cs })
      } else if (c === at) {
        if (cs > 1) shifted.push({ r, c, rs, cs: cs - 1 })
      } else if (c + cs > at) {
        shifted.push({ r, c, rs, cs: cs - 1 })
      } else {
        shifted.push({ r, c, rs, cs })
      }
    }
  }
  const nextColCount = action === 'insert' ? prevColCount + 1 : prevColCount - 1
  return normalizeMerges(shifted, prevRowCount, Math.max(0, nextColCount))
}
