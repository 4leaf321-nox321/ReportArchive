import {
  createBrowserRouter,
  createRoutesFromElements,
  Navigate,
  Outlet,
  Route,
  RouterProvider,
} from 'react-router-dom'
import { AppShell } from '@/shared/layout/AppShell'
import { WorkspaceProvider } from '@/shared/workspace/WorkspaceContext'
import { AuthProvider, useAuth } from '@/shared/auth/AuthContext'
import { ProtectedRoute } from '@/shared/auth/ProtectedRoute'
import { ThemeProvider } from '@/shared/theme/ThemeContext'
import { CommandPaletteProvider } from '@/shared/components/CommandPalette'
import { ReportTabsProvider } from '@/shared/reports/ReportTabsContext'
import { WidgetClipboardProvider } from '@/shared/reports/WidgetClipboardContext'
import { NotFoundPage } from '@/shared/components/NotFoundPage'
import { Toaster } from '@/shared/components/ui/toaster'
import { DEFAULT_WORKSPACE } from '@/shared/workspace/workspaces'

import LoginPage from '@/modules/auth/LoginPage'
import SignupPage from '@/modules/auth/SignupPage'
import ForgotPasswordPage from '@/modules/auth/ForgotPasswordPage'
import ForcePasswordChangePage from '@/modules/auth/ForcePasswordChangePage'
import ProfilePage from '@/modules/profile/ProfilePage'
import WorkspaceHomePage from '@/modules/workspace/WorkspaceHomePage'
import ReportsListPage from '@/modules/reports/ReportsListPage'
import ReportNewPage from '@/modules/reports/ReportNewPage'
import ReportDetailPage from '@/modules/reports/ReportDetailPage'
import ReportGraphPage from '@/modules/reports/ReportGraphPage'
import SearchPage from '@/modules/reports/SearchPage'
import DashboardPage from '@/modules/dashboard/DashboardPage'
import TemplatesPage from '@/modules/templates/TemplatesPage'
import TemplateEditorPage from '@/modules/templates/TemplateEditorPage'
import CompositesListPage from '@/modules/composites/CompositesListPage'
import CompositeDetailPage from '@/modules/composites/CompositeDetailPage'
import AdminPage from '@/modules/admin/AdminPage'
import AccountsAdminPage from '@/modules/admin/AccountsAdminPage'
import UserSpaceAdminPage from '@/modules/admin/UserSpaceAdminPage'
import ServerPage from '@/modules/admin/ServerPage'
import OrphanFilesAdminPage from '@/modules/admin/OrphanFilesAdminPage'
import DashboardMetricsAdminPage from '@/modules/admin/DashboardMetricsAdminPage'
import EntitiesAdminPage from '@/modules/entities/EntitiesAdminPage'
import VocListPage from '@/modules/voc/VocListPage'
import VocDetailPage from '@/modules/voc/VocDetailPage'
import AiSettingsPage from '@/modules/ai_settings/AiSettingsPage'
import MembersPage from '@/modules/members/MembersPage'
import NotificationsPage from '@/modules/notifications/NotificationsPage'
import InboxPage from '@/modules/inbox/InboxPage'

/**
 * Layout route that wraps the entire authenticated portion of the app.
 * The order of providers matters:
 *   ProtectedRoute  → guarantees `me` is loaded before children render
 *   WorkspaceProvider → can safely fetch /api/workspaces (token + me ready)
 *   CommandPaletteProvider → uses workspace context
 */
function AuthedShell() {
  return (
    <ProtectedRoute>
      <WorkspaceProvider>
        <CommandPaletteProvider>
          <ReportTabsProvider>
            <WidgetClipboardProvider>
              <AppShell />
            </WidgetClipboardProvider>
          </ReportTabsProvider>
        </CommandPaletteProvider>
      </WorkspaceProvider>
    </ProtectedRoute>
  )
}

/**
 * `/` redirect — sends the user to their primary workspace based on
 * `me.memberships`. Falls back to the bootstrap default if (somehow) the
 * user has no memberships at all.
 *
 * `me` is guaranteed loaded here since this is rendered inside ProtectedRoute,
 * which won't render children until `/api/me` resolves.
 */
function RootRedirect() {
  const { me } = useAuth()
  const slug = me?.memberships?.[0]?.workspace_slug ?? DEFAULT_WORKSPACE
  return <Navigate to={`/w/${slug}`} replace />
}

/**
 * Root layout — wraps everything in AuthProvider so child routes can use
 * useAuth. Lives inside the router (not above it) because AuthProvider
 * itself calls useNavigate, which requires the router context. Toaster
 * is rendered here too so toasts persist across route changes.
 */
function RootLayout() {
  return (
    <AuthProvider>
      <Outlet />
      <Toaster />
    </AuthProvider>
  )
}

// Data router — required for useBlocker (the unsaved-changes nav guard
// in ReportDetailPage). createRoutesFromElements lets us keep the same
// JSX route definitions, so the migration from <BrowserRouter> + <Routes>
// is mostly a wrapper swap.
const router = createBrowserRouter(
  createRoutesFromElements(
    <Route element={<RootLayout />}>
      {/* Public */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      {/* 인증됐지만 임시 비번 → 새 비번 강제 설정. AuthedShell 밖이라 리다이렉트
          루프가 없고, 자체적으로 me/로딩을 가드한다. */}
      <Route path="/force-password-change" element={<ForcePasswordChangePage />} />

      {/* Authenticated — AuthedShell renders <Outlet /> via AppShell */}
      <Route element={<AuthedShell />}>
        <Route path="/" element={<RootRedirect />} />

        {/* 부서 스코프 — /reports/new* 가 :reportId 보다 먼저 매치 */}
        <Route path="/w/:workspace" element={<WorkspaceHomePage />} />
        <Route path="/w/:workspace/reports" element={<ReportsListPage />} />
        <Route path="/w/:workspace/search" element={<SearchPage />} />
        <Route path="/w/:workspace/report-graph" element={<ReportGraphPage />} />
        <Route path="/w/:workspace/reports/new" element={<ReportNewPage />} />
        <Route
          path="/w/:workspace/reports/new/:templateId/:version"
          element={<ReportDetailPage />}
        />
        <Route path="/w/:workspace/reports/:reportId" element={<ReportDetailPage />} />
        <Route path="/w/:workspace/dashboard" element={<DashboardPage />} />
        <Route path="/w/:workspace/composites" element={<CompositesListPage />} />
        <Route path="/w/:workspace/composites/:compositeId" element={<CompositeDetailPage />} />
        <Route path="/w/:workspace/members" element={<MembersPage />} />

        {/* 공통 (부서 횡단) */}
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/notifications" element={<NotificationsPage />} />
        {/* 내 공간 — dedicated route. Renders the standard reports list
            against the user's personal workspace (slug resolved in
            WorkspaceProvider when the URL is /personal/*). Does NOT
            touch the sticky org context, so the sidebar's 부서 메뉴
            keeps pointing at the user's current org. */}
        <Route path="/personal/reports" element={<ReportsListPage />} />
        {/* 받은 코멘트 inbox — workspace-agnostic. Lists open comment
            threads on reports the actor owns. */}
        <Route path="/personal/inbox" element={<InboxPage />} />
        <Route path="/templates" element={<TemplatesPage />} />
        <Route path="/templates/new" element={<TemplateEditorPage />} />
        <Route path="/templates/:templateId/edit" element={<TemplateEditorPage />} />
        <Route path="/voc" element={<VocListPage />} />
        <Route path="/voc/:postId" element={<VocDetailPage />} />
        <Route path="/ai-settings" element={<AiSettingsPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/admin/accounts" element={<AccountsAdminPage />} />
        <Route path="/admin/user-spaces" element={<UserSpaceAdminPage />} />
        <Route path="/admin/entities" element={<EntitiesAdminPage />} />
        <Route path="/admin/orphan-files" element={<OrphanFilesAdminPage />} />
        <Route path="/admin/dashboard-metrics" element={<DashboardMetricsAdminPage />} />
        <Route path="/server" element={<ServerPage />} />

        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Route>
  )
)

export default function App() {
  return (
    <ThemeProvider>
      <RouterProvider router={router} />
    </ThemeProvider>
  )
}
