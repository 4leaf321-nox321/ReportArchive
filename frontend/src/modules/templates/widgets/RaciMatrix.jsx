import { Fragment, useMemo } from 'react'
import { ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Plus, X } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import {
  CaptionInput,
  DEFAULT_BODY_FONT_PX,
  DataTableActions,
  LabelField,
  PreviewLabel,
  TextStyleField,
  captionSkipProps,
  textStyleToClassName,
  textStyleToInlineStyle,
  toTsv,
} from './_shared'

// --------------------------------------------------------------------------- //
// Letter semantics                                                            //
// --------------------------------------------------------------------------- //
// Underlying schema stays R/A/C/I (universal, AI-prompt-friendly), but the
// UI shows Korean words so first-time readers don't have to learn the
// acronym. `short` is what renders inside table cells / dropdown options;
// `label` is the full description used in the legend tooltip.
const LETTERS = {
  R: { label: '실무 (Responsible)', short: '실무', color: '#2563eb', bg: '#2563eb18' },
  A: { label: '책임 (Accountable)', short: '책임', color: '#dc2626', bg: '#dc262618' },
  C: { label: '자문 (Consulted)', short: '자문', color: '#d97706', bg: '#d9770618' },
  I: { label: '공유 (Informed)', short: '공유', color: '#6b7280', bg: '#6b728018' },
}
const DOMINANCE = ['A', 'R', 'C', 'I']
function cellDominant(value) {
  if (!value) return null
  for (const l of DOMINANCE) if (value.includes(l)) return l
  return null
}
// Display a stored "R/A" value as "실무/책임" by translating each letter
// segment through LETTERS. Falls through unmodified for unknown letters.
function formatCell(value) {
  if (!value) return ''
  return value
    .split('/')
    .map((l) => LETTERS[l]?.short ?? l)
    .join(' / ')
}
const CELL_OPTIONS = [
  { value: '', label: '—' },
  { value: 'R', label: '실무' },
  { value: 'A', label: '책임' },
  { value: 'R/A', label: '실무 / 책임' },
  { value: 'C', label: '자문' },
  { value: 'I', label: '공유' },
  { value: 'C/I', label: '자문 / 공유' },
]

// --------------------------------------------------------------------------- //
// Group-run computation — consecutive roles sharing the same `group`          //
// merge into one top-row cell with colspan = run length.                      //
//                                                                             //
// Returns null when a two-row header would be redundant: either no role       //
// has a group at all, or no role has a label distinct from its group         //
// (in which case the bottom row would be empty or duplicate the top).         //
// In that case the renderer falls back to a single-row header showing         //
// `label || group` per column.                                                //
// --------------------------------------------------------------------------- //
function computeGroupRuns(roles) {
  if (!roles?.length) return null
  const hasAnyGroup = roles.some((r) => (r?.group ?? '').trim())
  if (!hasAnyGroup) return null
  const hasDistinctLabel = roles.some((r) => {
    const label = (r?.label ?? '').trim()
    const group = (r?.group ?? '').trim()
    return label && label !== group
  })
  if (!hasDistinctLabel) return null
  const runs = []
  let cur = null
  for (let i = 0; i < roles.length; i++) {
    const g = (roles[i]?.group ?? '').trim()
    if (cur && cur.group === g) {
      cur.count += 1
      cur.endIdx = i
    } else {
      cur = { group: g, count: 1, startIdx: i, endIdx: i }
      runs.push(cur)
    }
  }
  return runs
}

// --------------------------------------------------------------------------- //
// PropsPanel — only the label + initial-seed roles. Writers do most of the   //
// role editing inline in the report's table header.                           //
// --------------------------------------------------------------------------- //
export function RaciMatrixPropsPanel({ props, onChange }) {
  const defaultRoles = Array.isArray(props.default_roles) ? props.default_roles : []
  function patch(next) {
    onChange({ ...props, ...next })
  }
  function addRole() {
    const existing = new Set(defaultRoles.map((r) => r.key))
    let n = defaultRoles.length + 1
    let key = `role_${n}`
    while (existing.has(key)) {
      n += 1
      key = `role_${n}`
    }
    patch({ default_roles: [...defaultRoles, { key, label: '' }] })
  }
  function updateRole(idx, p) {
    patch({
      default_roles: defaultRoles.map((r, i) => (i === idx ? { ...r, ...p } : r)),
    })
  }
  function removeRole(idx) {
    patch({ default_roles: defaultRoles.filter((_, i) => i !== idx) })
  }
  function moveRole(idx, dir) {
    const newIdx = idx + dir
    if (newIdx < 0 || newIdx >= defaultRoles.length) return
    const next = [...defaultRoles]
    const [m] = next.splice(idx, 1)
    next.splice(newIdx, 0, m)
    patch({ default_roles: next })
  }
  return (
    <div className="space-y-4">
      <LabelField
        label="라벨"
        value={props.label}
        onChange={(v) => patch({ label: v })}
        placeholder="역할 분담"
      />
      <div>
        <Label className="text-xs">기본 담당자 (초깃값)</Label>
        <div className="mt-1 space-y-1.5">
          {defaultRoles.map((r, idx) => (
            <div key={idx} className="space-y-1 rounded-md border bg-muted/20 p-1.5">
              <div className="flex items-center gap-1">
                <Input
                  value={r.key ?? ''}
                  onChange={(e) =>
                    updateRole(idx, {
                      key: e.target.value
                        .toLowerCase()
                        .replace(/[^a-z0-9_]/g, ''),
                    })
                  }
                  placeholder="key"
                  maxLength={64}
                  className="h-7 text-[11px] w-20 font-mono"
                />
                <Input
                  value={r.label ?? ''}
                  onChange={(e) => updateRole(idx, { label: e.target.value })}
                  placeholder="담당자 입력"
                  maxLength={100}
                  className="h-7 text-xs flex-1"
                />
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6"
                  onClick={() => moveRole(idx, -1)}
                  disabled={idx === 0}
                >
                  <ChevronUp className="h-3 w-3" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6"
                  onClick={() => moveRole(idx, 1)}
                  disabled={idx === defaultRoles.length - 1}
                >
                  <ChevronDown className="h-3 w-3" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6 text-destructive"
                  onClick={() => removeRole(idx)}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
              <Input
                value={r.group ?? ''}
                onChange={(e) => updateRole(idx, { group: e.target.value })}
                placeholder="(선택) 상단 그룹 — 같은 그룹의 인접 열은 자동 병합"
                maxLength={100}
                className="h-6 text-[11px]"
              />
            </div>
          ))}
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={addRole}
          className="mt-2 h-7 text-xs"
        >
          <Plus className="mr-1 h-3 w-3" />
          담당자 추가
        </Button>
        <p className="mt-1 text-[10px] text-muted-foreground">
          여기서 정한 담당자는 새 보고서에서의 <strong>초깃값</strong>입니다.
          보고서 작성 시 표 헤더에서 직접 추가·삭제·이름변경할 수 있습니다.
        </p>
      </div>
      <TextStyleField
        value={props.text_style}
        onChange={(text_style) => patch({ text_style })}
        defaultSizePx={DEFAULT_BODY_FONT_PX}
      />
      <div className="rounded-md border bg-muted/30 p-2 space-y-1">
        <div className="text-[11px] font-medium">셀에 입력 가능한 값</div>
        <div className="text-[10px] text-muted-foreground leading-relaxed">
          <strong>실무</strong> (R, 실제 작업) / <strong>책임</strong> (A, 최종 책임자) /{' '}
          <strong>자문</strong> (C, 의견 제공) / <strong>공유</strong> (I, 결과 통지).
          한 셀에 여러 값(예: 실무/책임)도 가능. 한 행에는 <strong>책임</strong> 1명을 두는 것이 표준입니다.
        </div>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Preview                                                                     //
// --------------------------------------------------------------------------- //
export function RaciMatrixPreview({ props }) {
  const defaultRoles = (Array.isArray(props.default_roles) ? props.default_roles : []).slice(0, 6)
  // Augment with sample person labels so the preview shows the two-row
  // grouped header even when the template designer hasn't filled in
  // labels yet — otherwise the bottom row would be empty and the
  // grouping pattern wouldn't be visible.
  const PREVIEW_LABELS = ['김OO', '박OO', '이OO', '정OO', '최OO', '강OO']
  const roles = defaultRoles.map((r, i) => ({
    ...r,
    label: r.label || PREVIEW_LABELS[i] || '',
  }))
  return (
    <div className="space-y-2">
      <PreviewLabel>{props.label || '(라벨 없음)'}</PreviewLabel>
      <div className="rounded-md border border-dashed bg-muted/20 px-3 py-3 overflow-x-auto">
        <RaciTable
          roles={roles}
          rows={SAMPLE_ROWS.map((r) => ({
            ...r,
            assignments: pickFromKeys(r.assignments, roles),
          }))}
          readOnly
          compact
        />
      </div>
      <p className="text-[10px] text-muted-foreground italic">
        보고서에서 작업(행)을 추가하고 각 셀에 R/A/C/I 를 지정합니다.
      </p>
    </div>
  )
}
const SAMPLE_ROWS = [
  {
    label: '요구사항 정의',
    assignments: { modeling: 'I', analysis: 'R/A', develop: 'C', design: 'C' },
  },
  {
    label: '시스템 모델링',
    assignments: { modeling: 'R/A', analysis: 'C', develop: 'I', design: 'C' },
  },
  {
    label: '상세 설계',
    assignments: { modeling: 'C', analysis: 'I', develop: 'C', design: 'R/A' },
  },
  {
    label: '구현',
    assignments: { modeling: 'I', analysis: 'I', develop: 'R/A', design: 'C' },
  },
]
function pickFromKeys(map, roles) {
  const out = {}
  for (const r of roles) {
    if (map?.[r.key] !== undefined) out[r.key] = map[r.key]
  }
  return out
}

// --------------------------------------------------------------------------- //
// Shared table renderer — different headers per mode but shared body.         //
//   readOnly + has groups   → two-row header with colspan'd group cells       //
//   readOnly + no groups    → single-row header (labels only)                 //
//   edit mode               → single cell per column with stacked inputs      //
//                             (group input on top, label below, action row)  //
// --------------------------------------------------------------------------- //
function RaciTable({
  roles,
  rows,
  readOnly,
  compact,
  fontSizePx = null,
  onCellChange,
  onLabelChange,
  onRowRemove,
  onRowMove,
  onRoleChange,
  onRoleAdd,
  onRoleRemove,
  onRoleMove,
}) {
  const textSize = compact ? 'text-xs' : 'text-sm'
  const groupRuns = computeGroupRuns(roles)
  const colCount = roles.length + (readOnly ? 1 : 2) // +1 task col, +1 actions in edit
  return (
    // fontSizePx 가 오면 그 값으로 고정(속성 반영), 없으면 textSize 클래스
    // (.report-widget-body 가 text-sm 을 ≈18px 로 부스트)로 폴백.
    <table
      className={`w-full border-collapse ${fontSizePx == null ? textSize : ''}`}
      style={fontSizePx != null ? { fontSize: fontSizePx } : undefined}
    >
      <thead>
        {readOnly ? (
          groupRuns ? (
            <>
              <tr>
                <th
                  rowSpan={2}
                  className="border bg-muted/40 px-2 py-1.5 text-left font-medium align-bottom"
                  style={{ minWidth: 140 }}
                >
                  작업
                </th>
                {groupRuns.map((run, i) =>
                  run.group ? (
                    <th
                      key={i}
                      colSpan={run.count}
                      className="border bg-muted/50 px-2 py-1.5 text-center font-semibold"
                    >
                      {run.group}
                    </th>
                  ) : (
                    <Fragment key={i}>
                      {Array.from({ length: run.count }).map((_, j) => (
                        <th
                          key={j}
                          className="border bg-muted/40"
                          style={{ minWidth: 70 }}
                        />
                      ))}
                    </Fragment>
                  ),
                )}
              </tr>
              <tr>
                {roles.map((r) => (
                  <th
                    key={r.key}
                    className="border bg-muted/40 px-2 py-1.5 text-center font-medium"
                    style={{ minWidth: 70 }}
                  >
                    {r.label || r.group || r.key}
                  </th>
                ))}
              </tr>
            </>
          ) : (
            <tr>
              <th
                className="border bg-muted/40 px-2 py-1.5 text-left font-medium"
                style={{ minWidth: 140 }}
              >
                작업
              </th>
              {roles.map((r) => (
                <th
                  key={r.key}
                  className="border bg-muted/40 px-2 py-1.5 text-center font-medium"
                  style={{ minWidth: 70 }}
                >
                  {r.label || r.group || r.key}
                </th>
              ))}
            </tr>
          )
        ) : (
          // Edit mode — inline editable header (group + label + actions
          // stacked in each role's cell). No colspan during edit so each
          // column stays individually addressable.
          <tr>
            <th
              className="border bg-muted/40 px-2 py-1.5 text-left font-medium align-bottom"
              style={{ minWidth: 140 }}
            >
              작업
            </th>
            {roles.map((role, idx) => (
              <th
                key={`col-${idx}`}
                className="border bg-muted/40 p-1 align-top"
                style={{ minWidth: 110 }}
              >
                <div className="space-y-1">
                  <Input
                    value={role.group ?? ''}
                    onChange={(e) =>
                      onRoleChange?.(idx, { group: e.target.value })
                    }
                    placeholder="(상단 그룹)"
                    maxLength={100}
                    className="h-6 text-[10px] text-center bg-background/70"
                  />
                  <Input
                    value={role.label ?? ''}
                    onChange={(e) =>
                      onRoleChange?.(idx, { label: e.target.value })
                    }
                    placeholder="담당자 입력"
                    maxLength={100}
                    className="h-7 text-xs text-center font-semibold"
                  />
                  <div className="flex items-center justify-center gap-0.5">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-5 w-5"
                      onClick={() => onRoleMove?.(idx, -1)}
                      disabled={idx === 0}
                      title="왼쪽으로"
                    >
                      <ChevronLeft className="h-3 w-3" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-5 w-5"
                      onClick={() => onRoleMove?.(idx, 1)}
                      disabled={idx === roles.length - 1}
                      title="오른쪽으로"
                    >
                      <ChevronRight className="h-3 w-3" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-5 w-5 text-destructive"
                      onClick={() => onRoleRemove?.(idx)}
                      title="이 열 삭제"
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              </th>
            ))}
            <th
              className="border bg-muted/40 p-1 align-top"
              style={{ width: 36 }}
            >
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6"
                onClick={() => onRoleAdd?.()}
                title="담당자 추가"
              >
                <Plus className="h-3 w-3" />
              </Button>
            </th>
          </tr>
        )}
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr>
            <td
              colSpan={colCount}
              className="border px-2 py-3 text-center text-xs text-muted-foreground italic"
            >
              아직 작업이 없습니다.
            </td>
          </tr>
        )}
        {rows.map((row, rIdx) => (
          <tr key={rIdx} className="group">
            <td className="border px-2 py-1">
              {readOnly ? (
                <div className="font-medium">{row.label}</div>
              ) : (
                <Input
                  value={row.label ?? ''}
                  onChange={(e) => onLabelChange?.(rIdx, e.target.value)}
                  placeholder="작업 이름"
                  className="h-8 text-xs"
                />
              )}
              {row.note && (
                <div className="mt-0.5 text-[10px] text-muted-foreground">
                  {row.note}
                </div>
              )}
            </td>
            {roles.map((role) => {
              const cell = row.assignments?.[role.key] ?? ''
              return (
                <RaciCell
                  key={role.key}
                  value={cell}
                  readOnly={readOnly}
                  onChange={(v) => onCellChange?.(rIdx, role.key, v)}
                />
              )
            })}
            {!readOnly && (
              <td className="border px-1 py-1 text-center">
                <div className="flex items-center justify-center gap-0.5">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-5 w-5"
                    onClick={() => onRowMove?.(rIdx, -1)}
                    disabled={rIdx === 0}
                    title="위로"
                  >
                    <ChevronUp className="h-3 w-3" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-5 w-5"
                    onClick={() => onRowMove?.(rIdx, 1)}
                    disabled={rIdx === rows.length - 1}
                    title="아래로"
                  >
                    <ChevronDown className="h-3 w-3" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-5 w-5 text-destructive opacity-0 group-hover:opacity-100"
                    onClick={() => onRowRemove?.(rIdx)}
                    title="삭제"
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function RaciCell({ value, readOnly, onChange }) {
  const dom = cellDominant(value)
  const info = dom ? LETTERS[dom] : null
  const bg = info ? info.bg : undefined
  const fg = info ? info.color : undefined
  if (readOnly) {
    return (
      <td
        className="border px-2 py-1.5 text-center"
        style={{ backgroundColor: bg }}
        // Title keeps the raw R/A/C/I letters discoverable for users
        // who already know the standard — Korean-only display might
        // confuse them otherwise.
        title={value || undefined}
      >
        {value ? (
          <span className="font-semibold whitespace-nowrap" style={{ color: fg }}>
            {formatCell(value)}
          </span>
        ) : (
          <span className="text-muted-foreground/40">—</span>
        )}
      </td>
    )
  }
  return (
    <td className="border p-0" style={{ backgroundColor: bg }}>
      <select
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-full bg-transparent border-0 outline-none text-center text-sm font-semibold focus:ring-1 focus:ring-ring"
        style={{ color: fg }}
        title={value || undefined}
      >
        {CELL_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </td>
  )
}

// --------------------------------------------------------------------------- //
// Legend                                                                      //
// --------------------------------------------------------------------------- //
function RaciLegend() {
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px]">
      {Object.entries(LETTERS).map(([letter, info]) => (
        <span
          key={letter}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5"
          style={{ backgroundColor: info.bg, color: info.color }}
          title={info.label}
        >
          <span className="font-semibold">{info.short}</span>
          <span className="opacity-60 font-mono text-[10px]">({letter})</span>
        </span>
      ))}
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Editor                                                                      //
// --------------------------------------------------------------------------- //
export function RaciMatrixEditor({ props, content, onChange, readOnly }) {
  const caption = content?.caption ?? ''
  const rows = Array.isArray(content?.rows) ? content.rows : []
  // Effective roles — content.roles wins once the writer has touched the
  // header. Presence check (not length) so an explicitly emptied list
  // doesn't silently revert to template defaults.
  const roles = useMemo(() => {
    const raw = Array.isArray(content?.roles)
      ? content.roles
      : Array.isArray(props.default_roles)
        ? props.default_roles
        : []
    // Legacy-shape migration: early versions of this widget stored work-
    // area names (모델링, 분석, …) directly in `label` with no `group`.
    // The new layout puts those in the top-row `group` slot and reserves
    // `label` for individual people. We only auto-swap when the fingerprint
    // is unambiguous — every role has a label AND no role has a group —
    // so a deliberate single-row layout (people names only) survives
    // untouched. Once the writer makes any edit, the migrated shape gets
    // persisted into content.roles via patch() and the migration won't
    // re-trigger on subsequent renders.
    const looksLikeLegacy =
      raw.length > 0 &&
      raw.every(
        (r) => (r?.label ?? '').trim() && !(r?.group ?? '').trim(),
      )
    if (!looksLikeLegacy) return raw
    return raw.map((r) => ({ ...r, label: '', group: r.label }))
  }, [content?.roles, props.default_roles])
  const textClass = textStyleToClassName(props.text_style)
  const textStyle = textStyleToInlineStyle(props.text_style)
  // 표 글자 크기 — 속성(text_style.font_size_px)을 반영. null(미설정)이면
  // 현행 기본(text-sm ≈ 18px, 다른 표 위젯과 동일)을 유지. 예전엔 표가
  // text-sm/xs 로 고정돼 wrapper 의 속성값을 덮어써 안 먹었다.
  const bodyFontPx = props.text_style?.font_size_px ?? null

  function patch(next) {
    const merged = {
      ...(content ?? {}),
      ...(caption ? { caption } : {}),
      // Always materialize the current effective roles into content so
      // subsequent unrelated patches (row label edits, etc.) don't lose
      // the writer's column setup back to template defaults.
      roles,
      rows,
      ...next,
    }
    if (!merged.caption) delete merged.caption
    if (!merged.rows || merged.rows.length === 0) delete merged.rows
    if (!merged.caption_skip_autofill) delete merged.caption_skip_autofill
    onChange(merged)
  }

  // Role-column manipulation. All paths flow through patch() so the
  // writer's edits land in content.roles atomically with any row-side
  // cleanup (orphaned assignment keys, etc.).
  function uniqueRoleKey(seed) {
    const existing = new Set(roles.map((r) => r.key))
    if (!existing.has(seed)) return seed
    let n = 2
    while (existing.has(`${seed}_${n}`)) n += 1
    return `${seed}_${n}`
  }
  function addRole() {
    const key = uniqueRoleKey(`role_${roles.length + 1}`)
    // Inherit the rightmost role's group so the typical action — "add
    // another person under the team I'm currently filling out" — works
    // without re-typing the group. Writer can clear/rename the group
    // afterwards if they want to start a fresh team.
    const inheritedGroup = roles.length > 0 ? roles[roles.length - 1]?.group ?? '' : ''
    const newRole = { key, label: '' }
    if (inheritedGroup) newRole.group = inheritedGroup
    patch({ roles: [...roles, newRole] })
  }
  function updateRole(idx, p) {
    // Key renames must propagate into every row's assignments so cell
    // values stay tied to the column the writer thinks they're editing.
    const current = roles[idx]
    const nextKey =
      p.key !== undefined && p.key !== current.key
        ? uniqueRoleKey(p.key || current.key)
        : undefined
    const nextRoles = roles.map((r, i) =>
      i === idx ? { ...r, ...p, ...(nextKey ? { key: nextKey } : {}) } : r,
    )
    let nextRows = rows
    if (nextKey) {
      const oldKey = current.key
      nextRows = rows.map((row) => {
        if (!row.assignments || !(oldKey in row.assignments)) return row
        const v = row.assignments[oldKey]
        const { [oldKey]: _drop, ...keep } = row.assignments
        return { ...row, assignments: { ...keep, [nextKey]: v } }
      })
    }
    patch({ roles: nextRoles, rows: nextRows })
  }
  function removeRole(idx) {
    const removedKey = roles[idx].key
    const nextRoles = roles.filter((_, i) => i !== idx)
    const nextRows = rows.map((row) => {
      if (!row.assignments || !(removedKey in row.assignments)) return row
      const { [removedKey]: _drop, ...keep } = row.assignments
      return { ...row, assignments: keep }
    })
    patch({ roles: nextRoles, rows: nextRows })
  }
  function moveRole(idx, dir) {
    const newIdx = idx + dir
    if (newIdx < 0 || newIdx >= roles.length) return
    const next = [...roles]
    const [m] = next.splice(idx, 1)
    next.splice(newIdx, 0, m)
    patch({ roles: next })
  }

  // Row-side handlers (unchanged from previous version).
  function addRow() {
    patch({ rows: [...rows, { label: '', assignments: {} }] })
  }
  function setLabel(idx, label) {
    patch({ rows: rows.map((r, i) => (i === idx ? { ...r, label } : r)) })
  }
  function setCell(idx, roleKey, value) {
    patch({
      rows: rows.map((r, i) => {
        if (i !== idx) return r
        const nextAssignments = { ...(r.assignments ?? {}) }
        if (value) nextAssignments[roleKey] = value
        else delete nextAssignments[roleKey]
        return { ...r, assignments: nextAssignments }
      }),
    })
  }
  function removeRow(idx) {
    patch({ rows: rows.filter((_, i) => i !== idx) })
  }
  function moveRow(idx, dir) {
    const newIdx = idx + dir
    if (newIdx < 0 || newIdx >= rows.length) return
    const next = [...rows]
    const [m] = next.splice(idx, 1)
    next.splice(newIdx, 0, m)
    patch({ rows: next })
  }

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
        <div className="overflow-x-auto">
          <RaciTable rows={rows} roles={roles} readOnly fontSizePx={bodyFontPx} />
        </div>
        <RaciLegend />
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
      {roles.length > 0 && (
        <div className="flex justify-end">
          <DataTableActions
            label="RACI 데이터"
            onCopy={() => {
              // Top-left blank, role labels across, then each task row
              // prefixed by its task label with R/A/C/I cells.
              const header = ['', ...roles.map((r) => r.label || r.key)]
              const body = rows.map((row) => [
                row.label ?? '',
                ...roles.map((r) => row.assignments?.[r.key] ?? ''),
              ])
              return toTsv([header, ...body])
            }}
            onClear={() => patch({ rows: [] })}
          />
        </div>
      )}
      {roles.length === 0 ? (
        <div className="rounded-md border border-dashed bg-muted/20 px-3 py-4 text-center text-xs text-muted-foreground">
          담당자(열)가 없습니다.
          <Button
            size="sm"
            variant="outline"
            onClick={addRole}
            className="ml-2 h-7 text-xs"
          >
            <Plus className="mr-1 h-3 w-3" />
            첫 담당자 추가
          </Button>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <RaciTable
            rows={rows}
            roles={roles}
            fontSizePx={bodyFontPx}
            onCellChange={setCell}
            onLabelChange={setLabel}
            onRowRemove={removeRow}
            onRowMove={moveRow}
            onRoleChange={updateRole}
            onRoleAdd={addRole}
            onRoleRemove={removeRole}
            onRoleMove={moveRole}
          />
        </div>
      )}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Button size="sm" variant="outline" onClick={addRow} disabled={roles.length === 0}>
          <Plus className="mr-1 h-3.5 w-3.5" />
          작업 추가
        </Button>
        <RaciLegend />
      </div>
      <p className="text-[10px] text-muted-foreground">
        각 열의 상단 "그룹" 칸은 업무 영역(예: 모델링·개발), 하단 "담당자" 칸은 인력명을 적습니다.
        "담당자 추가"는 가장 오른쪽 그룹을 그대로 이어받아 같은 그룹에 한 줄 더 추가합니다 — 다른 그룹으로 옮기려면 추가 후 그룹 칸을 바꾸세요.
      </p>
    </div>
  )
}
