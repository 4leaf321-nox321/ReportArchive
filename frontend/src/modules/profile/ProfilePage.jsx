import { useEffect, useState } from 'react'
import { User, KeyRound, Building2, Plug, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/components/ui/card'
import { Badge } from '@/shared/components/ui/badge'
import { Separator } from '@/shared/components/ui/separator'
import { PageHeader } from '@/shared/components/PageHeader'
import { useAuth } from '@/shared/auth/AuthContext'
import {
  updateMyProfile,
  changeMyPassword,
  listMcpTokens,
  createMcpToken,
  revokeMcpToken,
} from '@/shared/api/me'

// p8 마이그레이션 후 workspace role 은 manager/user 두 값만 존재.
const ROLE_LABEL = { manager: '매니저', user: '사용자' }
const ROLE_VARIANT = { manager: 'default', user: 'outline' }

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
      <McpTokensCard me={me} />
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

function tokenStatus(t) {
  if (t.revoked_at) return { label: '취소됨', variant: 'destructive' }
  if (t.expires_at && new Date(t.expires_at) < new Date())
    return { label: '만료', variant: 'outline' }
  return { label: '활성', variant: 'default' }
}

function fmtDate(s) {
  if (!s) return '—'
  try {
    return new Date(s).toLocaleDateString('ko-KR', { year: '2-digit', month: '2-digit', day: '2-digit' })
  } catch {
    return s
  }
}

function copyText(text, label) {
  navigator.clipboard
    .writeText(text)
    .then(() => toast.success(`${label} 복사됨`))
    .catch(() => toast.error('복사 실패 — 직접 선택해 복사하세요'))
}

function McpTokensCard({ me }) {
  const [tokens, setTokens] = useState([])
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [expiresDays, setExpiresDays] = useState(90)
  const [creating, setCreating] = useState(false)
  const [reveal, setReveal] = useState(null) // 방금 발급된 평문(1회 노출)

  async function load() {
    setLoading(true)
    try {
      setTokens(await listMcpTokens())
    } catch (err) {
      toast.error(err.message || '토큰 목록을 불러오지 못했습니다.')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    load()
  }, [])

  async function onCreate(e) {
    e.preventDefault()
    if (!name.trim()) return
    setCreating(true)
    try {
      const data = await createMcpToken({ name: name.trim(), expiresDays })
      setReveal(data.token)
      setName('')
      await load()
    } catch (err) {
      toast.error(err.message || '토큰 발급 실패')
    } finally {
      setCreating(false)
    }
  }

  async function onRevoke(t) {
    if (!window.confirm(`'${t.name}' 토큰을 취소할까요? 이 토큰을 쓰는 연결은 즉시 끊깁니다.`))
      return
    try {
      await revokeMcpToken(t.id)
      toast.success('토큰을 취소했습니다.')
      await load()
    } catch (err) {
      toast.error(err.message || '취소 실패')
    }
  }

  const host = typeof window !== 'undefined' ? window.location.hostname : 'localhost'
  const slug = me?.workspace_slug || '<부서slug>'
  const addCmd = reveal
    ? `claude mcp add --transport http reportarchive http://${host}:3002/mcp \\\n  --header "Authorization: Bearer ${reveal}" \\\n  --header "X-Workspace-Slug: ${slug}"`
    : ''

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Plug className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-base">MCP 토큰 (Claude 연동)</CardTitle>
        </div>
        <CardDescription>
          Claude(Claude Code 등)에서 보고서를 작성·검색할 때 쓰는 개인 토큰. 발급된 값은
          <b> 한 번만</b> 보이니 바로 복사하세요. 유출되면 여기서 취소하면 됩니다.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 방금 발급된 토큰 — 1회 노출 */}
        {reveal && (
          <div className="rounded-md border border-primary/40 bg-primary/5 p-3 space-y-2">
            <div className="text-sm font-medium text-primary">
              토큰이 발급되었습니다. 지금 복사하세요 — 다시 볼 수 없습니다.
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-muted px-2 py-1 text-xs font-mono">
                {reveal}
              </code>
              <Button type="button" size="sm" variant="outline" onClick={() => copyText(reveal, '토큰')}>
                토큰 복사
              </Button>
            </div>
            <Separator />
            <div className="text-xs text-muted-foreground">
              아래 명령을 터미널에 붙여 Claude Code 에 등록(주소·부서는 확인 후 수정):
            </div>
            <pre className="overflow-x-auto rounded bg-muted px-2 py-2 text-[11px] font-mono whitespace-pre">{addCmd}</pre>
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => copyText(addCmd, '등록 명령')}>
                명령 복사
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setReveal(null)}>
                확인했습니다(닫기)
              </Button>
            </div>
          </div>
        )}

        {/* 발급 폼 */}
        <form onSubmit={onCreate} className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5 flex-1 min-w-[160px]">
            <Label htmlFor="tok-name">토큰 이름</Label>
            <Input
              id="tok-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="예: 내 노트북"
              maxLength={100}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tok-exp">만료</Label>
            <select
              id="tok-exp"
              value={expiresDays}
              onChange={(e) => setExpiresDays(Number(e.target.value))}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value={30}>30일</option>
              <option value={90}>90일</option>
              <option value={365}>1년</option>
            </select>
          </div>
          <Button type="submit" disabled={creating || !name.trim()}>
            {creating ? '발급 중...' : '토큰 발급'}
          </Button>
        </form>

        <Separator />

        {/* 목록 */}
        {loading ? (
          <p className="text-sm text-muted-foreground">불러오는 중...</p>
        ) : tokens.length === 0 ? (
          <p className="text-sm text-muted-foreground">발급된 토큰이 없습니다.</p>
        ) : (
          <ul className="divide-y">
            {tokens.map((t) => {
              const st = tokenStatus(t)
              return (
                <li key={t.id} className="flex items-center justify-between gap-2 py-2">
                  <div className="min-w-0 flex flex-col gap-0.5">
                    <span className="text-sm font-medium truncate">{t.name}</span>
                    <span className="text-[10px] text-muted-foreground font-mono">
                      {t.token_prefix}… · 생성 {fmtDate(t.created_at)} · 마지막 사용{' '}
                      {fmtDate(t.last_used_at)} · 만료 {fmtDate(t.expires_at)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant={st.variant}>{st.label}</Badge>
                    {!t.revoked_at && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => onRevoke(t)}
                        title="취소"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
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
