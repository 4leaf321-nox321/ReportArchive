import * as React from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { Header } from './Header'
import { Sidebar, MobileSidebar } from './Sidebar'
import { MentionReturnBar } from './MentionReturnBar'
import { ErrorBoundary } from '@/shared/components/ErrorBoundary'

/**
 * Top-level layout: header on top, sidebar on the left, page content fills the rest.
 *
 * - Desktop (md+): Sidebar always visible.
 * - Mobile: Sidebar lives inside MobileSidebar (Sheet) toggled from the header hamburger.
 *
 * Each route's content is wrapped in an ErrorBoundary so a crash on one
 * page doesn't take down the shell. The boundary resets when the URL changes.
 */
export function AppShell() {
  const [mobileOpen, setMobileOpen] = React.useState(false)
  const location = useLocation()

  return (
    <div className="flex h-full flex-col">
      <Header onOpenMobileSidebar={() => setMobileOpen(true)} />
      <div className="flex flex-1 min-h-0">
        <Sidebar />
        <MobileSidebar open={mobileOpen} onOpenChange={setMobileOpen} />
        <main className="flex-1 min-w-0 overflow-y-auto bg-muted/30">
          <MentionReturnBar />
          <ErrorBoundary resetKey={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  )
}
