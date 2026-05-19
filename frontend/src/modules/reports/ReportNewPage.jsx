import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PageHeader } from '@/shared/components/PageHeader'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import { TemplatePicker } from './TemplatePicker'

export default function ReportNewPage() {
  const { slug, workspace } = useWorkspace()
  const navigate = useNavigate()
  // Two-step flow: pick a template (full-page picker) → confirm a report
  // title in a small dialog → navigate to the editor with the chosen title
  // pre-applied via router state. The editor still exposes its own rename
  // UI; this just front-loads the decision so it isn't easy to miss.
  const [pendingTemplate, setPendingTemplate] = useState(null)

  function handlePick(template) {
    setPendingTemplate(template)
  }

  function handleConfirm(title) {
    if (!pendingTemplate) return
    navigate(
      `/w/${slug}/reports/new/${pendingTemplate.template_id}/${pendingTemplate.version}`,
      { state: { initialTitle: title } },
    )
  }

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="새 보고서 — 템플릿 선택"
        description={`${workspace?.name ?? ''}에 작성할 보고서의 양식을 고르세요. 양식은 JSON Schema로 정의되어 있어 AI가 섹션 단위로 작성·검증합니다.`}
        breadcrumbs={[
          { label: workspace?.name ?? '부서', to: `/w/${slug}` },
          { label: '보고서', to: `/w/${slug}/reports` },
          { label: '새 보고서' },
        ]}
      />

      <TemplatePicker onPick={handlePick} reloadKey={slug} />

      <NameReportDialog
        template={pendingTemplate}
        onCancel={() => setPendingTemplate(null)}
        onConfirm={handleConfirm}
      />
    </div>
  )
}

function NameReportDialog({ template, onCancel, onConfirm }) {
  const open = Boolean(template)
  const [title, setTitle] = useState('')

  // Pre-fill with the template name each time the dialog opens. We
  // deliberately don't carry the last-typed value across template changes —
  // picking a different template should re-seed the default.
  useEffect(() => {
    if (open) {
      setTitle(template?.name ?? '')
    }
  }, [open, template?.name])

  function handleSubmit(e) {
    e.preventDefault()
    const trimmed = title.trim()
    if (!trimmed) return
    onConfirm(trimmed)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onCancel()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>보고서 이름 지정</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="new-report-title" className="text-sm font-medium">
              보고서 제목
            </label>
            <Input
              id="new-report-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="예) 2026-W20 주간보고"
              autoFocus
              required
            />
            <p className="text-[11px] text-muted-foreground">
              템플릿:{' '}
              <span className="font-medium text-foreground">
                {template?.name}
              </span>{' '}
              · 편집창에서 언제든지 다시 변경할 수 있습니다.
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onCancel}>
              취소
            </Button>
            <Button type="submit" disabled={!title.trim()}>
              작성 시작
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
