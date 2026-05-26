import { Link } from 'react-router-dom'
import { HardDrive, RefreshCw } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/shared/components/ui/card'
import { PageHeader } from '@/shared/components/PageHeader'
import { ErrorState } from '@/shared/components/ErrorState'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { useAuth } from '@/shared/auth/AuthContext'
import { useAsync } from '@/shared/hooks/useAsync'
import { getStorageStats } from '@/shared/api/admin'

/** Server / storage admin page — sibling of /admin in the sidebar.
 *
 *  Surfaces two distinct numbers that operators tend to confuse:
 *    - partition.* : the FILESYSTEM backing upload_dir_path (what `df`
 *      shows). Drives the upload guard — when free dips below the safety
 *      margin, new uploads are rejected with 507.
 *    - upload_dir.* : the bytes accounted to ReportArchive (SUM of
 *      files.size). Tells the operator what THIS app consumes,
 *      independent of other tenants on the same partition.
 */
export default function ServerPage() {
  const { me } = useAuth()
  // Server page is a system-operator concern (disk, processes), not
  // a per-workspace one. Gate on the global is_system_admin flag.
  const isAdmin = me?.is_system_admin === true

  if (!isAdmin) {
    return (
      <div className="p-6">
        <PageHeader title="서버" description="서버 / 저장소 상태" />
        <ErrorState
          title="권한 없음"
          description="서버 상태는 admin 권한이 있는 사용자만 볼 수 있습니다."
          action={
            <Button asChild variant="outline">
              <Link to="/">홈으로</Link>
            </Button>
          }
        />
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <PageHeader
        title="서버"
        description="업로드 디스크 잔여 용량 + 앱 footprint. 잔여가 안전 마진 이하로 떨어지면 업로드는 자동으로 거부됩니다."
      />
      <StorageSection />
    </div>
  )
}

function StorageSection() {
  const { data, loading, error, reload } = useAsync(() => getStorageStats(), [])

  if (loading) {
    return <Skeleton className="h-64 w-full" />
  }
  if (error) {
    return <ErrorState description={error.message} onRetry={reload} />
  }
  if (!data) return null

  const {
    partition,
    upload_dir: uploadDir,
    by_workspace: byWorkspace,
    safety_margin_bytes: safetyMargin,
    upload_max_bytes: uploadMax,
  } = data
  // Percent the app's footprint takes inside the partition (purely
  // informational — partition.percent_used is what gates uploads).
  const appPercentOfPartition = partition.total_bytes
    ? (uploadDir.size_bytes * 100) / partition.total_bytes
    : 0

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <HardDrive className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">파티션 잔여 용량</CardTitle>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => reload()}
              className="h-7 text-xs"
            >
              <RefreshCw className="mr-1 h-3 w-3" />
              새로고침
            </Button>
          </div>
          <CardDescription>
            업로드 디렉터리(<code className="font-mono text-[11px]">{partition.path}</code>)가
            올라가 있는 파일시스템 전체 용량. <strong>잔여</strong>가
            업로드 가능 여부를 결정.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <UsageBar
            percent={partition.percent_used}
            label={`${formatBytes(partition.used_bytes)} / ${formatBytes(partition.total_bytes)} 사용`}
          />
          <div className="grid grid-cols-3 gap-3 text-sm">
            <Stat label="총 용량" value={formatBytes(partition.total_bytes)} />
            <Stat label="사용 중" value={formatBytes(partition.used_bytes)} />
            <Stat
              label="잔여"
              value={formatBytes(partition.free_bytes)}
              tone={partition.free_bytes < safetyMargin * 2 ? 'danger' : 'normal'}
            />
          </div>
          <div className="text-[11px] text-muted-foreground border-t pt-2">
            업로드 가드: 파일 1개당 최대{' '}
            <strong>{formatBytes(uploadMax)}</strong>, 잔여가{' '}
            <strong>{formatBytes(safetyMargin)}</strong> 이하로 떨어지면
            새 업로드는 <code className="font-mono">507</code>로 거부됩니다.
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <HardDrive className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">ReportArchive 사용량</CardTitle>
          </div>
          <CardDescription>
            이 앱이 차지하는 footprint — `files` 테이블의 `size` 합. 파티션을
            다른 서비스와 공유하면 위 잔여 용량과 별개로 움직일 수 있음.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-3 gap-3 text-sm">
            <Stat label="총 합계" value={formatBytes(uploadDir.size_bytes)} />
            <Stat label="파일 수" value={uploadDir.file_count.toLocaleString()} />
            <Stat
              label="파티션 내 비중"
              value={`${appPercentOfPartition.toFixed(2)}%`}
            />
          </div>

          {byWorkspace.length > 0 && (
            <div className="rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium text-xs text-muted-foreground">부서</th>
                    <th className="px-3 py-2 text-right font-medium text-xs text-muted-foreground">파일 수</th>
                    <th className="px-3 py-2 text-right font-medium text-xs text-muted-foreground">용량</th>
                    <th className="px-3 py-2 text-right font-medium text-xs text-muted-foreground">앱 footprint 대비</th>
                  </tr>
                </thead>
                <tbody>
                  {byWorkspace.map((row) => {
                    const percent = uploadDir.size_bytes
                      ? (row.size_bytes * 100) / uploadDir.size_bytes
                      : 0
                    return (
                      <tr key={row.workspace_slug} className="border-t">
                        <td className="px-3 py-2">
                          <span className="font-medium">
                            {row.workspace_name ?? row.workspace_slug}
                          </span>
                          <span className="ml-2 text-[10px] font-mono text-muted-foreground">
                            {row.workspace_slug}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {row.file_count.toLocaleString()}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatBytes(row.size_bytes)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {percent.toFixed(1)}%
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function UsageBar({ percent, label }) {
  const tone =
    percent >= 90
      ? 'bg-destructive'
      : percent >= 70
        ? 'bg-amber-500'
        : 'bg-emerald-500'
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono tabular-nums">{percent.toFixed(1)}%</span>
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full ${tone} transition-all`}
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      </div>
    </div>
  )
}

function Stat({ label, value, tone = 'normal' }) {
  return (
    <div className="rounded-md border p-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={`mt-0.5 text-base font-semibold tabular-nums ${
          tone === 'danger' ? 'text-destructive' : ''
        }`}
      >
        {value}
      </div>
    </div>
  )
}

// Operators read GB/TB more readily than raw bytes. 1024-based units —
// matches what `df -h` shows.
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const idx = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  )
  const value = bytes / 1024 ** idx
  // 2 decimals for GB+, 1 for MB, none for KB/B — readability vs precision.
  const decimals = idx >= 3 ? 2 : idx >= 2 ? 1 : 0
  return `${value.toFixed(decimals)} ${units[idx]}`
}
