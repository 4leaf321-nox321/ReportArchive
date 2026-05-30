// 보고서 관계도 모달 (지식그래프 Phase 1a) — 중심 보고서를 기준으로
// explicit link 를 ±depth hop 따라간 관계도를 모달로 띄운다. 실제 그래프
// 렌더는 LinkGraphCanvas 가 담당하고, 여기선 fetch + 깊이 컨트롤 + 빈/에러
// 메시지만 다룬다 (글로벌 페이지 ReportGraphPage 와 캔버스를 공유).
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2, Network, Search, X } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/shared/components/ui/dialog'
import { getReportLinkGraph } from '@/shared/api/reportLinks'
import { listReportTypes } from '@/shared/api/reportTypes'
import { LinkGraphCanvas } from './LinkGraphCanvas'
import { GraphTagLayer, DEFAULT_TAG_AXES } from './GraphTagLayer'
import { useGraphColors, GraphColorLegend } from './graphColorMapping'

/**
 * @param {object}  props
 * @param {boolean} props.open
 * @param {(v:boolean)=>void} props.onOpenChange
 * @param {number}  props.reportId      중심 보고서 id
 * @param {string=} props.reportTitle   헤더 표기용 (선택)
 */
export function ReportGraphModal({ open, onOpenChange, reportId, reportTitle }) {
  const navigate = useNavigate()

  const [depth, setDepth] = useState(2)
  // 관련정보(entity) 레이어 — 축 선택 + 공유 태그만(부품 폭증 방지)
  const [tagLayer, setTagLayer] = useState({
    enabled: false,
    axes: DEFAULT_TAG_AXES,
    sharedOnly: true,
  })
  const [searchQuery, setSearchQuery] = useState('') // 노드 검색 하이라이트
  const [includeComposites, setIncludeComposites] = useState(false) // 종합보고 hub
  const [colorBy, setColorBy] = useState('type') // 색 기준 (종류/작성자/단색)
  const [typeOptions, setTypeOptions] = useState([]) // [{id,name}] — 종류 범례용
  const [graph, setGraph] = useState(null) // 서버 응답 원본
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  // 종류 카탈로그 (색 범례 이름용) — 모달이 처음 열릴 때 1회.
  useEffect(() => {
    if (!open || typeOptions.length) return
    let cancelled = false
    listReportTypes({ limit: 200 })
      .then((res) => {
        if (cancelled) return
        const items = res?.items ?? res ?? []
        setTypeOptions(
          (Array.isArray(items) ? items : []).map((t) => ({ id: t.id, name: t.name })),
        )
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [open, typeOptions.length])
  const typeNameById = useMemo(
    () => new Map(typeOptions.map((t) => [t.id, t.name])),
    [typeOptions],
  )
  const { colors, nodeColor, labelFor } = useGraphColors({
    graph,
    colorBy,
    typeNameById,
  })

  // open + reportId + depth + tagLayer 변화에 반응해 fetch. 닫히면 비움.
  useEffect(() => {
    if (!open || !reportId) {
      setGraph(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    getReportLinkGraph(reportId, {
      depth,
      includeTags: tagLayer.enabled,
      tagAxes: tagLayer.axes,
      tagMinDegree: tagLayer.sharedOnly ? 2 : 1,
      includeComposites,
    })
      .then((data) => {
        if (!cancelled) setGraph(data)
      })
      .catch((err) => {
        if (!cancelled) {
          console.warn('getReportLinkGraph failed', err)
          setError('관계도를 불러오지 못했습니다.')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, reportId, depth, tagLayer, includeComposites])

  const nodeCount = graph?.nodes?.length ?? 0
  const edgeCount = graph?.edges?.length ?? 0
  // 로컬 그래프는 중심 노드가 항상 있다. 이웃이 없어도 자기 자신 노드는
  // 그대로 보여 주는 게 맞으므로, 안내 메시지는 노드가 0개일 때만(=로드 실패
  // 등 사실상 없는 경우) 띄운다. 중심 1개만 있을 땐 메시지 없이 노드만.
  const isEmpty = !loading && !error && nodeCount === 0

  const handleNodeClick = useCallback(
    (node) => {
      if (!node || node.is_center) return // 중심 = 현재 보고서
      if (node.type === 'report') {
        onOpenChange?.(false)
        navigate(`/w/${node.workspace_slug}/reports/${node.report_id}`)
      } else if (node.type === 'composite') {
        onOpenChange?.(false)
        navigate(`/w/${node.workspace_slug}/composites/${node.composite_id}`)
      }
    },
    [navigate, onOpenChange],
  )

  const overlay = (
    <>
      {error && (
        <div className="absolute inset-0 grid place-items-center text-sm text-destructive">
          {error}
        </div>
      )}
      {isEmpty && (
        <div className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-muted-foreground">
          아직 연결된 보고서가 없습니다.
          <br />
          본문 하단「연결된 보고서」에서 다른 보고서와 연결해 보세요.
        </div>
      )}
    </>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex flex-col max-w-[min(96vw,1100px)] w-[min(96vw,1100px)] h-[80vh] p-0 gap-0 overflow-hidden">
        <DialogHeader className="shrink-0 px-5 pt-4 pb-3 border-b">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Network className="h-4 w-4" />
            관계도
            {reportTitle && (
              <span className="text-muted-foreground font-normal truncate">
                · {reportTitle}
              </span>
            )}
          </DialogTitle>
          <DialogDescription className="sr-only">
            이 보고서와 연결된 보고서들의 관계도
          </DialogDescription>
          {/* 컨트롤 바 — 깊이 슬라이더 + 노드/엣지 수 + truncated 안내 */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              깊이
              <input
                type="range"
                min={1}
                max={3}
                step={1}
                value={depth}
                onChange={(e) => setDepth(Number(e.target.value))}
                className="w-28 accent-indigo-500"
              />
              <span className="tabular-nums font-medium text-foreground">
                {depth} hop
              </span>
            </label>
            {/* 관련정보(entity) 레이어 — 축 선택 + 공유 태그만 (지식그래프 §2.1) */}
            <GraphTagLayer
              enabled={tagLayer.enabled}
              axes={tagLayer.axes}
              sharedOnly={tagLayer.sharedOnly}
              onChange={setTagLayer}
            />
            {/* 종합보고 레이어 (Phase 4) — 이 보고서를 묶는 hub 노드 */}
            <button
              type="button"
              onClick={() => setIncludeComposites((v) => !v)}
              className={
                includeComposites
                  ? 'h-7 rounded-md border border-amber-300 bg-amber-50 px-2 text-[11px] font-medium text-amber-700'
                  : 'h-7 rounded-md border border-border bg-background px-2 text-[11px] font-medium text-muted-foreground hover:bg-muted'
              }
              title="이 보고서를 묶는 종합보고를 hub 노드로 표시"
            >
              종합보고
            </button>
            {/* 색 기준 (Phase 2 — 모달 적용) */}
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              색
              <select
                value={colorBy}
                onChange={(e) => setColorBy(e.target.value)}
                className="h-7 rounded-md border bg-background px-2 text-[11px]"
              >
                <option value="type">보고서 종류</option>
                <option value="owner">작성자</option>
                <option value="none">단색</option>
              </select>
            </label>
            <span className="text-xs text-muted-foreground tabular-nums">
              노드 {nodeCount} · 연결 {edgeCount}
            </span>
            {graph?.truncated && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                일부만 표시 — 너무 큽니다 (깊이를 줄이세요)
              </span>
            )}
            {loading && (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
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
          </div>
          {/* 색 범례 — 색 기준이 켜져 있고 범주가 있을 때만 */}
          <GraphColorLegend colors={colors} labelFor={labelFor} className="pt-1" />
        </DialogHeader>

        <LinkGraphCanvas
          graph={graph}
          active={open}
          onNodeClick={handleNodeClick}
          overlay={overlay}
          nodeColor={nodeColor}
          searchQuery={searchQuery}
        />
      </DialogContent>
    </Dialog>
  )
}
