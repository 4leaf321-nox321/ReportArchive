import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { Textarea } from '@/shared/components/ui/textarea'
import { Badge } from '@/shared/components/ui/badge'
import { Button } from '@/shared/components/ui/button'
import { useAsync } from '@/shared/hooks/useAsync'
import { listEntities, listEntityTypes } from '@/shared/api/entities'

/**
 * 동적 속성 폼 (온톨로지 강화 A0.1 스텝3b). 축(entity_type)의 property_defs
 * 를 받아 data_type 별 입력 위젯을 렌더한다. 값은 위젯이 만드는 표현 그대로
 * (number/year 는 문자열, bool 은 boolean, entity_ref 는 id) `properties`
 * 객체에 담겨 저장 경로로 넘어가고, 최종 검증·정규화는 백엔드
 * `validate_properties` 가 한다(문자열 숫자도 coerce). 빈 값은 키를 지운다.
 *
 * 정의가 없으면(=대부분의 reference 축) 아무것도 렌더하지 않아 완전 additive.
 */
export function EntityPropertiesFields({ defs, value, onChange }) {
  if (!defs || defs.length === 0) return null
  const props = value ?? {}

  function setKey(key, v) {
    const next = { ...props }
    const empty =
      v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
    if (empty) delete next[key]
    else next[key] = v
    onChange(next)
  }

  return (
    <div className="space-y-3 rounded-md border bg-muted/20 p-3">
      <div className="text-xs font-medium text-muted-foreground">속성</div>
      {defs.map((d) => (
        <PropertyField
          key={d.id}
          def={d}
          value={props[d.key]}
          onChange={(v) => setKey(d.key, v)}
        />
      ))}
    </div>
  )
}

function PropertyField({ def, value, onChange }) {
  const labelEl = (
    <Label className="text-xs">
      {def.label}
      {def.unit && <span className="ml-1 text-muted-foreground">({def.unit})</span>}
      {def.required && <span className="ml-1 text-amber-600">*</span>}
    </Label>
  )
  const isMulti = def.multi && def.data_type !== 'bool'
  return (
    <div className="space-y-1">
      {labelEl}
      {isMulti ? (
        <MultiField
          def={def}
          value={Array.isArray(value) ? value : []}
          onChange={onChange}
        />
      ) : (
        <SingleWidget def={def} value={value} onChange={onChange} />
      )}
      {def.help && <p className="text-[11px] text-muted-foreground">{def.help}</p>}
    </div>
  )
}

/** data_type 별 단일 입력 위젯. number/year 는 문자열로 보관(백엔드가 coerce). */
function SingleWidget({ def, value, onChange }) {
  const dt = def.data_type

  if (dt === 'longtext') {
    return (
      <Textarea
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        maxLength={2000}
      />
    )
  }
  if (dt === 'bool') {
    return (
      <label className="flex cursor-pointer items-center gap-1.5 text-sm">
        <input
          type="checkbox"
          className="h-4 w-4 accent-primary"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
        {value === true ? '예' : '아니오'}
      </label>
    )
  }
  if (dt === 'enum') {
    const opts = (def.enum_options ?? []).map((o) =>
      typeof o === 'object' ? o : { value: o, label: o },
    )
    return (
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || undefined)}
        className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
      >
        <option value="">— 선택 —</option>
        {opts.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    )
  }
  if (dt === 'number') {
    return (
      <Input
        inputMode="decimal"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder="숫자"
      />
    )
  }
  if (dt === 'year') {
    return (
      <Input
        inputMode="numeric"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder="예: 2025"
      />
    )
  }
  if (dt === 'date') {
    return (
      <Input
        type="date"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || undefined)}
      />
    )
  }
  if (dt === 'entity_ref') {
    return <EntityRefPicker def={def} value={value} onChange={onChange} />
  }
  // text, url, 그 외
  return (
    <Input
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      placeholder={dt === 'url' ? 'https://' : ''}
      maxLength={255}
    />
  )
}

/** 배열 속성(multi). 기존 항목은 칩으로, draft 위젯 + 「추가」로 append. */
function MultiField({ def, value, onChange }) {
  const [draft, setDraft] = useState(def.data_type === 'entity_ref' ? undefined : '')

  function add() {
    if (draft === undefined || draft === null || draft === '') return
    if (value.some((v) => String(v) === String(draft))) {
      setDraft(def.data_type === 'entity_ref' ? undefined : '')
      return
    }
    onChange([...value, draft])
    setDraft(def.data_type === 'entity_ref' ? undefined : '')
  }

  function removeAt(i) {
    onChange(value.filter((_, idx) => idx !== i))
  }

  return (
    <div className="space-y-1.5">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {value.map((v, i) => (
            <Badge key={`${v}-${i}`} variant="secondary" className="gap-1 text-[11px]">
              {def.data_type === 'entity_ref' ? `#${v}` : String(v)}
              <button
                type="button"
                onClick={() => removeAt(i)}
                className="text-muted-foreground hover:text-foreground"
                aria-label="제거"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <SingleWidget def={def} value={draft} onChange={setDraft} />
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={add}
          disabled={draft === undefined || draft === null || draft === ''}
        >
          추가
        </Button>
      </div>
    </div>
  )
}

/**
 * entity_ref picker (스텝3b — picker만, 라벨 재조회는 Phase A). 대상 축을
 * q 로 검색해 하나 고르면 id 를 저장한다. 선택한 라벨은 세션 동안 기억해
 * 보여주고, 재마운트(편집 재진입) 시엔 검색 결과에서 매칭되면 라벨, 아니면
 * #id 로 표시한다. ref_type_slug 가 있으면 그 축으로만 검색을 제한.
 */
function EntityRefPicker({ def, value, onChange }) {
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState(null) // { id, label } — 세션 기억

  const { data: typesData } = useAsync(() => listEntityTypes(), [])
  const refTypeId = useMemo(() => {
    if (!def.ref_type_slug) return undefined
    return (typesData?.items ?? []).find((t) => t.slug === def.ref_type_slug)?.id
  }, [typesData, def.ref_type_slug])

  const { data: resData } = useAsync(
    () =>
      q.trim().length >= 1
        ? listEntities({ typeId: refTypeId, q: q.trim(), limit: 15 })
        : Promise.resolve({ items: [] }),
    [q, refTypeId],
  )
  const results = resData?.items ?? []

  if (value !== undefined && value !== null && value !== '') {
    const label = picked && String(picked.id) === String(value) ? picked.label : `#${value}`
    return (
      <div className="flex items-center gap-2">
        <Badge variant="secondary" className="gap-1 text-[11px]">
          {label}
          <button
            type="button"
            onClick={() => {
              onChange(undefined)
              setPicked(null)
            }}
            className="text-muted-foreground hover:text-foreground"
            aria-label="해제"
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      </div>
    )
  }

  return (
    <div className="space-y-1">
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={
          def.ref_type_slug ? `${def.ref_type_slug} 검색…` : '객체 검색…'
        }
      />
      {q.trim() && results.length > 0 && (
        <div className="max-h-40 overflow-y-auto rounded-md border">
          {results.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => {
                onChange(r.id)
                setPicked({ id: r.id, label: r.value })
                setQ('')
              }}
              className="flex w-full items-center gap-2 px-2 py-1 text-left text-sm hover:bg-accent"
            >
              <span className="font-medium">{r.value}</span>
              {r.code && (
                <code className="text-[11px] text-muted-foreground">{r.code}</code>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** 목록 행 요약 칩 — 정의된 속성 중 값이 있는 것만 「라벨:값」 으로 압축 표시.
 *  풍부한 표시는 Phase A 프로필 담당(설계 §7). entity_ref 는 #id. */
export function PropertiesSummary({ defs, properties }) {
  const items = useMemo(() => {
    const props = properties ?? {}
    const out = []
    for (const d of defs ?? []) {
      const raw = props[d.key]
      if (raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && raw.length === 0))
        continue
      out.push({ key: d.key, label: d.label, text: fmt(d, raw) })
    }
    return out
  }, [defs, properties])

  if (items.length === 0) return <span className="text-xs text-muted-foreground">—</span>
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((it) => (
        <span
          key={it.key}
          className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
        >
          <span className="text-foreground/70">{it.label}</span>: {it.text}
        </span>
      ))}
    </div>
  )
}

function fmt(def, raw) {
  const one = (v) => {
    if (def.data_type === 'entity_ref') return `#${v}`
    if (def.data_type === 'bool') return v === true ? '예' : '아니오'
    return String(v)
  }
  const body = Array.isArray(raw) ? raw.map(one).join(', ') : one(raw)
  return def.unit && def.data_type === 'number' ? `${body}${def.unit}` : body
}

/** EditDialog 의 저장 버튼 게이팅용 — 값이 빈 필수 속성 키 배열. */
export function missingRequiredProps(defs, properties) {
  const props = properties ?? {}
  const out = []
  for (const d of defs ?? []) {
    if (!d.required) continue
    const raw = props[d.key]
    if (raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && raw.length === 0))
      out.push(d.key)
  }
  return out
}
