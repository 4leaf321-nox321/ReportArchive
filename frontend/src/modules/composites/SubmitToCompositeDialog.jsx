import { useMemo, useState } from 'react'
import { Send } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import { Button } from '@/shared/components/ui/button'
import { Badge } from '@/shared/components/ui/badge'
import { Textarea } from '@/shared/components/ui/textarea'
import { Input } from '@/shared/components/ui/input'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { cn } from '@/shared/lib/utils'
import { toast } from 'sonner'
import { useAsync } from '@/shared/hooks/useAsync'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import {
  listSubmittableComposites,
  submitItemRequest,
} from '@/shared/api/composites'
import { KIND_LABEL, KIND_VARIANT } from './constants'

/** 보고서 상세에서 "종합보고에 제출" — 동시편집 회피를 위해 종합보고를 직접
 *  수정하지 않고 신청만 한다. 작성자가 승인하면 그때 안건으로 추가된다. */
export function SubmitToCompositeButton({ reportId }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        title="이 보고서를 종합보고에 안건으로 제출 (작성자 승인 후 추가)"
      >
        <Send className="mr-1 h-3 w-3" />
        {/* 폭이 좁아지면(xl 미만) "종합보고 "를 숨겨 "제출"로 단축 — 툴바가
            한 줄에 더 오래 들어가, 버튼 줄바꿈보다 먼저 일어나는 단계. */}
        <span className="hidden xl:inline">종합보고 </span>제출
      </Button>
      {open && (
        <SubmitToCompositeDialog
          reportId={reportId}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

/** YYYY-MM-DD 범위 포함 검사. value 가 없으면(주제 종합) 날짜 필터가 켜졌을 때
 *  제외된다(비교할 날짜가 없음). */
function inDateRange(value, from, to) {
  if (!from && !to) return true
  if (!value) return false
  if (from && value < from) return false
  if (to && value > to) return false
  return true
}

function SubmitToCompositeDialog({ reportId, onClose }) {
  const { all: workspaces } = useWorkspace()
  const workspaceName = useMemo(() => {
    const map = new Map((workspaces ?? []).map((w) => [w.slug, w.name]))
    return (s) => map.get(s) ?? s
  }, [workspaces])
  const { data, loading, error } = useAsync(
    () => listSubmittableComposites(reportId),
    [reportId],
  )
  const list = useMemo(() => data ?? [], [data])

  const [selectedId, setSelectedId] = useState(null)
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  // 필터들
  const [orgFilter, setOrgFilter] = useState('all') // workspace_slug | 'all'
  const [kindFilter, setKindFilter] = useState('all') // 'all'|'recurring'|'theme'
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [query, setQuery] = useState('')

  // 후보에 실제로 존재하는 조직만 드롭다운에 노출(상·하위 연결 조직 = 백엔드가
  // 보고서 게시판 + 상위 조직으로 추려서 내려준 set).
  const orgs = useMemo(() => {
    const seen = new Map()
    for (const c of list) {
      if (!seen.has(c.workspace_slug)) {
        seen.set(c.workspace_slug, workspaceName(c.workspace_slug))
      }
    }
    return [...seen.entries()]
      .map(([slug, name]) => ({ slug, name }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [list, workspaceName])

  const showDateFilter = kindFilter !== 'theme'

  const filtered = useMemo(
    () =>
      list
        .filter((c) => orgFilter === 'all' || c.workspace_slug === orgFilter)
        .filter((c) => kindFilter === 'all' || c.kind === kindFilter)
        .filter((c) =>
          showDateFilter ? inDateRange(c.period_date, dateFrom, dateTo) : true,
        )
        .filter((c) => {
          const q = query.trim().toLowerCase()
          if (!q) return true
          return (
            (c.title ?? '').toLowerCase().includes(q) ||
            (c.owner_name ?? '').toLowerCase().includes(q) ||
            workspaceName(c.workspace_slug).toLowerCase().includes(q)
          )
        }),
    [list, orgFilter, kindFilter, showDateFilter, dateFrom, dateTo, query, workspaceName],
  )

  const selectable = (c) => !c.already_item && !c.already_pending

  async function submit() {
    if (selectedId == null) return
    setSubmitting(true)
    try {
      await submitItemRequest(selectedId, { ref_report_id: reportId, note })
      toast.success('제출되었습니다 — 종합보고 작성자의 승인을 기다립니다.')
      onClose()
    } catch (e) {
      toast.error(e?.response?.data?.message || e.message || '제출 실패')
    } finally {
      setSubmitting(false)
    }
  }

  const KIND_TABS = [
    { v: 'all', label: '전체' },
    { v: 'recurring', label: '정기' },
    { v: 'theme', label: '주제' },
  ]

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[80vh] max-h-[80vh] w-[80vw] max-w-[80vw] flex-col sm:max-w-[80vw]">
        <DialogHeader>
          <DialogTitle>종합보고에 제출</DialogTitle>
          <DialogDescription>
            이 보고서를 안건으로 올릴 종합보고를 고르세요. 작성자가 승인하면
            안건으로 추가됩니다. (이 보고서가 게시된 부서·상위 조직의 종합보고)
          </DialogDescription>
        </DialogHeader>

        {/* 필터 — 조직 / 종류 / 기준일 / 검색 */}
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b pb-3">
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            조직
            <select
              value={orgFilter}
              onChange={(e) => setOrgFilter(e.target.value)}
              className="h-8 max-w-[12rem] truncate rounded border bg-background px-2 text-xs"
            >
              <option value="all">전체 조직</option>
              {orgs.map((o) => (
                <option key={o.slug} value={o.slug}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>

          <div className="inline-flex rounded-md border p-0.5">
            {KIND_TABS.map((t) => (
              <button
                key={t.v}
                type="button"
                onClick={() => setKindFilter(t.v)}
                className={cn(
                  'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                  kindFilter === t.v
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          {showDateFilter && (
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              기준일
              <Input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="h-8 w-[9.5rem] text-xs"
              />
              <span>~</span>
              <Input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="h-8 w-[9.5rem] text-xs"
              />
              {(dateFrom || dateTo) && (
                <button
                  type="button"
                  onClick={() => {
                    setDateFrom('')
                    setDateTo('')
                  }}
                  className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  지우기
                </button>
              )}
            </label>
          )}

          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="제목·작성자·조직 검색"
            className="h-8 min-w-[10rem] flex-1 text-xs"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <Skeleton className="h-40" />
          ) : error ? (
            <p className="text-sm text-destructive">{error.message}</p>
          ) : list.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              제출할 수 있는 종합보고가 없습니다. (이 보고서가 게시된 부서·상위
              조직의 종합보고가 있어야 합니다)
            </p>
          ) : filtered.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              필터에 맞는 종합보고가 없습니다.
            </p>
          ) : (
            <ul className="space-y-1 pr-1">
              {filtered.map((c) => {
                const ok = selectable(c)
                const active = c.id === selectedId
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      disabled={!ok}
                      onClick={() => ok && setSelectedId(c.id)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left transition-colors',
                        active
                          ? 'border-primary bg-primary/10'
                          : 'hover:bg-muted',
                        !ok && 'cursor-not-allowed opacity-60',
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {c.title}
                        </span>
                        <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                          <Badge
                            variant={KIND_VARIANT[c.kind]}
                            className="h-3.5 px-1 text-[9px]"
                          >
                            {KIND_LABEL[c.kind] ?? c.kind}
                          </Badge>
                          <span>{workspaceName(c.workspace_slug)}</span>
                          {c.period_date && <span>· 기준 {c.period_date}</span>}
                          {c.owner_name && <span>· {c.owner_name}</span>}
                        </span>
                      </span>
                      {c.already_item ? (
                        <Badge variant="secondary" className="shrink-0 text-[10px]">
                          이미 안건
                        </Badge>
                      ) : c.already_pending ? (
                        <Badge variant="outline" className="shrink-0 text-[10px]">
                          제출됨(대기)
                        </Badge>
                      ) : null}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div className="shrink-0">
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="제출 메모 (선택) — 작성자에게 전달됩니다"
            rows={2}
            className="text-sm"
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            취소
          </Button>
          <Button onClick={submit} disabled={selectedId == null || submitting}>
            {submitting ? '제출 중…' : '제출'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
