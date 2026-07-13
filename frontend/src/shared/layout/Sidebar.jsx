import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard,
  FileText,
  FileCode2,
  Layers,
  Network,
  Boxes,
  Settings,
  Home,
  Users,
  UserCog,
  UserSearch,
  HardDrive,
  MessageSquare,
  Sparkles,
  Tags,
  User,
  Bell,
  Siren,
  Inbox,
  FileQuestion,
} from 'lucide-react'
import * as React from 'react'
import { getUnreadCount } from '@/shared/api/notifications'
import { listCommentsInbox } from '@/shared/api/comments'
import { subscribeBadgesChanged } from '@/shared/lib/badgesEvents'
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
  { to: 'report-graph', label: '관계도', icon: Network },
  { to: 'composites', label: '종합보고', icon: Layers },
  { to: 'dashboard', label: '대시보드', icon: LayoutDashboard },
]

/** Sidebar menu items share one shape:
 *   - absolute:        { to: '/templates', ... }
 *   - workspace-scoped:{ resolve: (slug) => `/w/${slug}/members`, ... }
 *   - user-scoped:     { resolveUser: (userId) => `/w/personal-${userId}`, ... }
 *
 * Two visibility gates:
 *   - `requireWorkspaceAdmin` — current workspace's admin/manager
 *     (i.e. 부서 관리자). Used for member management of this workspace.
 *   - `requireSystemAdmin` — User.is_system_admin only. Used for
 *     org-wide settings (workspace tree, entity master, server).
 */

/** 내 활동 — 본인 중심 페이지들. 부서 컨텍스트와 무관하게 동작.
 *  사이드바에서 부서 메뉴와 공통(시스템 도구) 사이에 끼어 들어가는
 *  중간 그룹. 4B(내 공간 enrich) · 4C(mount 현황) · 4D(받은 코멘트)
 *  진입점이 모두 여기로 모임. */
const MY_ACTIVITY_MENU = [
  // 내 공간 — dedicated route. Click no longer switches the org
  // workspace context; it just opens the personal reports view while
  // the sidebar's 부서 메뉴 keeps pointing at the user's current org.
  // 게시 관리(기간/게시판 필터, bulk unmount)도 여기 합쳐져 있음 —
  // 별도 "내 게시 현황" 페이지는 4B 와 거의 복제판이라 폐기.
  { to: '/personal/reports', label: '내 공간', icon: User },
  // 받은 코멘트 inbox (Phase 4D). Badge counts open threads on the
  // user's reports — poll on the same 30s cadence as the alarm bell.
  {
    to: '/personal/inbox',
    label: '받은 코멘트',
    icon: Inbox,
    badgeKey: 'inboxOpen',
  },
  { to: '/notifications', label: '알림', icon: Bell, badgeKey: 'unread' },
]

/** 공통 — 누구나 접근 가능한 글로벌 자원들. 본인 활동도 부서 데이터도
 *  아닌, 워크스페이스에 걸쳐 살아 있는 도구들. 템플릿 관리·AI 설정은
 *  나중에 관리/비관리 기능 분리가 들어가면 한쪽 절반은 관리자 섹션으로
 *  내려갈 후보. */
const PUBLIC_MENU = [
  { to: '/entities', label: '기준정보 탐색', icon: Boxes },
  { to: '/templates', label: '템플릿 관리', icon: FileCode2 },
  { to: '/voc', label: 'VOC', icon: MessageSquare },
  { to: '/ai-settings', label: 'AI 설정', icon: Sparkles },
]

/** 관리자 — 부서 관리자(workspace admin) 또는 시스템 관리자만 접근 가능한
 *  항목들. 일반 사용자에게는 섹션 자체가 숨겨지므로 의미 없는 메뉴 헤더가
 *  남지 않음. 개별 항목은 여전히 requireWorkspaceAdmin/requireSystemAdmin
 *  로 세분화되어 부서 관리자는 부서 멤버만 보이고 시스템 관리자는 나머지
 *  3개까지 보임. */
const ADMIN_MENU = [
  // '계정 관리' 는 가입자 계정 자체의 lifecycle (생성·활성/비활성·시스템
  // 관리자 권한). 어느 계정이 어느 부서에 들어가는지는 그 아래 '부서
  // 멤버' 에서 결정 — 두 책임을 분리해서 컨텍스트가 섞이지 않게.
  { to: '/admin/accounts', label: '계정 관리', icon: UserCog, requireSystemAdmin: true },
  // '가입자 공간' — 다른 가입자의 personal-{id} 워크스페이스를 '내 공간'
  // 과 같은 GUI 로 들여다보는 시스템 관리자 전용 도구.
  { to: '/admin/user-spaces', label: '가입자 공간', icon: UserSearch, requireSystemAdmin: true },
  {
    resolve: (slug) => `/w/${slug}/members`,
    label: '부서 멤버',
    icon: Users,
    requireWorkspaceAdmin: true,
  },
  { to: '/admin', label: '시스템 관리', icon: Settings, requireSystemAdmin: true },
  { to: '/admin/entities', label: '엔티티 관리', icon: Tags, requireSystemAdmin: true },
  { to: '/admin/connectors', label: '외부 시스템 연계', icon: Network, requireSystemAdmin: true },
  { to: '/admin/alerts', label: '경보', icon: Siren, requireSystemAdmin: true },
  // '대시보드 지표'(콘텐츠 수치, TemplateMetric)는 메타데이터 통계로 방향을
  // 틀면서 휴면 — 라우트/페이지/API 는 남겨두되 메뉴에서만 숨긴다(추후 재검토).
  // { to: '/admin/dashboard-metrics', label: '대시보드 지표', icon: Gauge, requireSystemAdmin: true },
  { to: '/admin/orphan-files', label: '오펀 파일 정리', icon: FileQuestion, requireSystemAdmin: true },
  { to: '/server', label: '서버', icon: HardDrive, requireSystemAdmin: true },
]

/**
 * Desktop sidebar — visible at md+. `collapsed` 이면 폭을 0 으로 접어 본문이
 * 전체 폭을 쓰게 한다(헤더의 토글 버튼으로 여닫음, 상태는 AppShell 이 보관).
 * 접혀도 SidebarBody 는 마운트된 채라 안읽음/코멘트 폴러가 계속 돈다 —
 * overflow-hidden 으로 내용만 가린다. 모바일은 MobileSidebar(Sheet) 로 별도.
 */
export function Sidebar({ collapsed = false }) {
  return (
    <aside
      data-app-chrome="sidebar"
      data-collapsed={collapsed ? 'true' : 'false'}
      aria-hidden={collapsed}
      className={cn(
        'hidden md:flex h-full shrink-0 flex-col bg-card overflow-hidden',
        'transition-[width] duration-200 ease-in-out',
        collapsed ? 'w-0 border-r-0' : 'w-60 border-r'
      )}
    >
      {/* 고정폭 내부 래퍼 — aside 가 w-0 으로 줄어도 내용이 찌그러지지 않고
          그대로 잘려 깔끔하게 슬라이드되도록(폭은 바깥 overflow-hidden 이 클립). */}
      <div className="flex h-full w-60 flex-col">
        <SidebarBody />
      </div>
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
  // 부서 메뉴 links always target the sticky org workspace (`orgSlug`),
  // never the effective slug — visiting /personal/reports shouldn't
  // pivot the sidebar onto the user's personal space.
  const { orgSlug, getAncestors } = useWorkspace()
  const slug = orgSlug
  const { me } = useAuth()
  // 부서 메뉴/관리자 가시성은 "현재 페이지"가 아니라 사용자가 *조직*에서
  // 매니저인지로 판정해야 한다.
  //
  // `me.role` 은 현재 요청 워크스페이스 기준이라 신뢰할 수 없다:
  // ensure_personal_workspace 가 모든 사용자에게 자기 personal-{id} 워크스페이스
  // 의 manager 역할을 부여하므로, URL 이 /personal/*(내 활동) 이면 effective
  // 워크스페이스가 personal 이 되어 부서 권한이 없는 사람도 me.role==='manager'
  // 가 된다. 과거엔 이를 `!isPersonalPage` 로 막았는데, 그러면 *진짜 부서
  // 매니저*도 내 활동 화면에선 부서 메뉴가 통째로 사라지는 버그가 있었다.
  //
  // 대신 memberships 에서 개인 워크스페이스를 뺀 매니저 역할만 보고, orgSlug
  // 자신 또는 그 조상에 매니저면 부서 관리자로 본다(매니저 권한은 트리 위→아래
  // 상속). 현재 페이지가 개인이든 조직이든 일관되게 동작한다.
  const managerSlugs = React.useMemo(
    () =>
      new Set(
        (me?.memberships ?? [])
          .filter(
            (m) =>
              m.role === 'manager' &&
              !String(m.workspace_slug).startsWith('personal-'),
          )
          .map((m) => m.workspace_slug),
      ),
    [me],
  )
  const isWorkspaceAdmin =
    !!orgSlug &&
    (managerSlugs.has(orgSlug) ||
      getAncestors(orgSlug).some((a) => managerSlugs.has(a.slug)))
  const isSystemAdmin = me?.is_system_admin === true
  const userId = me?.user?.id
  // Sidebar holds its own unread poller (parallel to the bell). Same
  // 30s cadence; the call is cheap. Putting it here avoids relying on
  // the bell being mounted on every page.
  const [unread, setUnread] = React.useState(0)
  const [inboxOpen, setInboxOpen] = React.useState(0)
  React.useEffect(() => {
    if (!userId) return
    let cancelled = false
    async function tick() {
      // Run both polls in parallel — same 30s cadence, both are
      // cheap COUNT queries on the backend. allSettled so a transient
      // failure of one doesn't kill the other's update.
      const [n, inbox] = await Promise.allSettled([
        getUnreadCount(),
        // limit=1 is the smallest payload that still returns open_count;
        // we only need the counter here, not the items.
        listCommentsInbox({ status: 'open', limit: 1 }),
      ])
      if (cancelled) return
      if (n.status === 'fulfilled') setUnread(n.value)
      if (inbox.status === 'fulfilled') setInboxOpen(inbox.value.openCount)
    }
    tick()
    const id = setInterval(tick, 30_000)
    // 알림/코멘트 mutation 직후 즉시 재폴링 — 새로고침 없이도 사이드바
    // 배지가 사라지게.
    const unsubscribe = subscribeBadgesChanged(() => {
      if (!cancelled) tick()
    })
    return () => {
      cancelled = true
      clearInterval(id)
      unsubscribe()
    }
  }, [userId])
  const badges = { unread, inboxOpen }

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

        <SidebarDivider />
        <SectionLabel>내 활동</SectionLabel>
        {renderMenuItems(MY_ACTIVITY_MENU, {
          slug,
          userId,
          isWorkspaceAdmin,
          isSystemAdmin,
          badges,
          onNavigate,
        })}

        <SidebarDivider />
        <SectionLabel>공통</SectionLabel>
        {renderMenuItems(PUBLIC_MENU, {
          slug,
          userId,
          isWorkspaceAdmin,
          isSystemAdmin,
          badges,
          onNavigate,
        })}

        {/* 관리자 섹션 — 부서/시스템 관리자 권한이 하나라도 있는 사람에게만
            노출. 일반 사용자에게는 헤더까지 통째로 숨겨서 빈 영역이 남지
            않게 한다. 내부 항목은 여전히 require* 로 더 세분화된다. */}
        {(isWorkspaceAdmin || isSystemAdmin) && (
          <>
            <SidebarDivider />
            <SectionLabel>관리자</SectionLabel>
            {renderMenuItems(ADMIN_MENU, {
              slug,
              userId,
              isWorkspaceAdmin,
              isSystemAdmin,
              badges,
              onNavigate,
            })}
          </>
        )}
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

/** Thin horizontal rule between sidebar sections — kept as its own
 *  component so the spacing stays consistent across all dividers and a
 *  later restyle (e.g. dotted line, indent) only touches one place. */
function SidebarDivider() {
  return (
    <div className="py-2">
      <Separator />
    </div>
  )
}

/** Render a list of menu items with the standard visibility filters +
 *  URL/badge resolution. Shared between every menu section so adding a
 *  new section is just `<SectionLabel>...</SectionLabel> {renderMenuItems(...)}`. */
function renderMenuItems(
  items,
  { slug, userId, isWorkspaceAdmin, isSystemAdmin, badges, onNavigate },
) {
  return items
    .filter((item) => !item.requireWorkspaceAdmin || isWorkspaceAdmin)
    .filter((item) => !item.requireSystemAdmin || isSystemAdmin)
    .filter((item) => !item.resolveUser || userId)
    .map((item) => {
      const to =
        item.to ??
        (item.resolveUser ? item.resolveUser(userId) : item.resolve(slug))
      const badgeValue = item.badgeKey ? badges[item.badgeKey] : 0
      return (
        <SidebarLink
          key={to}
          to={to}
          icon={item.icon}
          onNavigate={onNavigate}
          badge={badgeValue}
        >
          {item.label}
        </SidebarLink>
      )
    })
}

function SidebarLink({ to, icon: Icon, end, onNavigate, badge, children }) {
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
      <Icon className="h-4 w-4 shrink-0" />
      <span className="flex-1 truncate">{children}</span>
      {badge > 0 && (
        <span className="min-w-[18px] h-[18px] px-1.5 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </NavLink>
  )
}
