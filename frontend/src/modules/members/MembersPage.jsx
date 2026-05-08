import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Trash2, ShieldCheck, UserCog, User as UserIcon, KeyRound } from 'lucide-react'
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
import { useAuth } from '@/shared/auth/AuthContext'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import { useAsync } from '@/shared/hooks/useAsync'
import {
  listMembers,
  addMember,
  updateMemberRole,
  removeMember,
} from '@/shared/api/members'
import { adminSetUserPassword } from '@/shared/api/me'

const ROLES = [
  { value: 'admin', label: '관리자', icon: ShieldCheck, description: '멤버 + 기준정보 관리, 매니저 권한 포함' },
  { value: 'manager', label: '매니저', icon: UserCog, description: '보고서 + 템플릿 작성/편집/삭제' },
  { value: 'user', label: '사용자', icon: UserIcon, description: '보고서 조회' },
]

const ROLE_LABEL = Object.fromEntries(ROLES.map((r) => [r.value, r.label]))
const ROLE_VARIANT = { admin: 'default', manager: 'secondary', user: 'outline' }

export default function MembersPage() {
  const { me } = useAuth()
  const { workspace, slug, getPath } = useWorkspace()
  const [addOpen, setAddOpen] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(null)
  const [resetPwdMember, setResetPwdMember] = useState(null)

  const { data: members, loading, error, reload } = useAsync(
    () => (slug ? listMembers(slug) : Promise.resolve([])),
    [slug]
  )

  const isAdmin = me?.role === 'admin'

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

  if (!isAdmin) {
    return (
      <div className="p-6">
        <PageHeader title="멤버" description={`${workspace.name} 멤버 관리`} />
        <ErrorState
          title="권한 없음"
          description="멤버 관리는 부서 관리자만 가능합니다."
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
      await updateMemberRole(slug, memberId, { role: newRole })
      toast.success('역할이 변경되었습니다.')
      reload()
    } catch (err) {
      toast.error(err.message || '역할 변경 실패')
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

  const direct = (members ?? []).filter((m) => m.source === 'direct')
  const inherited = (members ?? []).filter((m) => m.source === 'inherited')
  const descendants = (members ?? []).filter((m) => m.source === 'descendant')

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="멤버"
        description={`${workspace.name} — 직접 ${direct.length}명, 상속 ${inherited.length}명, 하위 부서 ${descendants.length}명`}
        breadcrumbs={breadcrumb}
        actions={
          <Button onClick={() => setAddOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            멤버 추가
          </Button>
        }
      />

      {error ? (
        <ErrorState description={error.message} onRetry={reload} />
      ) : loading ? (
        <Skeleton className="h-64" />
      ) : (
        <>
          <Card>
            <CardContent className="pt-6">
              <SectionHeading
                title="이 부서의 직접 멤버"
                hint={`${workspace.name}에 직접 등록된 사용자`}
              />
              {direct.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4">
                  이 부서에 직접 등록된 멤버가 없습니다.
                </p>
              ) : (
                <ul className="divide-y">
                  {direct.map((m) => (
                    <MemberRow
                      key={m.id}
                      member={m}
                      isSelf={me.user.id === m.user_id}
                      onChangeRole={(role) => handleChangeRole(m.id, role)}
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
                  hint="상위 부서에서 관리됨 — 여기서는 수정 불가"
                />
                <ul className="divide-y">
                  {inherited.map((m) => (
                    <MemberRow key={m.id} member={m} readonly />
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {descendants.length > 0 && (
            <Card>
              <CardContent className="pt-6">
                <SectionHeading
                  title="하위 부서 멤버"
                  hint="산하 팀에 직접 등록된 사용자 — 관리자 권한이 트리로 상속되어 여기서도 수정 가능"
                />
                <ul className="divide-y">
                  {descendants.map((m) => (
                    <MemberRow
                      key={m.id}
                      member={m}
                      isSelf={me.user.id === m.user_id}
                      onChangeRole={(role) => handleChangeRole(m.id, role)}
                      onRemove={() => setConfirmRemove(m)}
                      onResetPassword={() => setResetPwdMember(m)}
                      showAssignedWorkspace
                    />
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
        workspaceSlug={slug}
        workspaceName={workspace.name}
      />

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
  onChangeRole,
  onRemove,
  onResetPassword,
  readonly,
  showAssignedWorkspace,
}) {
  return (
    <li className="flex items-center gap-3 py-3">
      <div className="rounded-full bg-muted h-8 w-8 flex items-center justify-center text-xs font-medium">
        {member.name.charAt(0)}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium">{member.name}</span>
          <span className="text-[10px] text-muted-foreground font-mono">#{member.user_id}</span>
          {isSelf && <Badge variant="outline" className="text-[10px]">본인</Badge>}
          {readonly && member.source === 'inherited' && (
            <Badge variant="secondary" className="text-[10px]">
              상속: {member.source_workspace_slug}
            </Badge>
          )}
          {showAssignedWorkspace && (
            <Badge variant="secondary" className="text-[10px]">
              소속: {member.source_workspace_slug}
            </Badge>
          )}
        </div>
        <div className="text-xs text-muted-foreground">{member.email}</div>
      </div>

      {readonly ? (
        <Badge variant={ROLE_VARIANT[member.role]}>{ROLE_LABEL[member.role]}</Badge>
      ) : (
        <>
          <select
            value={member.role}
            disabled={isSelf}
            onChange={(e) => onChangeRole(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
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
            disabled={isSelf}
            onClick={onRemove}
            aria-label="멤버 제거"
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

function AddMemberDialog({ open, onOpenChange, onAdded, workspaceSlug, workspaceName }) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('user')
  const [submitting, setSubmitting] = useState(false)

  async function onSubmit(e) {
    e.preventDefault()
    setSubmitting(true)
    try {
      await addMember(workspaceSlug, { email, role })
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
          <DialogTitle>{workspaceName}에 멤버 추가</DialogTitle>
          <DialogDescription>
            등록된 사용자의 이메일을 입력하세요. 사용자 계정은 별도로 생성되어 있어야 합니다.
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
