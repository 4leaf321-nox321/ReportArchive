import { Hash } from 'lucide-react'
import { cn } from '@/shared/lib/utils'

const KIND_STYLES = {
  project: 'bg-blue-50 text-blue-700 border-blue-200',
  person: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  tech: 'bg-violet-50 text-violet-700 border-violet-200',
  tag: 'bg-slate-50 text-slate-700 border-slate-200',
}

const KIND_PREFIX = {
  project: '#',
  person: '@',
  tech: '⚙',
  tag: '#',
}

export function EntityChip({ kind = 'tag', name, onClick, className }) {
  const Tag = onClick ? 'button' : 'span'
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium transition-colors',
        KIND_STYLES[kind] ?? KIND_STYLES.tag,
        onClick && 'hover:opacity-80 cursor-pointer',
        className
      )}
    >
      <span className="font-mono opacity-70">{KIND_PREFIX[kind] ?? <Hash className="h-3 w-3" />}</span>
      <span>{name}</span>
    </Tag>
  )
}
