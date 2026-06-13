import { Link } from 'react-router-dom'
import { useMemo } from 'react'
import {
  Activity,
  Building2,
  CheckCircle2,
  Edit3,
  FilePlus2,
  FileText,
  LayoutDashboard,
  Layers3,
  Lock,
  MessageCircle,
  Network,
  Pin,
  Plus,
  Send,
  Sparkles,
  Unlock,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/components/ui/card'
import { Button } from '@/shared/components/ui/button'
import { Badge } from '@/shared/components/ui/badge'
import { PageHeader } from '@/shared/components/PageHeader'
import { ErrorState } from '@/shared/components/ErrorState'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import { useAuth } from '@/shared/auth/AuthContext'
import { useAsync } from '@/shared/hooks/useAsync'
import { listReports } from '@/modules/reports/api'
import { listTemplates } from '@/shared/api/templates'
import { listWorkspaceActivities } from '@/shared/api/activities'
import { listWorkspacePins, removeWorkspacePin } from '@/shared/api/pins'
import { PHASE_LABEL, PHASE_VARIANT } from '@/modules/reports/constants'
import { parseUtcIso } from '@/shared/lib/period'
import { cn } from '@/shared/lib/utils'

/**
 * 활동 타입 → 아이콘·라벨·색. ActivityTimeline 의 TYPE_META 를 피드용으로
 * 추린 버전(같은 한국어 라벨 유지). 누락 타입은 기본값으로 떨어진다.
 */
const ACTIVITY_META = {
  created: { icon: Sparkles, color: 'text-blue-600', label: '생성' },
  edited: { icon: Edit3, color: 'text-muted-foreground', label: '편집' },
  comment_added: { icon: MessageCircle, color: 'text-blue-600', label: '코멘트' },
  comment_replied: { icon: MessageCircle, color: 'text-blue-600', label: '답글' },
  thread_resolved: { icon: CheckCircle2, color: 'text-green-600', label: '코멘트 해결' },
  thread_reopened: { icon: MessageCircle, color: 'text-amber-600', label: '코멘트 재오픈' },
  phase_to_reviewing: { icon: Activity, color: 'text-amber-600', label: '리뷰 단계' },
  phase_to_finalized: { icon: CheckCircle2, color: 'text-green-600', label: '발행' },
  phase_to_drafting: { icon: Activity, color: 'text-muted-foreground', label: '작성 복귀' },
  mounted: { icon: Send, color: 'text-purple-600', label: '게시' },
  unmounted: { icon: Send, color: 'text-muted-foreground', label: '게시 해제' },
  mount_folder_changed: { icon: Layers3, color: 'text-muted-foreground', label: '폴더 이동' },
  folder_changed: { icon: Layers3, color: 'text-muted-foreground', label: '폴더 이동' },
  locked: { icon: Lock, color: 'text-red-600', label: '수정 잠금' },
  unlocked: { icon: Unlock, color: 'text-green-600', label: '잠금 해제' },
  lock_force_unset: { icon: Unlock, color: 'text-muted-foreground', label: '잠금 강제 해제' },
  editor_added: { icon: Activity, color: 'text-blue-600', label: '편집자 추가' },
  editor_removed: { icon: Activity, color: 'text-muted-foreground', label: '편집자 제거' },
}

/** "방금 / N분 전 / N시간 전 / N일 전 / YYYY-MM-DD" 상대시간. */
function formatRelative(iso) {
  const d = parseUtcIso(iso)
  if (!d) return ''
  const diffMs = Date.now() - d.getTime()
  const min = Math.floor(diffMs / 60000)
  if (min < 1) return '방금'
  if (min < 60) return `${min}분 전`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}시간 전`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}일 전`
  return d.toISOString().slice(0, 10)
}

/**
 * 부서 홈 = 탐색·시작 허브. (부서홈_대시보드_설계.md 참고)
 * 기간 필터·집계 차트는 두지 않는다(그건 대시보드). 여기는 "어디로 갈지"를 돕는
 * 바로가기 + 빠른 시작(자주 쓴 템플릿) + 최근 보고서 + 하위 부서.
 */
export default function WorkspaceHomePage() {
  const { workspace, slug, all: workspaces } = useWorkspace()
  const { me } = useAuth()
  const isManager = me?.role === 'manager'
  const { data: reports, loading, error, reload } = useAsync(
    () => (slug ? listReports() : Promise.resolve([])),
    [slug],
  )
  // 부서 고정 보고서(핀) — 매니저가 고정, 멤버 모두 열람. 가상 노드 제외.
  const {
    data: pins,
    reload: reloadPins,
  } = useAsync(
    () => (slug && !workspace?.virtual ? listWorkspacePins(slug) : Promise.resolve([])),
    [slug, workspace?.virtual],
  )
  const pinnedReports = useMemo(() => pins ?? [], [pins])
  async function handleUnpin(reportId) {
    try {
      await removeWorkspacePin(slug, reportId)
      reloadPins()
    } catch (e) {
      toast.error(e?.response?.data?.message || '고정 해제 실패')
    }
  }
  const { data: templates } = useAsync(
    () => (slug ? listTemplates() : Promise.resolve([])),
    [slug],
  )
  // 부서 활동 피드 — 가상(_global) 노드에선 호출 안 함(백엔드도 빈 목록).
  const { data: activities } = useAsync(
    () => (slug && !workspace?.virtual ? listWorkspaceActivities({ limit: 12 }) : Promise.resolve([])),
    [slug, workspace?.virtual],
  )
  const templateName = useMemo(() => makeTemplateNameLookup(templates), [templates])

  const list = useMemo(() => reports ?? [], [reports])
  const recent = useMemo(
    () =>
      [...list]
        .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))
        .slice(0, 6),
    [list],
  )

  // 자주 쓴 템플릿 — 이 부서 보고서의 template_id 빈도 상위. 클릭 시 그 템플릿으로
  // 새 보고서. version 은 템플릿 목록의 최신값을 쓴다.
  const topTemplates = useMemo(() => {
    const tplMeta = new Map((templates ?? []).map((t) => [t.template_id, t]))
    const freq = new Map()
    for (const r of list) {
      if (r.template_id) freq.set(r.template_id, (freq.get(r.template_id) ?? 0) + 1)
    }
    return [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => tplMeta.get(id))
      .filter((t) => t && t.template_id)
      .slice(0, 6)
  }, [list, templates])

  const feedItems = useMemo(() => activities ?? [], [activities])

  // 직속 하위 부서(권한 범위 내 = 컨텍스트에 들어온 것만). 가상 노드 제외.
  const childDepts = useMemo(() => {
    if (!slug) return []
    return (workspaces ?? []).filter((w) => w.parent_slug === slug && !w.virtual)
  }, [workspaces, slug])

  if (!workspace || loading) {
    return (
      <div className="p-6 space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-24" />
        <Skeleton className="h-64" />
      </div>
    )
  }
  if (error) {
    return (
      <div className="p-6">
        <ErrorState description={error.message} onRetry={reload} />
      </div>
    )
  }

  const isVirtual = workspace.virtual

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title={workspace.name}
        description={[workspace.description, `보고서 ${list.length}건`]
          .filter(Boolean)
          .join(' · ')}
        actions={
          !isVirtual && (
            <div className="flex items-center gap-2">
              <Button asChild variant="outline" size="sm">
                <Link to={`/w/${slug}/composites`}>
                  <Layers3 className="mr-1.5 h-4 w-4" />
                  종합보고
                </Link>
              </Button>
              <Button asChild size="sm">
                <Link to={`/w/${slug}/reports/new`}>
                  <Plus className="mr-1.5 h-4 w-4" />
                  보고서 작성
                </Link>
              </Button>
            </div>
          )
        }
      />

      {/* 빠른 이동 — 부서 주요 화면 바로가기 */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <NavCard to={`/w/${slug}/dashboard`} icon={LayoutDashboard} label="대시보드" desc="현황·추세" />
        <NavCard to={`/w/${slug}/reports`} icon={FileText} label="보고서 목록" desc="폴더·검색" />
        <NavCard to={`/w/${slug}/composites`} icon={Layers3} label="종합보고" desc="모아 보기" />
        <NavCard to={`/w/${slug}/report-graph`} icon={Network} label="관계도" desc="연결 그래프" />
      </div>

      {/* 빠른 시작 — 자주 쓴 템플릿으로 바로 작성 */}
      {!isVirtual && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">빠른 시작</CardTitle>
            <CardDescription>자주 쓰는 템플릿으로 새 보고서</CardDescription>
          </CardHeader>
          <CardContent>
            {topTemplates.length === 0 ? (
              <Button asChild variant="outline" size="sm">
                <Link to={`/w/${slug}/reports/new`}>
                  <FilePlus2 className="mr-1.5 h-4 w-4" />
                  템플릿 선택해서 작성
                </Link>
              </Button>
            ) : (
              <div className="flex flex-wrap gap-2">
                {topTemplates.map((t) => (
                  <Link
                    key={t.template_id}
                    to={`/w/${slug}/reports/new/${t.template_id}/${t.version}`}
                    className="inline-flex items-center gap-1.5 rounded-md border bg-background px-3 py-1.5 text-sm hover:bg-muted transition-colors"
                  >
                    <FilePlus2 className="h-3.5 w-3.5 text-muted-foreground" />
                    {t.name || templateName(t.template_id)}
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* 고정 보고서(핀) — 매니저가 고정한 주요 보고서. 멤버 모두에게 보임.
          핀이 없으면 섹션 자체를 숨긴다(매니저에겐 안내). */}
      {!isVirtual && (pinnedReports.length > 0 || isManager) && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-1.5">
              <Pin className="h-4 w-4 text-primary" />
              고정 보고서
            </CardTitle>
            <CardDescription>
              {pinnedReports.length > 0
                ? `이 부서의 주요 보고서 ${pinnedReports.length}건`
                : '보고서 상세의 «더보기 → 부서 홈에 고정»으로 추가하세요.'}
            </CardDescription>
          </CardHeader>
          {pinnedReports.length > 0 && (
            <CardContent className="divide-y">
              {pinnedReports.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center gap-3 py-3 hover:bg-muted/40 -mx-6 px-6 group"
                >
                  <Pin className="h-4 w-4 text-primary shrink-0" />
                  <Link
                    to={`/w/${slug}/reports/${r.id}`}
                    className="flex-1 min-w-0"
                  >
                    <div className="font-medium truncate">{r.title}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {templateName(r.template_id)} · {r.owner_name ?? r.workspace_slug} · {r.report_date ?? '—'}
                    </div>
                  </Link>
                  <Badge variant={PHASE_VARIANT[r.phase] ?? 'secondary'} className="shrink-0">
                    {PHASE_LABEL[r.phase] ?? r.phase}
                  </Badge>
                  {isManager && (
                    <button
                      type="button"
                      onClick={() => handleUnpin(r.id)}
                      className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                      title="고정 해제"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
              ))}
            </CardContent>
          )}
        </Card>
      )}

      {/* 최근 보고서 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">최근 보고서</CardTitle>
          <CardDescription>최근 업데이트 순 {recent.length}건</CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          {recent.length === 0 ? (
            <div className="py-6 text-sm text-muted-foreground text-center">
              아직 보고서가 없습니다.
            </div>
          ) : (
            recent.map((r) => (
              <Link
                key={r.id}
                to={`/w/${slug}/reports/${r.id}`}
                className="flex items-center gap-3 py-3 hover:bg-muted/40 -mx-6 px-6"
              >
                <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{r.title}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    {templateName(r.template_id)} · {r.owner_name ?? r.workspace_slug} · {r.report_date ?? '—'}
                  </div>
                </div>
                <Badge variant={PHASE_VARIANT[r.phase] ?? 'secondary'} className="shrink-0">
                  {PHASE_LABEL[r.phase] ?? r.phase}
                </Badge>
              </Link>
            ))
          )}
        </CardContent>
      </Card>

      {/* 부서 최근 활동 — 이 부서 보고서들의 생성/편집/게시/코멘트 흐름 */}
      {!isVirtual && feedItems.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">부서 최근 활동</CardTitle>
            <CardDescription>이 부서 보고서의 최근 변경·코멘트 {feedItems.length}건</CardDescription>
          </CardHeader>
          <CardContent className="divide-y">
            {feedItems.map((it) => {
              const meta = ACTIVITY_META[it.type] ?? {
                icon: Activity,
                color: 'text-muted-foreground',
                label: it.type,
              }
              const Icon = meta.icon
              return (
                <Link
                  key={it.id}
                  to={`/w/${slug}/reports/${it.report_id}`}
                  className="flex items-center gap-3 py-2.5 hover:bg-muted/40 -mx-6 px-6"
                >
                  <Icon className={cn('h-4 w-4 shrink-0', meta.color)} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm truncate">
                      <span className="font-medium">{it.report_title || '(제목 없음)'}</span>
                      <span className="text-muted-foreground"> · {meta.label}</span>
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {it.actor?.name ?? '시스템'} · {formatRelative(it.created_at)}
                    </div>
                  </div>
                </Link>
              )
            })}
          </CardContent>
        </Card>
      )}

      {/* 하위 부서 바로가기 */}
      {childDepts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">하위 부서</CardTitle>
            <CardDescription>볼 수 있는 직속 하위 부서 {childDepts.length}곳</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {childDepts.map((w) => (
                <Link
                  key={w.slug}
                  to={`/w/${w.slug}`}
                  className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm hover:bg-muted transition-colors"
                >
                  <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="truncate">{w.name}</span>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function NavCard({ to, icon: Icon, label, desc }) {
  return (
    <Link
      to={to}
      className={cn(
        'flex flex-col gap-1 rounded-lg border bg-background p-3 transition-colors hover:bg-muted',
      )}
    >
      <Icon className="h-5 w-5 text-primary" />
      <div className="text-sm font-medium">{label}</div>
      <div className="text-[11px] text-muted-foreground">{desc}</div>
    </Link>
  )
}

/**
 * Build a (template_id → display name) lookup from the API list. Falls back
 * to the id itself when the template can't be found (deleted / not yet
 * loaded), but trims long UUIDs so the row doesn't blow up.
 */
function makeTemplateNameLookup(templates) {
  const map = new Map((templates ?? []).map((t) => [t.template_id, t.name]))
  return (id) => {
    if (!id) return ''
    const name = map.get(id)
    if (name) return name
    if (id.length > 16) return `${id.slice(0, 8)}…`
    return id
  }
}
