import * as React from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Search, Bell, User, Sun, Moon, Menu } from 'lucide-react'
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
import { NotificationDrawer } from '@/shared/components/NotificationDrawer'
import { useTheme } from '@/shared/theme/ThemeContext'
import { useAuth } from '@/shared/auth/AuthContext'

export function Header({ onOpenMobileSidebar }) {
  const palette = useCommandPalette()
  const { theme, toggleTheme } = useTheme()
  const { me, logout } = useAuth()
  const navigate = useNavigate()
  const [notifOpen, setNotifOpen] = React.useState(false)

  const isMac =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform)
  const shortcut = isMac ? '⌘K' : 'Ctrl K'

  return (
    <header className="flex h-14 items-center gap-2 border-b bg-background px-4">
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

      <Link to="/" className="text-base font-bold tracking-tight">
        Report Archive
      </Link>

      {/* 검색 트리거 — 클릭 시 명령 팔레트 */}
      <button
        type="button"
        onClick={palette.open}
        className="relative ml-2 hidden md:flex items-center gap-2 max-w-md flex-1 h-9 rounded-md border border-input bg-background px-3 text-sm text-muted-foreground hover:bg-muted/50 transition-colors"
      >
        <Search className="h-4 w-4 shrink-0" />
        <span className="flex-1 text-left truncate">보고서 / 엔티티 검색...</span>
        <kbd className="hidden sm:inline-flex h-5 items-center rounded border bg-muted px-1.5 font-mono text-[10px] text-muted-foreground">
          {shortcut}
        </kbd>
      </button>

      <div className="ml-auto flex items-center gap-1">
        {/* 모바일 검색 트리거 */}
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 md:hidden"
          aria-label="검색"
          onClick={palette.open}
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

        {/* 알림 */}
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9"
          aria-label="알림"
          onClick={() => setNotifOpen(true)}
        >
          <Bell className="h-4 w-4" />
        </Button>

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

      <NotificationDrawer open={notifOpen} onOpenChange={setNotifOpen} />
    </header>
  )
}
