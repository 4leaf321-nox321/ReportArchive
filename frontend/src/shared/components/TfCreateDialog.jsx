import * as React from 'react'
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
import { Textarea } from '@/shared/components/ui/textarea'
import { createTfWorkspace } from '@/shared/api/workspaces'

/**
 * TF(태스크포스) 개설 다이얼로그 — 보직장(org 매니저) 이상 self-service
 * (TF조직_설계.md §4). 이름 + (선택) 차출 멤버 이메일. 멤버는 부서 무관
 * (cross-functional). 개설자는 자동으로 매니저가 된다. 성공 시 onCreated(ws).
 *
 * ⚠ Popover 안에서 열면 Popover 가 닫히며 언마운트되므로, 이 다이얼로그는
 * WorkspaceSelector 최상위(Popover 바깥)에서 렌더해야 한다.
 */
export function TfCreateDialog({ open, onOpenChange, onCreated }) {
  const [name, setName] = React.useState('')
  const [emailsText, setEmailsText] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)

  React.useEffect(() => {
    if (open) {
      setName('')
      setEmailsText('')
      setSubmitting(false)
    }
  }, [open])

  async function handleSubmit(e) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) {
      toast.error('TF 이름을 입력하세요.')
      return
    }
    // 쉼표·줄바꿈·공백으로 구분된 이메일을 분리.
    const memberEmails = emailsText
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    setSubmitting(true)
    try {
      const { data, message } = await createTfWorkspace({
        name: trimmed,
        memberEmails,
      })
      toast.success(`TF '${data.name}' 개설됨`)
      if (message) toast.warning(message) // 미가입 이메일 등 부분 성공 안내
      onOpenChange(false)
      onCreated?.(data)
    } catch (err) {
      toast.error(
        err?.response?.data?.message || err.message || 'TF 개설 실패',
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>TF 개설</DialogTitle>
            <DialogDescription>
              공식 조직도 밖의 한시 조직입니다. 개설자가 매니저가 되며, 멤버는
              부서와 무관하게 차출할 수 있습니다.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="tf-name">TF 이름</Label>
              <Input
                id="tf-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="예: 차세대 플랫폼 TF"
                autoFocus
                maxLength={128}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tf-emails">멤버 이메일 (선택)</Label>
              <Textarea
                id="tf-emails"
                value={emailsText}
                onChange={(e) => setEmailsText(e.target.value)}
                placeholder="쉼표 또는 줄바꿈으로 구분. 나중에 추가할 수도 있습니다."
                rows={3}
              />
              <p className="text-[11px] text-muted-foreground">
                등록된 사용자만 추가됩니다. 미가입 이메일은 건너뛰고 알려드립니다.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              취소
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? '개설 중…' : '개설'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
