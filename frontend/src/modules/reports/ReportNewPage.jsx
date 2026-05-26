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

/** Edit-policy options for the "같이 게시" dropdown. Mirrors
 *  MountDialog.POLICY_OPTIONS so labels stay consistent — kept inline
 *  here to avoid a cross-file import for a 3-row constant. Policy can
 *  always be changed afterward from the report's 게시 다이얼로그. */
const CREATE_POLICY_OPTIONS = [
  { value: 'default',    label: '기본 (작성자 + 보직장)' },
  { value: 'owner_only', label: '작성자 전용' },
  { value: 'coauthor',   label: '공동 작성 (게시판 멤버 전원)' },
]

export default function ReportNewPage() {
  const { slug, workspace } = useWorkspace()
  const navigate = useNavigate()
  // Two-step flow: pick a template (full-page picker) → confirm a report
  // title in a small dialog → navigate to the editor with the chosen title
  // pre-applied via router state. The editor still exposes its own rename
  // UI; this just front-loads the decision so it isn't easy to miss.
  const [pendingTemplate, setPendingTemplate] = useState(null)

  // "이 부서에 같이 게시" 옵션은 부서 컨텍스트에서 진입했을 때만 의미가
  // 있음. 개인 공간 / virtual(횡단) 워크스페이스에서 진입했을 때는 섹션
  // 자체를 숨겨서 다이얼로그가 단순해진다.
  const defaultMount =
    workspace?.kind === 'org' && !workspace.virtual
      ? { slug: workspace.slug, name: workspace.name }
      : null

  function handlePick(template) {
    setPendingTemplate(template)
  }

  function handleConfirm(title, mountConfig) {
    if (!pendingTemplate) return
    navigate(
      `/w/${slug}/reports/new/${pendingTemplate.template_id}/${pendingTemplate.version}`,
      { state: { initialTitle: title, mountConfig } },
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
        defaultMount={defaultMount}
        onCancel={() => setPendingTemplate(null)}
        onConfirm={handleConfirm}
      />
    </div>
  )
}

function NameReportDialog({ template, defaultMount, onCancel, onConfirm }) {
  const open = Boolean(template)
  const [title, setTitle] = useState('')
  // Mount section state — only rendered when defaultMount is set (org
  // entry). Defaults to ON so the user's intuitive expectation ("내가
  // 부서에서 만들었으니 그 부서에 보임") is met without extra clicks.
  const [autoMount, setAutoMount] = useState(true)
  const [editPolicy, setEditPolicy] = useState('default')

  // Pre-fill with the template name each time the dialog opens. We
  // deliberately don't carry the last-typed value across template changes —
  // picking a different template should re-seed the default.
  useEffect(() => {
    if (open) {
      setTitle(template?.name ?? '')
      setAutoMount(true)
      setEditPolicy('default')
    }
  }, [open, template?.name])

  function handleSubmit(e) {
    e.preventDefault()
    const trimmed = title.trim()
    if (!trimmed) return
    const mountConfig =
      defaultMount && autoMount
        ? { slugs: [defaultMount.slug], editPolicy }
        : null
    onConfirm(trimmed, mountConfig)
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

          {/* 게시 섹션 — 부서 진입 시에만. 개인 공간에서 진입했으면
              어디 게시할지가 모호하므로 (다이얼로그를 거치지 않고)
              사후 MountDialog에서 결정하게 둔다. */}
          {defaultMount && (
            <div className="rounded-md border bg-muted/30 p-3 space-y-2">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoMount}
                  onChange={(e) => setAutoMount(e.target.checked)}
                  className="mt-0.5 h-4 w-4"
                />
                <div className="text-sm">
                  <div>
                    작성 후{' '}
                    <span className="font-medium">{defaultMount.name}</span>{' '}
                    게시판에 같이 게시
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    보고서는 내 공간에 저장되고, 이 게시판에 link 되어 부서 멤버가 열람·코멘트할 수 있습니다.
                  </p>
                </div>
              </label>
              {autoMount && (
                <div className="flex items-center gap-2 pl-6">
                  <span className="text-xs text-muted-foreground shrink-0">
                    편집 권한:
                  </span>
                  <select
                    value={editPolicy}
                    onChange={(e) => setEditPolicy(e.target.value)}
                    className="h-7 rounded border border-input bg-background px-1.5 text-xs flex-1"
                  >
                    {CREATE_POLICY_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}

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
