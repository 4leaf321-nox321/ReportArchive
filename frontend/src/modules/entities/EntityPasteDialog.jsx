import { useEffect, useMemo, useState } from 'react'
import { ClipboardPaste, Plus, X, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/shared/components/ui/dialog'
import {
  importEntityRows,
  listTypeProperties,
  listRelationTypes,
} from '@/shared/api/entities'
import { ImportPreviewResult } from './EntityImportDialog'

const SELECT_CLS = 'h-8 rounded-md border bg-background px-2 text-xs min-w-0'
const START_ROWS = 4

/**
 * 셀 값 클라이언트 검증 — 백엔드 _validate_one 을 정확히 미러(오탐 방지). 빈 값은
 * 통과(미설정). number/year/date/enum 만 판정(그 외는 백엔드에 위임). 오류 시 메시지.
 */
function validateCell(cd, value) {
  const v = (value ?? '').trim()
  if (!v || cd.kind !== 'prop') return null
  if (cd.dataType === 'number') {
    if (v === '' || Number.isNaN(Number(v))) return `${cd.label}: 숫자여야 합니다`
  } else if (cd.dataType === 'year') {
    if (!/^-?\d+$/.test(v)) return `${cd.label}: 연도(정수)여야 합니다`
    const n = parseInt(v, 10)
    if (n < 1900 || n > 2200) return `${cd.label}: 연도 범위(1900~2200)`
  } else if (cd.dataType === 'date') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
    if (!m) return `${cd.label}: YYYY-MM-DD 형식`
    const d = new Date(+m[1], +m[2] - 1, +m[3])
    if (d.getFullYear() !== +m[1] || d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3])
      return `${cd.label}: 유효한 날짜가 아닙니다`
  } else if (cd.dataType === 'enum' && cd.enumValues) {
    if (!cd.enumValues.includes(v))
      return `${cd.label}: 허용값 아님 (${cd.enumValues.join('/')})`
  }
  return null
}

/**
 * 그리드 셀 — 타입별 입력 위젯. enum=드롭다운, date=날짜픽커, number/year=숫자입력,
 * 그 외=텍스트. 붙여넣은 이상값(위젯이 표현 못하는)은 빨간 텍스트로 노출해 고치게
 * 한다(적응형). 붙여넣기는 모든 텍스트/숫자/날짜 입력에서 동작(select 제외).
 */
function GridCell({ cd, value, onChange, onPaste }) {
  const err = validateCell(cd, value)
  const base = 'h-7 w-full min-w-[7rem] bg-transparent px-2 text-xs outline-none'
  const cls =
    base +
    (err
      ? ' bg-destructive/10 text-destructive focus:bg-destructive/15'
      : ' focus:bg-primary/5')
  const dt = cd.kind === 'prop' ? cd.dataType : 'text'

  if (dt === 'enum') {
    const opts = cd.enumValues ?? []
    const invalid = value && !opts.includes(value)
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)} className={cls}>
        <option value="" />
        {opts.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
        {invalid && <option value={value}>{value} (허용 안 됨)</option>}
      </select>
    )
  }
  // 유효/빈 값이면 타입 위젯, 붙여넣은 이상값이면 빨간 텍스트로 노출(고치게).
  if (dt === 'date' && !err) {
    return (
      <input type="date" value={value} onChange={(e) => onChange(e.target.value)}
             onPaste={onPaste} className={cls} />
    )
  }
  if ((dt === 'number' || dt === 'year') && !err) {
    return (
      <input type="number" value={value} onChange={(e) => onChange(e.target.value)}
             onPaste={onPaste} className={cls} />
    )
  }
  return (
    <input value={value} onChange={(e) => onChange(e.target.value)}
           onPaste={onPaste} title={err || ''} className={cls} />
  )
}

/**
 * 붙여넣기(표) 입력 모달 — 엑셀에서 복사한 여러 행을 그리드에 붙여넣어 한꺼번에
 * 객체 등록. 열은 선택한 종류로부터 자동 구성(이름 + 속성) + 관계열 추가 가능.
 * 미리보기(dry_run)로 확인 후 저장. 백엔드는 파일 임포트와 같은 run_import 재사용.
 */
export function EntityPasteDialog({ open, onOpenChange, types, fixedType, onImported }) {
  const [typeId, setTypeId] = useState('')
  const [propDefs, setPropDefs] = useState([])
  const [relCols, setRelCols] = useState([]) // [{relation, target_type}]
  const [relTypes, setRelTypes] = useState([])
  const [grid, setGrid] = useState([]) // rows of cell strings
  const [preview, setPreview] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setTypeId(fixedType ? String(fixedType.id) : '')
    setPropDefs([]); setRelCols([]); setPreview(null)
    setGrid(Array.from({ length: START_ROWS }, () => []))
    listRelationTypes().then((r) => setRelTypes(r?.items ?? [])).catch(() => {})
  }, [open, fixedType?.id])

  useEffect(() => {
    if (!typeId) { setPropDefs([]); return }
    setPreview(null)
    listTypeProperties(typeId)
      .then((r) => setPropDefs(r?.items ?? []))
      .catch(() => setPropDefs([]))
  }, [typeId])

  const recordTypes = useMemo(
    () => (types ?? []).filter((t) => t.kind_class !== 'system'),
    [types],
  )
  const typeLabel = (slug) =>
    recordTypes.find((t) => t.slug === slug)?.label ?? slug
  const relLabel = (slug) =>
    relTypes.find((t) => t.slug === slug)?.label ?? slug

  // 완성된 관계열만 그리드 열로. 열 순서 = 이름 + 속성 + 관계.
  const completeRels = relCols.filter((r) => r.relation && r.target_type)
  const colDefs = useMemo(() => {
    const cols = [{ id: 'c0', label: '이름', kind: 'value' }]
    propDefs.forEach((d, i) =>
      cols.push({ id: `c${i + 1}`, label: d.label, kind: 'prop',
                  propKey: d.key, dataType: d.data_type,
                  enumValues: d.data_type === 'enum'
                    ? (d.enum_options ?? []).map((o) => o.value) : null }))
    completeRels.forEach((rc, i) =>
      cols.push({
        id: `c${propDefs.length + 1 + i}`, kind: 'rel',
        label: `${relLabel(rc.relation)}→${typeLabel(rc.target_type)}`,
        relation: rc.relation, target_type: rc.target_type,
      }))
    return cols
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propDefs, completeRels, relTypes, recordTypes])
  const numCols = colDefs.length

  function setCell(r, c, val) {
    setGrid((prev) => {
      const next = prev.map((row) => [...row])
      while (next.length <= r) next.push([])
      while (next[r].length < numCols) next[r].push('')
      next[r][c] = val
      return next
    })
  }

  function handlePaste(e, r, c) {
    const text = e.clipboardData.getData('text')
    if (!text) return
    // 단일 값이든 표 블록이든 항상 그리드 상태에 채운다(셀 위젯 종류 무관하게 일관).
    e.preventDefault()
    const lines = text.replace(/\r/g, '').split('\n')
    if (lines.length && lines[lines.length - 1] === '') lines.pop()
    setGrid((prev) => {
      const next = prev.map((row) => {
        const nr = [...row]
        while (nr.length < numCols) nr.push('')
        return nr
      })
      lines.forEach((line, i) => {
        const rr = r + i
        while (next.length <= rr) next.push(Array(numCols).fill(''))
        line.split('\t').forEach((cell, j) => {
          const cc = c + j
          if (cc < numCols) next[rr][cc] = cell
        })
      })
      return next
    })
  }

  function buildPayload(dryRun) {
    const rows = grid
      .map((row) => colDefs.map((_, c) => (row[c] ?? '').trim()))
      .filter((row) => row.some((cell) => cell !== ''))
    const property_columns = {}
    const relation_columns = []
    colDefs.forEach((cd) => {
      if (cd.kind === 'prop') property_columns[cd.id] = cd.propKey
      if (cd.kind === 'rel')
        relation_columns.push({ column: cd.id, relation: cd.relation,
                                target_type: cd.target_type })
    })
    return {
      columns: colDefs.map((c) => c.id),
      rows,
      mapping: {
        type_id: Number(typeId), value_column: 'c0',
        property_columns, relation_columns, dry_run: dryRun,
      },
    }
  }

  const filledRows = grid.filter((row) =>
    row.some((c) => (c ?? '').trim() !== ''),
  ).length
  const cellErrors = grid.reduce(
    (acc, row) =>
      acc + colDefs.filter((cd, c) => validateCell(cd, row[c] ?? '')).length,
    0,
  )
  const canRun = typeId && filledRows > 0 && !busy

  async function run(dryRun) {
    setBusy(true)
    try {
      const res = await importEntityRows(buildPayload(dryRun))
      setPreview(res)
      if (!dryRun) {
        const s = res.summary
        toast.success(
          `저장 완료 — 생성 ${s.create}, 갱신 ${s.update}, 링크 ${s.linked}` +
            (s.error ? `, 오류 ${s.error}` : ''),
        )
        onImported?.()
      }
    } catch (e) {
      toast.error(e?.response?.data?.message || '저장에 실패했습니다.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardPaste className="h-4 w-4" /> 표로 입력 (붙여넣기)
          </DialogTitle>
          <DialogDescription>
            엑셀에서 여러 행을 복사해 아래 표에 붙여넣으면 한꺼번에 등록됩니다. 열은
            선택한 종류의 속성으로 구성됩니다. 저장 전 미리보기로 확인하세요.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* 종류 + 관계열 */}
          <div className="flex flex-wrap items-center gap-2">
            {fixedType ? (
              <span className="rounded-md border bg-muted/40 px-2.5 py-1 text-xs font-medium">
                {fixedType.label}
              </span>
            ) : (
              <select
                value={typeId}
                onChange={(e) => setTypeId(e.target.value)}
                className={SELECT_CLS}
              >
                <option value="">종류 선택…</option>
                {recordTypes.map((t) => (
                  <option key={t.id} value={t.id}>{t.label}</option>
                ))}
              </select>
            )}
            {typeId && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-[11px]"
                onClick={() =>
                  setRelCols((r) => [...r, { relation: '', target_type: '' }])
                }
              >
                <Plus className="mr-1 h-3 w-3" /> 관계열 추가
              </Button>
            )}
          </div>

          {/* 관계열 설정 */}
          {relCols.length > 0 && (
            <div className="space-y-1.5 rounded-md border p-2">
              {relCols.map((rc, i) => (
                <div key={i} className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="text-muted-foreground">관계열</span>
                  <select
                    value={rc.relation}
                    onChange={(e) =>
                      setRelCols((r) => r.map((x, j) => j === i ? { ...x, relation: e.target.value } : x))
                    }
                    className={SELECT_CLS}
                  >
                    <option value="">관계…</option>
                    {relTypes.map((t) => (
                      <option key={t.slug} value={t.slug}>{t.label}</option>
                    ))}
                  </select>
                  <select
                    value={rc.target_type}
                    onChange={(e) =>
                      setRelCols((r) => r.map((x, j) => j === i ? { ...x, target_type: e.target.value } : x))
                    }
                    className={SELECT_CLS}
                  >
                    <option value="">대상 종류…</option>
                    {recordTypes.map((t) => (
                      <option key={t.id} value={t.slug}>{t.label}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => setRelCols((r) => r.filter((_, j) => j !== i))}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* 그리드 */}
          {typeId && (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="bg-muted/40">
                    <th className="w-8 border-b px-1 py-1 text-muted-foreground">#</th>
                    {colDefs.map((cd) => (
                      <th key={cd.id} className="border-b border-l px-2 py-1 text-left font-medium">
                        {cd.label}
                        {cd.kind === 'prop' && (
                          <span className="ml-1 text-[10px] font-normal text-muted-foreground">
                            {cd.dataType}
                          </span>
                        )}
                      </th>
                    ))}
                    <th className="w-8 border-b border-l" />
                  </tr>
                </thead>
                <tbody>
                  {grid.map((row, r) => (
                    <tr key={r}>
                      <td className="px-1 py-0.5 text-center text-[10px] text-muted-foreground">
                        {r + 1}
                      </td>
                      {colDefs.map((cd, c) => (
                        <td key={cd.id} className="border-l p-0">
                          <GridCell
                            cd={cd}
                            value={row[c] ?? ''}
                            onChange={(v) => setCell(r, c, v)}
                            onPaste={(e) => handlePaste(e, r, c)}
                          />
                        </td>
                      ))}
                      <td className="border-l text-center">
                        <button
                          type="button"
                          onClick={() => setGrid((g) => g.filter((_, j) => j !== r))}
                          className="text-muted-foreground hover:text-destructive"
                          title="행 삭제"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex items-center justify-between border-t px-2 py-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 text-[11px]"
                  onClick={() => setGrid((g) => [...g, []])}
                >
                  <Plus className="mr-1 h-3 w-3" /> 행 추가
                </Button>
                <span className="text-[10px] text-muted-foreground">
                  엑셀에서 복사 후 셀에 붙여넣기(Ctrl+V) — 여러 행·열 한 번에
                </span>
              </div>
            </div>
          )}

          {preview && <ImportPreviewResult preview={preview} />}

          {typeId && (
            <div className="flex items-center justify-end gap-2">
              <span className="mr-auto text-[11px] text-muted-foreground">
                입력된 {filledRows}행
                {cellErrors > 0 && (
                  <span className="ml-2 text-destructive">
                    · 형식 오류 {cellErrors}칸
                  </span>
                )}
              </span>
              <Button variant="outline" size="sm" disabled={!canRun} onClick={() => run(true)}>
                {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                미리보기
              </Button>
              <Button
                size="sm"
                disabled={!canRun || !preview || preview.summary?.committed}
                onClick={() => run(false)}
                title={!preview ? '먼저 미리보기로 확인하세요' : ''}
              >
                저장
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
