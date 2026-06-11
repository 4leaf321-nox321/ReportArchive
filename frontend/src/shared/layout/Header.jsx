import * as React from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Search, User, Sun, Moon, Menu } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu'
import { useCommandPalette } from '@/shared/components/CommandPalette'
import { NotificationBell } from '@/shared/components/NotificationBell'
import { useTheme } from '@/shared/theme/ThemeContext'
import { useAuth } from '@/shared/auth/AuthContext'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'

export function Header({ onOpenMobileSidebar }) {
  const palette = useCommandPalette()
  const { theme, toggleTheme } = useTheme()
  const { me, logout } = useAuth()
  const { slug } = useWorkspace()
  const navigate = useNavigate()
  const [search, setSearch] = React.useState('')

  const isMac =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform)
  const shortcut = isMac ? '⌘K' : 'Ctrl K'

  // 헤더 검색창은 모달(명령 팔레트, ⌘K 로 별도 제공)을 열지 않고, 입력 후
  // Enter 로 전용 검색 페이지(/w/:slug/search)로 바로 보낸다.
  function submitSearch(e) {
    e.preventDefault()
    const q = search.trim()
    if (!slug) return
    navigate(q ? `/w/${slug}/search?q=${encodeURIComponent(q)}` : `/w/${slug}/search`)
  }

  return (
    <header
      data-app-chrome="header"
      className="flex h-14 items-center gap-2 border-b bg-background px-4"
    >
      {/* 모바일 햄버거 */}
      <Button
        variant="ghost"
        size="icon"
        className="h-9 w-9 md:hidden"
        aria-label="메뉴 열기"
        onClick={onOpenMobileSidebar}
      >
        <Menu className="h-4 w-4" />
      </Button>

      <Link to="/" className="flex items-baseline gap-1.5 tracking-tight">
        <span className="text-base font-bold">Report Archive</span>
        {/* eslint-disable-next-line no-undef */}
        <span className="text-[11px] font-medium text-muted-foreground">
          v{__APP_VERSION__}
        </span>
      </Link>

      {/* 검색창 — 입력 후 Enter 로 전용 검색 페이지로(모달 안 띄움). */}
      <form
        onSubmit={submitSearch}
        className="relative ml-2 hidden md:flex items-center max-w-md flex-1"
      >
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="보고서 검색 (제목·본문) — Enter"
          aria-label="보고서 검색"
          className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      </form>

      <div className="ml-auto flex items-center gap-1">
        {/* 모바일 검색 — 전용 검색 페이지로 이동(거기서 입력). */}
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 md:hidden"
          aria-label="검색"
          onClick={() => slug && navigate(`/w/${slug}/search`)}
        >
          <Search className="h-4 w-4" />
        </Button>

        {/* 테마 토글 */}
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9"
          aria-label={theme === 'dark' ? '라이트 모드' : '다크 모드'}
          onClick={toggleTheme}
        >
          {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>

        {/* 알림 — Phase 2D NotificationBell (실데이터 + 폴링 + 점프) */}
        <NotificationBell />

        {/* 사용자 */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-9 w-9" aria-label="계정">
              <User className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>
              <div className="text-sm">{me?.user?.name ?? 'guest'}</div>
              <div className="text-[11px] text-muted-foreground">
                {me?.user?.email ?? '인증 미연결'}
              </div>
              {me && (
                <div className="mt-1 text-[10px] text-muted-foreground">
                  {me.workspace_slug} · <span className="font-medium">{me.role}</span>
                </div>
              )}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={toggleTheme}>
              {theme === 'dark' ? '라이트 모드' : '다크 모드'}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={palette.open}>명령 팔레트 ({shortcut})</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => navigate('/profile')}>프로필</DropdownMenuItem>
            <DropdownMenuItem disabled>설정</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => logout()}>로그아웃</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

    </header>
  )
}
