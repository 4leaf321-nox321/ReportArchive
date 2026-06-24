import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertTriangle,
  Cpu,
  Database,
  HardDrive,
  MemoryStick,
  RefreshCw,
  Server,
  Sliders,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
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
import {
  getRuntimeTuning,
  getServerInfo,
  getStorageStats,
  setRuntimeTuning,
} from '@/shared/api/admin'

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
        description="호스트 스펙 · 업로드 디스크 잔여 용량 · 앱 footprint. 잔여 용량이 안전 마진 이하로 떨어지면 업로드는 자동 거부됩니다."
      />
      <SpecSection />
      <TuningSection />
      <StorageSection />
    </div>
  )
}

/** 동시 처리량 / DB 풀 등 다음 부팅 시 적용될 값을 편집. 실시간 hot-reload
 *  가 아니라 운영자가 systemctl restart 후 워커가 새 값을 읽음 — 그래서
 *  각 키마다 "저장된 값 ≠ 실행 중 값" 일 땐 「재시작 필요」 배지를 띄움. */
function TuningSection() {
  const { data, loading, error, reload } = useAsync(() => getRuntimeTuning(), [])
  if (loading) return <Skeleton className="h-72 w-full" />
  if (error) return <ErrorState description={error.message} onRetry={reload} />
  if (!data) return null

  const migrationRequired = data.__meta__?.migration_required === true
  const rows = { ...data }
  delete rows.__meta__
  const anyRestart = Object.values(rows).some((row) => row.restart_required)

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sliders className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">동시 처리량 튜닝</CardTitle>
          </div>
          {anyRestart && (
            <span className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-800">
              <AlertTriangle className="h-3 w-3" />
              재시작 필요
            </span>
          )}
        </div>
        <CardDescription>
          여기서 바꾼 값은 <strong>다음 워커 부팅</strong>부터 반영됩니다.
          서비스를 운영자 권한으로 재시작해야 적용 — SIF/systemd 환경에선{' '}
          <code className="font-mono text-[11px]">sudo systemctl restart reportarchive</code>
          {' '}또는 동등한 절차.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {migrationRequired && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 flex items-start gap-2">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <div className="space-y-1">
              <div>
                <strong>runtime_settings 테이블이 아직 없습니다.</strong> 백엔드에서{' '}
                <code className="font-mono">alembic upgrade head</code> 를 실행해
                마이그레이션을 적용한 뒤 이 페이지를 새로고침하세요. (현재는
                실행 중 effective 값만 표시됩니다.)
              </div>
            </div>
          </div>
        )}
        <TuningRow
          k="uvicorn_workers"
          row={rows.uvicorn_workers}
          label="uvicorn workers"
          hint="동시에 처리되는 worker 프로세스 수. 보통 CPU 코어의 1–2배. 늘릴수록 동시 요청을 더 받지만 메모리·DB 커넥션도 비례해서 늘어남."
          onSaved={reload}
        />
        <TuningRow
          k="db_pool_size"
          row={rows.db_pool_size}
          label="DB pool_size (worker 당)"
          hint="SQLAlchemy 가 상시 보유하는 connection 수. 평상시 동시 in-flight 쿼리 수를 받는다."
          onSaved={reload}
        />
        <TuningRow
          k="db_max_overflow"
          row={rows.db_max_overflow}
          label="DB max_overflow (worker 당)"
          hint="peak 때만 일시적으로 열리는 추가 connection 한도. 워커당 최대 DB 연결 = pool_size + max_overflow."
          onSaved={reload}
        />
        <div className="rounded-md border border-muted bg-muted/30 p-3 text-[11px] text-muted-foreground space-y-1">
          <div>
            <strong>주의:</strong> 총 DB connection = workers × (pool_size + max_overflow).
            예: 8 × (10 + 10) = 160 — PostgreSQL{' '}
            <code className="font-mono">max_connections</code> 기본 100 을 넘기지
            않도록 주의.
          </div>
          <div>
            <code className="font-mono">max_connections</code> 변경은 앱 권한
            밖이라 운영자가 <code className="font-mono">postgresql.conf</code>{' '}
            에서 별도로 조정해야 합니다.
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function TuningRow({ k, row, label, hint, onSaved }) {
  const limits = row?.limits ?? { min: 1, max: 32 }
  const initial = row?.stored ?? row?.effective ?? limits.min
  const [draft, setDraft] = useState(initial)
  const [saving, setSaving] = useState(false)
  const draftNum = Number(draft)
  const valid =
    Number.isFinite(draftNum) &&
    Number.isInteger(draftNum) &&
    draftNum >= limits.min &&
    draftNum <= limits.max
  const stored = row?.stored
  const effective = row?.effective
  const dirty = valid && draftNum !== (stored ?? effective)

  async function handleSave() {
    if (!valid || !dirty) return
    setSaving(true)
    try {
      await setRuntimeTuning(k, draftNum)
      toast.success(`${label} 저장됨 — 재시작 후 적용`)
      onSaved?.()
    } catch (err) {
      toast.error(
        err?.response?.data?.message || err?.message || '저장 실패',
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rounded-md border p-3 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="space-y-0.5">
          <div className="text-sm font-medium">{label}</div>
          <div className="text-[11px] text-muted-foreground">{hint}</div>
        </div>
        {row?.restart_required && (
          <span className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-800 shrink-0">
            <AlertTriangle className="h-2.5 w-2.5" />
            재시작 필요
          </span>
        )}
      </div>
      <div className="flex items-end gap-3 flex-wrap">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            저장값
          </span>
          <Input
            type="number"
            min={limits.min}
            max={limits.max}
            step={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="h-8 w-24 text-sm font-mono"
          />
        </label>
        <div className="text-[11px] text-muted-foreground space-y-0.5">
          <div>
            범위 <span className="font-mono">{limits.min}–{limits.max}</span>
          </div>
          <div>
            실행 중{' '}
            <span className="font-mono tabular-nums">
              {effective ?? '—'}
            </span>
            {stored != null && stored !== effective && (
              <>
                {' '}· 저장됨{' '}
                <span className="font-mono tabular-nums">{stored}</span>
              </>
            )}
          </div>
        </div>
        <Button
          size="sm"
          variant={dirty ? 'default' : 'outline'}
          disabled={!valid || !dirty || saving}
          onClick={handleSave}
          className="ml-auto"
        >
          {saving ? '저장 중...' : '저장'}
        </Button>
      </div>
    </div>
  )
}

/** 호스트 스펙 카드 — OS / CPU / 메모리 / 런타임 / DB 현재 상태. */
function SpecSection() {
  const { data, loading, error, reload } = useAsync(() => getServerInfo(), [])

  if (loading) return <Skeleton className="h-72 w-full" />
  if (error) return <ErrorState description={error.message} onRetry={reload} />
  if (!data) return null

  const { host, cpu, memory, process: proc, runtime, database } = data

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Server className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">서버 스펙</CardTitle>
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
          이 ReportArchive 가 돌고 있는 호스트의 OS · CPU · 메모리 와
          uvicorn worker 수, DB connection pool 사용량. 동시접속 가능
          인원은 이 표 + 워커 수가 큰 결정 요인입니다.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* CPU + load average */}
        <div className="space-y-2">
          <SectionLabel icon={Cpu} text="CPU" />
          <div className="rounded-md border bg-muted/20 px-3 py-2 text-sm font-mono break-all">
            {cpu.model}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
            <Stat label="논리 CPU" value={`${cpu.logical_cpus} 개`} />
            <Stat
              label="물리 소켓"
              value={cpu.physical_sockets ? `${cpu.physical_sockets} 개` : '—'}
            />
            <Stat
              label="Load (1m)"
              value={cpu.load_avg_1m.toFixed(2)}
              tone={
                cpu.logical_cpus && cpu.load_avg_1m > cpu.logical_cpus * 0.85
                  ? 'danger'
                  : 'normal'
              }
            />
            <Stat
              label="Load (5m / 15m)"
              value={`${cpu.load_avg_5m.toFixed(2)} / ${cpu.load_avg_15m.toFixed(2)}`}
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            Load average 가 논리 CPU 수에 가깝거나 넘어가면 새 요청이 대기
            큐에 쌓입니다 (= 응답 지연 시작).
          </p>
        </div>

        {/* Memory */}
        <div className="space-y-2">
          <SectionLabel icon={MemoryStick} text="메모리" />
          <UsageBar
            percent={memory.percent_used}
            label={`${formatBytes(memory.used_bytes)} / ${formatBytes(memory.total_bytes)} 사용`}
          />
          <div className="grid grid-cols-3 gap-2 text-sm">
            <Stat label="총 메모리" value={formatBytes(memory.total_bytes)} />
            <Stat
              label="사용 가능"
              value={formatBytes(memory.available_bytes)}
              tone={
                memory.total_bytes &&
                memory.available_bytes < memory.total_bytes * 0.1
                  ? 'danger'
                  : 'normal'
              }
            />
            <Stat
              label="이 워커 RSS"
              value={formatBytes(proc.rss_bytes)}
            />
          </div>
        </div>

        {/* 호스트 / 런타임 */}
        <div className="space-y-2">
          <SectionLabel icon={Server} text="호스트 / 런타임" />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
            <KeyValue label="호스트네임" value={host.hostname || '—'} mono />
            <KeyValue label="OS" value={host.os || '—'} />
            <KeyValue label="아키텍처" value={host.arch || '—'} mono />
            <KeyValue
              label="가동 시간"
              value={formatUptime(host.uptime_seconds)}
            />
            <KeyValue
              label="uvicorn workers"
              value={`${runtime.uvicorn_workers} 개`}
            />
            <KeyValue
              label="Python"
              value={proc.python_version}
              mono
            />
            <KeyValue label="환경" value={runtime.app_env} mono />
            <KeyValue
              label="정적 자산 서빙"
              value={runtime.serve_frontend_dist ? 'FastAPI 직접' : 'nginx 등 외부'}
            />
          </div>
        </div>

        {/* DB */}
        <div className="space-y-2">
          <SectionLabel icon={Database} text="PostgreSQL" />
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
            <KeyValue label="버전" value={database.version} mono />
            <Stat
              label="Pool 보유"
              value={
                Number.isFinite(database.pool?.size)
                  ? `${database.pool.size}`
                  : '—'
              }
            />
            <Stat
              label="사용 중"
              value={
                Number.isFinite(database.pool?.checkedout)
                  ? `${database.pool.checkedout}`
                  : '—'
              }
              tone={
                Number.isFinite(database.pool?.checkedout) &&
                Number.isFinite(database.pool?.size) &&
                database.pool.size > 0 &&
                database.pool.checkedout / database.pool.size > 0.8
                  ? 'danger'
                  : 'normal'
              }
            />
            <Stat
              label="Overflow"
              value={
                Number.isFinite(database.pool?.overflow)
                  ? `${database.pool.overflow}`
                  : '—'
              }
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            Worker 당 SQLAlchemy pool. 「사용 중」 이 「Pool 보유」 + overflow
            합계에 자주 도달하면 connection 부족으로 요청이 대기합니다.
            (이 카드는 새로고침한 *그 워커* 의 풀만 보여줍니다 — 워커가
            여러 개면 합계는 worker 수배.)
          </p>
        </div>
      </CardContent>
    </Card>
  )
}

function SectionLabel({ icon: Icon, text }) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
      <Icon className="h-3 w-3" />
      {text}
    </div>
  )
}

function KeyValue({ label, value, mono = false }) {
  return (
    <div className="rounded-md border p-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={
          'mt-0.5 text-sm break-all ' + (mono ? 'font-mono' : 'font-medium')
        }
      >
        {value}
      </div>
    </div>
  )
}

/** 초 단위 가동시간을 "Nd Nh Nm" 식으로. 0 이면 — 표시. */
function formatUptime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const parts = []
  if (days > 0) parts.push(`${days}일`)
  if (hours > 0) parts.push(`${hours}시간`)
  if (days === 0) parts.push(`${minutes}분`)
  return parts.join(' ')
}

function StorageSection() {
  const { data, loading, error, reload } = useAsync(() => getStorageStats(), [])
  // 부서별 표 정렬 상태. 기본은 용량 내림차순 — 백엔드 기본 정렬과 동일.
  // useState 는 아래 early-return 들보다 먼저 호출돼야 hook 순서가 안정적.
  const [sort, setSort] = useState({ key: 'size_bytes', dir: 'desc' })

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

  // 헤더 클릭 정렬. 같은 열 다시 누르면 방향 토글, 다른 열로 옮기면 부서명은
  // 오름차순·숫자열은 내림차순을 기본으로 (큰 값 먼저 보는 게 자연스러움).
  function toggleSort(key) {
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'workspace_name' ? 'asc' : 'desc' },
    )
  }
  // 표시용 정렬 사본 — byWorkspace 원본은 건드리지 않는다. report_count 는
  // 백엔드 응답에 없을 수도 있어(구버전) ?? 0 으로 방어.
  const sortedWorkspaces = [...byWorkspace].sort((a, b) => {
    if (sort.key === 'workspace_name') {
      const av = a.workspace_name ?? a.workspace_slug ?? ''
      const bv = b.workspace_name ?? b.workspace_slug ?? ''
      const cmp = av.localeCompare(bv, 'ko')
      return sort.dir === 'asc' ? cmp : -cmp
    }
    const av = a[sort.key] ?? 0
    const bv = b[sort.key] ?? 0
    return sort.dir === 'asc' ? av - bv : bv - av
  })

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
                    <SortTh label="부서" sortKey="workspace_name" sort={sort} onSort={toggleSort} align="left" />
                    <SortTh label="파일 수" sortKey="file_count" sort={sort} onSort={toggleSort} />
                    <SortTh label="용량" sortKey="size_bytes" sort={sort} onSort={toggleSort} />
                    <SortTh label="보고서 수" sortKey="report_count" sort={sort} onSort={toggleSort} />
                    <th className="px-3 py-2 text-right font-medium text-xs text-muted-foreground">앱 footprint 대비</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedWorkspaces.map((row) => {
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
                        <td className="px-3 py-2 text-right tabular-nums">
                          {(row.report_count ?? 0).toLocaleString()}
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

// 정렬 가능한 표 헤더 셀. 활성 열이면 방향 화살표(▲/▼)를 표시하고, 클릭
// 시 toggleSort 를 호출. 숫자열은 우측 정렬(align='right' 기본), 부서명만
// 좌측 정렬. 폭이 안 흔들리도록 화살표 자리는 항상 고정 너비로 비워둔다.
function SortTh({ label, sortKey, sort, onSort, align = 'right' }) {
  const active = sort.key === sortKey
  return (
    <th
      className={`px-3 py-2 font-medium text-xs text-muted-foreground ${
        align === 'left' ? 'text-left' : 'text-right'
      }`}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 hover:text-foreground ${
          align === 'right' ? 'w-full justify-end' : ''
        } ${active ? 'text-foreground' : ''}`}
        title="정렬"
      >
        <span>{label}</span>
        <span className="w-2 text-[9px] leading-none">
          {active ? (sort.dir === 'asc' ? '▲' : '▼') : ''}
        </span>
      </button>
    </th>
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
