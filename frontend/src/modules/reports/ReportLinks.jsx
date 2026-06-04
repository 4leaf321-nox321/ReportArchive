// 보고서 간 link 의 UI — 메타 칩(상단)과 본문 하단 섹션 두 종류 + 데이터
// 관리 hook 하나. 데이터모델은 단방향 (from → to) 저장 + 양쪽 화면에서
// 같은 row 를 forward/reverse 라벨로 뒤집어 보여주는 식. 자세한 건
// `shared/reports/linkKinds.js` 와 백엔드 `app/shared/link_kinds.py`.
//
// 권한:
//   - 추가 : from 쪽 보고서의 편집권자만 (백엔드 can_edit 강제, UI 는
//            isEditing && existingReport.can_edit 일 때만 input 활성)
//   - 삭제 : link 의 from 쪽 보고서의 편집권자만. incoming 쪽에서는
//            X 버튼을 숨김 (혼란 방지) — 끊고 싶으면 출처 보고서로 이동.
//   - 조회 : 보고서 read 권한과 동일.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link as RouterLink } from 'react-router-dom'
import { Link2, Loader2, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/shared/components/ui/popover'
import { cn } from '@/shared/lib/utils'
import { colorClasses, labelForKind } from '@/shared/reports/linkKinds'
import { listLinkKinds } from '@/shared/api/linkKinds'
import {
  createReportLink,
  deleteReportLink,
  listReportLinks,
} from '@/shared/api/reportLinks'
import { ReportPicker } from './ReportPicker'

// ─────────────────────────────────────────────────────────────────────────── //
// useLinkKinds — 모듈 레벨 캐시. 카탈로그가 자주 안 바뀌므로 페이지마다     //
// 재요청하지 않고 한 번 받아 둔 걸 재사용. admin 이 편집하면 그 페이지에서  //
// invalidate (setKinds 로 직접 set) → ReportLinks 들은 다음 mount 때 신선  //
// 한 값을 본다.                                                              //
// ─────────────────────────────────────────────────────────────────────────── //

let _cachedKinds = null
let _inflight = null

async function _fetchKinds() {
  if (_cachedKinds) return _cachedKinds
  if (_inflight) return _inflight
  _inflight = listLinkKinds()
    .then((data) => {
      _cachedKinds = Array.isArray(data) ? data : []
      _inflight = null
      return _cachedKinds
    })
    .catch((err) => {
      // 실패는 캐시하지 않고 inflight 를 풀어 둔다 — 안 그러면 (이전 버그)
      // 한 번의 일시적 실패(예: 초기 로드 타이밍의 401)가 거부된 inflight
      // 프로미스로 남아 이후 모든 호출이 그걸 돌려받아 카탈로그가 영구히
      // 빈 채로 고착됐다. 다음 mount/호출이 다시 시도하게 한다.
      _inflight = null
      throw err
    })
  return _inflight
}

export function invalidateLinkKindsCache() {
  _cachedKinds = null
  _inflight = null
}

export function useLinkKinds() {
  const [kinds, setKinds] = useState(_cachedKinds ?? [])
  // 실패 시 자동 재시도 트리거 — 초기 로드 타이밍에 한 번 실패해도 새로고침
  // 없이 곧 카탈로그가 채워지게 한다.
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let cancelled = false
    let timer = null
    _fetchKinds()
      .then((rows) => {
        if (!cancelled) setKinds(rows)
      })
      .catch((err) => {
        if (cancelled) return
        console.warn('useLinkKinds fetch failed, will retry', err)
        // 최대 3회까지 백오프 재시도.
        if (retry < 3) timer = setTimeout(() => setRetry((r) => r + 1), 1500)
      })
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [retry])
  const byKey = useMemo(
    () => Object.fromEntries((kinds ?? []).map((k) => [k.key, k])),
    [kinds],
  )
  return { kinds: kinds ?? [], byKey }
}

// ─────────────────────────────────────────────────────────────────────────── //
// useReportLinks — 한 보고서의 link 들을 보관·수정하는 hook                  //
// ─────────────────────────────────────────────────────────────────────────── //

/**
 * 이 보고서의 outgoing+incoming link 들을 관리. 보고서 페이지 한 곳에서만
 * 호출하고, 결과를 칩·섹션 두 곳에 prop 으로 흘려보낸다. 그래야 한쪽에서
 * 추가/삭제하면 다른 쪽에도 즉시 반영.
 *
 *  @returns {{
 *    links: ReportLinkRead[],
 *    loading: boolean,
 *    refresh: () => Promise<void>,
 *    addLink: (params: {toReportId, kind, note?}) => Promise<void>,
 *    removeLink: (linkId: number) => Promise<void>,
 *  }}
 */
export function useReportLinks(reportId) {
  const [links, setLinks] = useState([])
  const [loading, setLoading] = useState(false)
  const refresh = useCallback(async () => {
    if (!reportId) {
      setLinks([])
      return
    }
    setLoading(true)
    try {
      const data = await listReportLinks(reportId)
      setLinks(Array.isArray(data) ? data : [])
    } catch (err) {
      // 조용히 실패 — 보고서 본체 보기에 지장 없도록. 토스트는 mutation 만.
      console.warn('listReportLinks failed', err)
    } finally {
      setLoading(false)
    }
  }, [reportId])
  useEffect(() => {
    refresh()
  }, [refresh])
  const addLink = useCallback(
    async ({ toReportId, kind, note, direction = 'outgoing' }) => {
      if (!reportId) return
      try {
        await createReportLink(reportId, {
          toReportId,
          kind,
          note,
          direction,
        })
        await refresh()
        toast.success('보고서가 연결되었습니다.')
      } catch (err) {
        const msg = err?.response?.data?.message || '연결에 실패했습니다.'
        toast.error(msg)
      }
    },
    [reportId, refresh],
  )
  const removeLink = useCallback(
    async (linkId) => {
      if (!reportId) return
      try {
        await deleteReportLink(reportId, linkId)
        await refresh()
      } catch (err) {
        const msg = err?.response?.data?.message || '삭제에 실패했습니다.'
        toast.error(msg)
      }
    },
    [reportId, refresh],
  )
  return { links, loading, refresh, addLink, removeLink }
}

// ─────────────────────────────────────────────────────────────────────────── //
// LinkedReportsChip — 메타 칩 + 추가/제거 popover                            //
// ─────────────────────────────────────────────────────────────────────────── //

/**
 * 메타 칩 ("📎 연결됨 N건"). 클릭하면 popover 가 열려 현재 link 목록과
 * 새 link 추가 폼이 나온다. 보고서 종류·관련 정보 칩 옆에 자연스럽게 끼움.
 *
 * editable=false 면 X(제거) 버튼과 추가 폼이 숨겨지고 목록만 보임.
 */
export function LinkedReportsChip({
  reportId,
  links,
  loading,
  onAdd,
  onRemove,
  editable,
  tone = 'amber',
}) {
  const { kinds, byKey } = useLinkKinds()
  const hasLinks = links?.length > 0
  const ctaTones = {
    amber: 'border-amber-400 bg-amber-100/70 text-amber-900 hover:bg-amber-200/70',
    blue:  'border-blue-400  bg-blue-100/70  text-blue-900  hover:bg-blue-200/70',
    red:   'border-red-400   bg-red-100/70   text-red-900   hover:bg-red-200/70',
  }
  const ctaCls = ctaTones[tone] || ctaTones.amber
  const mutedCls =
    'border-border bg-background/80 text-foreground/80 hover:bg-muted'
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors',
            hasLinks ? mutedCls : ctaCls,
          )}
          title={hasLinks ? '연결된 보고서 보기/편집' : '다른 보고서와 연결'}
        >
          {hasLinks ? (
            <Link2 className="h-3 w-3" />
          ) : (
            <Plus className="h-3 w-3" />
          )}
          <span>
            {hasLinks ? `연결됨 ${links.length}건` : '연결된 보고서'}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[520px] p-3 space-y-3" align="end">
        <div className="text-xs font-semibold text-muted-foreground">
          연결된 보고서
          {loading && (
            <Loader2 className="ml-1 inline h-3 w-3 animate-spin" />
          )}
        </div>
        {/* 현재 link 들 — 추가/삭제 모두 같은 자리에서 */}
        {hasLinks ? (
          <ul className="space-y-1 max-h-[260px] overflow-y-auto pr-1">
            {links.map((l) => (
              <LinkRow
                key={l.id}
                link={l}
                kindRow={byKey[l.kind]}
                // 백엔드 정책: path 보고서 쪽 can_edit 면 incoming/outgoing
                // 어느 쪽이든 삭제 가능. 그대로 UI 도 양쪽 X 노출.
                editable={editable}
                onRemove={onRemove}
              />
            ))}
          </ul>
        ) : (
          <p className="text-[11px] text-muted-foreground italic">
            아직 연결된 보고서가 없습니다.
          </p>
        )}
        {editable && reportId != null && (
          <>
            <div className="border-t" />
            <AddLinkForm reportId={reportId} kinds={kinds} onAdd={onAdd} />
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

// ─────────────────────────────────────────────────────────────────────────── //
// AddLinkForm — 보고서 검색(ReportPicker) + 관계 유형 + 메모 + 추가          //
// ─────────────────────────────────────────────────────────────────────────── //

function AddLinkForm({ reportId, kinds, onAdd }) {
  const [selected, setSelected] = useState(null) // ReportSummary
  // 옵션 value 는 "kind|direction" 형태로 한 select 에 정·역 모두 노출.
  // 예) "successor|outgoing" 정방향 후속, "successor|incoming" 역방향 선행.
  const [kindDir, setKindDir] = useState(
    kinds?.[0] ? `${kinds[0].key}|outgoing` : '',
  )
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  useEffect(() => {
    if (!kindDir && kinds?.length > 0) {
      setKindDir(`${kinds[0].key}|outgoing`)
    }
  }, [kinds, kindDir])
  const canSubmit = !!selected && !!kindDir && !submitting
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-[11px] font-semibold text-muted-foreground">
          새 연결 추가
        </div>
        <div className="text-[10px] text-muted-foreground italic">
          조직에 게시된 보고서만 선택 가능
        </div>
      </div>
      <ReportPicker
        excludeReportId={reportId}
        selected={selected}
        onSelect={setSelected}
      />
      <div className="flex items-center gap-2">
        <div className="flex flex-col">
          <span className="text-[10px] text-muted-foreground leading-tight">
            상대 보고서는?
          </span>
          <select
            value={kindDir}
            onChange={(e) => setKindDir(e.target.value)}
            className="h-7 rounded-md border bg-background px-2 text-xs"
            disabled={!kinds || kinds.length === 0}
          >
            {kinds?.flatMap((k) => [
              // 옵션 텍스트는 라벨 한 단어만 — 의미는 select 아래 hint.
              <option key={`${k.key}|outgoing`} value={`${k.key}|outgoing`}>
                {k.forward_label}
              </option>,
              <option key={`${k.key}|incoming`} value={`${k.key}|incoming`}>
                {k.reverse_label}
              </option>,
            ])}
          </select>
        </div>
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="메모 (선택)"
          maxLength={200}
          className="h-8 flex-1 text-xs self-end"
        />
      </div>
      {/* 선택된 라벨의 의미 미리보기 — 화살표 없이 자연어 한 줄. */}
      <KindDirHint kindDir={kindDir} kinds={kinds} />
      <div className="flex justify-end">
        <Button
          size="sm"
          className="h-7 text-xs"
          disabled={!canSubmit}
          onClick={async () => {
            if (!selected || !kindDir) return
            const [kind, direction] = kindDir.split('|')
            setSubmitting(true)
            try {
              await onAdd({ toReportId: selected.id, kind, note, direction })
              // 성공하면 폼 초기화 — 잇따라 여러 link 추가 자연스럽게.
              setSelected(null)
              setNote('')
            } finally {
              setSubmitting(false)
            }
          }}
        >
          {submitting ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <>
              <Plus className="mr-1 h-3 w-3" />
              연결 추가
            </>
          )}
        </Button>
      </div>
    </div>
  )
}

/**
 * 선택한 옵션이 어떤 관계를 만드는지 한 문장으로 풀어 안내.
 * "상대 보고서는 이 보고서의 후속/선행/참조/참조됨" 식.
 */
function KindDirHint({ kindDir, kinds }) {
  if (!kindDir) return null
  const [kind, direction] = kindDir.split('|')
  const meta = kinds?.find((k) => k.key === kind)
  if (!meta) return null
  const label =
    direction === 'incoming' ? meta.reverse_label : meta.forward_label
  return (
    <p className="text-[10px] text-muted-foreground">
      → 상대 보고서는 이 보고서의{' '}
      <span className="font-medium text-foreground">{label}</span>
      {'입니다.'}
    </p>
  )
}

// ─────────────────────────────────────────────────────────────────────────── //
// LinkRow — popover 와 본문 하단 섹션 양쪽에서 쓰는 한 줄 카드               //
// ─────────────────────────────────────────────────────────────────────────── //

function LinkRow({ link, kindRow, editable, onRemove }) {
  // kindRow 가 비동기로 도착하기 전엔 raw kind key 를 fallback 으로 표시.
  // 카탈로그에서 삭제된 (=알 수 없는) kind 일 때도 같은 동작.
  const label = kindRow ? labelForKind(kindRow, link.direction) : link.kind
  const colorCls = colorClasses(kindRow?.color)
  const cp = link.counterpart
  return (
    <li className="flex items-start gap-2 rounded-md border bg-background/60 px-2 py-1.5 text-[11px]">
      <span
        className={cn(
          'shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium',
          colorCls,
        )}
        title={
          link.direction === 'outgoing'
            ? '이 보고서가 → 상대'
            : '상대가 → 이 보고서'
        }
      >
        {label}
      </span>
      <div className="min-w-0 flex-1">
        <RouterLink
          to={`/w/${cp.workspace_slug}/reports/${cp.id}`}
          className="block truncate font-medium text-foreground hover:underline"
          title={cp.title}
        >
          {cp.title}
        </RouterLink>
        <div className="truncate text-[10px] text-muted-foreground">
          {cp.owner_name ? `${cp.owner_name} · ` : ''}
          {cp.report_date}
          {link.note ? ` · ${link.note}` : ''}
        </div>
      </div>
      {editable && (
        <button
          type="button"
          onClick={() => onRemove?.(link.id)}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-destructive"
          title="이 연결 끊기"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </li>
  )
}

// ─────────────────────────────────────────────────────────────────────────── //
// ReportLinksSection — 본문 하단의 그룹 섹션                                 //
// ─────────────────────────────────────────────────────────────────────────── //

/**
 * link 가 0건이면 렌더 안 함 — 본문이 깔끔하게 유지됨. 1건 이상이면
 * direction × kind 별로 그룹화해서 표시. outgoing/incoming 은 라벨이 이미
 * forward/reverse 로 다르므로 사용자에겐 단순한 "참조 / 참조됨 / 후속 /
 * 선행" 4섹션처럼 보임 (kind 가 더 늘어나면 그 두 배로 늘어남).
 */
export function ReportLinksSection({ links, onRemove, editable }) {
  const { kinds, byKey } = useLinkKinds()
  // 그룹 키 = direction|kind. 화면 순서는 카탈로그 sort_order × outgoing 우선.
  const groups = useMemo(() => {
    if (!links || links.length === 0) return []
    const map = new Map() // key -> { kind, direction, label, items[] }
    for (const l of links) {
      const groupKey = `${l.direction}|${l.kind}`
      const label = byKey[l.kind]
        ? labelForKind(byKey[l.kind], l.direction)
        : l.kind
      if (!map.has(groupKey)) {
        map.set(groupKey, {
          kind: l.kind,
          direction: l.direction,
          label,
          items: [],
        })
      }
      map.get(groupKey).items.push(l)
    }
    const order = kinds.map((k) => k.key)
    return Array.from(map.values()).sort((a, b) => {
      const oa = order.indexOf(a.kind)
      const ob = order.indexOf(b.kind)
      if (oa !== ob) return oa - ob
      if (a.direction !== b.direction)
        return a.direction === 'outgoing' ? -1 : 1
      return 0
    })
  }, [links, kinds, byKey])
  if (!links || links.length === 0) return null
  return (
    <section className="rounded-md border bg-muted/20 px-4 py-3 space-y-3">
      <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
        <Link2 className="h-3.5 w-3.5" />
        연결된 보고서
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {groups.map((g) => (
          <div key={`${g.direction}-${g.kind}`} className="space-y-1">
            <div className="text-[11px] font-medium text-muted-foreground">
              {g.label}{' '}
              <span className="text-[10px]">({g.items.length})</span>
            </div>
            <ul className="space-y-1">
              {g.items.map((l) => (
                <LinkRow
                  key={l.id}
                  link={l}
                  kindRow={byKey[l.kind]}
                  // 본문 섹션도 path 보고서 편집권자라면 incoming/outgoing
                  // 어느 쪽이든 끊을 수 있게 노출.
                  editable={editable}
                  onRemove={onRemove}
                />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  )
}
