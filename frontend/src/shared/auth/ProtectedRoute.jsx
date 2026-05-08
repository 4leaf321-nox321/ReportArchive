import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from './AuthContext'

/**
 * Wraps the authenticated portion of the app. If there's no resolved user,
 * redirect to /login carrying the current path so we can return after login.
 *
 * `loading` distinguishes "checking stored token" from "definitely not
 * logged in" so the user doesn't see a flash of the login page on each
 * refresh.
 */
export function ProtectedRoute({ children }) {
  const { me, loading } = useAuth()
  const location = useLocation()

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-sm text-muted-foreground">로딩 중...</div>
      </div>
    )
  }

  if (!me) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
  }

  return children
}
