import { useState } from 'react'
import { Link } from 'react-router-dom'
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
import { requestPasswordReset } from '@/shared/api/auth'

/**
 * 비밀번호 찾기 — 이메일 발송 인프라가 없어 '관리자 중개' 방식. 요청을 접수해
 * 관리자 큐에 쌓고, 관리자가 본인 확인 후 임시 비번을 발급한다. 이메일 존재
 * 여부는 노출하지 않으므로 제출 시 항상 동일한 접수 안내를 보여준다.
 */
export default function ForgotPasswordPage() {
  const [emailLocal, setEmailLocal] = useState('')
  const [emailHost, setEmailHost] = useState('samsung.com')
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  const [errorMsg, setErrorMsg] = useState(null)

  async function onSubmit(e) {
    e.preventDefault()
    setErrorMsg(null)
    const local = emailLocal.trim()
    const host = emailHost.trim()
    if (!local || !host) {
      setErrorMsg('이메일 주소와 호스트를 모두 입력하세요.')
      return
    }
    setSubmitting(true)
    try {
      await requestPasswordReset({ email: `${local}@${host}` })
      setDone(true)
    } catch (err) {
      setErrorMsg(err?.response?.data?.message || err.message || '요청에 실패했습니다.')
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
          <CardTitle className="text-xl">비밀번호 찾기</CardTitle>
          <CardDescription>
            가입한 이메일로 비밀번호 재설정 링크를 보내드립니다. (메일 발송이
            준비되지 않은 환경에서는 부서 관리자가 확인 후 임시 비밀번호를
            발급합니다.)
          </CardDescription>
        </CardHeader>
        <CardContent>
          {done ? (
            <div className="space-y-4">
              <div className="flex items-start gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-3 text-sm">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <div>
                  요청이 접수되었습니다. 가입된 계정이면 재설정 링크를 이메일로
                  보내드립니다 — 메일함(스팸함 포함)을 확인하세요. 메일이 오지
                  않으면 부서 관리자가 임시 비밀번호를 발급해 드립니다.
                </div>
              </div>
              <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                급하면 소속 <strong>부서 관리자</strong>에게 직접 재설정을
                요청하세요. 관리자가 계정 관리에서 즉시 임시 비밀번호를 발급할
                수 있습니다.
              </div>
              <Button asChild variant="outline" className="w-full">
                <Link to="/login">로그인으로 돌아가기</Link>
              </Button>
            </div>
          ) : (
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
              </div>

              {errorMsg && (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  {errorMsg}
                </div>
              )}

              <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                급하면 소속 <strong>부서 관리자</strong>에게 직접 요청하면 더
                빠르게 처리됩니다.
              </div>

              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? '요청 중...' : '재설정 요청'}
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
