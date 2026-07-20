import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Network,
  Plus,
  Loader2,
  RefreshCw,
  Trash2,
  Play,
  Eye,
  Search,
  History,
  Sparkles,
  X as XIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/shared/components/ui/card'
import { Badge } from '@/shared/components/ui/badge'
import { PageHeader } from '@/shared/components/PageHeader'
import { ErrorState } from '@/shared/components/ErrorState'
import { ConfirmDialog } from '@/shared/components/ConfirmDialog'
import { useAuth } from '@/shared/auth/AuthContext'
import { useAsync } from '@/shared/hooks/useAsync'
import { listEntityTypes, listRelationTypes, listTypeProperties } from '@/shared/api/entities'
import {
  listDataSources,
  getDataSource,
  createDataSource,
  updateDataSource,
  deleteDataSource,
  probeDataSource,
  previewDataSource,
  syncDataSource,
  resetBackfill,
  listSyncRuns,
  suggestMapping,
} from '@/shared/api/connectors'

/** 샘플 레코드를 점표기 leaf 경로 목록으로 평탄화(name, supplier.code …). datalist 자동완성용. */
function flattenPaths(obj, prefix = '', out = []) {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) flattenPaths(v, prefix ? `${prefix}.${k}` : k, out)
  } else if (Array.isArray(obj)) {
    if (obj.length) flattenPaths(obj[0], `${prefix}.0`, out)
    else if (prefix) out.push(prefix)
  } else if (prefix) {
    out.push(prefix)
  }
  return out
}

function blankStream() {
  return {
    label: '',
    endpoint_path: '',
    http_method: 'GET',
    records_path: '',
    target_type_id: 0,
    value_path: '',
    match_key: 'value', // 'value'(이름) | 'code'(안정 식별자)
    code_path: '',
    query_rows: [], // [{key,value}] — OData $expand·$select·$filter 등 쿼리 파라미터
    prop_paths: {}, // {속성 slug: 필드 경로}
    relation_rows: [],
    // 고급(v3) — 페이지네이션 · 증분
    page_style: 'none',
    page_size: 100,
    page_param: 'offset',
    size_param: 'limit',
    cursor_path: '',
    cursor_param: 'cursor',
    next_url_path: '',
    skip_on_error: false,
    incremental: false,
    watermark_field: '',
    watermark_param: '',
    watermark_template: '',
  }
}

function blankDraft() {
  return {
    name: '',
    enabled: true,
    schedule_kind: 'manual',
    interval_minutes: 60,
    base_url: '',
    auth_type: 'none',
    auth_token: '',
    auth_header: 'X-API-Key',
    auth_username: '',
    auth_password: '',
    has_secret: false,
    streams: [blankStream()],
  }
}

function streamFromConfig(st) {
  return {
    label: st.label || '',
    endpoint_path: st.endpoint_path || '',
    http_method: st.http_method || 'GET',
    records_path: st.records_path || '',
    target_type_id: st.target_type_id || 0,
    value_path: st.value_path || '',
    match_key: st.match_key || 'value',
    code_path: st.code_path || '',
    query_rows: Object.entries(st.query || {}).map(([key, value]) => ({
      key,
      value: String(value),
    })),
    prop_paths: { ...(st.property_map || {}) },
    relation_rows: (st.relation_map || []).map((r) => ({ match_key: 'value', ...r })),
    page_style: st.page_style || 'none',
    page_size: st.page_size || 100,
    page_param: st.page_param || 'offset',
    size_param: st.size_param || 'limit',
    cursor_path: st.cursor_path || '',
    cursor_param: st.cursor_param || 'cursor',
    next_url_path: st.next_url_path || '',
    skip_on_error: !!st.skip_on_error,
    backfill: !!st.backfill,
    backfill_window: st.backfill_window || 0,
    incremental: !!st.incremental,
    watermark_field: st.watermark_field || '',
    watermark_param: st.watermark_param || '',
    watermark_template: st.watermark_template || '',
  }
}

function draftFromSource(s) {
  const conn = s.config?.connection || {}
  return {
    name: s.name,
    enabled: s.enabled,
    schedule_kind: s.schedule_kind || 'manual',
    interval_minutes: s.interval_minutes || 60,
    base_url: conn.base_url || '',
    auth_type: conn.auth?.type || 'none',
    auth_token: '',
    auth_header: conn.auth?.header || 'X-API-Key',
    auth_username: conn.auth?.username || '',
    auth_password: '',
    has_secret: s.has_secret,
    sync_state: s.sync_state || {}, // 백필 진행률 표시용(편집 대상 아님)
    streams: (s.config?.streams || []).map(streamFromConfig),
  }
}

function streamToConfig(st) {
  const property_map = {}
  for (const [slug, path] of Object.entries(st.prop_paths || {})) {
    if (slug && (path || '').trim()) property_map[slug] = path.trim()
  }
  const relation_map = st.relation_rows
    .filter((r) => r.relation && r.target_type && r.path?.trim())
    .map((r) => ({
      relation: r.relation, target_type: r.target_type, path: r.path.trim(),
      match_key: r.match_key === 'code' ? 'code' : 'value',
    }))
  // 쿼리 파라미터(OData $expand·$select·$filter 등) — 페이지네이션 파라미터와 같은
  // params dict 로 함께 전송돼야 URL 쿼리가 덮이지 않는다(endpoint_path 에 붙이면 안 됨).
  const query = {}
  for (const r of st.query_rows || []) {
    if ((r.key || '').trim()) query[r.key.trim()] = r.value ?? ''
  }
  return {
    label: st.label.trim(),
    endpoint_path: st.endpoint_path.trim(),
    http_method: st.http_method,
    query,
    records_path: st.records_path.trim(),
    target_type_id: Number(st.target_type_id) || 0,
    match_key: st.match_key === 'code' ? 'code' : 'value',
    value_path: st.value_path.trim(),
    code_path: (st.code_path || '').trim(),
    property_map,
    relation_map,
    page_style: st.page_style || 'none',
    page_size: Number(st.page_size) || 100,
    page_param: (st.page_param || 'offset').trim(),
    size_param: (st.size_param || 'limit').trim(),
    cursor_path: (st.cursor_path || '').trim(),
    cursor_param: (st.cursor_param || 'cursor').trim(),
    next_url_path: (st.next_url_path || '').trim(),
    skip_on_error: !!st.skip_on_error,
    backfill: !!st.backfill,
    backfill_window: Number(st.backfill_window) || 0,
    incremental: !!st.incremental,
    watermark_field: (st.watermark_field || '').trim(),
    watermark_param: (st.watermark_param || '').trim(),
    watermark_template: (st.watermark_template || '').trim(),
  }
}

function draftToConnection(d) {
  return {
    base_url: d.base_url.trim(),
    auth: {
      type: d.auth_type,
      token: d.auth_token,
      header: d.auth_header,
      username: d.auth_username,
      password: d.auth_password,
    },
    headers: {},
  }
}

function draftToConfig(d) {
  return { connection: draftToConnection(d), streams: d.streams.map(streamToConfig) }
}

function StatusBadge({ status }) {
  if (!status) return <span className="text-xs text-muted-foreground">—</span>
  const map = {
    done: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
    failed: 'bg-red-500/15 text-red-600 dark:text-red-400',
    running: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  }
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${map[status] || 'bg-muted'}`}>
      {status}
    </span>
  )
}

function SummaryLine({ summary }) {
  if (!summary) return null
  const s = summary
  return (
    <p className="text-sm text-muted-foreground">
      스트림 {s.streams} · 총 {s.total} · 생성 {s.create} · 갱신 {s.update} · 오류 {s.error} · 링크{' '}
      {s.linked}
      {s.link_unresolved ? ` · 미해결링크 ${s.link_unresolved}` : ''}
      {s.committed === false ? ' · (미리보기, 쓰기 없음)' : ''}
    </p>
  )
}

/** 필드 경로 입력 — datalist(dlId)로 조회된 키 자동완성. 모듈 스코프 정의(리렌더 시
 *  포커스 유실 방지). */
function PathInput({ dlId, value, onChange, placeholder }) {
  return (
    <Input
      list={dlId}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="h-8"
    />
  )
}

/** 스트림 1개 편집기. 대상 축을 고르면 그 축의 속성이 자동 리스트업되고, 샘플 조회한
 *  키가 모든 경로칸에 자동완성(datalist)으로 뜬다. */
function StreamEditor({
  stream,
  index,
  axes,
  axisDefs,
  relationTypes,
  onChange,
  onRemove,
  onProbe,
  probing,
  probeResult,
  onSuggest,
  suggesting,
  onRun,
  busy,
  canRun,
  syncState,
  onResetBackfill,
}) {
  function upd(patch) {
    onChange(index, { ...stream, ...patch })
  }
  function setProp(slug, path) {
    upd({ prop_paths: { ...stream.prop_paths, [slug]: path } })
  }

  const dlId = `ff-${index}` // datalist id (조회된 필드 경로)
  // 조회된 필드 경로 — 서버가 받아온 레코드 전체(스캔 상한까지)를 훑어 준 fields 를
  // 쓴다. 화면에 오는 샘플 5건만 훑으면, $expand 된 navigation 이 앞쪽 레코드에서
  // null 일 때(SPDM product 등) 하위 경로가 통째로 빠진다. sample 평탄화는 구버전
  // 응답(fields 없음) 대비 폴백.
  const fieldPaths = useMemo(() => {
    if (probeResult?.fields?.length) return probeResult.fields
    const rows = probeResult?.sample ?? []
    return [...new Set(rows.flatMap((r) => flattenPaths(r ?? {})))].sort()
  }, [probeResult])

  // 속성 행 = 축 정의 속성(자동) + config 에 있던 추가 slug(하위호환).
  const defKeys = (axisDefs || []).map((d) => d.key)
  const extraKeys = Object.keys(stream.prop_paths || {}).filter((k) => !defKeys.includes(k))

  return (
    <Card>
      <datalist id={dlId}>
        {fieldPaths.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm">
            스트림 {index + 1}
            {stream.label ? ` · ${stream.label}` : ''}
          </CardTitle>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onRemove(index)}>
            <XIcon className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs">라벨(선택)</Label>
            <Input value={stream.label} onChange={(e) => upd({ label: e.target.value })} placeholder="공급사" />
          </div>
          <div>
            <Label className="text-xs">대상 축</Label>
            <select
              value={stream.target_type_id}
              onChange={(e) => upd({ target_type_id: e.target.value, prop_paths: {} })}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value={0}>— 선택 —</option>
              {axes.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label} ({a.slug})
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label className="text-xs">Endpoint 경로</Label>
            <Input
              value={stream.endpoint_path}
              onChange={(e) => upd({ endpoint_path: e.target.value })}
              placeholder="/api/suppliers"
            />
          </div>
          <div>
            <Label className="text-xs">records_path</Label>
            <Input value={stream.records_path} onChange={(e) => upd({ records_path: e.target.value })} placeholder="data.items" />
          </div>
        </div>

        {/* 쿼리 파라미터 — OData $expand·$select·$filter 등. endpoint_path 에 붙이면
            페이지네이션 파라미터가 URL 쿼리를 덮어써 사라지므로 반드시 여기에. */}
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <Label className="text-xs">
              쿼리 파라미터{' '}
              <span className="font-normal text-muted-foreground">
                (OData $expand · $select · $filter)
              </span>
            </Label>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() =>
                upd({ query_rows: [...(stream.query_rows || []), { key: '', value: '' }] })
              }
            >
              <Plus className="mr-1 h-3.5 w-3.5" /> 추가
            </Button>
          </div>
          {(stream.query_rows || []).map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                className="h-8 w-40 font-mono text-xs"
                placeholder="$expand"
                value={r.key}
                onChange={(e) => {
                  const rows = [...stream.query_rows]
                  rows[i] = { ...rows[i], key: e.target.value }
                  upd({ query_rows: rows })
                }}
              />
              <span className="text-muted-foreground">=</span>
              <Input
                className="h-8 flex-1 font-mono text-xs"
                placeholder="Product"
                value={r.value}
                onChange={(e) => {
                  const rows = [...stream.query_rows]
                  rows[i] = { ...rows[i], value: e.target.value }
                  upd({ query_rows: rows })
                }}
              />
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 shrink-0 p-0"
                onClick={() =>
                  upd({ query_rows: stream.query_rows.filter((_, j) => j !== i) })
                }
              >
                <XIcon className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          {(stream.query_rows || []).length === 0 && (
            <p className="text-[11px] text-muted-foreground">
              예: <code className="font-mono">$expand = Product</code> — navigation 을
              딸려와 관계/속성 경로에서 <code className="font-mono">Product.필드</code> 로
              뽑을 수 있습니다.
            </p>
          )}
        </div>

        <div className="flex items-end gap-2">
          <Button variant="outline" size="sm" onClick={() => onProbe(index)} disabled={probing}>
            {probing ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Search className="mr-1 h-4 w-4" />}
            샘플 조회
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onSuggest(index)}
            disabled={suggesting || !probeResult || !stream.target_type_id}
            title={!probeResult ? '먼저 샘플 조회를 하세요.' : '샘플을 보고 매핑 초안을 자동 제안'}
          >
            {suggesting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1 h-4 w-4" />}
            AI 자동 매핑
          </Button>
          {fieldPaths.length > 0 && (
            <span className="pb-1.5 text-xs text-muted-foreground">
              필드 {fieldPaths.length}개 조회됨
              {probeResult?.scanned ? ` (레코드 ${probeResult.scanned}건 기준)` : ''} —
              칸을 클릭해 고르거나 ‘AI 자동 매핑’으로 한 번에.
            </span>
          )}
        </div>

        {/* 이 스트림만 실행 — 큰 소스에서 문제 스트림만 재시도하거나 초기 백필을
            스트림별로 나눠 돌릴 때. 저장된 config 기준으로 도니 편집분은 먼저 저장. */}
        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          <span className="text-xs font-medium text-muted-foreground">이 스트림만:</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onRun('preview', index)}
            disabled={!canRun || busy != null}
            title={!canRun ? '먼저 저장한 뒤 실행하세요.' : '이 스트림만 미리보기(쓰기 없음)'}
          >
            {busy === `preview:${index}` ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Eye className="mr-1 h-4 w-4" />
            )}
            미리보기
          </Button>
          <Button
            size="sm"
            onClick={() => onRun('sync', index)}
            disabled={!canRun || busy != null}
            title={!canRun ? '먼저 저장한 뒤 실행하세요.' : '이 스트림만 동기화(온톨로지에 쓰기)'}
          >
            {busy === `sync:${index}` ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Play className="mr-1 h-4 w-4" />
            )}
            지금 동기화
          </Button>
        </div>
        {probeResult && (
          <>
            {/* 미리보기는 첫 레코드 1건 — 이 레코드에 null 인 값도 위 필드 목록에는
                있을 수 있다(목록은 전체 스캔 기준). 오해 없게 밝혀둔다. */}
            <p className="text-xs text-muted-foreground">
              아래는 <b>첫 레코드 1건</b>입니다. 여기서 <code>null</code>인 항목도 뒤쪽
              레코드에 값이 있으면 위 필드 목록에는 나옵니다.
            </p>
            <pre className="max-h-32 overflow-auto rounded-md border bg-muted/30 p-2 text-xs text-muted-foreground">
              {JSON.stringify(probeResult.sample?.[0] ?? {}, null, 2)}
            </pre>
          </>
        )}

        {/* 값(이름) */}
        <div>
          <Label className="text-xs">값(이름) 필드 경로</Label>
          <PathInput dlId={dlId} value={stream.value_path} onChange={(v) => upd({ value_path: v })} placeholder="name" />
        </div>

        {/* 매칭 기준 — 코드(안정 식별자)로 매칭하면 이름이 바뀌어도 재동기화 시 중복이 안 생김 */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs">매칭 기준 (같은 객체 판별)</Label>
            <select
              value={stream.match_key}
              onChange={(e) => upd({ match_key: e.target.value })}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="value">이름으로 매칭</option>
              <option value="code">코드(안정 식별자)로 매칭 — 권장</option>
            </select>
          </div>
          {stream.match_key === 'code' && (
            <div>
              <Label className="text-xs">코드 필드 경로</Label>
              <PathInput dlId={dlId} value={stream.code_path} onChange={(v) => upd({ code_path: v })} placeholder="id" />
            </div>
          )}
        </div>
        {stream.match_key === 'code' && (
          <p className="-mt-1 text-xs text-muted-foreground">
            코드가 같으면 같은 객체로 봅니다 — 외부에서 이름이 바뀌어도 재동기화 시 새로 만들지 않고 갱신합니다.
          </p>
        )}

        {/* 속성 — 대상 축에서 자동 리스트업 */}
        <div>
          <Label className="text-xs">속성 매핑 {axisDefs ? `(${defKeys.length}개 속성)` : ''}</Label>
          {!stream.target_type_id ? (
            <p className="py-1 text-xs text-muted-foreground">대상 축을 먼저 선택하세요.</p>
          ) : axisDefs === null ? (
            <p className="py-1 text-xs text-muted-foreground">속성 불러오는 중…</p>
          ) : defKeys.length === 0 && extraKeys.length === 0 ? (
            <p className="py-1 text-xs text-muted-foreground">
              이 축엔 정의된 속성이 없습니다. (엔티티 관리에서 속성을 추가하면 여기 자동으로 뜹니다.)
            </p>
          ) : (
            <div className="space-y-1.5">
              {(axisDefs || []).map((d) => (
                <div key={d.key} className="flex items-center gap-2">
                  <div className="w-40 shrink-0 truncate text-sm" title={`${d.label} (${d.key})`}>
                    {d.label}
                    <span className="ml-1 text-xs text-muted-foreground">{d.data_type}</span>
                  </div>
                  <span className="text-muted-foreground">←</span>
                  <PathInput
                    dlId={dlId}
                    value={stream.prop_paths[d.key] || ''}
                    onChange={(v) => setProp(d.key, v)}
                    placeholder="필드 경로 (비우면 매핑 안 함)"
                  />
                </div>
              ))}
              {extraKeys.map((k) => (
                <div key={k} className="flex items-center gap-2">
                  <div className="w-40 shrink-0 truncate text-sm text-muted-foreground" title={k}>
                    {k}
                  </div>
                  <span className="text-muted-foreground">←</span>
                  <PathInput dlId={dlId} value={stream.prop_paths[k] || ''} onChange={(v) => setProp(k, v)} placeholder="필드 경로" />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    onClick={() => {
                      const next = { ...stream.prop_paths }
                      delete next[k]
                      upd({ prop_paths: next })
                    }}
                  >
                    <XIcon className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 관계 매핑 */}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <Label className="text-xs">관계 매핑 (관계 · 대상 축 · 필드 경로)</Label>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => upd({ relation_rows: [...stream.relation_rows, { relation: '', target_type: '', path: '', match_key: 'value' }] })}
            >
              <Plus className="h-3.5 w-3.5" /> 추가
            </Button>
          </div>
          {stream.relation_rows.map((r, i) => (
            <div key={i} className="mb-1.5 flex items-center gap-2">
              <select
                value={r.relation}
                onChange={(e) => {
                  const rows = [...stream.relation_rows]
                  rows[i] = { ...rows[i], relation: e.target.value }
                  upd({ relation_rows: rows })
                }}
                className="h-8 rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="">관계</option>
                {relationTypes.map((rt) => (
                  <option key={rt.slug} value={rt.slug}>
                    {rt.label}
                  </option>
                ))}
              </select>
              <select
                value={r.target_type}
                onChange={(e) => {
                  const rows = [...stream.relation_rows]
                  rows[i] = { ...rows[i], target_type: e.target.value }
                  upd({ relation_rows: rows })
                }}
                className="h-8 rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="">대상 축</option>
                {axes.map((a) => (
                  <option key={a.id} value={a.slug}>
                    {a.label}
                  </option>
                ))}
              </select>
              <PathInput
                dlId={dlId}
                value={r.path}
                onChange={(v) => {
                  const rows = [...stream.relation_rows]
                  rows[i] = { ...rows[i], path: v }
                  upd({ relation_rows: rows })
                }}
                placeholder={r.match_key === 'code' ? '코드 필드 경로' : '필드 경로'}
              />
              <select
                value={r.match_key || 'value'}
                onChange={(e) => {
                  const rows = [...stream.relation_rows]
                  rows[i] = { ...rows[i], match_key: e.target.value }
                  upd({ relation_rows: rows })
                }}
                title="대상 객체를 이름으로 찾을지, 코드(안정 식별자)로 찾을지"
                className="h-8 rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="value">이름</option>
                <option value="code">코드</option>
              </select>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={() => upd({ relation_rows: stream.relation_rows.filter((_, j) => j !== i) })}
              >
                <XIcon className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>

        {/* 고급 — 페이지네이션 · 증분 */}
        <details className="rounded-md border px-3 py-2">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            고급 — 페이지네이션 · 증분 동기화
          </summary>
          <div className="mt-3 space-y-3">
            {/* 페이지네이션 */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">페이지네이션</Label>
                <select
                  value={stream.page_style}
                  onChange={(e) => upd({ page_style: e.target.value })}
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                >
                  <option value="none">없음 (단일 요청)</option>
                  <option value="offset">offset (오프셋+개수)</option>
                  <option value="page">page (페이지번호+개수)</option>
                  <option value="cursor">cursor (다음 커서)</option>
                  <option value="next_url">다음 URL 따라가기 (OData nextLink 등)</option>
                </select>
              </div>
              {(stream.page_style === 'offset' || stream.page_style === 'page') && (
                <div>
                  <Label className="text-xs">페이지 크기</Label>
                  <Input type="number" min={1} value={stream.page_size}
                    onChange={(e) => upd({ page_size: e.target.value })} />
                </div>
              )}
            </div>
            {(stream.page_style === 'offset' || stream.page_style === 'page') && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">{stream.page_style === 'offset' ? '오프셋' : '페이지'} 파라미터명</Label>
                  <Input value={stream.page_param} onChange={(e) => upd({ page_param: e.target.value })}
                    placeholder={stream.page_style === 'offset' ? 'offset' : 'page'} />
                </div>
                <div>
                  <Label className="text-xs">개수 파라미터명</Label>
                  <Input value={stream.size_param} onChange={(e) => upd({ size_param: e.target.value })} placeholder="limit" />
                </div>
              </div>
            )}
            {stream.page_style === 'cursor' && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">다음 커서 경로(응답)</Label>
                  <Input value={stream.cursor_path} onChange={(e) => upd({ cursor_path: e.target.value })} placeholder="meta.next_cursor" />
                </div>
                <div>
                  <Label className="text-xs">커서 파라미터명</Label>
                  <Input value={stream.cursor_param} onChange={(e) => upd({ cursor_param: e.target.value })} placeholder="cursor" />
                </div>
              </div>
            )}
            {stream.page_style === 'next_url' && (
              <div>
                <Label className="text-xs">다음 URL 경로(응답)</Label>
                <Input value={stream.next_url_path} onChange={(e) => upd({ next_url_path: e.target.value })} placeholder="@odata.nextLink" />
                <p className="mt-1 text-xs text-muted-foreground">응답이 알려주는 완전한 다음 URL을 그대로 따라갑니다.</p>
              </div>
            )}

            {/* 자동 스킵 — offset 에서만 의미. 특정 레코드가 서버 오류를 내면 그 1건만
                건너뛰고 이어받는다(그 레코드는 버려짐). */}
            {stream.page_style === 'offset' && (
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-0.5" checked={stream.skip_on_error}
                  onChange={(e) => upd({ skip_on_error: e.target.checked })} />
                <span>
                  서버 오류 레코드 자동 스킵
                  <span className="block text-xs text-muted-foreground">
                    어떤 페이지가 서버 오류(예: 500)로 중간에 실패하면, 받은 만큼은
                    취하고 실패한 레코드 1건을 건너뛰어 계속 가져옵니다. 그 레코드는
                    수집되지 않으며 건너뛴 수는 로그에 남습니다.
                  </span>
                </span>
              </label>
            )}

            {/* 오프셋 백필 — 초기 대량 적재(상한 초과)를 실행마다 한 창씩 나눠 받기 */}
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5" checked={stream.backfill}
                onChange={(e) => upd({ backfill: e.target.checked })} />
              <span>
                오프셋 백필 (초기 대량 적재를 나눠서)
                <span className="block text-xs text-muted-foreground">
                  한 번에 다 못 받을 때, 실행할 때마다 정한 개수(기본 2만, 아래에서
                  조정)만큼 이어서 받습니다. 필터 없이 <code>$skip</code>(오프셋 파라미터)+
                  <code>$top</code>(개수 파라미터)로 페이징합니다. 다 받으면 자동으로
                  멈추고, 이후 실제 변경분은 증분 동기화로 넘기면 됩니다.
                </span>
              </span>
            </label>
            {stream.backfill && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-muted-foreground">
                <div className="mb-2 flex items-center gap-2">
                  <Label className="text-xs">한 번에 받을 개수(창 크기)</Label>
                  <Input
                    type="number"
                    min={0}
                    max={20000}
                    className="h-8 w-28"
                    value={stream.backfill_window || ''}
                    placeholder="20000"
                    onChange={(e) => upd({ backfill_window: e.target.value })}
                  />
                  <span>비우면 기본 2만(상한). 그보다 크게 넣어도 2만으로 제한됩니다.</span>
                </div>
                <p className="font-medium text-amber-600 dark:text-amber-400">설정 확인</p>
                <ul className="ml-4 list-disc space-y-0.5">
                  <li>
                    쿼리에 <code>$orderby</code>로 <b>안정 정렬</b>을 넣으세요(예: 기본키·
                    코드). 정렬이 흔들리면 창 경계에서 누락·중복이 생깁니다.
                  </li>
                  <li>
                    <b>개수 파라미터명</b>=<code>$top</code>, <b>오프셋 파라미터명</b>=
                    <code>$skip</code>, <b>페이지 크기</b>는 서버가 한 번에 돌려주는
                    실제 페이지 크기와 같게 두세요.
                  </li>
                  <li>매칭 기준을 <b>코드</b>로 두면 창이 겹쳐도 중복 없이 갱신됩니다.</li>
                </ul>
                {(() => {
                  const off = syncState?.[`${index}:backfill_offset`]
                  const done = syncState?.[`${index}:backfill_done`] === '1'
                  if (off == null && !done) {
                    return <p className="mt-1">진행 상태: 아직 시작 안 함 (다음 실행이 offset 0부터).</p>
                  }
                  return (
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <span>
                        진행 상태:{' '}
                        {done ? (
                          <b className="text-emerald-600 dark:text-emerald-400">완료</b>
                        ) : (
                          <>다음 실행은 offset <b>{off ?? 0}</b>부터</>
                        )}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-xs"
                        onClick={() => onResetBackfill(index)}
                        disabled={!canRun}
                        title="offset 0부터 다시 받도록 진행 상태를 초기화"
                      >
                        위치 초기화
                      </Button>
                    </div>
                  )
                })()}
              </div>
            )}

            {/* 증분 */}
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={stream.incremental}
                onChange={(e) => upd({ incremental: e.target.checked })} />
              증분 동기화 (마지막 이후 바뀐 것만)
            </label>
            {stream.incremental && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">변경 기준 필드</Label>
                  <PathInput dlId={dlId} value={stream.watermark_field}
                    onChange={(v) => upd({ watermark_field: v })} placeholder="updatedAt" />
                </div>
                <div>
                  <Label className="text-xs">since 파라미터명</Label>
                  <Input value={stream.watermark_param} onChange={(e) => upd({ watermark_param: e.target.value })} placeholder="updated_since / $filter" />
                </div>
              </div>
            )}
            {stream.incremental && (
              <div>
                <Label className="text-xs">필터 식 템플릿 (선택 — OData 등)</Label>
                <Input value={stream.watermark_template} onChange={(e) => upd({ watermark_template: e.target.value })}
                  placeholder="Modified gt {since}" />
                <p className="mt-1 text-xs text-muted-foreground">
                  값에 식이 필요한 API용. `{'{since}'}`·`{'{field}'}`가 치환됩니다. 예: `$filter` 파라미터에 `Modified gt {'{since}'}`. 비우면 값=마지막 시각 그대로.
                </p>
              </div>
            )}
            {stream.incremental && (
              <p className="text-xs text-muted-foreground">
                변경 기준 필드의 최댓값을 기억해, 다음 동기화 때 그 이후 변경분만 요청합니다. (ISO 날짜·증가 ID 처럼 커지는 값이어야 함)
              </p>
            )}
          </div>
        </details>
      </CardContent>
    </Card>
  )
}

/**
 * 관리자 — 외부 시스템 연계 커넥터. 커넥션(접속) 1개 + 스트림(엔드포인트→축) 여러 개.
 * 대상 축을 고르면 속성이 자동 리스트업되고, 샘플 조회한 키가 경로칸 자동완성으로 뜬다.
 */
export default function ConnectorsAdminPage() {
  const { me } = useAuth()
  const isAdmin = me?.is_system_admin === true

  const { data: listData, loading, error, reload } = useAsync(
    () => (isAdmin ? listDataSources() : Promise.resolve(null)),
    [isAdmin],
  )
  const { data: axesData } = useAsync(() => (isAdmin ? listEntityTypes() : Promise.resolve(null)), [isAdmin])
  const { data: relData } = useAsync(() => (isAdmin ? listRelationTypes() : Promise.resolve(null)), [isAdmin])

  const sources = useMemo(() => listData?.items ?? [], [listData])
  const axes = useMemo(() => axesData?.items ?? [], [axesData])
  const relationTypes = useMemo(() => relData?.items ?? [], [relData])
  const axisName = useMemo(() => Object.fromEntries(axes.map((a) => [a.id, a.label])), [axes])

  const [selectedId, setSelectedId] = useState(null)
  const [draft, setDraft] = useState(null)
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState(null)
  const [probing, setProbing] = useState(null)
  const [suggesting, setSuggesting] = useState(null)
  const [probeResults, setProbeResults] = useState({})
  const [result, setResult] = useState(null)
  const [runs, setRuns] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [selStream, setSelStream] = useState(0) // 좌측 리스트에서 선택한 스트림 index

  // 축 속성정의 캐시 {typeId: [defs]} (null=로딩 전/중).
  const [axisProps, setAxisProps] = useState({})
  const loadingAxis = useRef(new Set())
  function ensureAxisProps(id) {
    id = Number(id)
    if (!id || loadingAxis.current.has(id)) return
    loadingAxis.current.add(id)
    setAxisProps((p) => ({ ...p, [id]: p[id] ?? null }))
    listTypeProperties(id)
      .then((res) => setAxisProps((p) => ({ ...p, [id]: res.items || [] })))
      .catch(() => setAxisProps((p) => ({ ...p, [id]: [] })))
  }
  // draft 의 각 스트림 대상 축 속성을 미리 로드.
  useEffect(() => {
    if (!draft) return
    for (const st of draft.streams) if (st.target_type_id) ensureAxisProps(st.target_type_id)
  }, [draft])

  function openNew() {
    setSelectedId('new')
    setDraft(blankDraft())
    setResult(null)
    setRuns(null)
    setProbeResults({})
    setSelStream(0)
  }
  async function openEdit(id) {
    setSelectedId(id)
    setResult(null)
    setRuns(null)
    setProbeResults({})
    setSelStream(0)
    try {
      setDraft(draftFromSource(await getDataSource(id)))
    } catch (err) {
      toast.error(err?.response?.data?.message || '소스를 불러오지 못했습니다.')
      setSelectedId(null)
    }
  }
  function closeEditor() {
    setSelectedId(null)
    setDraft(null)
    setResult(null)
    setRuns(null)
  }
  function set(field, value) {
    setDraft((d) => ({ ...d, [field]: value }))
  }
  function setStream(i, next) {
    setDraft((d) => ({ ...d, streams: d.streams.map((s, j) => (j === i ? next : s)) }))
  }
  function addStream() {
    setDraft((d) => ({ ...d, streams: [...d.streams, blankStream()] }))
    setSelStream(draft ? draft.streams.length : 0) // 새로 추가한 스트림 선택
  }
  function removeStream(i) {
    setDraft((d) => ({ ...d, streams: d.streams.filter((_, j) => j !== i) }))
    // 삭제 후 남은 범위로 선택 보정.
    setSelStream((s) => Math.max(0, Math.min(s, (draft?.streams.length ?? 1) - 2)))
  }

  async function save() {
    if (!draft.name.trim()) return toast.error('이름을 입력하세요.')
    if (draft.streams.length === 0) return toast.error('스트림을 하나 이상 추가하세요.')
    if (draft.streams.some((s) => !Number(s.target_type_id)))
      return toast.error('모든 스트림에 대상 축을 선택하세요.')
    setSaving(true)
    try {
      const body = {
        name: draft.name.trim(),
        enabled: draft.enabled,
        config: draftToConfig(draft),
        schedule_kind: draft.schedule_kind,
        interval_minutes: draft.schedule_kind === 'interval' ? Number(draft.interval_minutes) : null,
      }
      if (selectedId === 'new') {
        const created = await createDataSource({ kind: 'rest_json', ...body })
        toast.success('데이터소스를 등록했습니다.')
        reload()
        openEdit(created.id)
      } else {
        await updateDataSource(selectedId, body)
        toast.success('저장했습니다.')
        reload()
      }
    } catch (err) {
      toast.error(err?.response?.data?.message || '저장에 실패했습니다.')
    } finally {
      setSaving(false)
    }
  }

  async function doProbe(streamIndex) {
    setProbing(streamIndex)
    try {
      const connection = draftToConnection(draft)
      const stream = streamToConfig(draft.streams[streamIndex])
      // 저장된 소스 편집 중이면 selectedId 를 넘겨 마스킹된 토큰을 서버가 채우게.
      const res = await probeDataSource(connection, stream, selectedId)
      setProbeResults((p) => ({ ...p, [streamIndex]: res }))
      toast.success(`레코드 ${res.record_count}건 · 필드 ${res.fields.length}개`)
    } catch (err) {
      toast.error(err?.response?.data?.message || '응답을 가져오지 못했습니다.')
    } finally {
      setProbing(null)
    }
  }

  async function doSuggest(i) {
    const st = draft.streams[i]
    // probe 결과를 통째로 — 1건만 주면 그 레코드에서 null 인 navigation 을 AI 가
    // 못 본다(SPDM product 등). 샘플 5건 + 전체 스캔 경로를 함께 넘긴다.
    const probe = probeResults[i]
    if (!Number(st.target_type_id)) return toast.error('대상 축을 먼저 선택하세요.')
    if (!probe?.sample?.length) return toast.error('먼저 샘플 조회를 하세요.')
    setSuggesting(i)
    try {
      const res = await suggestMapping(Number(st.target_type_id), probe)
      setStream(i, {
        ...st,
        value_path: res.value_path || st.value_path,
        prop_paths: { ...st.prop_paths, ...(res.property_map || {}) },
        relation_rows:
          res.relation_map && res.relation_map.length
            ? res.relation_map.map((r) => ({ relation: r.relation, target_type: r.target_type, path: r.path }))
            : st.relation_rows,
      })
      const n = Object.keys(res.property_map || {}).length
      toast.success(`AI 매핑 제안 (${res.source === 'llm' ? 'LLM' : '자동 추정'}) — 속성 ${n}개 채움. 확인 후 저장하세요.`)
    } catch (err) {
      toast.error(err?.response?.data?.message || '자동 매핑에 실패했습니다.')
    } finally {
      setSuggesting(null)
    }
  }

  async function doAction(kind, streamIndex = null) {
    if (selectedId === 'new') return toast.error('먼저 저장한 뒤 실행하세요.')
    // busy 키에 스트림 인덱스를 실어(예: 'sync:2') 그 버튼만 돌게 한다.
    const busyKey = streamIndex != null ? `${kind}:${streamIndex}` : kind
    setBusy(busyKey)
    setResult(null)
    try {
      const res =
        kind === 'preview'
          ? await previewDataSource(selectedId, streamIndex)
          : await syncDataSource(selectedId, streamIndex)
      setResult({ kind, streamIndex, ...res })
      if (kind === 'sync') {
        toast.success(streamIndex != null ? '이 스트림 동기화 완료.' : '동기화 완료.')
        reload()
        // 백필 오프셋이 전진했을 수 있어 진행률 표시를 새 sync_state 로 갱신.
        try {
          const fresh = await getDataSource(selectedId)
          setDraft((d) => (d ? { ...d, sync_state: fresh.sync_state || {} } : d))
        } catch {
          /* 진행률 갱신 실패는 치명적 아님 */
        }
      }
    } catch (err) {
      toast.error(err?.response?.data?.message || '실행에 실패했습니다.')
    } finally {
      setBusy(null)
    }
  }

  async function doResetBackfill(streamIndex) {
    if (selectedId === 'new') return
    try {
      const res = await resetBackfill(selectedId, streamIndex)
      // 반환된 sync_state 로 draft 의 진행률 표시를 갱신(편집 config 는 그대로).
      setDraft((d) => (d ? { ...d, sync_state: res.sync_state || {} } : d))
      toast.success('백필 위치를 초기화했습니다. 다음 실행이 offset 0부터 받습니다.')
    } catch (err) {
      toast.error(err?.response?.data?.message || '초기화에 실패했습니다.')
    }
  }

  async function loadRuns() {
    setBusy('runs')
    try {
      const res = await listSyncRuns(selectedId)
      setRuns(res.items || [])
    } catch (err) {
      toast.error(err?.response?.data?.message || '이력을 불러오지 못했습니다.')
    } finally {
      setBusy(null)
    }
  }

  async function doDelete() {
    try {
      await deleteDataSource(selectedId)
      toast.success('삭제했습니다.')
      closeEditor()
      reload()
    } catch (err) {
      toast.error(err?.response?.data?.message || '삭제에 실패했습니다.')
    }
  }

  if (!isAdmin) {
    return (
      <div className="p-6">
        <PageHeader title="외부 시스템 연계" description="데이터 커넥터" />
        <ErrorState
          title="권한 없음"
          description="시스템 관리자만 접근할 수 있습니다."
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
    <div className="p-6 space-y-4 max-w-5xl">
      <PageHeader
        title="외부 시스템 연계"
        description="외부 시스템(커넥션)을 한 번 등록하고, 그 아래 여러 스트림(엔드포인트→축 매핑)을 둡니다. 대상 축을 고르면 속성이 자동으로 뜨고, ‘샘플 조회’한 응답의 키가 경로칸 자동완성으로 나옵니다."
      />

      {selectedId === null ? (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Network className="h-4 w-4" /> 데이터소스
                </CardTitle>
                <CardDescription>등록된 외부 연계 목록</CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={reload} disabled={loading}>
                  <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                </Button>
                <Button size="sm" onClick={openNew}>
                  <Plus className="mr-1 h-4 w-4" /> 새 소스
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {loading ? (
              <p className="py-8 text-center text-sm text-muted-foreground">불러오는 중…</p>
            ) : error ? (
              <ErrorState description={error.message} onRetry={reload} />
            ) : sources.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                등록된 데이터소스가 없습니다. “새 소스”로 외부 API 를 연결하세요.
              </p>
            ) : (
              <div className="divide-y rounded-md border">
                {sources.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => openEdit(s.id)}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-muted/40"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium truncate">{s.name}</span>
                        {!s.enabled && (
                          <Badge variant="outline" className="text-xs">
                            비활성
                          </Badge>
                        )}
                        <Badge variant="secondary" className="text-xs">
                          스트림 {s.config?.streams?.length ?? 0}
                        </Badge>
                        {s.schedule_kind === 'interval' && (
                          <Badge variant="outline" className="text-xs">
                            주기 {s.interval_minutes}분
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">{s.config?.connection?.base_url || '—'}</div>
                    </div>
                    <div className="flex flex-col items-end gap-0.5 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <StatusBadge status={s.last_status} />
                        <span className="text-xs text-muted-foreground">
                          {s.last_run_at ? s.last_run_at.slice(0, 16).replace('T', ' ') : '미실행'}
                        </span>
                      </div>
                      {s.schedule_kind === 'interval' && s.next_run_at && (
                        <span className="text-xs text-muted-foreground">
                          다음 {s.next_run_at.slice(0, 16).replace('T', ' ')}
                        </span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        draft && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <Button variant="ghost" size="sm" onClick={closeEditor}>
                <XIcon className="mr-1 h-4 w-4" /> 목록으로
              </Button>
              {selectedId !== 'new' && (
                <Button variant="ghost" size="sm" className="text-red-600" onClick={() => setConfirmDelete(true)}>
                  <Trash2 className="mr-1 h-4 w-4" /> 삭제
                </Button>
              )}
            </div>

            {/* 커넥션(접속) */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">커넥션 (접속 — 모든 스트림 공유)</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs">이름</Label>
                    <Input value={draft.name} onChange={(e) => set('name', e.target.value)} placeholder="사내 PLM" />
                  </div>
                  <div className="flex items-end">
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={draft.enabled} onChange={(e) => set('enabled', e.target.checked)} />
                      활성
                    </label>
                  </div>
                  <div className="col-span-2">
                    <Label className="text-xs">Base URL</Label>
                    <Input value={draft.base_url} onChange={(e) => set('base_url', e.target.value)} placeholder="https://plm.corp" />
                  </div>
                  <div>
                    <Label className="text-xs">인증</Label>
                    <select
                      value={draft.auth_type}
                      onChange={(e) => set('auth_type', e.target.value)}
                      className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                    >
                      <option value="none">없음</option>
                      <option value="bearer">Bearer 토큰</option>
                      <option value="api_key">API Key 헤더</option>
                      <option value="basic">Basic</option>
                    </select>
                  </div>
                </div>

                {draft.auth_type === 'bearer' && (
                  <div>
                    <Label className="text-xs">토큰 {draft.has_secret && '(저장됨 — 비우면 유지)'}</Label>
                    <Input
                      type="password"
                      value={draft.auth_token}
                      onChange={(e) => set('auth_token', e.target.value)}
                      placeholder={draft.has_secret ? '••••••• (변경 시에만 입력)' : ''}
                    />
                  </div>
                )}
                {draft.auth_type === 'api_key' && (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs">헤더 이름</Label>
                      <Input value={draft.auth_header} onChange={(e) => set('auth_header', e.target.value)} />
                    </div>
                    <div>
                      <Label className="text-xs">키 {draft.has_secret && '(저장됨 — 비우면 유지)'}</Label>
                      <Input
                        type="password"
                        value={draft.auth_token}
                        onChange={(e) => set('auth_token', e.target.value)}
                        placeholder={draft.has_secret ? '•••••••' : ''}
                      />
                    </div>
                  </div>
                )}
                {draft.auth_type === 'basic' && (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs">사용자</Label>
                      <Input value={draft.auth_username} onChange={(e) => set('auth_username', e.target.value)} />
                    </div>
                    <div>
                      <Label className="text-xs">비밀번호 {draft.has_secret && '(저장됨 — 비우면 유지)'}</Label>
                      <Input
                        type="password"
                        value={draft.auth_password}
                        onChange={(e) => set('auth_password', e.target.value)}
                        placeholder={draft.has_secret ? '•••••••' : ''}
                      />
                    </div>
                  </div>
                )}

                {/* 스케줄 */}
                <div className="grid grid-cols-2 gap-3 border-t pt-3">
                  <div>
                    <Label className="text-xs">동기화 스케줄</Label>
                    <select
                      value={draft.schedule_kind}
                      onChange={(e) => set('schedule_kind', e.target.value)}
                      className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                    >
                      <option value="manual">수동 (지금 동기화만)</option>
                      <option value="interval">주기 자동</option>
                    </select>
                  </div>
                  {draft.schedule_kind === 'interval' && (
                    <div>
                      <Label className="text-xs">주기(분)</Label>
                      <Input
                        type="number"
                        min={1}
                        value={draft.interval_minutes}
                        onChange={(e) => set('interval_minutes', e.target.value)}
                      />
                    </div>
                  )}
                </div>
                {draft.schedule_kind === 'interval' && (
                  <p className="text-xs text-muted-foreground">
                    저장하면 약 {draft.interval_minutes}분마다 자동 동기화됩니다. (운영에서 스케줄러·워커가 켜져
                    있어야 실제 실행됩니다.)
                  </p>
                )}
              </CardContent>
            </Card>

            {/* 스트림들 — 좌측 리스트 / 우측 편집 카드 (마스터-디테일) */}
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-muted-foreground">
                스트림 (엔드포인트 → 축 매핑) · 위에서부터 순서대로 동기화
              </h3>
              <Button variant="outline" size="sm" onClick={addStream}>
                <Plus className="mr-1 h-4 w-4" /> 스트림 추가
              </Button>
            </div>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-stretch">
              {/* 좌측: 스트림 목록 — 우측 카드 높이에 맞춰 내부 세로 스크롤(sm+).
                  절대위치라 리스트가 행 높이를 키우지 않고 카드가 높이를 주도한다. */}
              <div className="relative w-full shrink-0 sm:w-56">
                <div className="space-y-1 sm:absolute sm:inset-0 sm:overflow-y-auto sm:pr-1">
                {draft.streams.length === 0 ? (
                  <p className="rounded-md border border-dashed px-2 py-6 text-center text-xs text-muted-foreground">
                    스트림 없음 — “스트림 추가”
                  </p>
                ) : (
                  draft.streams.map((st, i) => (
                    <button
                      key={i}
                      onClick={() => setSelStream(i)}
                      className={`flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left ${
                        i === selStream ? 'border-primary bg-muted/50' : 'hover:bg-muted/30'
                      }`}
                    >
                      <span className="w-4 shrink-0 text-xs text-muted-foreground">{i + 1}</span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">
                          {st.label || `스트림 ${i + 1}`}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {axisName[Number(st.target_type_id)] || '축 미선택'}
                        </span>
                      </span>
                    </button>
                  ))
                )}
                </div>
              </div>
              {/* 우측: 선택한 스트림 편집 카드 */}
              <div className="min-w-0 flex-1">
                {draft.streams[selStream] ? (
                  <StreamEditor
                    key={selStream}
                    stream={draft.streams[selStream]}
                    index={selStream}
                    axes={axes}
                    axisDefs={
                      draft.streams[selStream].target_type_id
                        ? axisProps[Number(draft.streams[selStream].target_type_id)] ?? null
                        : []
                    }
                    relationTypes={relationTypes}
                    onChange={setStream}
                    onRemove={removeStream}
                    onProbe={doProbe}
                    probing={probing === selStream}
                    probeResult={probeResults[selStream]}
                    onSuggest={doSuggest}
                    suggesting={suggesting === selStream}
                    onRun={doAction}
                    busy={busy}
                    canRun={selectedId !== 'new'}
                    syncState={draft.sync_state}
                    onResetBackfill={doResetBackfill}
                  />
                ) : (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    왼쪽에서 스트림을 선택하거나 “스트림 추가”를 누르세요.
                  </p>
                )}
              </div>
            </div>

            {/* 액션 */}
            <Card>
              <CardContent className="space-y-3 pt-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Button onClick={save} disabled={saving}>
                    {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                    저장
                  </Button>
                  <Button variant="outline" onClick={() => doAction('preview')} disabled={busy != null || selectedId === 'new'}>
                    {busy === 'preview' ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Eye className="mr-1 h-4 w-4" />}
                    전체 미리보기(dry-run)
                  </Button>
                  <Button onClick={() => doAction('sync')} disabled={busy != null || selectedId === 'new'}>
                    {busy === 'sync' ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Play className="mr-1 h-4 w-4" />}
                    전체 동기화
                  </Button>
                  <Button variant="ghost" onClick={loadRuns} disabled={busy != null || selectedId === 'new'}>
                    <History className="mr-1 h-4 w-4" /> 이력
                  </Button>
                </div>

                {(result?.kind === 'preview' || result?.kind === 'sync') && (
                  <div className="rounded-md border bg-muted/30 p-3">
                    <p className="mb-1 text-sm font-medium">
                      {result.kind === 'preview' ? '미리보기 결과' : '동기화 결과'}
                      {result.streamIndex != null ? ` · 스트림 ${result.streamIndex + 1}만 실행` : ''}
                    </p>
                    <SummaryLine summary={result.summary} />
                    <div className="mt-2 space-y-1">
                      {(result.streams || []).map((sr, i) => (
                        <div key={i} className="text-xs">
                          <span className="font-medium">
                            {sr.label} · {axisName[sr.target_type_id] || `축#${sr.target_type_id}`}
                          </span>
                          {sr.error ? (
                            <span className="text-red-600"> — 오류: {sr.error}</span>
                          ) : (
                            <span className="text-muted-foreground">
                              {' '}
                              — 생성 {sr.summary.create} · 갱신 {sr.summary.update} · 오류 {sr.summary.error} · 링크{' '}
                              {sr.summary.linked}
                            </span>
                          )}
                          {sr.backfill && !sr.backfill.idle && (
                            <span className="ml-1 text-amber-600 dark:text-amber-400">
                              · 백필 offset {sr.backfill.from}→{sr.backfill.to}
                              {sr.backfill.done ? ' (완료 ✓)' : ' (다음 실행에서 계속)'}
                            </span>
                          )}
                          {sr.backfill?.idle && (
                            <span className="ml-1 text-muted-foreground">· 백필 완료 — 받을 것 없음</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {runs && (
                  <div className="rounded-md border">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/40 text-xs text-muted-foreground">
                        <tr>
                          <th className="px-2 py-1.5 text-left">시각</th>
                          <th className="px-2 py-1.5 text-left">상태</th>
                          <th className="px-2 py-1.5 text-left">트리거</th>
                          <th className="px-2 py-1.5 text-left">결과</th>
                        </tr>
                      </thead>
                      <tbody>
                        {runs.length === 0 ? (
                          <tr>
                            <td colSpan={4} className="px-2 py-4 text-center text-muted-foreground">
                              이력이 없습니다.
                            </td>
                          </tr>
                        ) : (
                          runs.map((r) => (
                            <tr key={r.id} className="border-t">
                              <td className="px-2 py-1.5 whitespace-nowrap">{r.started_at?.slice(0, 16).replace('T', ' ')}</td>
                              <td className="px-2 py-1.5">
                                <StatusBadge status={r.status} />
                              </td>
                              <td className="px-2 py-1.5 text-xs text-muted-foreground">{r.triggered_by}</td>
                              <td className="px-2 py-1.5 text-xs text-muted-foreground">
                                {r.error
                                  ? r.error.slice(0, 60)
                                  : r.summary
                                    ? `생성 ${r.summary.create} · 갱신 ${r.summary.update} · 오류 ${r.summary.error}`
                                    : '—'}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )
      )}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="데이터소스 삭제"
        description="이 데이터소스와 동기화 이력을 삭제합니다. 이미 온톨로지에 채워진 객체는 지워지지 않습니다. 되돌릴 수 없습니다."
        variant="destructive"
        confirmLabel="삭제"
        onConfirm={doDelete}
      />
    </div>
  )
}
