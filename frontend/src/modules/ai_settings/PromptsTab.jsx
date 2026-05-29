import { useEffect, useMemo, useRef, useState } from 'react'
import {
  FileText,
  LayoutTemplate,
  Plus,
  Search,
  ShieldCheck,
  ShieldQuestion,
  Sparkles,
  Wand2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Badge } from '@/shared/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import { useAuth } from '@/shared/auth/AuthContext'
import { listAllPrompts, listPrompts } from '@/shared/api/prompts'
import { DEFAULT_BUILDER_STATE } from '@/shared/ai/promptSkeletons'
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
  //   'new'           — create-mode dialog (body / builder preseeded)
  //   { ...promptRow} — edit-mode dialog
  const [editing, setEditing] = useState(null)
  // Easy-form starting state for create mode. Set by the starting-point
  // picker before flipping `editing` to 'new'. Null means user picked
  // "고급 — 빈 본문" → start on Advanced raw editor.
  const [initialBuilder, setInitialBuilder] = useState(null)
  // Starting-point picker visibility — opens before PromptEditDialog
  // in create mode so first-time authors don't see a blank canvas.
  const [startPickerOpen, setStartPickerOpen] = useState(false)
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
        <Button size="sm" onClick={() => setStartPickerOpen(true)}>
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

      {startPickerOpen && (
        <StartingPointPicker
          onPick={(builderSeed) => {
            setInitialBuilder(builderSeed)
            setStartPickerOpen(false)
            setEditing('new')
          }}
          onCancel={() => setStartPickerOpen(false)}
        />
      )}

      {editing != null && (
        <PromptEditDialog
          mode={editing === 'new' ? 'create' : 'edit'}
          prompt={editing === 'new' ? null : editing}
          initialBuilder={editing === 'new' ? initialBuilder : undefined}
          isAdmin={isAdmin}
          currentUserId={me?.id}
          onClose={() => {
            setEditing(null)
            setInitialBuilder(null)
          }}
          onSaved={() => {
            setEditing(null)
            setInitialBuilder(null)
            reload()
          }}
          onDeleted={() => {
            setEditing(null)
            setInitialBuilder(null)
            reload()
          }}
        />
      )}
    </div>
  )
}

/** Pre-create chooser. Lets the author pick a mode (Easy form skeleton)
 *  or jump to Advanced raw editor with a blank body. The Easy modes
 *  preseed the form so the dialog opens with sensible defaults — the
 *  body is then assembled from a skeleton, not copied from a seed row.
 *  This means no API round-trip and no dependency on the v1/v2 seeds
 *  still existing.
 *
 *  `onPick(builder)` — `builder` is one of:
 *    - { mode: 'new_report', purpose: '', extra_rules: [], extra_donts: [], widgets: [] }
 *    - { mode: 'fill_template', ... }
 *    - { mode: 'curated', ... }
 *    - null   → user wants Advanced/raw start, no form scaffolding
 */
function StartingPointPicker({ onPick, onCancel }) {
  const options = [
    {
      key: 'new_report',
      title: '새 보고서 작성 (Easy)',
      desc: '템플릿이 비어 있거나 사용자 입력만 보고 처음부터 보고서를 만드는 형태. 전체 위젯 카탈로그를 AI 에게 보여주고 자유롭게 조합. 가장 일반적인 모드.',
      icon: Sparkles,
      hint: '추천: 자유로운 보고서',
    },
    {
      key: 'fill_template',
      title: '기존 템플릿 채우기 (Easy)',
      desc: '현재 페이지에 이미 배치된 블록 id 들을 박아 넣고, 사용자 입력을 그 블록 content 에 채워 넣게 합니다. 사전 양식에 데이터를 붓는 데 적합.',
      icon: LayoutTemplate,
      hint: '추천: 정해진 양식 채우기',
    },
    {
      key: 'curated',
      title: '위젯 큐레이션 (Easy)',
      desc: '특정 위젯들만 허용하는 잠금형 프롬프트. 사용자가 다이얼로그에서 위젯을 늘릴 수는 없습니다. 양식이 굳은 반복 보고서에 적합.',
      icon: Wand2,
      hint: '고급 — 위젯 잠금',
    },
    {
      key: 'advanced_blank',
      title: '고급 — 빈 본문에서 시작',
      desc: '본문 textarea 가 빈 상태로 시작. 토큰 vocab 과 출력 골격을 직접 작성합니다. Easy 폼을 거치지 않고 곧장 raw 편집기.',
      icon: FileText,
      hint: '직접 본문 설계',
    },
  ]

  function handlePick(key) {
    if (key === 'advanced_blank') {
      onPick(null) // null → PromptEditDialog opens on Advanced with empty body
      return
    }
    onPick({ ...DEFAULT_BUILDER_STATE, mode: key })
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="h-4 w-4" />
            새 프롬프트 — 시작점 선택
          </DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          Easy 폼은 4~5개 필드만 채우면 본문이 자동으로 조립됩니다. 처음 만든다면 Easy 로 시작하는 것을 추천. 본문 설계를 직접 하고 싶다면 “고급 — 빈 본문” 으로.
        </p>
        <div className="grid gap-2 mt-1">
          {options.map((opt) => {
            const Icon = opt.icon
            return (
              <button
                key={opt.key}
                type="button"
                onClick={() => handlePick(opt.key)}
                className="flex items-start gap-3 rounded-md border bg-card p-3 text-left transition-colors hover:bg-accent"
              >
                <Icon className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{opt.title}</span>
                    <Badge variant="outline" className="h-4 px-1.5 text-[10px] font-normal">
                      {opt.hint}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
                    {opt.desc}
                  </p>
                </div>
              </button>
            )
          })}
        </div>
        <div className="flex justify-end pt-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            취소
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Single prompt card in the grid. Click → open edit dialog. The chips
 *  row uses derived_widget_types / wildcard_all from the server response
 *  so we don't re-parse the body here. */
function PromptCard({ prompt, onClick }) {
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
          {chips.slice(0, 8).map((c) => (
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
