import { useEffect, useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { UserPlus } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/components/ui/card'
import { WorkspaceCombobox } from '@/shared/components/WorkspaceCombobox'
import { useAuth } from '@/shared/auth/AuthContext'
import { listPublicWorkspaces } from '@/shared/api/auth'

export default function SignupPage() {
  const { signup, isAuthenticated, loading: authLoading } = useAuth()
  const navigate = useNavigate()

  // 이메일은 로컬부분 + 호스트로 분리 입력. 사내 계정이 대부분 @samsung.com 이라
  // 호스트 기본값을 미리 채워 잘못된 도메인 가입을 줄인다(필요하면 수정 가능).
  const [emailLocal, setEmailLocal] = useState('')
  const [emailHost, setEmailHost] = useState('samsung.com')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [workspaceSlug, setWorkspaceSlug] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState(null)

  // Fetch the public workspace list for the 소속 combobox.
  const [workspaces, setWorkspaces] = useState([])
  const [wsLoading, setWsLoading] = useState(true)
  useEffect(() => {
    let cancelled = false
    listPublicWorkspaces()
      .then((data) => {
        if (cancelled) return
        const list = data || []
        setWorkspaces(list)
        // Default to a leaf-ish workspace (more specific) over the top 본부.
        const firstLeaf = list.find((w) => w.parent_slug != null)
        if (firstLeaf) setWorkspaceSlug(firstLeaf.slug)
        else if (list[0]) setWorkspaceSlug(list[0].slug)
      })
      .finally(() => {
        if (!cancelled) setWsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (!authLoading && isAuthenticated) {
    return <Navigate to="/" replace />
  }

  async function onSubmit(e) {
    e.preventDefault()
    setErrorMsg(null)

    const local = emailLocal.trim()
    const host = emailHost.trim()
    if (!local || !host) {
      setErrorMsg('이메일 주소와 호스트를 모두 입력하세요.')
      return
    }
    const email = `${local}@${host}`
    if (password !== passwordConfirm) {
      setErrorMsg('비밀번호가 일치하지 않습니다.')
      return
    }
    if (password.length < 8) {
      setErrorMsg('비밀번호는 8자 이상이어야 합니다.')
      return
    }
    if (!workspaceSlug) {
      setErrorMsg('소속을 선택하세요.')
      return
    }

    setSubmitting(true)
    try {
      await signup({ email, name, password, workspaceSlug })
      navigate('/', { replace: true })
    } catch (err) {
      setErrorMsg(err.message || '가입에 실패했습니다.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-muted/30 p-6">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1 text-center">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
            <UserPlus className="h-5 w-5 text-primary" />
          </div>
          <CardTitle className="text-xl">회원가입</CardTitle>
          <CardDescription>
            소속 부서를 선택해 가입하세요. 가입 후 기본 권한은 <strong>사용자</strong>입니다.
            관리자 / 매니저 권한은 부서 관리자가 부여합니다.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">이메일</Label>
              <div className="flex items-center gap-1.5">
                <Input
                  id="email"
                  type="text"
                  value={emailLocal}
                  onChange={(e) => {
                    const v = e.target.value
                    // 전체 이메일을 붙여넣으면 @ 기준으로 호스트까지 자동 분리.
                    if (v.includes('@')) {
                      const [local, ...rest] = v.split('@')
                      setEmailLocal(local)
                      const host = rest.join('@').trim()
                      if (host) setEmailHost(host)
                    } else {
                      setEmailLocal(v)
                    }
                  }}
                  placeholder="아이디"
                  autoComplete="username"
                  required
                  autoFocus
                  className="flex-1 min-w-0"
                />
                <span className="select-none text-sm text-muted-foreground">@</span>
                <Input
                  id="email-host"
                  type="text"
                  value={emailHost}
                  onChange={(e) => setEmailHost(e.target.value)}
                  placeholder="samsung.com"
                  autoComplete="off"
                  required
                  aria-label="이메일 호스트"
                  className="w-40 shrink-0"
                />
              </div>
              <p className="text-[11px] text-muted-foreground">
                기본 호스트는 <strong>samsung.com</strong> 입니다. 다른 도메인이면 직접 수정하세요.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="name">이름</Label>
              <Input
                id="name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="홍길동"
                autoComplete="name"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="workspace">소속</Label>
              <WorkspaceCombobox
                id="workspace"
                excludeArchived
                workspaces={workspaces}
                value={workspaceSlug}
                onChange={setWorkspaceSlug}
                disabled={wsLoading || workspaces.length === 0}
                placeholder={
                  wsLoading
                    ? '부서 목록 로딩 중...'
                    : workspaces.length === 0
                      ? '사용 가능한 부서가 없습니다'
                      : '소속 부서 선택...'
                }
                searchPlaceholder="부서명으로 검색..."
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="password">비밀번호</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="8자 이상"
                  autoComplete="new-password"
                  required
                  minLength={8}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="password-confirm">비밀번호 확인</Label>
                <Input
                  id="password-confirm"
                  type="password"
                  value={passwordConfirm}
                  onChange={(e) => setPasswordConfirm(e.target.value)}
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

            <Button type="submit" className="w-full" disabled={submitting || wsLoading}>
              {submitting ? '가입 중...' : '가입'}
            </Button>

            <div className="text-center text-xs text-muted-foreground">
              이미 계정이 있나요?{' '}
              <Link to="/login" className="text-primary hover:underline">
                로그인
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
