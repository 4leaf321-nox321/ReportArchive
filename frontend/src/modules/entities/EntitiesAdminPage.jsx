import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ChevronUp,
  ChevronDown,
  ExternalLink,
  FileText,
  Link2Off,
  Lock,
  LockOpen,
  Network,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Share2,
  Tags,
  Trash2,
  Combine,
  GitMerge,
  Upload,
  ClipboardPaste,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { Badge } from '@/shared/components/ui/badge'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { Textarea } from '@/shared/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/shared/components/ui/dialog'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/shared/components/ui/popover'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/components/ui/tabs'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { DataTable } from '@/shared/components/DataTable'
import { EntityGraphDialog } from './EntityGraphDialog'
import { EntityImportDialog } from './EntityImportDialog'
import { EntityPasteDialog } from './EntityPasteDialog'
import { MergeCandidatesDialog } from './MergeCandidatesDialog'
import { PropertyDefsDialog } from './PropertyDefsDialog'
import {
  EntityPropertiesFields,
  PropertiesSummary,
  missingRequiredProps,
} from './EntityPropertiesFields'
import { cn } from '@/shared/lib/utils'
import { PageHeader } from '@/shared/components/PageHeader'
import { ErrorState } from '@/shared/components/ErrorState'
import { useAsync } from '@/shared/hooks/useAsync'
import { searchReports } from '@/modules/reports/api'
import { listWorkspaces } from '@/shared/api/workspaces'
import { WorkspaceCombobox } from '@/shared/components/WorkspaceCombobox'
import { Combobox } from '@/shared/components/Combobox'
import { searchUsers } from '@/shared/api/members'
import {
  addEntityAlias,
  addEntityRelation,
  addObjectLink,
  listObjectLinks,
  deleteObjectLink,
  createEntity,
  createEntityType,
  deleteEntity,
  deleteEntityAlias,
  deleteEntityRelation,
  deleteEntityType,
  getEntityYears,
  listEntities,
  listEntityAliases,
  listEntityRelations,
  listEntityTypes,
  listEntityUsage,
  listRelationTypes,
  listTypeProperties,
  createTypeProperty,
  updateTypeProperty,
  deleteTypeProperty,
  createRelationType,
  updateRelationType,
  deleteRelationType,
  listRelationTypeProperties,
  createRelationTypeProperty,
  updateRelationTypeProperty,
  deleteRelationTypeProperty,
  updateEntityRelation,
  mergeEntity,
  setEntityYears,
  unlinkEntityFromAllReports,
  unlinkEntityFromReport,
  updateEntity,
  updateEntityType,
} from '@/shared/api/entities'

// 시간 차원 정책 (p56) 짧은 라벨 — 축 거버넌스 바에 현재 설정을 한 단어로 표시.
const TEMPORAL_KIND_LABEL = {
  evergreen: '연도 무관',
  lifecycle: '유효구간',
  yearly: '연도별 배정',
  derived: '자동 추론',
}

// PropertyDefsDialog 의 owner 설정 — 폴리모픽 property_defs(A0)를 축/관계종류
// 어느 쪽으로도 관리하게 API 를 주입한다.
function entityTypeOwner(type) {
  return {
    depKey: `type:${type.id}`,
    label: type.label,
    description:
      '이 축(객체 종류)의 속성 스키마를 정합니다. 여기서 정의한 속성으로 각 값(객체)의 속성이 검증됩니다. (예: 부품 → 재질·중량)',
    list: () => listTypeProperties(type.id),
    create: (payload) => createTypeProperty(type.id, payload),
    update: (defId, payload) => updateTypeProperty(type.id, defId, payload),
    remove: (defId) => deleteTypeProperty(type.id, defId),
  }
}
function relationTypeOwner(rt) {
  return {
    depKey: `rel:${rt.slug}`,
    label: `${rt.label} (링크)`,
    description:
      '이 관계 종류(링크)가 나르는 속성 스키마를 정합니다. 여기서 정의한 속성으로 각 링크의 속성이 검증됩니다. (예: 시험됨 → 시험일자·결과)',
    list: () => listRelationTypeProperties(rt.slug),
    create: (payload) => createRelationTypeProperty(rt.slug, payload),
    update: (defId, payload) => updateRelationTypeProperty(rt.slug, defId, payload),
    remove: (defId) => deleteRelationTypeProperty(rt.slug, defId),
  }
}

/**
 * /admin/entities — admin-only management for the N-axis controlled
 * vocabulary. One sub-tab per axis (7 today, seeded by the backend
 * migration). Within an axis: search + 비활성 toggle + 추가 / 편집 /
 * 비활성·복원 / 머지 / 삭제.
 *
 * Backend gates the destructive actions on admin role, so a non-admin
 * who lands here via direct URL sees the data but their writes 403.
 * The sidebar entry itself is admin-only — this page is best-effort
 * accessible.
 */
export default function EntitiesAdminPage() {
  const {
    data: typesResp,
    loading: typesLoading,
    error: typesError,
    reload: reloadTypes,
  } = useAsync(() => listEntityTypes(), [])
  const types = typesResp?.items ?? []
  // system 축(부서 등, A0.3)은 값을 담지 않는 투영 표식 — 값 관리 탭에서 숨긴다
  // (관계 다이얼로그가 내부적으로만 참조). slug 충돌 검사엔 전체 types 를 쓴다.
  const shownTypes = types.filter((t) => t.kind_class !== 'system')
  const [axisSlug, setAxisSlug] = useState(null)
  const [newAxisOpen, setNewAxisOpen] = useState(false)
  const [relTypesOpen, setRelTypesOpen] = useState(false)

  // Pick the first axis once the list arrives. Falls through cleanly on
  // re-mount because we treat null as "no axis chosen yet".
  useEffect(() => {
    if (axisSlug == null && shownTypes.length > 0) {
      setAxisSlug(shownTypes[0].slug)
    }
  }, [shownTypes, axisSlug])

  const [reordering, setReordering] = useState(false)
  // 축 순서 바꾸기 — 이웃과 sort_order 를 맞바꾼다(두 번의 PATCH). 동률이면
  // 인접값 기준으로 재배치해 확실히 갈라준다.
  async function moveAxis(idx, dir) {
    const a = shownTypes[idx]
    const b = shownTypes[idx + dir]
    if (!a || !b || reordering) return
    const aOrder = a.sort_order ?? idx
    const bOrder = b.sort_order ?? idx + dir
    setReordering(true)
    try {
      await Promise.all([
        updateEntityType(a.id, { sortOrder: bOrder === aOrder ? bOrder + dir : bOrder }),
        updateEntityType(b.id, { sortOrder: aOrder }),
      ])
      await reloadTypes()
    } catch (err) {
      toast.error(err?.response?.data?.message || err?.message || '순서 변경 실패')
    } finally {
      setReordering(false)
    }
  }

  if (typesLoading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-96" />
      </div>
    )
  }
  if (typesError) {
    return (
      <div className="p-6">
        <ErrorState
          title="축 목록을 불러올 수 없습니다"
          description={typesError.message}
        />
      </div>
    )
  }

  return (
    <div className="p-6 space-y-4">
      <PageHeader
        title="엔티티 관리"
        description="보고서를 태깅하는 N축 통제어휘. 사용자가 picker 에서 추가한 값을 정리/머지/비활성화 합니다."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRelTypesOpen(true)}
            >
              <Network className="mr-1 h-3.5 w-3.5" />
              관계 종류 관리
            </Button>
            <Button size="sm" onClick={() => setNewAxisOpen(true)}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              새 축 추가
            </Button>
          </div>
        }
      />

      {/* 좌측 세로 리스트 + 우측 활성 축 패널. 가로 strip 으로 보이던
          이전 레이아웃은 축이 많아지면 줄바꿈이 어지러워 사용 어려웠음.
          왼쪽 컬럼은 max-h + overflow-y-auto 로 자체 스크롤, 오른쪽은
          페이지 흐름에 따라 자연스럽게 늘어남. */}
      <Tabs
        orientation="vertical"
        value={axisSlug ?? ''}
        onValueChange={setAxisSlug}
        className="flex gap-4 items-start"
      >
        <TabsList className="flex flex-col items-stretch h-auto w-48 shrink-0 max-h-[calc(100vh-180px)] overflow-y-auto">
          {shownTypes.map((t, i) => (
            <div key={t.slug} className="flex items-center gap-0.5">
              <TabsTrigger
                value={t.slug}
                className="flex-1 justify-start text-xs whitespace-normal text-left"
              >
                {t.label}
              </TabsTrigger>
              <div className="flex shrink-0 flex-col">
                <button
                  type="button"
                  disabled={i === 0 || reordering}
                  onClick={() => moveAxis(i, -1)}
                  title="위로"
                  className="rounded p-0.5 text-muted-foreground hover:bg-accent disabled:opacity-30"
                >
                  <ChevronUp className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  disabled={i === shownTypes.length - 1 || reordering}
                  onClick={() => moveAxis(i, 1)}
                  title="아래로"
                  className="rounded p-0.5 text-muted-foreground hover:bg-accent disabled:opacity-30"
                >
                  <ChevronDown className="h-3 w-3" />
                </button>
              </div>
            </div>
          ))}
        </TabsList>
        <div className="flex-1 min-w-0">
          {shownTypes.map((t) => (
            <TabsContent key={t.slug} value={t.slug} className="mt-0">
              {/* Mount fresh per axis (key on slug) so search/toggle/state
                  resets when the admin switches tabs — keeps the mental
                  model "each tab is its own grid". */}
              {axisSlug === t.slug && (
                <AxisPanel
                  key={t.slug}
                  type={t}
                  allTypes={types}
                  onAxisUpdated={reloadTypes}
                  onAxisDeleted={() => {
                    // 다른 축으로 자동 전환 — 삭제 직후 사라진 탭에
                    // 머무를 수 없으므로 첫 번째로 이동(없으면 null).
                    // reloadTypes 가 끝나면 자연스럽게 첫 축이 재진입.
                    const remaining = shownTypes.filter((x) => x.id !== t.id)
                    setAxisSlug(remaining[0]?.slug ?? null)
                    reloadTypes()
                  }}
                />
              )}
            </TabsContent>
          ))}
        </div>
      </Tabs>

      {newAxisOpen && (
        <NewAxisDialog
          existingSlugs={types.map((t) => t.slug)}
          onClose={() => setNewAxisOpen(false)}
          onCreated={(created) => {
            setNewAxisOpen(false)
            // 새 축으로 즉시 전환 — 추가한 흐름에서 자연스럽게 그 축에서
            // 값을 등록하기 시작할 것이라 가정.
            setAxisSlug(created.slug)
            reloadTypes()
          }}
        />
      )}

      {relTypesOpen && (
        <RelationTypesDialog
          axes={types}
          onClose={() => setRelTypesOpen(false)}
        />
      )}
    </div>
  )
}

/** 축 자체 삭제 확인 다이얼로그. 값이 0건이어야만 백엔드가 받아주므로
 *  안내 문구로 그 사실을 분명히 한다. 값을 직접 정리하지 않은 채 들어
 *  오면 destructive 버튼이 disable 되고, 사용자는 값 정리 후 재시도. */
function DeleteAxisDialog({ type, valueCount, onClose, onDeleted }) {
  const [submitting, setSubmitting] = useState(false)
  const canDelete = !submitting && valueCount === 0

  async function handleDelete() {
    if (!canDelete) return
    setSubmitting(true)
    try {
      await deleteEntityType(type.id)
      toast.success(`'${type.label}' 축 삭제됨`)
      onDeleted()
    } catch (err) {
      toast.error(err?.response?.data?.message || err.message || '삭제 실패')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            축 삭제 확인
          </DialogTitle>
          <DialogDescription>
            <strong>'{type.label}'</strong> 축({type.slug}) 자체를 삭제합니다.
            이 축에 속한 모든 picker 옵션이 함께 사라지고, 이미 이 축으로
            태깅된 보고서가 있는 경우엔 삭제할 수 없습니다.
          </DialogDescription>
        </DialogHeader>

        {valueCount > 0 ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs space-y-1.5">
            <p className="font-medium text-destructive">
              이 축에는 {valueCount}건의 값이 등록되어 있어 삭제할 수
              없습니다.
            </p>
            <p className="text-muted-foreground">
              값을 하나씩 삭제하거나 다른 축으로 머지해 0건이 된 뒤 다시
              시도하세요. (사용 중인 보고서가 있으면 그 값 자체부터
              머지하거나 비활성화해야 합니다.)
            </p>
          </div>
        ) : (
          <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
            현재 등록된 값이 없습니다. 안전하게 삭제할 수 있습니다.
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            취소
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={handleDelete}
            disabled={!canDelete}
            title={
              valueCount > 0
                ? '이 축에 등록된 값이 있어 삭제할 수 없습니다.'
                : undefined
            }
          >
            {submitting ? '삭제 중...' : '축 삭제'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 새 축(엔티티 타입) 추가 다이얼로그. label/slug 가 필수, 나머지는
 *  선택. slug 는 영어 소문자/숫자/언더스코어/대시만 — picker URL 의
 *  ?type= 파라미터로도 쓰일 수 있는 키이므로 안전한 식별자만 허용. */
function NewAxisDialog({ existingSlugs, onClose, onCreated }) {
  const [label, setLabel] = useState('')
  const [slug, setSlug] = useState('')
  // 사용자가 slug 를 직접 만지지 않은 동안엔 label 에서 자동 파생.
  const [slugTouched, setSlugTouched] = useState(false)
  const [icon, setIcon] = useState('')
  const [multi, setMulti] = useState(true)
  const [description, setDescription] = useState('')
  // 객체 분류 (A0.3). reference=단순 어휘/태그, record=속성 갖는 객체(프로필·속성폼 개방).
  const [kindClass, setKindClass] = useState('reference')
  const [submitting, setSubmitting] = useState(false)

  // label → slug 추정: 영문자만 남기고 lower-case + dash 정리. 한글
  // label 이면 결과가 비어서 사용자가 slug 를 직접 입력하게 됨.
  const autoSlug = useMemo(() => {
    return label
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32)
  }, [label])

  const effectiveSlug = slugTouched ? slug.trim() : autoSlug
  const slugIsValid = /^[a-z0-9_-]+$/.test(effectiveSlug)
  const slugClash =
    !!effectiveSlug && existingSlugs.includes(effectiveSlug)
  const canSubmit =
    !submitting &&
    label.trim().length > 0 &&
    effectiveSlug.length > 0 &&
    slugIsValid &&
    !slugClash

  async function handleSubmit() {
    if (!canSubmit) return
    setSubmitting(true)
    try {
      const created = await createEntityType({
        slug: effectiveSlug,
        label: label.trim(),
        icon: icon.trim(),
        multi,
        description: description.trim(),
        kind_class: kindClass,
      })
      toast.success(`'${created.label}' 축 추가됨`)
      onCreated(created)
    } catch (err) {
      toast.error(err?.response?.data?.message || err.message || '추가 실패')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>새 축 추가</DialogTitle>
          <DialogDescription className="text-xs">
            새 N축을 만들면 보고서 태그 picker 에 해당 축이 노출되어
            사용자가 값을 등록할 수 있게 됩니다. 축은 한 번 만들고 나면
            slug 가 식별자로 굳기 때문에 신중히 정해 주세요 (라벨/설명은
            추후 시드 마이그레이션 또는 별도 편집 기능으로 바꾸어야 함).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs">라벨</Label>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={64}
              autoFocus
              className="mt-1 h-9"
              placeholder="예: 시험 조건"
            />
          </div>
          <div>
            <Label className="text-xs">
              slug
              {!slugTouched && autoSlug && (
                <span className="ml-1 text-[10px] text-muted-foreground">
                  (라벨에서 자동 생성됨)
                </span>
              )}
            </Label>
            <Input
              value={effectiveSlug}
              onChange={(e) => {
                setSlugTouched(true)
                setSlug(e.target.value.toLowerCase())
              }}
              maxLength={32}
              className="mt-1 h-9 font-mono text-sm"
              placeholder="예: test_condition"
            />
            {effectiveSlug && !slugIsValid && (
              <p className="mt-1 text-[11px] text-destructive">
                소문자·숫자·언더스코어(_)·대시(-) 만 사용할 수 있습니다.
              </p>
            )}
            {slugClash && (
              <p className="mt-1 text-[11px] text-destructive">
                이미 같은 slug 의 축이 있습니다.
              </p>
            )}
          </div>
          <div className="flex items-center gap-4">
            <label className="inline-flex items-center gap-1.5 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={multi}
                onChange={(e) => setMulti(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              <span>다중 선택 허용</span>
            </label>
            <span className="text-[11px] text-muted-foreground">
              {multi
                ? '한 보고서에 여러 값을 태깅할 수 있음'
                : 'picker 가 단일 선택으로 동작 (DB 강제 아님)'}
            </span>
          </div>
          <div>
            <Label className="text-xs">
              아이콘 (선택, Lucide 이름)
            </Label>
            <Input
              value={icon}
              onChange={(e) => setIcon(e.target.value)}
              maxLength={32}
              className="mt-1 h-9"
              placeholder="예: Tags, FlaskConical"
            />
          </div>
          <div>
            <Label className="text-xs">설명 (선택)</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
              rows={3}
              className="mt-1"
              placeholder="이 축이 무엇을 분류하는지 — picker 에 hover 도움말로도 노출됨"
            />
          </div>
          <div>
            <Label className="text-xs">객체 분류 (A0.3)</Label>
            <select
              value={kindClass}
              onChange={(e) => setKindClass(e.target.value)}
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="reference">어휘(reference) — 단순 태그·선택지</option>
              <option value="record">레코드(record) — 속성 갖는 객체(과제·공급사 등)</option>
            </select>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {kindClass === 'record'
                ? '값마다 속성을 정의하고 객체 프로필로 볼 수 있습니다. 「속성 정의」에서 스키마를 정하세요.'
                : '보고서에 붙이는 이름표 수준의 통제어휘입니다.'}
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            취소
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={!canSubmit}>
            {submitting ? '추가 중...' : '추가'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The grid + dialogs for one axis. Owns its own reload counter so
 * mutations (create/update/merge/delete) reload only the current axis,
 * not the whole page.
 */
function AxisPanel({ type, allTypes, onAxisDeleted, onAxisUpdated }) {
  const [reloadKey, setReloadKey] = useState(0)
  const [query, setQuery] = useState('')
  const [includeDeprecated, setIncludeDeprecated] = useState(true)
  const [deleteAxisOpen, setDeleteAxisOpen] = useState(false)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [govOpen, setGovOpen] = useState(false)
  const [propsDefOpen, setPropsDefOpen] = useState(false)
  const [aliasTarget, setAliasTarget] = useState(null)
  const [relTarget, setRelTarget] = useState(null)
  const [graphTarget, setGraphTarget] = useState(null)

  const { data, loading, error } = useAsync(
    () =>
      listEntities({
        typeId: type.id,
        includeDeprecated,
        withUsage: true,
        limit: 500,
      }),
    [type.id, includeDeprecated, reloadKey],
  )
  const rows = data?.items ?? []
  // 축의 속성 스키마(A0.1). record 축이면 목록 요약칩·편집 폼이 이걸로 렌더
  // 된다. reference 축(정의 0개)이면 빈 배열 → 관련 UI 전부 비표시(additive).
  // reloadKey 를 deps 에 넣어 속성 정의 편집 후에도 갱신.
  const { data: propDefsData } = useAsync(
    () => listTypeProperties(type.id),
    [type.id, reloadKey],
  )
  const propertyDefs = propDefsData?.items ?? []
  // Client-side search across value/code/description — DataTable has its
  // own search box but we surface one in the toolbar above so it lives
  // alongside the "비활성 포함" toggle.
  const filteredRows = useMemo(() => {
    const n = query.trim().toLowerCase()
    if (!n) return rows
    return rows.filter(
      (r) =>
        r.value.toLowerCase().includes(n) ||
        (r.code ?? '').toLowerCase().includes(n) ||
        (r.description ?? '').toLowerCase().includes(n),
    )
  }, [rows, query])

  const [createOpen, setCreateOpen] = useState(false)
  const [editTarget, setEditTarget] = useState(null)
  const [mergeTarget, setMergeTarget] = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [mergeScanOpen, setMergeScanOpen] = useState(false)

  function reload() {
    setReloadKey((n) => n + 1)
  }

  const columns = useMemo(
    () => [
      {
        key: 'value',
        header: '값',
        sortable: true,
        render: (r) => (
          <span
            className={
              r.status === 'deprecated'
                ? 'text-muted-foreground line-through'
                : 'font-medium'
            }
            title={r.description}
          >
            {r.value}
          </span>
        ),
      },
      {
        key: 'code',
        header: '코드',
        sortable: true,
        headerClassName: 'w-[120px]',
        render: (r) => (
          <span className="text-xs text-muted-foreground tabular-nums">
            {r.code ?? '—'}
          </span>
        ),
      },
      {
        key: 'status',
        header: '상태',
        sortable: true,
        headerClassName: 'w-[90px]',
        render: (r) =>
          r.status === 'active' ? (
            <Badge variant="secondary" className="text-[10px]">활성</Badge>
          ) : (
            <Badge variant="outline" className="text-[10px] text-muted-foreground">
              비활성
            </Badge>
          ),
      },
      {
        key: 'usage_count',
        header: '사용',
        sortable: true,
        headerClassName: 'w-[80px] text-right',
        cellClassName: 'text-right',
        render: (r) => <UsageCell entity={r} onReload={reload} />,
      },
      {
        key: 'created_at',
        header: '등록일',
        sortable: true,
        headerClassName: 'w-[110px]',
        render: (r) => (
          <span className="text-xs text-muted-foreground whitespace-nowrap font-mono">
            {formatDate(r.created_at)}
          </span>
        ),
      },
      // 속성 요약 (A0.1) — 정의된 속성이 있는 record 축에서만 노출.
      ...(propertyDefs.length > 0
        ? [
            {
              key: '_properties',
              header: '속성',
              render: (r) => (
                <PropertiesSummary defs={propertyDefs} properties={r.properties} />
              ),
            },
          ]
        : []),
      {
        key: '_actions',
        header: '',
        headerClassName: 'w-[220px]',
        render: (r) => (
          <div className="flex items-center justify-end gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              title="편집"
              onClick={(e) => {
                e.stopPropagation()
                setEditTarget(r)
              }}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              title={r.status === 'active' ? '비활성화' : '복원'}
              onClick={async (e) => {
                e.stopPropagation()
                try {
                  await updateEntity(r.id, {
                    status: r.status === 'active' ? 'deprecated' : 'active',
                  })
                  toast.success(
                    r.status === 'active'
                      ? `'${r.value}' 비활성화됨`
                      : `'${r.value}' 복원됨`,
                  )
                  reload()
                } catch (err) {
                  toast.error(err.message || '상태 변경 실패')
                }
              }}
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              title="별칭(다른 표기) 관리 — 등록한 표기는 입력 시 이 값으로 자동 흡수"
              onClick={(e) => {
                e.stopPropagation()
                setAliasTarget(r)
              }}
            >
              <Tags className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              title="관계/계층 관리 — 상위(part_of) 연결. 캐스케이드 picker·롤업에 사용"
              onClick={(e) => {
                e.stopPropagation()
                setRelTarget(r)
              }}
            >
              <Network className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              title="관계도 보기 — 이 값 주변 그래프"
              onClick={(e) => {
                e.stopPropagation()
                setGraphTarget(r)
              }}
            >
              <Share2 className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              title="다른 값으로 머지"
              onClick={(e) => {
                e.stopPropagation()
                setMergeTarget(r)
              }}
            >
              <Combine className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 text-destructive hover:text-destructive"
              title="삭제 (사용 중이면 차단)"
              onClick={(e) => {
                e.stopPropagation()
                setDeleteTarget(r)
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ),
      },
    ],
    [propertyDefs],
  )

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`${type.label} 검색 (값·코드·설명)`}
            className="h-8 pl-7 w-72 text-sm"
          />
        </div>
        <label className="inline-flex items-center gap-1.5 cursor-pointer select-none text-xs">
          <input
            type="checkbox"
            checked={includeDeprecated}
            onChange={(e) => setIncludeDeprecated(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          <span>비활성 포함</span>
        </label>
        <div className="ml-auto flex items-center gap-2">
          {/* 중복/동의어 후보를 AI 보조로 찾아 머지(엔티티머지보조_설계.md). */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setMergeScanOpen(true)}
            title="이 축에서 같은 대상을 가리키는 중복 값을 찾아 합칩니다"
          >
            <GitMerge className="mr-1 h-3.5 w-3.5" />
            중복 스캔
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            추가
          </Button>
          {/* 이 축에 여러 건을 한꺼번에 — 붙여넣기(표) / 파일(엑셀·CSV). 종류는
              현재 축으로 고정된다. */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPasteOpen(true)}
            title="엑셀에서 복사한 여러 행을 표에 붙여넣어 한꺼번에 등록"
          >
            <ClipboardPaste className="mr-1 h-3.5 w-3.5" />
            표로 입력
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setImportOpen(true)}
            title="엑셀·CSV 파일로 가져오기"
          >
            <Upload className="mr-1 h-3.5 w-3.5" />
            가져오기
          </Button>
          {/* 이 축 자체를 통째로 삭제. 값이 남아 있으면 백엔드가 400으로
              막고, 다이얼로그가 그 안내를 그대로 보여준다. */}
          <Button
            variant="outline"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={() => setDeleteAxisOpen(true)}
            title="이 축(엔티티 타입) 자체를 삭제합니다"
          >
            <Trash2 className="mr-1 h-3.5 w-3.5" />
            축 삭제
          </Button>
        </div>
      </div>

      {/* 입력 거버넌스 바 — 이 축의 정책/패턴을 한눈에 + 편집 진입. */}
      <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-1.5 text-xs">
        {type.entry_policy === 'closed' ? (
          <span className="inline-flex items-center gap-1 text-amber-600">
            <Lock className="h-3.5 w-3.5" /> 폐쇄형 — 관리자만 값 추가
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <LockOpen className="h-3.5 w-3.5" /> 개방형 — 누구나 값 추가
          </span>
        )}
        <span className="text-muted-foreground/50">·</span>
        <span className="text-muted-foreground">
          형식:{' '}
          {type.value_pattern ? (
            <code className="rounded bg-muted px-1 font-mono text-[11px]">
              {type.value_pattern}
            </code>
          ) : (
            '제한 없음'
          )}
        </span>
        <span className="text-muted-foreground/50">·</span>
        <span className="text-muted-foreground">
          연도: {TEMPORAL_KIND_LABEL[type.temporal_kind] ?? '연도 무관'}
        </span>
        {type.kind_class && type.kind_class !== 'reference' && (
          <>
            <span className="text-muted-foreground/50">·</span>
            <Badge variant="secondary" className="text-[10px]">
              {type.kind_class === 'record' ? '레코드 객체' : '시스템'}
            </Badge>
          </>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-6 px-2 text-xs"
          onClick={() => setPropsDefOpen(true)}
        >
          속성 정의
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={() => setGovOpen(true)}
        >
          축 편집
        </Button>
      </div>

      {error ? (
        <ErrorState description={error.message} onRetry={reload} />
      ) : loading ? (
        <Skeleton className="h-72" />
      ) : (
        <DataTable
          columns={columns}
          data={filteredRows}
          fixedLayout
          defaultSort={{ key: 'value', dir: 'asc' }}
          pageSizeStorageKey={`entities-${type.slug}`}
          searchableKeys={['value', 'code', 'description']}
          searchPlaceholder=""
        />
      )}

      {govOpen && (
        <AxisGovernanceDialog
          type={type}
          onClose={() => setGovOpen(false)}
          onSaved={() => {
            setGovOpen(false)
            onAxisUpdated?.()
          }}
        />
      )}
      {propsDefOpen && (
        <PropertyDefsDialog
          owner={entityTypeOwner(type)}
          onClose={() => setPropsDefOpen(false)}
          onChanged={reload}
        />
      )}
      {aliasTarget && (
        <AliasDialog
          type={type}
          entity={aliasTarget}
          onClose={() => setAliasTarget(null)}
        />
      )}
      {relTarget && (
        <RelationsDialog
          type={type}
          entity={relTarget}
          onClose={() => setRelTarget(null)}
        />
      )}
      {graphTarget && (
        <EntityGraphDialog
          entityId={graphTarget.id}
          label={graphTarget.value}
          onClose={() => setGraphTarget(null)}
        />
      )}
      {createOpen && (
        <EditDialog
          mode="create"
          type={type}
          defs={propertyDefs}
          onClose={() => setCreateOpen(false)}
          onSaved={() => {
            setCreateOpen(false)
            reload()
          }}
        />
      )}
      {editTarget && (
        <EditDialog
          mode="edit"
          type={type}
          defs={propertyDefs}
          target={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={() => {
            setEditTarget(null)
            reload()
          }}
        />
      )}
      {mergeTarget && (
        <MergeDialog
          type={type}
          source={mergeTarget}
          allRows={rows}
          onClose={() => setMergeTarget(null)}
          onMerged={() => {
            setMergeTarget(null)
            reload()
          }}
        />
      )}
      {mergeScanOpen && (
        <MergeCandidatesDialog
          type={type}
          onClose={() => setMergeScanOpen(false)}
          onChanged={reload}
        />
      )}
      <EntityPasteDialog
        open={pasteOpen}
        onOpenChange={setPasteOpen}
        types={allTypes}
        fixedType={type}
        onImported={reload}
      />
      <EntityImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        types={allTypes}
        fixedType={type}
        onImported={reload}
      />
      {deleteTarget && (
        <DeleteConfirmDialog
          target={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => {
            setDeleteTarget(null)
            reload()
          }}
          onSwitchToMerge={() => {
            // Hand off to the merge dialog without losing context — the
            // common reason a delete is blocked is duplicate-cleanup, and
            // merge is the right next action.
            setMergeTarget(deleteTarget)
            setDeleteTarget(null)
          }}
        />
      )}
      {deleteAxisOpen && (
        <DeleteAxisDialog
          type={type}
          valueCount={rows.length}
          onClose={() => setDeleteAxisOpen(false)}
          onDeleted={() => {
            setDeleteAxisOpen(false)
            onAxisDeleted?.()
          }}
        />
      )}
    </div>
  )
}

/**
 * Usage-count cell. Renders "N건" — and when N > 0, clicking opens a
 * popover with the actual reports (id + title + workspace + updated)
 * so the admin can jump straight to any of them in a new tab. Reduces
 * the "왜 못 지우지?" guessing cost from O(grep the whole list) to a
 * single click.
 *
 * Each row also has a × that unlinks the entity from that one report
 * in place. After unlink we refetch the popover list AND call onReload
 * on the parent so the row's usage count + delete-button state stays
 * in sync.
 */
function UsageCell({ entity, onReload }) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState(null)
  const [error, setError] = useState(null)
  const count = entity.usage_count ?? 0

  function refetch() {
    setItems(null)
    setError(null)
    listEntityUsage(entity.id)
      .then((res) => setItems(res?.items ?? []))
      .catch((e) => setError(e))
  }

  useEffect(() => {
    if (!open || items !== null) return
    let cancelled = false
    listEntityUsage(entity.id)
      .then((res) => {
        if (!cancelled) setItems(res?.items ?? [])
      })
      .catch((e) => {
        if (cancelled) return
        setError(e)
      })
    return () => {
      cancelled = true
    }
  }, [open, items, entity.id])

  async function handleUnlink(reportId) {
    try {
      await unlinkEntityFromReport(entity.id, reportId)
      toast.success(`보고서 ${reportId} 에서 '${entity.value}' 태그 해제됨`)
      refetch()
      onReload?.()
    } catch (err) {
      toast.error(err.message || '태그 해제 실패')
    }
  }

  if (count <= 0) {
    return <span className="text-xs text-muted-foreground tabular-nums">0건</span>
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className="text-xs tabular-nums underline-offset-2 hover:underline"
          title="이 값을 사용 중인 보고서 보기"
        >
          {count}건
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 p-2"
        onClick={(e) => e.stopPropagation()}
      >
        <UsageList items={items} error={error} onUnlink={handleUnlink} />
      </PopoverContent>
    </Popover>
  )
}

/**
 * Shared list rendering used by the cell popover, the delete-confirm
 * dialog, and the merge preview. Each item links out to the report in
 * a new tab (target=_blank) so the admin doesn't lose their place. When
 * `onUnlink(reportId)` is provided, each row also gets a small × button
 * so the admin can untag a single report inline — useful for surgical
 * fixes ("this one report has the wrong tag").
 */
function UsageList({
  items,
  error,
  emptyLabel = '사용 중인 보고서가 없습니다.',
  onUnlink,
}) {
  if (error) {
    return (
      <p className="text-xs text-destructive">
        목록을 불러올 수 없습니다.
      </p>
    )
  }
  if (items === null) {
    return (
      <p className="text-xs text-muted-foreground">불러오는 중...</p>
    )
  }
  if (items.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">{emptyLabel}</p>
    )
  }
  return (
    <ul className="max-h-72 overflow-y-auto divide-y">
      {items.map((r) => (
        <li key={r.id} className="flex items-stretch">
          <a
            href={`/w/${r.workspace_slug}/reports/${r.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex flex-1 items-start justify-between gap-2 px-2 py-1.5 text-sm hover:bg-accent min-w-0"
            title={`${r.workspace_slug} · 수정 ${formatDate(r.updated_at)}`}
          >
            <span className="flex-1 truncate">{r.title}</span>
            <span className="shrink-0 text-[10px] text-muted-foreground inline-flex items-center gap-0.5">
              {r.workspace_slug}
              <ExternalLink className="h-3 w-3" />
            </span>
          </a>
          {onUnlink && (
            <button
              type="button"
              onClick={() => onUnlink(r.id)}
              className="px-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              title="이 보고서에서 태그 해제"
            >
              <Link2Off className="h-3.5 w-3.5" />
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}

/**
 * 입력 거버넌스 편집 — 축의 entry_policy(open/closed)와 value_pattern(정규식)을
 * 바꾼다. 저장 시 백엔드가 정규식 유효성을 재검증한다(여기선 빠른 사전 안내만).
 */
function AxisGovernanceDialog({ type, onClose, onSaved }) {
  // 기본 정보 (라벨=탭 이름, 아이콘, 설명). slug 는 식별자라 편집 불가.
  const [label, setLabel] = useState(type.label ?? '')
  const [icon, setIcon] = useState(type.icon ?? '')
  const [description, setDescription] = useState(type.description ?? '')
  const [policy, setPolicy] = useState(type.entry_policy ?? 'open')
  const [pattern, setPattern] = useState(type.value_pattern ?? '')
  const [temporalKind, setTemporalKind] = useState(
    type.temporal_kind ?? 'evergreen',
  )
  const [kindClass, setKindClass] = useState(type.kind_class ?? 'reference')
  const [test, setTest] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const trimmedPattern = pattern.trim()
  // 클라이언트 정규식 유효성 — 잘못되면 저장 비활성화하고 안내.
  const patternError = useMemo(() => {
    if (!trimmedPattern) return null
    try {
      new RegExp(trimmedPattern)
      return null
    } catch (e) {
      return String(e?.message ?? e)
    }
  }, [trimmedPattern])
  // 테스트 입력이 패턴에 맞는지(fullmatch) 즉석 확인.
  const testResult = useMemo(() => {
    if (!trimmedPattern || !test) return null
    try {
      const m = test.match(new RegExp(trimmedPattern))
      return !!m && m[0] === test
    } catch {
      return null
    }
  }, [trimmedPattern, test])

  const trimmedLabel = label.trim()
  const canSave = !patternError && trimmedLabel.length > 0 && !submitting

  async function handleSave() {
    if (!canSave) return
    setSubmitting(true)
    try {
      await updateEntityType(type.id, {
        label: trimmedLabel,
        icon: icon.trim(),
        description: description.trim(),
        entryPolicy: policy,
        valuePattern: trimmedPattern, // 빈 문자열이면 백엔드가 제약 해제
        temporalKind,
        kindClass,
      })
      toast.success(`'${trimmedLabel}' 축 저장됨`)
      onSaved?.()
    } catch (err) {
      toast.error(
        err?.response?.data?.message || err?.message || '저장 실패',
      )
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            축 편집 —{' '}
            <code className="rounded bg-muted px-1 font-mono text-sm">
              {type.slug}
            </code>
          </DialogTitle>
          <DialogDescription>
            이 축의 이름·아이콘·설명과 입력 조건을 수정합니다. slug 는 식별자라
            바꿀 수 없고, 기존 값·태그에는 영향이 없습니다.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* 기본 정보 — 라벨(탭 이름)·아이콘·설명 */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">라벨 (탭 이름)</Label>
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={64}
                className="h-8"
                placeholder="예: 모델"
              />
              {trimmedLabel.length === 0 && (
                <p className="text-[11px] text-destructive">라벨은 비울 수 없습니다.</p>
              )}
            </div>
            <div className="space-y-1">
              <Label className="text-xs">아이콘 (선택, Lucide 이름)</Label>
              <Input
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
                maxLength={32}
                className="h-8"
                placeholder="예: Tags"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">설명 (선택)</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
              rows={2}
              placeholder="이 축이 무엇을 분류하는지"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">입력 정책</Label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setPolicy('open')}
                className={cn(
                  'rounded-md border px-3 py-2 text-left text-xs',
                  policy === 'open'
                    ? 'border-primary bg-primary/5'
                    : 'hover:bg-muted',
                )}
              >
                <span className="flex items-center gap-1 font-medium">
                  <LockOpen className="h-3.5 w-3.5" /> 개방형
                </span>
                <span className="mt-0.5 block text-muted-foreground">
                  누구나 picker 에서 새 값 추가
                </span>
              </button>
              <button
                type="button"
                onClick={() => setPolicy('closed')}
                className={cn(
                  'rounded-md border px-3 py-2 text-left text-xs',
                  policy === 'closed'
                    ? 'border-primary bg-primary/5'
                    : 'hover:bg-muted',
                )}
              >
                <span className="flex items-center gap-1 font-medium">
                  <Lock className="h-3.5 w-3.5" /> 폐쇄형
                </span>
                <span className="mt-0.5 block text-muted-foreground">
                  관리자가 등록한 값만 선택
                </span>
              </button>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="value-pattern">
              값 형식 (정규식, 선택)
            </Label>
            <Input
              id="value-pattern"
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              placeholder="예: ^[0-9]{8}$ (BOM 8자리). 비우면 제한 없음"
              className="h-8 font-mono text-sm"
            />
            {patternError ? (
              <p className="text-[11px] text-destructive">
                정규식 오류: {patternError}
              </p>
            ) : trimmedPattern ? (
              <div className="flex items-center gap-2">
                <Input
                  value={test}
                  onChange={(e) => setTest(e.target.value)}
                  placeholder="형식 테스트 입력…"
                  className="h-7 text-xs"
                />
                {test && (
                  <span
                    className={cn(
                      'shrink-0 text-[11px]',
                      testResult ? 'text-emerald-600' : 'text-amber-600',
                    )}
                  >
                    {testResult ? '통과' : '불일치'}
                  </span>
                )}
              </div>
            ) : null}
          </div>

          {/* 시간 차원 정책 (p56) — 연도 필터가 이 축에 어떻게 적용될지. */}
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="temporal-kind">
              시간 차원 (연도 적용 방식)
            </Label>
            <select
              id="temporal-kind"
              value={temporalKind}
              onChange={(e) => setTemporalKind(e.target.value)}
              className="h-8 w-full rounded-md border bg-background px-2 text-sm"
            >
              <option value="evergreen">연도 무관 (항상 노출)</option>
              <option value="lifecycle">유효구간 (도입~폐지 연도)</option>
              <option value="yearly">연도별 배정 (값마다 연도 세트)</option>
              <option value="derived">자동 추론 (쓰인 보고서 연도)</option>
            </select>
            <p className="text-[11px] text-muted-foreground">
              {temporalKind === 'evergreen' &&
                '연도 필터를 무시하고 항상 보입니다(시험 종류·단계 등).'}
              {temporalKind === 'lifecycle' &&
                '값마다 유효 시작/종료 연도를 두고, 그 구간에 드는 해에만 노출(부품·BOM).'}
              {temporalKind === 'yearly' &&
                '값마다 적용 연도를 명시 배정합니다(모델). 새 값은 올해로 시작.'}
              {temporalKind === 'derived' &&
                '별도 입력 없이, 그 값이 쓰인 보고서의 연도로 자동 판정합니다(관리비 0).'}
            </p>
          </div>

          {/* 객체 분류 (A0.3) — record 로 올리면 속성/객체 프로필이 열린다. */}
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="kind-class">
              객체 분류
            </Label>
            <select
              id="kind-class"
              value={kindClass}
              onChange={(e) => setKindClass(e.target.value)}
              className="h-8 w-full rounded-md border bg-background px-2 text-sm"
            >
              <option value="reference">어휘(reference) — 단순 태그·선택지</option>
              <option value="record">레코드(record) — 속성 갖는 객체</option>
              <option value="system">시스템(system) — 원 테이블 투영(고급)</option>
            </select>
            <p className="text-[11px] text-muted-foreground">
              {kindClass === 'reference' &&
                '보고서에 붙이는 이름표 수준의 통제어휘입니다.'}
              {kindClass === 'record' &&
                '값마다 속성을 정의하고 객체 프로필로 봅니다(과제·공급사·시험 등). 「속성 정의」에서 스키마를 정하세요.'}
              {kindClass === 'system' &&
                '보고서·사용자·부서 같은 원 테이블을 투영하는 축(A0.3 스텝2~). 값은 여기서 만들지 않습니다.'}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={submitting}>
            취소
          </Button>
          <Button size="sm" onClick={handleSave} disabled={!canSave}>
            {submitting ? '저장 중…' : '저장'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 별칭(다른 표기) 관리 — 한 엔티티에 여러 표기를 매핑한다. 사용자가 별칭을
 * 입력하면 서버가 이 canonical 값으로 자동 흡수하므로 사후 머지가 줄어든다.
 */
function AliasDialog({ type, entity, onClose }) {
  const [aliases, setAliases] = useState(null) // null=loading
  const [input, setInput] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function reload() {
    try {
      const res = await listEntityAliases(entity.id)
      setAliases(res?.items ?? [])
    } catch (err) {
      toast.error('별칭 불러오기 실패', {
        description: String(err?.message ?? err),
      })
      setAliases([])
    }
  }
  useEffect(() => {
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity.id])

  async function handleAdd() {
    const value = input.trim()
    if (!value) return
    setSubmitting(true)
    try {
      await addEntityAlias(entity.id, value)
      setInput('')
      await reload()
    } catch (err) {
      toast.error(
        err?.response?.data?.message || err?.message || '별칭 추가 실패',
      )
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(aliasId) {
    try {
      await deleteEntityAlias(entity.id, aliasId)
      await reload()
    } catch (err) {
      toast.error(
        err?.response?.data?.message || err?.message || '별칭 삭제 실패',
      )
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Tags className="h-4 w-4" /> 별칭 — {entity.value}
          </DialogTitle>
          <DialogDescription>
            등록한 표기를 사용자가 <strong>{type.label}</strong> picker 에 입력하면
            자동으로 <strong>‘{entity.value}’</strong> 로 흡수됩니다(새 값이 생기지
            않음). 예: <code className="font-mono">A-1234</code>,{' '}
            <code className="font-mono">a 1234</code>.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="다른 표기 입력…"
            className="h-8 text-sm"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                handleAdd()
              }
            }}
          />
          <Button size="sm" onClick={handleAdd} disabled={submitting || !input.trim()}>
            <Plus className="mr-1 h-3.5 w-3.5" /> 추가
          </Button>
        </div>

        <div className="max-h-60 overflow-y-auto rounded-md border">
          {aliases === null ? (
            <p className="px-3 py-3 text-center text-xs text-muted-foreground">
              불러오는 중…
            </p>
          ) : aliases.length === 0 ? (
            <p className="px-3 py-3 text-center text-xs text-muted-foreground">
              등록된 별칭이 없습니다.
            </p>
          ) : (
            aliases.map((a) => (
              <div
                key={a.id}
                className="flex items-center justify-between gap-2 border-b px-3 py-1.5 text-sm last:border-b-0"
              >
                <span className="truncate font-mono text-xs">{a.alias}</span>
                <button
                  type="button"
                  onClick={() => handleDelete(a.id)}
                  className="shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  title="별칭 삭제"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            닫기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 관계/계층 관리 — 이 엔티티의 상위(part_of) 연결을 추가/제거하고, 하위
 * (이 값에 묶인 것들)를 보여준다. 상위를 걸면 작성 picker 가 캐스케이드로
 * 좁혀지고(부모 선택 → 이 값이 후보로), 롤업 대시보드의 토대가 된다.
 */
function RelationsDialog({ type, entity, onClose }) {
  const [rel, setRel] = useState(null) // { parents, children } | null=loading
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  // 관계 종류 레지스트리(p55) + 추가 시 선택한 종류. 기본 part_of.
  const [relTypes, setRelTypes] = useState([])
  const [selectedRel, setSelectedRel] = useState('part_of')
  // A0.2 — 편집 중인 링크(속성/근거) row | null. 관계종류 slug → 링크 속성정의.
  const [editingRel, setEditingRel] = useState(null)
  const [defsBySlug, setDefsBySlug] = useState({})
  // A0.3 스텝2 — system 축(부서 등) + cross-kind 링크(object_links).
  const [sysAxes, setSysAxes] = useState(() => new Set())
  const [orgWorkspaces, setOrgWorkspaces] = useState([])
  const [userOptions, setUserOptions] = useState([]) // led_by 등 user 대상 picker
  const [objectLinks, setObjectLinks] = useState([])

  useEffect(() => {
    listRelationTypes()
      .then((res) => setRelTypes(res?.items ?? []))
      .catch(() => setRelTypes([]))
    listEntityTypes({ includeSystem: true })
      .then((res) =>
        setSysAxes(
          new Set(
            (res?.items ?? [])
              .filter((t) => t.kind_class === 'system')
              .map((t) => t.slug),
          ),
        ),
      )
      .catch(() => {})
    listWorkspaces()
      .then((res) =>
        setOrgWorkspaces(
          (res ?? []).filter((w) => w.kind === 'org' && !w.virtual),
        ),
      )
      .catch(() => setOrgWorkspaces([]))
    // led_by 등 user 대상 관계용 — 사용자 목록(이름·이메일로 검색·구분).
    searchUsers({ limit: 300 })
      .then((res) =>
        setUserOptions(
          (res ?? []).map((u) => ({
            value: String(u.id),
            label: u.email ? `${u.name} (${u.email})` : u.name,
          })),
        ),
      )
      .catch(() => setUserOptions([]))
  }, [])

  async function reloadLinks() {
    try {
      const res = await listObjectLinks(entity.id)
      setObjectLinks(res?.items ?? [])
    } catch {
      setObjectLinks([])
    }
  }
  useEffect(() => {
    reloadLinks()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity.id])

  async function addObjectTarget(dstType, dstId) {
    setSubmitting(true)
    try {
      await addObjectLink(entity.id, { dstType, dstId, relation: selectedRel })
      await reloadLinks()
    } catch (err) {
      toast.error(
        err?.response?.data?.message || err?.message || '링크 추가 실패',
      )
    } finally {
      setSubmitting(false)
    }
  }

  async function removeObjectLink(linkId) {
    try {
      await deleteObjectLink(entity.id, linkId)
      await reloadLinks()
    } catch (err) {
      toast.error(
        err?.response?.data?.message || err?.message || '링크 삭제 실패',
      )
    }
  }

  // slug → 관계 종류 메타(라벨·역라벨·도착축 제약). 표시·검색 좁힘에 쓴다.
  const relTypeBySlug = useMemo(() => {
    const m = new Map()
    for (const rt of relTypes) m.set(rt.slug, rt)
    return m
  }, [relTypes])
  const selectedRelType = relTypeBySlug.get(selectedRel) ?? null
  // 선택한 관계 종류의 도착축이 system(부서 등)이면 그 slug — 대상 picker 가
  // 엔티티 검색 대신 워크스페이스 드롭다운이 되고, 추가는 object_link 로 간다.
  const dstSysType = useMemo(() => {
    const dsts = selectedRelType?.dst_axis_slugs ?? []
    return dsts.find((s) => sysAxes.has(s)) ?? null
  }, [selectedRelType, sysAxes])

  async function reload() {
    try {
      const res = await listEntityRelations(entity.id)
      setRel({ parents: res?.parents ?? [], children: res?.children ?? [] })
    } catch (err) {
      toast.error('관계 불러오기 실패', {
        description: String(err?.message ?? err),
      })
      setRel({ parents: [], children: [] })
    }
  }
  useEffect(() => {
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity.id])

  // 관계에 등장하는 종류별 링크 속성 정의를 지연 로드(요약칩·편집 폼용). 종류당 1회.
  useEffect(() => {
    if (!rel) return undefined
    const slugs = new Set([...rel.parents, ...rel.children].map((r) => r.relation))
    const missing = [...slugs].filter((s) => !(s in defsBySlug))
    if (missing.length === 0) return undefined
    let cancelled = false
    Promise.all(
      missing.map((s) =>
        listRelationTypeProperties(s)
          .then((res) => [s, res?.items ?? []])
          .catch(() => [s, []]),
      ),
    ).then((pairs) => {
      if (cancelled) return
      setDefsBySlug((prev) => {
        const next = { ...prev }
        for (const [s, defs] of pairs) next[s] = defs
        return next
      })
    })
    return () => {
      cancelled = true
    }
  }, [rel, defsBySlug])

  // 상위 후보 검색 — 전체 축에서(부모는 보통 다른 축). 자기 자신·이미 상위인
  // 것은 제외.
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setResults([])
      return
    }
    let cancelled = false
    setSearching(true)
    const t = setTimeout(async () => {
      try {
        const res = await listEntities({ q, limit: 20 })
        if (cancelled) return
        const parentIds = new Set((rel?.parents ?? []).map((p) => p.entity_id))
        // 선택한 관계 종류가 도착 축을 제약하면 그 축의 값만 후보로(서버도 거부하지만
        // 미리 좁혀 UX 향상). 제약 없으면 전체 축.
        const dstAxes = selectedRelType?.dst_axis_slugs ?? null
        setResults(
          (res?.items ?? []).filter(
            (e) =>
              e.id !== entity.id &&
              !parentIds.has(e.id) &&
              (!dstAxes || dstAxes.includes(e.type_slug)),
          ),
        )
      } catch {
        if (!cancelled) setResults([])
      } finally {
        if (!cancelled) setSearching(false)
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [query, entity.id, rel, selectedRel, selectedRelType])

  async function addParent(dst) {
    setSubmitting(true)
    try {
      await addEntityRelation(entity.id, dst.id, selectedRel)
      setQuery('')
      setResults([])
      await reload()
    } catch (err) {
      toast.error(
        err?.response?.data?.message || err?.message || '관계 추가 실패',
      )
    } finally {
      setSubmitting(false)
    }
  }

  async function removeRelation(relationId) {
    try {
      await deleteEntityRelation(entity.id, relationId)
      await reload()
    } catch (err) {
      toast.error(
        err?.response?.data?.message || err?.message || '관계 삭제 실패',
      )
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Network className="h-4 w-4" /> 관계 — {entity.value}
          </DialogTitle>
          <DialogDescription>
            <strong>{type.label}</strong> ‘{entity.value}’ 에서 출발하는 관계를
            연결합니다(이 값 → 대상). 종류에 따라 캐스케이드 picker·롤업·확장
            검색에 쓰입니다.
          </DialogDescription>
        </DialogHeader>

        {editingRel ? (
          <RelationEditor
            entityId={entity.id}
            rel={editingRel}
            defs={defsBySlug[editingRel.relation] ?? []}
            relLabel={
              relTypeBySlug.get(editingRel.relation)?.label ?? editingRel.relation
            }
            onCancel={() => setEditingRel(null)}
            onSaved={async () => {
              setEditingRel(null)
              await reload()
            }}
          />
        ) : (
          <>
        {/* 관계 추가 — 종류 선택 + 대상 검색 */}
        <div className="space-y-1.5">
          <Label className="text-xs">관계 추가</Label>
          <div className="flex items-center gap-1.5">
            <select
              value={selectedRel}
              onChange={(e) => {
                setSelectedRel(e.target.value)
                setResults([])
              }}
              className="h-8 shrink-0 rounded-md border bg-background px-2 text-xs"
              title="관계 종류"
            >
              {relTypes.map((rt) => (
                <option key={rt.slug} value={rt.slug}>
                  {rt.label}
                </option>
              ))}
            </select>
            {dstSysType === 'dept' ? (
              // 도착축이 부서(system) — 부서 선택 콤보박스. 고르면 즉시 링크 생성.
              <div className="flex-1">
                <WorkspaceCombobox
                  excludeArchived
                  workspaces={orgWorkspaces}
                  value=""
                  onChange={(slug) => slug && addObjectTarget('dept', slug)}
                  disabled={submitting || orgWorkspaces.length === 0}
                  placeholder="담당 부서 선택..."
                />
              </div>
            ) : dstSysType === 'user' ? (
              // 도착축이 사용자(system) — led_by(담당 PL) 등. 사용자 검색 콤보박스.
              <div className="flex-1">
                <Combobox
                  options={userOptions}
                  value=""
                  onChange={(uid) => uid && addObjectTarget('user', String(uid))}
                  disabled={submitting || userOptions.length === 0}
                  placeholder="담당자 선택..."
                  searchPlaceholder="이름·이메일 검색..."
                />
              </div>
            ) : dstSysType ? (
              <p className="flex-1 text-xs text-muted-foreground">
                이 관계의 대상({dstSysType})은 아직 이 화면에서 지정할 수 없습니다.
              </p>
            ) : (
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={
                    selectedRelType?.dst_axis_slugs?.length
                      ? `대상 검색 (${selectedRelType.dst_axis_slugs.join('·')})…`
                      : '대상 값 검색 (전체 축)…'
                  }
                  className="h-8 pl-7 text-sm"
                />
              </div>
            )}
          </div>
          {!dstSysType && query.trim() && (
            <div className="max-h-40 overflow-y-auto rounded-md border">
              {searching ? (
                <p className="px-3 py-2 text-center text-xs text-muted-foreground">
                  검색 중…
                </p>
              ) : results.length === 0 ? (
                <p className="px-3 py-2 text-center text-xs text-muted-foreground">
                  결과 없음
                </p>
              ) : (
                results.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    disabled={submitting}
                    onClick={() => addParent(e)}
                    className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-sm hover:bg-accent"
                  >
                    <span className="truncate">{e.value}</span>
                    <Badge variant="outline" className="shrink-0 text-[9px]">
                      {e.type_slug}
                    </Badge>
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        {/* 나가는 관계 (이 값 → 대상) */}
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">
            나가는 관계 (이 값 → 대상)
          </Label>
          <RelationList
            items={rel?.parents}
            empty="나가는 관계가 없습니다."
            relTypeBySlug={relTypeBySlug}
            defsBySlug={defsBySlug}
            onRemove={removeRelation}
            onEdit={setEditingRel}
          />
        </div>

        {/* 들어오는 관계 (대상 → 이 값) */}
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">
            들어오는 관계 (대상 → 이 값)
          </Label>
          <RelationList
            items={rel?.children}
            empty="들어오는 관계가 없습니다."
            relTypeBySlug={relTypeBySlug}
            defsBySlug={defsBySlug}
            onRemove={removeRelation}
            onEdit={setEditingRel}
          />
        </div>

        {/* cross-kind 링크 (A0.3 스텝2) — 부서 등 system 객체 */}
        {objectLinks.length > 0 && (
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              조직 링크 (부서 등)
            </Label>
            <div className="max-h-40 overflow-y-auto rounded-md border">
              {objectLinks.map((it) => (
                <div
                  key={it.link_id}
                  className="flex items-center justify-between gap-2 border-b px-2.5 py-1.5 text-sm last:border-b-0"
                >
                  <span className="flex items-center gap-1.5 truncate">
                    <Badge className="shrink-0 text-[9px]">
                      {relTypeBySlug?.get(it.relation)?.label ?? it.relation}
                    </Badge>
                    <span className="truncate">
                      {it.target?.label ?? it.target?.id}
                    </span>
                    <Badge variant="outline" className="shrink-0 text-[9px]">
                      {it.target?.type}
                    </Badge>
                  </span>
                  <button
                    type="button"
                    onClick={() => removeObjectLink(it.link_id)}
                    className="shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    title="링크 삭제"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
          </>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            닫기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RelationList({ items, empty, onRemove, onEdit, relTypeBySlug, defsBySlug }) {
  if (items == null) {
    return (
      <p className="rounded-md border px-3 py-2 text-center text-xs text-muted-foreground">
        불러오는 중…
      </p>
    )
  }
  if (items.length === 0) {
    return (
      <p className="rounded-md border px-3 py-2 text-center text-xs text-muted-foreground">
        {empty}
      </p>
    )
  }
  return (
    <div className="max-h-56 overflow-y-auto rounded-md border">
      {items.map((it) => {
        const defs = defsBySlug?.[it.relation] ?? []
        const props = it.properties ?? {}
        const hasProps = Object.keys(props).length > 0
        const hasEvidence = it.evidence_report_id != null || it.evidence_note
        return (
          <div
            key={it.relation_id}
            className="space-y-1 border-b px-2.5 py-1.5 text-sm last:border-b-0"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 truncate">
                <Badge className="shrink-0 text-[9px]">
                  {relTypeBySlug?.get(it.relation)?.label ?? it.relation}
                </Badge>
                <span className="truncate">{it.value}</span>
                <Badge variant="outline" className="shrink-0 text-[9px]">
                  {it.type_slug}
                </Badge>
              </span>
              <span className="flex shrink-0 items-center">
                {onEdit && (
                  <button
                    type="button"
                    onClick={() => onEdit(it)}
                    className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                    title="링크 속성·근거 편집"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onRemove(it.relation_id)}
                  className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  title="관계 삭제"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </span>
            </div>
            {(hasProps || hasEvidence) && (
              <div className="space-y-0.5 pl-1">
                {hasProps && <PropertiesSummary defs={defs} properties={props} />}
                {hasEvidence && (
                  <div
                    className="flex items-center gap-1 text-[11px] text-muted-foreground"
                    title={it.evidence_note || undefined}
                  >
                    <FileText className="h-3 w-3 shrink-0" />
                    <span className="truncate">
                      {it.evidence_report_id != null
                        ? it.evidence_report_title || `보고서 #${it.evidence_report_id}`
                        : it.evidence_note}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * 링크(관계) 하나의 속성/근거 편집 (A0.2). 관계 종류의 property_defs(defs)로
 * 동적 속성 폼(축 편집과 동일한 EntityPropertiesFields 재사용)을 렌더하고, 근거
 * 보고서(provenance)와 자유 메모를 붙인다. 저장은 updateEntityRelation(PATCH):
 * properties 는 통째 교체(정의 없으면 {}), evidence 는 값/해제 그대로 반영.
 */
function RelationEditor({ entityId, rel, defs, relLabel, onCancel, onSaved }) {
  const [properties, setProperties] = useState(rel.properties ?? {})
  const [evidenceReportId, setEvidenceReportId] = useState(
    rel.evidence_report_id ?? null,
  )
  const [evidenceTitle, setEvidenceTitle] = useState(
    rel.evidence_report_title ?? null,
  )
  const [evidenceNote, setEvidenceNote] = useState(rel.evidence_note ?? '')
  const [submitting, setSubmitting] = useState(false)
  const missing = missingRequiredProps(defs, properties)
  const canSave = missing.length === 0 && !submitting

  async function handleSave() {
    if (!canSave) return
    setSubmitting(true)
    try {
      await updateEntityRelation(entityId, rel.relation_id, {
        properties: defs.length ? properties : {},
        evidence_report_id: evidenceReportId,
        evidence_note: evidenceNote.trim() || null,
      })
      toast.success('링크 저장됨')
      await onSaved()
    } catch (err) {
      toast.error(err?.response?.data?.message || err?.message || '저장 실패')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="rounded-md border bg-muted/20 px-3 py-2 text-sm">
        <div className="flex items-center gap-1.5">
          <Badge className="shrink-0 text-[9px]">{relLabel}</Badge>
          <span className="truncate font-medium">{rel.value}</span>
          <Badge variant="outline" className="shrink-0 text-[9px]">
            {rel.type_slug}
          </Badge>
        </div>
      </div>

      {defs.length > 0 ? (
        <EntityPropertiesFields
          defs={defs}
          value={properties}
          onChange={setProperties}
        />
      ) : (
        <p className="text-[11px] text-muted-foreground">
          이 관계 종류에는 정의된 링크 속성이 없습니다. (관계 종류 관리 → 속성 정의)
        </p>
      )}

      {/* 근거(provenance) — 이 링크를 주장한 보고서 + 자유 메모 */}
      <div className="space-y-1.5">
        <Label className="text-xs">근거 보고서 (선택)</Label>
        <EvidenceReportPicker
          reportId={evidenceReportId}
          title={evidenceTitle}
          onPick={(r) => {
            setEvidenceReportId(r?.id ?? null)
            setEvidenceTitle(r?.title ?? null)
          }}
        />
        <Textarea
          value={evidenceNote}
          onChange={(e) => setEvidenceNote(e.target.value)}
          rows={2}
          maxLength={500}
          placeholder="근거 메모(선택) — 이 링크를 주장하는 출처·조건 등"
          className="text-sm"
        />
      </div>

      {missing.length > 0 && (
        <p className="text-[11px] text-destructive">필수 속성을 채워주세요.</p>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          <X className="mr-1 h-3.5 w-3.5" /> 취소
        </Button>
        <Button size="sm" onClick={handleSave} disabled={!canSave}>
          {submitting ? '저장 중...' : '저장'}
        </Button>
      </div>
    </div>
  )
}

/** 근거 보고서 picker — 제목·본문 전문검색(가시 범위 내)으로 하나 고른다.
 *  선택 시 id 를 저장하고 라벨은 세션 동안 제목으로 표시. 해제 가능. */
function EvidenceReportPicker({ reportId, title, onPick }) {
  const [q, setQ] = useState('')
  const { data } = useAsync(
    () =>
      q.trim().length >= 1
        ? searchReports(q.trim(), { limit: 12 })
        : Promise.resolve({ results: [] }),
    [q],
  )
  const results = data?.results ?? []

  if (reportId != null) {
    return (
      <div className="flex items-center gap-2">
        <Badge variant="secondary" className="gap-1 text-[11px]">
          <FileText className="h-3 w-3" />
          <span className="max-w-[16rem] truncate">
            {title || `보고서 #${reportId}`}
          </span>
          <button
            type="button"
            onClick={() => onPick(null)}
            className="text-muted-foreground hover:text-foreground"
            aria-label="근거 해제"
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      </div>
    )
  }

  return (
    <div className="space-y-1">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="보고서 제목·본문 검색…"
          className="h-8 pl-7 text-sm"
        />
      </div>
      {q.trim() && results.length > 0 && (
        <div className="max-h-40 overflow-y-auto rounded-md border">
          {results.map(({ report }) => (
            <button
              key={report.id}
              type="button"
              onClick={() => {
                onPick(report)
                setQ('')
              }}
              className="flex w-full items-center gap-2 px-2 py-1 text-left text-sm hover:bg-accent"
            >
              <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{report.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Create + edit share the same dialog — fields are identical
 * (value/code/description) and the only differences are the title and
 * the submit handler. `mode="create"` ignores `target`.
 */
function EditDialog({ mode, type, defs = [], target, onClose, onSaved }) {
  const isCreate = mode === 'create'
  const isLifecycle = type.temporal_kind === 'lifecycle'
  const isYearly = type.temporal_kind === 'yearly'
  const [value, setValue] = useState(target?.value ?? '')
  const [code, setCode] = useState(target?.code ?? '')
  const [description, setDescription] = useState(target?.description ?? '')
  // 객체 속성 (A0.1). 편집 시 기존 값에서 시드. 정의 없으면 폼 미표시.
  const [properties, setProperties] = useState(target?.properties ?? {})
  const missingProps = missingRequiredProps(defs, properties)
  // lifecycle 유효구간 — 빈 문자열 = 개방(NULL).
  const [fromYear, setFromYear] = useState(
    target?.valid_from_year != null ? String(target.valid_from_year) : '',
  )
  const [toYear, setToYear] = useState(
    target?.valid_to_year != null ? String(target.valid_to_year) : '',
  )
  // yearly 연도 세트 — 쉼표/공백 구분 텍스트로 편집. 신규는 올해로 시작
  // (백엔드 자동배정과 일치). 기존 값은 마운트 시 로드.
  const [yearsText, setYearsText] = useState(
    isCreate && isYearly ? String(new Date().getFullYear()) : '',
  )
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (isCreate || !isYearly || !target?.id) return undefined
    let cancelled = false
    getEntityYears(target.id)
      .then((res) => {
        if (!cancelled) setYearsText((res?.years ?? []).join(', '))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [isCreate, isYearly, target?.id])

  // 입력 텍스트 → 정렬된 고유 연도 배열(범위 밖/비정수 무시).
  const parsedYears = useMemo(() => {
    const set = new Set()
    for (const tok of yearsText.split(/[\s,]+/)) {
      if (!tok) continue
      const n = Number(tok)
      if (Number.isInteger(n) && n >= 1900 && n <= 2200) set.add(n)
    }
    return [...set].sort((a, b) => a - b)
  }, [yearsText])

  const trimmedValue = value.trim()
  const canSubmit = trimmedValue.length > 0 && missingProps.length === 0 && !submitting

  function yearOrNull(s) {
    const t = s.trim()
    if (!t) return null
    const n = Number(t)
    return Number.isInteger(n) ? n : null
  }

  async function handleSubmit() {
    if (!canSubmit) return
    setSubmitting(true)
    try {
      if (isCreate) {
        const created = await createEntity({
          type_id: type.id,
          value: trimmedValue,
          code: code.trim() || undefined,
          description: description.trim(),
          properties: defs.length ? properties : undefined,
        })
        // 연도 데이터는 별도 경로 — 생성된 id 로 후속 반영.
        if (isLifecycle && (fromYear.trim() || toYear.trim())) {
          await updateEntity(created.id, {
            validFromYear: yearOrNull(fromYear),
            validToYear: yearOrNull(toYear),
          })
        }
        if (isYearly) await setEntityYears(created.id, parsedYears)
        toast.success(`'${trimmedValue}' 추가됨`)
      } else {
        await updateEntity(target.id, {
          value: trimmedValue,
          code: code.trim() || '',
          description: description.trim(),
          ...(defs.length ? { properties } : {}),
          ...(isLifecycle
            ? {
                validFromYear: yearOrNull(fromYear),
                validToYear: yearOrNull(toYear),
              }
            : {}),
        })
        if (isYearly) await setEntityYears(target.id, parsedYears)
        toast.success(`'${trimmedValue}' 수정됨`)
      }
      onSaved()
    } catch (err) {
      toast.error(err.message || '저장 실패')
    } finally {
      setSubmitting(false)
    }
  }

  const hasProps = defs.length > 0
  // 기본 정보 필드 묶음 — 속성 유무에 따라 단일/2단 배치에서 재사용.
  const basicFields = (
    <div className="space-y-3">
      <div>
        <Label className="text-xs">값</Label>
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          maxLength={255}
          className="mt-1 h-9"
          autoFocus
        />
      </div>
      <div>
        <Label className="text-xs">코드 (선택)</Label>
        <Input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          maxLength={64}
          className="mt-1 h-9"
          placeholder="예: AX-001"
        />
      </div>
      <div>
        <Label className="text-xs">설명 (선택)</Label>
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={2000}
          rows={4}
          className="mt-1"
        />
      </div>

      {/* lifecycle 축 — 유효구간(도입~폐지). 비우면 개방. (p56) */}
      {isLifecycle && (
        <div>
          <Label className="text-xs">유효 연도 구간 (선택)</Label>
          <div className="mt-1 flex items-center gap-2">
            <Input
              value={fromYear}
              onChange={(e) => setFromYear(e.target.value)}
              inputMode="numeric"
              placeholder="시작 (예: 2022)"
              className="h-9"
            />
            <span className="text-muted-foreground">~</span>
            <Input
              value={toYear}
              onChange={(e) => setToYear(e.target.value)}
              inputMode="numeric"
              placeholder="종료 (비우면 진행중)"
              className="h-9"
            />
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            비우면 그쪽이 개방됩니다(시작 비움=이전부터, 종료 비움=진행중).
          </p>
        </div>
      )}

      {/* yearly 축 — 적용 연도 세트. 쉼표/공백 구분. (p56) */}
      {isYearly && (
        <div>
          <Label className="text-xs">적용 연도</Label>
          <Input
            value={yearsText}
            onChange={(e) => setYearsText(e.target.value)}
            placeholder="예: 2024, 2025"
            className="mt-1 h-9"
          />
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {parsedYears.length === 0 ? (
              <span className="text-[11px] text-muted-foreground">
                배정된 연도 없음 — 이 값은 연도 필터에서 숨겨집니다.
              </span>
            ) : (
              parsedYears.map((y) => (
                <span
                  key={y}
                  className="rounded-full border bg-background px-2 py-0.5 text-[11px]"
                >
                  {y}
                </span>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className={cn(
          'flex max-h-[80vh] flex-col overflow-hidden',
          // 속성이 있으면 넓게(2단), 없으면 적당히.
          hasProps ? 'h-[80vh] w-[80vw] max-w-[80vw]' : 'max-w-lg',
        )}
      >
        <DialogHeader>
          <DialogTitle>
            {isCreate ? `${type.label} 추가` : `${type.label} 편집`}
          </DialogTitle>
          {!isCreate && target && (
            <DialogDescription className="text-xs">
              사용 중인 보고서 {target.usage_count ?? 0}건
            </DialogDescription>
          )}
        </DialogHeader>

        {hasProps ? (
          // 2단 — 왼쪽 기본 정보, 오른쪽 속성. 각 열 독립 스크롤.
          <div className="grid min-h-0 flex-1 gap-6 overflow-hidden md:grid-cols-[22rem_1fr]">
            <div className="min-h-0 space-y-2 overflow-y-auto pr-2">
              <div className="text-xs font-semibold text-muted-foreground">
                기본 정보
              </div>
              {basicFields}
            </div>
            <div className="min-h-0 overflow-y-auto pr-1">
              <EntityPropertiesFields
                defs={defs}
                value={properties}
                onChange={setProperties}
              />
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">{basicFields}</div>
        )}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            취소
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={!canSubmit}>
            {submitting ? '저장 중...' : isCreate ? '추가' : '저장'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Pick another value in the same axis as the merge target. Reuses the
 * already-fetched `allRows` so no extra request for the candidate list
 * — admin lists everything for the axis anyway. The source row is
 * excluded from the pick list (merging into itself is a no-op).
 *
 * When the source has any usage, we also fetch the actual list of
 * affected reports so the admin can preview which reports will be
 * re-tagged before committing.
 */
function MergeDialog({ type, source, allRows, onClose, onMerged }) {
  const [intoId, setIntoId] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [usage, setUsage] = useState(null) // null = loading | array
  const [usageError, setUsageError] = useState(null)
  const candidates = useMemo(
    () => allRows.filter((r) => r.id !== source.id),
    [allRows, source.id],
  )
  const target = candidates.find((r) => r.id === intoId)
  const canSubmit = !!target && !submitting
  const sourceUsage = source.usage_count ?? 0

  useEffect(() => {
    if (sourceUsage <= 0) {
      setUsage([]) // skip the network call when there's nothing to preview
      return
    }
    let cancelled = false
    listEntityUsage(source.id)
      .then((res) => {
        if (!cancelled) setUsage(res?.items ?? [])
      })
      .catch((e) => {
        if (cancelled) return
        setUsageError(e)
      })
    return () => {
      cancelled = true
    }
  }, [source.id, sourceUsage])

  async function handleMerge() {
    if (!canSubmit) return
    setSubmitting(true)
    try {
      const res = await mergeEntity(source.id, intoId)
      toast.success(
        `'${source.value}' → '${target.value}' 머지 완료 (${res?.relinked_report_count ?? 0}건 재연결).`,
      )
      onMerged()
    } catch (err) {
      toast.error(err.message || '머지 실패')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{type.label} 머지</DialogTitle>
          <DialogDescription className="text-xs">
            <strong>'{source.value}'</strong> 를 다른 값으로 합칩니다 —
            이 값을 사용하던 보고서들은 모두 선택한 대상 값으로 재연결되고,
            <strong>'{source.value}'</strong> 는 삭제됩니다.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {sourceUsage > 0 && (
            <div className="rounded-md border bg-muted/30 p-2">
              <div className="mb-1 text-[11px] font-medium text-muted-foreground">
                재연결될 보고서 ({sourceUsage}건)
              </div>
              <UsageList items={usage} error={usageError} />
            </div>
          )}
          <div>
            <Label className="text-xs">합칠 대상</Label>
            <div className="mt-1 max-h-60 overflow-y-auto rounded-md border">
              {candidates.length === 0 && (
                <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                  같은 축의 다른 값이 없습니다.
                </p>
              )}
              {candidates.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setIntoId(r.id)}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-accent ${
                    intoId === r.id ? 'bg-accent' : ''
                  }`}
                >
                  <span
                    className={
                      r.status === 'deprecated'
                        ? 'text-muted-foreground line-through'
                        : ''
                    }
                  >
                    {r.value}
                    {r.code && (
                      <span className="ml-1 text-[11px] text-muted-foreground">
                        ({r.code})
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                    {r.usage_count ?? 0}건
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            취소
          </Button>
          <Button size="sm" onClick={handleMerge} disabled={!canSubmit}>
            {submitting ? '머지 중...' : '머지'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Hard-delete confirm. On open, fetches the actual list of reports using
 * this entity so the admin can see them inline (instead of getting a
 * bare "사용 중" error toast after clicking 삭제). When there's any
 * usage the destructive action is disabled and three escape routes
 * surface:
 *
 *   - 대신 머지   — consolidate with another value (preserves the tagging)
 *   - 태그 해제   — unlink from one report (×) or all reports (footer button);
 *                   the entity itself stays
 *   - 취소
 *
 * Once usage drops to 0 (via × or bulk-unlink), the 삭제 button enables.
 * The list and count refresh in place after each unlink so the admin
 * doesn't have to re-open the dialog.
 */
function DeleteConfirmDialog({ target, onClose, onDeleted, onSwitchToMerge }) {
  const [submitting, setSubmitting] = useState(false)
  const [unlinkingAll, setUnlinkingAll] = useState(false)
  const [usage, setUsage] = useState(null) // null = loading | array
  const [usageError, setUsageError] = useState(null)

  function refetchUsage() {
    setUsage(null)
    setUsageError(null)
    listEntityUsage(target.id)
      .then((res) => setUsage(res?.items ?? []))
      .catch((e) => setUsageError(e))
  }

  useEffect(() => {
    let cancelled = false
    listEntityUsage(target.id)
      .then((res) => {
        if (!cancelled) setUsage(res?.items ?? [])
      })
      .catch((e) => {
        if (cancelled) return
        setUsageError(e)
      })
    return () => {
      cancelled = true
    }
  }, [target.id])

  // Server's count and our just-fetched list may diverge by 1–2 if a
  // concurrent edit landed between the grid load and now; we trust the
  // freshly-fetched list to drive the disabled state.
  const blockedByUsage = (usage?.length ?? 0) > 0 || usage === null
  const canDelete = !submitting && usage !== null && usage.length === 0

  async function handleUnlinkOne(reportId) {
    try {
      await unlinkEntityFromReport(target.id, reportId)
      toast.success(`보고서 ${reportId} 에서 '${target.value}' 태그 해제됨`)
      refetchUsage()
    } catch (err) {
      toast.error(err.message || '태그 해제 실패')
    }
  }

  async function handleUnlinkAll() {
    if (!usage || usage.length === 0) return
    setUnlinkingAll(true)
    try {
      const res = await unlinkEntityFromAllReports(target.id)
      toast.success(
        `${res?.removed_count ?? usage.length}건의 보고서에서 '${target.value}' 태그 해제됨`,
      )
      refetchUsage()
    } catch (err) {
      toast.error(err.message || '태그 해제 실패')
    } finally {
      setUnlinkingAll(false)
    }
  }

  async function handleDelete() {
    setSubmitting(true)
    try {
      await deleteEntity(target.id)
      toast.success(`'${target.value}' 삭제됨`)
      onDeleted()
    } catch (err) {
      // Defensive: a concurrent edit might have re-introduced usage
      // between our refetch and the delete call. Surface the server's
      // message verbatim in that case.
      toast.error(err.message || '삭제 실패')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            삭제 확인
          </DialogTitle>
          <DialogDescription>
            <strong>'{target.value}'</strong> 를 완전히 삭제합니다.
            {usage !== null && usage.length === 0
              ? ' 사용 중인 보고서가 없어 안전하게 삭제할 수 있습니다.'
              : ' 사용 중인 보고서가 있으면 직접 삭제할 수 없습니다 — 머지하거나, 아래 ×/일괄 해제로 태그를 먼저 풀어주세요.'}
          </DialogDescription>
        </DialogHeader>

        {blockedByUsage && (
          <div className="rounded-md border bg-muted/30 p-2">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium text-muted-foreground">
                {usage === null
                  ? '사용 중인 보고서 확인 중...'
                  : `사용 중인 보고서 (${usage.length}건)`}
              </span>
              {usage !== null && usage.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-[11px] text-muted-foreground hover:text-destructive"
                  onClick={handleUnlinkAll}
                  disabled={unlinkingAll}
                  title="이 모든 보고서에서 태그만 해제 — 엔티티 자체는 남습니다"
                >
                  <Link2Off className="mr-1 h-3 w-3" />
                  {unlinkingAll ? '해제 중...' : '모두 해제'}
                </Button>
              )}
            </div>
            <UsageList
              items={usage}
              error={usageError}
              onUnlink={handleUnlinkOne}
            />
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            취소
          </Button>
          {usage !== null && usage.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={onSwitchToMerge}
              className="gap-1"
            >
              <Combine className="h-3.5 w-3.5" />
              대신 머지하기
            </Button>
          )}
          <Button
            size="sm"
            variant="destructive"
            onClick={handleDelete}
            disabled={!canDelete}
            title={
              usage !== null && usage.length > 0
                ? '사용 중인 보고서가 있어서 삭제할 수 없습니다.'
                : undefined
            }
          >
            {submitting ? '삭제 중...' : '삭제'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function formatDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString().slice(0, 10)
}

/**
 * 관계 종류 레지스트리 관리 (D-1 후속) — relation_types CRUD. 엔티티끼리 잇는
 * 엣지의 *종류*(part_of / tested_by …)를 admin 이 직접 추가·편집·삭제한다. 지금까지
 * 7종이 시드돼 있고, 새 도메인 관계가 필요할 때 마이그레이션 없이 여기서 늘린다.
 * 사용 중인 종류 삭제는 백엔드가 거부(toast 로 표시).
 */
function RelationTypesDialog({ axes, onClose }) {
  const [items, setItems] = useState(null) // null=loading
  const [editing, setEditing] = useState(null) // null | {} (new) | row (edit)
  const [propDefsRt, setPropDefsRt] = useState(null) // 링크 속성정의 편집 대상(관계종류)

  async function reload() {
    try {
      const res = await listRelationTypes()
      setItems(res?.items ?? [])
    } catch (err) {
      toast.error('관계 종류 불러오기 실패', {
        description: String(err?.message ?? err),
      })
      setItems([])
    }
  }
  useEffect(() => {
    reload()
  }, [])

  async function handleDelete(rt) {
    if (
      !window.confirm(
        `'${rt.label}'(${rt.slug}) 관계 종류를 삭제할까요? 사용 중이면 거부됩니다.`,
      )
    )
      return
    try {
      await deleteRelationType(rt.slug)
      toast.success(`'${rt.label}' 삭제됨`)
      reload()
    } catch (err) {
      toast.error(
        err?.response?.data?.message || err?.message || '삭제 실패',
      )
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[80vh] w-[44rem] max-w-[44rem] flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Network className="h-4 w-4" /> 관계 종류 관리
          </DialogTitle>
          <DialogDescription>
            엔티티 간 관계의 종류를 정의합니다. 이행성(롤업 대상)·방향·허용 축을
            지정하며, slug 는 관계들이 가리키는 키라 생성 후 변경 불가입니다.
          </DialogDescription>
        </DialogHeader>

        {editing !== null ? (
          <RelationTypeForm
            axes={axes}
            value={editing}
            onCancel={() => setEditing(null)}
            onSaved={() => {
              setEditing(null)
              reload()
            }}
          />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <div className="flex justify-end">
              <Button size="sm" onClick={() => setEditing({})}>
                <Plus className="mr-1 h-3.5 w-3.5" /> 관계 종류 추가
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto rounded-md border">
              {items === null ? (
                <p className="p-4 text-center text-xs text-muted-foreground">
                  불러오는 중…
                </p>
              ) : items.length === 0 ? (
                <p className="p-4 text-center text-xs text-muted-foreground">
                  등록된 관계 종류가 없습니다.
                </p>
              ) : (
                <ul className="divide-y">
                  {items.map((rt) => (
                    <li
                      key={rt.slug}
                      className="flex items-start gap-2 px-3 py-2 text-sm"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium">{rt.label}</span>
                          <code className="rounded bg-muted px-1 font-mono text-[11px] text-muted-foreground">
                            {rt.slug}
                          </code>
                        </div>
                        <div className="mt-0.5 flex flex-wrap gap-1">
                          {rt.transitive && (
                            <Badge
                              variant="secondary"
                              className="text-[10px]"
                              title="연쇄로 이어짐 — '관련 포함' 검색이 자손까지 끝까지 펼침(예: part_of)"
                            >
                              이행(롤업)
                            </Badge>
                          )}
                          {rt.directed && (
                            <Badge
                              variant="secondary"
                              className="text-[10px]"
                              title="출발→도착 방향이 의미를 가짐(역방향은 다른 뜻)"
                            >
                              방향성
                            </Badge>
                          )}
                          {rt.acyclic && (
                            <Badge
                              variant="secondary"
                              className="text-[10px]"
                              title="A→B→A 같은 순환을 금지(계층·버전 구조)"
                            >
                              순환금지
                            </Badge>
                          )}
                          <span
                            className="text-[11px] text-muted-foreground"
                            title="허용 출발 축 → 도착 축 (전체 = 제약 없음)"
                          >
                            {(rt.src_axis_slugs?.join('·') || '전체')} →{' '}
                            {rt.dst_axis_slugs?.join('·') || '전체'}
                          </span>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setPropDefsRt(rt)}
                        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                        title="링크 속성 정의 — 이 관계가 나르는 속성 스키마"
                      >
                        <Tags className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditing(rt)}
                        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                        title="편집"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(rt)}
                        className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        title="삭제"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </DialogContent>
      {propDefsRt && (
        <PropertyDefsDialog
          owner={relationTypeOwner(propDefsRt)}
          onClose={() => setPropDefsRt(null)}
        />
      )}
    </Dialog>
  )
}

/** 체크박스 + 제목 + 평이한 설명 한 줄. 관계 메타 용어(이행/방향/순환)를
 *  관리자가 정확히 이해하도록 각 항목에 예시를 곁들인다. */
function CheckRow({ checked, onChange, title, desc }) {
  return (
    <label className="flex cursor-pointer items-start gap-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="mt-0.5 h-3.5 w-3.5 shrink-0"
      />
      <span className="min-w-0">
        <span className="text-xs font-medium">{title}</span>
        <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
          {desc}
        </span>
      </span>
    </label>
  )
}

/** 관계 종류 추가/편집 폼. value={} 면 생성(slug 입력), 아니면 편집(slug 고정). */
function RelationTypeForm({ axes, value, onCancel, onSaved }) {
  const isCreate = !value.slug
  const [slug, setSlug] = useState(value.slug ?? '')
  const [label, setLabel] = useState(value.label ?? '')
  const [inverseLabel, setInverseLabel] = useState(value.inverse_label ?? '')
  const [directed, setDirected] = useState(value.directed ?? true)
  const [transitive, setTransitive] = useState(value.transitive ?? false)
  const [acyclic, setAcyclic] = useState(value.acyclic ?? false)
  const [srcAxes, setSrcAxes] = useState(value.src_axis_slugs ?? [])
  const [dstAxes, setDstAxes] = useState(value.dst_axis_slugs ?? [])
  const [sortOrder, setSortOrder] = useState(String(value.sort_order ?? 0))
  const [description, setDescription] = useState(value.description ?? '')
  const [submitting, setSubmitting] = useState(false)

  const trimmedSlug = slug.trim()
  const canSubmit =
    !submitting &&
    label.trim().length > 0 &&
    (!isCreate || /^[a-z0-9_]+$/.test(trimmedSlug))

  function toggleAxis(setter, list, axisSlug) {
    setter(
      list.includes(axisSlug)
        ? list.filter((s) => s !== axisSlug)
        : [...list, axisSlug],
    )
  }

  async function handleSave() {
    if (!canSubmit) return
    setSubmitting(true)
    const common = {
      label: label.trim(),
      inverse_label: inverseLabel.trim(),
      directed,
      transitive,
      acyclic,
      // 빈 배열 → 백엔드가 '제약 없음'(NULL)으로 저장.
      src_axis_slugs: srcAxes,
      dst_axis_slugs: dstAxes,
      sort_order: Number(sortOrder) || 0,
      description: description.trim(),
    }
    try {
      if (isCreate) {
        await createRelationType({ slug: trimmedSlug, ...common })
        toast.success(`'${label.trim()}' 추가됨`)
      } else {
        await updateRelationType(value.slug, common)
        toast.success(`'${label.trim()}' 수정됨`)
      }
      onSaved()
    } catch (err) {
      toast.error(
        err?.response?.data?.message || err?.message || '저장 실패',
      )
      setSubmitting(false)
    }
  }

  function AxisChecks({ list, setter }) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {axes.map((a) => (
          <label
            key={a.slug}
            className="inline-flex cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]"
          >
            <input
              type="checkbox"
              checked={list.includes(a.slug)}
              onChange={() => toggleAxis(setter, list, a.slug)}
              className="h-3 w-3"
            />
            {a.label}
          </label>
        ))}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs">slug (영소문자·숫자·_)</Label>
            <Input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              disabled={!isCreate}
              placeholder="예: depends_on"
              className="mt-1 h-9 font-mono text-sm disabled:opacity-60"
            />
          </div>
          <div>
            <Label className="text-xs">정렬 순서</Label>
            <Input
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
              inputMode="numeric"
              className="mt-1 h-9"
            />
          </div>
        </div>
        <p className="-mt-1 text-[11px] text-muted-foreground">
          slug = 시스템 내부 식별자(관계들이 이 키를 참조). 생성 후 변경 불가.
          정렬 순서 = picker·목록에서 표시 순서(작을수록 위).
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs">라벨</Label>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="예: 의존함"
              className="mt-1 h-9"
            />
          </div>
          <div>
            <Label className="text-xs">역방향 라벨</Label>
            <Input
              value={inverseLabel}
              onChange={(e) => setInverseLabel(e.target.value)}
              placeholder="예: 의존 대상"
              className="mt-1 h-9"
            />
          </div>
        </div>
        <p className="-mt-1 text-[11px] text-muted-foreground">
          라벨 = 출발 엔티티 관점 표기, 역방향 라벨 = 도착 엔티티 관점 표기.
          예: part_of → 라벨 &ldquo;포함됨&rdquo;(부품 입장) ↔ 역 &ldquo;포함&rdquo;(모델 입장).
        </p>
        <div className="space-y-2.5 rounded-md border bg-muted/20 p-3">
          <CheckRow
            checked={transitive}
            onChange={() => setTransitive((v) => !v)}
            title="이행적 (연쇄·롤업 대상)"
            desc="관계가 연쇄로 이어집니다. A가 B에, B가 C에 속하면 A도 C에 속한 것으로 봅니다. 켜면 '관련 포함' 검색이 자손까지 끝까지 펼칩니다. 예: part_of(나사⊂모듈⊂모델 → 나사도 모델 소속). 끄면 한 단계만 보고 연쇄하지 않습니다(예: tested_by)."
          />
          <CheckRow
            checked={directed}
            onChange={() => setDirected((v) => !v)}
            title="방향성 있음"
            desc="한쪽 방향(출발→도착)이 의미를 갖는 관계입니다. 예: 부품 tested_by 시험 — '부품이 시험된다'는 방향이고 역은 다른 뜻. '관련 포함' 검색은 방향성 관계를 주체→속성 방향으로만 따라갑니다. 끄면 양쪽이 대등한 대칭 관계(예: '관련됨')."
          />
          <CheckRow
            checked={acyclic}
            onChange={() => setAcyclic((v) => !v)}
            title="순환 금지"
            desc="A→B→A 같은 고리를 막습니다. 켜면 순환이 생기는 관계 추가를 거부 — 계층·버전 구조에 필수입니다(예: 'A가 B의 부품인데 B도 A의 부품'은 불가). 보통 이행적 관계와 함께 켭니다(part_of·supersedes)."
          />
        </div>
        <p className="text-[11px] text-muted-foreground">
          이 관계를 맺을 수 있는 축을 제한합니다(잘못된 조합 입력 방지). 예:
          tested_by → 출발=부품, 도착=시험. 둘 다 비우면 아무 축이나 허용.
        </p>
        <div>
          <Label className="text-xs">허용 출발 축 (비우면 제약 없음)</Label>
          <div className="mt-1">
            <AxisChecks list={srcAxes} setter={setSrcAxes} />
          </div>
        </div>
        <div>
          <Label className="text-xs">허용 도착 축 (비우면 제약 없음)</Label>
          <div className="mt-1">
            <AxisChecks list={dstAxes} setter={setDstAxes} />
          </div>
        </div>
        <div>
          <Label className="text-xs">설명 (선택)</Label>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="mt-1"
          />
        </div>
      </div>
      <DialogFooter className="mt-3">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>
          ← 목록
        </Button>
        <Button size="sm" onClick={handleSave} disabled={!canSubmit}>
          {submitting ? '저장 중…' : isCreate ? '추가' : '저장'}
        </Button>
      </DialogFooter>
    </div>
  )
}
