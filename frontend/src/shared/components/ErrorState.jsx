import { AlertTriangle } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { cn } from '@/shared/lib/utils'

/**
 * Error variant of EmptyState. Used for failed loads, render errors, etc.
 *
 *   <ErrorState title="불러오기 실패" description={err.message} onRetry={refetch} />
 */
export function ErrorState({
  icon: Icon = AlertTriangle,
  title = '문제가 발생했습니다',
  description,
  onRetry,
  retryLabel = '다시 시도',
  action,
  className,
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-lg border border-dashed border-destructive/30 bg-destructive/5 px-6 py-16 text-center',
        className
      )}
    >
      <Icon className="mb-4 h-10 w-10 text-destructive" />
      <h3 className="text-base font-semibold text-foreground">{title}</h3>
      {description && (
        <p className="mt-1 max-w-md text-sm text-muted-foreground">{description}</p>
      )}
      {(onRetry || action) && (
        <div className="mt-4 flex gap-2">
          {onRetry && (
            <Button variant="outline" onClick={onRetry}>
              {retryLabel}
            </Button>
          )}
          {action}
        </div>
      )}
    </div>
  )
}
