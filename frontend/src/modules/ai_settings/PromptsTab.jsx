import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Plus,
  Search,
  ShieldCheck,
  ShieldQuestion,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Badge } from '@/shared/components/ui/badge'
import { useAuth } from '@/shared/auth/AuthContext'
import { listAllPrompts, listPrompts } from '@/shared/api/prompts'
import { PromptEditDialog } from './PromptEditDialog'

/**
 * Prompts management tab. Lists every prompt the user can see (officials
 * + own unofficial for normal users; everything for admins) as a grid of
 * cards. Click a card to open the edit dialog — non-editable rows render
 * as read-only inside the same dialog so the user can still see the body
 * and promote/demote (admin) or copy the body (Phase 3.2).
 *
 * Search box drives a server-side substring filter (q param). Debounced
 * 250ms so live typing doesn't hammer the API.
 */
export function PromptsTab() {
  const { me } = useAuth()
  // Prompt master catalog (promote/demote, manage others' prompts) is
  // a system-operator task. Backend gates on is_system_admin; mirror.
  // Any member can still create their own unofficial prompt.
  const isAdmin = me?.is_system_admin === true

  const [query, setQuery] = useState('')
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  // `editing` is one of:
  //   null            — dialog closed
  //   'new'           — create-mode dialog
  //   { ...promptRow} — edit-mode dialog
  const [editing, setEditing] = useState(null)
  const debounceRef = useRef(null)
  // Refresh trigger — bumped after any mutation so the dialog can ask
  // the list to reload without holding a direct reference to fetchList.
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const fire = async () => {
      setLoading(true)
      try {
        // Admin uses /all so they see every user's unofficial entries;
        // non-admins only see official + own (server-enforced).
        const res = isAdmin
          ? await listAllPrompts({ q: query || undefined, limit: 500 })
          : await listPrompts({ q: query || undefined, limit: 200 })
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
  }, [query, isAdmin, refreshKey])

  function reload() {
    setRefreshKey((k) => k + 1)
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="이름이나 설명으로 검색..."
            className="pl-8 h-9"
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
        <Button size="sm" onClick={() => setEditing('new')}>
          <Plus className="mr-1 h-3.5 w-3.5" />새 프롬프트
        </Button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto rounded-md border bg-background p-3">
        {loading && (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            불러오는 중...
          </div>
        )}
        {!loading && items.length === 0 && (
          <div className="px-3 py-12 text-center text-sm text-muted-foreground">
            {query
              ? '검색 조건에 맞는 프롬프트가 없습니다.'
              : '등록된 프롬프트가 없습니다. "새 프롬프트"로 추가해 보세요.'}
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
              <PromptCard
                key={p.id}
                prompt={p}
                onClick={() => setEditing(p)}
              />
            ))}
          </div>
        )}
      </div>

      {editing != null && (
        <PromptEditDialog
          mode={editing === 'new' ? 'create' : 'edit'}
          prompt={editing === 'new' ? null : editing}
          isAdmin={isAdmin}
          currentUserId={me?.id}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            reload()
          }}
          onDeleted={() => {
            setEditing(null)
            reload()
          }}
        />
      )}
    </div>
  )
}

/** Single prompt card in the grid. Click → open edit dialog. The chips
 *  row uses derived_widget_types / wildcard_all from the server response
 *  so we don't re-parse the body here. */
function PromptCard({ prompt, onClick }) {
  const chips = useMemo(() => {
    if (prompt.wildcard_all) return [{ label: '전체 위젯', wildcard: true }]
    return (prompt.derived_widget_types ?? []).map((t) => ({
      label: t,
      wildcard: false,
    }))
  }, [prompt.derived_widget_types, prompt.wildcard_all])

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
          {chips.slice(0, 8).map((c) => (
            <Badge
              key={c.label}
              variant={c.wildcard ? 'default' : 'secondary'}
              className="h-4 px-1.5 text-[10px] font-normal"
            >
              {c.label}
            </Badge>
          ))}
          {chips.length > 8 && (
            <span className="text-[10px] text-muted-foreground">
              +{chips.length - 8}
            </span>
          )}
        </div>
      )}
      <div className="mt-auto flex w-full items-center justify-between text-[10px] text-muted-foreground">
        <span>
          {prompt.created_by?.name ? `by ${prompt.created_by.name}` : '시스템 시드'}
        </span>
        <span>#{prompt.id}</span>
      </div>
    </button>
  )
}

function PromptStatusBadge({ status }) {
  if (status === 'official') {
    return (
      <Badge
        variant="secondary"
        className="h-4 gap-0.5 px-1.5 text-[10px] font-normal"
        title="공식 — 모든 사용자에게 노출됩니다"
      >
        <ShieldCheck className="h-2.5 w-2.5" />
        공식
      </Badge>
    )
  }
  return (
    <Badge
      variant="outline"
      className="h-4 gap-0.5 px-1.5 text-[10px] font-normal"
      title="비공식 — 작성자 본인과 관리자만 볼 수 있습니다"
    >
      <ShieldQuestion className="h-2.5 w-2.5" />
      비공식
    </Badge>
  )
}

export { PromptStatusBadge }
