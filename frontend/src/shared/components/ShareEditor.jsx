/** 공유 관리 본문 — Dialog/Popover 양쪽에서 재사용하는 알맹이.
 *
 *  대상: 부서(하위 상속) / 사용자 / 전체 공개(view 고정). 권한: 열람/편집.
 *  추가·삭제는 canManage 일 때만. 모드는 props(folderId>boardSlug>content).
 *
 *  props:
 *    contentType, contentId | boardSlug | folderId : 공유 대상(택1 모드).
 *    ownerUserId : 콘텐츠 소유자(canManage 자동판정용; board/folder 는 canManage 명시).
 *    canManage   : (선택) 추가/삭제 권한. 미지정이면 소유자/시스템관리자로 판정.
 *    active      : 활성(열림) 여부 — true 일 때 데이터 로드.
 *    onChanged   : 변경 후 콜백(부모 목록/뱃지 갱신).
 *    onGrantsChange(grants) : 현재 grant 목록이 바뀔 때 통지(뱃지 동기화).
 */
import * as React from 'react'
import { Globe, Loader2, Search, Users, X } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Badge } from '@/shared/components/ui/badge'
import { WorkspaceTreeSelect } from '@/shared/components/WorkspaceTreeSelect'
import { cn } from '@/shared/lib/utils'
import { toast } from 'sonner'
import { shareApi } from '@/shared/api/shares'
import { listWorkspaces } from '@/shared/api/workspaces'
import { searchUsers } from '@/shared/api/members'
import { useAuth } from '@/shared/auth/AuthContext'

const TABS = [
  { key: 'workspace', label: '부서', icon: Users },
  { key: 'user', label: '사용자', icon: Search },
  { key: 'all_org', label: '전체 공개', icon: Globe },
]

function LevelToggle({ value, onChange }) {
  return (
    <div className="inline-flex rounded border overflow-hidden text-xs">
      {[
        { v: 'view', l: '열람' },
        { v: 'edit', l: '편집' },
      ].map((o) => (
        <button
          key={o.v}
          type="button"
          onClick={() => onChange(o.v)}
          className={cn(
            'px-2.5 py-1',
            value === o.v
              ? 'bg-primary text-primary-foreground'
              : 'bg-background hover:bg-muted/50',
          )}
        >
          {o.l}
        </button>
      ))}
    </div>
  )
}

export function ShareEditor({
  contentType,
  contentId,
  ownerUserId,
  boardSlug,
  folderId,
  compositeDefaultSlug,
  canManage: canManageProp,
  active = true,
  onChanged,
  onGrantsChange,
}) {
  const { me } = useAuth()
  const isFolder = Boolean(folderId)
  const isBoard = !isFolder && Boolean(boardSlug)
  const canManage =
    canManageProp !== undefined
      ? canManageProp
      : (me?.user?.id && ownerUserId === me.user.id) ||
        me?.is_system_admin === true

  const api = React.useMemo(
    () =>
      shareApi({
        contentType,
        contentId,
        boardSlug,
        folderId,
        compositeDefaultSlug,
      }),
    [contentType, contentId, boardSlug, folderId, compositeDefaultSlug],
  )

  const [grants, setGrantsRaw] = React.useState([])
  const [loading, setLoading] = React.useState(false)
  const [tab, setTab] = React.useState('workspace')
  const [level, setLevel] = React.useState('view')
  const [orgs, setOrgs] = React.useState([])
  const [selectedWs, setSelectedWs] = React.useState(() => new Set())
  const [query, setQuery] = React.useState('')
  const [results, setResults] = React.useState([])
  const [searching, setSearching] = React.useState(false)

  const setGrants = React.useCallback(
    (next) => {
      setGrantsRaw(next)
      onGrantsChange?.(next)
    },
    [onGrantsChange],
  )

  React.useEffect(() => {
    if (!active) return
    if (!isFolder && !isBoard && !contentId) return
    let cancelled = false
    setLoading(true)
    api
      .list()
      .then((items) => !cancelled && setGrants(items))
      .catch((e) => !cancelled && toast.error(e?.response?.data?.message || '공유 조회 실패'))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, contentType, contentId, boardSlug, folderId])

  React.useEffect(() => {
    if (!active || !canManage) return
    listWorkspaces()
      .then((items) => setOrgs((items || []).filter((w) => w.kind === 'org')))
      .catch(() => setOrgs([]))
  }, [active, canManage])

  React.useEffect(() => {
    if (tab !== 'user' || !query.trim()) {
      setResults([])
      return
    }
    let cancelled = false
    setSearching(true)
    const t = setTimeout(async () => {
      try {
        const data = await searchUsers({ search: query.trim(), limit: 10 })
        if (cancelled) return
        setResults(Array.isArray(data) ? data : data?.items ?? [])
      } catch {
        if (!cancelled) setResults([])
      } finally {
        if (!cancelled) setSearching(false)
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [tab, query])

  async function doAdd(payload) {
    try {
      await api.add(payload)
      setGrants(await api.list())
      setQuery('')
      setResults([])
      toast.success('공유되었습니다.')
      onChanged?.()
    } catch (e) {
      toast.error(e?.response?.data?.message || '공유 추가 실패')
    }
  }

  async function addSelectedWorkspaces() {
    const slugs = [...selectedWs]
    if (!slugs.length) return
    try {
      for (const slug of slugs) {
        await api.add({ principalType: 'workspace', principalRef: slug, level })
      }
      setGrants(await api.list())
      setSelectedWs(new Set())
      toast.success(`${slugs.length}개 부서에 공유되었습니다.`)
      onChanged?.()
    } catch (e) {
      toast.error(e?.response?.data?.message || '공유 추가 실패')
    }
  }

  function toggleWs(slug) {
    setSelectedWs((prev) => {
      const next = new Set(prev)
      if (next.has(slug)) next.delete(slug)
      else next.add(slug)
      return next
    })
  }

  async function handleRemove(grant) {
    const prev = grants
    setGrants(grants.filter((g) => g.id !== grant.id))
    try {
      await api.remove(grant.id)
      toast.success('공유 해제')
      onChanged?.()
    } catch (e) {
      setGrants(prev)
      toast.error(e?.response?.data?.message || '공유 해제 실패')
    }
  }

  return (
    <div className="space-y-3">
      {!canManage && (
        <p className="text-xs text-amber-600">
          작성자/매니저만 추가·제거할 수 있습니다 (열람만 가능).
        </p>
      )}

      {/* 현재 공유 목록 */}
      <div>
        <label className="text-xs text-muted-foreground block mb-1.5">
          현재 공유 ({grants.length})
        </label>
        {loading ? (
          <div className="flex items-center text-sm text-muted-foreground py-3">
            <Loader2 className="h-4 w-4 animate-spin mr-2" /> 조회 중...
          </div>
        ) : grants.length === 0 ? (
          <div className="text-sm text-muted-foreground py-2 italic">
            공유 없음 (작성자 본인만 열람)
          </div>
        ) : (
          <ul className="space-y-1">
            {grants.map((g) => (
              <li
                key={g.id}
                className="flex items-center gap-2 rounded border px-2.5 py-1.5 text-sm"
              >
                {g.principal_type === 'all_org' ? (
                  <Globe className="h-3.5 w-3.5 text-sky-500 shrink-0" />
                ) : g.principal_type === 'user' ? (
                  <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                ) : (
                  <Users className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                )}
                <span className="flex-1 min-w-0 truncate">
                  {g.principal_label ?? g.principal_ref}
                </span>
                <Badge variant="outline" className="text-[10px]">
                  {g.level === 'edit' ? '편집' : '열람'}
                </Badge>
                {canManage && (
                  <button
                    type="button"
                    onClick={() => handleRemove(g)}
                    className="p-1 rounded hover:bg-red-100 hover:text-red-600"
                    title="공유 해제"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 추가 */}
      {canManage && (
        <div className="border-t pt-3 space-y-2">
          <div className="flex items-center gap-1">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={cn(
                  'inline-flex items-center gap-1 rounded px-2 py-1 text-xs',
                  tab === t.key
                    ? 'bg-muted font-medium'
                    : 'hover:bg-muted/50 text-muted-foreground',
                )}
              >
                <t.icon className="h-3 w-3" />
                {t.label}
              </button>
            ))}
            {tab !== 'all_org' && (
              <div className="ml-auto">
                <LevelToggle value={level} onChange={setLevel} />
              </div>
            )}
          </div>

          {tab === 'workspace' && (
            <div className="space-y-2">
              <WorkspaceTreeSelect
                orgWorkspaces={orgs}
                selected={selectedWs}
                onToggle={toggleWs}
                autoExpandSlugs={[...selectedWs]}
                searchPlaceholder="부서명 / slug 검색 (비우면 트리 보기)"
                maxHeightClass="max-h-52"
              />
              <div className="flex items-center justify-end gap-2">
                <span className="text-xs text-muted-foreground">
                  {selectedWs.size}개 선택
                </span>
                <Button
                  size="sm"
                  disabled={selectedWs.size === 0}
                  onClick={addSelectedWorkspaces}
                >
                  공유
                </Button>
              </div>
            </div>
          )}

          {tab === 'user' && (
            <div>
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(ev) => setQuery(ev.target.value)}
                  placeholder="이름 또는 이메일로 검색"
                  className="pl-7 text-sm"
                />
              </div>
              {(searching || results.length > 0 || query.trim()) && (
                <div className="mt-1.5 max-h-44 overflow-y-auto border rounded">
                  {searching ? (
                    <div className="flex items-center text-xs text-muted-foreground p-2">
                      <Loader2 className="h-3 w-3 animate-spin mr-1.5" />
                      검색 중...
                    </div>
                  ) : results.length === 0 ? (
                    <div className="text-xs text-muted-foreground p-2 italic">
                      결과 없음
                    </div>
                  ) : (
                    results.map((u) => (
                      <button
                        key={u.id}
                        type="button"
                        onClick={() =>
                          doAdd({
                            principalType: 'user',
                            principalRef: String(u.id),
                            level,
                          })
                        }
                        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-sm hover:bg-muted/50 border-b last:border-b-0"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="truncate font-medium">{u.name}</div>
                          <div className="text-[11px] text-muted-foreground truncate">
                            {u.email}
                          </div>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          )}

          {tab === 'all_org' && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                사내 모든 인증 사용자에게 읽기 전용으로 공개합니다.
              </span>
              <Button size="sm" onClick={() => doAdd({ principalType: 'all_org' })}>
                전체 공개
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
