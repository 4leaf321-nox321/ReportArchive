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
import { useEffect, useMemo, useRef, useState } from 'react'
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
  Trash2,
  UserPlus,
  UserX,
  UserCheck,
  X as XIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { copyTextToClipboard } from '@/shared/lib/clipboard'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/components/ui/tabs'
import { ConfirmDialog } from '@/shared/components/ConfirmDialog'
import { DataTable } from '@/shared/components/DataTable'
import { PageHeader } from '@/shared/components/PageHeader'
import { ErrorState } from '@/shared/components/ErrorState'
import { useAuth } from '@/shared/auth/AuthContext'
import { useAsync } from '@/shared/hooks/useAsync'
import {
  getAccountDetail,
  listAllAccounts,
  listAccessLogs,
  accessLogStats,
  accessLogStatsDetail,
  setUserActive,
  deleteUser,
  getUserDeleteDependents,
  setUserHomeWorkspace,
  adminSetUserPassword,
  listPasswordResetRequests,
  resolvePasswordResetRequest,
  dismissPasswordResetRequest,
} from '@/shared/api/me'
import { register as registerUser } from '@/shared/api/auth'
import { setSystemAdmin } from '@/shared/api/systemAdmins'
import { WorkspaceCombobox } from '@/shared/components/WorkspaceCombobox'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'

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
  const [confirmDelete, setConfirmDelete] = useState(null) // 완전 삭제할 account
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
  // 탭 — 'list'(계정 목록) / 'depts'(부서별 가입자 현황 트리).
  const [activeTab, setActiveTab] = useState('list')
  // 이메일 복사 시 비활성 계정 제외 여부. 기본 on — 비활성 계정은 보통
  // 메일을 받을 수 없거나 받을 필요가 없으므로 수신자 목록에서 빼는 게
  // 합리적. 목록에는 (「비활성 포함」이 켜져 있으면) 그대로 보이되 복사
  // 결과에서만 빠진다 — 보기/관리와 발송 대상은 별개라서 분리.
  const [excludeInactiveOnCopy, setExcludeInactiveOnCopy] = useState(true)

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

  // 실제 복사 대상 — 소속 필터를 통과한 계정 중, 「비활성 제외」가 켜져
  // 있으면 비활성(is_active === false) 계정을 추가로 걸러낸다.
  const copyAccounts = useMemo(
    () =>
      excludeInactiveOnCopy
        ? filteredAccounts.filter((a) => a.is_active)
        : filteredAccounts,
    [filteredAccounts, excludeInactiveOnCopy],
  )

  /** 현재 필터된 계정들의 이메일을 `email1;email2;...` 로 묶어 클립보드.
   *  세미콜론은 Outlook / 다수 사내 메일 클라이언트가 To 필드 구분자로
   *  쓰는 포맷이라 그대로 paste 하면 수신자 리스트로 인식된다. 빈 이메일은
   *  필터링 (가입은 됐는데 이메일이 비어있는 잘못된 row 가 있는 경우).
   *  「비활성 제외」가 켜져 있으면 비활성 계정은 대상에서 빠진다. */
  async function handleCopyEmails() {
    const emails = copyAccounts
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
      const excluded = filteredAccounts.length - copyAccounts.length
      const suffix =
        excludeInactiveOnCopy && excluded > 0 ? ` (비활성 ${excluded}개 제외)` : ''
      toast.success(
        (homeFilter
          ? `필터된 ${n}개의 이메일을 복사했습니다.`
          : `${n}개의 이메일을 복사했습니다.`) + suffix,
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

  async function handleDeleteUser(account) {
    await deleteUser(account.id)
    toast.success(`계정(${account.email})이 완전히 삭제되었습니다.`)
    setConfirmDelete(null)
    reload()
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
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                title="계정 완전 삭제 (잘못된 가입 정리 — 이메일 해방)"
                onClick={(e) => {
                  e.stopPropagation()
                  setConfirmDelete(a)
                }}
                disabled={isSelf}
              >
                <Trash2 className="h-3.5 w-3.5" />
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

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="list">계정 목록</TabsTrigger>
          <TabsTrigger value="depts">부서별 가입자 현황</TabsTrigger>
          <TabsTrigger value="access">접속 이력</TabsTrigger>
        </TabsList>
        <TabsContent value="list" className="space-y-4 mt-4">

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
          disabled={copyAccounts.length === 0}
          title="이메일 주소를 세미콜론(;) 구분자로 클립보드에 복사"
        >
          <ClipboardCopy className="mr-1 h-3.5 w-3.5" />
          이메일 복사
          {copyAccounts.length > 0 && (
            <span className="ml-1 tabular-nums text-muted-foreground">
              ({copyAccounts.length})
            </span>
          )}
        </Button>
        {/* 복사 대상에서 비활성 계정 제외. 목록 표시(「비활성 포함」)와는
            독립 — 비활성 계정을 화면에서는 보면서 발송 대상에서만 뺄 수
            있게. */}
        <label className="inline-flex items-center gap-1.5 cursor-pointer select-none text-xs">
          <input
            type="checkbox"
            checked={excludeInactiveOnCopy}
            onChange={(e) => setExcludeInactiveOnCopy(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          <span>복사 시 비활성 제외</span>
        </label>
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
        </TabsContent>
        <TabsContent value="depts" className="mt-4">
          <DeptMembersTab
            accounts={accounts}
            workspaces={workspaces}
            descendantsBySlug={descendantsBySlug}
          />
        </TabsContent>
        <TabsContent value="access" className="mt-4">
          <AccessLogTab isSystemAdmin={isSystemAdmin} />
        </TabsContent>
      </Tabs>

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

      <DeleteAccountConfirm
        account={confirmDelete}
        onOpenChange={(o) => !o && setConfirmDelete(null)}
        onConfirm={() => confirmDelete && handleDeleteUser(confirmDelete)}
      />
    </div>
  )
}

// 계정 완전 삭제 확인 — 먼저 참조(작성 댓글·개인공간 내용)를 조회해, 남아 있으면
// 삭제를 막고 비활성화를 권한다(부서 삭제 다이얼로그와 같은 패턴).
const ACCOUNT_BLOCKER_LABELS = {
  comment_threads: '작성한 댓글 스레드',
  comments: '작성한 댓글',
  personal_content: '개인 작업공간의 보고서·파일 등',
}

function DeleteAccountConfirm({ account, onOpenChange, onConfirm }) {
  const open = Boolean(account)
  const [blockers, setBlockers] = useState(null)
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open || !account) {
      setBlockers(null)
      setSubmitting(false)
      return
    }
    setLoading(true)
    getUserDeleteDependents(account.id)
      .then(setBlockers)
      .catch(() => setBlockers(null))
      .finally(() => setLoading(false))
  }, [open, account?.id])

  const totalBlockers = blockers
    ? Object.values(blockers).reduce((a, b) => a + b, 0)
    : 0
  const canDelete = !loading && !submitting && blockers && totalBlockers === 0

  async function handleSubmit(e) {
    e.preventDefault()
    if (!canDelete) return
    setSubmitting(true)
    try {
      await onConfirm()
    } catch (err) {
      toast.error(err?.response?.data?.message || err.message || '삭제 실패')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>계정 완전 삭제</DialogTitle>
          <DialogDescription>
            <span className="font-medium">
              {account?.name || account?.email}
            </span>{' '}
            계정을 완전히 삭제합니다. 되돌릴 수 없으며, 삭제 후 이 이메일로 다시
            가입할 수 있습니다. 작성한 보고서는 「작성자 없음」으로 보존됩니다.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          {loading ? (
            <Skeleton className="h-16" />
          ) : blockers ? (
            <div className="space-y-2 text-sm">
              {Object.entries(blockers).map(([key, count]) => (
                <div key={key} className="flex items-center justify-between">
                  <span>{ACCOUNT_BLOCKER_LABELS[key] || key}</span>
                  <Badge variant={count === 0 ? 'outline' : 'destructive'}>
                    {count}
                  </Badge>
                </div>
              ))}
              {totalBlockers > 0 && (
                <p className="text-xs text-amber-600 mt-2">
                  참조 항목이 남아 있어 삭제할 수 없습니다. 정리하거나, 대신
                  계정을 비활성화하세요.
                </p>
              )}
            </div>
          ) : null}

          <DialogFooter className="mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              취소
            </Button>
            <Button type="submit" variant="destructive" disabled={!canDelete}>
              {submitting ? '삭제 중…' : '완전 삭제'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// 트리맵 색 — 상위(루트) 부서마다 조화로운 뮤트 톤 한 색을 배정하고, 하위로
// 갈수록 같은 색을 흰색과 섞어 옅게(브랜치가 한 계열로 묶여 보이도록). seaborn
// 'muted' 계열 — 채도가 과하지 않아 정돈된 인상.
const TREEMAP_PALETTE = [
  '#4878d0',
  '#ee854a',
  '#6acc64',
  '#d65f5f',
  '#956cb4',
  '#8c613c',
  '#dc7ec0',
  '#797979',
  '#d5bb67',
  '#82c6e2',
]

function _tintHex(hex, amount) {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  const mix = (c) => Math.round(c + (255 - c) * amount)
  const to2 = (n) => n.toString(16).padStart(2, '0')
  return '#' + to2(mix(r)) + to2(mix(g)) + to2(mix(b))
}

/** 부서별 가입자 현황 — 트리맵(Plotly). 사각형 크기 = 인원수, 부모가 자식
 *  부서를 품어 상위/하위 관계를 화면 전체로 보여준다. 각 칸의 값은 그 부서에
 *  *직접* 소속된 가입자(branchvalues='remainder' 라 부모 면적 = 직접 + 하위
 *  합계로 자동 누적). 부서를 클릭하면 그 부서로 줌인(드릴다운), 상단 경로
 *  막대로 복귀. 가입자 수는 계정의 home(소속) 부서 기준 — 별도 API 불필요. */
function DeptMembersTab({ accounts, workspaces, descendantsBySlug }) {
  const orgs = useMemo(
    () => (workspaces ?? []).filter((w) => !w.virtual && w.kind !== 'personal'),
    [workspaces],
  )
  // 이 부서를 소속(home)으로 둔 가입자 수(직접).
  const directCount = useMemo(() => {
    const m = new Map()
    for (const a of accounts) {
      if (!a.home_workspace_slug) continue
      m.set(a.home_workspace_slug, (m.get(a.home_workspace_slug) ?? 0) + 1)
    }
    return m
  }, [accounts])
  const orgSlugs = useMemo(() => new Set(orgs.map((w) => w.slug)), [orgs])
  const subtreeCountFor = useMemo(() => {
    const f = (slug) => {
      const desc = descendantsBySlug.get(slug) ?? new Set([slug])
      let c = 0
      for (const d of desc) c += directCount.get(d) ?? 0
      return c
    }
    return f
  }, [descendantsBySlug, directCount])

  const noHome = useMemo(
    () => accounts.reduce((n, a) => (a.home_workspace_slug ? n : n + 1), 0),
    [accounts],
  )
  const withHome = accounts.length - noHome

  // Plotly 트리맵 trace — 인원이 1명 이상인 서브트리만(0 면적 칸 제거).
  const fig = useMemo(() => {
    const ids = []
    const labels = []
    const parents = []
    const values = []
    const customdata = []
    const colors = []
    const inTree = new Set(
      orgs.filter((w) => subtreeCountFor(w.slug) > 0).map((w) => w.slug),
    )
    const parentOf = new Map(orgs.map((w) => [w.slug, w.parent_slug ?? null]))
    // 루트(트리 안에서 부모가 없는 노드)별 팔레트 인덱스 배정.
    const rootIndex = new Map()
    const resolve = (slug) => {
      let depth = 0
      let cur = slug
      while (true) {
        const p = parentOf.get(cur)
        if (!p || !inTree.has(p)) {
          if (!rootIndex.has(cur)) rootIndex.set(cur, rootIndex.size)
          return { root: cur, depth }
        }
        cur = p
        depth += 1
      }
    }
    for (const w of orgs) {
      if (!inTree.has(w.slug)) continue
      ids.push(w.slug)
      labels.push(w.name || w.slug)
      parents.push(
        w.parent_slug && inTree.has(w.parent_slug) ? w.parent_slug : '',
      )
      values.push(directCount.get(w.slug) ?? 0) // 직접 인원(면적은 누적)
      customdata.push(subtreeCountFor(w.slug)) // 하위 포함 합계(hover)
      const { root, depth } = resolve(w.slug)
      const base = TREEMAP_PALETTE[(rootIndex.get(root) ?? 0) % TREEMAP_PALETTE.length]
      // 루트도 살짝 옅게(0.18) 시작 → 어두운 텍스트가 어디서나 읽힘. 하위로
      // 갈수록 +0.15 씩 더 옅게(최대 0.72).
      colors.push(_tintHex(base, Math.min(0.18 + depth * 0.15, 0.72)))
    }
    return { ids, labels, parents, values, customdata, colors }
  }, [orgs, directCount, subtreeCountFor])

  const ref = useRef(null)
  const plotlyRef = useRef(null)
  useEffect(() => {
    let cancelled = false
    const el = ref.current
    if (!el) return undefined
    import('plotly.js-dist').then((mod) => {
      if (cancelled || !ref.current) return
      const Plotly = mod.default
      plotlyRef.current = Plotly
      const data = [
        {
          type: 'treemap',
          ids: fig.ids,
          labels: fig.labels,
          parents: fig.parents,
          values: fig.values,
          customdata: fig.customdata,
          branchvalues: 'remainder',
          marker: {
            colors: fig.colors,
            line: { width: 2.5, color: '#ffffff' },
            cornerradius: 5,
            pad: 3,
          },
          tiling: { pad: 0 },
          textinfo: 'label+value',
          texttemplate: '<b>%{label}</b><br>%{value}명',
          hovertemplate:
            '<b>%{label}</b><br>직접 소속 %{value}명<br>하위 포함 %{customdata}명<extra></extra>',
          textposition: 'middle center',
          textfont: { size: 13, color: '#1f2937', family: 'inherit' },
          pathbar: {
            visible: true,
            side: 'top',
            thickness: 24,
            textfont: { size: 12, color: '#475569' },
          },
          hoverlabel: {
            bgcolor: '#1e293b',
            bordercolor: '#1e293b',
            font: { color: '#f8fafc', size: 12 },
          },
        },
      ]
      const layout = {
        margin: { t: 28, l: 0, r: 0, b: 0 },
        height: ref.current.clientHeight || 600,
        font: { family: 'inherit' },
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
      }
      const config = {
        responsive: true,
        displaylogo: false,
        modeBarButtonsToRemove: ['sendDataToCloud'],
      }
      Plotly.react(ref.current, data, layout, config)
    })
    return () => {
      cancelled = true
    }
  }, [fig])

  // 언마운트 시 정리.
  useEffect(() => {
    const el = ref.current
    return () => {
      if (el && plotlyRef.current) plotlyRef.current.purge(el)
    }
  }, [])

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>
          소속 있는 가입자 <b className="text-foreground">{withHome}</b>명 · 부서{' '}
          <b className="text-foreground">{orgs.length}</b>개
        </span>
        {noHome > 0 && (
          <span className="text-amber-700">소속 없음 {noHome}명</span>
        )}
        <span className="ml-auto">
          칸 크기 = 인원수 · 부서를 클릭하면 그 부서로 확대(상단 경로로 복귀).
        </span>
      </div>
      {fig.ids.length === 0 ? (
        <div className="rounded-lg border p-2">
          <p className="px-2 py-10 text-center text-sm text-muted-foreground">
            소속이 지정된 가입자가 없습니다.
          </p>
        </div>
      ) : (
        <div
          ref={ref}
          className="rounded-lg border"
          style={{ height: 'calc(100vh - 320px)', minHeight: 460 }}
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
              excludeArchived
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
      {/* 고정 폭 + 콤보박스 wrap — 깊은 부서 경로는 트리거 안에서 여러 줄로
          줄바꿈돼(버튼 높이만 늘어남) 가로로 모달 밖을 넘지 않는다. 예전
          w-fit + noTruncate 는 경로가 길면 nowrap 이라 모달 밖으로 삐져나왔다. */}
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>소속 부서 변경</DialogTitle>
          <DialogDescription className="break-words">
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
              excludeArchived
              workspaces={assignableWorkspaces}
              value={workspaceSlug}
              onChange={(s) => setWorkspaceSlug(s ?? '')}
              placeholder="소속 없음"
              searchPlaceholder="부서 검색"
              wrap
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

// 백엔드는 naive UTC(datetime.utcnow)로 저장 → 오프셋이 없으면 'Z'를 붙여
// UTC로 해석한 뒤 사용자 로컬 시각으로 표기. (날짜+시간)
function formatDateTime(iso) {
  if (!iso) return ''
  const hasTz = /[zZ]$|[+-]\d\d:?\d\d$/.test(iso)
  const d = new Date(hasTz ? iso : `${iso}Z`)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('ko-KR', { hour12: false })
}

// User-Agent → "OS · 브라우저" 한 줄 요약(전체는 title 툴팁). 정확한 파싱이
// 목적이 아니라 한눈에 알아볼 수 있게 하는 용도.
function shortUserAgent(ua) {
  if (!ua) return '—'
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua)
      ? 'macOS'
      : /Android/.test(ua)
        ? 'Android'
        : /iPhone|iPad|iPod/.test(ua)
          ? 'iOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : ''
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Whale/.test(ua)
        ? 'Whale'
        : /SamsungBrowser/.test(ua)
          ? 'Samsung'
          : /Chrome\//.test(ua)
            ? 'Chrome'
            : /Firefox\//.test(ua)
              ? 'Firefox'
              : /Safari\//.test(ua)
                ? 'Safari'
                : ''
  const label = [os, browser].filter(Boolean).join(' · ')
  return label || ua.slice(0, 40)
}

const ACCESS_LIMIT_OPTIONS = [100, 200, 500]
const ACCESS_SUCCESS_FILTERS = [
  ['all', '전체'],
  ['success', '성공'],
  ['fail', '실패'],
]

// 접속 이력 탭 — 로그인/가입 시도 로그(시스템 관리자 전용). 탭을 열 때만
// 마운트되어(Radix Tabs) 그때 fetch 한다. 최근 N건 + 성공/실패 필터.
function AccessLogTab({ isSystemAdmin }) {
  const [limit, setLimit] = useState(200)
  const [successFilter, setSuccessFilter] = useState('all') // 'all' | 'success' | 'fail'
  const [reloadKey, setReloadKey] = useState(0)
  const successParam =
    successFilter === 'success' ? true : successFilter === 'fail' ? false : null

  const { data, loading, error } = useAsync(
    () =>
      isSystemAdmin
        ? listAccessLogs({ limit, success: successParam })
        : Promise.resolve({ items: [], total: 0 }),
    [isSystemAdmin, limit, successFilter, reloadKey],
  )
  const items = useMemo(() => data?.items ?? [], [data])
  const total = data?.total ?? 0

  const columns = useMemo(
    () => [
      {
        key: 'created_at',
        header: '접속 시각',
        sortable: true,
        headerClassName: 'w-[160px]',
        render: (r) => (
          <span className="tabular-nums whitespace-nowrap text-xs">
            {formatDateTime(r.created_at)}
          </span>
        ),
      },
      {
        key: 'name',
        header: '사용자',
        sortable: true,
        render: (r) => (
          <div className="min-w-0">
            <div className="truncate">
              {r.name || (
                <span className="text-muted-foreground italic">(미가입 / 삭제)</span>
              )}
            </div>
            <div className="truncate text-[11px] text-muted-foreground font-mono">
              {r.email}
            </div>
          </div>
        ),
      },
      {
        key: 'event',
        header: '구분',
        sortable: true,
        headerClassName: 'w-[72px]',
        render: (r) => {
          const label =
            r.event === 'signup' ? '가입' : r.event === 'resume' ? '세션' : '로그인'
          const title =
            r.event === 'signup'
              ? '회원가입'
              : r.event === 'resume'
                ? "'로그인 유지'로 토큰만 들고 재접속(자동)"
                : '아이디·비밀번호 로그인'
          return (
            <span
              title={title}
              className={r.event === 'resume' ? 'text-muted-foreground' : ''}
            >
              {label}
            </span>
          )
        },
      },
      {
        key: 'success',
        header: '결과',
        sortable: true,
        headerClassName: 'w-[72px]',
        render: (r) =>
          r.success ? (
            <Badge
              variant="outline"
              className="border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
            >
              성공
            </Badge>
          ) : (
            <Badge variant="destructive">실패</Badge>
          ),
      },
      {
        key: 'ip_address',
        header: 'IP',
        sortable: true,
        headerClassName: 'w-[130px]',
        render: (r) => (
          <span className="font-mono text-xs">{r.ip_address || '—'}</span>
        ),
      },
      {
        key: 'user_agent',
        header: '기기 / 브라우저',
        render: (r) => (
          <span
            className="block max-w-[240px] truncate text-xs text-muted-foreground"
            title={r.user_agent || ''}
          >
            {shortUserAgent(r.user_agent)}
          </span>
        ),
      },
    ],
    [],
  )

  return (
    <div className="flex flex-col gap-4 xl:flex-row">
      {/* 좌측 절반 — 컨트롤 + 접속 이력 표 */}
      <div className="min-w-0 space-y-3 xl:w-1/2">
      <div className="flex items-center gap-3 flex-wrap text-xs">
        <div className="inline-flex items-center gap-1">
          <span className="text-muted-foreground">결과</span>
          {ACCESS_SUCCESS_FILTERS.map(([v, label]) => (
            <Button
              key={v}
              size="sm"
              variant={successFilter === v ? 'default' : 'outline'}
              className="h-7 text-xs"
              onClick={() => setSuccessFilter(v)}
            >
              {label}
            </Button>
          ))}
        </div>
        <div className="inline-flex items-center gap-1">
          <span className="text-muted-foreground">최근</span>
          <select
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            className="h-7 rounded-md border border-input bg-background px-2 text-xs"
          >
            {ACCESS_LIMIT_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}건
              </option>
            ))}
          </select>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={() => setReloadKey((k) => k + 1)}
        >
          새로고침
        </Button>
        <span className="text-[11px] text-muted-foreground ml-auto">
          {loading ? '불러오는 중…' : `표시 ${items.length} / 전체 ${total}건`}
        </span>
      </div>

      {error ? (
        <ErrorState
          description={error.message}
          onRetry={() => setReloadKey((k) => k + 1)}
        />
      ) : loading ? (
        <Skeleton className="h-72" />
      ) : (
        <DataTable
          columns={columns}
          data={items}
          fixedLayout
          minTableWidthClass="min-w-[820px]"
          defaultSort={{ key: 'created_at', dir: 'desc' }}
          pageSizeStorageKey="access-logs"
          searchableKeys={['name', 'email', 'ip_address']}
          searchPlaceholder="이름 / 이메일 / IP 검색"
        />
      )}
      </div>
      {/* 우측 절반 — 부서별 일/주/월 접속 막대그래프 */}
      <div className="min-w-0 xl:w-1/2">
        <AccessStatsChart isSystemAdmin={isSystemAdmin} />
      </div>
    </div>
  )
}

const ACCESS_STATS_GRANULARITIES = [
  ['day', '일간'],
  ['week', '주간'],
  ['month', '월간'],
]

// 결과 필터(성공/실패/전체) — 막대그래프 + 드릴다운에 공통 적용. UI 값 →
// API success 파라미터(true/false/null) 매핑.
const ACCESS_RESULT_FILTERS = [
  ['success', '성공', true],
  ['fail', '실패', false],
  ['all', '전체', null],
]

// 부서 막대 색상 팔레트 — Chart 위젯과 동일 계열. 부서 수가 팔레트보다 많으면
// 순환한다.
const ACCESS_DEPT_COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444',
  '#8b5cf6', '#06b6d4', '#ec4899', '#14b8a6',
  '#a855f7', '#f97316', '#64748b',
]

/** 부서별·기간별 접속 건수 막대그래프. 일/주/월 + 성공/실패/전체 토글, 부서별
 *  스택 막대. 막대(부서 구간)를 클릭하면 그 구간의 사용자별 접속 횟수를 보여준다.
 *  데이터 소스: GET /api/admin/access-logs/stats(+/detail). */
function AccessStatsChart({ isSystemAdmin }) {
  const [granularity, setGranularity] = useState('day')
  const [resultFilter, setResultFilter] = useState('success') // 'success'|'fail'|'all'
  const [drill, setDrill] = useState(null) // 클릭한 막대 구간(드릴다운 대상)
  const successParam =
    ACCESS_RESULT_FILTERS.find(([v]) => v === resultFilter)?.[2] ?? null

  const { data, loading, error } = useAsync(
    () =>
      isSystemAdmin
        ? accessLogStats({ granularity, success: successParam })
        : Promise.resolve({ departments: [], points: [] }),
    [isSystemAdmin, granularity, resultFilter],
  )
  const departments = data?.departments ?? []
  const chartData = useMemo(
    () =>
      (data?.points ?? []).map((p) => ({
        label: p.label,
        bucket_start: p.bucket_start,
        ...p.counts,
      })),
    [data],
  )
  const hasData = (data?.points ?? []).some((p) => p.total > 0)

  function handleBarClick(entry) {
    const p = entry?.payload ?? entry
    if (!p?.bucket_start) return
    // 어느 부서 구간을 클릭하든 그 날짜/시간 버킷 '전체'를 본다(부서 필터 없음).
    setDrill({
      granularity,
      bucket: p.bucket_start,
      label: p.label,
      department: null,
      success: successParam,
    })
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-x-3 gap-y-2 flex-wrap text-xs">
        <div className="inline-flex items-center gap-1">
          {ACCESS_STATS_GRANULARITIES.map(([v, label]) => (
            <Button
              key={v}
              size="sm"
              variant={granularity === v ? 'default' : 'outline'}
              className="h-7 text-xs"
              onClick={() => setGranularity(v)}
            >
              {label}
            </Button>
          ))}
        </div>
        <div className="inline-flex items-center gap-1">
          {ACCESS_RESULT_FILTERS.map(([v, label]) => (
            <Button
              key={v}
              size="sm"
              variant={resultFilter === v ? 'default' : 'outline'}
              className="h-7 text-xs"
              onClick={() => setResultFilter(v)}
            >
              {label}
            </Button>
          ))}
        </div>
        <span className="text-[11px] text-muted-foreground ml-auto">
          막대를 클릭하면 사용자별 상세
        </span>
      </div>

      {error ? (
        <ErrorState description={error.message} />
      ) : loading ? (
        <Skeleton className="h-[460px]" />
      ) : !hasData ? (
        <div className="flex h-[460px] items-center justify-center rounded-md border text-sm text-muted-foreground">
          표시할 접속 통계가 없습니다.
        </div>
      ) : (
        <div className="h-[460px] rounded-md border p-2">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={chartData}
              margin={{ top: 8, right: 8, left: -12, bottom: 4 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                className="stroke-border"
                vertical={false}
              />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11 }}
                interval="preserveStartEnd"
              />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={32} />
              <RechartsTooltip
                contentStyle={{ fontSize: 12 }}
                cursor={{ fill: 'rgba(127,127,127,0.08)' }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {departments.map((dept, i) => (
                <Bar
                  key={dept}
                  dataKey={dept}
                  stackId="access"
                  fill={ACCESS_DEPT_COLORS[i % ACCESS_DEPT_COLORS.length]}
                  cursor="pointer"
                  onClick={handleBarClick}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      <AccessDrillDialog target={drill} onClose={() => setDrill(null)} />
    </div>
  )
}

/** 막대(버킷+부서) 클릭 드릴다운 — 그 구간의 사용자별 접속 횟수(내림차순). */
function AccessDrillDialog({ target, onClose }) {
  const { data, loading, error } = useAsync(
    () =>
      target
        ? accessLogStatsDetail({
            granularity: target.granularity,
            bucket: target.bucket,
            department: target.department,
            success: target.success,
          })
        : Promise.resolve({ total: 0, users: [] }),
    [
      target?.granularity,
      target?.bucket,
      target?.department,
      target?.success,
    ],
  )
  const users = data?.users ?? []
  const resultLabel =
    target?.success === true ? '성공' : target?.success === false ? '실패' : '전체'

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base">
            {target?.label} 접속 상세
          </DialogTitle>
          <DialogDescription>
            결과: {resultLabel} · 전체 부서 · 사용자별 접속 횟수
            {data ? ` (총 ${data.total ?? 0}건)` : ''}
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <ErrorState description={error.message} />
        ) : loading ? (
          <Skeleton className="h-40" />
        ) : users.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            접속 기록이 없습니다.
          </div>
        ) : (
          <div className="max-h-[55vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-background text-xs text-muted-foreground">
                <tr>
                  <th className="py-1 text-left font-medium">사용자</th>
                  <th className="w-24 py-1 text-left font-medium">부서</th>
                  <th className="w-14 py-1 text-right font-medium">횟수</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u, i) => (
                  <tr key={`${u.user_id ?? 'x'}-${u.email}-${i}`} className="border-t">
                    <td className="min-w-0 py-1">
                      <div className="truncate">
                        {u.name || (
                          <span className="italic text-muted-foreground">
                            (미가입 / 삭제)
                          </span>
                        )}
                      </div>
                      <div className="truncate font-mono text-[11px] text-muted-foreground">
                        {u.email}
                      </div>
                    </td>
                    <td className="py-1 align-top">
                      <span className="block truncate text-xs text-muted-foreground">
                        {u.department}
                      </span>
                    </td>
                    <td className="py-1 text-right align-top font-medium tabular-nums">
                      {u.count}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

// 비밀번호 찾기 대기 큐 — 사용자가 '비밀번호 찾기'로 접수한 요청을 보여주고,
// 본인 확인 후 임시 비번을 발급해 해소한다. 요청 없음/권한 없음이면 숨김.
function PasswordResetRequestsPanel() {
  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const [resolving, setResolving] = useState(null)
  // 반려(취소) — 처리 불가/무효 요청을 큐에서 정리. 오타·미가입 등으로 가입
  // 계정이 없는 요청은 발급이 불가능하므로 이 경로로만 닫는다. 실수 클릭을
  // 막으려 인라인 2단계 확인.
  const [confirmDismissId, setConfirmDismissId] = useState(null)
  const [dismissingId, setDismissingId] = useState(null)

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

  async function handleDismiss(r) {
    setDismissingId(r.id)
    try {
      await dismissPasswordResetRequest(r.id)
      toast.success('요청을 반려했습니다.')
      setConfirmDismissId(null)
      load()
    } catch (err) {
      toast.error(
        err?.response?.data?.message || err.message || '반려에 실패했습니다.',
      )
    } finally {
      setDismissingId(null)
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
        <br />
        <span className="text-amber-700 dark:text-amber-300">(미가입 이메일)</span>
        은 오타나 가입 안 된 주소라 발급할 수 없습니다 — 실제 가입 이메일을
        확인해 그 계정으로 발급하거나, 처리 불가한 요청은 <b>반려</b>로 정리하세요.
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
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                size="sm"
                disabled={!r.user_id}
                onClick={() => setResolving(r)}
                title={r.user_id ? '' : '가입된 계정이 없어 발급할 수 없습니다'}
              >
                <KeyRound className="mr-1.5 h-3.5 w-3.5" />
                임시 비번 발급
              </Button>
              {confirmDismissId === r.id ? (
                <>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={dismissingId === r.id}
                    onClick={() => handleDismiss(r)}
                  >
                    {dismissingId === r.id ? '반려 중…' : '반려 확인'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirmDismissId(null)}
                  >
                    취소
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground"
                  onClick={() => setConfirmDismissId(r.id)}
                  title="이 요청을 큐에서 제거(반려) — 오타·미가입 등 처리 불가한 요청 정리용"
                >
                  반려
                </Button>
              )}
            </div>
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
