import { Maximize2, Minimize2 } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { usePersistedState } from '@/shared/hooks/usePersistedState'

/**
 * Shared "narrow / wide" preference for detail pages. The same localStorage
 * key drives both ReportDetailPage and CompositeDetailPage so the user
 * picks once and the choice follows them across navigations.
 *
 *   'wide'   — page content fills the available area (legacy report look)
 *   'narrow' — content is capped at ~64rem for easier reading on big monitors
 */
export function usePageWidth() {
  return usePersistedState('ra:page-width:v1', 'wide')
}

export function PageWidthToggle({ value, onChange }) {
  const isWide = value === 'wide'
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() => onChange(isWide ? 'narrow' : 'wide')}
      aria-label={isWide ? '좁게 보기' : '넓게 보기'}
      title={isWide ? '좁게 보기' : '넓게 보기'}
    >
      {isWide ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
    </Button>
  )
}
