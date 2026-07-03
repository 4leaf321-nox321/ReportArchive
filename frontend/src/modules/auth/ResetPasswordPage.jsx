import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { KeyRound, CheckCircle2 } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/shared/components/ui/card'
import { confirmPasswordReset } from '@/shared/api/auth'

/**
 * 셀프 비밀번호 재설정 — 이메일로 받은 링크(/reset-password?token=...)로 진입.
 * 토큰으로 새 비밀번호를 설정하고 로그인으로 보낸다. 토큰은 1회용·만료.
 */
export default function ResetPasswordPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const token = params.get('token') || ''

  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  const [errorMsg, setErrorMsg] = useState(null)

  async function onSubmit(e) {
    e.preventDefault()
    setErrorMsg(null)
    if (pw.length < 8) {
      setErrorMsg('비밀번호는 8자 이상이어야 합니다.')
      return
    }
    if (pw !== pw2) {
      setErrorMsg('새 비밀번호가 일치하지 않습니다.')
      return
    }
    setSubmitting(true)
    try {
      await confirmPasswordReset({ token, newPassword: pw })
      setDone(true)
      setTimeout(() => navigate('/login', { replace: true }), 2000)
    } catch (err) {
      setErrorMsg(
        err?.response?.data?.message || err.message || '재설정에 실패했습니다.',
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-muted/30 p-6">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1 text-center">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
            <KeyRound className="h-5 w-5 text-primary" />
          </div>
          <CardTitle className="text-xl">비밀번호 재설정</CardTitle>
          <CardDescription>새 비밀번호를 설정하세요.</CardDescription>
        </CardHeader>
        <CardContent>
          {!token ? (
            <div className="space-y-4">
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-3 text-sm text-destructive">
                유효하지 않은 링크입니다. 비밀번호 찾기부터 다시 요청해주세요.
              </div>
              <Button asChild variant="outline" className="w-full">
                <Link to="/forgot-password">비밀번호 찾기</Link>
              </Button>
            </div>
          ) : done ? (
            <div className="space-y-4">
              <div className="flex items-start gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-3 text-sm">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <div>
                  비밀번호가 변경되었습니다. 잠시 후 로그인 화면으로
                  이동합니다.
                </div>
              </div>
              <Button asChild variant="outline" className="w-full">
                <Link to="/login">로그인으로 이동</Link>
              </Button>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="new-pw">새 비밀번호</Label>
                <Input
                  id="new-pw"
                  type="password"
                  value={pw}
                  onChange={(e) => setPw(e.target.value)}
                  placeholder="8자 이상"
                  autoComplete="new-password"
                  required
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="new-pw2">새 비밀번호 확인</Label>
                <Input
                  id="new-pw2"
                  type="password"
                  value={pw2}
                  onChange={(e) => setPw2(e.target.value)}
                  placeholder="다시 입력"
                  autoComplete="new-password"
                  required
                />
              </div>

              {errorMsg && (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  {errorMsg}
                </div>
              )}

              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? '변경 중...' : '비밀번호 변경'}
              </Button>

              <div className="text-center text-xs text-muted-foreground">
                <Link to="/login" className="text-primary hover:underline">
                  로그인으로 돌아가기
                </Link>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
