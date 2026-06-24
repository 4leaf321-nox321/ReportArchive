import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ChevronDown, Layers, Search, Sparkles } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import { Badge } from '@/shared/components/ui/badge'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import {
  ScopeCategorySidebar,
  useScopeCategories,
} from '@/shared/components/ScopeCategories'
import { cn } from '@/shared/lib/utils'
import { WorkspaceCombobox } from '@/shared/components/WorkspaceCombobox'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import { useAuth } from '@/shared/auth/AuthContext'
import { createComposite } from '@/shared/api/composites'
import {
  listCompositePresets,
  newCompositeFromPreset,
} from '@/shared/api/compositePresets'
import { KINDS } from './constants'

/** Create dialog — pick a workspace within the current tree, kind, and
 *  (for recurring) a period date. Items are added on the detail page
 *  after creation so the user can preview the picker once they're in. */
export function NewCompositeDialog({
  open,
  onOpenChange,
  currentWorkspaceSlug,
  workspaces,
  onCreated,
}) {
  const { getDescendantsInclusive } = useWorkspace()
  const { me } = useAuth()
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState('recurring')
  const [periodDate, setPeriodDate] = useState(todayIsoDate())
  const [wsSlug, setWsSlug] = useState(currentWorkspaceSlug)
  const [submitting, setSubmitting] = useState(false)
  // 시작 양식 — '' = 빈 종합보고, 그 외 = 선택한 양식 id(문자열). 양식은
  // 요약·그룹 골격·보기설정을 미리 채워 준다(안건은 회차마다 다르므로 제외).
  const [presets, setPresets] = useState([])
  const [presetId, setPresetId] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const selectedPreset = useMemo(
    () => presets.find((p) => String(p.id) === presetId) ?? null,
    [presets, presetId],
  )

  useEffect(() => {
    if (open) {
      setTitle('')
      setKind('recurring')
      setPeriodDate(todayIsoDate())
      setWsSlug(currentWorkspaceSlug)
      setPresetId('')
    }
  }, [open, currentWorkspaceSlug])

  // 작성 picker — 모든 사용자가 모든 부서 양식으로 종합보고를 시작할 수 있어야
  // 하므로 소유 부서 무관 전체를 로드한다(scope:'all'). 분류는 useScopeCategories.
  useEffect(() => {
    if (!open) return undefined
    let cancelled = false
    listCompositePresets({ scope: 'all' })
      .then((rows) => {
        if (!cancelled) setPresets(rows ?? [])
      })
      .catch(() => {
        if (!cancelled) setPresets([])
      })
    return () => {
      cancelled = true
    }
  }, [open])

  // Restrict workspace choices to the current workspace tree (writable scope).
  const eligibleWorkspaces = (currentWorkspaceSlug
    ? getDescendantsInclusive(currentWorkspaceSlug)
    : []
  )
    .map((s) => workspaces?.find((w) => w.slug === s))
    .filter((w) => w && !w.virtual)

  async function onSubmit(e) {
    e.preventDefault()
    setSubmitting(true)
    try {
      if (presetId) {
        // 양식에서 시작 — 요약·그룹 골격·보기설정이 미리 채워진 종합보고를
        // 생성한다. seed_groups(빈 그룹 골격)는 상세 페이지가 pendingGroups
        // 로 시딩하도록 navigate state 로 넘긴다.
        const { composite, seed_groups } = await newCompositeFromPreset(
          presetId,
          {
            workspace_slug: wsSlug,
            title,
            kind,
            period_date: kind === 'recurring' ? periodDate || null : null,
          },
        )
        onCreated?.(composite.id, { seedGroups: seed_groups ?? [] })
        return
      }
      const created = await createComposite({
        workspace_slug: wsSlug,
        title,
        kind,
        period_date: kind === 'recurring' ? periodDate || null : null,
        description: '',
        items: [],
      })
      onCreated?.(created.id)
    } catch (err) {
      toast.error(err.message || '생성 실패')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>새 종합보고</DialogTitle>
          <DialogDescription>
            묶을 안건은 생성 후 상세 화면에서 추가합니다.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="comp-title">제목</Label>
            <Input
              id="comp-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="2026-W21 개발본부 종합보고"
              required
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label>타입</Label>
            <div className="inline-flex rounded-md border bg-background overflow-hidden">
              {KINDS.map((k) => (
                <button
                  key={k.value}
                  type="button"
                  onClick={() => setKind(k.value)}
                  className={
                    'px-4 py-2 text-sm transition-colors ' +
                    (kind === k.value
                      ? 'bg-primary/10 text-primary font-medium'
                      : 'text-muted-foreground hover:bg-muted')
                  }
                >
                  {k.label}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {kind === 'recurring'
                ? '정기 — 주·월 단위로 기준일을 두고 같은 주기를 묶음.'
                : '주제 — 시간과 무관하게 하나의 주제를 묶음 (기준일 없음).'}
            </p>
          </div>
          {presets.length > 0 && (
            <div className="space-y-1.5">
              <Label>시작 양식</Label>
              <Button
                type="button"
                variant="outline"
                className="h-9 w-full justify-between px-2.5 font-normal"
                onClick={() => setPickerOpen(true)}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  {selectedPreset ? (
                    <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" />
                  ) : (
                    <Layers className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate">
                    {selectedPreset ? selectedPreset.name : '빈 종합보고로 시작'}
                  </span>
                </span>
                <ChevronDown className="h-4 w-4 shrink-0 opacity-60" />
              </Button>
              <p className="text-[11px] text-muted-foreground">
                {selectedPreset
                  ? '요약·그룹 골격·보기 설정이 미리 채워집니다 (안건은 직접 추가).'
                  : '양식을 고르면 요약·그룹 골격·보기 설정이 미리 채워집니다.'}
              </p>
            </div>
          )}
          {kind === 'recurring' && (
            <div className="space-y-1.5">
              <Label htmlFor="comp-period">기준일</Label>
              <Input
                id="comp-period"
                type="date"
                value={periodDate}
                onChange={(e) => setPeriodDate(e.target.value)}
                className="font-mono"
                required
              />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="comp-ws">부서</Label>
            <WorkspaceCombobox
              id="comp-ws"
              workspaces={eligibleWorkspaces}
              value={wsSlug}
              onChange={(s) => s && setWsSlug(s)}
              placeholder="부서 선택"
              searchPlaceholder="부서 검색"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              취소
            </Button>
            <Button type="submit" disabled={submitting || !wsSlug || !title.trim()}>
              {submitting ? '생성 중...' : '생성'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    <CompositePresetPickerDialog
      open={pickerOpen}
      onOpenChange={setPickerOpen}
      presets={presets}
      selectedId={presetId}
      workspaces={workspaces}
      currentUserId={me?.user?.id}
      onSelect={(id) => {
        setPresetId(id)
        setPickerOpen(false)
      }}
    />
    </>
  )
}

/** 시작 양식 선택 전용 모달 — 화면 80% 크기의 큰 다이얼로그. 좌측 분류
 *  사이드바(전체 / 개인 / 전사 / 조직별)로 좁히고, 우측에서 카드 형태로
 *  고른다. 검색은 현재 분류 안에서 동작. "빈 종합보고"는 항상 우측 상단에.
 *  분류 기준(기존 데이터로):
 *   - 개인  : 내가 만든 양식(created_by_user_id === 나)
 *   - 전사  : owner_workspace_slugs 가 비어 있음(전사 공개)
 *   - 조직별: 특정 조직에 스코프된 양식 — 조직별로 묶어서 보여줌
 *  (한 양식이 여러 분류에 동시에 들 수 있음 — 예: 내가 만든 전사 양식). */
function CompositePresetPickerDialog({
  open,
  onOpenChange,
  presets,
  selectedId,
  workspaces,
  currentUserId,
  onSelect,
}) {
  const [query, setQuery] = useState('')
  const wsName = useMemo(() => {
    const map = new Map((workspaces ?? []).map((w) => [w.slug, w.name]))
    return (s) => map.get(s) ?? s
  }, [workspaces])
  const { cat, setCat, counts, orgGroups, filter } = useScopeCategories(presets, {
    currentUserId,
    getName: wsName,
  })
  useEffect(() => {
    if (open) {
      setQuery('')
      setCat({ type: 'all' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const byCat = (presets ?? []).filter(filter)
  const trimmed = query.trim().toLowerCase()
  const filtered = trimmed
    ? byCat.filter(
        (p) =>
          p.name.toLowerCase().includes(trimmed) ||
          (p.description || '').toLowerCase().includes(trimmed) ||
          (p.groups ?? []).some((g) => g.toLowerCase().includes(trimmed)),
      )
    : byCat

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[80vh] max-h-[80vh] w-[80vw] max-w-[80vw] flex-col">
        <DialogHeader>
          <DialogTitle>시작 양식 선택</DialogTitle>
          <DialogDescription>
            요약·그룹 골격·보기 설정이 미리 채워집니다. 안건은 생성 후 직접 추가.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="현재 분류에서 이름·설명·그룹 검색"
            className="h-9 pl-8 text-sm"
            autoFocus
          />
        </div>

        <div className="flex min-h-0 flex-1 gap-4">
          {/* ── 좌측: 분류 사이드바(공용) ── */}
          <ScopeCategorySidebar
            counts={counts}
            orgGroups={orgGroups}
            cat={cat}
            onChange={setCat}
            mineLabel="개인 (내 양식)"
            emptyOrgText="조직 양식이 없습니다."
            className="w-52 shrink-0 overflow-y-auto border-r pr-2"
          />

          {/* ── 우측: 양식 카드 그리드 ── */}
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            {/* 빈 종합보고 — 항상 맨 위, 분류·검색과 무관하게 노출. */}
            <button
              type="button"
              onClick={() => onSelect('')}
              className={cn(
                'mb-2 flex w-full items-center gap-2 rounded-md border px-3 py-2.5 text-left transition-colors hover:bg-muted/50',
                selectedId === '' && 'border-primary bg-primary/5',
              )}
            >
              <Layers className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0">
                <span className="block text-sm font-medium">빈 종합보고로 시작</span>
                <span className="block text-[11px] text-muted-foreground">
                  양식 없이 처음부터 구성합니다.
                </span>
              </span>
            </button>

            {filtered.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                {trimmed ? '검색 결과가 없습니다.' : '이 분류에 양식이 없습니다.'}
              </p>
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {filtered.map((p) => (
                  <li key={p.id}>
                    <PresetCard
                      preset={p}
                      selected={String(p.id) === selectedId}
                      wsName={wsName}
                      onClick={() => onSelect(String(p.id))}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** 우측 양식 카드 — 이름·공개범위 뱃지·설명·요약/그룹 개수. 클릭 시 선택. */
function PresetCard({ preset: p, selected, wsName, onClick }) {
  const orgSlugs = p.owner_workspace_slugs ?? []
  const isGlobal = orgSlugs.length === 0
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-full w-full items-start gap-2 rounded-md border px-3 py-2.5 text-left transition-colors hover:bg-muted/50',
        selected && 'border-primary bg-primary/5',
      )}
    >
      <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-sm font-medium">{p.name}</span>
          {isGlobal ? (
            <Badge variant="secondary" className="text-[9px]">
              전사
            </Badge>
          ) : (
            orgSlugs.map((s) => (
              <Badge key={s} variant="outline" className="text-[9px]">
                {wsName(s)}
              </Badge>
            ))
          )}
        </span>
        {p.description && (
          <span className="mt-0.5 block text-[11px] text-muted-foreground line-clamp-2">
            {p.description}
          </span>
        )}
        <span className="mt-1 block text-[10px] text-muted-foreground">
          요약 {p.summary_widget_count ?? 0}개 · 그룹 {(p.groups ?? []).length}개
          {(p.groups ?? []).length > 0 &&
            ` (${p.groups.slice(0, 4).join(', ')}${
              p.groups.length > 4 ? ' …' : ''
            })`}
        </span>
        {p.created_by_name && (
          <span className="mt-0.5 block text-[10px] text-muted-foreground">
            {p.created_by_name}
          </span>
        )}
      </span>
    </button>
  )
}

function todayIsoDate() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
