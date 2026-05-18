import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { WorkspaceCombobox } from '@/shared/components/WorkspaceCombobox'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import { createComposite } from '@/shared/api/composites'
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
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState('recurring')
  const [periodDate, setPeriodDate] = useState(todayIsoDate())
  const [wsSlug, setWsSlug] = useState(currentWorkspaceSlug)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (open) {
      setTitle('')
      setKind('recurring')
      setPeriodDate(todayIsoDate())
      setWsSlug(currentWorkspaceSlug)
    }
  }, [open, currentWorkspaceSlug])

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
  )
}

function todayIsoDate() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
