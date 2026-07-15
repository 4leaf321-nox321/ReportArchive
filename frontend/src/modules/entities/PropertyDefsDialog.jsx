import { useMemo, useState } from 'react'
import { Plus, Pencil, Trash2, X, Table2, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { copyTextToClipboard } from '@/shared/lib/clipboard'
import { rowsToTsv } from '@/shared/lib/tableExport'
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
const TYPE_VALUES = new Set(DATA_TYPES.map((d) => d.value))
// 한글 라벨 → value (표 입력에서 '숫자','텍스트' 등도 받아들이게).
const LABEL_TO_TYPE = Object.fromEntries(
  DATA_TYPES.map((d) => [d.label.replace(/\(.*$/, '').trim(), d.value]),
)
const KEY_RE = /^[a-z][a-z0-9_]*$/

function parseType(raw) {
  const s = (raw || '').trim()
  if (!s) return 'text'
  if (TYPE_VALUES.has(s)) return s
  return LABEL_TO_TYPE[s] || null // 모르면 null → 그 행 무효
}

function parseBool(raw) {
  const s = (raw || '').trim().toLowerCase()
  return ['필수', 'y', 'yes', 'true', '1', 'o', '예'].includes(s)
}

// 표(그리드) 입력 열 정의 — 단건 폼과 같은 필드를 열로. extra=enum 옵션(쉼표) /
// entity_ref 대상 축 slug.
const BULK_COLS = [
  { id: 'key', label: '키', kind: 'text', placeholder: 'material' },
  { id: 'label', label: '표시명', kind: 'text', placeholder: '재질' },
  { id: 'data_type', label: '형식', kind: 'type' },
  { id: 'unit', label: '단위', kind: 'text', placeholder: 'kg' },
  { id: 'required', label: '필수', kind: 'bool' },
  { id: 'extra', label: '옵션/참조', kind: 'text', placeholder: 'A,B,C · 축slug' },
]
const BULK_START_ROWS = 4

function emptyRow() {
  return { key: '', label: '', data_type: 'text', unit: '', required: false, extra: '' }
}
function rowIsEmpty(r) {
  return !r.key.trim() && !r.label.trim() && !r.unit.trim() && !r.extra.trim()
}
function rowErrors(r) {
  const errs = []
  if (!KEY_RE.test(r.key.trim())) errs.push('키 형식')
  if (!r.label.trim()) errs.push('표시명 없음')
  if (r.data_type === 'enum') {
    const opts = r.extra.split(',').map((s) => s.trim()).filter(Boolean)
    if (opts.length === 0) errs.push('enum 옵션 없음')
  }
  return errs
}
function rowToPayload(r) {
  const enumOptions =
    r.data_type === 'enum'
      ? r.extra.split(',').map((s) => s.trim()).filter(Boolean)
          .map((v) => ({ value: v, label: v }))
      : null
  return {
    key: r.key.trim(),
    label: r.label.trim(),
    data_type: r.data_type,
    unit: r.unit.trim() || null,
    required: !!r.required,
    multi: false,
    enum_options: enumOptions,
    ref_type_slug: r.data_type === 'entity_ref' ? r.extra.trim() || null : null,
  }
}

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
        ) : editing === 'bulk' ? (
          <PropertyDefBulkForm
            owner={owner}
            onCancel={() => setEditing(null)}
            onDone={() => {
              setEditing(null)
              reload()
            }}
          />
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
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setEditing('new')}>
                  <Plus className="mr-1 h-3.5 w-3.5" /> 속성 추가
                </Button>
                <Button variant="outline" size="sm" onClick={() => setEditing('bulk')}>
                  <Table2 className="mr-1 h-3.5 w-3.5" /> 표로 입력
                </Button>
              </div>
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

/**
 * 여러 속성 정의를 표(편집 그리드)로 한꺼번에 추가. 단건 폼과 같은 입력을 열로
 * 두어(키·표시명·형식 드롭다운·단위·필수·옵션/참조) 직접 채우거나 엑셀에서 복사해
 * 셀에 붙여넣기(Ctrl+V)로 여러 행·열을 한 번에 채운다. 유효한(빈 행 제외) 행만
 * owner.create 로 순차 생성(행별 성공/실패 요약). EntityPasteDialog 그리드 패턴 참고.
 */
function PropertyDefBulkForm({ owner, onCancel, onDone }) {
  const [rows, setRows] = useState(() =>
    Array.from({ length: BULK_START_ROWS }, emptyRow),
  )
  const [submitting, setSubmitting] = useState(false)

  const { nonEmpty, validRows } = useMemo(() => {
    const ne = rows.filter((r) => !rowIsEmpty(r))
    return { nonEmpty: ne, validRows: ne.filter((r) => rowErrors(r).length === 0) }
  }, [rows])

  function setCell(ri, field, val) {
    setRows((prev) => prev.map((r, i) => (i === ri ? { ...r, [field]: val } : r)))
  }
  function addRow() {
    setRows((prev) => [...prev, emptyRow()])
  }
  function removeRow(ri) {
    setRows((prev) =>
      prev.length > 1 ? prev.filter((_, i) => i !== ri) : [emptyRow()],
    )
  }

  // 엑셀 붙여넣기 — 탭/줄바꿈 블록을 (ri,ci)부터 그리드에 채운다. 형식/필수 열은
  // 문자열을 해석(숫자→number, 필수→true). 단일 값이면 기본 붙여넣기(입력) 허용.
  function handlePaste(e, ri, ci) {
    const text = e.clipboardData.getData('text')
    if (!text || !/[\t\n]/.test(text)) return
    e.preventDefault()
    const lines = text.replace(/\r/g, '').split('\n')
    if (lines.length && lines[lines.length - 1] === '') lines.pop()
    // "표 복사"로 내보낸 헤더 줄을 그대로 다시 붙여넣으면 첫 줄이 열 이름이므로
    // 건너뛴다(0번 열에 붙여넣을 때만).
    if (ci === 0 && lines.length && lines[0].split('\t')[0].trim() === BULK_COLS[0].label) {
      lines.shift()
    }
    setRows((prev) => {
      const next = prev.map((r) => ({ ...r }))
      lines.forEach((line, li) => {
        const rr = ri + li
        while (next.length <= rr) next.push(emptyRow())
        line.split('\t').forEach((cell, cj) => {
          const col = BULK_COLS[ci + cj]
          if (!col) return
          if (col.id === 'data_type') {
            const t = parseType(cell)
            if (t) next[rr].data_type = t
          } else if (col.id === 'required') {
            next[rr].required = parseBool(cell)
          } else {
            next[rr][col.id] = cell
          }
        })
      })
      return next
    })
  }

  async function handleSubmit() {
    setSubmitting(true)
    let ok = 0
    const fails = []
    for (const r of validRows) {
      try {
        await owner.create(rowToPayload(r))
        ok++
      } catch (err) {
        fails.push(`${r.key}: ${err?.response?.data?.message || err.message || '실패'}`)
      }
    }
    if (ok > 0 && fails.length === 0) {
      toast.success(`${ok}개 속성 정의 추가됨`)
    } else if (ok > 0) {
      toast.success(`${ok}개 추가`, { description: `${fails.length}개 실패 — ${fails[0]}` })
    } else {
      toast.error('추가된 속성이 없습니다', {
        description: fails[0] || '유효한 행이 없습니다.',
      })
    }
    setSubmitting(false)
    onDone()
  }

  async function handleCopy() {
    const filled = rows.filter((r) => !rowIsEmpty(r))
    const src = filled.length ? filled : [emptyRow()] // 비어도 헤더+예시 1행
    const tsv = rowsToTsv(
      src.map((r) => [
        r.key,
        r.label,
        r.data_type,
        r.unit,
        r.required ? '필수' : '',
        r.extra,
      ]),
      BULK_COLS.map((c) => c.label),
    )
    try {
      await copyTextToClipboard(tsv)
      toast.success('표를 클립보드에 복사했습니다', {
        description: '엑셀에 붙여넣어 편집하거나, 다시 이 표에 붙여넣을 수 있습니다.',
      })
    } catch {
      toast.error('복사에 실패했습니다')
    }
  }

  const cellCls = 'h-7 w-full bg-transparent px-2 text-xs outline-none focus:bg-primary/5'
  const errCls = ' bg-destructive/10 text-destructive'

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-muted-foreground">
        여러 속성을 한꺼번에 입력하세요. 엑셀에서 복사해 셀에 붙여넣기(Ctrl+V)도 됩니다.
        형식이 <b>선택지(enum)</b>면 「옵션/참조」에 값들을 쉼표로, <b>다른 객체 참조</b>면
        대상 축 slug를 넣습니다.
      </p>

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="bg-muted/40">
              <th className="w-8 border-b px-1 py-1 text-muted-foreground">#</th>
              {BULK_COLS.map((c) => (
                <th key={c.id} className="border-b border-l px-2 py-1 text-left font-medium">
                  {c.label}
                </th>
              ))}
              <th className="w-8 border-b border-l" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => {
              const empty = rowIsEmpty(r)
              const keyBad = !empty && !KEY_RE.test(r.key.trim())
              const labelBad = !empty && !r.label.trim()
              const extraBad =
                !empty &&
                r.data_type === 'enum' &&
                r.extra.split(',').map((s) => s.trim()).filter(Boolean).length === 0
              return (
                <tr key={ri}>
                  <td className="px-1 text-center text-[10px] text-muted-foreground">
                    {ri + 1}
                  </td>
                  <td className="border-l p-0">
                    <input
                      value={r.key}
                      placeholder="material"
                      onChange={(e) => setCell(ri, 'key', e.target.value)}
                      onPaste={(e) => handlePaste(e, ri, 0)}
                      className={cellCls + (keyBad ? errCls : '')}
                      title={keyBad ? '소문자로 시작하는 영문/숫자/밑줄' : ''}
                    />
                  </td>
                  <td className="border-l p-0">
                    <input
                      value={r.label}
                      placeholder="재질"
                      onChange={(e) => setCell(ri, 'label', e.target.value)}
                      onPaste={(e) => handlePaste(e, ri, 1)}
                      className={cellCls + (labelBad ? errCls : '')}
                    />
                  </td>
                  <td className="border-l p-0">
                    <select
                      value={r.data_type}
                      onChange={(e) => setCell(ri, 'data_type', e.target.value)}
                      className="h-7 w-full min-w-[6rem] bg-transparent px-1 text-xs outline-none"
                    >
                      {DATA_TYPES.map((d) => (
                        <option key={d.value} value={d.value}>{d.label}</option>
                      ))}
                    </select>
                  </td>
                  <td className="border-l p-0">
                    <input
                      value={r.unit}
                      placeholder="kg"
                      onChange={(e) => setCell(ri, 'unit', e.target.value)}
                      onPaste={(e) => handlePaste(e, ri, 3)}
                      className={cellCls}
                    />
                  </td>
                  <td className="border-l p-0 text-center">
                    <input
                      type="checkbox"
                      checked={r.required}
                      onChange={(e) => setCell(ri, 'required', e.target.checked)}
                      className="h-3.5 w-3.5 accent-primary"
                    />
                  </td>
                  <td className="border-l p-0">
                    <input
                      value={r.extra}
                      placeholder={
                        r.data_type === 'enum'
                          ? 'A,B,C'
                          : r.data_type === 'entity_ref'
                            ? '축 slug'
                            : ''
                      }
                      disabled={r.data_type !== 'enum' && r.data_type !== 'entity_ref'}
                      onChange={(e) => setCell(ri, 'extra', e.target.value)}
                      onPaste={(e) => handlePaste(e, ri, 5)}
                      className={cellCls + (extraBad ? errCls : '') + ' disabled:opacity-40'}
                    />
                  </td>
                  <td className="border-l text-center">
                    <button
                      type="button"
                      onClick={() => removeRow(ri)}
                      className="text-muted-foreground hover:text-destructive"
                      title="행 삭제"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <div className="flex items-center justify-between border-t px-2 py-1">
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 text-[11px]"
              onClick={addRow}
            >
              <Plus className="mr-1 h-3 w-3" /> 행 추가
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 text-[11px]"
              onClick={handleCopy}
              title="현재 표를 클립보드에 복사(TSV) — 엑셀 편집·붙여넣기 왕복용"
            >
              <Copy className="mr-1 h-3 w-3" /> 표 복사
            </Button>
          </div>
          <span className="text-[10px] text-muted-foreground">
            엑셀에서 복사 후 셀에 붙여넣기 — 여러 행·열 한 번에
          </span>
        </div>
      </div>

      <div className="flex items-center justify-between pt-1">
        <span className="text-xs text-muted-foreground">
          {nonEmpty.length > 0
            ? `${validRows.length}개 추가 가능` +
              (nonEmpty.length - validRows.length > 0
                ? ` · ${nonEmpty.length - validRows.length}개 오류`
                : '')
            : '행을 채우면 추가할 수 있습니다.'}
        </span>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            <X className="mr-1 h-3.5 w-3.5" /> 취소
          </Button>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={submitting || validRows.length === 0}
          >
            {submitting ? '추가 중...' : `${validRows.length}개 추가`}
          </Button>
        </div>
      </div>
    </div>
  )
}
