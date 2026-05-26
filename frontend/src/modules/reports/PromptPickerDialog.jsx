import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, Sparkles, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Badge } from '@/shared/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import { Link } from 'react-router-dom'
import { listPrompts } from '@/shared/api/prompts'
import { PromptStatusBadge } from '@/modules/ai_settings/PromptsTab'

/**
 * Dialog for picking which AI prompt to use from the report editor. The
 * list is the user's "visible" set (official + own unofficial). Click a
 * card → onPick(row); parent then renders the body via the shared
 * promptRenderer + opens the existing AiPromptDialog.
 *
 * No edit affordance here — full management lives at /ai-settings.
 * We surface a small "관리 →" link in the footer so the path is one
 * click away when an author wants to tweak something.
 */
export function PromptPickerDialog({ open, onClose, onPick }) {
  const [query, setQuery] = useState('')
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const debounceRef = useRef(null)

  useEffect(() => {
    if (!open) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const fire = async () => {
      setLoading(true)
      try {
        const res = await listPrompts({ q: query || undefined, limit: 200 })
        setItems(res?.items ?? [])
      } catch (e) {
        toast.error('프롬프트 목록 불러오기 실패', {
          description: String(e?.message ?? e),
        })
      } finally {
        setLoading(false)
      }
    }
    debounceRef.current = setTimeout(fire, query ? 250 : 0)
    return () => debounceRef.current && clearTimeout(debounceRef.current)
  }, [open, query])

  if (!open) return null
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[80vw] max-w-[1100px] h-[80vh] max-h-[80vh] flex flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" />
            AI 프롬프트 선택
          </DialogTitle>
        </DialogHeader>

        <div className="relative shrink-0">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="이름이나 설명으로 검색..."
            className="pl-8 h-9"
            autoFocus
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto rounded-md border bg-background p-3 mt-2">
          {loading && (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              불러오는 중...
            </div>
          )}
          {!loading && items.length === 0 && (
            <div className="px-3 py-12 text-center text-sm text-muted-foreground">
              사용할 수 있는 프롬프트가 없습니다.{' '}
              <Link
                to="/ai-settings"
                className="underline hover:text-foreground"
                onClick={onClose}
              >
                AI 설정에서 추가
              </Link>{' '}
              해 보세요.
            </div>
          )}
          {!loading && items.length > 0 && (
            <div
              className="grid gap-2"
              style={{
                gridTemplateColumns:
                  'repeat(auto-fill, minmax(20rem, 1fr))',
              }}
            >
              {items.map((p) => (
                <PromptPickCard
                  key={p.id}
                  prompt={p}
                  onClick={() => onPick?.(p)}
                />
              ))}
            </div>
          )}
        </div>

        <DialogFooter className="shrink-0 gap-2 sm:gap-2 border-t pt-3 mt-2">
          <Link
            to="/ai-settings"
            onClick={onClose}
            className="text-xs underline text-muted-foreground hover:text-foreground self-center"
          >
            관리 → AI 설정
          </Link>
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={onClose}>
            닫기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PromptPickCard({ prompt, onClick }) {
  const chips = useMemo(() => {
    const out = []
    if (prompt.page_context) {
      out.push({ label: '페이지 편집', kind: 'page' })
    }
    if (prompt.wildcard_all) {
      out.push({ label: '전체 위젯', kind: 'wildcard' })
    } else {
      for (const t of prompt.derived_widget_types ?? []) {
        out.push({ label: t, kind: 'widget' })
      }
    }
    return out
  }, [
    prompt.derived_widget_types,
    prompt.wildcard_all,
    prompt.page_context,
  ])

  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col items-start gap-2 rounded-md border bg-card p-3 text-left transition-colors hover:bg-accent"
    >
      <div className="flex w-full items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-medium">{prompt.name}</span>
            <PromptStatusBadge status={prompt.status} />
          </div>
          {prompt.description && (
            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
              {prompt.description}
            </p>
          )}
        </div>
      </div>
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {chips.slice(0, 10).map((c) => (
            <Badge
              key={c.label}
              variant={
                c.kind === 'wildcard' || c.kind === 'page'
                  ? 'default'
                  : 'secondary'
              }
              className={
                'h-4 px-1.5 text-[10px] font-normal' +
                (c.kind === 'page'
                  ? ' bg-violet-600 hover:bg-violet-600/90'
                  : '')
              }
            >
              {c.label}
            </Badge>
          ))}
          {chips.length > 10 && (
            <span className="text-[10px] text-muted-foreground">
              +{chips.length - 10}
            </span>
          )}
        </div>
      )}
    </button>
  )
}
