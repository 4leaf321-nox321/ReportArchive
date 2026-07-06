import { useState } from 'react'
import { Plus, Pencil, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/shared/components/ui/dialog'
import { Badge } from '@/shared/components/ui/badge'
import { useAsync } from '@/shared/hooks/useAsync'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { ErrorState } from '@/shared/components/ErrorState'
import { Combobox } from '@/shared/components/Combobox'
import { listEntityTypes } from '@/shared/api/entities'

// 백엔드 PROPERTY_DATA_TYPES 와 일치.
const DATA_TYPES = [
  { value: 'text', label: '텍스트' },
  { value: 'longtext', label: '긴 텍스트' },
  { value: 'number', label: '숫자' },
  { value: 'date', label: '날짜(YYYY-MM-DD)' },
  { value: 'year', label: '연도' },
  { value: 'bool', label: '예/아니오' },
  { value: 'enum', label: '선택지(enum)' },
  { value: 'entity_ref', label: '다른 객체 참조' },
  { value: 'url', label: 'URL' },
]
const TYPE_LABEL = Object.fromEntries(DATA_TYPES.map((d) => [d.value, d.label]))

/**
 * 속성 정의를 관리하는 관리자 다이얼로그 (온톨로지 강화 A0). 소유자(owner)가
 * 축(entity_type, A0.1)이든 관계 종류(relation_type 링크, A0.2)든 동일하게 쓴다 —
 * 백엔드 property_defs 가 폴리모픽(owner_kind)이라 스키마·검증이 같기 때문.
 *
 * owner: {
 *   depKey,        // useAsync 재조회 키(안정 식별자, 예: type.id / rt.slug)
 *   label,         // 다이얼로그 제목의 대상 이름
 *   description,   // 설명 문구(문자열 or JSX)
 *   list()         → Promise<{ items }>   // 정의 목록
 *   create(payload)→ Promise              // payload = { key, ...def }
 *   update(defId, payload) → Promise
 *   remove(defId)  → Promise
 * }
 * 여기서 정의한 스키마로 해당 소유자의 properties 가 검증된다.
 */
export function PropertyDefsDialog({ owner, onClose, onChanged }) {
  const [reloadKey, setReloadKey] = useState(0)
  const [editing, setEditing] = useState(null) // null | 'new' | def object

  const { data, loading, error } = useAsync(
    () => owner.list(),
    [owner.depKey, reloadKey],
  )
  const defs = data?.items ?? []

  function reload() {
    setReloadKey((n) => n + 1)
    onChanged?.()
  }

  async function handleDelete(def) {
    if (!window.confirm(`'${def.label}' 속성 정의를 삭제할까요? (기존 값은 남습니다)`)) return
    try {
      await owner.remove(def.id)
      toast.success('속성 정의 삭제됨')
      reload()
    } catch (err) {
      toast.error(err?.response?.data?.message || err.message || '삭제 실패')
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>속성 정의 — {owner.label}</DialogTitle>
          <DialogDescription>{owner.description}</DialogDescription>
        </DialogHeader>

        {error ? (
          <ErrorState description={error.message} onRetry={reload} />
        ) : loading ? (
          <Skeleton className="h-40" />
        ) : editing ? (
          <PropertyDefForm
            owner={owner}
            def={editing === 'new' ? null : editing}
            onCancel={() => setEditing(null)}
            onSaved={() => {
              setEditing(null)
              reload()
            }}
          />
        ) : (
          <div className="space-y-2">
            {defs.length === 0 ? (
              <div className="rounded-md border bg-muted/30 px-3 py-6 text-center text-sm text-muted-foreground">
                아직 정의된 속성이 없습니다. 아래 「속성 추가」로 시작하세요.
              </div>
            ) : (
              <div className="divide-y rounded-md border">
                {defs.map((d) => (
                  <div key={d.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                    <span className="font-medium">{d.label}</span>
                    <code className="rounded bg-muted px-1 font-mono text-[11px] text-muted-foreground">
                      {d.key}
                    </code>
                    <Badge variant="secondary" className="text-[10px]">
                      {TYPE_LABEL[d.data_type] ?? d.data_type}
                    </Badge>
                    {d.unit && (
                      <span className="text-xs text-muted-foreground">단위 {d.unit}</span>
                    )}
                    {d.required && (
                      <Badge variant="outline" className="text-[10px] text-amber-700">
                        필수
                      </Badge>
                    )}
                    {d.multi && (
                      <Badge variant="outline" className="text-[10px]">다중</Badge>
                    )}
                    <div className="ml-auto flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
                        title="편집"
                        onClick={() => setEditing(d)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-destructive"
                        title="삭제"
                        onClick={() => handleDelete(d)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="flex justify-between pt-1">
              <Button variant="outline" size="sm" onClick={() => setEditing('new')}>
                <Plus className="mr-1 h-3.5 w-3.5" /> 속성 추가
              </Button>
              <Button variant="ghost" size="sm" onClick={onClose}>
                닫기
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function PropertyDefForm({ owner, def, onCancel, onSaved }) {
  const isEdit = Boolean(def)
  const [key, setKey] = useState(def?.key ?? '')
  const [label, setLabel] = useState(def?.label ?? '')
  const [dataType, setDataType] = useState(def?.data_type ?? 'text')
  const [unit, setUnit] = useState(def?.unit ?? '')
  const [required, setRequired] = useState(def?.required ?? false)
  const [multi, setMulti] = useState(def?.multi ?? false)
  const [enumText, setEnumText] = useState(
    (def?.enum_options ?? [])
      .map((o) => (typeof o === 'object' ? o.value : o))
      .join(', '),
  )
  const [refSlug, setRefSlug] = useState(def?.ref_type_slug ?? '')
  const [submitting, setSubmitting] = useState(false)

  // 참조 축 선택지 — slug 를 외우지 않게 라벨로 고르는 콤보박스. system 축은
  // listEntityTypes 가 기본 제외(entity_ref 는 실제 값이 있는 축만 가리킴).
  const { data: typesRes } = useAsync(() => listEntityTypes(), [])
  const axisOptions = [
    { value: '', label: '(제한 없음 — 아무 객체)' },
    ...(typesRes?.items ?? []).map((t) => ({ value: t.slug, label: t.label })),
  ]

  const keyValid = isEdit || /^[a-z][a-z0-9_]*$/.test(key)
  const canSubmit = keyValid && label.trim() && !submitting

  async function handleSubmit() {
    setSubmitting(true)
    try {
      const enum_options =
        dataType === 'enum'
          ? enumText
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
              .map((v) => ({ value: v, label: v }))
          : null
      const payload = {
        label: label.trim(),
        data_type: dataType,
        unit: unit.trim() || null,
        required,
        multi,
        enum_options,
        ref_type_slug: dataType === 'entity_ref' ? refSlug.trim() || null : null,
      }
      if (isEdit) {
        await owner.update(def.id, payload)
        toast.success('속성 정의 수정됨')
      } else {
        await owner.create({ key: key.trim(), ...payload })
        toast.success('속성 정의 추가됨')
      }
      onSaved()
    } catch (err) {
      toast.error(err?.response?.data?.message || err.message || '저장 실패')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs">키 (영문, 저장용){isEdit && ' — 변경 불가'}</Label>
          <Input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="material"
            disabled={isEdit}
            className={!keyValid && key ? 'border-destructive' : ''}
          />
          {!keyValid && key && (
            <p className="text-[11px] text-destructive">
              소문자로 시작하는 영문/숫자/밑줄만 가능
            </p>
          )}
        </div>
        <div className="space-y-1">
          <Label className="text-xs">표시명</Label>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="재질" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs">데이터 형식</Label>
          <select
            value={dataType}
            onChange={(e) => setDataType(e.target.value)}
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
          >
            {DATA_TYPES.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">단위 (선택)</Label>
          <Input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="kg" />
        </div>
      </div>

      {dataType === 'enum' && (
        <div className="space-y-1">
          <Label className="text-xs">선택지 (쉼표로 구분)</Label>
          <Input
            value={enumText}
            onChange={(e) => setEnumText(e.target.value)}
            placeholder="A, B, C"
          />
        </div>
      )}
      {dataType === 'entity_ref' && (
        <div className="space-y-1">
          <Label className="text-xs">참조 객체 종류 (비우면 아무 객체)</Label>
          <Combobox
            options={axisOptions}
            value={refSlug}
            onChange={(v) => setRefSlug(v || '')}
            placeholder="(제한 없음 — 아무 객체)"
            searchPlaceholder="객체 종류 검색..."
          />
          <p className="text-[11px] text-muted-foreground">
            이 속성이 가리킬 객체의 종류를 고릅니다. 비우면 어떤 종류든 참조 가능.
          </p>
        </div>
      )}

      <div className="flex items-center gap-4 text-sm">
        <label className="flex cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            className="h-4 w-4 accent-primary"
            checked={required}
            onChange={(e) => setRequired(e.target.checked)}
          />
          필수
        </label>
        <label className="flex cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            className="h-4 w-4 accent-primary"
            checked={multi}
            onChange={(e) => setMulti(e.target.checked)}
          />
          다중값(배열)
        </label>
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          <X className="mr-1 h-3.5 w-3.5" /> 취소
        </Button>
        <Button size="sm" onClick={handleSubmit} disabled={!canSubmit}>
          {submitting ? '저장 중...' : isEdit ? '수정' : '추가'}
        </Button>
      </div>
    </div>
  )
}
