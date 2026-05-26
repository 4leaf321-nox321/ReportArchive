import { useEffect, useState } from 'react'
import { User, KeyRound, Building2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/components/ui/card'
import { Badge } from '@/shared/components/ui/badge'
import { Separator } from '@/shared/components/ui/separator'
import { PageHeader } from '@/shared/components/PageHeader'
import { useAuth } from '@/shared/auth/AuthContext'
import { updateMyProfile, changeMyPassword } from '@/shared/api/me'

const ROLE_LABEL = { admin: '관리자', manager: '매니저', user: '사용자' }
const ROLE_VARIANT = { admin: 'default', manager: 'secondary', user: 'outline' }

export default function ProfilePage() {
  const { me, refresh } = useAuth()

  if (!me?.user) {
    return (
      <div className="p-6 text-sm text-muted-foreground">사용자 정보를 불러오는 중...</div>
    )
  }

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <PageHeader title="프로필" description="계정 정보 + 비밀번호 변경" />

      <ProfileForm me={me} onSaved={refresh} />
      <PasswordForm />
      <MembershipsCard memberships={me.memberships} />
    </div>
  )
}

function ProfileForm({ me, onSaved }) {
  const [name, setName] = useState(me.user.name)
  const [submitting, setSubmitting] = useState(false)

  // Keep local form synced if me.user changes elsewhere (e.g. another tab).
  useEffect(() => {
    setName(me.user.name)
  }, [me.user.name])

  const dirty = name.trim() !== me.user.name && name.trim().length > 0

  async function onSubmit(e) {
    e.preventDefault()
    setSubmitting(true)
    try {
      await updateMyProfile({ name: name.trim() })
      toast.success('프로필이 저장되었습니다.')
      await onSaved()
    } catch (err) {
      toast.error(err.message || '저장 실패')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <User className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-base">계정 정보</CardTitle>
        </div>
        <CardDescription>
          이메일은 로그인 식별자라 여기서 변경할 수 없습니다.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label>이메일</Label>
            <Input value={me.user.email} disabled className="bg-muted" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="profile-name">이름</Label>
            <Input
              id="profile-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="이름"
              required
            />
          </div>
          <Button type="submit" disabled={!dirty || submitting}>
            {submitting ? '저장 중...' : '저장'}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

function PasswordForm() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState(null)

  async function onSubmit(e) {
    e.preventDefault()
    setErrorMsg(null)

    if (next !== confirm) {
      setErrorMsg('새 비밀번호가 일치하지 않습니다.')
      return
    }
    if (next.length < 8) {
      setErrorMsg('비밀번호는 8자 이상이어야 합니다.')
      return
    }
    if (current === next) {
      setErrorMsg('새 비밀번호가 현재 비밀번호와 같습니다.')
      return
    }

    setSubmitting(true)
    try {
      await changeMyPassword({ currentPassword: current, newPassword: next })
      toast.success('비밀번호가 변경되었습니다.')
      setCurrent('')
      setNext('')
      setConfirm('')
    } catch (err) {
      setErrorMsg(err.message || '비밀번호 변경 실패')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-base">비밀번호 변경</CardTitle>
        </div>
        <CardDescription>
          보안을 위해 현재 비밀번호 확인 후 새 비밀번호를 설정합니다.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="cur-pwd">현재 비밀번호</Label>
            <Input
              id="cur-pwd"
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          <Separator />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="new-pwd">새 비밀번호</Label>
              <Input
                id="new-pwd"
                type="password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                placeholder="8자 이상"
                autoComplete="new-password"
                required
                minLength={8}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-pwd-confirm">새 비밀번호 확인</Label>
              <Input
                id="new-pwd-confirm"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                required
                minLength={8}
              />
            </div>
          </div>

          {errorMsg && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {errorMsg}
            </div>
          )}

          <Button type="submit" disabled={submitting}>
            {submitting ? '변경 중...' : '비밀번호 변경'}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

function MembershipsCard({ memberships }) {
  // Personal workspaces carry an auto-provisioned self-admin row that
  // isn't a "department" in the user's mental model — drop it from the
  // soso list. (kind comes from the /api/users/me response now;
  // workspace_slug fallback covers older payloads / cached responses.)
  const orgMemberships = (memberships ?? []).filter(
    (m) =>
      m.workspace_kind !== 'personal' &&
      !(m.workspace_slug || '').startsWith('personal-'),
  )
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Building2 className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-base">소속 부서</CardTitle>
        </div>
        <CardDescription>
          내가 직접 등록된 부서 + 역할. 상위 부서 멤버십은 자손에서도 자동 적용됩니다.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {orgMemberships.length === 0 ? (
          <p className="text-sm text-muted-foreground">소속된 부서가 없습니다.</p>
        ) : (
          <ul className="divide-y">
            {orgMemberships.map((m) => (
              <li
                key={m.workspace_slug}
                className="flex items-center justify-between py-2"
              >
                <div className="min-w-0 flex flex-col gap-0.5">
                  <span className="text-sm font-medium truncate">
                    {m.workspace_name || m.workspace_slug}
                  </span>
                  {m.workspace_name && (
                    <span className="text-[10px] text-muted-foreground font-mono">
                      {m.workspace_slug}
                    </span>
                  )}
                </div>
                <Badge variant={ROLE_VARIANT[m.role]}>{ROLE_LABEL[m.role]}</Badge>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
