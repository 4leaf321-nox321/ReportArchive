// 객체 레코드 위젯 (온톨로지 A0.3 입력경로). 작성자가 record 축(시험실행·실패사례
// 등)을 고르고 이름+속성을 채우면, 보고서 저장 시 백엔드 훅이 그 값으로 entity
// 객체를 upsert 하고 entity_id 를 content 에 되심는다. 위젯은 그 객체의 인-컨텍스트
// 편집기 — content = { axis_slug, name, properties, entity_id }.
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Boxes, ArrowUpRight } from 'lucide-react'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { Badge } from '@/shared/components/ui/badge'
import { useAsync } from '@/shared/hooks/useAsync'
import {
  listEntities,
  listEntityTypes,
  listTypeProperties,
} from '@/shared/api/entities'
import {
  EntityPropertiesFields,
  PropertiesSummary,
  recordPropertyErrors,
} from '@/modules/entities/EntityPropertiesFields'
import { AlertTriangle } from 'lucide-react'

export function useRecordAxes() {
  const { data } = useAsync(() => listEntityTypes(), [])
  const items = data?.items ?? []
  return items.filter((t) => t.kind_class === 'record')
}

export function useAxisDefs(axis) {
  const { data } = useAsync(
    () => (axis?.id ? listTypeProperties(axis.id) : Promise.resolve({ items: [] })),
    [axis?.id],
  )
  return data?.items ?? []
}

/**
 * 이름 = 검색 콤보박스. 열면 그 축의 기존 객체 목록이 뜨고, 검색해 고르면 **기존
 * 객체에 연결**(entity_id + 그 객체의 속성까지 불러옴 — 저장 시 덮어쓰기 사고 방지).
 * 목록에 없는 이름을 입력하면 entity_id 를 비워 **저장 시 새 객체로 생성**한다.
 *   onPick({ name, entityId, properties? })  — properties 는 기존 선택 시에만.
 */
export function RecordNamePicker({ axisId, name, onPick }) {
  const [open, setOpen] = useState(false)
  const q = name ?? ''
  const { data } = useAsync(
    () =>
      open && axisId
        ? listEntities({ typeId: axisId, q: q.trim() || undefined, limit: 20 })
        : Promise.resolve({ items: [] }),
    [open, q, axisId],
  )
  const results = data?.items ?? []
  const exact = results.some(
    (r) => String(r.value).trim().toLowerCase() === q.trim().toLowerCase(),
  )

  return (
    <div className="relative">
      <Input
        value={q}
        onChange={(e) => onPick({ name: e.target.value, entityId: null })}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="이름 검색 또는 새로 입력…"
      />
      {open && (results.length > 0 || q.trim()) && (
        <div className="absolute z-20 mt-1 max-h-44 w-full overflow-y-auto rounded-md border bg-popover shadow-md">
          {results.map((r) => (
            <button
              key={r.id}
              type="button"
              // onMouseDown: input blur 보다 먼저 실행돼 선택이 안전하게 등록.
              onMouseDown={(e) => {
                e.preventDefault()
                onPick({ name: r.value, entityId: r.id, properties: r.properties || {} })
                setOpen(false)
              }}
              className="flex w-full items-center justify-between gap-2 px-2 py-1 text-left text-sm hover:bg-accent"
            >
              <span className="truncate">{r.value}</span>
              <Badge variant="outline" className="shrink-0 text-[9px]">
                기존
              </Badge>
            </button>
          ))}
          {q.trim() && !exact && (
            <div className="border-t px-2 py-1 text-[11px] text-muted-foreground">
              「{q.trim()}」 — 저장 시 <strong>새 객체</strong>로 생성
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** 템플릿 설정 — 라벨 + (선택) 축 고정. 축을 고정하면 작성자는 못 바꾼다. */
export function RecordPropsPanel({ props, onChange }) {
  const axes = useRecordAxes()
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label className="text-xs">라벨</Label>
        <Input
          value={props?.label ?? ''}
          onChange={(e) => onChange({ ...props, label: e.target.value })}
          placeholder="객체 레코드"
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">객체 종류 고정 (선택)</Label>
        <select
          value={props?.axis_slug ?? ''}
          onChange={(e) =>
            onChange({ ...props, axis_slug: e.target.value || undefined })
          }
          className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
        >
          <option value="">작성자가 선택</option>
          {axes.map((t) => (
            <option key={t.slug} value={t.slug}>
              {t.label}
            </option>
          ))}
        </select>
        <p className="text-[11px] text-muted-foreground">
          고정하면 이 위젯은 항상 그 종류의 객체를 기록합니다.
        </p>
      </div>
    </div>
  )
}

/** 작성/표시 겸용. readOnly 면 채워진 속성 카드 + 객체 프로필 링크를 렌더한다. */
export function RecordEditor({ props, content, onChange, readOnly }) {
  const lockedAxis = props?.axis_slug || ''
  const axisSlug = content?.axis_slug || lockedAxis || ''
  const name = content?.name || ''
  const properties = content?.properties || {}
  const entityId = content?.entity_id ?? null

  const axes = useRecordAxes()
  const axis = axes.find((t) => t.slug === axisSlug) || null
  const defs = useAxisDefs(axis)
  // 입력 즉시 형식 검증(백엔드 validate_properties 미러링) — 저장 때까지 미루지 않는다.
  const errors = axisSlug ? recordPropertyErrors(defs, properties) : []
  const nameMissing = !!axisSlug && !name.trim()

  function patch(next) {
    onChange({ ...(content || {}), ...next })
  }

  if (readOnly) {
    if (!axisSlug || !name) {
      return (
        <p className="text-sm text-muted-foreground">
          (객체 레코드 — 미작성)
        </p>
      )
    }
    return (
      <div className="rounded-lg border bg-card p-3">
        <div className="flex items-center gap-2">
          <Boxes className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">
            {axis?.label ?? axisSlug}
          </span>
          {entityId != null ? (
            <Link
              to={`/entities/${entityId}`}
              className="group inline-flex items-center gap-1 font-medium hover:underline"
            >
              {name}
              <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100" />
            </Link>
          ) : (
            <span className="font-medium">{name}</span>
          )}
        </div>
        {defs.length > 0 && (
          <div className="mt-2">
            <PropertiesSummary defs={defs} properties={properties} />
          </div>
        )}
        {errors.length > 0 && (
          <div className="mt-2 flex items-center gap-1 text-[11px] text-destructive">
            <AlertTriangle className="h-3 w-3" /> 입력 오류 — 편집해서 고쳐주세요
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {!lockedAxis && (
        <div className="space-y-1">
          <Label className="text-xs">객체 종류</Label>
          <select
            value={axisSlug}
            onChange={(e) =>
              patch({ axis_slug: e.target.value, properties: {} })
            }
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
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
      <div className="space-y-1">
        <Label className="text-xs">
          이름 <span className="text-amber-600">*</span>
        </Label>
        <RecordNamePicker
          axisId={axis?.id}
          name={name}
          onPick={({ name: nm, entityId, properties: props }) =>
            patch({
              name: nm,
              entity_id: entityId,
              ...(props !== undefined ? { properties: props } : {}),
            })
          }
        />
      </div>
      {axisSlug ? (
        <EntityPropertiesFields
          defs={defs}
          value={properties}
          onChange={(p) => patch({ properties: p })}
        />
      ) : (
        <p className="text-[11px] text-muted-foreground">
          종류를 먼저 고르면 속성 입력란이 나타납니다.
        </p>
      )}
      {(nameMissing || errors.length > 0) && (
        <div className="space-y-0.5 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-[11px] text-destructive">
          <div className="flex items-center gap-1 font-medium">
            <AlertTriangle className="h-3 w-3" /> 입력 확인 — 고쳐야 저장 시 객체가 만들어집니다
          </div>
          {nameMissing && <div>· 이름을 입력하세요</div>}
          {errors.map((e) => (
            <div key={e.key}>
              · {e.label}: {e.message}
            </div>
          ))}
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">
        저장하면 이 값으로 객체가 생성/갱신되고, 이 보고서가 근거로 남습니다.
      </p>
    </div>
  )
}

/** 템플릿 미리보기 — 빈 placeholder. */
export function RecordPreview({ props }) {
  return (
    <div className="rounded-md border border-dashed bg-muted/20 p-3 text-sm text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <Boxes className="h-4 w-4" /> 객체 레코드
        {props?.axis_slug ? ` (${props.axis_slug})` : ''} — 작성 시 이름·속성 입력
      </span>
    </div>
  )
}
