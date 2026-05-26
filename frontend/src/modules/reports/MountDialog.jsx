/** 게시 다이얼로그 — 보고서를 조직 게시판에 link.
 *
 * Personal 공간의 보고서를 N개 조직 게시판에 동시에 게시/해제. 사용자가
 * 멤버인 org 워크스페이스만 노출. 이미 게시된 게시판은 체크 상태로 표시,
 * 해제도 같은 다이얼로그에서 가능.
 *
 * 권한 모델 (Phase 1): 작성자 본인만 게시/해제 가능 (Phase 3에서 보직장
 * 자동 권한 추가). Edit policy preset은 Phase 3에서 노출 — Phase 1은 모두
 * `default`로 고정.
 */
import * as React from 'react'
import { Check, Loader2, Building2, AlertCircle } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import { Button } from '@/shared/components/ui/button'
import { Textarea } from '@/shared/components/ui/textarea'
import { toast } from 'sonner'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import { useAuth } from '@/shared/auth/AuthContext'
import {
  listMounts,
  mountReport,
  unmountReport,
  setMountFolder,
  setMountEditPolicy,
} from '@/shared/api/mounts'
import { FolderPickerButton } from './FolderPickerButton'
import { cn } from '@/shared/lib/utils'

/** Edit policy options for the per-mount dropdown. The short labels go
 *  on the chip; the descriptions appear in the dropdown row + tooltip
 *  so users learn the semantics without a separate help page. */
const POLICY_OPTIONS = [
  {
    value: 'default',
    label: '기본',
    description: '작성자 + 보직장 편집 가능',
  },
  {
    value: 'owner_only',
    label: '작성자 전용',
    description: '보직장도 차단, 작성자만 편집',
  },
  {
    value: 'coauthor',
    label: '공동 작성',
    description: '게시판 멤버 누구나 편집',
  },
]
const POLICY_BY_VALUE = Object.fromEntries(
  POLICY_OPTIONS.map((o) => [o.value, o]),
)

export function MountDialog({ open, onOpenChange, report, onChanged }) {
  const { all, getDescendantsInclusive } = useWorkspace()
  const { me } = useAuth()

  const [mounts, setMounts] = React.useState([])
  const [pending, setPending] = React.useState({}) // slug → 'mounting' | 'unmounting'
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState(null)
  const [note, setNote] = React.useState('')
  const isOwner = me?.user?.id && report?.owner_user_id === me.user.id

  // Eligible boards = org workspaces the user can publish to.
  // Mirrors the backend's ancestor-walk permission check: membership
  // at a parent (e.g. 본부) grants publish rights to every descendant
  // team. So we union descendants of every direct org membership.
  const eligibleSlugs = React.useMemo(() => {
    const set = new Set()
    for (const m of me?.memberships ?? []) {
      const slug = m.workspace_slug
      if (!slug || slug.startsWith('personal-')) continue
      for (const s of getDescendantsInclusive(slug)) set.add(s)
    }
    return set
  }, [me, getDescendantsInclusive])

  const eligible = React.useMemo(
    () =>
      all
        .filter(
          (w) =>
            w.kind === 'org' &&
            !w.virtual &&
            eligibleSlugs.has(w.slug),
        )
        .sort((a, b) => a.name.localeCompare(b.name)),
    [all, eligibleSlugs],
  )

  const mountedSlugs = React.useMemo(
    () => new Set(mounts.map((m) => m.workspace_slug)),
    [mounts],
  )

  React.useEffect(() => {
    if (!open || !report?.id) return
    let cancelled = false
    setLoading(true)
    setError(null)
    listMounts(report.id)
      .then((rows) => {
        if (!cancelled) setMounts(rows)
      })
      .catch((e) => {
        if (!cancelled) setError(e?.message || String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, report?.id])

  async function handlePolicyChange(workspaceSlug, nextPolicy) {
    // Optimistic local update; revert on failure.
    const prev = mounts
    setMounts((arr) =>
      arr.map((m) =>
        m.workspace_slug === workspaceSlug
          ? { ...m, edit_policy: nextPolicy }
          : m,
      ),
    )
    try {
      await setMountEditPolicy({
        reportId: report.id,
        workspaceSlug,
        editPolicy: nextPolicy,
      })
      toast.success(
        `편집 정책: ${POLICY_BY_VALUE[nextPolicy]?.label ?? nextPolicy}`,
      )
      onChanged?.()
    } catch (e) {
      setMounts(prev)
      toast.error(
        e?.response?.data?.message || '편집 정책 변경 실패',
      )
    }
  }

  async function handleToggle(workspaceSlug) {
    if (pending[workspaceSlug]) return
    const isMounted = mountedSlugs.has(workspaceSlug)
    setPending((p) => ({ ...p, [workspaceSlug]: isMounted ? 'unmounting' : 'mounting' }))
    try {
      const ws = eligible.find((w) => w.slug === workspaceSlug)
      const wsLabel = ws?.name || workspaceSlug
      if (isMounted) {
        await unmountReport({ reportId: report.id, workspaceSlug })
        setMounts((prev) => prev.filter((m) => m.workspace_slug !== workspaceSlug))
        toast.success(`${wsLabel} 게시판에서 해제`)
      } else {
        // New mounts always start with the `default` policy. To use a
        // different policy, the user changes it via the per-row
        // dropdown after the board appears as 게시됨. Keeps the dialog
        // to one knob (per-board), not two.
        const created = await mountReport({
          reportId: report.id,
          workspaceSlugs: [workspaceSlug],
          note: note.trim() || undefined,
        })
        setMounts((prev) => [...prev, ...created])
        toast.success(`${wsLabel} 게시판에 게시`)
      }
      onChanged?.()
    } catch (e) {
      const msg = e?.response?.data?.message || e?.message || '게시 작업 실패'
      toast.error(msg)
    } finally {
      setPending((p) => {
        const next = { ...p }
        delete next[workspaceSlug]
        return next
      })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>조직 게시판에 게시</DialogTitle>
          <DialogDescription>
            보고서를 조직 게시판에 연결하면 멤버가 열람·코멘트할 수 있습니다.
            원본은 내 공간에 그대로 남고, 수정 시 게시판에도 즉시 반영됩니다.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin mr-2" /> 게시 현황 조회 중...
          </div>
        ) : error ? (
          <div className="flex items-center gap-2 rounded border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        ) : eligible.length === 0 ? (
          <div className="text-sm text-muted-foreground py-4">
            게시할 수 있는 조직 게시판이 없습니다. 워크스페이스에 멤버로
            등록되어 있어야 게시 가능합니다.
          </div>
        ) : (
          <div className="space-y-3">
            <div className="max-h-80 overflow-y-auto -mx-2 px-2 space-y-1">
              {eligible.map((ws) => {
                const isMounted = mountedSlugs.has(ws.slug)
                const isPending = Boolean(pending[ws.slug])
                const mount = mounts.find((m) => m.workspace_slug === ws.slug)
                return (
                  <div
                    key={ws.slug}
                    className={cn(
                      'flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
                      isMounted
                        ? 'border-primary/40 bg-primary/5'
                        : 'border-border',
                      isPending && 'opacity-60',
                    )}
                  >
                    {/* Workspace toggle (click row body to mount/unmount) */}
                    <button
                      type="button"
                      disabled={isPending}
                      onClick={() => handleToggle(ws.slug)}
                      className="flex items-center gap-2 flex-1 min-w-0 text-left hover:bg-muted/30 rounded -ml-1 px-1 py-0.5"
                      title={isMounted ? '게시 해제' : '게시'}
                    >
                      <span
                        className="h-2.5 w-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: ws.color }}
                      />
                      <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="flex-1 truncate">{ws.name}</span>
                      {isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                      ) : isMounted ? (
                        <span className="flex items-center gap-1 text-xs text-primary shrink-0">
                          <Check className="h-3.5 w-3.5" />
                          게시됨
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground shrink-0">게시</span>
                      )}
                    </button>
                    {/* Folder picker — only shown for currently-mounted
                        boards. New mounts go to 미분류; user can pick
                        a folder here without leaving the dialog. */}
                    {isMounted && (
                      <FolderPickerButton
                        mode="org"
                        workspaceSlug={ws.slug}
                        reportId={report.id}
                        folderId={mount?.folder_id ?? null}
                        onChanged={(newFolderId) => {
                          setMounts((prev) =>
                            prev.map((m) =>
                              m.workspace_slug === ws.slug
                                ? { ...m, folder_id: newFolderId }
                                : m,
                            ),
                          )
                          onChanged?.()
                        }}
                      />
                    )}
                    {/* Per-mount edit-policy. Hidden for non-owners
                        (server rejects change anyway; rendering would
                        just confuse). */}
                    {isMounted && isOwner && (
                      <select
                        value={mount?.edit_policy ?? 'default'}
                        onChange={(e) =>
                          handlePolicyChange(ws.slug, e.target.value)
                        }
                        className="text-[11px] rounded border bg-background px-1.5 py-1 hover:border-primary/60 cursor-pointer"
                        title={
                          POLICY_BY_VALUE[mount?.edit_policy ?? 'default']
                            ?.description
                        }
                      >
                        {POLICY_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                )
              })}
            </div>

            <div className="border-t pt-3">
              <label className="text-xs text-muted-foreground block mb-1">
                게시 메모 (선택, 새 게시에만 적용)
              </label>
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="예: 본부 보고 자료로 활용 부탁드립니다."
                rows={2}
                className="resize-none text-sm"
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            닫기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
