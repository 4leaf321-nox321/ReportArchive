import { Breadcrumb } from './Breadcrumb'
import { cn } from '@/shared/lib/utils'

/**
 * Standard page header — title + description + optional breadcrumb + right-side actions.
 * Use as the first child of every top-level page so layout/spacing stays consistent.
 *
 *   <PageHeader
 *     title="보고서"
 *     description="개발본부 보고서"
 *     breadcrumbs={[{ label: '개발본부', to: '/w/dev' }, { label: '보고서' }]}
 *     actions={<Button>신규 작성</Button>}
 *   />
 */
export function PageHeader({ title, description, breadcrumbs, actions, className }) {
  return (
    <div className={cn('space-y-2', className)}>
      {breadcrumbs?.length > 0 && <Breadcrumb items={breadcrumbs} />}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </div>
    </div>
  )
}
