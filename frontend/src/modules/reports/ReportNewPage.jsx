import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Sparkles } from 'lucide-react'
import { toast } from 'sonner'
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
import { useAsync } from '@/shared/hooks/useAsync'
import { listPresets, newReportFromPreset } from '@/shared/api/presets'
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

  // 프리셋은 템플릿에 종속(preset → template). 한 번 불러와
  // template_id 로 그룹핑해서, 평면 나열 대신 템플릿 "아래에" 중첩한다 —
  // 카드엔 "프리셋 N개" 뱃지, 템플릿을 고르면 그 템플릿의 프리셋만 선택지로.
  const { data: presets } = useAsync(() => listPresets(), [slug])
  const presetsByTemplate = useMemo(() => {
    const map = new Map()
    for (const p of presets ?? []) {
      if (!map.has(p.template_id)) map.set(p.template_id, [])
      map.get(p.template_id).push(p)
    }
    return map
  }, [presets])
  const presetCounts = useMemo(() => {
    const out = {}
    for (const [tid, list] of presetsByTemplate) out[tid] = list.length
    return out
  }, [presetsByTemplate])

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

  async function handleStartFromPreset(presetId, title) {
    try {
      const created = await newReportFromPreset(presetId, { title })
      navigate(`/w/${created.workspace_slug}/reports/${created.id}`, {
        state: { startEditing: true },
      })
    } catch (err) {
      toast.error(err?.message || '프리셋으로 시작 실패')
      throw err
    }
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

      <TemplatePicker
        onPick={handlePick}
        reloadKey={slug}
        presetCounts={presetCounts}
      />

      <NameReportDialog
        template={pendingTemplate}
        presets={
          pendingTemplate
            ? presetsByTemplate.get(pendingTemplate.template_id) ?? []
            : []
        }
        defaultMount={defaultMount}
        onCancel={() => setPendingTemplate(null)}
        onConfirm={handleConfirm}
        onStartFromPreset={handleStartFromPreset}
      />
    </div>
  )
}

/** 프리셋 선택 — 내용이 채워진 프리셋으로 바로 새 보고서를
 *  만든다. 프리셋이 하나도 없으면 섹션 자체를 숨긴다(빈 템플릿 흐름 방해
 *  안 하도록). 클릭 시 서버가 personal 공간에 seed 된 보고서를 만들고 그
 *  편집창으로 이동(복사 흐름과 동일 패턴). */
/** 시작 방식 선택 카드 — "빈 보고서" 또는 특정 프리셋 한 줄. */
function StartOption({ active, onClick, title, desc, sparkle }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'flex items-start gap-2 rounded-md border px-3 py-2 text-left transition-colors ' +
        (active ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50')
      }
    >
      <span
        className={
          'mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full border ' +
          (active ? 'border-primary bg-primary' : 'border-muted-foreground/40')
        }
        aria-hidden
      />
      <span className="min-w-0">
        <span className="flex items-center gap-1 text-sm font-medium">
          {sparkle && <Sparkles className="h-3 w-3 shrink-0 text-primary" />}
          <span className="truncate">{title}</span>
        </span>
        {desc && (
          <span className="block text-[11px] text-muted-foreground line-clamp-2">
            {desc}
          </span>
        )}
      </span>
    </button>
  )
}

function NameReportDialog({
  template,
  presets,
  defaultMount,
  onCancel,
  onConfirm,
  onStartFromPreset,
}) {
  const open = Boolean(template)
  const [title, setTitle] = useState('')
  // null = 빈 보고서(프리셋 없음), 그 외 = 선택한 프리셋 id.
  const [selectedPresetId, setSelectedPresetId] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  // Mount section state — only rendered when defaultMount is set (org
  // entry). Defaults to ON so the user's intuitive expectation ("내가
  // 부서에서 만들었으니 그 부서에 보임") is met without extra clicks.
  const [autoMount, setAutoMount] = useState(true)
  const [editPolicy, setEditPolicy] = useState('default')

  const list = presets ?? []
  const hasPresets = list.length > 0
  const isBlank = selectedPresetId == null

  // Pre-fill with the template name each time the dialog opens. We
  // deliberately don't carry the last-typed value across template changes —
  // picking a different template should re-seed the default.
  useEffect(() => {
    if (open) {
      setTitle(template?.name ?? '')
      setSelectedPresetId(null)
      setAutoMount(true)
      setEditPolicy('default')
      setSubmitting(false)
    }
  }, [open, template?.name])

  function selectOption(presetId) {
    setSelectedPresetId(presetId)
    // 제목 기본값을 선택지에 맞춰 재시드(사용자가 이어서 수정 가능).
    if (presetId == null) setTitle(template?.name ?? '')
    else setTitle(list.find((p) => p.id === presetId)?.name ?? template?.name ?? '')
  }

  async function handleSubmit(e) {
    e.preventDefault()
    const trimmed = title.trim()
    if (!trimmed) return
    if (!isBlank) {
      // 프리셋 → 서버가 seed 된 보고서를 만들고 편집창으로 이동.
      setSubmitting(true)
      try {
        await onStartFromPreset(selectedPresetId, trimmed)
      } catch {
        setSubmitting(false)
      }
      return
    }
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
          <DialogTitle>새 보고서 시작</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {hasPresets && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">시작 방식</label>
              <div className="grid max-h-52 gap-1.5 overflow-y-auto">
                <StartOption
                  active={isBlank}
                  onClick={() => selectOption(null)}
                  title="빈 보고서로 시작"
                  desc="프리셋 없이 템플릿 구조만 — 내용은 비어 있음"
                />
                {list.map((p) => (
                  <StartOption
                    key={p.id}
                    active={selectedPresetId === p.id}
                    onClick={() => selectOption(p.id)}
                    title={p.name}
                    desc={p.description || '내용이 채워진 프리셋'}
                    sparkle
                  />
                ))}
              </div>
            </div>
          )}
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

          {/* 게시 섹션 — 부서 진입 + 빈 보고서 시작일 때만. 프리셋은
              개인 공간에 seed 되어 생성되므로 게시는 사후 결정한다. */}
          {isBlank && defaultMount && (
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
            <Button
              type="button"
              variant="outline"
              onClick={onCancel}
              disabled={submitting}
            >
              취소
            </Button>
            <Button type="submit" disabled={!title.trim() || submitting}>
              {submitting ? '시작하는 중…' : '작성 시작'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
