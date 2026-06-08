import { useMemo } from 'react'
import { ChevronDown, ChevronUp, Plus, X } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import {
  CaptionInput,
  DEFAULT_BODY_FONT_PX,
  EditorOptionBar,
  EditorOptionNumber,
  EditorOptionText,
  LabelField,
  PreviewLabel,
  TextStyleField,
  captionSkipProps,
  effectiveNumber,
  effectiveString,
  pruneOverrideKeys,
  textStyleToClassName,
  textStyleToInlineStyle,
} from './_shared'

// --------------------------------------------------------------------------- //
// Color mapping
// --------------------------------------------------------------------------- //
// Ratio buckets (value / max) → bar fill + track tint. Higher is better:
// red below 30%, amber 30–70%, green at or above 70%. ≥100% gets the
// emerald-dark "over goal" tone so over-delivery is visible at a glance.
// `status`, when the writer sets it explicitly, overrides the automatic
// color so e.g. a stuck task can stay red even at 100% of its (revised)
// scope.
const STATUS_COLORS = {
  pending: { bar: '#94a3b8', track: '#94a3b822' }, // slate-400
  in_progress: { bar: '#3b82f6', track: '#3b82f622' }, // blue-500
  done: { bar: '#10b981', track: '#10b98122' }, // emerald-500
  blocked: { bar: '#ef4444', track: '#ef444422' }, // red-500
}
function colorForRatio(ratio) {
  if (!Number.isFinite(ratio)) return { bar: '#94a3b8', track: '#94a3b822' }
  if (ratio >= 1) return { bar: '#059669', track: '#10b98122' } // over goal — emerald-600
  if (ratio >= 0.7) return { bar: '#10b981', track: '#10b98122' } // emerald-500
  if (ratio >= 0.3) return { bar: '#f59e0b', track: '#f59e0b22' } // amber-500
  return { bar: '#ef4444', track: '#ef444422' } // red-500
}

const STATUS_OPTIONS = [
  { value: '', label: '(자동)' },
  { value: 'pending', label: '예정' },
  { value: 'in_progress', label: '진행중' },
  { value: 'done', label: '완료' },
  { value: 'blocked', label: '중단' },
]

// --------------------------------------------------------------------------- //
// PropsPanel — template-time configuration
// --------------------------------------------------------------------------- //
export function ProgressBarPropsPanel({ props, onChange }) {
  function patch(next) {
    onChange({ ...props, ...next })
  }
  return (
    <div className="space-y-4">
      <LabelField
        label="라벨"
        value={props.label}
        onChange={(v) => patch({ label: v })}
        placeholder="프로젝트 진척도"
      />
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-xs">기본 목표값</Label>
          <Input
            type="number"
            min={1}
            value={props.default_max ?? 100}
            onChange={(e) =>
              patch({
                default_max:
                  e.target.value === '' ? undefined : Number(e.target.value),
              })
            }
            className="mt-1 h-9"
          />
        </div>
        <div>
          <Label className="text-xs">단위</Label>
          <Input
            value={props.unit ?? ''}
            onChange={(e) => patch({ unit: e.target.value })}
            placeholder="%"
            maxLength={8}
            className="mt-1 h-9"
          />
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground -mt-2">
        보고서에서 항목별로 <strong>현재값/목표값</strong>을 입력하면 막대가 자동 그려집니다.
        목표값 비워두면 위 기본값(보통 100)을 사용합니다.
      </p>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-xs">최소 항목 수</Label>
          <Input
            type="number"
            min={0}
            value={props.min_items ?? ''}
            onChange={(e) =>
              patch({
                min_items:
                  e.target.value === '' ? undefined : Number(e.target.value),
              })
            }
            className="mt-1 h-9"
          />
        </div>
        <div>
          <Label className="text-xs">최대 항목 수</Label>
          <Input
            type="number"
            min={1}
            value={props.max_items ?? ''}
            onChange={(e) =>
              patch({
                max_items:
                  e.target.value === '' ? undefined : Number(e.target.value),
              })
            }
            className="mt-1 h-9"
          />
        </div>
      </div>
      <p className="text-[10px] text-muted-foreground">
        막대 색상은 진척률에 따라 자동: 30% 미만 빨강, 30–70% 주황, 70–99% 초록,
        100% 이상 진초록. 항목별 상태(예정/진행중/완료/중단)를 직접 지정하면
        해당 상태 색상이 우선합니다.
      </p>
      <TextStyleField
        value={props.text_style}
        onChange={(text_style) => patch({ text_style })}
        defaultSizePx={DEFAULT_BODY_FONT_PX}
      />
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Preview — sample bars for the template canvas
// --------------------------------------------------------------------------- //
export function ProgressBarPreview({ props }) {
  return (
    <div className="space-y-2">
      <PreviewLabel>{props.label || '(라벨 없음)'}</PreviewLabel>
      <div className="rounded-md border border-dashed bg-muted/20 px-3 py-3 space-y-2">
        <ProgressRow item={{ label: '작업 A', value: 92 }} unit={props.unit ?? '%'} />
        <ProgressRow item={{ label: '작업 B', value: 55 }} unit={props.unit ?? '%'} />
        <ProgressRow item={{ label: '작업 C', value: 18 }} unit={props.unit ?? '%'} />
      </div>
      <p className="text-[10px] text-muted-foreground italic">
        보고서에서 작업·항목을 추가하면 막대가 그려집니다.
      </p>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Shared row renderer used by Preview + read-only view + edit mode preview
// --------------------------------------------------------------------------- //
function ProgressRow({ item, unit, textClass = '', textStyle }) {
  const max = Number.isFinite(item?.max) && item.max > 0 ? item.max : 100
  const value = Number.isFinite(item?.value) ? Math.max(0, item.value) : 0
  const ratio = value / max
  const fillPct = Math.max(0, Math.min(1, ratio)) * 100
  const explicit = item?.status ? STATUS_COLORS[item.status] : null
  const auto = colorForRatio(ratio)
  const colors = explicit ?? auto
  const display = `${formatNum(value)}${unit ? unit : ''}${
    max !== 100 || unit !== '%' ? ` / ${formatNum(max)}${unit ?? ''}` : ''
  }`
  return (
    <div className={`text-sm ${textClass}`} style={textStyle}>
      <div className="flex items-baseline justify-between gap-2 mb-0.5">
        <span className="truncate font-medium">{item?.label ?? ''}</span>
        {/* 값은 라벨과 같은 본문 크기를 상속(예전 text-xs=12px 고정 제거) —
            속성 텍스트 크기가 wrapper(textStyle)를 통해 반영된다. */}
        <span className="text-muted-foreground tabular-nums shrink-0">
          {display}
        </span>
      </div>
      <div
        className="relative h-2 rounded-full overflow-hidden"
        style={{ backgroundColor: colors.track }}
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full transition-[width]"
          style={{ width: `${fillPct}%`, backgroundColor: colors.bar }}
        />
      </div>
      {item?.note && (
        // 노트는 본문의 0.85배(상대) — 속성 텍스트 크기에 비례해 함께 커진다.
        <div className="mt-1 text-[0.85em] text-muted-foreground">{item.note}</div>
      )}
    </div>
  )
}

function formatNum(n) {
  if (!Number.isFinite(n)) return ''
  // Trim trailing .0 for whole numbers but keep up to 2 fraction digits.
  return Number.isInteger(n) ? String(n) : Number(n.toFixed(2)).toString()
}

// --------------------------------------------------------------------------- //
// Editor — caption + visible bar list + data-entry table
// --------------------------------------------------------------------------- //
export function ProgressBarEditor({ props, content, onChange, readOnly }) {
  const caption = content?.caption ?? ''
  const items = Array.isArray(content?.items) ? content.items : []
  const textClass = textStyleToClassName(props.text_style)
  const textStyle = textStyleToInlineStyle(props.text_style)
  // Per-report overrides — content wins over props.
  const unit = effectiveString(content, props, 'unit', '%')
  const defaultMax = effectiveNumber(content, props, 'default_max', 100)
  const maxItems = Number.isFinite(props.max_items) ? props.max_items : null

  function patch(next) {
    const merged = {
      ...(content ?? {}),
      ...(caption ? { caption } : {}),
      items,
      ...next,
    }
    if (!merged.caption) delete merged.caption
    if (!merged.items || merged.items.length === 0) delete merged.items
    if (!merged.caption_skip_autofill) delete merged.caption_skip_autofill
    pruneOverrideKeys(merged, props, {
      default_max: 100,
      unit: '%',
    })
    onChange(merged)
  }

  function addItem() {
    if (maxItems != null && items.length >= maxItems) return
    patch({ items: [...items, { label: '', value: 0 }] })
  }
  function updateItem(idx, p) {
    patch({ items: items.map((it, i) => (i === idx ? { ...it, ...p } : it)) })
  }
  function removeItem(idx) {
    patch({ items: items.filter((_, i) => i !== idx) })
  }
  function moveItem(idx, dir) {
    const newIdx = idx + dir
    if (newIdx < 0 || newIdx >= items.length) return
    const next = [...items]
    const [m] = next.splice(idx, 1)
    next.splice(newIdx, 0, m)
    patch({ items: next })
  }

  // Hydrate each item with the template's default_max so the preview
  // shows accurate ratios when the writer hasn't overridden max per row.
  const hydratedItems = useMemo(
    () =>
      items.map((it) => ({
        ...it,
        max: Number.isFinite(it?.max) && it.max > 0 ? it.max : defaultMax,
      })),
    [items, defaultMax],
  )

  if (readOnly) {
    if (!caption && items.length === 0) return null
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
        {items.length > 0 ? (
          <div className="space-y-2">
            {hydratedItems.map((it, i) => (
              <ProgressRow
                key={i}
                item={it}
                unit={unit}
                textClass={textClass}
                textStyle={textStyle}
              />
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground italic">(항목 없음)</p>
        )}
      </div>
    )
  }

  return (
    <div className={`space-y-3 ${textClass}`} style={textStyle}>
      <CaptionInput
        value={caption}
        onChange={(v) => patch({ caption: v })}
        placeholder={props.label}
        {...captionSkipProps({ content, patch })}
      />
      <EditorOptionBar>
        <EditorOptionNumber
          label="기본 목표값"
          value={defaultMax}
          min={1}
          onChange={(v) => patch({ default_max: v })}
          hint="항목별 max를 비워두면 이 값이 100% 기준이 됩니다."
        />
        <EditorOptionText
          label="단위"
          value={unit}
          onChange={(v) => patch({ unit: v })}
          maxLength={8}
          placeholder="%"
          width="w-14"
          hint="값/목표 표시에 붙는 접미사 (예: %, 건, h)"
        />
      </EditorOptionBar>
      {/* Live preview — same renderer as view mode so the writer sees
          the final layout while typing. */}
      {hydratedItems.length > 0 && (
        <div className="space-y-2 rounded-md border bg-muted/10 px-3 py-3">
          {hydratedItems.map((it, i) => (
            <ProgressRow
              key={i}
              item={it}
              unit={unit}
              textClass={textClass}
              textStyle={textStyle}
            />
          ))}
        </div>
      )}
      {/* Data-entry table — label / value / (optional) max + status */}
      <div className="rounded-md border overflow-hidden">
        {items.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs text-muted-foreground italic">
            아직 항목이 없습니다. "항목 추가"로 작업을 추가하세요.
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-muted/40">
              <tr>
                <th className="px-2 py-1.5 text-left font-medium text-muted-foreground w-10">
                  순서
                </th>
                <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">
                  항목
                </th>
                <th className="px-2 py-1.5 text-right font-medium text-muted-foreground w-24">
                  현재값
                </th>
                <th className="px-2 py-1.5 text-right font-medium text-muted-foreground w-24">
                  목표값
                </th>
                <th className="px-2 py-1.5 text-left font-medium text-muted-foreground w-28">
                  상태
                </th>
                <th className="w-16" />
              </tr>
            </thead>
            <tbody>
              {items.map((it, idx) => (
                <tr key={idx} className="border-t group">
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-0.5">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-5 w-5"
                        onClick={() => moveItem(idx, -1)}
                        disabled={idx === 0}
                        title="위로"
                      >
                        <ChevronUp className="h-3 w-3" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-5 w-5"
                        onClick={() => moveItem(idx, 1)}
                        disabled={idx === items.length - 1}
                        title="아래로"
                      >
                        <ChevronDown className="h-3 w-3" />
                      </Button>
                    </div>
                  </td>
                  <td className="px-2 py-1.5">
                    <Input
                      value={it?.label ?? ''}
                      onChange={(e) => updateItem(idx, { label: e.target.value })}
                      placeholder="작업 이름"
                      className="h-8 text-xs"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <Input
                      type="number"
                      min={0}
                      step="any"
                      value={it?.value ?? ''}
                      onChange={(e) =>
                        updateItem(idx, {
                          value:
                            e.target.value === ''
                              ? 0
                              : Number(e.target.value),
                        })
                      }
                      className="h-8 text-xs text-right tabular-nums"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <Input
                      type="number"
                      min={0}
                      step="any"
                      value={it?.max ?? ''}
                      onChange={(e) => {
                        const v = e.target.value
                        if (v === '') {
                          // Empty → clear the override so the row falls
                          // back to the template's default_max.
                          const { max: _drop, ...rest } = it ?? {}
                          updateItem(idx, rest)
                          return
                        }
                        updateItem(idx, { max: Number(v) })
                      }}
                      placeholder={String(defaultMax)}
                      className="h-8 text-xs text-right tabular-nums"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <select
                      value={it?.status ?? ''}
                      onChange={(e) => {
                        const v = e.target.value
                        if (v === '') {
                          const { status: _drop, ...rest } = it ?? {}
                          updateItem(idx, rest)
                        } else {
                          updateItem(idx, { status: v })
                        }
                      }}
                      className="h-8 w-full rounded-md border border-input bg-background px-1 text-xs"
                    >
                      {STATUS_OPTIONS.map((o) => (
                        <option key={o.value || 'auto'} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 text-destructive opacity-0 group-hover:opacity-100"
                      onClick={() => removeItem(idx)}
                      title="삭제"
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="flex items-center justify-between">
        <Button
          size="sm"
          variant="outline"
          onClick={addItem}
          disabled={maxItems != null && items.length >= maxItems}
        >
          <Plus className="mr-1 h-3.5 w-3.5" />
          항목 추가
        </Button>
        <span className="text-[10px] text-muted-foreground">
          {items.length}개
          {maxItems != null ? ` / 최대 ${maxItems}개` : ''}
        </span>
      </div>
    </div>
  )
}
