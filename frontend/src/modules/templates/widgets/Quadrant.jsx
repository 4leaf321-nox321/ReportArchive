/**
 * Quadrant / 2x2 Matrix widget.
 *
 * Two complementary modes share a single widget type so a writer who
 * wants a SWOT-style bucket of texts and one who wants a BCG-style
 * positioned scatter use the same building block:
 *
 *   bucket — 4 corner cells, each an unordered list of text items.
 *            Drag items between cells.  Used for SWOT, Eisenhower,
 *            generic 2x2 comparisons.
 *   plot   — continuous x/y plane with the 4 quadrants drawn beneath.
 *            Items are dots at specific coordinates, optionally sized
 *            by `size`.  Used for BCG, Risk, impact×effort.
 *
 * All visual config (preset, mode, quadrant labels, colors, axis
 * labels, plot options) is editable inline in the report editor via
 * `onChangePropsOverride` — that mirrors Chart.jsx so writers don't
 * have to bounce between the right-side template props panel and the
 * widget body to tune the matrix.  The PropsPanel itself is
 * intentionally minimal (just the widget label and the seed preset);
 * everything else lives in the editor's right config column.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { GripVertical, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '@/shared/components/ui/popover'
import { cn } from '@/shared/lib/utils'
import {
  CaptionInput,
  LabelField,
  PreviewLabel,
  captionSkipProps,
  textStyleToClassName,
  textStyleToInlineStyle,
} from './_shared'

// --------------------------------------------------------------------------- //
// Constants — quadrant keys, modes, presets                                   //
// --------------------------------------------------------------------------- //
const QUADRANT_KEYS = ['tl', 'tr', 'bl', 'br']
const QUADRANT_POSITION_LABEL = {
  tl: '↖ 좌상',
  tr: '↗ 우상',
  bl: '↙ 좌하',
  br: '↘ 우하',
}

const MODE_OPTIONS = [
  { value: 'bucket', label: '버킷' },
  { value: 'plot', label: '좌표' },
]

const PRESET_OPTIONS = [
  { value: 'swot', label: 'SWOT' },
  { value: 'bcg', label: 'BCG' },
  { value: 'eisenhower', label: '아이젠하워' },
  { value: 'risk', label: 'Risk' },
  { value: 'custom', label: '커스텀' },
]

// Every props field that the editor exposes inline.  Sent as a full
// snapshot through `onChangePropsOverride` because the dialog treats
// the override as a REPLACE — partial patches would silently reset
// fields the writer hadn't touched on this call.  Mirrors Chart's
// STRUCTURAL_KEYS contract.
const STRUCTURAL_KEYS = [
  'default_mode',
  'preset',
  'x_axis_title',
  'y_axis_title',
  'x_low_label',
  'x_high_label',
  'y_low_label',
  'y_high_label',
  'quadrant_labels',
  'quadrant_colors',
  'show_grid_lines',
  'show_axis_arrows',
  'x_range',
  'y_range',
  'show_bubble_size',
]

// Preset → full seed for props.  Picking a preset rewrites every
// field in one shot so a partially-customized template resets cleanly.
// `custom` never seeds.
const PRESETS = {
  swot: {
    default_mode: 'bucket',
    x_axis_title: '',
    y_axis_title: '',
    x_low_label: '내부',
    x_high_label: '외부',
    y_low_label: '부정',
    y_high_label: '긍정',
    quadrant_labels: {
      tl: '강점 (Strengths)',
      tr: '기회 (Opportunities)',
      bl: '약점 (Weaknesses)',
      br: '위협 (Threats)',
    },
    quadrant_colors: {
      tl: '#dbeafe',
      tr: '#dcfce7',
      bl: '#fef3c7',
      br: '#fee2e2',
    },
    show_grid_lines: true,
    show_axis_arrows: true,
    show_bubble_size: false,
    x_range: [0, 100],
    y_range: [0, 100],
  },
  eisenhower: {
    default_mode: 'bucket',
    x_axis_title: '',
    y_axis_title: '',
    x_low_label: '여유',
    x_high_label: '긴급',
    y_low_label: '덜 중요',
    y_high_label: '중요',
    quadrant_labels: {
      tl: '계획 (Important · Not Urgent)',
      tr: '지금 (Important · Urgent)',
      bl: '제거 (Not Important · Not Urgent)',
      br: '위임 (Not Important · Urgent)',
    },
    quadrant_colors: {
      tl: '#dbeafe',
      tr: '#fee2e2',
      bl: '#e5e7eb',
      br: '#fef3c7',
    },
    show_grid_lines: true,
    show_axis_arrows: true,
    show_bubble_size: false,
    x_range: [0, 100],
    y_range: [0, 100],
  },
  bcg: {
    default_mode: 'plot',
    x_axis_title: '시장 점유율 (상대)',
    y_axis_title: '시장 성장률',
    x_low_label: '낮음',
    x_high_label: '높음',
    y_low_label: '낮음',
    y_high_label: '높음',
    quadrant_labels: {
      tl: '물음표 (Question Mark)',
      tr: '스타 (Star)',
      bl: '개 (Dog)',
      br: '캐시카우 (Cash Cow)',
    },
    quadrant_colors: {
      tl: '#fef3c7',
      tr: '#dcfce7',
      bl: '#e5e7eb',
      br: '#dbeafe',
    },
    show_grid_lines: true,
    show_axis_arrows: true,
    show_bubble_size: true,
    x_range: [0, 100],
    y_range: [0, 100],
  },
  risk: {
    default_mode: 'plot',
    x_axis_title: '발생 확률',
    y_axis_title: '영향도',
    x_low_label: '낮음',
    x_high_label: '높음',
    y_low_label: '낮음',
    y_high_label: '높음',
    quadrant_labels: {
      tl: '주의',
      tr: '심각',
      bl: '낮음',
      br: '관찰',
    },
    quadrant_colors: {
      tl: '#fed7aa',
      tr: '#fecaca',
      bl: '#dcfce7',
      br: '#fef9c3',
    },
    show_grid_lines: true,
    show_axis_arrows: true,
    show_bubble_size: false,
    x_range: [0, 100],
    y_range: [0, 100],
  },
}

const DEFAULT_BUBBLE_SIZE = 4

// --------------------------------------------------------------------------- //
// Effective-value helpers                                                     //
// --------------------------------------------------------------------------- //
function effectiveMode(content, props) {
  const fromContent = content?.mode
  if (fromContent === 'bucket' || fromContent === 'plot') return fromContent
  const fromProps = props?.default_mode
  if (fromProps === 'bucket' || fromProps === 'plot') return fromProps
  return 'bucket'
}

function effectiveQuadrantLabels(props) {
  const explicit = props?.quadrant_labels ?? {}
  return {
    tl: explicit.tl ?? '',
    tr: explicit.tr ?? '',
    bl: explicit.bl ?? '',
    br: explicit.br ?? '',
  }
}

function effectiveQuadrantColors(props) {
  const explicit = props?.quadrant_colors ?? {}
  return {
    tl: explicit.tl ?? '#f1f5f9',
    tr: explicit.tr ?? '#f1f5f9',
    bl: explicit.bl ?? '#f1f5f9',
    br: explicit.br ?? '#f1f5f9',
  }
}

function effectiveRange(props, axis) {
  const r = props?.[axis === 'x' ? 'x_range' : 'y_range']
  if (Array.isArray(r) && r.length === 2 && Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[0] < r[1]) {
    return [r[0], r[1]]
  }
  return [0, 100]
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

function clamp01(v) {
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}

// --------------------------------------------------------------------------- //
// PropsPanel — template-only fields                                           //
//                                                                              //
// Slimmed down vs. the original — everything visual (preset / mode /          //
// labels / colors / axes) moved into the editor itself so writers can         //
// tune the matrix without bouncing to the right-side template panel.          //
// What stays here is the truly template-level seed: the widget label          //
// (heading) + the initial preset for new reports.                             //
// --------------------------------------------------------------------------- //
export function QuadrantPropsPanel({ props, onChange }) {
  const preset = props.preset ?? 'custom'

  function patch(next) {
    onChange({ ...props, ...next })
  }

  function applyPreset(nextPreset) {
    if (nextPreset === 'custom') {
      patch({ preset: 'custom' })
      return
    }
    const seed = PRESETS[nextPreset]
    if (!seed) return
    patch({ preset: nextPreset, ...seed })
  }

  return (
    <div className="space-y-4">
      <LabelField
        label="라벨"
        value={props.label}
        onChange={(v) => patch({ label: v })}
        placeholder="2x2 매트릭스"
      />

      <div>
        <Label className="text-xs">시드 프리셋</Label>
        <div className="mt-1 flex flex-wrap gap-1">
          {PRESET_OPTIONS.map((opt) => {
            const active = preset === opt.value
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => applyPreset(opt.value)}
                className={cn(
                  'rounded-md border px-2 py-1 text-xs transition-colors',
                  active
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'bg-background hover:bg-muted',
                )}
              >
                {opt.label}
              </button>
            )
          })}
        </div>
        <p className="mt-1 text-[10px] text-muted-foreground">
          새 보고서에 처음 깔리는 기본값.
          보고서별로 위젯 편집에서 자유롭게 바꿀 수 있습니다.
        </p>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Preview                                                                     //
// --------------------------------------------------------------------------- //
export function QuadrantPreview({ props }) {
  const labels = effectiveQuadrantLabels(props)
  const colors = effectiveQuadrantColors(props)
  return (
    <div className="space-y-2">
      <PreviewLabel hint="2x2 매트릭스">{props.label || '(라벨 없음)'}</PreviewLabel>
      <div className="grid grid-cols-2 gap-0.5 rounded-md border p-1 bg-muted/20">
        {QUADRANT_KEYS.map((k) => (
          <div
            key={k}
            className="aspect-[2/1] rounded-sm p-1.5 text-[10px] text-foreground/80 leading-tight"
            style={{ backgroundColor: colors[k] }}
          >
            {labels[k] || QUADRANT_POSITION_LABEL[k]}
          </div>
        ))}
      </div>
      {props.preset && props.preset !== 'custom' && (
        <p className="text-[10px] text-muted-foreground italic">
          프리셋: {PRESET_OPTIONS.find((o) => o.value === props.preset)?.label}
        </p>
      )}
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Editor — 2-column layout (board left, config right)                         //
// --------------------------------------------------------------------------- //
export function QuadrantEditor({
  props,
  content,
  onChange,
  onChangePropsOverride,
  readOnly,
  autoFit,
}) {
  const caption = content?.caption ?? ''
  const mode = effectiveMode(content, props)
  const labels = effectiveQuadrantLabels(props)
  const colors = effectiveQuadrantColors(props)
  const [xMin, xMax] = effectiveRange(props, 'x')
  const [yMin, yMax] = effectiveRange(props, 'y')
  const textClass = textStyleToClassName(props.text_style)
  const textStyle = textStyleToInlineStyle(props.text_style)
  const [selectedPlotId, setSelectedPlotId] = useState(null)

  function patchContent(next) {
    const merged = { ...(content ?? {}), ...next }
    if (!merged.caption) delete merged.caption
    if (!merged.caption_skip_autofill) delete merged.caption_skip_autofill
    if (!Array.isArray(merged.bucket_items) || merged.bucket_items.length === 0) {
      delete merged.bucket_items
    }
    if (!Array.isArray(merged.plot_items) || merged.plot_items.length === 0) {
      delete merged.plot_items
    }
    // `mode` is part of content (per-report) since it can differ from
    // the template's `default_mode`. Strip when it matches default.
    if (merged.mode && merged.mode === (props.default_mode ?? 'bucket')) {
      delete merged.mode
    }
    onChange(merged)
  }

  // Build a full structural snapshot from current effective props and
  // hand it to `onChangePropsOverride`.  The dialog treats override
  // updates as REPLACE — partial patches would silently revert
  // untouched fields back to the template default.  When override is
  // unavailable (legacy host that didn't wire the prop), fall back to
  // writing into content so the change at least sticks for this
  // report.  Same defensive pattern Chart uses.
  function patchOverride(partial) {
    const snapshot = {}
    for (const k of STRUCTURAL_KEYS) {
      if (partial[k] !== undefined) {
        snapshot[k] = partial[k]
      } else if (props[k] !== undefined) {
        snapshot[k] = props[k]
      }
    }
    if (typeof onChangePropsOverride === 'function') {
      onChangePropsOverride(snapshot)
    } else {
      // Legacy host fallback. Won't survive a template change, but
      // beats losing the edit entirely.
      const merged = { ...(content ?? {}) }
      Object.assign(merged, partial)
      onChange(merged)
    }
  }

  function setMode(nextMode) {
    if (nextMode === mode) return
    patchContent({ mode: nextMode })
    setSelectedPlotId(null)
  }

  function applyPreset(nextPreset) {
    if (nextPreset === 'custom') {
      patchOverride({ preset: 'custom' })
      return
    }
    const seed = PRESETS[nextPreset]
    if (!seed) return
    patchOverride({ preset: nextPreset, ...seed })
    // Mode also flips, mirror that into content so the next read
    // reflects the preset's intent.
    if (seed.default_mode && seed.default_mode !== mode) {
      patchContent({ mode: seed.default_mode })
      setSelectedPlotId(null)
    }
  }

  const skipCaptionProps = captionSkipProps({ content, patch: patchContent })
  const captionHint = props.label ?? ''
  const showBubbleSize = props.show_bubble_size === true

  const plotItems = useMemo(
    () => (Array.isArray(content?.plot_items) ? content.plot_items : []),
    [content?.plot_items],
  )

  function addPlotItemAtCenter() {
    const xMid = (xMin + xMax) / 2
    const yMid = (yMin + yMax) / 2
    const id = newId('p')
    const next = [
      ...plotItems,
      {
        id,
        label: `항목 ${plotItems.length + 1}`,
        x: xMid,
        y: yMid,
        ...(showBubbleSize ? { size: DEFAULT_BUBBLE_SIZE } : {}),
      },
    ]
    patchContent({ plot_items: next })
    setSelectedPlotId(id)
  }

  return (
    <div
      className={cn('flex flex-col h-full min-h-0 gap-3', textClass)}
      style={textStyle}
    >
      <CaptionInput
        value={caption}
        onChange={(v) => patchContent({ caption: v })}
        placeholder={captionHint}
        readOnly={readOnly}
        {...skipCaptionProps}
      />

      {!readOnly && (
        <TopToolbar
          preset={props.preset ?? 'custom'}
          mode={mode}
          onPresetChange={applyPreset}
          onModeChange={setMode}
          onAddPoint={mode === 'plot' ? addPlotItemAtCenter : null}
        />
      )}

      {/* Main grid: board on the left, config panel on the right.
          Switches to a single column on narrow viewports so the right
          panel doesn't squeeze the board to nothing.  In the edit
          dialog (autoFit=false) the row claims the remaining 80vh
          height via `flex-1 min-h-0`; in the in-grid render
          (autoFit=true) the parent has no fixed height and natural
          flow takes over. */}
      <div
        className={cn(
          'grid gap-3',
          autoFit ? '' : 'flex-1 min-h-0',
          readOnly
            ? 'grid-cols-1'
            : 'grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(260px,340px)]',
        )}
      >
        <div className="min-h-0 flex flex-col">
          {mode === 'bucket' ? (
            <BucketBoard
              content={content}
              labels={labels}
              colors={colors}
              patch={patchContent}
              readOnly={readOnly}
              autoFit={autoFit}
            />
          ) : (
            <PlotCanvas
              items={plotItems}
              props={props}
              colors={colors}
              labels={labels}
              xMin={xMin}
              xMax={xMax}
              yMin={yMin}
              yMax={yMax}
              showBubbleSize={showBubbleSize}
              selectedId={selectedPlotId}
              onSelect={setSelectedPlotId}
              onItemsChange={(next) => patchContent({ plot_items: next })}
              readOnly={readOnly}
            />
          )}
        </div>

        {!readOnly && (
          <ConfigPanel
            mode={mode}
            labels={labels}
            colors={colors}
            props={props}
            xMin={xMin}
            xMax={xMax}
            yMin={yMin}
            yMax={yMax}
            showBubbleSize={showBubbleSize}
            onPatchOverride={patchOverride}
          />
        )}
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// TopToolbar — preset chips + mode toggle                                     //
// --------------------------------------------------------------------------- //
function TopToolbar({ preset, mode, onPresetChange, onModeChange, onAddPoint }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-md border bg-muted/20 px-3 py-1.5 text-xs">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
        프리셋
      </span>
      <div className="flex flex-wrap gap-1">
        {PRESET_OPTIONS.map((opt) => {
          const active = preset === opt.value
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onPresetChange(opt.value)}
              className={cn(
                'rounded px-2 py-0.5 text-xs transition-colors border',
                active
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-transparent hover:bg-background',
              )}
              title={
                opt.value === 'custom'
                  ? '커스텀 — 현재 설정 유지 (재시드 안 함)'
                  : `${opt.label} 프리셋으로 라벨/색/모드 재설정`
              }
            >
              {opt.label}
            </button>
          )
        })}
      </div>
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold ml-2">
        모드
      </span>
      <div className="inline-flex rounded-md border bg-background overflow-hidden">
        {MODE_OPTIONS.map((opt) => {
          const active = mode === opt.value
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onModeChange(opt.value)}
              className={cn(
                'px-2 py-0.5 text-xs transition-colors',
                active
                  ? 'bg-primary text-primary-foreground'
                  : 'hover:bg-muted',
              )}
            >
              {opt.label}
            </button>
          )
        })}
      </div>
      {onAddPoint && (
        <Button
          type="button"
          size="sm"
          variant="default"
          className="h-7 gap-1 text-xs ml-auto"
          onClick={onAddPoint}
          title="캔버스 중앙에 새 점 추가 (캔버스 빈 곳을 더블클릭해도 됩니다)"
        >
          <Plus className="h-3.5 w-3.5" />
          점 추가
        </Button>
      )}
    </div>
  )
}

// --------------------------------------------------------------------------- //
// ConfigPanel — right column: all the visual config the writer can tune       //
//                                                                              //
// Sections collapse-free — the panel itself is scrollable so authors can      //
// reach everything without nested toggling.  Order is from "what readers      //
// look at first" (axis labels, quadrant labels) down to plot-only options.   //
// --------------------------------------------------------------------------- //
function ConfigPanel({
  mode,
  labels,
  colors,
  props,
  xMin,
  xMax,
  yMin,
  yMax,
  showBubbleSize,
  onPatchOverride,
}) {
  return (
    <div className="min-h-0 overflow-y-auto pr-1 space-y-3">
      <PanelSection title="사분면 라벨">
        <div className="grid grid-cols-2 gap-2">
          {QUADRANT_KEYS.map((k) => (
            <div key={k} className="space-y-1">
              <span className="text-[10px] text-muted-foreground">
                {QUADRANT_POSITION_LABEL[k]}
              </span>
              <Input
                value={labels[k]}
                onChange={(e) =>
                  onPatchOverride({
                    quadrant_labels: { ...labels, [k]: e.target.value },
                    preset: 'custom',
                  })
                }
                placeholder={QUADRANT_POSITION_LABEL[k]}
                className="h-7 text-xs"
              />
            </div>
          ))}
        </div>
      </PanelSection>

      <PanelSection title="사분면 색상">
        <div className="grid grid-cols-2 gap-2">
          {QUADRANT_KEYS.map((k) => (
            <div key={k} className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground w-10 shrink-0">
                {QUADRANT_POSITION_LABEL[k]}
              </span>
              <input
                type="color"
                value={colors[k]}
                onChange={(e) =>
                  onPatchOverride({
                    quadrant_colors: { ...colors, [k]: e.target.value },
                    preset: 'custom',
                  })
                }
                className="h-7 w-10 rounded border bg-background"
              />
            </div>
          ))}
        </div>
      </PanelSection>

      <PanelSection title="축 라벨">
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <FieldInput
              label="X축 제목"
              value={props.x_axis_title ?? ''}
              onChange={(v) => onPatchOverride({ x_axis_title: v, preset: 'custom' })}
            />
            <FieldInput
              label="Y축 제목"
              value={props.y_axis_title ?? ''}
              onChange={(v) => onPatchOverride({ y_axis_title: v, preset: 'custom' })}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <FieldInput
              label="X 왼쪽"
              value={props.x_low_label ?? ''}
              onChange={(v) => onPatchOverride({ x_low_label: v, preset: 'custom' })}
            />
            <FieldInput
              label="X 오른쪽"
              value={props.x_high_label ?? ''}
              onChange={(v) => onPatchOverride({ x_high_label: v, preset: 'custom' })}
            />
            <FieldInput
              label="Y 아래"
              value={props.y_low_label ?? ''}
              onChange={(v) => onPatchOverride({ y_low_label: v, preset: 'custom' })}
            />
            <FieldInput
              label="Y 위"
              value={props.y_high_label ?? ''}
              onChange={(v) => onPatchOverride({ y_high_label: v, preset: 'custom' })}
            />
          </div>
        </div>
      </PanelSection>

      {mode === 'plot' && (
        <PanelSection title="플롯 옵션">
          <div className="space-y-2">
            <div className="flex flex-wrap gap-3">
              <ToggleField
                label="격자선"
                value={props.show_grid_lines !== false}
                onChange={(v) =>
                  onPatchOverride({ show_grid_lines: v, preset: 'custom' })
                }
              />
              <ToggleField
                label="축 화살표"
                value={props.show_axis_arrows !== false}
                onChange={(v) =>
                  onPatchOverride({ show_axis_arrows: v, preset: 'custom' })
                }
              />
              <ToggleField
                label="버블 크기"
                value={showBubbleSize}
                onChange={(v) =>
                  onPatchOverride({ show_bubble_size: v, preset: 'custom' })
                }
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <NumberField
                label="X min"
                value={xMin}
                onChange={(v) =>
                  onPatchOverride({ x_range: [v, xMax], preset: 'custom' })
                }
              />
              <NumberField
                label="X max"
                value={xMax}
                onChange={(v) =>
                  onPatchOverride({ x_range: [xMin, v], preset: 'custom' })
                }
              />
              <NumberField
                label="Y min"
                value={yMin}
                onChange={(v) =>
                  onPatchOverride({ y_range: [v, yMax], preset: 'custom' })
                }
              />
              <NumberField
                label="Y max"
                value={yMax}
                onChange={(v) =>
                  onPatchOverride({ y_range: [yMin, v], preset: 'custom' })
                }
              />
            </div>
          </div>
        </PanelSection>
      )}

    </div>
  )
}

function PanelSection({ title, action, children }) {
  return (
    <section className="rounded-md border bg-muted/10 p-2 space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
          {title}
        </span>
        {action}
      </div>
      {children}
    </section>
  )
}

function FieldInput({ label, value, onChange }) {
  return (
    <label className="block space-y-1">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 text-xs"
      />
    </label>
  )
}

function NumberField({ label, value, onChange }) {
  return (
    <label className="block space-y-1">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <Input
        type="number"
        value={Number.isFinite(value) ? value : ''}
        onChange={(e) => {
          const n = Number(e.target.value)
          if (Number.isFinite(n)) onChange(n)
        }}
        className="h-7 text-xs"
      />
    </label>
  )
}

function ToggleField({ label, value, onChange }) {
  return (
    <label className="inline-flex items-center gap-1.5 cursor-pointer text-xs">
      <input
        type="checkbox"
        checked={!!value}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  )
}

// --------------------------------------------------------------------------- //
// BucketBoard — 4 cells, each an editable list. HTML5 DnD between cells.       //
// --------------------------------------------------------------------------- //
function BucketBoard({ content, labels, colors, patch, readOnly, autoFit }) {
  const items = useMemo(
    () => (Array.isArray(content?.bucket_items) ? content.bucket_items : []),
    [content?.bucket_items],
  )
  const byQuadrant = useMemo(() => {
    const out = { tl: [], tr: [], bl: [], br: [] }
    for (const it of items) {
      if (!it || !QUADRANT_KEYS.includes(it.quadrant)) continue
      out[it.quadrant].push(it)
    }
    return out
  }, [items])

  const dragIdRef = useRef(null)
  const [dragOverQuadrant, setDragOverQuadrant] = useState(null)

  function addItem(quadrant) {
    const next = [
      ...items,
      { id: newId('b'), quadrant, text: '' },
    ]
    patch({ bucket_items: next })
  }

  function updateItem(id, p) {
    const next = items.map((it) => (it.id === id ? { ...it, ...p } : it))
    patch({ bucket_items: next })
  }

  function removeItem(id) {
    const next = items.filter((it) => it.id !== id)
    patch({ bucket_items: next })
  }

  function moveItemToQuadrant(id, quadrant) {
    if (!QUADRANT_KEYS.includes(quadrant)) return
    const next = items.map((it) => (it.id === id ? { ...it, quadrant } : it))
    patch({ bucket_items: next })
  }

  function onCellDragOver(e, quadrant) {
    if (readOnly) return
    if (dragIdRef.current == null) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dragOverQuadrant !== quadrant) setDragOverQuadrant(quadrant)
  }

  function onCellDrop(e, quadrant) {
    if (readOnly) return
    e.preventDefault()
    const id = dragIdRef.current
    dragIdRef.current = null
    setDragOverQuadrant(null)
    if (id) moveItemToQuadrant(id, quadrant)
  }

  function onItemDragStart(e, id) {
    if (readOnly) return
    dragIdRef.current = id
    e.dataTransfer.effectAllowed = 'move'
    try { e.dataTransfer.setData('text/plain', id) } catch (_) { /* noop */ }
  }

  function onItemDragEnd() {
    dragIdRef.current = null
    setDragOverQuadrant(null)
  }

  const wrapperClass = autoFit
    ? ''
    : 'flex-1 min-h-0 overflow-y-auto pr-1'
  return (
    <div className={wrapperClass}>
      <div className="grid grid-cols-2 gap-2">
        {QUADRANT_KEYS.map((k) => (
          <BucketCell
            key={k}
            quadrant={k}
            label={labels[k] || QUADRANT_POSITION_LABEL[k]}
            color={colors[k]}
            items={byQuadrant[k]}
            readOnly={readOnly}
            highlight={dragOverQuadrant === k}
            onAdd={() => addItem(k)}
            onUpdate={updateItem}
            onRemove={removeItem}
            onMove={moveItemToQuadrant}
            onItemDragStart={onItemDragStart}
            onItemDragEnd={onItemDragEnd}
            onCellDragOver={(e) => onCellDragOver(e, k)}
            onCellDrop={(e) => onCellDrop(e, k)}
            onCellDragLeave={() => {
              if (dragOverQuadrant === k) setDragOverQuadrant(null)
            }}
          />
        ))}
      </div>
    </div>
  )
}

function BucketCell({
  quadrant,
  label,
  color,
  items,
  readOnly,
  highlight,
  onAdd,
  onUpdate,
  onRemove,
  onMove,
  onItemDragStart,
  onItemDragEnd,
  onCellDragOver,
  onCellDrop,
  onCellDragLeave,
}) {
  return (
    <div
      className={cn(
        'rounded-md border min-h-[120px] flex flex-col transition-shadow',
        highlight && 'ring-2 ring-primary/60',
      )}
      style={{ backgroundColor: color }}
      onDragOver={onCellDragOver}
      onDragLeave={onCellDragLeave}
      onDrop={onCellDrop}
    >
      <div className="px-2 py-1 text-xs font-semibold text-foreground/80 border-b border-foreground/10 flex items-center justify-between">
        <span className="truncate">{label}</span>
        <span className="text-[10px] text-foreground/50 ml-2 shrink-0">
          {items.length}
        </span>
      </div>
      <div className="flex-1 p-1.5 space-y-1">
        {items.length === 0 && readOnly && (
          <div className="text-[10px] text-foreground/40 italic px-1 py-2">
            (비어 있음)
          </div>
        )}
        {items.map((it) => (
          <BucketItem
            key={it.id}
            item={it}
            quadrant={quadrant}
            readOnly={readOnly}
            onChangeText={(t) => onUpdate(it.id, { text: t })}
            onRemove={() => onRemove(it.id)}
            onMove={(q) => onMove(it.id, q)}
            onDragStart={(e) => onItemDragStart(e, it.id)}
            onDragEnd={onItemDragEnd}
          />
        ))}
      </div>
      {!readOnly && (
        <div className="p-1 border-t border-foreground/10">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-full justify-start gap-1 text-xs text-foreground/70"
            onClick={onAdd}
          >
            <Plus className="h-3 w-3" />
            항목 추가
          </Button>
        </div>
      )}
    </div>
  )
}

function BucketItem({
  item,
  quadrant,
  readOnly,
  onChangeText,
  onRemove,
  onMove,
  onDragStart,
  onDragEnd,
}) {
  if (readOnly) {
    return (
      <div className="rounded-sm bg-background/70 border border-foreground/5 px-2 py-1 text-sm">
        {item.text || <span className="text-foreground/40 italic">(빈 항목)</span>}
      </div>
    )
  }
  return (
    <div
      className="group relative rounded-sm bg-background/80 border border-foreground/10 hover:border-foreground/30 transition-colors"
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <div className="flex items-start gap-1 px-1 py-1">
        <GripVertical
          className="h-3.5 w-3.5 mt-1 text-foreground/30 cursor-grab shrink-0"
          aria-hidden="true"
        />
        <textarea
          value={item.text ?? ''}
          onChange={(e) => onChangeText(e.target.value)}
          rows={1}
          placeholder="내용 입력"
          className="flex-1 min-w-0 resize-none bg-transparent border-0 outline-none focus:ring-0 text-sm px-0.5 py-0.5"
          style={{ height: 'auto' }}
          onInput={(e) => {
            e.target.style.height = 'auto'
            e.target.style.height = `${e.target.scrollHeight}px`
          }}
        />
        <button
          type="button"
          onClick={onRemove}
          className="opacity-0 group-hover:opacity-100 transition-opacity text-foreground/40 hover:text-destructive shrink-0"
          title="항목 삭제"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="hidden group-hover:flex items-center gap-0.5 px-1 pb-1 ml-4">
        {QUADRANT_KEYS.filter((q) => q !== quadrant).map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => onMove(q)}
            className="rounded px-1 py-0.5 text-[10px] text-foreground/50 hover:bg-muted hover:text-foreground"
            title={`${QUADRANT_POSITION_LABEL[q]} 로 이동`}
          >
            {QUADRANT_POSITION_LABEL[q]}
          </button>
        ))}
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// PlotCanvas — continuous x/y plane with draggable dots.                      //
//                                                                              //
// The SVG fills its column via `flex-1 min-h-0` + `w-full h-full` with         //
// `preserveAspectRatio="xMidYMid meet"`, so it scales to whatever shape       //
// the left column is (no fixed aspect-ratio constraint that could overflow    //
// the dialog height).  Drag math uses `getScreenCTM` so the math is still    //
// correct when letterboxing kicks in.                                          //
// --------------------------------------------------------------------------- //
const VB = { w: 120, h: 90 }
const MARGIN = { t: 6, r: 8, b: 18, l: 20 }
const PLOT = {
  x: MARGIN.l,
  y: MARGIN.t,
  w: VB.w - MARGIN.l - MARGIN.r,
  h: VB.h - MARGIN.t - MARGIN.b,
}

function PlotCanvas({
  items,
  props,
  colors,
  labels,
  xMin,
  xMax,
  yMin,
  yMax,
  showBubbleSize,
  selectedId,
  onSelect,
  onItemsChange,
  readOnly,
}) {
  const xMid = (xMin + xMax) / 2
  const yMid = (yMin + yMax) / 2
  const showGrid = props.show_grid_lines !== false
  const showArrows = props.show_axis_arrows !== false

  const wrapperRef = useRef(null)
  const svgRef = useRef(null)
  const dragRef = useRef(null)
  const [anchorPos, setAnchorPos] = useState(null)
  const [resizeTick, setResizeTick] = useState(0)

  const selectedItem = useMemo(
    () => items.find((it) => it.id === selectedId) ?? null,
    [items, selectedId],
  )

  function clientToData(clientX, clientY) {
    const svg = svgRef.current
    if (!svg) return { x: xMin, y: yMin }
    const ctm = svg.getScreenCTM()
    if (!ctm) return { x: xMin, y: yMin }
    const pt = svg.createSVGPoint()
    pt.x = clientX
    pt.y = clientY
    const local = pt.matrixTransform(ctm.inverse())
    const fx = clamp01((local.x - PLOT.x) / PLOT.w)
    const fy = clamp01((local.y - PLOT.y) / PLOT.h)
    return {
      x: xMin + fx * (xMax - xMin),
      y: yMin + (1 - fy) * (yMax - yMin),
    }
  }

  function updateItem(id, p) {
    onItemsChange(items.map((it) => (it.id === id ? { ...it, ...p } : it)))
  }

  function removeItem(id) {
    onItemsChange(items.filter((it) => it.id !== id))
    onSelect(null)
  }

  function addItemAtData(x, y) {
    const id = newId('p')
    const next = [
      ...items,
      {
        id,
        label: `항목 ${items.length + 1}`,
        x,
        y,
        ...(showBubbleSize ? { size: DEFAULT_BUBBLE_SIZE } : {}),
      },
    ]
    onItemsChange(next)
    onSelect(id)
  }

  function onDotPointerDown(e, id) {
    if (readOnly) return
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    dragRef.current = { id, pointerId: e.pointerId, moved: false }
    onSelect(id)
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch (_) { /* noop */ }
  }

  function onDotPointerMove(e) {
    if (!dragRef.current) return
    const { x, y } = clientToData(e.clientX, e.clientY)
    dragRef.current.moved = true
    updateItem(dragRef.current.id, { x, y })
  }

  function onDotPointerUp(e) {
    if (!dragRef.current) return
    try { e.currentTarget.releasePointerCapture(dragRef.current.pointerId) } catch (_) { /* noop */ }
    dragRef.current = null
  }

  // Single click on empty canvas → deselect. Dots stopPropagation on
  // pointerdown so this only fires for background clicks.
  function onCanvasPointerDown(e) {
    if (readOnly) return
    if (e.button !== 0) return
    if (selectedId) onSelect(null)
  }

  // Double-click empty canvas → add a point at that data position.
  // Dots stopPropagation on dblclick so this only fires for the
  // background.
  function onCanvasDoubleClick(e) {
    if (readOnly) return
    const { x, y } = clientToData(e.clientX, e.clientY)
    addItemAtData(x, y)
  }

  function dataToPlot(x, y) {
    return {
      px: PLOT.x + ((x - xMin) / (xMax - xMin)) * PLOT.w,
      py: PLOT.y + (1 - (y - yMin) / (yMax - yMin)) * PLOT.h,
    }
  }

  function sizeToRadius(size) {
    const axisSpan = Math.max(xMax - xMin, yMax - yMin)
    if (!Number.isFinite(size) || size <= 0) return 2.2
    const norm = size / axisSpan
    return Math.max(1.2, Math.min(10, norm * 50))
  }

  // Convert the selected dot's data coords to a pixel position inside
  // the wrapper, so the Radix Popover anchor can sit on top of it.
  // Uses getScreenCTM to follow the SVG's actual rendered transform
  // (which depends on letterboxing from preserveAspectRatio).
  useLayoutEffect(() => {
    if (!selectedItem) {
      setAnchorPos(null)
      return
    }
    const svg = svgRef.current
    const wrapper = wrapperRef.current
    if (!svg || !wrapper) return
    const ctm = svg.getScreenCTM()
    if (!ctm) return
    const px = PLOT.x + ((selectedItem.x - xMin) / (xMax - xMin)) * PLOT.w
    const py = PLOT.y + (1 - (selectedItem.y - yMin) / (yMax - yMin)) * PLOT.h
    const pt = svg.createSVGPoint()
    pt.x = px
    pt.y = py
    const screen = pt.matrixTransform(ctm)
    const rect = wrapper.getBoundingClientRect()
    setAnchorPos({ left: screen.x - rect.left, top: screen.y - rect.top })
  }, [selectedItem, xMin, xMax, yMin, yMax, resizeTick])

  // Container resize → recompute anchor (bumps a tick to retrigger the
  // layout effect above with the new screen CTM).
  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setResizeTick((t) => t + 1))
    ro.observe(wrapper)
    return () => ro.disconnect()
  }, [])

  // ESC anywhere closes the popover / clears selection.
  useEffect(() => {
    if (!selectedId || readOnly) return
    function onKey(e) {
      if (e.key === 'Escape') onSelect(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, readOnly, onSelect])

  return (
    <div ref={wrapperRef} className="flex-1 min-h-0 w-full relative">
      <div className="absolute inset-0 overflow-hidden rounded-md border bg-background">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VB.w} ${VB.h}`}
        className="w-full h-full"
        preserveAspectRatio="xMidYMid meet"
        style={{ touchAction: 'none' }}
        onPointerDown={onCanvasPointerDown}
        onDoubleClick={onCanvasDoubleClick}
      >
        {/* Quadrant fills */}
        {QUADRANT_KEYS.map((k) => {
          const isRight = k === 'tr' || k === 'br'
          const isTop = k === 'tl' || k === 'tr'
          const halfW = PLOT.w / 2
          const halfH = PLOT.h / 2
          return (
            <rect
              key={k}
              x={isRight ? PLOT.x + halfW : PLOT.x}
              y={isTop ? PLOT.y : PLOT.y + halfH}
              width={halfW}
              height={halfH}
              fill={colors[k]}
            />
          )
        })}

        {/* Quadrant labels — anchored at the outer corner of each cell */}
        {QUADRANT_KEYS.map((k) => {
          const isRight = k === 'tr' || k === 'br'
          const isTop = k === 'tl' || k === 'tr'
          const lx = isRight ? PLOT.x + PLOT.w - 1.5 : PLOT.x + 1.5
          const ly = isTop ? PLOT.y + 1.5 : PLOT.y + PLOT.h - 2
          return (
            <text
              key={`lbl_${k}`}
              x={lx}
              y={ly}
              textAnchor={isRight ? 'end' : 'start'}
              dominantBaseline={isTop ? 'hanging' : 'alphabetic'}
              fontSize={3.2}
              fill="rgba(15, 23, 42, 0.6)"
              fontWeight={600}
              pointerEvents="none"
            >
              {labels[k] || QUADRANT_POSITION_LABEL[k]}
            </text>
          )
        })}

        {/* Grid mid-lines */}
        {showGrid && (
          <g stroke="rgba(15, 23, 42, 0.4)" strokeWidth={0.25} strokeDasharray="0.8 0.8">
            <line
              x1={PLOT.x + PLOT.w / 2}
              y1={PLOT.y}
              x2={PLOT.x + PLOT.w / 2}
              y2={PLOT.y + PLOT.h}
            />
            <line
              x1={PLOT.x}
              y1={PLOT.y + PLOT.h / 2}
              x2={PLOT.x + PLOT.w}
              y2={PLOT.y + PLOT.h / 2}
            />
          </g>
        )}

        {/* Plot border */}
        <rect
          x={PLOT.x}
          y={PLOT.y}
          width={PLOT.w}
          height={PLOT.h}
          fill="none"
          stroke="rgba(15, 23, 42, 0.5)"
          strokeWidth={0.4}
        />

        {/* Axis arrows */}
        {showArrows && (
          <g stroke="rgba(15, 23, 42, 0.7)" strokeWidth={0.5} fill="none">
            <line
              x1={PLOT.x}
              y1={PLOT.y + PLOT.h + 2.5}
              x2={PLOT.x + PLOT.w}
              y2={PLOT.y + PLOT.h + 2.5}
            />
            <polyline
              points={`${PLOT.x + PLOT.w - 1.5},${PLOT.y + PLOT.h + 1.5} ${PLOT.x + PLOT.w},${PLOT.y + PLOT.h + 2.5} ${PLOT.x + PLOT.w - 1.5},${PLOT.y + PLOT.h + 3.5}`}
            />
            <line
              x1={PLOT.x - 2.5}
              y1={PLOT.y + PLOT.h}
              x2={PLOT.x - 2.5}
              y2={PLOT.y}
            />
            <polyline
              points={`${PLOT.x - 3.5},${PLOT.y + 1.5} ${PLOT.x - 2.5},${PLOT.y} ${PLOT.x - 1.5},${PLOT.y + 1.5}`}
            />
          </g>
        )}

        {/* Axis endpoint labels */}
        <g fill="rgba(15, 23, 42, 0.75)" fontSize={2.9}>
          {props.x_low_label && (
            <text x={PLOT.x} y={PLOT.y + PLOT.h + 7.5} textAnchor="start">
              {props.x_low_label}
            </text>
          )}
          {props.x_high_label && (
            <text x={PLOT.x + PLOT.w} y={PLOT.y + PLOT.h + 7.5} textAnchor="end">
              {props.x_high_label}
            </text>
          )}
          {props.y_low_label && (
            <text
              x={PLOT.x - 4.5}
              y={PLOT.y + PLOT.h}
              textAnchor="end"
              dominantBaseline="alphabetic"
            >
              {props.y_low_label}
            </text>
          )}
          {props.y_high_label && (
            <text
              x={PLOT.x - 4.5}
              y={PLOT.y + 2.5}
              textAnchor="end"
              dominantBaseline="hanging"
            >
              {props.y_high_label}
            </text>
          )}
        </g>

        {/* Axis titles */}
        <g fill="rgba(15, 23, 42, 0.9)" fontSize={3.6} fontWeight={600}>
          {props.x_axis_title && (
            <text
              x={PLOT.x + PLOT.w / 2}
              y={PLOT.y + PLOT.h + 13}
              textAnchor="middle"
            >
              {props.x_axis_title}
            </text>
          )}
          {props.y_axis_title && (
            <text
              x={6}
              y={PLOT.y + PLOT.h / 2}
              textAnchor="middle"
              dominantBaseline="middle"
              transform={`rotate(-90 6 ${PLOT.y + PLOT.h / 2})`}
            >
              {props.y_axis_title}
            </text>
          )}
        </g>

        {/* Dots */}
        {items.map((it) => {
          const { px, py } = dataToPlot(it.x, it.y)
          const r = showBubbleSize ? sizeToRadius(it.size) : 2.4
          const isSelected = it.id === selectedId
          const dotColor = it.color || quadrantColorOfPoint(it.x, it.y, xMid, yMid, colors)
          return (
            <g key={it.id}>
              <circle
                data-quadrant-dot=""
                cx={px}
                cy={py}
                r={r}
                fill={dotColor}
                fillOpacity={0.85}
                stroke={isSelected ? '#0f172a' : 'rgba(15,23,42,0.7)'}
                strokeWidth={isSelected ? 0.9 : 0.4}
                onPointerDown={(e) => onDotPointerDown(e, it.id)}
                onPointerMove={onDotPointerMove}
                onPointerUp={onDotPointerUp}
                onPointerCancel={onDotPointerUp}
                onDoubleClick={(e) => e.stopPropagation()}
                style={{ cursor: readOnly ? 'default' : 'grab' }}
              />
              {it.label && (
                <text
                  x={px + r + 0.8}
                  y={py + 1}
                  fontSize={3}
                  fill="rgba(15,23,42,0.9)"
                  pointerEvents="none"
                >
                  {it.label}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      </div>

      {/* Anchored editor popover. Anchor is a zero-size div positioned
          at the selected dot's pixel coords; Radix handles flipping
          near the canvas edges. Clicks on another dot don't close the
          popover — the anchor just reposits to the new selection. */}
      {!readOnly && (
        <Popover
          open={!!selectedItem && !!anchorPos}
          onOpenChange={(open) => {
            if (!open) onSelect(null)
          }}
        >
          <PopoverAnchor asChild>
            <div
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: anchorPos?.left ?? 0,
                top: anchorPos?.top ?? 0,
                width: 0,
                height: 0,
                pointerEvents: 'none',
              }}
            />
          </PopoverAnchor>
          <PopoverContent
            side="right"
            align="center"
            sideOffset={14}
            collisionPadding={8}
            className="w-64 p-3"
            onOpenAutoFocus={(e) => e.preventDefault()}
            onPointerDownOutside={(e) => {
              const t = e.target
              if (t && typeof t.closest === 'function' && t.closest('[data-quadrant-dot]')) {
                e.preventDefault()
              }
            }}
          >
            {selectedItem && (
              <SelectedPlotItemEditor
                item={selectedItem}
                showBubbleSize={showBubbleSize}
                xRange={[xMin, xMax]}
                yRange={[yMin, yMax]}
                onChange={(p) => updateItem(selectedItem.id, p)}
                onRemove={() => removeItem(selectedItem.id)}
              />
            )}
          </PopoverContent>
        </Popover>
      )}
    </div>
  )
}

// --------------------------------------------------------------------------- //
// SelectedPlotItemEditor — fields for the currently-selected plot dot         //
// --------------------------------------------------------------------------- //
function SelectedPlotItemEditor({ item, showBubbleSize, xRange, yRange, onChange, onRemove }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
          선택된 점
        </span>
        <button
          type="button"
          onClick={onRemove}
          className="text-foreground/50 hover:text-destructive"
          title="점 삭제"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <label className="block space-y-1">
        <span className="text-[10px] text-muted-foreground">라벨</span>
        <Input
          value={item.label ?? ''}
          onChange={(e) => onChange({ label: e.target.value })}
          placeholder="항목 이름"
          className="h-7 text-xs"
        />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label={`X (${xRange[0]}~${xRange[1]})`}
          value={item.x}
          onChange={(v) => onChange({ x: v })}
        />
        <NumberField
          label={`Y (${yRange[0]}~${yRange[1]})`}
          value={item.y}
          onChange={(v) => onChange({ y: v })}
        />
        {showBubbleSize && (
          <NumberField
            label="크기"
            value={Number.isFinite(item.size) ? item.size : DEFAULT_BUBBLE_SIZE}
            onChange={(v) => onChange({ size: v })}
          />
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-muted-foreground">색상</span>
        <input
          type="color"
          value={item.color ?? '#475569'}
          onChange={(e) => onChange({ color: e.target.value })}
          className="h-7 w-10 rounded border bg-background"
        />
        {item.color && (
          <button
            type="button"
            onClick={() => onChange({ color: undefined })}
            className="text-[10px] text-muted-foreground hover:text-foreground underline"
          >
            기본값
          </button>
        )}
      </div>
      <label className="block space-y-1">
        <span className="text-[10px] text-muted-foreground">메모</span>
        <Input
          value={item.note ?? ''}
          onChange={(e) => onChange({ note: e.target.value || undefined })}
          placeholder="(선택)"
          className="h-7 text-xs"
        />
      </label>
    </div>
  )
}

function quadrantColorOfPoint(x, y, xMid, yMid, colors) {
  const isRight = x >= xMid
  const isTop = y >= yMid
  if (isTop && !isRight) return colors.tl
  if (isTop && isRight) return colors.tr
  if (!isTop && !isRight) return colors.bl
  return colors.br
}
