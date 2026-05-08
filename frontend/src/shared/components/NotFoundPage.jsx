import { Link } from 'react-router-dom'
import { Compass, Home, FileText } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'

export function NotFoundPage() {
  const { slug } = useWorkspace()

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-md text-center space-y-4">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Compass className="h-6 w-6 text-muted-foreground" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">페이지를 찾을 수 없습니다</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            요청한 경로가 존재하지 않거나 이동되었을 수 있습니다.
          </p>
        </div>
        <div className="flex justify-center gap-2">
          <Button asChild variant="outline">
            <Link to={`/w/${slug}`}>
              <Home className="mr-2 h-4 w-4" />
              부서 홈
            </Link>
          </Button>
          <Button asChild>
            <Link to={`/w/${slug}/reports`}>
              <FileText className="mr-2 h-4 w-4" />
              보고서 목록
            </Link>
          </Button>
        </div>
      </div>
    </div>
  )
}
