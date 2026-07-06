import { useEffect, useMemo, useState } from 'react'
import { Upload, Plus, X, Loader2, CheckCircle2, AlertCircle } from 'lucide-react'
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
  inspectEntityImport,
  runEntityImport,
  listTypeProperties,
  listRelationTypes,
} from '@/shared/api/entities'

const SELECT_CLS =
  'h-8 rounded-md border bg-background px-2 text-xs min-w-0'

/**
 * 엔티티 벌크 임포트 (데이터 채우기 v1) — 엑셀/CSV 시트로 객체+속성+관계 시딩.
 * 흐름: 파일·축 선택 → 열 매핑(값·속성·관계) → 미리보기(dry_run) → 가져오기(커밋).
 * types = 대상 후보 축(record/reference). 커밋 성공 시 onImported() 로 목록 새로고침.
 */
export function EntityImportDialog({ open, onOpenChange, types, onImported }) {
  const [file, setFile] = useState(null)
  const [columns, setColumns] = useState([])
  const [rowCount, setRowCount] = useState(0)
  const [typeId, setTypeId] = useState('')
  const [valueColumn, setValueColumn] = useState('')
  const [propDefs, setPropDefs] = useState([])
  const [propMap, setPropMap] = useState({}) // propKey -> column
  const [relCols, setRelCols] = useState([]) // [{column, relation, target_type}]
  const [relTypes, setRelTypes] = useState([])
  const [preview, setPreview] = useState(null)
  const [busy, setBusy] = useState(false)

  // 다이얼로그 열릴 때 관계 종류 로드 + 상태 초기화.
  useEffect(() => {
    if (!open) return
    setFile(null); setColumns([]); setRowCount(0); setTypeId('')
    setValueColumn(''); setPropDefs([]); setPropMap({}); setRelCols([])
    setPreview(null)
    listRelationTypes().then((r) => setRelTypes(r?.items ?? [])).catch(() => {})
  }, [open])

  // 축 바뀌면 속성 정의 로드(속성 매핑 대상).
  useEffect(() => {
    if (!typeId) { setPropDefs([]); setPropMap({}); return }
    listTypeProperties(typeId)
      .then((r) => setPropDefs(r?.items ?? []))
      .catch(() => setPropDefs([]))
  }, [typeId])

  const recordTypes = useMemo(
    () => (types ?? []).filter((t) => t.kind_class !== 'system'),
    [types],
  )

  async function onPickFile(f) {
    setFile(f); setColumns([]); setPreview(null); setValueColumn('')
    if (!f) return
    setBusy(true)
    try {
      const d = await inspectEntityImport(f)
      setColumns(d.columns ?? [])
      setRowCount(d.row_count ?? 0)
      // 값 열 기본값 = 첫 열.
      if (d.columns?.length) setValueColumn(d.columns[0])
    } catch (e) {
      toast.error(e?.response?.data?.message || '파일을 읽지 못했습니다.')
    } finally {
      setBusy(false)
    }
  }

  function buildMapping(dryRun) {
    return {
      type_id: Number(typeId),
      value_column: valueColumn,
      property_columns: Object.fromEntries(
        Object.entries(propMap)
          .filter(([, col]) => col)
          .map(([key, col]) => [col, key]), // 백엔드는 헤더→key
      ),
      relation_columns: relCols.filter(
        (r) => r.column && r.relation && r.target_type,
      ),
      dry_run: dryRun,
    }
  }

  const canRun = file && typeId && valueColumn && !busy

  async function run(dryRun) {
    setBusy(true)
    try {
      const res = await runEntityImport(file, buildMapping(dryRun))
      setPreview(res)
      if (!dryRun) {
        const s = res.summary
        toast.success(
          `가져오기 완료 — 생성 ${s.create}, 갱신 ${s.update}, 링크 ${s.linked}` +
            (s.error ? `, 오류 ${s.error}` : ''),
        )
        onImported?.()
      }
    } catch (e) {
      toast.error(e?.response?.data?.message || '가져오기에 실패했습니다.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="h-4 w-4" /> 객체 가져오기 (엑셀·CSV)
          </DialogTitle>
          <DialogDescription>
            시트의 각 행을 선택한 종류의 객체로 만듭니다(값=이름, 지정 열=속성).
            관계열을 두면 대상 객체와 링크합니다. 먼저 미리보기로 확인하세요.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* 1. 파일 + 축 */}
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="file"
              accept=".csv,.xlsx"
              onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
              className="text-xs"
            />
            <select
              value={typeId}
              onChange={(e) => setTypeId(e.target.value)}
              className={SELECT_CLS}
            >
              <option value="">종류 선택…</option>
              {recordTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
            {columns.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {rowCount}행 · {columns.length}열
              </span>
            )}
          </div>

          {/* 2. 열 매핑 */}
          {columns.length > 0 && typeId && (
            <div className="space-y-3 rounded-md border p-3">
              <label className="flex items-center gap-2 text-xs">
                <span className="w-20 shrink-0 font-medium">값(이름)</span>
                <select
                  value={valueColumn}
                  onChange={(e) => setValueColumn(e.target.value)}
                  className={SELECT_CLS}
                >
                  {columns.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </label>

              {propDefs.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-[11px] font-medium text-muted-foreground">속성 매핑</p>
                  {propDefs.map((d) => (
                    <label key={d.key} className="flex items-center gap-2 text-xs">
                      <span className="w-20 shrink-0 truncate" title={d.label}>
                        {d.label}
                      </span>
                      <select
                        value={propMap[d.key] ?? ''}
                        onChange={(e) =>
                          setPropMap((m) => ({ ...m, [d.key]: e.target.value }))
                        }
                        className={SELECT_CLS}
                      >
                        <option value="">(사용 안 함)</option>
                        {columns.map((c) => (
                          <option key={c} value={c}>{c}</option>
                        ))}
                      </select>
                      <span className="text-[10px] text-muted-foreground">
                        {d.data_type}
                      </span>
                    </label>
                  ))}
                </div>
              )}

              {/* 관계 매핑 */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <p className="text-[11px] font-medium text-muted-foreground">
                    관계 매핑 (선택)
                  </p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 text-[11px]"
                    onClick={() =>
                      setRelCols((r) => [...r, { column: '', relation: '', target_type: '' }])
                    }
                  >
                    <Plus className="mr-1 h-3 w-3" /> 관계열 추가
                  </Button>
                </div>
                {relCols.map((rc, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-1.5 text-xs">
                    <select
                      value={rc.column}
                      onChange={(e) => updateRel(setRelCols, i, { column: e.target.value })}
                      className={SELECT_CLS}
                    >
                      <option value="">열…</option>
                      {columns.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                    <span className="text-muted-foreground">→</span>
                    <select
                      value={rc.relation}
                      onChange={(e) => updateRel(setRelCols, i, { relation: e.target.value })}
                      className={SELECT_CLS}
                    >
                      <option value="">관계…</option>
                      {relTypes.map((t) => (
                        <option key={t.slug} value={t.slug}>{t.label}</option>
                      ))}
                    </select>
                    <select
                      value={rc.target_type}
                      onChange={(e) => updateRel(setRelCols, i, { target_type: e.target.value })}
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
            </div>
          )}

          {/* 3. 미리보기 결과 */}
          {preview && <PreviewResult preview={preview} />}

          {/* 액션 */}
          {columns.length > 0 && typeId && (
            <div className="flex items-center justify-end gap-2">
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
                가져오기
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function updateRel(setRelCols, i, patch) {
  setRelCols((r) => r.map((row, j) => (j === i ? { ...row, ...patch } : row)))
}

function PreviewResult({ preview }) {
  const s = preview.summary ?? {}
  return (
    <div className="rounded-md border">
      <div className="flex flex-wrap gap-3 border-b bg-muted/30 px-3 py-2 text-[11px]">
        <span>총 {s.total}행</span>
        <span className="text-green-600 dark:text-green-400">생성 {s.create}</span>
        <span className="text-blue-600 dark:text-blue-400">갱신 {s.update}</span>
        {s.linked > 0 && <span>링크 {s.linked}</span>}
        {s.link_unresolved > 0 && (
          <span className="text-amber-600 dark:text-amber-400">
            링크 미해결 {s.link_unresolved}
          </span>
        )}
        {s.error > 0 && <span className="text-destructive">오류 {s.error}</span>}
        <span className="ml-auto text-muted-foreground">
          {s.committed ? '커밋됨' : '미리보기(쓰기 없음)'}
        </span>
      </div>
      <div className="max-h-56 overflow-y-auto">
        <table className="w-full text-[11px]">
          <tbody>
            {(preview.rows ?? []).map((r) => (
              <tr key={r.row} className="border-b last:border-0">
                <td className="w-8 px-2 py-1 text-center text-muted-foreground">{r.row}</td>
                <td className="px-2 py-1">
                  {r.status === 'error' ? (
                    <AlertCircle className="inline h-3 w-3 text-destructive" />
                  ) : (
                    <CheckCircle2 className="inline h-3 w-3 text-green-600 dark:text-green-400" />
                  )}
                </td>
                <td className="px-2 py-1 font-medium">{r.value || '—'}</td>
                <td className="px-2 py-1 text-muted-foreground">
                  {r.status === 'error'
                    ? r.messages?.join(' ')
                    : r.relations
                        ?.map((rel) =>
                          rel.resolved ? `→${rel.target}` : `→${rel.target}?`,
                        )
                        .join(' ')}
                  {r.messages?.length > 0 && r.status !== 'error' && (
                    <span className="text-amber-600 dark:text-amber-400">
                      {' '}
                      {r.messages.join(' ')}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
