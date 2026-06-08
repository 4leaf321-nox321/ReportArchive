import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { KeyRound } from 'lucide-react'
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
import { useAuth } from '@/shared/auth/AuthContext'
import { changeMyPassword } from '@/shared/api/me'

/**
 * 임시 비밀번호로 로그인한 계정(must_change_password=true)이 새 비밀번호를
 * 설정하도록 강제하는 화면. 변경 성공 시 서버가 플래그를 해제하므로 refresh()
 * 후 정상 진입한다. 변경 전에는 ProtectedRoute 가 모든 앱 경로를 여기로 보낸다.
 */
export default function ForcePasswordChangePage() {
  const { me, loading, refresh, logout } = useAuth()
  const navigate = useNavigate()

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState(null)

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        로딩 중...
      </div>
    )
  }
  if (!me) return <Navigate to="/login" replace />
  // 이미 변경 완료된 계정이 직접 URL로 들어오면 앱으로.
  if (!me.user?.must_change_password) return <Navigate to="/" replace />

  async function onSubmit(e) {
    e.preventDefault()
    setErrorMsg(null)
    if (newPassword !== confirm) {
      setErrorMsg('새 비밀번호가 일치하지 않습니다.')
      return
    }
    if (newPassword.length < 8) {
      setErrorMsg('비밀번호는 8자 이상이어야 합니다.')
      return
    }
    if (newPassword === currentPassword) {
      setErrorMsg('새 비밀번호가 임시 비밀번호와 같습니다.')
      return
    }
    setSubmitting(true)
    try {
      await changeMyPassword({ currentPassword, newPassword })
      await refresh() // 서버가 must_change_password 를 해제 → 정상 진입
      navigate('/', { replace: true })
    } catch (err) {
      setErrorMsg(
        err?.response?.data?.message || err.message || '변경에 실패했습니다.',
      )
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
          <CardTitle className="text-xl">새 비밀번호 설정</CardTitle>
          <CardDescription>
            관리자가 발급한 임시 비밀번호로 로그인했습니다. 계속하려면 새
            비밀번호를 설정하세요.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="current">임시 비밀번호</Label>
              <Input
                id="current"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="발급받은 임시 비밀번호"
                autoComplete="current-password"
                required
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new">새 비밀번호</Label>
              <Input
                id="new"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="8자 이상"
                autoComplete="new-password"
                required
                minLength={8}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="confirm">새 비밀번호 확인</Label>
              <Input
                id="confirm"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                required
                minLength={8}
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
            <button
              type="button"
              onClick={() => logout(true)}
              className="w-full text-center text-xs text-muted-foreground hover:underline"
            >
              로그아웃
            </button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
