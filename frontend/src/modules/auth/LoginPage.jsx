import { useState } from 'react'
import { Link, useLocation, useNavigate, Navigate } from 'react-router-dom'
import { LogIn } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/components/ui/card'
import { useAuth } from '@/shared/auth/AuthContext'

export default function LoginPage() {
  const { login, isAuthenticated, loading } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState(null)

  // Already logged in → bounce to whatever the user was trying to reach.
  if (!loading && isAuthenticated) {
    const from = location.state?.from || '/'
    return <Navigate to={from} replace />
  }

  async function onSubmit(e) {
    e.preventDefault()
    setErrorMsg(null)
    setSubmitting(true)
    try {
      await login({ email, password })
      const from = location.state?.from || '/'
      navigate(from, { replace: true })
    } catch (err) {
      setErrorMsg(err.message || '로그인에 실패했습니다.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-muted/30 p-6">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1 text-center">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
            <LogIn className="h-5 w-5 text-primary" />
          </div>
          <CardTitle className="text-xl">Report Archive</CardTitle>
          <CardDescription>로그인하여 부서 보고서에 접근하세요.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">이메일</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                required
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">비밀번호</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
                required
              />
            </div>

            {errorMsg && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {errorMsg}
              </div>
            )}

            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? '로그인 중...' : '로그인'}
            </Button>

            <div className="text-center text-xs text-muted-foreground">
              계정이 없나요?{' '}
              <Link to="/signup" className="text-primary hover:underline">
                회원가입
              </Link>
            </div>

            <div className="rounded-md border bg-muted/40 p-3 text-[11px] text-muted-foreground">
              <div className="font-semibold mb-1">테스트 계정</div>
              <ul className="space-y-0.5 font-mono">
                <li>admin@example.com / admin1234 (관리자)</li>
                <li>manager@example.com / manager1234 (매니저)</li>
                <li>user@example.com / user1234 (사용자)</li>
              </ul>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
