import { Link } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/shared/lib/utils'

/**
 * items: [{ label, to? }, ...]
 *   to 없는 항목은 현재 위치(마지막)로 간주, 링크 아닌 텍스트.
 */
export function Breadcrumb({ items, className }) {
  if (!items?.length) return null
  return (
    <nav aria-label="breadcrumb" className={cn('flex items-center gap-1 text-xs', className)}>
      {items.map((item, i) => {
        const isLast = i === items.length - 1
        return (
          <div key={i} className="flex items-center gap-1">
            {item.to && !isLast ? (
              <Link
                to={item.to}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                {item.label}
              </Link>
            ) : (
              <span className={cn(isLast ? 'text-foreground' : 'text-muted-foreground')}>
                {item.label}
              </span>
            )}
            {!isLast && <ChevronRight className="h-3 w-3 text-muted-foreground/60" />}
          </div>
        )
      })}
    </nav>
  )
}
