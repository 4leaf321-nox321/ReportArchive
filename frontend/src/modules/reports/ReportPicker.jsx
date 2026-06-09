// 링크 대상 보고서 검색 picker — "연결된 보고서" 추가 폼(AddLinkForm)과 본문
// @멘션 작성 팝업(ReportMentionDialog)이 공유한다. 둘 다 동일한 권한 풀
// (listLinkableReports: 조직 보고서 || 어딘가에 게시된 개인 보고서)에서
// 검색하므로, 멘션의 검색 범위가 관계 추가와 정확히 같다.
//
// 검색/필터(제목·작성자·게시조직, 기간, 작성자, 게시조직)만 담당하고, 선택된
// 보고서는 `onSelect` 로 위로 올린다. 관계 유형·메모·삽입은 호출부 책임.
import { useEffect, useMemo, useState } from 'react'
import { Building2, Check, ChevronDown, User } from 'lucide-react'
import { Input } from '@/shared/components/ui/input'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/shared/components/ui/command'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/shared/components/ui/popover'
import { cn } from '@/shared/lib/utils'
import {
  listLinkableFacets,
  listLinkableReports,
} from '@/shared/api/reportLinks'
import { listWorkspaces } from '@/shared/api/workspaces'

// ─────────────────────────────────────────────────────────────────────────── //
// 기간 프리셋 — composite picker 와 같은 어휘로 통일                          //
// ─────────────────────────────────────────────────────────────────────────── //
const _DATE_PRESETS = [
  { value: 'all', label: '전체 기간', days: null },
  { value: '7', label: '지난 1주', days: 7 },
  { value: '30', label: '지난 1개월', days: 30 },
  { value: '90', label: '지난 3개월', days: 90 },
  { value: '365', label: '지난 1년', days: 365 },
]

function _fmtLocalDate(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function _presetFromValue(value) {
  const found = _DATE_PRESETS.find((p) => p.value === value)
  if (!found || found.days == null) return null // 전체 기간
  const today = new Date()
  const start = new Date(today)
  start.setDate(start.getDate() - found.days)
  return { from: _fmtLocalDate(start), to: _fmtLocalDate(today) }
}

// ─────────────────────────────────────────────────────────────────────────── //
// MRU (Most Recently Used) — 최근 선택값을 localStorage 에 보관해 다음 번에  //
// 드롭다운 상단에 「최근」 그룹으로 노출. key 충돌 회피를 위해 namespaced.  //
// ─────────────────────────────────────────────────────────────────────────── //
const MRU_MAX = 8

function _loadMru(storageKey) {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : []
  } catch {
    return []
  }
}

function _saveMru(storageKey, value) {
  if (!value) return // '전체' 같은 빈값은 기억 안 함
  try {
    const prev = _loadMru(storageKey)
    const next = [value, ...prev.filter((v) => v !== value)].slice(0, MRU_MAX)
    localStorage.setItem(storageKey, JSON.stringify(next))
  } catch {
    /* private mode / 용량 초과 — 조용히 무시 */
  }
}

/**
 * 검색 가능한 single-select combobox — 작성자/게시조직 필터용. 작은 trigger 와
 * popover 안에 cmdk Command 를 띄움. mruKey 가 주어지면 최근 선택값을
 * localStorage 에 저장하고 드롭다운 상단에 「최근」 그룹으로 분리해 보여줌.
 */
function FilterCombo({
  icon: Icon,
  label,
  value,
  options,
  allLabel,
  searchPlaceholder,
  onChange,
  mruKey,
}) {
  const [open, setOpen] = useState(false)
  // open 시점에 한 번 읽어 fixed snapshot — 선택 동작이 즉시 옵션 재정렬을
  // 일으켜 클릭한 항목 위치가 점프하는 걸 막음.
  const [recentSnapshot, setRecentSnapshot] = useState([])
  useEffect(() => {
    if (open && mruKey) setRecentSnapshot(_loadMru(mruKey))
  }, [open, mruKey])

  const selectedLabel = value
    ? options.find((o) => o.value === value)?.label ?? value
    : allLabel

  const optionByValue = useMemo(
    () => Object.fromEntries(options.map((o) => [o.value, o])),
    [options],
  )
  const recentItems = useMemo(
    () => recentSnapshot.map((v) => optionByValue[v]).filter(Boolean),
    [recentSnapshot, optionByValue],
  )
  const recentSet = useMemo(
    () => new Set(recentItems.map((o) => o.value)),
    [recentItems],
  )
  const restItems = useMemo(
    () => options.filter((o) => !recentSet.has(o.value)),
    [options, recentSet],
  )

  function pick(v) {
    if (mruKey) _saveMru(mruKey, v)
    onChange(v)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1 rounded-md border bg-background px-2 text-[11px]"
          title={label}
        >
          {Icon && <Icon className="h-3 w-3 text-muted-foreground" />}
          <span className="text-muted-foreground">{label}</span>
          <span
            className={cn(
              'truncate max-w-[120px]',
              value ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            {selectedLabel}
          </span>
          <ChevronDown className="h-3 w-3 opacity-50" />
        </button>
      </PopoverTrigger>
      {/* z-[70]: 멘션 다이얼로그 패널(z-[61]) 위로 띄운다. 기본 Popover
          z-50 은 멘션 모달 안에서 쓰일 때 패널 뒤로 깔려 가려졌다. */}
      <PopoverContent className="z-[70] w-[240px] p-0" align="start">
        <Command
          filter={(v, search) =>
            v.toLowerCase().includes(search.toLowerCase()) ? 1 : 0
          }
        >
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList className="max-h-[260px]">
            <CommandEmpty>일치 항목이 없습니다.</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="__all__ 전체"
                onSelect={() => {
                  onChange('')
                  setOpen(false)
                }}
                className="cursor-pointer"
              >
                <span className="flex-1">{allLabel}</span>
                {!value && <Check className="h-4 w-4 text-primary shrink-0" />}
              </CommandItem>
            </CommandGroup>
            {recentItems.length > 0 && (
              <CommandGroup heading="최근">
                {recentItems.map((opt) => (
                  <FilterComboItem
                    key={`recent-${opt.value}`}
                    opt={opt}
                    selectedValue={value}
                    onPick={pick}
                  />
                ))}
              </CommandGroup>
            )}
            <CommandGroup heading={recentItems.length > 0 ? '전체' : undefined}>
              {restItems.map((opt) => (
                <FilterComboItem
                  key={opt.value}
                  opt={opt}
                  selectedValue={value}
                  onPick={pick}
                />
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function FilterComboItem({ opt, selectedValue, onPick }) {
  return (
    <CommandItem
      value={`${opt.value} ${opt.label}`}
      onSelect={() => onPick(opt.value)}
      className="cursor-pointer"
    >
      <span className="flex-1 truncate">{opt.label}</span>
      {opt.count != null && (
        <span className="text-[10px] text-muted-foreground tabular-nums mr-2">
          {opt.count}
        </span>
      )}
      {opt.value === selectedValue && (
        <Check className="h-4 w-4 text-primary shrink-0" />
      )}
    </CommandItem>
  )
}

/**
 * 링크/멘션 대상 보고서를 검색·선택하는 공용 picker.
 *
 *  @param {object}   props
 *  @param {number=}  props.excludeReportId  목록에서 제외할 보고서 id(본 보고서)
 *  @param {object=}  props.selected         현재 선택된 보고서(ReportSummary) | null
 *  @param {(r:object)=>void} props.onSelect 선택 콜백
 */
export function ReportPicker({ excludeReportId, selected, onSelect }) {
  const [allReports, setAllReports] = useState([])
  // slug → kind 매핑. link 대상 적격성(조직 보고서 || 게시된 개인 보고서) 판정.
  const [workspaceKindBySlug, setWorkspaceKindBySlug] = useState({})
  const [authorFacets, setAuthorFacets] = useState([]) // [{name, count}]
  const [mountFacets, setMountFacets] = useState([]) // [{slug, name, count}]
  const [loadingList, setLoadingList] = useState(false)
  const [query, setQuery] = useState('')
  const [datePreset, setDatePreset] = useState('all')
  const [ownerFilter, setOwnerFilter] = useState('') // '' = 전체
  const [mountFilter, setMountFilter] = useState('') // slug, '' = 전체

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoadingList(true)
      // allSettled — 한쪽 호출이 실패해도 나머지로 picker 본체는 동작.
      const [reportsRes, workspacesRes, facetsRes] = await Promise.allSettled([
        listLinkableReports(),
        listWorkspaces(),
        listLinkableFacets(),
      ])
      if (cancelled) return
      if (reportsRes.status === 'fulfilled') {
        setAllReports(Array.isArray(reportsRes.value) ? reportsRes.value : [])
      } else {
        console.warn('listReports for picker failed', reportsRes.reason)
      }
      if (workspacesRes.status === 'fulfilled') {
        const map = {}
        for (const w of workspacesRes.value ?? []) map[w.slug] = w.kind
        setWorkspaceKindBySlug(map)
      } else {
        console.warn('listWorkspaces for picker failed', workspacesRes.reason)
      }
      if (facetsRes.status === 'fulfilled') {
        const f = facetsRes.value
        setAuthorFacets(Array.isArray(f?.authors) ? f.authors : [])
        setMountFacets(Array.isArray(f?.mounts) ? f.mounts : [])
      } else {
        console.warn('listLinkableFacets failed', facetsRes.reason)
      }
      setLoadingList(false)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // 적격 후보(조직 보고서 || 어딘가에 게시된 보고서). 필터/검색은 그 다음.
  const eligible = useMemo(() => {
    return allReports
      .filter((r) => r.id !== excludeReportId)
      .filter((r) => {
        const kind = workspaceKindBySlug[r.workspace_slug]
        if (kind && kind !== 'personal') return true
        return (r.mount_workspaces?.length ?? 0) > 0
      })
  }, [allReports, excludeReportId, workspaceKindBySlug])

  const ownerOptions = useMemo(
    () => authorFacets.map((a) => ({ name: a.name, count: a.count })),
    [authorFacets],
  )
  const mountOptions = useMemo(
    () => mountFacets.map((m) => ({ slug: m.slug, name: m.name, count: m.count })),
    [mountFacets],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const range = _presetFromValue(datePreset)
    return eligible
      .filter((r) => {
        if (!range) return true
        const d = r.report_date
        if (!d) return false
        return d >= range.from && d <= range.to
      })
      .filter((r) => !ownerFilter || r.owner_name === ownerFilter)
      .filter((r) => {
        if (!mountFilter) return true
        return (r.mount_workspaces ?? []).some((m) => m?.slug === mountFilter)
      })
      .filter((r) => {
        if (!q) return true
        if ((r.title || '').toLowerCase().includes(q)) return true
        if ((r.owner_name || '').toLowerCase().includes(q)) return true
        return (r.mount_workspaces ?? []).some((m) =>
          (m?.name || '').toLowerCase().includes(q),
        )
      })
      .slice(0, 40)
  }, [eligible, query, datePreset, ownerFilter, mountFilter])

  return (
    <div className="space-y-2">
      <Input
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          onSelect?.(null)
        }}
        placeholder={
          loadingList ? '보고서 목록 불러오는 중…' : '제목·작성자·게시조직 검색'
        }
        className="h-8 text-xs"
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <select
          value={datePreset}
          onChange={(e) => setDatePreset(e.target.value)}
          className="h-7 rounded-md border bg-background px-2 text-[11px]"
          title="보고서 일자 기간"
        >
          {_DATE_PRESETS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        <FilterCombo
          icon={User}
          label="작성자"
          value={ownerFilter}
          onChange={setOwnerFilter}
          options={ownerOptions.map((o) => ({
            value: o.name,
            label: o.name,
            count: o.count,
          }))}
          allLabel="전체"
          searchPlaceholder="작성자 검색..."
          mruKey="ra:reportLinks:recentAuthors"
        />
        <FilterCombo
          icon={Building2}
          label="게시"
          value={mountFilter}
          onChange={setMountFilter}
          options={mountOptions.map((m) => ({
            value: m.slug,
            label: m.name,
            count: m.count,
          }))}
          allLabel="전체"
          searchPlaceholder="조직 검색..."
          mruKey="ra:reportLinks:recentMounts"
        />
        {(datePreset !== 'all' || ownerFilter || mountFilter || query) && (
          <button
            type="button"
            onClick={() => {
              setDatePreset('all')
              setOwnerFilter('')
              setMountFilter('')
              setQuery('')
            }}
            className="h-7 rounded-md border bg-background px-2 text-[11px] text-muted-foreground hover:bg-muted"
            title="필터/검색 초기화"
          >
            초기화
          </button>
        )}
      </div>
      <div className="text-[10px] text-muted-foreground px-0.5">
        {loadingList
          ? '불러오는 중…'
          : `${filtered.length}건${
              filtered.length === 40 ? ' (최대 표시 — 더 좁히려면 검색/필터)' : ''
            }`}
      </div>
      <ul className="max-h-[200px] overflow-y-auto rounded border bg-muted/30">
        {filtered.length === 0 ? (
          <li className="px-2 py-1 text-[11px] text-muted-foreground italic">
            {loadingList ? ' ' : '일치하는 보고서가 없습니다.'}
          </li>
        ) : (
          filtered.map((r) => {
            const mountNames = (r.mount_workspaces ?? [])
              .map((m) => m?.name)
              .filter(Boolean)
              .join(', ')
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => onSelect?.(r)}
                  className={cn(
                    'flex w-full items-start justify-between gap-2 px-2 py-1 text-left text-[11px]',
                    selected?.id === r.id
                      ? 'bg-primary/15 text-foreground'
                      : 'hover:bg-muted/70',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{r.title}</div>
                    {mountNames && (
                      <div className="truncate text-[10px] text-muted-foreground">
                        게시: {mountNames}
                      </div>
                    )}
                  </div>
                  <span className="shrink-0 text-muted-foreground">
                    {r.owner_name ? `${r.owner_name} · ` : ''}
                    {r.report_date}
                  </span>
                </button>
              </li>
            )
          })
        )}
      </ul>
    </div>
  )
}
