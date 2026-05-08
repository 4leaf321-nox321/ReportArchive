import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from '@/shared/layout/AppShell'
import { WorkspaceProvider } from '@/shared/workspace/WorkspaceContext'
import { AuthProvider, useAuth } from '@/shared/auth/AuthContext'
import { ProtectedRoute } from '@/shared/auth/ProtectedRoute'
import { ThemeProvider } from '@/shared/theme/ThemeContext'
import { CommandPaletteProvider } from '@/shared/components/CommandPalette'
import { NotFoundPage } from '@/shared/components/NotFoundPage'
import { Toaster } from '@/shared/components/ui/toaster'
import { DEFAULT_WORKSPACE } from '@/shared/workspace/workspaces'

import LoginPage from '@/modules/auth/LoginPage'
import SignupPage from '@/modules/auth/SignupPage'
import ProfilePage from '@/modules/profile/ProfilePage'
import WorkspaceHomePage from '@/modules/workspace/WorkspaceHomePage'
import ReportsListPage from '@/modules/reports/ReportsListPage'
import ReportNewPage from '@/modules/reports/ReportNewPage'
import ReportDetailPage from '@/modules/reports/ReportDetailPage'
import DashboardPage from '@/modules/dashboard/DashboardPage'
import TemplatesPage from '@/modules/templates/TemplatesPage'
import TemplateEditorPage from '@/modules/templates/TemplateEditorPage'
import EntitiesPage from '@/modules/entities/EntitiesPage'
import AIJobsPage from '@/modules/ai/AIJobsPage'
import AdminPage from '@/modules/admin/AdminPage'
import MembersPage from '@/modules/members/MembersPage'

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
          <AppShell />
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

export default function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            {/* Public */}
            <Route path="/login" element={<LoginPage />} />
            <Route path="/signup" element={<SignupPage />} />

            {/* Authenticated — AuthedShell renders <Outlet /> via AppShell */}
            <Route element={<AuthedShell />}>
              <Route path="/" element={<RootRedirect />} />

              {/* 부서 스코프 — /reports/new* 가 :reportId 보다 먼저 매치 */}
              <Route path="/w/:workspace" element={<WorkspaceHomePage />} />
              <Route path="/w/:workspace/reports" element={<ReportsListPage />} />
              <Route path="/w/:workspace/reports/new" element={<ReportNewPage />} />
              <Route
                path="/w/:workspace/reports/new/:templateId/:version"
                element={<ReportDetailPage />}
              />
              <Route path="/w/:workspace/reports/:reportId" element={<ReportDetailPage />} />
              <Route path="/w/:workspace/dashboard" element={<DashboardPage />} />
              <Route path="/w/:workspace/members" element={<MembersPage />} />

              {/* 공통 (부서 횡단) */}
              <Route path="/profile" element={<ProfilePage />} />
              <Route path="/templates" element={<TemplatesPage />} />
              <Route path="/templates/new" element={<TemplateEditorPage />} />
              <Route path="/templates/:templateId/edit" element={<TemplateEditorPage />} />
              <Route path="/entities" element={<EntitiesPage />} />
              <Route path="/ai-jobs" element={<AIJobsPage />} />
              <Route path="/admin" element={<AdminPage />} />

              <Route path="*" element={<NotFoundPage />} />
            </Route>
          </Routes>
        </AuthProvider>
        <Toaster />
      </BrowserRouter>
    </ThemeProvider>
  )
}
