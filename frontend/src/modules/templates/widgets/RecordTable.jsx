// 객체 레코드 표 위젯 (A0.3 입력경로, 여러 건). 한 위젯에 여러 record 객체를 표로
// 기록한다 — 행=객체, 열=이름+속성. 저장 시 백엔드 훅이 각 행을 upsert 하고 행마다
// entity_id 를 되심는다. content = { axis_slug, rows: [{ name, properties, entity_id }] }.
import { Link } from 'react-router-dom'
import { Boxes, Plus, Trash2, AlertTriangle } from 'lucide-react'
import { Label } from '@/shared/components/ui/label'
import { Button } from '@/shared/components/ui/button'
import {
  PropertyValueInput,
  recordPropertyErrors,
} from '@/modules/entities/EntityPropertiesFields'
import { useRecordAxes, useAxisDefs, RecordNamePicker } from './Record'

// 템플릿 설정(라벨·축 고정)은 단건 위젯과 동일 — 재사용.
export { RecordPropsPanel as RecordTablePropsPanel } from './Record'

function fmtCell(def, raw) {
  if (raw === undefined || raw === null || raw === '') return '—'
  const one = (v) =>
    def.data_type === 'entity_ref'
      ? `#${v}`
      : def.data_type === 'bool'
        ? v === true
          ? '예'
          : '아니오'
        : String(v)
  if (Array.isArray(raw)) return raw.map(one).join(', ')
  return def.unit && def.data_type === 'number' ? `${raw}${def.unit}` : one(raw)
}

export function RecordTableEditor({ props, content, onChange, readOnly }) {
  const lockedAxis = props?.axis_slug || ''
  const axisSlug = content?.axis_slug || lockedAxis || ''
  const rows = Array.isArray(content?.rows) ? content.rows : []

  const axes = useRecordAxes()
  const axis = axes.find((t) => t.slug === axisSlug) || null
  const defs = useAxisDefs(axis)

  function patch(next) {
    onChange({ ...(content || {}), ...next })
  }
  function setRows(r) {
    patch({ rows: r })
  }
  function setRow(i, next) {
    setRows(rows.map((r, idx) => (idx === i ? next : r)))
  }
  function setRowProp(i, key, v) {
    const p = { ...(rows[i]?.properties || {}) }
    const empty =
      v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
    if (empty) delete p[key]
    else p[key] = v
    setRow(i, { ...rows[i], properties: p })
  }
  function addRow() {
    setRows([...rows, { name: '', properties: {} }])
  }
  function removeRow(i) {
    setRows(rows.filter((_, idx) => idx !== i))
  }

  // 행별 검증(백엔드 미러링).
  const rowErrors = rows.map((row) => {
    const errs = recordPropertyErrors(defs, row.properties || {})
    if (!row.name?.trim()) errs.unshift({ key: '__name', label: '이름', message: '필수' })
    return errs
  })
  const hasErrors = rowErrors.some((e) => e.length > 0)

  if (readOnly) {
    const filled = rows.filter(
      (r) => r.name || Object.keys(r.properties || {}).length > 0,
    )
    if (!axisSlug || filled.length === 0) {
      return (
        <p className="text-sm text-muted-foreground">(객체 레코드 표 — 미작성)</p>
      )
    }
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-1.5 text-xs">
          <Boxes className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-semibold">{axis?.label ?? axisSlug}</span>
          {props?.label && props.label !== '객체 레코드 표' && (
            <span className="text-muted-foreground">· {props.label}</span>
          )}
          <span className="text-muted-foreground">({filled.length}건)</span>
        </div>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="px-2 py-1 text-left font-medium">이름</th>
                {defs.map((d) => (
                  <th key={d.id} className="px-2 py-1 text-left font-medium">
                    {d.label}
                  </th>
                ))}
              </tr>
            </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-t">
                <td className="px-2 py-1">
                  {row.entity_id != null ? (
                    <Link
                      to={`/entities/${row.entity_id}`}
                      className="font-medium hover:underline"
                    >
                      {row.name}
                    </Link>
                  ) : (
                    <span className="font-medium">{row.name}</span>
                  )}
                </td>
                {defs.map((d) => (
                  <td key={d.id} className="px-2 py-1 text-muted-foreground">
                    {fmtCell(d, row.properties?.[d.key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {!lockedAxis && (
        <div className="flex items-center gap-2">
          <Label className="shrink-0 text-xs">객체 종류</Label>
          <select
            value={axisSlug}
            onChange={(e) =>
              onChange({ ...(content || {}), axis_slug: e.target.value, rows: [] })
            }
            className="h-8 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="">— 종류 선택 —</option>
            {axes.map((t) => (
              <option key={t.slug} value={t.slug}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
      )}
      {lockedAxis && axisSlug && (
        <div className="flex items-center gap-1.5 text-xs">
          <Boxes className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-semibold">{axis?.label ?? axisSlug}</span>
          <span className="text-muted-foreground">표</span>
        </div>
      )}

      {axisSlug ? (
        <>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="px-2 py-1 text-left font-medium">이름 *</th>
                  {defs.map((d) => (
                    <th key={d.id} className="px-2 py-1 text-left font-medium">
                      {d.label}
                      {d.required && <span className="text-amber-600"> *</span>}
                    </th>
                  ))}
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i} className="border-t align-top">
                    <td className="min-w-[10rem] px-1 py-1">
                      <RecordNamePicker
                        axisId={axis?.id}
                        name={row.name}
                        onPick={({ name: nm, entityId, properties: props }) =>
                          setRow(i, {
                            ...row,
                            name: nm,
                            entity_id: entityId,
                            ...(props !== undefined ? { properties: props } : {}),
                          })
                        }
                      />
                    </td>
                    {defs.map((d) => (
                      <td key={d.id} className="min-w-[9rem] px-1 py-1">
                        <PropertyValueInput
                          def={d}
                          value={row.properties?.[d.key]}
                          onChange={(v) => setRowProp(i, d.key, v)}
                        />
                      </td>
                    ))}
                    <td className="px-1 py-1">
                      <button
                        type="button"
                        onClick={() => removeRow(i)}
                        className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        title="행 삭제"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td
                      colSpan={defs.length + 2}
                      className="px-2 py-3 text-center text-xs text-muted-foreground"
                    >
                      행이 없습니다. 아래 「행 추가」로 시작하세요.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={addRow}>
            <Plus className="mr-1 h-3.5 w-3.5" /> 행 추가
          </Button>
          {hasErrors && (
            <div className="space-y-0.5 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-[11px] text-destructive">
              <div className="flex items-center gap-1 font-medium">
                <AlertTriangle className="h-3 w-3" /> 입력 확인 — 고쳐야 저장 시 객체가 만들어집니다
              </div>
              {rowErrors.map((errs, i) =>
                errs.length > 0 ? (
                  <div key={i}>
                    · {rows[i].name?.trim() || `${i + 1}행`}:{' '}
                    {errs.map((e) => `${e.label} ${e.message}`).join(', ')}
                  </div>
                ) : null,
              )}
            </div>
          )}
        </>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          종류를 먼저 고르면 표가 나타납니다.
        </p>
      )}
      <p className="text-[11px] text-muted-foreground">
        저장하면 각 행이 객체로 생성/갱신되고, 이 보고서가 근거로 남습니다.
      </p>
    </div>
  )
}

/** 템플릿 미리보기 — 빈 placeholder. */
export function RecordTablePreview({ props }) {
  return (
    <div className="rounded-md border border-dashed bg-muted/20 p-3 text-sm text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <Boxes className="h-4 w-4" /> 객체 레코드 표
        {props?.axis_slug ? ` (${props.axis_slug})` : ''} — 작성 시 행 추가
      </span>
    </div>
  )
}
