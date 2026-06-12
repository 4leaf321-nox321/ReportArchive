import { useEffect, useState } from 'react'
import { Plug, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/components/ui/card'
import { Badge } from '@/shared/components/ui/badge'
import { Separator } from '@/shared/components/ui/separator'
import { useAuth } from '@/shared/auth/AuthContext'
import { listMcpTokens, createMcpToken, revokeMcpToken } from '@/shared/api/me'
import { copyTextToClipboard } from '@/shared/lib/clipboard'

/**
 * MCP 토큰 탭 — 공통 → AI 설정 안에 있지만 내용은 개인 단위다.
 * useAuth() 로 접속한 본인의 토큰만 발급·조회·취소한다(목록 API 자체가
 * 현재 사용자 토큰만 돌려줌). 부서 slug 는 등록 명령 헤더에 쓰인다.
 */
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
  // HTTP(비보안 컨텍스트)에서도 동작하도록 공용 폴백 헬퍼 사용
  // (운영서버는 평문 HTTP — navigator.clipboard 가 없음).
  copyTextToClipboard(text)
    .then(() => toast.success(`${label} 복사됨`))
    .catch(() => toast.error('복사 실패 — 직접 선택해 복사하세요'))
}

export function McpTab() {
  const { me } = useAuth()
  return (
    <div className="max-w-2xl">
      <McpTokensCard me={me} />
    </div>
  )
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
