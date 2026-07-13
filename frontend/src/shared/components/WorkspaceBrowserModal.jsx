import * as React from 'react'
import { toast } from 'sonner'
import {
  Search,
  Users,
  Building2,
  Archive,
  ArchiveRestore,
  Plus,
  Check,
  Trash2,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/shared/components/ui/dialog'
import { Input } from '@/shared/components/ui/input'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import { useAuth } from '@/shared/auth/AuthContext'
import { deleteTf, setWorkspaceArchived } from '@/shared/api/workspaces'
import { TfCreateDialog } from '@/shared/components/TfCreateDialog'
import { cn } from '@/shared/lib/utils'

/**
 * 조직 브라우저 모달 — 작은 드롭다운으로는 수십 개 부서를 찾기 어려워, 큰
 * 2단 화면으로 탐색·선택한다(좌=공식 조직도 트리, 우=내 TF 리스트). 검색은
 * 두 칸을 동시에 필터한다. 선택 시 즉시 부서를 전환하고 모달을 닫는다.
 *
 * WorkspaceSelector 의 확대 버튼이 호출. 자체적으로 useWorkspace/useAuth 에서
 * 필요한 것을 끌어 쓰므로 props 는 open/onOpenChange 만 받는다.
 */
export function WorkspaceBrowserModal({ open, onOpenChange }) {
  const {
    all,
    orgSlug,
    switchWorkspace,
    buildTree,
    flattenTree,
    getPath,
    reload,
  } = useWorkspace()
  const { me } = useAuth()

  const [query, setQuery] = React.useState('')
  const [showArchived, setShowArchived] = React.useState(false) // TF 보관
  const [showArchivedOrg, setShowArchivedOrg] = React.useState(false) // org 보관
  const [createOpen, setCreateOpen] = React.useState(false)
  const q = query.trim().toLowerCase()

  // 모달 열릴 때마다 검색어 초기화.
  React.useEffect(() => {
    if (open) setQuery('')
  }, [open])

  // 공식 조직도(트리 밖 TF·가상·개인 제외) → 평면 + depth.
  const orgFlat = React.useMemo(() => {
    return flattenTree(buildTree({ includeVirtual: false, includePersonal: false }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildTree, flattenTree, all])

  // 보관된 org 부서는 기본 숨김(개편이 잦아 쌓이면 지저분). 토글로만 노출 —
  // TF 와 동일 패턴. O1 덕분에 보관 노드를 숨겨도 활성 부서가 고아가 되지 않는다.
  const archivedOrgCount = orgFlat.filter((w) => w.status === 'archived').length
  const visibleOrgFlat = showArchivedOrg
    ? orgFlat
    : orgFlat.filter((w) => w.status !== 'archived')

  const tfs = React.useMemo(() => all.filter((w) => w.kind === 'tf'), [all])
  const activeTfs = tfs.filter((w) => w.status !== 'archived')
  const archivedTfs = tfs.filter((w) => w.status === 'archived')
  const visibleTfs = showArchived ? tfs : activeTfs

  const pathLabel = (slug) =>
    getPath(slug)
      .map((p) => p.name)
      .slice(0, -1)
      .join(' / ')

  const matches = (w) => {
    if (!q) return true
    return (
      w.name.toLowerCase().includes(q) ||
      w.slug.toLowerCase().includes(q) ||
      pathLabel(w.slug).toLowerCase().includes(q)
    )
  }

  const orgRows = visibleOrgFlat.filter(matches)
  const tfRows = visibleTfs.filter(matches)

  // 보직장(org 매니저) 이상이면 TF 개설 가능(서버도 동일 게이트).
  const isSysAdmin = me?.is_system_admin === true
  const isLead =
    isSysAdmin ||
    (me?.memberships || []).some(
      (m) => m.role === 'manager' && m.workspace_kind === 'org',
    )
  const canManageTf = (slug) =>
    isSysAdmin ||
    (me?.memberships || []).find((m) => m.workspace_slug === slug)?.role ===
      'manager'

  function pick(slug) {
    switchWorkspace(slug)
    onOpenChange(false)
  }

  async function handleArchiveToggle(ws) {
    const next = ws.status !== 'archived'
    try {
      await setWorkspaceArchived(ws.slug, next)
      toast.success(next ? `'${ws.name}' 보관됨` : `'${ws.name}' 복원됨`)
      await reload()
    } catch (err) {
      toast.error(err?.response?.data?.message || err.message || '변경 실패')
    }
  }

  async function handleDeleteTf(ws) {
    const ok = window.confirm(
      `'${ws.name}' TF를 완전히 삭제합니다.\n\n` +
        `멤버·폴더·게시·공유가 함께 사라지며 되돌릴 수 없습니다. ` +
        `(이 TF가 소유한 보고서가 있으면 삭제가 거부됩니다.)\n\n계속할까요?`,
    )
    if (!ok) return
    try {
      await deleteTf(ws.slug)
      toast.success(`'${ws.name}' TF가 삭제되었습니다`)
      await reload()
    } catch (err) {
      toast.error(err?.response?.data?.message || err.message || '삭제 실패')
    }
  }

  async function handleTfCreated(ws) {
    await reload()
    if (ws?.slug) pick(ws.slug)
  }

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>조직 / TF 선택</DialogTitle>
          <DialogDescription>
            왼쪽은 공식 조직도, 오른쪽은 참여 중인 TF입니다. 항목을 누르면 해당
            워크스페이스로 이동합니다.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="부서·TF 이름으로 검색…"
            className="pl-8"
            autoFocus
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          {/* ── 좌: 공식 조직도 ───────────────────────────────── */}
          <section className="min-w-0">
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Building2 className="h-3.5 w-3.5" />
              공식 조직도
            </div>
            <div className="h-[55vh] overflow-y-auto rounded-md border">
              {orgRows.length === 0 ? (
                <Empty>일치하는 부서가 없습니다.</Empty>
              ) : (
                orgRows.map((w) => (
                  <Row
                    key={w.slug}
                    active={orgSlug === w.slug}
                    onClick={() => pick(w.slug)}
                    indent={q ? 0 : (w.depth ?? 0) * 14}
                  >
                    <span
                      className="h-2 w-2 rounded-full shrink-0"
                      style={{ backgroundColor: w.color }}
                    />
                    <div className="flex min-w-0 flex-col">
                      <span
                        className={cn(
                          'truncate text-sm',
                          w.status === 'archived' && 'text-muted-foreground',
                        )}
                      >
                        {w.name}
                        {w.status === 'archived' && (
                          <span className="ml-1 text-[10px] text-amber-600">
                            (보관됨)
                          </span>
                        )}
                      </span>
                      {q && pathLabel(w.slug) && (
                        <span className="truncate text-[10px] text-muted-foreground">
                          {pathLabel(w.slug)}
                        </span>
                      )}
                    </div>
                  </Row>
                ))
              )}
            </div>
            {archivedOrgCount > 0 && (
              <button
                type="button"
                onClick={() => setShowArchivedOrg((v) => !v)}
                className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground"
              >
                <Archive className="h-3 w-3" />
                {showArchivedOrg
                  ? '보관된 부서 숨기기'
                  : `보관된 부서 보기 (${archivedOrgCount})`}
              </button>
            )}
          </section>

          {/* ── 우: 내 TF ─────────────────────────────────────── */}
          <section className="min-w-0">
            <div className="mb-1.5 flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Users className="h-3.5 w-3.5" />
                내 TF
              </div>
              {isLead && (
                <button
                  type="button"
                  onClick={() => setCreateOpen(true)}
                  className="flex items-center gap-1 text-[12px] text-primary hover:underline"
                >
                  <Plus className="h-3.5 w-3.5" />
                  TF 개설
                </button>
              )}
            </div>
            <div className="h-[55vh] overflow-y-auto rounded-md border">
              {tfRows.length === 0 ? (
                <Empty>
                  {tfs.length === 0
                    ? '참여 중인 TF가 없습니다.'
                    : '일치하는 TF가 없습니다.'}
                </Empty>
              ) : (
                tfRows.map((w) => (
                  <Row
                    key={w.slug}
                    active={orgSlug === w.slug}
                    onClick={() => pick(w.slug)}
                  >
                    <Users
                      className="h-3.5 w-3.5 shrink-0"
                      style={{ color: w.color }}
                    />
                    <span
                      className={cn(
                        'truncate text-sm flex-1',
                        w.status === 'archived' && 'text-muted-foreground',
                      )}
                    >
                      {w.name}
                      {w.status === 'archived' && (
                        <span className="ml-1 text-[10px] text-amber-600">
                          (보관됨)
                        </span>
                      )}
                    </span>
                    {canManageTf(w.slug) && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          handleArchiveToggle(w)
                        }}
                        className="rounded p-1 hover:bg-muted shrink-0"
                        aria-label={w.status === 'archived' ? 'TF 복원' : 'TF 보관'}
                        title={
                          w.status === 'archived'
                            ? 'TF 복원'
                            : 'TF 보관(읽기전용)'
                        }
                      >
                        {w.status === 'archived' ? (
                          <ArchiveRestore className="h-3.5 w-3.5 text-muted-foreground" />
                        ) : (
                          <Archive className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                      </button>
                    )}
                    {canManageTf(w.slug) && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          handleDeleteTf(w)
                        }}
                        className="rounded p-1 hover:bg-destructive/10 shrink-0"
                        aria-label="TF 완전 삭제"
                        title="TF 완전 삭제 (되돌릴 수 없음)"
                      >
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </button>
                    )}
                  </Row>
                ))
              )}
            </div>
            {archivedTfs.length > 0 && (
              <button
                type="button"
                onClick={() => setShowArchived((v) => !v)}
                className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground"
              >
                <Archive className="h-3 w-3" />
                {showArchived
                  ? '보관된 TF 숨기기'
                  : `보관된 TF 보기 (${archivedTfs.length})`}
              </button>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>

    <TfCreateDialog
      open={createOpen}
      onOpenChange={setCreateOpen}
      onCreated={handleTfCreated}
    />
    </>
  )
}

// Row 는 div(role=button) — 내부에 보관/복원 버튼을 중첩하므로 <button> 으로
// 두면 button-in-button 이 되어 잘못된 DOM 이 된다.
function Row({ active, onClick, indent = 0, children }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
      className={cn(
        'flex w-full cursor-pointer items-center gap-2 px-2 py-1.5 text-left hover:bg-muted focus:bg-muted outline-none',
        active && 'bg-muted',
      )}
      style={{ paddingLeft: 8 + indent }}
    >
      {children}
      {active && <Check className="ml-auto h-4 w-4 text-primary shrink-0" />}
    </div>
  )
}

function Empty({ children }) {
  return (
    <div className="px-3 py-6 text-center text-xs text-muted-foreground">
      {children}
    </div>
  )
}
