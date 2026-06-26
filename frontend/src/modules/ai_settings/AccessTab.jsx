import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Search, Trash2, User as UserIcon, Building2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Badge } from '@/shared/components/ui/badge'
import { cn } from '@/shared/lib/utils'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import { searchUsers } from '@/shared/api/members'
import {
  listAiEntitlements,
  createAiEntitlement,
  deleteAiEntitlement,
} from '@/shared/api/ai'

// 기능 라벨 — 백엔드 AiFeature enum 과 1:1.
const FEATURES = [
  { key: 'rag_qa', label: 'RAG 질문하기', desc: '아카이브에 자연어로 질문' },
  { key: 'auto_summary', label: '자동 요약·태깅', desc: '저장 시 초록/추천 태그' },
  {
    key: 'report_authoring',
    label: '보고서 작성하기',
    desc: 'Local LLM으로 보고서 내용 생성',
  },
  { key: 'all', label: '전체 (모든 AI 기능)', desc: '현재·향후 B300 기능 일괄' },
]
const FEATURE_LABEL = Object.fromEntries(FEATURES.map((f) => [f.key, f.label]))

/**
 * "AI 접근" 탭 (B300_보조AI_설계.md §E) — 시스템 관리자 전용. 기본 deny 라,
 * 여기서 명시적으로 허락한 유저/조직만 B300 기능을 쓴다(파일럿→점진 확대).
 */
export function AccessTab() {
  const { all: workspaces } = useWorkspace()
  const [items, setItems] = useState(null) // null=loading
  const [feature, setFeature] = useState('rag_qa')
  const [subjectKind, setSubjectKind] = useState('user')
  // 유저 선택
  const [userQuery, setUserQuery] = useState('')
  const [userResults, setUserResults] = useState([])
  const [picked, setPicked] = useState(null) // {id, label}
  // 조직 선택
  const [workspaceSlug, setWorkspaceSlug] = useState('')
  const [includeDescendants, setIncludeDescendants] = useState(false)
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const debounceRef = useRef(null)

  async function reload() {
    try {
      const res = await listAiEntitlements()
      setItems(res?.items ?? [])
    } catch (err) {
      toast.error('AI 접근 목록 불러오기 실패', {
        description: String(err?.message ?? err),
      })
      setItems([])
    }
  }
  useEffect(() => {
    reload()
  }, [])

  // 유저 검색(디바운스).
  useEffect(() => {
    if (subjectKind !== 'user') return undefined
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const q = userQuery.trim()
    if (!q) {
      setUserResults([])
      return undefined
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await searchUsers({ search: q, limit: 10 })
        setUserResults(res?.items ?? res ?? [])
      } catch {
        setUserResults([])
      }
    }, 250)
    return () => debounceRef.current && clearTimeout(debounceRef.current)
  }, [userQuery, subjectKind])

  // 조직 picker 후보 — personal/virtual 제외(개인공간은 유저 grant 로 커버).
  const orgWorkspaces = useMemo(
    () =>
      (workspaces ?? []).filter(
        (w) => w.kind !== 'personal' && !w.virtual,
      ),
    [workspaces],
  )

  const canSubmit =
    !submitting &&
    (subjectKind === 'user' ? !!picked : !!workspaceSlug)

  async function handleAdd() {
    if (!canSubmit) return
    setSubmitting(true)
    try {
      await createAiEntitlement({
        feature,
        subjectKind,
        userId: picked?.id,
        workspaceSlug,
        includeDescendants: subjectKind === 'workspace' && includeDescendants,
        note,
      })
      toast.success('AI 접근 권한 추가됨')
      // 리셋(기능·subjectKind 는 유지 — 연속 부여 편의).
      setPicked(null)
      setUserQuery('')
      setUserResults([])
      setWorkspaceSlug('')
      setIncludeDescendants(false)
      setNote('')
      reload()
    } catch (err) {
      toast.error(
        err?.response?.data?.message || err?.message || '추가 실패',
      )
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(row) {
    if (!window.confirm(`'${row.subject_label}'의 권한을 해제할까요?`)) return
    try {
      await deleteAiEntitlement(row.id)
      reload()
    } catch (err) {
      toast.error(err?.message || '해제 실패')
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        B300 보조 AI는 <strong>기본 차단</strong>입니다. 여기서 허락한 유저·부서만
        해당 기능을 쓸 수 있어요(파일럿으로 좁게 시작 → 점진 확대). 시스템 관리자는
        항상 사용 가능합니다.
      </p>

      {/* 추가 폼 */}
      <div className="space-y-3 rounded-md border p-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-muted-foreground">
            기능
            <select
              value={feature}
              onChange={(e) => setFeature(e.target.value)}
              className="mt-1 block h-8 rounded-md border bg-background px-2 text-xs"
            >
              {FEATURES.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>

          <div className="text-xs text-muted-foreground">
            대상
            <div className="mt-1 inline-flex rounded-md border p-0.5">
              <button
                type="button"
                onClick={() => setSubjectKind('user')}
                className={cn(
                  'flex items-center gap-1 rounded px-2 py-1 text-xs',
                  subjectKind === 'user'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground',
                )}
              >
                <UserIcon className="h-3 w-3" /> 유저
              </button>
              <button
                type="button"
                onClick={() => setSubjectKind('workspace')}
                className={cn(
                  'flex items-center gap-1 rounded px-2 py-1 text-xs',
                  subjectKind === 'workspace'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground',
                )}
              >
                <Building2 className="h-3 w-3" /> 부서
              </button>
            </div>
          </div>
        </div>

        {/* 대상 선택 */}
        {subjectKind === 'user' ? (
          <div>
            {picked ? (
              <div className="flex items-center gap-2 text-xs">
                <Badge variant="secondary">{picked.label}</Badge>
                <button
                  type="button"
                  onClick={() => setPicked(null)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  변경
                </button>
              </div>
            ) : (
              <div className="relative max-w-sm">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={userQuery}
                  onChange={(e) => setUserQuery(e.target.value)}
                  placeholder="이메일·이름으로 유저 검색"
                  className="h-8 pl-7 text-sm"
                />
                {userResults.length > 0 && (
                  <ul className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-md border bg-background shadow">
                    {userResults.map((u) => (
                      <li key={u.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setPicked({ id: u.id, label: u.email || u.name })
                            setUserResults([])
                          }}
                          className="block w-full px-2 py-1.5 text-left text-xs hover:bg-accent"
                        >
                          {u.email || u.name}
                          {u.name && u.email && (
                            <span className="ml-1 text-muted-foreground">
                              ({u.name})
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <select
              value={workspaceSlug}
              onChange={(e) => setWorkspaceSlug(e.target.value)}
              className="h-8 max-w-sm rounded-md border bg-background px-2 text-xs"
            >
              <option value="">부서 선택…</option>
              {orgWorkspaces.map((w) => (
                <option key={w.slug} value={w.slug}>
                  {w.name}
                </option>
              ))}
            </select>
            <label
              className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground"
              title="기본 OFF — 켜면 이 부서의 하위 부서 멤버까지 적용(상위→하위 자동 전파는 의식적으로)"
            >
              <input
                type="checkbox"
                checked={includeDescendants}
                onChange={() => setIncludeDescendants((v) => !v)}
                className="h-3.5 w-3.5"
              />
              하위 부서까지 포함
            </label>
          </div>
        )}

        <div className="flex items-end gap-2">
          <label className="flex-1 text-xs text-muted-foreground">
            메모 (선택)
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="예: 2026 H2 파일럿"
              className="mt-1 h-8 text-sm"
            />
          </label>
          <Button size="sm" onClick={handleAdd} disabled={!canSubmit}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            {submitting ? '추가 중…' : '권한 부여'}
          </Button>
        </div>
      </div>

      {/* 목록 */}
      <div className="min-h-0 flex-1 overflow-y-auto rounded-md border">
        {items === null ? (
          <p className="p-4 text-center text-xs text-muted-foreground">
            불러오는 중…
          </p>
        ) : items.length === 0 ? (
          <p className="p-4 text-center text-xs text-muted-foreground">
            부여된 권한이 없습니다 — 아무도(관리자 외) AI 기능을 쓸 수 없습니다.
          </p>
        ) : (
          <ul className="divide-y">
            {items.map((row) => (
              <li
                key={row.id}
                className="flex items-center gap-2 px-3 py-2 text-sm"
              >
                <Badge variant="outline" className="shrink-0">
                  {FEATURE_LABEL[row.feature] ?? row.feature}
                </Badge>
                <span className="inline-flex shrink-0 items-center gap-1 text-muted-foreground">
                  {row.subject_kind === 'user' ? (
                    <UserIcon className="h-3 w-3" />
                  ) : (
                    <Building2 className="h-3 w-3" />
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {row.subject_label}
                  {row.subject_kind === 'workspace' &&
                    row.include_descendants && (
                      <span className="ml-1 text-[11px] text-muted-foreground">
                        (하위 포함)
                      </span>
                    )}
                  {row.note && (
                    <span className="ml-2 text-[11px] text-muted-foreground">
                      · {row.note}
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => handleDelete(row)}
                  className="shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  title="권한 해제"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
