import { ChevronDown, ChevronUp, Plus, X } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'

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
            <div className="col-span-4">
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

/**
 * Shared block-level caption input used by every non-heading widget's
 * Editor. Renders inline as a heading-styled text field. When empty, the
 * placeholder shows the template's intended label as a hint; when set,
 * the caption replaces the block's external `<h2>` title in the report.
 *
 * When `readOnly` is true:
 *   - empty value → renders nothing (no placeholder leakage in view mode)
 *   - non-empty value → renders as static styled text
 */
export function CaptionInput({ value, onChange, placeholder, readOnly }) {
  if (readOnly) {
    if (!value) return null
    return (
      <div className="text-base font-semibold px-2 py-1">{value}</div>
    )
  }
  return (
    <input
      type="text"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder || '제목 (선택)'}
      className="w-full bg-transparent border-0 outline-none focus:ring-0 placeholder:text-muted-foreground/50 text-base font-semibold px-2 py-1"
    />
  )
}
