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

  async function onDelete(t) {
    if (!window.confirm(`'${t.name}' 토큰을 삭제할까요? 이 토큰을 쓰는 연결은 즉시 끊기고 목록에서 사라집니다.`))
      return
    try {
      await revokeMcpToken(t.id)
      toast.success('토큰을 삭제했습니다.')
      await load()
    } catch (err) {
      toast.error(err.message || '삭제 실패')
    }
  }

  const host = typeof window !== 'undefined' ? window.location.hostname : 'localhost'
  const slug = me?.workspace_slug || '<부서slug>'
  const mcpUrl = `http://${host}:3002/mcp`
  // Claude Code — 터미널 등록 명령(mcp-remote 브리지, stdio). Desktop·Codex 와
  // 같은 브리지로 통일해 HTTP URL(--allow-http)·시스템 CA(NODE_OPTIONS) 문제를 동일하게 처리.
  // 토큰·부서는 env(-e)로 넣고, args 의 ${...} 는 mcp-remote 가 치환(셸 확장 방지용 작은따옴표).
  const addCmd = reveal
    ? `claude mcp add reportarchive \\\n  -e AUTH='Bearer ${reveal}' \\\n  -e WS='${slug}' \\\n  -e NODE_OPTIONS=--use-system-ca \\\n  -- npx -y mcp-remote ${mcpUrl} --allow-http \\\n  --header 'Authorization:\${AUTH}' \\\n  --header 'X-Workspace-Slug:\${WS}'`
    : ''
  // Claude Desktop — claude_desktop_config.json 의 `mcpServers` 안에 붙여넣는 **항목만**.
  // (바깥 {mcpServers:{...}} 래퍼는 빼서, 기존 설정에 그대로 끼워넣기 쉽게 한다.)
  // Desktop 설정 파일은 stdio(command) 서버만 받으므로 HTTP 서버는 `mcp-remote`
  // 브리지로 연결(Node.js/npx 필요). 헤더 공백 문제를 피하려 값은 env 로 넣고
  // args 에선 ${...} 치환(mcp-remote 가 처리).
  const desktopCfg = reveal
    ? `"reportarchive": ${JSON.stringify(
        {
          command: 'npx',
          args: [
            '-y',
            'mcp-remote',
            mcpUrl,
            '--allow-http',
            '--header',
            'Authorization:${AUTH}',
            '--header',
            'X-Workspace-Slug:${WS}',
          ],
          env: {
            AUTH: `Bearer ${reveal}`,
            WS: slug,
            NODE_OPTIONS: '--use-system-ca',
          },
        },
        null,
        2,
      )}`
    : ''
  // Codex CLI — ~/.codex/config.toml 의 stdio 서버 항목(TOML). Desktop·Claude Code 와
  // 같은 mcp-remote 브리지로 통일해 HTTP URL(--allow-http)·시스템 CA(NODE_OPTIONS) 문제를
  // 동일하게 처리. 토큰·부서는 env 로 넣고 args 의 ${...} 는 mcp-remote 가 치환.
  const codexCfg = reveal
    ? `[mcp_servers.reportarchive]
command = "npx"
args = ["-y", "mcp-remote", "${mcpUrl}", "--allow-http", "--header", "Authorization:\${AUTH}", "--header", "X-Workspace-Slug:\${WS}"]

[mcp_servers.reportarchive.env]
AUTH = "Bearer ${reveal}"
WS = "${slug}"
NODE_OPTIONS = "--use-system-ca"`
    : ''
  // Gemini CLI — ~/.gemini/settings.json 의 `mcpServers` 안에 붙여넣는 항목.
  // Gemini CLI 의 stdio MCP 서버 항목은 Claude Desktop 과 같은 shape
  // (command/args/env)라 desktopCfg 를 그대로 재사용한다(같은 mcp-remote 브리지).
  const geminiCfg = desktopCfg

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Plug className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-base">MCP 토큰 (Claude·Codex·Gemini 연동)</CardTitle>
        </div>
        <CardDescription>
          AI CLI(Claude Code·Codex·Gemini CLI 등)에서 보고서를 작성·검색할 때 쓰는 개인 토큰. 발급된 값은
          <b> 한 번만</b> 보이니 바로 복사하세요. 유출되면 여기서 삭제하면 됩니다.
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
            {/* Claude Code — 터미널 명령 */}
            <div className="text-xs font-medium">Claude Code (터미널)</div>
            <div className="text-xs text-muted-foreground">
              아래 명령을 터미널에 붙여 등록(주소·부서는 확인 후 수정):
              <span className="block mt-1"><b>Node.js 필요</b> — HTTP 주소·사내 인증서 문제를 안정적으로 처리하려 <code className="font-mono">npx mcp-remote</code> 브리지로 연결합니다.</span>
            </div>
            <pre className="overflow-x-auto rounded bg-muted px-2 py-2 text-[11px] font-mono whitespace-pre">{addCmd}</pre>
            <Button type="button" size="sm" variant="outline" onClick={() => copyText(addCmd, '등록 명령')}>
              명령 복사
            </Button>
            <Separator />
            {/* Claude Desktop — 설정 파일(JSON, mcp-remote 브리지) */}
            <div className="text-xs font-medium">Claude Desktop (설정 파일)</div>
            <div className="text-xs text-muted-foreground">
              설정 → 개발자 → 「설정 편집」으로 <code className="font-mono">claude_desktop_config.json</code> 을 열고,
              아래 <b>항목을 <code className="font-mono">{'"mcpServers": { }'}</code> 중괄호 안에</b> 붙여넣은 뒤 Claude Desktop 재시작.
              <span className="block mt-1">파일에 <code className="font-mono">mcpServers</code> 가 없으면 <code className="font-mono">{'{ "mcpServers": { 여기 } }'}</code> 형태로 감싸고, 다른 항목이 이미 있으면 사이에 쉼표(<code className="font-mono">,</code>)를 넣으세요.</span>
              <span className="block mt-1"><b>Node.js 필요</b> — Desktop 설정 파일은 HTTP 서버를 직접 못 받아 <code className="font-mono">npx mcp-remote</code> 브리지로 연결합니다.</span>
            </div>
            <pre className="overflow-x-auto rounded bg-muted px-2 py-2 text-[11px] font-mono whitespace-pre">{desktopCfg}</pre>
            <Button type="button" size="sm" variant="outline" onClick={() => copyText(desktopCfg, 'Desktop 항목')}>
              항목 복사
            </Button>
            <Separator />
            {/* Codex CLI — config.toml (mcp-remote 브리지, stdio) */}
            <div className="text-xs font-medium">Codex CLI (설정 파일)</div>
            <div className="text-xs text-muted-foreground">
              <code className="font-mono">~/.codex/config.toml</code> 에 아래 항목을 추가한 뒤 Codex 재시작(부서를 바꾸려면 <code className="font-mono">WS</code> 값만 수정).
              <span className="block mt-1"><b>Node.js 필요</b> — HTTP 주소·사내 인증서 문제를 안정적으로 처리하려 <code className="font-mono">npx mcp-remote</code> 브리지로 연결합니다.</span>
            </div>
            <pre className="overflow-x-auto rounded bg-muted px-2 py-2 text-[11px] font-mono whitespace-pre">{codexCfg}</pre>
            <Button type="button" size="sm" variant="outline" onClick={() => copyText(codexCfg, 'Codex 설정')}>
              설정 복사
            </Button>
            <Separator />
            {/* Gemini CLI — ~/.gemini/settings.json (mcp-remote 브리지, stdio) */}
            <div className="text-xs font-medium">Gemini CLI (설정 파일)</div>
            <div className="text-xs text-muted-foreground">
              <code className="font-mono">~/.gemini/settings.json</code> 을 열고,
              아래 <b>항목을 <code className="font-mono">{'"mcpServers": { }'}</code> 중괄호 안에</b> 붙여넣은 뒤 Gemini CLI 재시작(부서를 바꾸려면 <code className="font-mono">WS</code> 값만 수정).
              <span className="block mt-1">파일이나 <code className="font-mono">mcpServers</code> 가 없으면 <code className="font-mono">{'{ "mcpServers": { 여기 } }'}</code> 형태로 감싸고, 다른 항목이 이미 있으면 사이에 쉼표(<code className="font-mono">,</code>)를 넣으세요.</span>
              <span className="block mt-1"><b>Node.js 필요</b> — HTTP 주소·사내 인증서 문제를 안정적으로 처리하려 <code className="font-mono">npx mcp-remote</code> 브리지로 연결합니다.</span>
            </div>
            <pre className="overflow-x-auto rounded bg-muted px-2 py-2 text-[11px] font-mono whitespace-pre">{geminiCfg}</pre>
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => copyText(geminiCfg, 'Gemini 항목')}>
                항목 복사
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
                        onClick={() => onDelete(t)}
                        title="삭제"
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
