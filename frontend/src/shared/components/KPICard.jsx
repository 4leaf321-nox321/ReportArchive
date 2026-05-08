import { Card, CardContent } from '@/shared/components/ui/card'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { cn } from '@/shared/lib/utils'

/**
 * Compact metric card for dashboards/home pages.
 *
 *   <KPICard icon={Clock} label="검토 중" value={12} accent="text-amber-600" />
 *   <KPICard icon={Clock} label="검토 중" loading />
 */
export function KPICard({ icon: Icon, label, value, accent = 'text-foreground', loading, className }) {
  return (
    <Card className={className}>
      <CardContent className="flex items-center gap-4 pt-6">
        {Icon && (
          <div className="rounded-md bg-muted p-2">
            <Icon className="h-5 w-5 text-muted-foreground" />
          </div>
        )}
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground truncate">{label}</div>
          {loading ? (
            <Skeleton className="mt-1 h-7 w-12" />
          ) : (
            <div className={cn('text-2xl font-semibold', accent)}>{value}</div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
