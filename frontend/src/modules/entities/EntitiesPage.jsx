import { Network } from 'lucide-react'
import { EmptyState } from '@/shared/components/EmptyState'
import { PageHeader } from '@/shared/components/PageHeader'

export default function EntitiesPage() {
  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="엔티티 / 태그"
        description="보고서 간 cross-reference의 진입점. 엔티티 추출 도입 시 활성화."
      />
      <EmptyState
        icon={Network}
        title="엔티티 모델 미구현"
        description="개발계획.md §1-4 / §5 단계 4~5에서 도입 예정. 보고서 간 연결의 진입점."
      />
    </div>
  )
}
