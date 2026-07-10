import { useEffect, useMemo, useState } from 'react'
import { RotateCcw, AlertTriangle, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Badge } from '@/shared/components/ui/badge'
import { getAiSettings, updateAiSettings, resetAiSetting } from '@/shared/api/ai'

/**
 * "검색 튜닝" 탭 — 시스템 관리자 전용. AI 검색 임계·토글을 재시작 없이 바꾼다.
 * `.env` 는 기본값이고, 여기서 바꾸면 DB override(app_settings)가 우선한다.
 * 색인 시점 설정(requires_reindex)은 변경해도 기존 보고서엔 재색인해야 반영 →
 * "재색인 필요" 배지로 경고한다.
 */
export function SearchTuningTab() {
  const [rows, setRows] = useState(null) // null=loading
  const [draft, setDraft] = useState({}) // key -> 편집 중 값
  const [saving, setSaving] = useState(false)

  const load = async () => {
    try {
      const data = await getAiSettings()
      setRows(data?.settings || [])
      setDraft({})
    } catch {
      setRows([])
    }
  }
  useEffect(() => {
    load()
  }, [])

  // 편집값(draft) 우선, 없으면 서버값.
  const valueOf = (r) => (r.key in draft ? draft[r.key] : r.value)
  const isDirty = (r) => r.key in draft && draft[r.key] !== r.value

  const { dirtyKeys, dirtyNeedsReindex } = useMemo(() => {
    const keys = []
    let reindex = false
    for (const r of rows || []) {
      if (r.key in draft && draft[r.key] !== r.value) {
        keys.push(r.key)
        if (r.requires_reindex) reindex = true
      }
    }
    return { dirtyKeys: keys, dirtyNeedsReindex: reindex }
  }, [rows, draft])

  const setDraftVal = (key, v) => setDraft((d) => ({ ...d, [key]: v }))

  const save = async () => {
    const changes = {}
    for (const r of rows) if (isDirty(r)) changes[r.key] = valueOf(r)
    if (!Object.keys(changes).length) return
    setSaving(true)
    try {
      const res = await updateAiSettings(changes)
      const reindex = res?.requires_reindex || []
      toast.success(
        '설정을 적용했습니다.' +
          (reindex.length ? ' 재색인해야 반영되는 항목이 있습니다.' : ''),
      )
      await load()
    } catch (e) {
      toast.error(e?.response?.data?.message || '설정 적용에 실패했습니다.')
    } finally {
      setSaving(false)
    }
  }

  const reset = async (key) => {
    try {
      await resetAiSetting(key)
      toast.success('기본값으로 되돌렸습니다.')
      await load()
    } catch {
      toast.error('되돌리기에 실패했습니다.')
    }
  }

  if (rows === null) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> 불러오는 중…
      </div>
    )
  }

  // 그룹별로 묶어 표시.
  const groups = {}
  for (const r of rows) (groups[r.group] ||= []).push(r)

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          AI 검색 동작을 <b>재시작 없이</b> 조정합니다. 여기서 바꾼 값은{' '}
          <code>.env</code> 기본값보다 우선하며, 최대 1분 안에 반영됩니다.
          <br />
          <span className="inline-flex items-center gap-1 text-amber-600">
            <AlertTriangle className="h-3.5 w-3.5" />
            &ldquo;재색인 필요&rdquo; 표시된 항목은 <b>기존 보고서엔 재색인해야</b>{' '}
            반영됩니다(새 글·수정 글은 자동).
          </span>
        </p>
        <Button size="sm" onClick={save} disabled={saving || !dirtyKeys.length}>
          {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
          저장{dirtyKeys.length ? ` (${dirtyKeys.length})` : ''}
        </Button>
      </div>

      {dirtyNeedsReindex && (
        <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/30">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          변경한 항목 중 <b>색인 시점 설정</b>이 있습니다 — 저장 후{' '}
          <b>임베딩 재색인</b>을 돌려야 기존 보고서에 반영됩니다.
        </div>
      )}

      {Object.entries(groups).map(([group, items]) => (
        <div key={group} className="space-y-2">
          <h3 className="text-sm font-semibold">{group}</h3>
          <div className="divide-y rounded-md border">
            {items.map((r) => (
              <div key={r.key} className="flex items-start gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-medium">{r.label}</span>
                    {r.requires_reindex && (
                      <Badge
                        variant="outline"
                        className="border-amber-400 text-amber-600"
                      >
                        재색인 필요
                      </Badge>
                    )}
                    {r.overridden && (
                      <Badge variant="secondary">기본값과 다름</Badge>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">{r.desc}</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground/70">
                    기본값: {String(r.default)}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  {r.type === 'bool' ? (
                    <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs">
                      <input
                        type="checkbox"
                        checked={!!valueOf(r)}
                        onChange={(e) => setDraftVal(r.key, e.target.checked)}
                        className="h-4 w-4"
                      />
                      {valueOf(r) ? '켜짐' : '꺼짐'}
                    </label>
                  ) : (
                    <Input
                      type="number"
                      value={valueOf(r)}
                      min={r.min ?? undefined}
                      max={r.max ?? undefined}
                      step={r.step ?? (r.type === 'int' ? 1 : 0.01)}
                      onChange={(e) => {
                        const raw = e.target.value
                        if (raw === '') return setDraftVal(r.key, raw)
                        const n =
                          r.type === 'int'
                            ? parseInt(raw, 10)
                            : parseFloat(raw)
                        setDraftVal(r.key, Number.isNaN(n) ? raw : n)
                      }}
                      className={`h-8 w-24 ${isDirty(r) ? 'border-primary' : ''}`}
                    />
                  )}
                  {r.overridden && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      title="기본값으로 되돌리기"
                      onClick={() => reset(r.key)}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
