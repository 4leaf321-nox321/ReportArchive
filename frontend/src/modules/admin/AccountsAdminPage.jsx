/** 계정 관리 — 시스템 관리자 전용. 이 페이지의 책임은 "모든 가입자
 *  계정 자체" 의 lifecycle (생성·활성/비활성·비밀번호 재설정·시스템
 *  관리자 권한). 어느 계정이 어느 부서에 소속되는지는 별도 '부서 멤버'
 *  페이지(/w/:slug/members)에서 관리한다. 둘을 분리한 이유:
 *
 *   - 부서 멤버는 부서 컨텍스트 안의 작업 — 부서 관리자(workspace
 *     admin)도 할 수 있고, 부서를 옮겨다니며 보는 것이 자연스럽다.
 *   - 계정 관리는 부서 trees 위에 있는 메타 레벨 — 누가 시스템에 들어와
 *     있는지를 가로지르며 본다. 시스템 관리자만 의미가 있어 권한 모델
 *     자체가 다르다.
 *
 *  Backend: GET /api/users/all + PUT /api/users/{id}/active. 비밀번호
 *  재설정 / 시스템 관리자 토글은 기존 엔드포인트를 그대로 호출.
 */
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Building2,
  Check,
  ChevronDown,
  ClipboardCopy,
  Home,
  KeyRound,
  Loader2,
  ShieldCheck,
  ShieldOff,
  UserPlus,
  UserX,
  UserCheck,
  X as XIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { Badge } from '@/shared/components/ui/badge'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import { Skeleton } from '@/shared/components/ui/skeleton'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/shared/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/shared/components/ui/command'
import { ConfirmDialog } from '@/shared/components/ConfirmDialog'
import { DataTable } from '@/shared/components/DataTable'
import { PageHeader } from '@/shared/components/PageHeader'
import { ErrorState } from '@/shared/components/ErrorState'
import { useAuth } from '@/shared/auth/AuthContext'
import { useAsync } from '@/shared/hooks/useAsync'
import {
  getAccountDetail,
  listAllAccounts,
  setUserActive,
  setUserHomeWorkspace,
  adminSetUserPassword,
  listPasswordResetRequests,
  resolvePasswordResetRequest,
} from '@/shared/api/me'
import { register as registerUser } from '@/shared/api/auth'
import { setSystemAdmin } from '@/shared/api/systemAdmins'
import { WorkspaceCombobox } from '@/shared/components/WorkspaceCombobox'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'

/** navigator.clipboard 는 보안 컨텍스트(HTTPS·localhost)에서만 존재한다.
 *  운영서버를 평문 HTTP 로 접속하면 navigator.clipboard 자체가 undefined 라
 *  .writeText 접근에서 터진다. 그 경우 레거시 execCommand('copy') 로 폴백. */
async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text)
  }
  const ta = document.createElement('textarea')
  ta.value = text
  // 화면 밖으로 빼되 포커스/선택은 가능하게 — display:none 이면 선택이 안 됨.
  ta.style.position = 'fixed'
  ta.style.left = '-9999px'
  ta.setAttribute('readonly', '')
  document.body.appendChild(ta)
  ta.select()
  try {
    const ok = document.execCommand('copy')
    if (!ok) throw new Error('execCommand copy 실패')
  } finally {
    document.body.removeChild(ta)
  }
}

export default function AccountsAdminPage() {
  const { me } = useAuth()
  const { all: workspaces } = useWorkspace()
  const isSystemAdmin = me?.is_system_admin === true

  // home 부서 picker 가 쓰는 후보군 — 가상/personal 은 가입 대상이 아니라
  // 제외. WorkspaceContext.all 은 사용자가 보는 전 트리를 들고 있으므로
  // 시스템 관리자에겐 충분.
  const assignableWorkspaces = useMemo(
    () => (workspaces ?? []).filter((w) => !w.virtual && w.kind !== 'personal'),
    [workspaces],
  )

  const [reloadKey, setReloadKey] = useState(0)
  const [includeInactive, setIncludeInactive] = useState(true)
  const { data, loading, error } = useAsync(
    () =>
      isSystemAdmin
        ? listAllAccounts({ includeInactive })
        : Promise.resolve([]),
    [isSystemAdmin, includeInactive, reloadKey],
  )
  // Wrap in useMemo so the `?? []` fallback doesn`t alias to a fresh
  // empty array every render — would otherwise churn the downstream
  // useMemos (homeOptions / hasNoHome / filteredAccounts) on each tick.
  const accounts = useMemo(() => data ?? [], [data])

  const [newAccountOpen, setNewAccountOpen] = useState(false)
  const [resetPwdTarget, setResetPwdTarget] = useState(null)
  const [confirmActive, setConfirmActive] = useState(null) // {account, nextActive}
  const [homeEditTarget, setHomeEditTarget] = useState(null)
  const [detailTarget, setDetailTarget] = useState(null) // row clicked → show detail
  // 소속 필터 — `null` 이면 전체 (필터 없음), 그 외엔 선택된 키들의
  // `Set<string>`. 각 키는 workspace slug 거나 특수값 `__none__` (소속
  // 미지정). 여러 부서를 동시에 선택 가능 — 선택된 부서 중 어느 하나라도
  // 매칭되면 통과 (OR 매칭). 빈 Set 상태가 발생하면 null 로 자동
  // 정규화해 "전체" 와 동일하게 다룬다 (UI 에 "0개 선택" 같은 어색한
  // 상태가 노출되지 않도록).
  const [homeFilter, setHomeFilter] = useState(null)
  // Popover open/close. 복수선택이라 항목 클릭으로는 닫지 않고, 「전체」
  // 만 한 번에 clear + close.
  const [filterOpen, setFilterOpen] = useState(false)

  function reload() {
    setReloadKey((k) => k + 1)
  }

  // slug → 그 부서의 모든 자손(자기 자신 포함) slug Set. 부모 부서를
  // 선택하면 자손까지 매칭되게 하기 위한 인덱스. 한 번 빌드해두면
  // filter 단계가 O(1) lookup.
  const descendantsBySlug = useMemo(() => {
    const list = assignableWorkspaces
    const childrenMap = new Map()
    for (const w of list) {
      const parent = w.parent_slug ?? null
      const arr = childrenMap.get(parent) ?? []
      arr.push(w.slug)
      childrenMap.set(parent, arr)
    }
    const out = new Map()
    for (const w of list) {
      const set = new Set([w.slug])
      const stack = [w.slug]
      while (stack.length > 0) {
        const cur = stack.pop()
        for (const child of childrenMap.get(cur) ?? []) {
          if (!set.has(child)) {
            set.add(child)
            stack.push(child)
          }
        }
      }
      out.set(w.slug, set)
    }
    return out
  }, [assignableWorkspaces])

  // 드롭다운에 보여줄 부서 옵션 — 트리 순회 (parent 먼저, 그 다음 자식
  // 재귀) 로 정렬되어 popover 에서 들여쓰기 (`depth`) 가 부모/자식
  // 관계를 시각적으로 드러냄. WorkspaceCombobox 와 같은 패턴.
  //
  // count 는 해당 부서의 **자손 전체 합계** — 부모를 보고 "이 본부에
  // 총 N명 있구나" 가 한눈에 보이도록. 자손합이 0 인 가지는 (= 누구도
  // 그 서브트리에 home 으로 등록되지 않음) UI 노이즈라서 숨김.
  const homeOptions = useMemo(() => {
    // direct: 정확히 이 slug 를 home 으로 가진 계정 수
    const direct = new Map()
    for (const a of accounts) {
      if (!a.home_workspace_slug) continue
      direct.set(
        a.home_workspace_slug,
        (direct.get(a.home_workspace_slug) ?? 0) + 1,
      )
    }
    const childrenMap = new Map()
    for (const w of assignableWorkspaces) {
      const parent = w.parent_slug ?? null
      const arr = childrenMap.get(parent) ?? []
      arr.push(w)
      childrenMap.set(parent, arr)
    }
    // 한국어 locale 로 자식 정렬 — 같은 부모 아래에서만 의미 있음.
    for (const arr of childrenMap.values()) {
      arr.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'ko'))
    }
    const out = []
    function walk(parentSlug, depth) {
      for (const w of childrenMap.get(parentSlug ?? null) ?? []) {
        const desc = descendantsBySlug.get(w.slug) ?? new Set([w.slug])
        let count = 0
        for (const d of desc) count += direct.get(d) ?? 0
        if (count > 0) {
          out.push({
            slug: w.slug,
            label: w.name || w.slug,
            depth,
            count,
          })
        }
        walk(w.slug, depth + 1)
      }
    }
    walk(null, 0)
    return out
  }, [accounts, assignableWorkspaces, descendantsBySlug])

  const noHomeCount = useMemo(
    () => accounts.reduce((n, a) => (a.home_workspace_slug ? n : n + 1), 0),
    [accounts],
  )

  // 적용된 필터 결과. 다중 선택의 OR 매칭 + 선택된 각 부서의 자손까지
  // 포함. 동작:
  //   1) 선택된 slug 들의 자손 집합 union 을 `passing` 으로 펼침
  //   2) 각 account 의 home_workspace_slug 가 그 집합에 있으면 통과
  //   3) `__none__` 이 선택돼 있으면 home 없는 account 도 추가로 통과
  // 트리에 없는 orphan slug (이미 사라진 부서의 잔존 home 값) 는 자기
  // 자신만 매칭되도록 fallback — 사라진 부서 사용자도 검색할 수 있게.
  const filteredAccounts = useMemo(() => {
    if (!homeFilter || homeFilter.size === 0) return accounts
    const passing = new Set()
    let includesNone = false
    for (const sel of homeFilter) {
      if (sel === '__none__') {
        includesNone = true
        continue
      }
      const desc = descendantsBySlug.get(sel)
      if (desc) {
        for (const d of desc) passing.add(d)
      } else {
        passing.add(sel)
      }
    }
    return accounts.filter((a) => {
      if (!a.home_workspace_slug) return includesNone
      return passing.has(a.home_workspace_slug)
    })
  }, [accounts, homeFilter, descendantsBySlug])

  // 필터 트리거 버튼에 표시할 현재 선택 라벨.
  //   null/빈 Set → "전체"
  //   단 1개       → 그 항목의 라벨 (특수값 __none__ 은 "소속 없음")
  //   여러 개      → "N개 선택"
  const homeFilterLabel = useMemo(() => {
    if (!homeFilter || homeFilter.size === 0) return '전체'
    if (homeFilter.size === 1) {
      const only = homeFilter.values().next().value
      if (only === '__none__') return '소속 없음'
      const opt = homeOptions.find((o) => o.slug === only)
      return opt?.label ?? only
    }
    return `${homeFilter.size}개 선택`
  }, [homeFilter, homeOptions])

  // 항목 toggle — popover 는 열린 상태 유지. 빈 Set 이 되면 null 로
  // 정규화해서 "전체" 와 동일한 상태로.
  function toggleHomeFilter(key) {
    setHomeFilter((prev) => {
      const next = new Set(prev ?? [])
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next.size === 0 ? null : next
    })
  }

  /** 현재 필터된 계정들의 이메일을 `email1;email2;...` 로 묶어 클립보드.
   *  세미콜론은 Outlook / 다수 사내 메일 클라이언트가 To 필드 구분자로
   *  쓰는 포맷이라 그대로 paste 하면 수신자 리스트로 인식된다. 빈 이메일은
   *  필터링 (가입은 됐는데 이메일이 비어있는 잘못된 row 가 있는 경우). */
  async function handleCopyEmails() {
    const emails = filteredAccounts
      .map((a) => a.email?.trim())
      .filter(Boolean)
      .join(';')
    if (!emails) {
      toast.error('복사할 이메일이 없습니다.')
      return
    }
    try {
      await copyTextToClipboard(emails)
      const n = emails.split(';').length
      toast.success(
        homeFilter
          ? `필터된 ${n}개의 이메일을 복사했습니다.`
          : `${n}개의 이메일을 복사했습니다.`,
      )
    } catch (err) {
      toast.error('클립보드 복사 실패: ' + (err?.message ?? String(err)))
    }
  }

  if (!isSystemAdmin) {
    return (
      <div className="p-6">
        <PageHeader title="계정 관리" description="시스템 관리자 전용" />
        <ErrorState
          title="권한 없음"
          description="계정 관리 페이지는 시스템 관리자만 접근 가능합니다."
          action={
            <Button asChild variant="outline">
              <Link to="/">홈으로</Link>
            </Button>
          }
        />
      </div>
    )
  }

  async function handleToggleSystemAdmin(account) {
    const next = !account.is_system_admin
    try {
      await setSystemAdmin(account.id, next)
      toast.success(
        next
          ? `'${account.name || account.email}' 시스템 관리자 권한 부여`
          : `'${account.name || account.email}' 시스템 관리자 권한 해제`,
      )
      reload()
    } catch (err) {
      toast.error(err?.response?.data?.message || err.message || '권한 변경 실패')
    }
  }

  async function handleSetActive(account, nextActive) {
    try {
      await setUserActive(account.id, { isActive: nextActive })
      toast.success(
        nextActive
          ? `'${account.name || account.email}' 계정 활성화됨`
          : `'${account.name || account.email}' 계정 비활성화됨`,
      )
      setConfirmActive(null)
      reload()
    } catch (err) {
      toast.error(err?.response?.data?.message || err.message || '계정 상태 변경 실패')
    }
  }

  const columns = useMemo(
    () => [
      {
        key: 'name',
        header: '이름',
        sortable: true,
        render: (a) => (
          <div className="flex items-center gap-2 min-w-0">
            <div className="rounded-full bg-muted h-7 w-7 flex items-center justify-center text-[11px] font-medium shrink-0">
              {a.name?.charAt(0) || a.email?.charAt(0) || '?'}
            </div>
            <span className={a.is_active ? 'font-medium' : 'text-muted-foreground line-through'}>
              {a.name || '—'}
            </span>
          </div>
        ),
      },
      {
        key: 'email',
        header: '이메일',
        sortable: true,
        render: (a) => (
          <span className="text-sm text-muted-foreground font-mono truncate">
            {a.email}
          </span>
        ),
      },
      {
        key: 'is_active',
        header: '상태',
        sortable: true,
        headerClassName: 'w-[90px]',
        render: (a) =>
          a.is_active ? (
            <Badge variant="secondary" className="text-[10px]">활성</Badge>
          ) : (
            <Badge variant="outline" className="text-[10px] text-muted-foreground">
              비활성
            </Badge>
          ),
      },
      {
        key: 'is_system_admin',
        header: '시스템 관리자',
        sortable: true,
        headerClassName: 'w-[120px]',
        render: (a) =>
          a.is_system_admin ? (
            <Badge variant="default" className="text-[10px] gap-1">
              <ShieldCheck className="h-2.5 w-2.5" />
              관리자
            </Badge>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          ),
      },
      {
        key: 'home_workspace_name',
        header: '소속',
        sortable: true,
        headerClassName: 'w-[200px]',
        render: (a) => (
          <button
            type="button"
            className={
              'inline-flex items-center gap-1 text-xs hover:underline truncate text-left max-w-full ' +
              (a.home_workspace_slug
                ? 'text-foreground/80'
                : 'text-amber-700')
            }
            onClick={(e) => {
              e.stopPropagation()
              setHomeEditTarget(a)
            }}
            title="소속 부서 변경"
          >
            <Building2 className="h-3 w-3 shrink-0 opacity-70" />
            <span className="truncate">
              {a.home_workspace_name || (a.home_workspace_slug ? a.home_workspace_slug : '소속 없음')}
            </span>
          </button>
        ),
      },
      {
        key: 'membership_count',
        header: '부서 수',
        sortable: true,
        headerClassName: 'w-[80px] text-right',
        cellClassName: 'text-right',
        render: (a) => (
          <span
            className="text-xs text-muted-foreground tabular-nums"
            title="소속 부서를 포함한 모든 워크스페이스 멤버십 수 (personal-* 포함)"
          >
            {a.membership_count ?? 0}
          </span>
        ),
      },
      {
        key: 'created_at',
        header: '가입일',
        sortable: true,
        headerClassName: 'w-[110px]',
        render: (a) => (
          <span className="text-xs text-muted-foreground whitespace-nowrap font-mono">
            {formatDate(a.created_at)}
          </span>
        ),
      },
      {
        key: '_actions',
        header: '',
        headerClassName: 'w-[200px]',
        render: (a) => {
          const isSelf = me?.user?.id === a.id
          return (
            <div className="flex items-center justify-end gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                title="비밀번호 재설정"
                onClick={(e) => {
                  e.stopPropagation()
                  setResetPwdTarget(a)
                }}
              >
                <KeyRound className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                title={a.is_system_admin ? '시스템 관리자 해제' : '시스템 관리자 부여'}
                onClick={(e) => {
                  e.stopPropagation()
                  handleToggleSystemAdmin(a)
                }}
                disabled={isSelf && a.is_system_admin}
              >
                {a.is_system_admin ? (
                  <ShieldOff className="h-3.5 w-3.5 text-muted-foreground" />
                ) : (
                  <ShieldCheck className="h-3.5 w-3.5" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={
                  'h-7 w-7 p-0 ' +
                  (a.is_active ? 'text-destructive hover:text-destructive' : '')
                }
                title={a.is_active ? '계정 비활성화' : '계정 활성화'}
                onClick={(e) => {
                  e.stopPropagation()
                  setConfirmActive({ account: a, nextActive: !a.is_active })
                }}
                disabled={isSelf && a.is_active}
              >
                {a.is_active ? (
                  <UserX className="h-3.5 w-3.5" />
                ) : (
                  <UserCheck className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
          )
        },
      },
    ],
    [me?.user?.id],
  )

  return (
    <div className="p-6 space-y-4">
      <PageHeader
        title="계정 관리"
        description="모든 가입자 계정의 lifecycle. 어느 계정이 어느 부서에 소속되는지는 '부서 멤버' 메뉴에서 별도로 관리."
        actions={
          <Button size="sm" onClick={() => setNewAccountOpen(true)}>
            <UserPlus className="mr-1 h-3.5 w-3.5" />
            계정 추가
          </Button>
        }
      />

      <PasswordResetRequestsPanel />

      <div className="flex items-center gap-3 flex-wrap">
        <label className="inline-flex items-center gap-1.5 cursor-pointer select-none text-xs">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          <span>비활성 포함</span>
        </label>
        {/* 소속 필터 — 검색 가능한 cmdk 기반 popover. 부서가 많아져도
            CommandInput 으로 좁혀가며 도달 가능. 「전체」/「소속 없음」 도
            동일 리스트의 항목으로 두어 검색만으로도 모든 옵션 도달.
            라벨 옆 카운트는 모집단 직관: "이 부서 N명" 한 줄로. */}
        <div className="inline-flex items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">소속</span>
          <Popover open={filterOpen} onOpenChange={setFilterOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                role="combobox"
                aria-expanded={filterOpen}
                className="h-7 gap-1.5 text-xs font-normal"
              >
                <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                <span
                  className={
                    'max-w-[180px] truncate ' +
                    (homeFilter ? 'text-foreground' : 'text-muted-foreground')
                  }
                >
                  {homeFilterLabel}
                </span>
                <ChevronDown className="h-3 w-3 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[280px] p-0" align="start">
              <Command
                filter={(value, search) =>
                  value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0
                }
              >
                <CommandInput placeholder="부서명 / slug 검색..." />
                <CommandList className="max-h-[320px]">
                  <CommandEmpty>일치하는 부서가 없습니다.</CommandEmpty>
                  <CommandGroup>
                    {/* 「전체」 — clear-all 단일 액션. 토글이 아니라 명시
                        지시여서 클릭 시 popover 도 닫음. */}
                    <CommandItem
                      value="전체 all clear"
                      onSelect={() => {
                        setHomeFilter(null)
                        setFilterOpen(false)
                      }}
                      className="cursor-pointer"
                    >
                      <span className="flex-1 font-medium">전체</span>
                      <span className="text-[10px] text-muted-foreground tabular-nums mr-2">
                        {accounts.length}
                      </span>
                      {(!homeFilter || homeFilter.size === 0) && (
                        <Check className="h-4 w-4 text-primary shrink-0" />
                      )}
                    </CommandItem>
                    {noHomeCount > 0 && (
                      <CommandItem
                        value="소속 없음 none unset 미지정"
                        onSelect={() => toggleHomeFilter('__none__')}
                        className="cursor-pointer"
                      >
                        <span className="flex-1 italic text-muted-foreground">
                          소속 없음
                        </span>
                        <span className="text-[10px] text-muted-foreground tabular-nums mr-2">
                          {noHomeCount}
                        </span>
                        {homeFilter?.has('__none__') && (
                          <Check className="h-4 w-4 text-primary shrink-0" />
                        )}
                      </CommandItem>
                    )}
                  </CommandGroup>
                  <CommandGroup heading="부서">
                    {homeOptions.map((opt) => (
                      <CommandItem
                        key={opt.slug}
                        value={`${opt.slug} ${opt.label}`}
                        onSelect={() => toggleHomeFilter(opt.slug)}
                        className="cursor-pointer"
                      >
                        <span
                          className="flex items-center gap-1 min-w-0 flex-1"
                          // depth 별 들여쓰기 — 트리 구조 시각화. 각 단계
                          // 10px 씩 (WorkspaceCombobox 12px 와 유사하지만
                          // 좁은 popover 폭에 맞춰 조금 줄임).
                          style={{ paddingLeft: opt.depth * 10 }}
                        >
                          <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <div className="flex flex-col min-w-0 flex-1">
                            <span className="truncate">{opt.label}</span>
                            {opt.label !== opt.slug && (
                              <span className="truncate text-[10px] text-muted-foreground font-mono">
                                {opt.slug}
                              </span>
                            )}
                          </div>
                        </span>
                        <span
                          className="text-[10px] text-muted-foreground tabular-nums mr-2 shrink-0"
                          title="이 부서와 모든 하위 부서의 합계 인원"
                        >
                          {opt.count}
                        </span>
                        {homeFilter?.has(opt.slug) && (
                          <Check className="h-4 w-4 text-primary shrink-0" />
                        )}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
          {homeFilter && (
            <button
              type="button"
              onClick={() => setHomeFilter(null)}
              className="inline-flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
              title="필터 해제"
              aria-label="필터 해제"
            >
              <XIcon className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {/* 이메일 복사 — 현재 필터된 모집단의 이메일을 ";" 구분자로 묶어
            클립보드. Outlook / Gmail / 다수 사내 메일 클라이언트 To 필드
            그대로 paste 가능. */}
        <Button
          size="sm"
          variant="outline"
          onClick={handleCopyEmails}
          disabled={filteredAccounts.length === 0}
          title="이메일 주소를 세미콜론(;) 구분자로 클립보드에 복사"
        >
          <ClipboardCopy className="mr-1 h-3.5 w-3.5" />
          이메일 복사
        </Button>
        <span className="text-[11px] text-muted-foreground ml-auto">
          {homeFilter
            ? `${filteredAccounts.length} / ${accounts.length}건`
            : `총 ${accounts.length}건`}
        </span>
      </div>

      {error ? (
        <ErrorState description={error.message} onRetry={reload} />
      ) : loading ? (
        <Skeleton className="h-72" />
      ) : (
        <DataTable
          columns={columns}
          data={filteredAccounts}
          fixedLayout
          minTableWidthClass="min-w-[900px]"
          defaultSort={{ key: 'created_at', dir: 'desc' }}
          pageSizeStorageKey="accounts-admin"
          searchableKeys={['name', 'email']}
          searchPlaceholder="이름 / 이메일 검색"
          onRowClick={(a) => setDetailTarget(a)}
        />
      )}

      {newAccountOpen && (
        <NewAccountDialog
          assignableWorkspaces={assignableWorkspaces}
          onClose={() => setNewAccountOpen(false)}
          onCreated={() => {
            setNewAccountOpen(false)
            reload()
          }}
        />
      )}

      {homeEditTarget && (
        <HomeWorkspaceDialog
          target={homeEditTarget}
          assignableWorkspaces={assignableWorkspaces}
          onClose={() => setHomeEditTarget(null)}
          onChanged={() => {
            setHomeEditTarget(null)
            reload()
          }}
        />
      )}

      {detailTarget && (
        <AccountDetailDialog
          target={detailTarget}
          onClose={() => setDetailTarget(null)}
        />
      )}

      {resetPwdTarget && (
        <ResetPasswordDialog
          target={resetPwdTarget}
          onClose={() => setResetPwdTarget(null)}
        />
      )}

      {confirmActive && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setConfirmActive(null)}
          title={confirmActive.nextActive ? '계정 활성화' : '계정 비활성화'}
          description={
            confirmActive.nextActive
              ? `'${confirmActive.account.name || confirmActive.account.email}' 계정을 다시 활성화합니다. 로그인 차단이 해제되고 기존 세션은 다음 요청부터 사용 가능합니다.`
              : `'${confirmActive.account.name || confirmActive.account.email}' 계정을 비활성화합니다. 즉시 로그인 차단되고 진행 중인 세션은 다음 API 요청에서 만료됩니다. 부서 소속이나 작성한 보고서는 그대로 유지됩니다.`
          }
          confirmLabel={confirmActive.nextActive ? '활성화' : '비활성화'}
          variant={confirmActive.nextActive ? 'default' : 'destructive'}
          onConfirm={() =>
            handleSetActive(confirmActive.account, confirmActive.nextActive)
          }
        />
      )}
    </div>
  )
}

function NewAccountDialog({ assignableWorkspaces, onClose, onCreated }) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [workspaceSlug, setWorkspaceSlug] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState(null)

  async function onSubmit(e) {
    e.preventDefault()
    setErrorMsg(null)
    if (password.length < 8) {
      setErrorMsg('비밀번호는 8자 이상이어야 합니다.')
      return
    }
    setSubmitting(true)
    try {
      await registerUser({
        email: email.trim(),
        name: name.trim(),
        password,
        workspaceSlug: workspaceSlug || undefined,
      })
      toast.success(`'${name || email}' 계정이 생성됐습니다.`)
      onCreated()
    } catch (err) {
      setErrorMsg(err?.response?.data?.message || err.message || '계정 생성 실패')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>계정 추가</DialogTitle>
          <DialogDescription>
            새 사용자 계정만 생성됩니다. 부서 소속은 별도로 '부서 멤버'
            메뉴에서 추가해야 해요. 생성된 사용자에게 초기 비밀번호를
            직접 전달해 주세요.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="new-account-email">이메일</Label>
            <Input
              id="new-account-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="user@example.com"
              required
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-account-name">이름</Label>
            <Input
              id="new-account-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="홍길동"
              maxLength={128}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-account-pwd">초기 비밀번호</Label>
            <Input
              id="new-account-pwd"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="8자 이상"
              minLength={8}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-account-ws">소속 부서 (선택)</Label>
            <WorkspaceCombobox
              id="new-account-ws"
              workspaces={assignableWorkspaces}
              value={workspaceSlug}
              onChange={(s) => setWorkspaceSlug(s ?? '')}
              placeholder="부서 선택 안 함"
              searchPlaceholder="부서 검색"
            />
            <p className="text-[11px] text-muted-foreground">
              지정하면 그 부서의 멤버 row 가 같이 생성됩니다. 나중에 '계정
              관리' 에서 변경 가능.
            </p>
          </div>
          {errorMsg && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {errorMsg}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              취소
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? '생성 중...' : '생성'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** 한 계정의 상세를 보여주는 read-only 다이얼로그. 행 클릭으로 열림.
 *  '부서 수' 카운트만으로는 부족한 "어느 부서들에 어떤 role 로 들어가
 *  있나" 를 한눈에 보게. personal 워크스페이스 (자기 개인공간) 와 실제
 *  org/virtual 부서를 시각적으로 구분해 표시. */
function AccountDetailDialog({ target, onClose }) {
  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    getAccountDetail(target.id)
      .then((data) => {
        if (!cancelled) setDetail(data)
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message || '계정 정보를 불러오지 못했습니다.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [target.id])

  // personal-{id} 는 누구나 자기 개인 공간을 갖고 매니저 role 로 자동
  // 가입되므로 부서 목록과 분리해 보여줘야 의미 있음.
  const orgMemberships =
    detail?.memberships?.filter((m) => m.workspace_kind !== 'personal') ?? []
  const personalMemberships =
    detail?.memberships?.filter((m) => m.workspace_kind === 'personal') ?? []

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-fit min-w-[28rem] max-w-[min(95vw,48rem)]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {target.name || target.email}
            {!target.is_active && (
              <Badge variant="outline" className="text-[10px] text-muted-foreground">
                비활성
              </Badge>
            )}
            {target.is_system_admin && (
              <Badge variant="default" className="text-[10px] gap-1">
                <ShieldCheck className="h-2.5 w-2.5" />
                시스템 관리자
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription className="break-all">
            {target.email} · 가입일 {formatDate(target.created_at)}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                소속 부서
              </div>
              {detail.home_workspace_slug ? (
                <div className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-sm">
                  <Home className="h-3.5 w-3.5 text-amber-500" />
                  <span className="font-medium">
                    {detail.home_workspace_name || detail.home_workspace_slug}
                  </span>
                  <span className="text-[10px] text-muted-foreground font-mono">
                    {detail.home_workspace_slug}
                  </span>
                </div>
              ) : (
                <span className="text-xs text-amber-700">
                  소속 부서 미지정 — 계정 관리 페이지에서 지정 필요
                </span>
              )}
            </div>

            <div className="space-y-1.5">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <Building2 className="h-3 w-3" />
                부서 멤버십 ({orgMemberships.length}개)
              </div>
              {orgMemberships.length === 0 ? (
                <p className="text-xs text-muted-foreground py-2">
                  어느 부서에도 멤버로 등록되어 있지 않습니다.
                </p>
              ) : (
                <ul className="divide-y rounded-md border">
                  {orgMemberships.map((m) => (
                    <li
                      key={m.workspace_slug}
                      className="flex items-center gap-2 px-2.5 py-1.5 text-sm"
                    >
                      <span className="flex-1 truncate">
                        {m.workspace_name}
                        <span className="ml-1.5 text-[10px] text-muted-foreground font-mono">
                          {m.workspace_slug}
                        </span>
                      </span>
                      {m.is_home && (
                        <Badge
                          variant="default"
                          className="text-[10px] gap-0.5 shrink-0"
                          title="소속 부서"
                        >
                          <Home className="h-2.5 w-2.5" />
                          소속
                        </Badge>
                      )}
                      <Badge
                        variant={m.role === 'manager' ? 'default' : 'outline'}
                        className="text-[10px] shrink-0"
                      >
                        {m.role === 'manager' ? '매니저' : '사용자'}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {personalMemberships.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  개인 공간
                </div>
                <ul className="text-xs text-muted-foreground space-y-0.5">
                  {personalMemberships.map((m) => (
                    <li key={m.workspace_slug} className="font-mono">
                      {m.workspace_slug}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            닫기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function HomeWorkspaceDialog({ target, assignableWorkspaces, onClose, onChanged }) {
  const [workspaceSlug, setWorkspaceSlug] = useState(target.home_workspace_slug ?? '')
  const [submitting, setSubmitting] = useState(false)

  async function handleSave() {
    setSubmitting(true)
    try {
      await setUserHomeWorkspace(target.id, {
        workspaceSlug: workspaceSlug || null,
      })
      toast.success(
        workspaceSlug
          ? `'${target.name || target.email}' 의 소속 부서가 변경되었습니다.`
          : `'${target.name || target.email}' 의 소속이 해제되었습니다.`,
      )
      onChanged()
    } catch (err) {
      toast.error(err?.response?.data?.message || err.message || '소속 변경 실패')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      {/* Dynamic width — 부서 트리 경로(전체 슬러그 path)가 길어지면
          기본 max-w-lg(512px) 으로 부서명/이메일/안내문이 모달 밖으로
          삐져나오는 케이스가 있어서 WorkspaceEditDialog 와 같은 정책으로
          맞춤. w-fit + min-w 베이스라인 + 95vw 캡. */}
      <DialogContent className="w-fit min-w-[28rem] max-w-[min(95vw,48rem)]">
        <DialogHeader>
          <DialogTitle>소속 부서 변경</DialogTitle>
          <DialogDescription className="break-all">
            {target.email}. 소속을 바꾸면 새 부서에는 자동으로 멤버로
            추가됩니다 (기존 다른 부서 멤버십은 그대로 유지). 부서 멤버
            페이지에서 그 사용자의 소속 row 는 직접 제거할 수 없으니
            소속을 옮기려면 여기서 바꾸어 주세요.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">새 소속 부서</Label>
            <WorkspaceCombobox
              workspaces={assignableWorkspaces}
              value={workspaceSlug}
              onChange={(s) => setWorkspaceSlug(s ?? '')}
              placeholder="소속 없음"
              searchPlaceholder="부서 검색"
              noTruncate
            />
            <p className="text-[11px] text-muted-foreground">
              비워두면 소속 해제. 부서 멤버십 자체는 별도 — 소속 해제
              해도 기존 부서들의 멤버 row 는 남아 있습니다.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            취소
          </Button>
          <Button onClick={handleSave} disabled={submitting}>
            {submitting ? '저장 중...' : '저장'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ResetPasswordDialog({ target, onClose }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState(null)

  // 재오픈 시 폼 리셋 — target 변경 동안 이전 입력값 유출되지 않게.
  useEffect(() => {
    setPassword('')
    setConfirm('')
    setErrorMsg(null)
  }, [target?.id])

  async function onSubmit(e) {
    e.preventDefault()
    setErrorMsg(null)
    if (password !== confirm) {
      setErrorMsg('새 비밀번호가 일치하지 않습니다.')
      return
    }
    if (password.length < 8) {
      setErrorMsg('비밀번호는 8자 이상이어야 합니다.')
      return
    }
    setSubmitting(true)
    try {
      await adminSetUserPassword(target.id, { newPassword: password })
      toast.success(`${target.email}의 비밀번호가 재설정되었습니다.`)
      onClose()
    } catch (err) {
      setErrorMsg(err?.response?.data?.message || err.message || '재설정 실패')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>비밀번호 재설정</DialogTitle>
          <DialogDescription>
            {target.email} 의 비밀번호를 새로 설정합니다. 사용자에게 새
            비밀번호를 직접 전달하세요.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="reset-pwd">새 비밀번호</Label>
            <Input
              id="reset-pwd"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="8자 이상"
              minLength={8}
              required
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reset-pwd-confirm">새 비밀번호 확인</Label>
            <Input
              id="reset-pwd-confirm"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              minLength={8}
              required
            />
          </div>
          {errorMsg && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {errorMsg}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              취소
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? '재설정 중...' : '재설정'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function formatDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString().slice(0, 10)
}

// 비밀번호 찾기 대기 큐 — 사용자가 '비밀번호 찾기'로 접수한 요청을 보여주고,
// 본인 확인 후 임시 비번을 발급해 해소한다. 요청 없음/권한 없음이면 숨김.
function PasswordResetRequestsPanel() {
  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const [resolving, setResolving] = useState(null)

  async function load() {
    try {
      const data = await listPasswordResetRequests()
      setRequests(data ?? [])
    } catch {
      setRequests([])
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    load()
  }, [])

  if (loading || requests.length === 0) return null

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-900/50 dark:bg-amber-950/20">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-900 dark:text-amber-200">
        <KeyRound className="h-4 w-4" />
        비밀번호 재설정 요청 ({requests.length})
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        사용자가 '비밀번호 찾기'로 접수한 요청입니다. 본인 확인 후 임시
        비밀번호를 발급하면, 사용자는 최초 로그인 시 새 비밀번호를 설정합니다.
      </p>
      <ul className="divide-y divide-amber-200/60 dark:divide-amber-900/40">
        {requests.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-3 py-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">
                {r.user_name || '(미가입 이메일)'}{' '}
                <span className="font-normal text-muted-foreground">· {r.email}</span>
              </div>
              <div className="text-xs text-muted-foreground">
                요청 {new Date(r.created_at).toLocaleString()}
              </div>
            </div>
            <Button
              size="sm"
              disabled={!r.user_id}
              onClick={() => setResolving(r)}
              title={r.user_id ? '' : '가입된 계정이 없어 발급할 수 없습니다'}
            >
              <KeyRound className="mr-1.5 h-3.5 w-3.5" />
              임시 비번 발급
            </Button>
          </li>
        ))}
      </ul>
      <ResolveResetDialog
        request={resolving}
        onOpenChange={(open) => !open && setResolving(null)}
        onResolved={() => {
          setResolving(null)
          load()
        }}
      />
    </div>
  )
}

function ResolveResetDialog({ request, onOpenChange, onResolved }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState(null)

  useEffect(() => {
    if (request) {
      setPassword('')
      setConfirm('')
      setErrorMsg(null)
      setSubmitting(false)
    }
  }, [request])

  async function onSubmit(e) {
    e.preventDefault()
    setErrorMsg(null)
    if (password !== confirm) {
      setErrorMsg('비밀번호가 일치하지 않습니다.')
      return
    }
    if (password.length < 8) {
      setErrorMsg('비밀번호는 8자 이상이어야 합니다.')
      return
    }
    setSubmitting(true)
    try {
      await resolvePasswordResetRequest(request.id, { newPassword: password })
      toast.success(
        `임시 비밀번호를 발급했습니다. ${request.email}에게 전달하세요 (최초 로그인 시 변경됨).`,
      )
      onResolved?.()
    } catch (err) {
      setErrorMsg(err?.response?.data?.message || err.message || '발급에 실패했습니다.')
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={Boolean(request)} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>임시 비밀번호 발급</DialogTitle>
          <DialogDescription>
            {request?.email} 의 임시 비밀번호를 설정합니다. 본인임을 확인한 뒤
            발급하고 사용자에게 안전하게 전달하세요. 사용자는 최초 로그인 시 새
            비밀번호를 설정하게 됩니다.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="resolve-pwd">임시 비밀번호</Label>
            <Input
              id="resolve-pwd"
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="8자 이상"
              autoComplete="off"
              required
              minLength={8}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="resolve-pwd-confirm">임시 비밀번호 확인</Label>
            <Input
              id="resolve-pwd-confirm"
              type="text"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="off"
              required
              minLength={8}
            />
          </div>
          {errorMsg && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {errorMsg}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              취소
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? '발급 중...' : '발급'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
