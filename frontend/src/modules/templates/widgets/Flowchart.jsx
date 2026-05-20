import { ChevronDown, ChevronRight, ChevronUp, Plus, X } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { CaptionInput, DEFAULT_BODY_FONT_PX, LabelField, PreviewLabel, TextStyleField, captionSkipProps, textStyleToClassName, textStyleToInlineStyle } from './_shared'

// --------------------------------------------------------------------------- //
// Visual palette                                                              //
// --------------------------------------------------------------------------- //
// Hand-picked gradient that walks blue → cyan → green → amber → red. Each
// step in the flowchart picks the next color, looping after the last
// stop. This mirrors the SmartArt "Process" feel without dragging in a
// design system token file.
const PALETTE = [
  '#2563eb', // blue-600
  '#0891b2', // cyan-600
  '#059669', // emerald-600
  '#65a30d', // lime-600
  '#ca8a04', // yellow-600
  '#ea580c', // orange-600
  '#dc2626', // red-600
  '#c026d3', // fuchsia-600
  '#7c3aed', // violet-600
]
function colorFor(index) {
  return PALETTE[index % PALETTE.length]
}

const ORIENTATIONS = [
  { value: 'horizontal', label: '가로 (→)' },
  { value: 'vertical', label: '세로 (↓)' },
]

// --------------------------------------------------------------------------- //
// PropsPanel
// --------------------------------------------------------------------------- //
export function FlowchartPropsPanel({ props, onChange }) {
  function patch(next) {
    onChange({ ...props, ...next })
  }
  const orientation = props.orientation ?? 'horizontal'
  return (
    <div className="space-y-4">
      <LabelField
        label="라벨"
        value={props.label}
        onChange={(v) => patch({ label: v })}
        placeholder="처리 절차"
      />
      <div>
        <Label className="text-xs">방향</Label>
        <div className="mt-1 flex gap-1">
          {ORIENTATIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => patch({ orientation: o.value })}
              className={`flex-1 h-9 rounded-md border text-sm transition-colors ${
                orientation === o.value
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'border-input hover:bg-accent'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
        <p className="mt-1 text-[10px] text-muted-foreground">
          노드를 연결하는 화살표 방향. 보고서에서도 변경 가능.
        </p>
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
// Preview
// --------------------------------------------------------------------------- //
export function FlowchartPreview({ props }) {
  const orientation = props.orientation ?? 'horizontal'
  return (
    <div className="space-y-2">
      <PreviewLabel hint={orientation === 'vertical' ? '세로' : '가로'}>
        {props.label || '(라벨 없음)'}
      </PreviewLabel>
      <div className="rounded-md border border-dashed bg-muted/20 px-3 py-4">
        <FlowchartCanvas items={SAMPLE_ITEMS} orientation={orientation} />
      </div>
      <p className="text-[10px] text-muted-foreground italic">
        보고서에서 단계를 추가하면 자동으로 연결됩니다.
      </p>
    </div>
  )
}
const SAMPLE_ITEMS = [
  { label: '요청 접수', description: '담당자가 인입 채널 확인' },
  { label: '검토', description: '필요 자료 확인' },
  { label: '실행' },
  { label: '완료' },
]

// --------------------------------------------------------------------------- //
// Editor
// --------------------------------------------------------------------------- //
export function FlowchartEditor({ props, content, onChange, readOnly }) {
  const caption = content?.caption ?? ''
  const items = Array.isArray(content?.items) ? content.items : []
  const orientation =
    content?.orientation ?? props.orientation ?? 'horizontal'
  const textClass = textStyleToClassName(props.text_style)
  const textStyle = textStyleToInlineStyle(props.text_style)

  function patch(next) {
    const merged = {
      ...(content ?? {}),
      ...(caption ? { caption } : {}),
      ...(content?.orientation ? { orientation: content.orientation } : {}),
      items,
      ...next,
    }
    if (!merged.caption) delete merged.caption
    if (!merged.orientation) delete merged.orientation
    if (!merged.items || merged.items.length === 0) delete merged.items
    if (!merged.caption_skip_autofill) delete merged.caption_skip_autofill
    onChange(merged)
  }

  function addItem() {
    patch({ items: [...items, { label: '' }] })
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
  function setOrientation(value) {
    patch({ orientation: value })
  }

  if (readOnly) {
    if (!caption && items.length === 0) return null
    return (
      <div className={`space-y-2 ${textClass}`} style={textStyle}>
        <CaptionInput value={caption} readOnly />
        {items.length > 0 ? (
          <FlowchartCanvas items={items} orientation={orientation} />
        ) : (
          <p className="text-xs text-muted-foreground italic">
            (순서도 항목 없음)
          </p>
        )}
      </div>
    )
  }

  return (
    <div className={`space-y-3 ${textClass}`} style={textStyle}>
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <CaptionInput
            value={caption}
            onChange={(v) => patch({ caption: v })}
            placeholder={props.label}
            {...captionSkipProps({ content, patch })}
          />
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          {ORIENTATIONS.map((o) => (
            <Button
              key={o.value}
              type="button"
              variant={orientation === o.value ? 'default' : 'ghost'}
              size="sm"
              className="h-7 text-[11px] px-2"
              onClick={() => setOrientation(o.value)}
              title={o.label}
            >
              {o.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="rounded-md border bg-card px-3 py-4">
        {items.length > 0 ? (
          <FlowchartCanvas items={items} orientation={orientation} />
        ) : (
          <div className="text-center text-xs text-muted-foreground italic py-6">
            단계를 추가하면 순서도가 그려집니다.
          </div>
        )}
      </div>

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-xs">
          <thead className="bg-muted/40">
            <tr>
              <th className="px-2 py-1.5 text-left font-medium text-muted-foreground w-12">
                #
              </th>
              <th className="px-2 py-1.5 text-left font-medium text-muted-foreground w-48">
                항목명
              </th>
              <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">
                상세 내용 (선택)
              </th>
              <th className="w-24 border-b" />
            </tr>
          </thead>
          <tbody>
            {items.map((it, idx) => (
              <tr key={idx} className="border-b last:border-b-0">
                <td className="px-2 py-1">
                  <span
                    className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold text-white"
                    style={{ backgroundColor: colorFor(idx) }}
                  >
                    {idx + 1}
                  </span>
                </td>
                <td className="px-1 py-1">
                  <Input
                    value={it.label ?? ''}
                    onChange={(e) => updateItem(idx, { label: e.target.value })}
                    placeholder="항목명"
                    className="h-8 text-xs"
                  />
                </td>
                <td className="px-1 py-1">
                  <Input
                    value={it.description ?? ''}
                    onChange={(e) =>
                      updateItem(idx, {
                        description: e.target.value || undefined,
                      })
                    }
                    placeholder="상세 내용 (선택)"
                    className="h-8 text-xs"
                  />
                </td>
                <td className="px-1 py-1">
                  <div className="flex items-center justify-end gap-0.5">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => moveItem(idx, -1)}
                      disabled={idx === 0}
                    >
                      <ChevronUp className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => moveItem(idx, 1)}
                      disabled={idx === items.length - 1}
                    >
                      <ChevronDown className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive"
                      onClick={() => removeItem(idx)}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td
                  colSpan={4}
                  className="px-2 py-3 text-center text-xs text-muted-foreground italic"
                >
                  아직 항목이 없습니다.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Button variant="outline" size="sm" onClick={addItem}>
        <Plus className="mr-1 h-3 w-3" />
        단계 추가
      </Button>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Canvas — PPT-style step blocks centered and connected with arrows
// --------------------------------------------------------------------------- //
function FlowchartCanvas({ items, orientation }) {
  const isHorizontal = orientation !== 'vertical'
  // Horizontal: equal-width steps stretch to fill the row so the
  // whole flow uses the available width (no big gutters on the
  // sides). When labels are too long to keep everything on one line,
  // `flex-wrap` lets the steps overflow onto a second row.
  // Vertical: each step is a full-width card stacked under the
  // previous one with no horizontal max-width — letting auto-fit
  // grow the cell as needed.
  const outerClass = isHorizontal
    ? 'flex flex-wrap items-stretch justify-center gap-1.5 w-full'
    : 'flex flex-col items-stretch gap-2 w-full'
  const Arrow = isHorizontal ? ChevronRight : ChevronDown
  return (
    <div className={outerClass}>
      {items.map((it, idx) => (
        <div
          key={idx}
          className={
            isHorizontal
              ? // Each step + (optional) arrow occupies an equal slice
                // of the row; `flex-1 basis-0 min-w-[10rem]` makes
                // them all the same width and grow to fill.
                'flex items-stretch gap-1 flex-1 basis-0 min-w-[10rem]'
              : 'flex flex-col items-stretch gap-1'
          }
        >
          <FlowStep
            index={idx}
            color={colorFor(idx)}
            label={it.label}
            description={it.description}
            orientation={orientation}
          />
          {idx < items.length - 1 && (
            <div
              className={
                isHorizontal
                  ? 'flex items-center text-muted-foreground/80 shrink-0'
                  : 'flex justify-center text-muted-foreground/80'
              }
            >
              <Arrow size={isHorizontal ? 28 : 26} strokeWidth={2.5} />
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

/** A single PPT-style step block: solid-color rounded rectangle, a small
 *  numbered chip in the corner, label centered prominently, optional
 *  description below in a smaller readable color. Sized generously so
 *  the diagram reads at presentation scale; auto-fit will tall the cell
 *  height to match. */
function FlowStep({ index, color, label, description, orientation }) {
  const isHorizontal = orientation !== 'vertical'
  return (
    <div
      className={`relative flex flex-col items-center justify-center text-center rounded-lg shadow-sm ${
        isHorizontal
          ? // Horizontal step takes its slice's full width and grows
            // tall enough for the description to fit.
            'flex-1 min-w-0 px-4 py-6 min-h-[5rem]'
          : 'w-full px-5 py-5 min-h-[4.5rem]'
      }`}
      style={{
        backgroundColor: color,
        color: '#fff',
      }}
    >
      {/* Step number chip — sits in the top-left corner without
          taking flow space. */}
      <span
        className="absolute top-1.5 left-2 inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full px-1.5 text-[11px] font-bold leading-none"
        style={{
          backgroundColor: 'rgba(255,255,255,0.25)',
          color: '#fff',
        }}
      >
        {index + 1}
      </span>
      <div
        className="text-base font-semibold leading-snug"
        style={{ wordBreak: 'keep-all', overflowWrap: 'anywhere' }}
        title={label}
      >
        {label || '(이름 없음)'}
      </div>
      {description && (
        <div
          className="mt-1.5 text-xs leading-snug opacity-95"
          style={{ wordBreak: 'keep-all', overflowWrap: 'anywhere' }}
        >
          {description}
        </div>
      )}
    </div>
  )
}
