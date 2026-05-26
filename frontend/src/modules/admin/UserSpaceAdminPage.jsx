/** 가입자 공간 (시스템 관리자) — 다른 사용자의 personal-{id} 워크스페이스를
 *  '내 공간' 과 같은 GUI 로 들여다본다. 라우트는 picker 단계 + 가입자 선택
 *  후 표준 /w/personal-{id}/reports 로 이동하는 두 단계로 나눠 두었음.
 *  picker 가 페이지의 메인 컨텐츠이므로 사용자가 "그 안에서 가입자를
 *  고를" 수 있다는 요건을 만족.
 *
 *  picker 가 가능한 이유: shared/auth.py 의 get_current_user 가 시스템
 *  관리자에 한해 부서 멤버 row 가 없어도 매니저 권한을 합성해 반환 —
 *  /w/personal-{otherUser}/reports 같은 URL 에서도 401/403 안 남.
 */
import { useState, useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowRight, Search, User as UserIcon, UserSearch } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { PageHeader } from '@/shared/components/PageHeader'
import { ErrorState } from '@/shared/components/ErrorState'
import { useAuth } from '@/shared/auth/AuthContext'
import { useAsync } from '@/shared/hooks/useAsync'
import { listAllAccounts } from '@/shared/api/me'

export default function UserSpaceAdminPage() {
  const { me } = useAuth()
  const navigate = useNavigate()
  const isSystemAdmin = me?.is_system_admin === true

  // 전체 계정을 한 번에 받아 클라이언트에서 검색. 활성 계정만 — 비활성
  // 계정의 personal 워크스페이스를 들여다보는 시나리오는 흔치 않고,
  // 필요하면 차후 토글로.
  const { data: accounts, loading, error } = useAsync(
    () =>
      isSystemAdmin
        ? listAllAccounts({ includeInactive: false })
        : Promise.resolve([]),
    [isSystemAdmin],
  )

  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const list = accounts ?? []
    const q = query.trim().toLowerCase()
    if (!q) return list
    return list.filter(
      (a) =>
        (a.name || '').toLowerCase().includes(q) ||
        (a.email || '').toLowerCase().includes(q) ||
        (a.home_workspace_name || '').toLowerCase().includes(q),
    )
  }, [accounts, query])

  if (!isSystemAdmin) {
    return (
      <div className="p-6">
        <PageHeader title="가입자 공간" description="시스템 관리자 전용" />
        <ErrorState
          title="권한 없음"
          description="가입자 공간은 시스템 관리자만 접근 가능합니다."
          action={
            <Button asChild variant="outline">
              <Link to="/">홈으로</Link>
            </Button>
          }
        />
      </div>
    )
  }

  return (
    <div className="p-6 space-y-4">
      <PageHeader
        title="가입자 공간"
        description="다른 가입자의 '내 공간' 데이터를 그대로 들여다봅니다. 가입자를 선택하면 그 사용자의 personal 워크스페이스로 이동 — 같은 GUI 로 보고서·폴더·코멘트 모두 보임."
      />

      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="이름·이메일·소속 부서로 검색"
          className="h-9 pl-7"
          autoFocus
        />
      </div>

      {error ? (
        <ErrorState description={error.message} />
      ) : loading ? (
        <Skeleton className="h-72" />
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground py-12 text-center">
          {query
            ? '검색 결과가 없습니다.'
            : '활성 계정이 없습니다.'}
        </p>
      ) : (
        <ul className="divide-y border rounded-md overflow-hidden bg-card">
          {filtered.map((a) => {
            const personalSlug = `personal-${a.id}`
            return (
              <li key={a.id}>
                <button
                  type="button"
                  onClick={() => navigate(`/w/${personalSlug}/reports`)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-muted/40 transition-colors"
                >
                  <div className="rounded-full bg-muted h-8 w-8 flex items-center justify-center text-xs font-medium shrink-0">
                    {a.name?.charAt(0) || a.email?.charAt(0) || '?'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">{a.name || '—'}</span>
                      <span className="text-[10px] text-muted-foreground font-mono">
                        #{a.id}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {a.email}
                      {a.home_workspace_name && (
                        <>
                          <span className="mx-1.5">·</span>
                          <span>{a.home_workspace_name}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {/* sidebar 의 UserSearch 아이콘과 시각적으로 호응하기 위한 작은 hint */}
      <p className="text-[11px] text-muted-foreground flex items-center gap-1 pt-2">
        <UserSearch className="h-3 w-3" />
        선택한 가입자의 공간으로 이동하면 사이드바·페이지 헤더가 그 가입자의
        personal 워크스페이스를 표시합니다. 다른 가입자로 바꾸려면 좌측
        사이드바의 '가입자 공간' 을 다시 누르세요.
      </p>
    </div>
  )
}
