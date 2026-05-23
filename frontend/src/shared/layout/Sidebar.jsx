import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard,
  FileText,
  FileCode2,
  Layers,
  Settings,
  Home,
  Users,
  HardDrive,
  MessageSquare,
  Sparkles,
  Tags,
} from 'lucide-react'
import { WorkspaceSelector } from '@/shared/components/WorkspaceSelector'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import { useAuth } from '@/shared/auth/AuthContext'
import { Separator } from '@/shared/components/ui/separator'
import { Sheet, SheetContent, SheetTitle } from '@/shared/components/ui/sheet'
import { cn } from '@/shared/lib/utils'

/** Per-workspace navigation. URLs are relative to /w/:slug. */
const WORKSPACE_MENU = [
  { to: '', label: '홈', icon: Home, end: true },
  { to: 'reports', label: '보고서', icon: FileText },
  { to: 'composites', label: '종합보고', icon: Layers },
  { to: 'dashboard', label: '대시보드', icon: LayoutDashboard },
]

/** Common section. Items can either be:
 *   - absolute: { to: '/templates', ... }
 *   - workspace-scoped: { resolve: (slug) => `/w/${slug}/members`, ... }
 *   - admin-only: add `requireAdmin: true`
 */
const GLOBAL_MENU = [
  { to: '/templates', label: '템플릿 관리', icon: FileCode2 },
  { to: '/voc', label: 'VOC', icon: MessageSquare },
  { to: '/ai-settings', label: 'AI 설정', icon: Sparkles },
  {
    resolve: (slug) => `/w/${slug}/members`,
    label: '멤버',
    icon: Users,
    requireAdmin: true,
  },
  { to: '/admin', label: '관리자', icon: Settings, requireAdmin: true },
  { to: '/admin/entities', label: '엔티티 관리', icon: Tags, requireAdmin: true },
  { to: '/server', label: '서버', icon: HardDrive, requireAdmin: true },
]

/**
 * Desktop sidebar — fixed width, always visible at md+.
 * On mobile, MobileSidebar wraps the same content in a slide-out Sheet.
 */
export function Sidebar() {
  return (
    <aside
      data-app-chrome="sidebar"
      className="hidden md:flex h-full w-60 shrink-0 flex-col border-r bg-card"
    >
      <SidebarBody />
    </aside>
  )
}

/** Mobile drawer variant — controlled from the header hamburger. */
export function MobileSidebar({ open, onOpenChange }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="p-0 w-64 flex flex-col">
        <SheetTitle className="sr-only">메뉴</SheetTitle>
        <SidebarBody onNavigate={() => onOpenChange(false)} />
      </SheetContent>
    </Sheet>
  )
}

function SidebarBody({ onNavigate }) {
  const { slug } = useWorkspace()
  const { me } = useAuth()
  const isAdmin = me?.role === 'admin'

  return (
    <>
      <div className="border-b p-3">
        <WorkspaceSelector />
      </div>

      <nav className="flex-1 overflow-y-auto p-2 space-y-1">
        <SectionLabel>부서 메뉴</SectionLabel>
        {WORKSPACE_MENU.map((item) => (
          <SidebarLink
            key={item.to}
            to={`/w/${slug}${item.to ? `/${item.to}` : ''}`}
            icon={item.icon}
            end={item.end}
            onNavigate={onNavigate}
          >
            {item.label}
          </SidebarLink>
        ))}

        <div className="py-2">
          <Separator />
        </div>

        <SectionLabel>공통</SectionLabel>
        {GLOBAL_MENU.filter((item) => !item.requireAdmin || isAdmin).map((item) => {
          const to = item.to ?? item.resolve(slug)
          return (
            <SidebarLink key={to} to={to} icon={item.icon} onNavigate={onNavigate}>
              {item.label}
            </SidebarLink>
          )
        })}
      </nav>

      <div className="border-t p-3 text-[11px] text-muted-foreground">
        Report Archive · Phase 0
      </div>
    </>
  )
}

function SectionLabel({ children }) {
  return (
    <div className="px-2 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  )
}

function SidebarLink({ to, icon: Icon, end, onNavigate, children }) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
          isActive
            ? 'bg-primary/10 text-primary font-medium'
            : 'text-foreground/80 hover:bg-muted hover:text-foreground'
        )
      }
    >
      <Icon className="h-4 w-4" />
      {children}
    </NavLink>
  )
}
