import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Share2, ArrowUpRight } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import { Button } from '@/shared/components/ui/button'
import { getEntityGraph, listRelationTypes } from '@/shared/api/entities'
import { EntityGraphView } from './EntityGraphView'

/**
 * 엔티티 주변 2단계 서브그래프를 force 그래프로 보여주는 읽기전용 다이얼로그
 * (GET /entities/{id}/graph). 관리자 화면(엔티티 관리)과 일반 사용자 진입점
 * (보고서 상세 "관련 정보")이 같은 컴포넌트를 공유한다 — 백엔드가 호출자
 * 권한에 따라 deprecated 노출 여부를 가르므로(비관리자=active만) 프론트는
 * 동일하게 호출하면 된다.
 *
 * props:
 *   entityId: number      중심 엔티티 id (필수)
 *   label: string         제목에 쓸 표시값(없으면 id)
 *   onClose()
 */
export function EntityGraphDialog({ entityId, label, onClose }) {
  const navigate = useNavigate()
  const [graph, setGraph] = useState(null) // null=loading
  const [relTypes, setRelTypes] = useState([])
  const [seed, setSeed] = useState({ id: entityId, label }) // 노드 클릭 시 재중심
  const [error, setError] = useState(false)

  // entityId(prop) 가 바뀌면 시드 초기화 — 같은 다이얼로그를 다른 칩에서 재사용.
  useEffect(() => {
    setSeed({ id: entityId, label })
  }, [entityId, label])

  useEffect(() => {
    if (seed.id == null) return undefined
    let cancelled = false
    setGraph(null)
    setError(false)
    Promise.all([
      getEntityGraph(seed.id, { depth: 2 }),
      listRelationTypes().catch(() => ({ items: [] })),
    ])
      .then(([g, rt]) => {
        if (cancelled) return
        setGraph(g)
        setRelTypes(rt?.items ?? [])
      })
      .catch(() => !cancelled && setError(true))
    return () => {
      cancelled = true
    }
  }, [seed.id])

  const relTypeLabels = useMemo(() => {
    const m = new Map()
    for (const rt of relTypes) m.set(rt.slug, rt.label)
    return m
  }, [relTypes])

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[80vh] max-h-[80vh] w-[80vw] max-w-[80vw] flex-col overflow-hidden">
        <DialogHeader>
          <div className="flex items-center justify-between gap-2 pr-6">
            <DialogTitle className="flex items-center gap-2">
              <Share2 className="h-4 w-4" /> 관계도 — {seed.label ?? seed.id}
            </DialogTitle>
            {seed.id != null && (
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => {
                  onClose()
                  navigate(`/entities/${seed.id}`)
                }}
              >
                프로필 열기 <ArrowUpRight className="ml-1 h-3.5 w-3.5" />
              </Button>
            )}
          </div>
          <DialogDescription>
            이 값 주변 2단계 관계 그래프. 노드를 끌어 배치하고 휠로 확대/축소하며,
            노드를 클릭하면 그 값 중심으로 다시 그립니다. 다이아몬드 = 엔티티(축별
            색), 화살표 = 관계(가리키면 종류 표시).
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1">
          {error ? (
            <div className="flex h-full items-center justify-center text-sm text-destructive">
              그래프를 불러오지 못했습니다.
            </div>
          ) : graph === null ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              불러오는 중…
            </div>
          ) : (
            <EntityGraphView
              graph={graph}
              centerId={seed.id}
              relTypeLabels={relTypeLabels}
              active
              onNodeClick={(node) => {
                if (node?.kind === 'system' && node.refType) {
                  // system 객체(부서)는 재중심 대신 그 객체 프로필로 이동.
                  onClose()
                  navigate(`/objects/${node.refType}/${node.refId}`)
                } else if (node?.id != null && node.id !== seed.id) {
                  setSeed({ id: node.id, label: node.label })
                }
              }}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
