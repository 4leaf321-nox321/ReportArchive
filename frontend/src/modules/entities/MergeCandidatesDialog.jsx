import { useEffect, useState } from 'react'
import { GitMerge, Loader2, RefreshCw, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/shared/components/ui/dialog'
import { Button } from '@/shared/components/ui/button'
import { Badge } from '@/shared/components/ui/badge'
import {
  scanMergeCandidates,
  dismissMergePair,
  mergeEntity,
} from '@/shared/api/entities'

/**
 * 중복/동의어 후보 검토 (엔티티머지보조_설계.md). 한 축을 스캔해 중복 후보
 * 클러스터를 보여주고, 관리자가 대표값을 골라 머지하거나 "중복 아님"으로 기각한다.
 *
 * 탐지는 넓은 그물(L0 정규화 + L1 임베딩 ≥0.6)이라 한 클러스터에 오탐(예: S26 vs
 * S26 Ultra)이 섞일 수 있다 → 멤버별 **포함 체크박스 + 생존 라디오**로 부분 머지를
 * 지원하고, 제외한 멤버는 생존값과의 쌍을 기각해 재출현을 막는다.
 */
export function MergeCandidatesDialog({ type, onClose, onChanged }) {
  const [loading, setLoading] = useState(true)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  async function scan() {
    setLoading(true)
    setError(null)
    try {
      const res = await scanMergeCandidates(type.id)
      setResult(res)
    } catch (e) {
      setError(e?.response?.data?.message || e?.message || '스캔 실패')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    scan()
    // 다이얼로그 열릴 때 1회 스캔.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type.id])

  const clusters = result?.clusters ?? []

  return (
    <Dialog open onOpenChange={(o) => !o && onClose?.()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitMerge className="h-4 w-4 text-violet-500" /> 중복 후보 검토 ·{' '}
            {type.label}
          </DialogTitle>
          <DialogDescription>
            같은 대상을 가리키는 값을 찾아 합칩니다. 후보는 넓게 잡히므로(오탐 포함),
            합칠 값만 체크하고 대표값을 고르세요. 합치면 되돌릴 수 없습니다.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[55vh] space-y-3 overflow-y-auto pr-1">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> 스캔 중…
            </div>
          ) : error ? (
            <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              <AlertTriangle className="h-4 w-4" /> {error}
            </div>
          ) : clusters.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              중복 후보가 없습니다. (스캔 {result?.scanned ?? 0}개 값)
              {result?.backend === 'mock' && (
                <div className="mt-1 text-xs">
                  ※ 임베딩이 mock이라 표기 정규화(L0)만 비교했습니다.
                </div>
              )}
            </div>
          ) : (
            clusters.map((cl, i) => (
              <ClusterCard
                key={i}
                typeId={type.id}
                cluster={cl}
                onResolved={() => {
                  // 한 클러스터 처리 후 화면에서 제거 + 상위 목록 새로고침.
                  setResult((prev) => ({
                    ...prev,
                    clusters: prev.clusters.filter((_, idx) => idx !== i),
                  }))
                  onChanged?.()
                }}
              />
            ))
          )}
          {result?.truncated && (
            <div className="text-xs text-amber-600">
              값이 많아 일부만 평가했습니다(상한 초과). 정리 후 다시 스캔하세요.
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            닫기
          </Button>
          <Button variant="outline" size="sm" onClick={scan} disabled={loading}>
            <RefreshCw className="mr-1 h-3.5 w-3.5" /> 다시 스캔
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ClusterCard({ typeId, cluster, onResolved }) {
  const members = cluster.members ?? []
  // 포함 여부(기본 전부 포함) + 생존값(기본=추천).
  const [included, setIncluded] = useState(() => new Set(members.map((m) => m.id)))
  const [survivorId, setSurvivorId] = useState(cluster.suggested_survivor_id)
  const [busy, setBusy] = useState(false)

  function toggle(id) {
    setIncluded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const includedIds = members.map((m) => m.id).filter((id) => included.has(id))
  const survivorOk = included.has(survivorId)
  const mergeCount = includedIds.filter((id) => id !== survivorId).length

  async function handleMerge() {
    if (busy) return
    if (!survivorOk) {
      toast.error('대표값은 포함된 값 중에서 골라주세요.')
      return
    }
    if (mergeCount < 1) {
      toast.error('합칠 값을 1개 이상 포함하세요.')
      return
    }
    if (
      !window.confirm(
        `${mergeCount}개 값을 '${
          members.find((m) => m.id === survivorId)?.value
        }'(으)로 합칩니다. 되돌릴 수 없습니다. 계속할까요?`,
      )
    )
      return
    setBusy(true)
    try {
      // 포함된 비-생존값 → 생존값으로 머지.
      for (const id of includedIds) {
        if (id === survivorId) continue
        await mergeEntity(id, survivorId)
      }
      // 제외한 값은 생존값과의 쌍을 기각해 재출현 차단(오탐 정리).
      for (const m of members) {
        if (!included.has(m.id) && m.id !== survivorId) {
          await dismissMergePair(typeId, m.id, survivorId).catch(() => {})
        }
      }
      toast.success(`${mergeCount}개 값을 합쳤습니다.`)
      onResolved?.()
    } catch (e) {
      toast.error(e?.response?.data?.message || e?.message || '머지 실패')
      setBusy(false)
    }
  }

  async function handleDismissAll() {
    if (busy) return
    setBusy(true)
    try {
      // 클러스터의 모든 쌍을 기각(이 묶음은 중복이 아님).
      for (let a = 0; a < members.length; a++) {
        for (let b = a + 1; b < members.length; b++) {
          await dismissMergePair(typeId, members[a].id, members[b].id).catch(
            () => {},
          )
        }
      }
      toast.success('중복 아님으로 표시했습니다.')
      onResolved?.()
    } catch {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-md border p-3">
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        {cluster.exact ? (
          <Badge variant="secondary">표기 일치</Badge>
        ) : (
          <Badge variant="outline">유사 {cluster.score ?? ''}</Badge>
        )}
        <span>합칠 값 체크 · 대표값(◉) 선택</span>
      </div>
      <div className="space-y-1.5">
        {members.map((m) => {
          const inc = included.has(m.id)
          return (
            <div
              key={m.id}
              className="flex items-center gap-2 rounded px-1 py-0.5 text-sm"
            >
              <input
                type="checkbox"
                checked={inc}
                onChange={() => toggle(m.id)}
                className="h-3.5 w-3.5"
                title="합치기에 포함"
              />
              <input
                type="radio"
                name={`survivor-${members.map((x) => x.id).join('-')}`}
                checked={survivorId === m.id}
                disabled={!inc}
                onChange={() => setSurvivorId(m.id)}
                className="h-3.5 w-3.5"
                title="대표값(생존)"
              />
              <span className={inc ? '' : 'text-muted-foreground line-through'}>
                {m.value}
                {m.code ? (
                  <span className="ml-1 text-xs text-muted-foreground">
                    ({m.code})
                  </span>
                ) : null}
              </span>
              <span className="ml-auto text-xs text-muted-foreground">
                {m.usage_count}건
              </span>
            </div>
          )
        })}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" onClick={handleMerge} disabled={busy}>
          {busy ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <GitMerge className="mr-1 h-3.5 w-3.5" />
          )}
          합치기{mergeCount > 0 ? ` (${mergeCount})` : ''}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleDismissAll}
          disabled={busy}
        >
          중복 아님
        </Button>
      </div>
    </div>
  )
}
