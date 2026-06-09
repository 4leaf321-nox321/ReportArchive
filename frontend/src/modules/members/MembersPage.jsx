import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Trash2, ShieldCheck, User as UserIcon, KeyRound, Home, Users, Search } from 'lucide-react'
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
import { Card, CardContent } from '@/shared/components/ui/card'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { PageHeader } from '@/shared/components/PageHeader'
import { ErrorState } from '@/shared/components/ErrorState'
import { ConfirmDialog } from '@/shared/components/ConfirmDialog'
import { WorkspaceCombobox } from '@/shared/components/WorkspaceCombobox'
import { useAuth } from '@/shared/auth/AuthContext'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import { useAsync } from '@/shared/hooks/useAsync'
import {
  listMembers,
  addMember,
  updateMember,
  removeMember,
  searchUsers,
} from '@/shared/api/members'
import {
  listTakedownRequests,
  approveTakedown,
  rejectTakedown,
} from '@/shared/api/takedowns'
import { DataTable } from '@/shared/components/DataTable'
import { adminSetUserPassword } from '@/shared/api/me'

// 부서 멤버 역할은 두 단계: 매니저 / 사용자. p7 이 옛 manager(템플릿만)
// 를 user 로 강등했고, p8 이 enum value 'admin' → 'manager' 로 rename.
// 이제 DB·코드·라벨 모두 'manager' 로 일관됨.
const ROLES = [
  {
    value: 'manager',
    label: '매니저',
    icon: ShieldCheck,
    description: '부서 멤버·템플릿·폴더·AI 프롬프트 관리 (보고서 권한 포함)',
  },
  {
    value: 'user',
    label: '사용자',
    icon: UserIcon,
    description: '보고서 작성·편집·조회 (템플릿·부서 관리는 매니저 이상)',
  },
]

const ROLE_LABEL = Object.fromEntries(ROLES.map((r) => [r.value, r.label]))
const ROLE_VARIANT = { manager: 'default', user: 'outline' }

export default function MembersPage() {
  const { me } = useAuth()
  const { workspace, slug, getPath, getDescendantsInclusive, all } = useWorkspace()
  const [addOpen, setAddOpen] = useState(false)
  const [bulkAddOpen, setBulkAddOpen] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(null)
  const [resetPwdMember, setResetPwdMember] = useState(null)

  const { data: members, loading, error, reload } = useAsync(
    () => (slug ? listMembers(slug) : Promise.resolve([])),
    [slug]
  )

  const isManager = me?.role === 'manager'

  // Workspaces an admin in `slug` is allowed to assign members into:
  // self + every non-virtual descendant of the current workspace.
  const assignableWorkspaces = (slug ? getDescendantsInclusive(slug) : [])
    .map((s) => all.find((w) => w.slug === s))
    .filter((w) => w && !w.virtual)

  if (!workspace) return null

  if (workspace.virtual) {
    return (
      <div className="p-6">
        <PageHeader title="멤버" description="가상 부서에는 멤버를 직접 추가할 수 없습니다." />
        <ErrorState
          title="가상 부서"
          description="공통(_global) 같은 가상 부서는 멤버를 직접 가지지 않습니다. 실제 부서로 전환하세요."
        />
      </div>
    )
  }

  if (!isManager) {
    return (
      <div className="p-6">
        <PageHeader title="멤버" description={`${workspace.name} 멤버 관리`} />
        <ErrorState
          title="권한 없음"
          description="멤버 관리는 매니저만 가능합니다."
          action={
            <Button asChild variant="outline">
              <Link to={`/w/${slug}`}>부서 홈으로</Link>
            </Button>
          }
        />
      </div>
    )
  }

  const path = getPath(slug)
  const breadcrumb = path
    .map((p) => ({ label: p.name, to: p.slug === slug ? undefined : `/w/${p.slug}` }))
    .concat([{ label: '멤버' }])

  async function handleChangeRole(memberId, newRole) {
    try {
      await updateMember(slug, memberId, { role: newRole })
      toast.success('역할이 변경되었습니다.')
      reload()
    } catch (err) {
      toast.error(err.message || '역할 변경 실패')
    }
  }

  async function handleChangeWorkspace(memberId, targetSlug) {
    try {
      await updateMember(slug, memberId, { targetWorkspaceSlug: targetSlug })
      toast.success('소속 부서가 변경되었습니다.')
      reload()
    } catch (err) {
      toast.error(err.message || '부서 변경 실패')
    }
  }

  async function handleRemove(memberId) {
    try {
      await removeMember(slug, memberId)
      toast.success('멤버가 제거되었습니다.')
      reload()
    } catch (err) {
      toast.error(err.message || '제거 실패')
    }
  }

  // 이 부서에서 실제로 권한을 가진 사람만 노출. 자손 부서 멤버는 여기
  // 권한이 없는데도 명단에 끼어 있어 헷갈렸기에 백엔드에서 제거. 자손
  // 부서 관리는 그 부서 페이지로 이동해 수행.
  const directMembers = (members ?? []).filter((m) => m.source === 'direct')
  const inherited = (members ?? []).filter((m) => m.source === 'inherited')

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="멤버"
        description={`${workspace.name} — ${directMembers.length}명${
          inherited.length ? ` (상위 상속 ${inherited.length}명)` : ''
        }`}
        breadcrumbs={breadcrumb}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => setBulkAddOpen(true)}>
              <Users className="mr-2 h-4 w-4" />
              여러 멤버 추가
            </Button>
            <Button onClick={() => setAddOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              멤버 추가
            </Button>
          </div>
        }
      />

      {/* 게시취소 요청 큐 — 작성자가 이 게시판에서 내려달라고 보낸 요청. 대기
          중인 게 있을 때만 노출(없으면 숨김). */}
      <TakedownRequestsPanel slug={slug} />

      {error ? (
        <ErrorState description={error.message} onRetry={reload} />
      ) : loading ? (
        <Skeleton className="h-64" />
      ) : (
        <>
          <Card>
            <CardContent className="pt-6">
              <SectionHeading
                title="멤버 명단"
                hint={`${workspace.name} 에 직접 임명된 사람. 역할 드롭다운으로 즉시 변경. 자손 부서 멤버는 해당 부서 페이지에서 관리.`}
              />
              {directMembers.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4">
                  이 부서에 등록된 멤버가 없습니다.
                </p>
              ) : (
                <ul className="divide-y">
                  {directMembers.map((m) => (
                    <MemberRow
                      key={m.id}
                      member={m}
                      isSelf={me.user.id === m.user_id}
                      assignableWorkspaces={assignableWorkspaces}
                      onChangeRole={(role) => handleChangeRole(m.id, role)}
                      onChangeWorkspace={(ws) => handleChangeWorkspace(m.id, ws)}
                      onRemove={() => setConfirmRemove(m)}
                      onResetPassword={() => setResetPwdMember(m)}
                    />
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {inherited.length > 0 && (
            <Card>
              <CardContent className="pt-6">
                <SectionHeading
                  title="상위 부서에서 상속됨"
                  hint="상위 부서에서 관리됨 — 여기서는 수정 불가. 변경하려면 해당 상위 부서로 이동."
                />
                <ul className="divide-y">
                  {inherited.map((m) => (
                    <MemberRow key={m.id} member={m} readonly />
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </>
      )}

      <AddMemberDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onAdded={() => {
          setAddOpen(false)
          reload()
        }}
        defaultWorkspaceSlug={slug}
        assignableWorkspaces={assignableWorkspaces}
      />

      {bulkAddOpen && (
        <BulkAddMembersDialog
          workspaceSlug={slug}
          existingMemberIds={new Set((members ?? []).map((m) => m.user_id))}
          onClose={() => setBulkAddOpen(false)}
          onAdded={() => {
            setBulkAddOpen(false)
            reload()
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(confirmRemove)}
        onOpenChange={() => setConfirmRemove(null)}
        title="멤버 제거"
        description={
          confirmRemove
            ? `${confirmRemove.email}을(를) ${confirmRemove.source_workspace_slug} 부서에서 제거하시겠습니까?`
            : ''
        }
        confirmLabel="제거"
        variant="destructive"
        onConfirm={() => confirmRemove && handleRemove(confirmRemove.id)}
      />

      <ResetPasswordDialog
        member={resetPwdMember}
        onOpenChange={(open) => !open && setResetPwdMember(null)}
      />
    </div>
  )
}

function SectionHeading({ title, hint }) {
  return (
    <div className="mb-3">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h2>
      {hint && <p className="text-[11px] text-muted-foreground/80 mt-0.5">{hint}</p>}
    </div>
  )
}

function MemberRow({
  member,
  isSelf,
  assignableWorkspaces = [],
  onChangeRole,
  onChangeWorkspace,
  onRemove,
  onResetPassword,
  readonly,
}) {
  return (
    <li className="flex items-center gap-3 py-3 flex-wrap sm:flex-nowrap">
      <div className="rounded-full bg-muted h-8 w-8 flex items-center justify-center text-xs font-medium shrink-0">
        {member.name.charAt(0)}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium">{member.name}</span>
          <span className="text-[10px] text-muted-foreground font-mono">#{member.user_id}</span>
          {isSelf && <Badge variant="outline" className="text-[10px]">본인</Badge>}
          {/* 소속 부서 row — 계정 관리에서 결정된 home. 부서 멤버에서는
              제거 불가, 옮기려면 계정 관리에서 home 을 다른 부서로. */}
          {member.is_home && (
            <Badge
              variant="default"
              className="text-[10px] gap-0.5"
              title="이 사용자의 소속 부서. 계정 관리에서만 변경 가능."
            >
              <Home className="h-2.5 w-2.5" />
              소속
            </Badge>
          )}
          {readonly && member.source === 'inherited' && (
            <Badge variant="secondary" className="text-[10px]">
              상속: {member.source_workspace_slug}
            </Badge>
          )}
        </div>
        <div className="text-xs text-muted-foreground truncate">{member.email}</div>
      </div>

      {readonly ? (
        <Badge variant={ROLE_VARIANT[member.role]}>{ROLE_LABEL[member.role]}</Badge>
      ) : (
        <>
          <WorkspaceCombobox
            workspaces={assignableWorkspaces}
            value={member.source_workspace_slug}
            onChange={(s) => s && s !== member.source_workspace_slug && onChangeWorkspace?.(s)}
            disabled={isSelf || member.is_home || assignableWorkspaces.length <= 1}
            compact
            className="min-w-[160px] max-w-[220px]"
            placeholder="부서"
          />
          <select
            value={member.role}
            disabled={isSelf}
            onChange={(e) => onChangeRole(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            title={isSelf ? '본인 역할은 변경 불가' : '역할 변경'}
          >
            {ROLES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
          {onResetPassword && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={onResetPassword}
              aria-label="비밀번호 재설정"
              title="비밀번호 재설정"
            >
              <KeyRound className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-destructive"
            disabled={isSelf || member.is_home}
            onClick={onRemove}
            aria-label="멤버 제거"
            title={
              member.is_home
                ? '소속 부서입니다. 계정 관리에서 소속을 다른 부서로 옮긴 뒤 제거하세요.'
                : isSelf
                  ? '본인은 직접 제거할 수 없습니다.'
                  : '멤버 제거'
            }
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </>
      )}
    </li>
  )
}

function ResetPasswordDialog({ member, onOpenChange }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState(null)

  const open = Boolean(member)
  const memberId = member?.user_id
  const memberEmail = member?.email

  // Reset form when dialog closes or target member changes.
  useEffect(() => {
    if (!open) {
      setPassword('')
      setConfirm('')
      setErrorMsg(null)
    }
  }, [open, memberId])

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
      await adminSetUserPassword(memberId, { newPassword: password })
      toast.success(`${memberEmail}의 비밀번호가 재설정되었습니다.`)
      onOpenChange(false)
    } catch (err) {
      setErrorMsg(err.message || '재설정 실패')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>비밀번호 재설정</DialogTitle>
          <DialogDescription>
            {memberEmail
              ? `${memberEmail}의 비밀번호를 새로 설정합니다. 사용자에게 새 비밀번호를 직접 전달하세요.`
              : ''}
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
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
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

/** 여러 멤버 한 번에 추가. 전체 가입자 중 검색·다중 선택 후 같은 역할로
 *  일괄 추가. 기존 멤버는 후보에서 자동 제외. 호출은 add_member 라우트
 *  를 N번 fire-and-summary (Promise.allSettled) — 일부 실패해도 성공한
 *  쪽은 그대로 추가되고 토스트에 요약. */
function BulkAddMembersDialog({ workspaceSlug, existingMemberIds, onClose, onAdded }) {
  const [query, setQuery] = useState('')
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(false)
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [role, setRole] = useState('user')
  const [submitting, setSubmitting] = useState(false)

  // 검색어 변경 시 debounce 200ms 후 서버 호출. limit=100 — 더 많으면
  // 검색어로 좁혀야 함. 후보군에서 이미 멤버인 사람은 제외.
  useEffect(() => {
    let cancelled = false
    const handle = setTimeout(async () => {
      setLoading(true)
      try {
        const results = await searchUsers({ search: query.trim(), limit: 100 })
        if (cancelled) return
        const list = (results ?? []).filter((u) => !existingMemberIds.has(u.id))
        setUsers(list)
      } catch (err) {
        if (!cancelled) toast.error(err?.message || '사용자 조회 실패')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [query, existingMemberIds])

  async function handleSubmit() {
    const targets = users.filter((u) => selectedIds.has(u.id))
    if (targets.length === 0) return
    setSubmitting(true)
    try {
      const results = await Promise.allSettled(
        targets.map((u) => addMember(workspaceSlug, { email: u.email, role })),
      )
      const ok = results.filter((r) => r.status === 'fulfilled').length
      const fail = results.length - ok
      if (fail === 0) {
        toast.success(`${ok}명이 ${ROLE_LABEL[role]}(으)로 추가됐습니다.`)
      } else {
        const firstErr = results.find((r) => r.status === 'rejected')?.reason
        toast.warning(`${ok}명 추가됨, ${fail}명 실패`, {
          description:
            firstErr?.response?.data?.message || firstErr?.message || undefined,
        })
      }
      onAdded()
    } finally {
      setSubmitting(false)
    }
  }

  const columns = [
    {
      key: 'name',
      header: '이름',
      sortable: true,
      render: (u) => <span className="font-medium">{u.name || '—'}</span>,
    },
    {
      key: 'email',
      header: '이메일',
      sortable: true,
      render: (u) => (
        <span className="text-xs text-muted-foreground font-mono truncate">
          {u.email}
        </span>
      ),
    },
  ]

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      {/* 동적 width — 이메일이 길면 기본 max-w 안에서 넘침. WorkspaceEdit
          과 같은 정책. */}
      <DialogContent className="w-fit min-w-[36rem] max-w-[min(95vw,56rem)] gap-3">
        <DialogHeader>
          <DialogTitle>여러 멤버 추가</DialogTitle>
          <DialogDescription className="text-xs">
            검색 후 체크박스로 다중 선택해 한 번에 같은 역할로 추가합니다.
            이 부서에 이미 속한 사람은 후보에서 자동 제외. 한 번에 100명
            까지 노출되므로 더 많으면 검색어로 좁히세요.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="이름·이메일 검색"
                className="h-9 pl-7"
                autoFocus
              />
            </div>
            <div className="inline-flex items-center gap-1.5">
              <Label className="text-xs">역할</Label>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              >
                {ROLES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="min-h-[18rem]">
            <DataTable
              columns={columns}
              data={users}
              fixedLayout
              defaultSort={{ key: 'email', dir: 'asc' }}
              pageSizeStorageKey="members-bulk-add"
              selectable
              selectedIds={selectedIds}
              onSelectionChange={setSelectedIds}
              getRowId={(u) => u.id}
              emptyState={
                <span className="text-sm text-muted-foreground">
                  {loading ? '불러오는 중...' : '추가할 수 있는 사용자가 없습니다.'}
                </span>
              }
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            취소
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={selectedIds.size === 0 || submitting}
          >
            {submitting
              ? '추가 중...'
              : selectedIds.size === 0
                ? '선택 후 추가'
                : `선택한 ${selectedIds.size}명 추가`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AddMemberDialog({
  open,
  onOpenChange,
  onAdded,
  defaultWorkspaceSlug,
  assignableWorkspaces = [],
}) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('user')
  const [targetSlug, setTargetSlug] = useState(defaultWorkspaceSlug)
  const [submitting, setSubmitting] = useState(false)

  // Reset target slug whenever the dialog (re)opens for a new viewing context.
  useEffect(() => {
    if (open) setTargetSlug(defaultWorkspaceSlug)
  }, [open, defaultWorkspaceSlug])

  async function onSubmit(e) {
    e.preventDefault()
    setSubmitting(true)
    try {
      await addMember(targetSlug, { email, role })
      toast.success('멤버가 추가되었습니다.')
      setEmail('')
      setRole('user')
      onAdded()
    } catch (err) {
      toast.error(err.message || '추가 실패')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>멤버 추가</DialogTitle>
          <DialogDescription>
            등록된 사용자의 이메일·소속 부서·역할을 지정. 계정 자체는 사전에 생성돼 있어야 합니다.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="member-email">이메일</Label>
            <Input
              id="member-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="user@example.com"
              required
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="member-workspace">소속 부서</Label>
            <WorkspaceCombobox
              id="member-workspace"
              workspaces={assignableWorkspaces}
              value={targetSlug}
              onChange={(s) => s && setTargetSlug(s)}
              placeholder="부서 선택"
              searchPlaceholder="부서 검색 (이름·슬러그·경로)"
            />
            <p className="text-[11px] text-muted-foreground">
              현재 부서 또는 하위 부서 중 하나를 선택. 부서가 많으면 입력해서 검색.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="member-role">역할</Label>
            <select
              id="member-role"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              {ROLES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label} — {r.description}
                </option>
              ))}
            </select>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              취소
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? '추가 중...' : '추가'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}


/** 게시취소 요청 큐(보고서 삭제 재설계 2단계) — 이 게시판에 들어온 pending
 *  요청을 매니저가 승인(게시취소)/거절(게시 유지). 대기 건이 없으면 숨긴다. */
function TakedownRequestsPanel({ slug }) {
  const { data, loading, reload } = useAsync(
    () => (slug ? listTakedownRequests() : Promise.resolve([])),
    [slug],
  )
  const [busyId, setBusyId] = useState(null)
  const list = data ?? []

  async function decide(id, approve) {
    setBusyId(id)
    try {
      if (approve) await approveTakedown(id)
      else await rejectTakedown(id)
      toast.success(approve ? '승인 — 이 게시판에서 게시취소했습니다.' : '거절 — 게시를 유지합니다.')
      reload()
    } catch (e) {
      toast.error(e?.response?.data?.message || e?.message || '처리 실패')
    } finally {
      setBusyId(null)
    }
  }

  // 대기 중 요청이 없으면 패널 자체를 숨긴다(잡음 최소화).
  if (loading || list.length === 0) return null

  return (
    <Card className="border-amber-300 dark:border-amber-700">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Trash2 className="h-4 w-4 text-amber-600" />
          <span className="text-sm font-semibold">게시취소 요청</span>
          <Badge variant="secondary">{list.length}</Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          작성자가 이 게시판에서 보고서를 내려달라고 요청했습니다. 승인하면 이
          게시판에서 게시취소되고(다른 게시판·원본은 유지), 거절하면 게시가
          그대로 유지됩니다.
        </p>
        <div className="space-y-1.5">
          {list.map((r) => (
            <div
              key={r.id}
              className="flex items-center gap-2 rounded-md border px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {r.report_title || `보고서 #${r.report_id}`}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  요청: {r.requested_by_name || '—'}
                  {r.created_at
                    ? ` · ${new Date(r.created_at).toLocaleDateString('ko-KR')}`
                    : ''}
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={busyId === r.id}
                onClick={() => decide(r.id, true)}
              >
                승인(게시취소)
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busyId === r.id}
                onClick={() => decide(r.id, false)}
              >
                거절
              </Button>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
