// 객체 프로필 (Phase A — "Object Profile"). 엔티티(=객체) 하나에 착지하는
// 읽기전용 화면. 흩어진 정보를 한 곳에 모은다: 헤더(축·값·상태·설명·별칭·연도)
// + 관련 객체(관계타입별, 근거 포함) + 이 객체를 태깅한 보고서(가시성 필터) +
// 2단계 관계도. 스키마 변경 없이 기존 서비스를 집약한 조합 엔드포인트
// (GET /api/entities/{id}/profile)를 렌더한다. "문서 중심 → 객체 중심" 전환의 얼굴.
import { useEffect, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  FileText,
  Network,
  Tag,
  Calendar,
  ArrowUpRight,
  Building2,
} from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Badge } from '@/shared/components/ui/badge'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { ErrorState } from '@/shared/components/ErrorState'
import { useAsync } from '@/shared/hooks/useAsync'
import {
  getEntityProfile,
  getEntityGraph,
  getObjectLinks,
  listEntityTypes,
  listRelationTypes,
} from '@/shared/api/entities'
import { EntityGraphView } from './EntityGraphView'

/**
 * 객체 프로필 **내용**(헤더·관련객체·관련보고서·관계도). 라우트 페이지와
 * "기준정보 탐색" 우측 패널이 공유한다. 페이지 헤더/컨테이너는 호출자 몫.
 *
 * props:
 *   entityId: number
 *   onOpenEntity(id, label)  — 관련객체 칩·관계도 노드 클릭 시. 라우트 페이지는
 *     `/entities/:id` 로 이동, 탐색 페이지는 시드를 그 값으로 바꿔 제자리 순회.
 *     생략하면 아무 동작 안 함(정적 표시).
 */
export function ObjectProfile({ entityId, onOpenEntity }) {
  const navigate = useNavigate()

  // 프로필 조합(별칭·연도·관계·태깅보고서) — id 바뀌면 재조회.
  const { data: profile, loading, error, reload } = useAsync(
    () => getEntityProfile(entityId),
    [entityId],
  )
  // 축 catalog + 관계 종류 라벨 — 표시용 메타(1회, id 무관하게 캐시).
  const { data: meta } = useAsync(
    () => Promise.all([listEntityTypes(), listRelationTypes()]),
    [],
  )
  const [typesRes, relTypesRes] = meta ?? [null, null]
  const axisBySlug = useMemo(() => {
    const m = new Map()
    for (const t of typesRes?.items ?? []) m.set(t.slug, t)
    return m
  }, [typesRes])
  const relTypeLabels = useMemo(() => {
    const m = new Map()
    for (const rt of relTypesRes?.items ?? []) m.set(rt.slug, rt.label)
    return m
  }, [relTypesRes])

  // 2단계 관계도 — 별도 호출(중복 방지). id 바뀌면 재조회.
  const { data: graph } = useAsync(
    () => getEntityGraph(entityId, { depth: 2 }),
    [entityId],
  )

  const entity = profile?.entity
  const axis = entity ? axisBySlug.get(entity.type_slug) : null
  const open = onOpenEntity ?? (() => {})

  if (error) {
    return <ErrorState description={String(error.message ?? error)} onRetry={reload} />
  }
  if (loading || !entity) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-28" />
        <Skeleton className="h-40" />
      </div>
    )
  }
  return (
    <div className="space-y-6">
      <HeaderCard entity={entity} axis={axis} profile={profile} />

      <RelatedObjects
        relations={profile.relations}
        relTypeLabels={relTypeLabels}
        onOpen={open}
      />

      <SystemLinks
        links={profile.system_links}
        relTypeLabels={relTypeLabels}
        onOpen={(t) => t && navigate(`/objects/${t.type}/${t.id}`)}
      />

      <RelatedReports
        reports={profile.reports}
        reportCount={profile.report_count}
        onOpen={(r) => navigate(`/w/${r.workspace_slug}/reports/${r.id}`)}
      />

      <GraphSection
        graph={graph}
        centerId={entityId}
        relTypeLabels={relTypeLabels}
        onNodeClick={(node) => {
          if (node?.kind === 'system' && node.refType) {
            navigate(`/objects/${node.refType}/${node.refId}`)
          } else if (node?.id != null && node.id !== entityId) {
            open(node.id, node.label)
          }
        }}
      />
    </div>
  )
}

/** 전역 라우트 `/entities/:entityId` — 프로필을 단독 페이지로. 칩/노드 클릭은
 *  같은 라우트로 이동해 순회한다. */
export default function ObjectProfilePage() {
  const { entityId } = useParams()
  const navigate = useNavigate()
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6">
      <ObjectProfile
        entityId={Number(entityId)}
        onOpenEntity={(id) => navigate(`/entities/${id}`)}
      />
    </div>
  )
}

/** 섹션 카드 래퍼 — 제목 + 내용. */
function Section({ icon: Icon, title, count, children }) {
  return (
    <section className="rounded-lg border bg-card">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        {Icon && <Icon className="h-4 w-4 text-muted-foreground" />}
        <h2 className="text-sm font-semibold">{title}</h2>
        {count != null && (
          <span className="text-xs text-muted-foreground">({count})</span>
        )}
      </div>
      <div className="p-4">{children}</div>
    </section>
  )
}

function HeaderCard({ entity, axis, profile }) {
  const isYearly = axis?.temporal_kind === 'yearly'
  const isLifecycle = axis?.temporal_kind === 'lifecycle'
  const years = profile.years ?? []
  const aliases = profile.aliases ?? []
  return (
    <section className="rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="text-[11px]">
          {axis?.label ?? entity.type_slug}
        </Badge>
        <span className="text-lg font-semibold">{entity.value}</span>
        {entity.code && (
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            {entity.code}
          </code>
        )}
        {entity.status === 'deprecated' && (
          <Badge variant="secondary" className="text-[11px]">
            비활성
          </Badge>
        )}
      </div>

      {entity.description && (
        <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
          {entity.description}
        </p>
      )}

      {/* 속성 (A0.1 record 축) */}
      {entity.properties && Object.keys(entity.properties).length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {Object.entries(entity.properties).map(([k, v]) => (
            <span
              key={k}
              className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
            >
              <span className="text-foreground/70">{k}</span>:{' '}
              {Array.isArray(v) ? v.join(', ') : String(v)}
            </span>
          ))}
        </div>
      )}

      {/* 별칭 + 연도 */}
      {(aliases.length > 0 || years.length > 0 || isLifecycle) && (
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          {aliases.length > 0 && (
            <span className="flex flex-wrap items-center gap-1">
              <Tag className="h-3.5 w-3.5" />
              {aliases.map((a) => (
                <Badge key={a.id} variant="outline" className="text-[10px]">
                  {a.alias}
                </Badge>
              ))}
            </span>
          )}
          {isYearly && years.length > 0 && (
            <span className="flex items-center gap-1">
              <Calendar className="h-3.5 w-3.5" />
              {years.join(', ')}
            </span>
          )}
          {isLifecycle && (entity.valid_from_year || entity.valid_to_year) && (
            <span className="flex items-center gap-1">
              <Calendar className="h-3.5 w-3.5" />
              {entity.valid_from_year ?? '…'} ~ {entity.valid_to_year ?? '현재'}
            </span>
          )}
        </div>
      )}
    </section>
  )
}

function RelatedObjects({ relations, relTypeLabels, onOpen }) {
  // parents(이 객체 → 대상) + children(대상 → 이 객체)을 관계 종류별로 묶는다.
  const groups = useMemo(() => {
    const out = new Map() // key: `${dir}:${slug}` → { dir, slug, items }
    const push = (dir, it) => {
      const key = `${dir}:${it.relation}`
      if (!out.has(key)) out.set(key, { dir, slug: it.relation, items: [] })
      out.get(key).items.push(it)
    }
    for (const it of relations?.parents ?? []) push('out', it)
    for (const it of relations?.children ?? []) push('in', it)
    return [...out.values()]
  }, [relations])

  const total =
    (relations?.parents?.length ?? 0) + (relations?.children?.length ?? 0)

  return (
    <Section icon={Network} title="관련 객체" count={total}>
      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">연결된 객체가 없습니다.</p>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => {
            const label = relTypeLabels.get(g.slug) ?? g.slug
            return (
              <div key={`${g.dir}:${g.slug}`}>
                <div className="mb-1 text-xs font-medium text-muted-foreground">
                  {label}
                  <span className="ml-1 text-[10px]">
                    {g.dir === 'out' ? '(이 객체 → 대상)' : '(대상 → 이 객체)'}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {g.items.map((it) => (
                    <button
                      key={it.relation_id}
                      type="button"
                      onClick={() => onOpen(it.entity_id, it.value)}
                      className="group inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-sm hover:bg-accent"
                      title={
                        it.evidence_note ||
                        (it.evidence_report_id ? '근거 보고서 있음' : undefined)
                      }
                    >
                      <span className="truncate max-w-[16rem]">{it.value}</span>
                      <Badge variant="outline" className="text-[9px]">
                        {it.type_slug}
                      </Badge>
                      {(it.evidence_report_id != null || it.evidence_note) && (
                        <FileText className="h-3 w-3 text-muted-foreground" />
                      )}
                      <ArrowUpRight className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100" />
                    </button>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Section>
  )
}

/** cross-kind 링크(A0.3 스텝2) — 부서 등 system 객체. 해석된 label·url 로 칩,
 *  클릭 시 대상(예: 부서 → /w/slug)으로 이동. 링크가 없으면 섹션 자체를 숨긴다. */
function SystemLinks({ links, relTypeLabels, onOpen }) {
  const items = links ?? []
  if (items.length === 0) return null
  return (
    <Section icon={Building2} title="관련 조직" count={items.length}>
      <div className="flex flex-wrap gap-1.5">
        {items.map((it) => (
          <button
            key={it.link_id}
            type="button"
            onClick={() => onOpen(it.target)}
            disabled={!it.target}
            className="group inline-flex items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-sm hover:bg-accent disabled:opacity-60"
            title={it.evidence_note || undefined}
          >
            <span className="text-[10px] text-muted-foreground">
              {relTypeLabels.get(it.relation) ?? it.relation}
            </span>
            <span className="truncate">{it.target?.label ?? it.target?.id}</span>
            <ArrowUpRight className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100" />
          </button>
        ))}
      </div>
    </Section>
  )
}

function RelatedReports({ reports, reportCount, onOpen }) {
  return (
    <Section icon={FileText} title="관련 보고서" count={reportCount}>
      {(reports?.length ?? 0) === 0 ? (
        <p className="text-sm text-muted-foreground">
          이 객체를 태깅한 (내가 볼 수 있는) 보고서가 없습니다.
        </p>
      ) : (
        <ul className="divide-y">
          {reports.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => onOpen(r)}
                className="flex w-full items-center justify-between gap-3 py-2 text-left hover:bg-accent/40"
              >
                <span className="min-w-0 flex-1 truncate text-sm">{r.title}</span>
                <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant="outline" className="text-[10px]">
                    {r.workspace_slug}
                  </Badge>
                  {r.updated_at && (
                    <span>{String(r.updated_at).slice(0, 10)}</span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

function GraphSection({ graph, centerId, relTypeLabels, onNodeClick }) {
  const hasEdges = (graph?.edges?.length ?? 0) > 0
  return (
    <Section icon={Network} title="관계도">
      {!hasEdges ? (
        <p className="text-sm text-muted-foreground">
          그릴 관계가 없습니다. 관계가 생기면 2단계 서브그래프가 표시됩니다.
        </p>
      ) : (
        <>
          <p className="mb-2 text-xs text-muted-foreground">
            2단계 관계 그래프. 노드를 클릭하면 그 객체 프로필로 이동합니다.
          </p>
          <div className="h-[420px] w-full overflow-hidden rounded-md border">
            <EntityGraphView
              graph={graph}
              centerId={centerId}
              relTypeLabels={relTypeLabels}
              active
              onNodeClick={onNodeClick}
            />
          </div>
        </>
      )}
    </Section>
  )
}

/**
 * 일반 객체 프로필 (A0.3 스텝3, ObjectRef 일반화). 라우트 `/objects/:objType/:objId`.
 * entity 객체는 더 풍부한 `/entities/:id` 로 리다이렉트하고, **system 객체(부서 등)**
 * 는 여기서 헤더 + "관련 객체"(cross-kind 링크 양방향)를 보여준다. 부서면 담당 과제들이
 * incoming 으로 뜬다("이 부서가 담당한 것 전부"). object_links(GET /objects/{t}/{id}/links).
 */
export function ObjectRefProfilePage() {
  const { objType, objId } = useParams()
  const navigate = useNavigate()

  const { data, loading, error, reload } = useAsync(
    () => getObjectLinks(objType, objId),
    [objType, objId],
  )
  const { data: relTypesRes } = useAsync(() => listRelationTypes(), [])
  // slug → { label, inverse_label } — incoming 은 역라벨로 보여준다(부서 입장).
  const relMeta = useMemo(() => {
    const m = new Map()
    for (const rt of relTypesRes?.items ?? []) m.set(rt.slug, rt)
    return m
  }, [relTypesRes])

  const obj = data?.object

  // entity 객체는 값 프로필(/entities/:id)이 더 풍부 — 그쪽으로 넘긴다.
  useEffect(() => {
    if (obj && obj.kind_class !== 'system') {
      navigate(`/entities/${obj.id}`, { replace: true })
    }
  }, [obj, navigate])

  if (error) {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-6">
        <ErrorState description={String(error.message ?? error)} onRetry={reload} />
      </div>
    )
  }
  if (loading || !obj || obj.kind_class !== 'system') {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-6">
        <Skeleton className="h-28" />
      </div>
    )
  }

  const items = data.items ?? []
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6">
      <section className="mb-6 rounded-lg border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Building2 className="h-5 w-5 text-muted-foreground" />
          <span className="text-lg font-semibold">{obj.label}</span>
          <Badge variant="outline" className="text-[11px]">
            {obj.type === 'dept' ? '부서' : obj.type}
          </Badge>
          {obj.url && (
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              onClick={() => navigate(obj.url)}
            >
              부서 홈 열기 <ArrowUpRight className="ml-1 h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </section>

      <Section icon={Network} title="관련 객체" count={items.length}>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            이 조직에 연결된 객체가 없습니다.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {items.map((it) => {
              const rt = relMeta.get(it.relation)
              const label =
                it.direction === 'in'
                  ? rt?.inverse_label ?? it.relation
                  : rt?.label ?? it.relation
              return (
                <button
                  key={it.link_id}
                  type="button"
                  onClick={() =>
                    navigate(`/objects/${it.target.type}/${it.target.id}`)
                  }
                  className="group inline-flex items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-sm hover:bg-accent"
                  title={it.evidence_note || undefined}
                >
                  <span className="text-[10px] text-muted-foreground">{label}</span>
                  <span className="truncate">
                    {it.target?.label ?? it.target?.id}
                  </span>
                  <Badge variant="outline" className="text-[9px]">
                    {it.target?.type}
                  </Badge>
                  <ArrowUpRight className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100" />
                </button>
              )
            })}
          </div>
        )}
      </Section>
    </div>
  )
}
