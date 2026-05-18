import { useNavigate } from 'react-router-dom'
import { PageHeader } from '@/shared/components/PageHeader'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import { TemplatePicker } from './TemplatePicker'

export default function ReportNewPage() {
  const { slug, workspace } = useWorkspace()
  const navigate = useNavigate()

  function handlePick(template) {
    navigate(`/w/${slug}/reports/new/${template.template_id}/${template.version}`)
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
    </div>
  )
}
