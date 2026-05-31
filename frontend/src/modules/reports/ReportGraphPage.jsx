// 글로벌 관계도 페이지 (지식그래프 Phase 1b) — 워크스페이스 범위의 연결된
// 보고서 구조를 한 화면에 본다. 그래프 렌더는 LinkGraphCanvas 를 로컬 모달과
// 공유하고, 여기선 필터(기간/종류/link kind) + fetch + 안내만 담당한다.
//
// 스코핑은 백엔드가 X-Workspace-Slug 헤더(현재 워크스페이스)로 처리한다 —
// virtual(전체) 뷰면 무스코핑, 아니면 워크스페이스 트리로 한정. 고립 노드는
// 기본 제외(연결된 보고서만), limit 초과 시 truncated 안내.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Loader2, RotateCw, Search, X } from 'lucide-react'
import { PageHeader } from '@/shared/components/PageHeader'
import { Button } from '@/shared/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/shared/components/ui/popover'
import { cn } from '@/shared/lib/utils'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import { colorClasses, labelForKind } from '@/shared/reports/linkKinds'
import { useGraphColors, GraphColorLegend } from './graphColorMapping'
import { useCommunities, COMMUNITY_MIN_NODES, SMALL_KEY } from './useCommunities'
import { listLinkKinds } from '@/shared/api/linkKinds'
import { listReportTypes } from '@/shared/api/reportTypes'
import { getGlobalLinkGraph } from '@/shared/api/reportLinks'
import { LinkGraphCanvas } from './LinkGraphCanvas'
import { EntityFilter } from './GraphEntityFilter'
import { GraphTagLayer, DEFAULT_TAG_AXES } from './GraphTagLayer'
import { GraphTimeBar } from './GraphTimeBar'

const DATE_PRESETS = [
  { value: 'all', label: '전체 기간', days: null },
  { value: '7', label: '지난 1주', days: 7 },
  { value: '30', label: '지난 1개월', days: 30 },
  { value: '90', label: '지난 3개월', days: 90 },
  { value: '365', label: '지난 1년', days: 365 },
]

function fmtLocalDate(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function rangeFromPreset(value) {
  const found = DATE_PRESETS.find((p) => p.value === value)
  if (!found || found.days == null) return { from: undefined, to: undefined }
  const today = new Date()
  const start = new Date(today)
  start.setDate(start.getDate() - found.days)
  return { from: fmtLocalDate(start), to: fmtLocalDate(today) }
}

// URL 쿼리스트링 ↔ 필터 상태 직렬화 헬퍼 (Phase 3 상태 보존·공유).
function parseCsv(v) {
  return v ? v.split(',').filter(Boolean) : []
}
function parseIdsCsv(v) {
  return parseCsv(v).map(Number).filter((n) => Number.isFinite(n))
}

export default function ReportGraphPage() {
  const navigate = useNavigate()
  const { slug, workspace } = useWorkspace()
  const [searchParams, setSearchParams] = useSearchParams()

  // 필터 상태 — 초기값은 URL 쿼리스트링에서 복원 (Phase 3 상태 보존·공유).
  // searchParams 는 첫 렌더 값을 캡처하므로 initializer 가 1회만 읽는다.
  const [datePreset, setDatePreset] = useState(
    () => searchParams.get('d') || 'all',
  )
  const [typeIds, setTypeIds] = useState(() =>
    parseIdsCsv(searchParams.get('types')),
  ) // number[]
  const [kindKeys, setKindKeys] = useState(() =>
    parseCsv(searchParams.get('kinds')),
  ) // string[] (빈 배열 = 전체)
  // 관련정보(entity) 레이어 — 노드로 표시할지(tagLayer) + 값으로 필터링
  // (selectedEntities). 필터는 레이어 표시와 독립 (값으로 좁히되 태그 노드는
  // 안 띄울 수도 있음). tagLayer: 부품 폭증 방지로 축 선택 + 공유 태그만 기본.
  const [tagLayer, setTagLayer] = useState(() => ({
    enabled: searchParams.get('tag') === '1',
    axes: searchParams.get('tagax')
      ? parseCsv(searchParams.get('tagax'))
      : DEFAULT_TAG_AXES,
    sharedOnly: searchParams.get('tagsh') !== '0', // 기본 true
  }))
  // 타임라인 정렬 모드 (Phase 3) — x 를 report_date 로 고정. 클라이언트
  // 레이아웃만 바꾸므로 재조회는 안 한다. laneBy: 스윔레인 기준
  // ('none'=평소 타임라인, 'type'=보고서 종류, 'owner'=작성자).
  const [timeline, setTimeline] = useState(() => searchParams.get('tl') === '1')
  const [laneBy, setLaneBy] = useState(() => searchParams.get('lane') || 'none')
  // 타임바 (Phase 3 (3)) — 평소 그래프에서 기간 브러시 + 재생. timeline 과 독립.
  // playRange/playing 은 일시적(공유 URL 엔 toggle 만 보존).
  const [timeBar, setTimeBar] = useState(() => searchParams.get('play') === '1')
  const [playRange, setPlayRange] = useState(null) // {from,to} ms | null
  const [playing, setPlaying] = useState(false)
  // 노드 검색 (Phase 4) — 매칭 노드만 또렷하게. 일시적이라 URL 미보존.
  const [searchQuery, setSearchQuery] = useState('')
  // 종합보고 레이어 (Phase 4) — 보고서를 묶는 hub 노드 표시.
  const [includeComposites, setIncludeComposites] = useState(
    () => searchParams.get('comp') === '1',
  )
  // 고립 노드 표시 (Phase 4) — 연결 없는 보고서도 점으로.
  const [includeIsolated, setIncludeIsolated] = useState(
    () => searchParams.get('iso') === '1',
  )
  const [selectedEntities, setSelectedEntities] = useState([]) // [{id,value,type_slug}]
  const entityIds = useMemo(
    () => selectedEntities.map((e) => e.id),
    [selectedEntities],
  )
  // 노드 색 기준 (Phase 2). 'type' = 보고서 종류(plan 기본), 'owner' = 작성자,
  // 'community' = 자동 클러스터(§11.4 4a), 'none' = 회색 단색.
  const [colorBy, setColorBy] = useState(() => searchParams.get('color') || 'type')
  // 클러스터링에 관련정보(entity has_tag)를 브릿지로 쓸지 (§11.4) — 켜면 같은
  // 관련정보를 공유한 보고서가 한 덩어리로 묶인다. community 모드일 때만 의미.
  const [communityBridge, setCommunityBridge] = useState(
    () => searchParams.get('club') === '1',
  )
  // 클러스터 외곽선(§11.4 4b) — 커뮤니티를 convex hull 로 감싼다. 색 기준과 독립
  // (색=종류여도 외곽선=구조). 타임라인 모드에선 캔버스가 무시.
  const [clusterHull, setClusterHull] = useState(
    () => searchParams.get('clu') === '1',
  )

  // 필터 옵션 카탈로그
  const [typeOptions, setTypeOptions] = useState([]) // [{id,name}]
  const [kinds, setKinds] = useState([]) // ReportLinkKindRead[]

  // 그래프 데이터
  const [graph, setGraph] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  // 카탈로그 로드 (1회)
  useEffect(() => {
    let cancelled = false
    Promise.allSettled([listReportTypes({ limit: 200 }), listLinkKinds()]).then(
      ([typesRes, kindsRes]) => {
        if (cancelled) return
        if (typesRes.status === 'fulfilled') {
          const items = typesRes.value?.items ?? typesRes.value ?? []
          setTypeOptions(
            (Array.isArray(items) ? items : []).map((t) => ({
              id: t.id,
              name: t.name,
            })),
          )
        }
        if (kindsRes.status === 'fulfilled') {
          setKinds(Array.isArray(kindsRes.value) ? kindsRes.value : [])
        }
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  // 그래프 fetch — 워크스페이스/필터 변화에 반응.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const { from, to } = rangeFromPreset(datePreset)
    getGlobalLinkGraph({
      dateFrom: from,
      dateTo: to,
      typeIds,
      kinds: kindKeys,
      entityIds,
      includeTags: tagLayer.enabled,
      tagAxes: tagLayer.axes,
      tagMinDegree: tagLayer.sharedOnly ? 2 : 1,
      includeComposites,
      includeIsolated,
    })
      .then((data) => {
        if (!cancelled) setGraph(data)
      })
      .catch((err) => {
        if (!cancelled) {
          console.warn('getGlobalLinkGraph failed', err)
          setError('관계도를 불러오지 못했습니다.')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [
    slug,
    datePreset,
    typeIds,
    kindKeys,
    entityIds,
    tagLayer,
    includeComposites,
    includeIsolated,
  ])

  // 필터 상태 → URL 쿼리스트링 동기화 (공유/뒤로가기 보존). 기본값은 안 적어
  // URL 을 짧게 유지. selectedEntities(값 필터)는 라벨 복원이 필요해 보류.
  useEffect(() => {
    const p = new URLSearchParams()
    if (datePreset !== 'all') p.set('d', datePreset)
    if (typeIds.length) p.set('types', typeIds.join(','))
    if (kindKeys.length) p.set('kinds', kindKeys.join(','))
    if (colorBy !== 'type') p.set('color', colorBy)
    if (colorBy === 'community' && communityBridge) p.set('club', '1')
    if (clusterHull) p.set('clu', '1')
    if (timeline) p.set('tl', '1')
    if (timeline && laneBy !== 'none') p.set('lane', laneBy)
    if (timeBar) p.set('play', '1')
    if (includeComposites) p.set('comp', '1')
    if (includeIsolated) p.set('iso', '1')
    if (tagLayer.enabled) {
      p.set('tag', '1')
      if (tagLayer.axes.join(',') !== DEFAULT_TAG_AXES.join(','))
        p.set('tagax', tagLayer.axes.join(','))
      if (!tagLayer.sharedOnly) p.set('tagsh', '0')
    }
    setSearchParams(p, { replace: true })
  }, [
    datePreset,
    typeIds,
    kindKeys,
    colorBy,
    communityBridge,
    clusterHull,
    timeline,
    laneBy,
    timeBar,
    includeComposites,
    includeIsolated,
    tagLayer,
    setSearchParams,
  ])

  const handleNodeClick = useCallback(
    (node) => {
      if (!node) return
      if (node.type === 'report') {
        navigate(`/w/${node.workspace_slug}/reports/${node.report_id}`)
      } else if (node.type === 'composite') {
        navigate(`/w/${node.workspace_slug}/composites/${node.composite_id}`)
      }
      // entity 노드는 이동 없음
    },
    [navigate],
  )

  const toggleType = useCallback((id) => {
    setTypeIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }, [])
  const toggleKind = useCallback((key) => {
    setKindKeys((prev) =>
      prev.includes(key) ? prev.filter((x) => x !== key) : [...prev, key],
    )
  }, [])

  // 필터가 그대로여도 최신 데이터로 강제 재조회 (effect 는 값이 같으면
  // 안 깨우므로 직접 호출).
  const refresh = useCallback(() => {
    setLoading(true)
    setError(null)
    const { from, to } = rangeFromPreset(datePreset)
    getGlobalLinkGraph({
      dateFrom: from,
      dateTo: to,
      typeIds,
      kinds: kindKeys,
      entityIds,
      includeTags: tagLayer.enabled,
      tagAxes: tagLayer.axes,
      tagMinDegree: tagLayer.sharedOnly ? 2 : 1,
      includeComposites,
      includeIsolated,
    })
      .then(setGraph)
      .catch(() => setError('관계도를 불러오지 못했습니다.'))
      .finally(() => setLoading(false))
  }, [
    datePreset,
    typeIds,
    kindKeys,
    entityIds,
    tagLayer,
    includeComposites,
    includeIsolated,
  ])

  const nodeCount = graph?.nodes?.length ?? 0
  const edgeCount = graph?.edges?.length ?? 0
  const hasFilters =
    datePreset !== 'all' ||
    typeIds.length > 0 ||
    kindKeys.length > 0 ||
    selectedEntities.length > 0
  const isEmpty = !loading && !error && nodeCount === 0

  const selectedTypeLabel = useMemo(() => {
    if (typeIds.length === 0) return '전체'
    if (typeIds.length === 1) {
      return typeOptions.find((t) => t.id === typeIds[0])?.name ?? '1개'
    }
    return `${typeIds.length}개`
  }, [typeIds, typeOptions])

  // ── 색 매핑 (Phase 2) ──────────────────────────────────────────────────
  const typeNameById = useMemo(
    () => new Map(typeOptions.map((t) => [t.id, t.name])),
    [typeOptions],
  )

  // ── 스윔레인 기준 (Phase 3 (2)) ────────────────────────────────────────
  // node → {key,label}. 'none' 이면 null (레인 없이 평소 타임라인). 타임라인이
  // 꺼져 있으면 캔버스가 무시하므로 laneBy 만으로 결정.
  const laneOf = useMemo(() => {
    if (laneBy === 'type') {
      return (node) => {
        const key = node.report_type_id ?? '__none__'
        return {
          key,
          label: key === '__none__' ? '미지정' : typeNameById.get(key) ?? `#${key}`,
        }
      }
    }
    if (laneBy === 'owner') {
      return (node) => ({
        key: node.owner_name ?? '__none__',
        label: node.owner_name ?? '미지정',
      })
    }
    return null
  }, [laneBy, typeNameById])

  // ── 타임바 (Phase 3 (3)) ───────────────────────────────────────────────
  const reportDates = useMemo(
    () =>
      (graph?.nodes ?? [])
        .filter((n) => n.type === 'report' && n.report_date)
        .map((n) => Date.parse(n.report_date))
        .filter((t) => !Number.isNaN(t)),
    [graph],
  )
  const timeBounds = useMemo(() => {
    if (!reportDates.length) return null
    return { min: Math.min(...reportDates), max: Math.max(...reportDates) }
  }, [reportDates])
  // 타임바 켜짐/데이터 변화 시 선택 기간 초기화(전체). 끄면 정리.
  useEffect(() => {
    if (timeBar && timeBounds) {
      setPlayRange({ from: timeBounds.min, to: timeBounds.max })
    } else {
      setPlaying(false)
      setPlayRange(null)
    }
  }, [timeBar, timeBounds])
  // 재생 — from=min 고정, to 를 6초에 걸쳐 끝까지 흘려 시간순으로 쌓는다.
  // rAF 타임스탬프만 쓰므로 Date.now 불필요.
  useEffect(() => {
    if (!playing || !timeBounds) return undefined
    let raf
    let startTs = null
    const DURATION = 6000
    const step = (ts) => {
      if (startTs === null) startTs = ts
      const p = Math.min(1, (ts - startTs) / DURATION)
      setPlayRange({
        from: timeBounds.min,
        to: timeBounds.min + p * (timeBounds.max - timeBounds.min),
      })
      if (p < 1) raf = requestAnimationFrame(step)
      else setPlaying(false)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [playing, timeBounds])
  const togglePlay = useCallback(() => {
    setPlaying((prev) => {
      if (!prev && timeBounds) setPlayRange({ from: timeBounds.min, to: timeBounds.min })
      return !prev
    })
  }, [timeBounds])
  const handleRangeChange = useCallback((r) => {
    setPlaying(false) // 수동 조작하면 재생 멈춤
    setPlayRange(r)
  }, [])

  // ── 자동 클러스터링 (§11.4 4a/4b) ──────────────────────────────────────
  // 색 기준이 community 거나 외곽선이 켜졌을 때 Louvain 계산. 노드 적으면
  // ready=false (회색 폴백 + 안내).
  const communityActive = colorBy === 'community' || clusterHull
  const community = useCommunities({
    graph,
    enabled: communityActive,
    includeBridges: communityBridge,
    typeNameById,
  })
  // 클러스터링을 요청했는데 노드가 적어 미적용된 경우 안내(드롭다운/토글은
  // 켜졌는데 색·외곽선이 안 보이는 이유 설명).
  const communityNotApplied = communityActive && !community.ready && nodeCount > 0

  // 외곽선(4b) 프롭 — 켜졌고 클러스터가 산출됐을 때만. 소규모(SMALL_KEY)는 한
  // 덩어리가 아니므로 keyOf 에서 제외(전체를 감싸는 거대 hull 방지).
  const { communityOf, colorOf: communityColorOf } = community
  const clusters = useMemo(() => {
    if (!clusterHull || !communityOf || !communityColorOf) return null
    return {
      keyOf: (node) => {
        const k = communityOf.get(node.id)
        return k === SMALL_KEY ? null : k
      },
      colorOf: communityColorOf,
    }
  }, [clusterHull, communityOf, communityColorOf])

  // 색 매핑 — 페이지·모달 공유 훅 (entity/composite 제외, report 만 집계).
  const { colors, nodeColor, labelFor } = useGraphColors({
    graph,
    colorBy,
    typeNameById,
    communityOf: community.communityOf,
    communityLabelOf: community.labelOf,
  })

  const overlay = (
    <>
      {error && (
        <div className="absolute inset-0 grid place-items-center text-sm text-destructive">
          {error}
        </div>
      )}
      {isEmpty && (
        <div className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-muted-foreground">
          {hasFilters
            ? '필터에 해당하는 연결된 보고서가 없습니다.'
            : '아직 보고서 간 연결이 없습니다. 보고서 상세에서 다른 보고서와 연결해 보세요.'}
        </div>
      )}
    </>
  )

  return (
    <div className="flex h-full flex-col">
      {/* 헤더 + 필터 바 — shrink-0, 나머지 공간은 캔버스가 채움 */}
      <div className="shrink-0 space-y-3 border-b bg-background p-4">
        <PageHeader
          title="관계도"
          description={
            (workspace?.virtual
              ? '전체 워크스페이스의 보고서 관계도'
              : `${workspace?.name ?? slug} 범위의 보고서 관계도`) +
            (includeIsolated ? ' (고립 노드 포함)' : ' (연결된 보고서만)')
          }
          actions={
            <Button
              variant="outline"
              size="sm"
              onClick={refresh}
              disabled={loading}
            >
              {loading ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCw className="mr-1 h-3.5 w-3.5" />
              )}
              새로고침
            </Button>
          }
        />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {/* 기간 */}
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            기간
            <select
              value={datePreset}
              onChange={(e) => setDatePreset(e.target.value)}
              className="h-7 rounded-md border bg-background px-2 text-[11px]"
            >
              {DATE_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>

          {/* 보고서 종류 multi-select */}
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="inline-flex h-7 items-center gap-1 rounded-md border bg-background px-2 text-[11px]"
              >
                <span className="text-muted-foreground">종류</span>
                <span className={typeIds.length ? 'text-foreground' : 'text-muted-foreground'}>
                  {selectedTypeLabel}
                </span>
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-[240px] p-2" align="start">
              <div className="max-h-[280px] space-y-0.5 overflow-y-auto">
                {typeOptions.length === 0 ? (
                  <p className="px-1 py-2 text-[11px] text-muted-foreground italic">
                    종류 없음
                  </p>
                ) : (
                  typeOptions.map((t) => (
                    <label
                      key={t.id}
                      className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted"
                    >
                      <input
                        type="checkbox"
                        checked={typeIds.includes(t.id)}
                        onChange={() => toggleType(t.id)}
                        className="accent-indigo-500"
                      />
                      <span className="truncate">{t.name}</span>
                    </label>
                  ))
                )}
              </div>
              {typeIds.length > 0 && (
                <button
                  type="button"
                  onClick={() => setTypeIds([])}
                  className="mt-1 w-full rounded border px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted"
                >
                  선택 해제
                </button>
              )}
            </PopoverContent>
          </Popover>

          {/* link kind 토글 칩 — 빈 선택 = 전체 */}
          {kinds.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-xs text-muted-foreground">관계</span>
              {kinds.map((k) => {
                const on = kindKeys.includes(k.key)
                return (
                  <button
                    key={k.key}
                    type="button"
                    onClick={() => toggleKind(k.key)}
                    className={cn(
                      'rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors',
                      on
                        ? colorClasses(k.color)
                        : 'border-border bg-background text-muted-foreground hover:bg-muted',
                    )}
                    title={`${k.forward_label} / ${labelForKind(k, 'incoming')}`}
                  >
                    {k.forward_label}
                  </button>
                )
              })}
            </div>
          )}

          {/* 관련정보(entity) 필터 — 값으로 보고서 좁힘 (axis 별 AND) */}
          <EntityFilter
            selected={selectedEntities}
            onChange={setSelectedEntities}
          />

          {/* 관련정보 레이어 — entity 노드 표시(축 선택 + 공유 태그만) §2.1 */}
          <GraphTagLayer
            enabled={tagLayer.enabled}
            axes={tagLayer.axes}
            sharedOnly={tagLayer.sharedOnly}
            onChange={setTagLayer}
          />

          {/* 종합보고 레이어 (Phase 4) — 보고서를 묶는 hub 노드 */}
          <button
            type="button"
            onClick={() => setIncludeComposites((v) => !v)}
            className={cn(
              'h-7 rounded-md border px-2 text-[11px] font-medium transition-colors',
              includeComposites
                ? 'border-amber-300 bg-amber-50 text-amber-700'
                : 'border-border bg-background text-muted-foreground hover:bg-muted',
            )}
            title="이 보고서들을 묶는 종합보고를 hub 노드로 표시"
          >
            종합보고
          </button>

          {/* 고립 노드 표시 (Phase 4) — 연결 없는 보고서도 점으로 */}
          <button
            type="button"
            onClick={() => setIncludeIsolated((v) => !v)}
            className={cn(
              'h-7 rounded-md border px-2 text-[11px] font-medium transition-colors',
              includeIsolated
                ? 'border-indigo-300 bg-indigo-50 text-indigo-700'
                : 'border-border bg-background text-muted-foreground hover:bg-muted',
            )}
            title="연결 없는 보고서도 점으로 표시 (degree 0)"
          >
            고립 노드
          </button>

          {/* 색 기준 — 노드를 어떤 범주로 칠할지 (plan §2.3) */}
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            색
            <select
              value={colorBy}
              onChange={(e) => setColorBy(e.target.value)}
              className="h-7 rounded-md border bg-background px-2 text-[11px]"
            >
              <option value="type">보고서 종류</option>
              <option value="owner">작성자</option>
              <option value="community">자동 클러스터</option>
              <option value="none">단색</option>
            </select>
          </label>

          {/* 클러스터 브릿지 (§11.4) — 관련정보(entity)로 보고서를 잇는다. 같은
              관련정보를 공유한 보고서가 한 덩어리로. 색=community 거나 외곽선이
              켜졌을 때(클러스터링이 도는 상황) 노출 */}
          {communityActive && (
            <button
              type="button"
              onClick={() => setCommunityBridge((v) => !v)}
              className={cn(
                'h-7 rounded-md border px-2 text-[11px] font-medium transition-colors',
                communityBridge
                  ? 'border-indigo-300 bg-indigo-50 text-indigo-700'
                  : 'border-border bg-background text-muted-foreground hover:bg-muted',
              )}
              title="같은 관련정보(모델·시험 등)를 공유한 보고서를 한 덩어리로 묶어 클러스터링"
            >
              관련정보로 묶기
            </button>
          )}

          {/* 클러스터 외곽선 (§11.4 4b) — 커뮤니티를 convex hull 로 감싼다. 색
              기준과 독립이라 색=종류여도 덩어리=구조를 동시에 볼 수 있다 */}
          <button
            type="button"
            onClick={() => setClusterHull((v) => !v)}
            className={cn(
              'h-7 rounded-md border px-2 text-[11px] font-medium transition-colors',
              clusterHull
                ? 'border-indigo-300 bg-indigo-50 text-indigo-700'
                : 'border-border bg-background text-muted-foreground hover:bg-muted',
            )}
            title="자동 클러스터를 외곽선(덩어리)으로 감싸 구조를 드러냄 (타임라인 정렬 중엔 비활성)"
          >
            클러스터 외곽선
          </button>

          {/* 타임라인 정렬 (Phase 3) — x 를 보고서 일자로 고정, 좌→우 시간 흐름 */}
          <button
            type="button"
            onClick={() => setTimeline((v) => !v)}
            className={cn(
              'h-7 rounded-md border px-2 text-[11px] font-medium transition-colors',
              timeline
                ? 'border-indigo-300 bg-indigo-50 text-indigo-700'
                : 'border-border bg-background text-muted-foreground hover:bg-muted',
            )}
            title="보고서 일자 순으로 좌→우 정렬"
          >
            타임라인 정렬
          </button>

          {/* 레인 기준 (Phase 3 (2)) — 타임라인일 때만. 세로를 카테고리 띠로 */}
          {timeline && (
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              레인
              <select
                value={laneBy}
                onChange={(e) => setLaneBy(e.target.value)}
                className="h-7 rounded-md border bg-background px-2 text-[11px]"
              >
                <option value="none">없음</option>
                <option value="type">보고서 종류</option>
                <option value="owner">작성자</option>
              </select>
            </label>
          )}

          {/* 시간 재생 (Phase 3 (3)) — 하단 타임바로 기간 브러시·재생. 독립 토글 */}
          <button
            type="button"
            onClick={() => setTimeBar((v) => !v)}
            className={cn(
              'h-7 rounded-md border px-2 text-[11px] font-medium transition-colors',
              timeBar
                ? 'border-indigo-300 bg-indigo-50 text-indigo-700'
                : 'border-border bg-background text-muted-foreground hover:bg-muted',
            )}
            title="하단 타임바로 기간을 좁히거나 시간 흐름을 재생"
          >
            시간 재생
          </button>

          {hasFilters && (
            <button
              type="button"
              onClick={() => {
                setDatePreset('all')
                setTypeIds([])
                setKindKeys([])
                setSelectedEntities([])
              }}
              className="h-7 rounded-md border bg-background px-2 text-[11px] text-muted-foreground hover:bg-muted"
            >
              필터 초기화
            </button>
          )}

          {/* 노드 검색 (Phase 4) — 매칭 노드만 또렷, 나머지 흐리게 */}
          <div className="relative ml-auto">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="노드 검색"
              className="h-7 w-40 rounded-md border bg-background pl-7 pr-6 text-[11px]"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                title="지우기"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {/* 상태 */}
          <span className="text-xs text-muted-foreground tabular-nums">
            노드 {nodeCount} · 연결 {edgeCount}
          </span>
          {graph?.truncated && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
              일부만 표시 — 필터를 좁혀 주세요
            </span>
          )}
        </div>

        {/* 색 범례 — 색 기준이 켜져 있고 범주가 있을 때만 */}
        <GraphColorLegend colors={colors} labelFor={labelFor} className="pt-0.5" />

        {/* 클러스터링 상태 (§11.4 4a/4b) — 적용 결과/미적용 사유 안내 */}
        {communityActive && community.ready && (
          <p className="pt-0.5 text-[11px] text-muted-foreground">
            자동 클러스터 {community.count}개
            {communityBridge ? ' · 관련정보로 묶음' : ''}
            {graph?.truncated ? ' · 표시된 노드 기준' : ''}
          </p>
        )}
        {communityNotApplied && (
          <p className="pt-0.5 text-[11px] text-muted-foreground">
            노드가 적어 자동 클러스터링을 적용하지 않았습니다 (보고서{' '}
            {COMMUNITY_MIN_NODES}개 이상 + 연결 필요).
          </p>
        )}

        {/* 클러스터 전용 범례 — 외곽선만 켜서 색 기준이 클러스터가 아닐 때, 덩어리
            색이 뭘 뜻하는지 보여준다. 색=자동 클러스터면 위 범례가 이미 같은 역할 */}
        {community.ready &&
          clusterHull &&
          colorBy !== 'community' &&
          community.colorOf && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5">
              <span className="text-[11px] font-medium text-muted-foreground">
                클러스터
              </span>
              {[...community.labelOf]
                .filter(([k]) => k !== SMALL_KEY)
                .map(([k, label]) => (
                  <span
                    key={String(k)}
                    className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"
                  >
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: community.colorOf.get(k) }}
                    />
                    {label}
                  </span>
                ))}
            </div>
          )}
      </div>

      <LinkGraphCanvas
        graph={graph}
        active
        onNodeClick={handleNodeClick}
        overlay={overlay}
        nodeColor={nodeColor}
        timeline={timeline}
        laneOf={timeline ? laneOf : null}
        timeFilter={timeBar ? playRange : null}
        searchQuery={searchQuery}
        clusters={clusters}
      />

      {/* 타임바 (Phase 3 (3)) — 캔버스 아래 전용 스트립 */}
      {timeBar && timeBounds && (
        <GraphTimeBar
          bounds={timeBounds}
          dates={reportDates}
          range={playRange}
          onRangeChange={handleRangeChange}
          playing={playing}
          onTogglePlay={togglePlay}
        />
      )}
    </div>
  )
}
