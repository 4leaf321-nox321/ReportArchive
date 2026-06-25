import { useMemo, useState } from 'react'
import { Check, Send } from 'lucide-react'
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

/** 제출 대상 종합보고 고르개 — 단건/일괄 다이얼로그가 공유하는 필터+목록.
 *  fetchReportId 하나로 후보를 받아오고(백엔드가 그 보고서의 게시 부서 +
 *  상위 조직 종합보고로 추려줌), selectedId 를 부모로 끌어올린다.
 *  enforceAvailability=true(단건) 면 이미 안건/대기 항목을 비활성·뱃지로
 *  표시한다. 일괄 모드는 N개 보고서마다 상태가 달라 신뢰할 수 없으므로
 *  false 로 전부 선택 가능하게 두고(중복은 서버가 거절) 뱃지를 감춘다. */
function CompositeChooser({
  fetchReportId,
  selectedId,
  onSelectId,
  enforceAvailability,
  excludeCompositeId,
}) {
  const { all: workspaces } = useWorkspace()
  const workspaceName = useMemo(() => {
    const map = new Map((workspaces ?? []).map((w) => [w.slug, w.name]))
    return (s) => map.get(s) ?? s
  }, [workspaces])
  const { data, loading, error } = useAsync(
    () => listSubmittableComposites(fetchReportId),
    [fetchReportId],
  )
  const list = useMemo(() => data ?? [], [data])

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
        // 자기 자신(현재 종합보고)으로의 제출은 무의미 — 대상 목록에서 숨긴다.
        .filter((c) => c.id !== excludeCompositeId)
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
    [list, excludeCompositeId, orgFilter, kindFilter, showDateFilter, dateFrom, dateTo, query, workspaceName],
  )

  // 단건 모드에서만 이미 안건/대기를 비선택 처리. 일괄 모드는 보고서마다
  // 상태가 달라(샘플 한 건 기준이라) 게이팅하지 않고 서버에 맡긴다.
  const selectable = (c) =>
    !enforceAvailability || (!c.already_item && !c.already_pending)

  const KIND_TABS = [
    { v: 'all', label: '전체' },
    { v: 'recurring', label: '정기' },
    { v: 'theme', label: '주제' },
  ]

  return (
    <>
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
                    onClick={() => ok && onSelectId(c.id)}
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
                    {/* 이미 안건/대기 뱃지는 단건 모드에서만 의미가 있다
                        (일괄은 샘플 한 건 기준이라 오해 소지). */}
                    {enforceAvailability && c.already_item ? (
                      <Badge variant="secondary" className="shrink-0 text-[10px]">
                        이미 안건
                      </Badge>
                    ) : enforceAvailability && c.already_pending ? (
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
    </>
  )
}

function SubmitToCompositeDialog({ reportId, onClose }) {
  const [selectedId, setSelectedId] = useState(null)
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)

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

        <CompositeChooser
          fetchReportId={reportId}
          selectedId={selectedId}
          onSelectId={setSelectedId}
          enforceAvailability
        />

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

/** 보고서 목록에서 체크박스로 고른 N건을 한 종합보고에 일괄 제출.
 *  후보 목록은 샘플(첫 선택) 보고서 기준으로 받아오되(같은 게시판 소속이라
 *  현재 부서·상위 조직 종합보고는 공통), 선택 후 각 보고서마다 제출 신청을
 *  보낸다. 이미 안건이거나 그 보고서로는 제출 불가한 건은 서버가 거절 →
 *  ok/fail 카운트로 토스트 요약(일괄 게시/삭제와 동일한 패턴). */
export function BulkSubmitToCompositeDialog({ reportIds, onClose, onDone }) {
  const [selectedId, setSelectedId] = useState(null)
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const sampleReportId = reportIds[0]

  async function submit() {
    if (selectedId == null || reportIds.length === 0) return
    setSubmitting(true)
    try {
      const results = await Promise.allSettled(
        reportIds.map((id) =>
          submitItemRequest(selectedId, { ref_report_id: id, note }),
        ),
      )
      const ok = results.filter((r) => r.status === 'fulfilled').length
      const fail = results.length - ok
      if (fail === 0) {
        toast.success(`${ok}건 제출됨 — 작성자 승인을 기다립니다.`)
      } else {
        const firstErr = results.find((r) => r.status === 'rejected')?.reason
        toast.warning(`${ok}건 제출, ${fail}건 실패`, {
          description:
            firstErr?.response?.data?.message ||
            firstErr?.message ||
            '이미 안건이거나 제출할 수 없는 보고서는 제외됩니다.',
        })
      }
      onDone?.()
      onClose()
    } catch (e) {
      toast.error(e?.response?.data?.message || e.message || '제출 실패')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !submitting && onClose()}>
      <DialogContent className="flex h-[80vh] max-h-[80vh] w-[80vw] max-w-[80vw] flex-col sm:max-w-[80vw]">
        <DialogHeader>
          <DialogTitle>종합보고에 일괄 제출</DialogTitle>
          <DialogDescription>
            선택한 {reportIds.length}건의 보고서를 안건으로 올릴 종합보고를
            고르세요. 작성자가 승인하면 각 보고서가 안건으로 추가됩니다. (이미
            안건이거나 제출 대기 중인 보고서는 자동으로 제외됩니다)
          </DialogDescription>
        </DialogHeader>

        <CompositeChooser
          fetchReportId={sampleReportId}
          selectedId={selectedId}
          onSelectId={setSelectedId}
          enforceAvailability={false}
        />

        <div className="shrink-0">
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="제출 메모 (선택) — 모든 보고서에 동일하게 작성자에게 전달됩니다"
            rows={2}
            className="text-sm"
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            취소
          </Button>
          <Button onClick={submit} disabled={selectedId == null || submitting}>
            {submitting ? '제출 중…' : `${reportIds.length}건 제출`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 종합보고 상세에서 "이 종합보고의 안건 중 몇 개를 다른 종합보고에 제출".
 *  2단계 — ① 보고서 기반 안건을 체크해서 고르고(중첩 종합보고·원본삭제
 *  안건은 애초에 후보에서 빠진 채로 넘어옴), ② 대상 종합보고를 고른다.
 *  실제 제출은 각 안건의 원본 보고서를 단건 제출 큐로 보내는 것이라
 *  BulkSubmitToCompositeDialog 와 동일한 ok/fail 집계를 쓴다.
 *
 *  items: [{ reportId, title, subtitle }] — 호출 측이 미리 후보만 추려서 전달.
 *  excludeCompositeId: 현재(출발) 종합보고 — 대상 목록에서 제외. */
export function SubmitCompositeItemsDialog({
  items,
  excludeCompositeId,
  onClose,
  onDone,
}) {
  // 1단계는 전체 선택으로 시작 — "이 안건들을 통째로 다른 종합보고에" 가
  // 흔한 경우라 클릭 수를 줄인다. 빼고 싶은 것만 해제하면 된다.
  const [picked, setPicked] = useState(() => new Set(items.map((it) => it.reportId)))
  const [step, setStep] = useState('items') // 'items' | 'target'
  const [selectedId, setSelectedId] = useState(null)
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const pickedIds = useMemo(
    () => items.map((it) => it.reportId).filter((id) => picked.has(id)),
    [items, picked],
  )
  const allPicked = pickedIds.length === items.length
  const sampleReportId = pickedIds[0]

  function toggle(reportId) {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(reportId)) next.delete(reportId)
      else next.add(reportId)
      return next
    })
  }

  async function submit() {
    if (selectedId == null || pickedIds.length === 0) return
    setSubmitting(true)
    try {
      const results = await Promise.allSettled(
        pickedIds.map((id) =>
          submitItemRequest(selectedId, { ref_report_id: id, note }),
        ),
      )
      const ok = results.filter((r) => r.status === 'fulfilled').length
      const fail = results.length - ok
      if (fail === 0) {
        toast.success(`${ok}건 제출됨 — 대상 종합보고 작성자의 승인을 기다립니다.`)
      } else {
        const firstErr = results.find((r) => r.status === 'rejected')?.reason
        toast.warning(`${ok}건 제출, ${fail}건 실패`, {
          description:
            firstErr?.response?.data?.message ||
            firstErr?.message ||
            '이미 안건이거나 제출할 수 없는 보고서는 제외됩니다.',
        })
      }
      onDone?.()
      onClose()
    } catch (e) {
      toast.error(e?.response?.data?.message || e.message || '제출 실패')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !submitting && onClose()}>
      <DialogContent className="flex h-[80vh] max-h-[80vh] w-[80vw] max-w-[80vw] flex-col sm:max-w-[80vw]">
        <DialogHeader>
          <DialogTitle>다른 종합보고에 제출</DialogTitle>
          <DialogDescription>
            {step === 'items'
              ? '이 종합보고의 안건 중 다른 종합보고로 올릴 것을 고르세요. (보고서 기반 안건만 제출할 수 있습니다)'
              : `선택한 ${pickedIds.length}건을 안건으로 올릴 종합보고를 고르세요. 작성자가 승인하면 안건으로 추가됩니다.`}
          </DialogDescription>
        </DialogHeader>

        {step === 'items' ? (
          <>
            <div className="flex shrink-0 items-center gap-2 border-b pb-2 text-xs text-muted-foreground">
              <button
                type="button"
                onClick={() =>
                  setPicked(
                    allPicked ? new Set() : new Set(items.map((it) => it.reportId)),
                  )
                }
                className="rounded border px-2 py-1 font-medium hover:bg-muted"
              >
                {allPicked ? '전체 해제' : '전체 선택'}
              </button>
              <span>
                {pickedIds.length} / {items.length}건 선택
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <ul className="space-y-1 pr-1">
                {items.map((it) => {
                  const on = picked.has(it.reportId)
                  return (
                    <li key={it.reportId}>
                      <button
                        type="button"
                        onClick={() => toggle(it.reportId)}
                        className={cn(
                          'flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left transition-colors',
                          on ? 'border-primary bg-primary/10' : 'hover:bg-muted',
                        )}
                      >
                        <span
                          className={cn(
                            'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                            on
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'border-muted-foreground/40',
                          )}
                        >
                          {on && <Check className="h-3 w-3" />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">
                            {it.title}
                          </span>
                          {it.subtitle && (
                            <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                              {it.subtitle}
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                취소
              </Button>
              <Button
                onClick={() => setStep('target')}
                disabled={pickedIds.length === 0}
              >
                다음 ({pickedIds.length}건)
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <CompositeChooser
              fetchReportId={sampleReportId}
              selectedId={selectedId}
              onSelectId={setSelectedId}
              enforceAvailability={false}
              excludeCompositeId={excludeCompositeId}
            />

            <div className="shrink-0">
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="제출 메모 (선택) — 모든 안건에 동일하게 작성자에게 전달됩니다"
                rows={2}
                className="text-sm"
              />
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setStep('items')}
                disabled={submitting}
              >
                이전
              </Button>
              <Button onClick={submit} disabled={selectedId == null || submitting}>
                {submitting ? '제출 중…' : `${pickedIds.length}건 제출`}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
