import { Sparkles } from 'lucide-react'
import { EmptyState } from '@/shared/components/EmptyState'
import { PageHeader } from '@/shared/components/PageHeader'

export default function AIJobsPage() {
  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="AI 작업"
        description="섹션 생성·재작성·검증·인용 작업의 큐. Anthropic Messages API 연결 후 본격 구현."
      />

      <EmptyState
        icon={Sparkles}
        title="AI 작업 큐 자리"
        description="여기에 진행 중 / 대기 중 / 완료된 AI 작업이 표시된다. 보고서 상세의 AI 도크에서 트리거된 작업이 모이는 곳."
      />
    </div>
  )
}
