// 본문 @멘션 작성 팝업 — 표시 문구 + 유형(현재: 보고서) + 대상 검색 + "연결된
// 보고서로 등록" 체크박스(기본 켜짐) + 관계 유형. 확인 시 행 에디터에 인라인
// 링크를 삽입하고(체크 시) ReportLink 관계도 생성한다.
//
// 유형 select 를 둬서 향후 보고서가 아닌 멘션 타입도 추가할 수 있게 일반화했다.
//
// 레이아웃: react-grid-layout transform 안에서 position:fixed 가 어긋나지 않게
// document.body 로 portal. 작은 화면에서 하단이 잘리지 않도록 (1) 패널 높이를
// 뷰포트에 맞춰 본문만 내부 스크롤하고 (헤더·푸터는 고정), (2) 헤더를 잡고
// 드래그해 옮길 수 있다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { GripHorizontal, Loader2, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { cn } from '@/shared/lib/utils'
import { WorkspaceTreeSelect } from '@/shared/components/WorkspaceTreeSelect'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import { useReportMention } from '@/shared/reports/ReportMentionContext'
import { useLinkKinds } from './ReportLinks'
import { ReportPicker } from './ReportPicker'
import { EntityMentionPicker } from './EntityMentionPicker'

// 멘션 유형. 향후(사용자/외부링크 등) 더 추가 가능하도록 배열 구조 유지.
// 엔티티 축은 여기 늘리지 않는다 — "관련 정보" 한 유형 안에서 축을 동적으로
// 고른다(EntityMentionPicker). 그래서 축이 늘어도 토글은 그대로다.
const MENTION_TYPES = [
  { value: 'report', label: '보고서' },
  { value: 'dept', label: '협업 부서' },
  { value: 'entity', label: '관련 정보' },
]

const PANEL_WIDTH = 440
const MARGIN = 8

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n))
}

// 팝업 초기 위치 — 앵커(커서) 아래에 두되 화면을 벗어나지 않게 클램프.
function computeInitialPos(rect) {
  if (typeof window === 'undefined') return { left: MARGIN, top: MARGIN }
  const vw = window.innerWidth
  const vh = window.innerHeight
  const left = rect
    ? clamp(rect.left, MARGIN, vw - PANEL_WIDTH - MARGIN)
    : Math.max(MARGIN, (vw - PANEL_WIDTH) / 2)
  const top = rect
    ? clamp(rect.bottom + 6, MARGIN, vh - 120)
    : Math.max(MARGIN, (vh - 400) / 2)
  return { left, top }
}

// 위젯 참조(#) 피커 — 같은 보고서의 그림/표/수식 등 번호가 매겨진 블록 목록을
// 보여주고, 고르면 본문에 "그림 3" 같은 참조를 즉시 삽입한다. 번호/라벨은
// blockIndex 에서 온 live 값(문서 순서 기반)이라 재정렬 시 자동 갱신된다.
function BlockRefPicker({ popup, blocks, onClose }) {
  const [query, setQuery] = useState('')
  // 박스(위치+크기). 모서리 드래그로 사용자가 키울 수 있다(resize: both).
  const [box, setBox] = useState(() => computeBlockPickerBox(popup.anchorRect))

  useEffect(() => {
    setBox(computeBlockPickerBox(popup.anchorRect))
  }, [popup.anchorRect])

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Strip a leading '#' so the trigger char never filters the list (the '#'
  // is shown as a fixed prefix in the box instead — see below).
  const q = query.replace(/^#+/, '').trim().toLowerCase()
  const filtered = q
    ? blocks.filter(
        (b) =>
          b.label.toLowerCase().includes(q) ||
          (b.caption ?? '').toLowerCase().includes(q),
      )
    : blocks

  function pick(b) {
    popup.insert?.({
      text: b.label,
      atCaret: popup.atCaret,
      // ids are page-local → store the page too so the reference resolves
      // unambiguously across the whole report.
      attrs: { mentionType: 'block', mentionId: b.id, mentionPage: b.pageIndex },
    })
    onClose()
  }

  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
  const vh = typeof window !== 'undefined' ? window.innerHeight : 768

  return createPortal(
    <>
      <div className="fixed inset-0 z-[60]" onMouseDown={onClose} />
      <div
        className="fixed z-[61] flex flex-col rounded-lg border bg-popover shadow-xl"
        style={{
          left: box.left,
          top: box.top,
          width: box.width,
          height: box.height,
          // 사용자가 모서리(우하단)를 끌어 크기 조절. overflow:hidden 이라야
          // 네이티브 리사이즈 그립이 뜨고, 내부 리스트는 자체 스크롤한다.
          resize: 'both',
          overflow: 'hidden',
          minWidth: 260,
          minHeight: 180,
          maxWidth: vw - 2 * MARGIN,
          maxHeight: vh - 2 * MARGIN,
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-b shrink-0">
          <div className="text-xs font-semibold text-foreground">위젯 참조</div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-0.5 text-muted-foreground hover:bg-muted"
            title="닫기"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="p-2 shrink-0 border-b">
          {/* '#' 는 고정 프리픽스로 표시하고, 입력값에 끼어든 선행 '#' 은 떼어내
              항상 리스트가 바로 보이게 한다. */}
          <div className="flex h-8 items-center gap-1 rounded-md border bg-background px-2 focus-within:ring-1 focus-within:ring-ring">
            <span className="select-none text-xs font-semibold text-amber-600">#</span>
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value.replace(/^#+/, ''))}
              placeholder="그림/표 검색 (라벨·캡션)"
              className="h-full flex-1 bg-transparent text-xs outline-none"
            />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <div className="px-2 py-6 text-center text-xs text-muted-foreground">
              참조할 그림/표가 없습니다.
            </div>
          ) : (
            filtered.map((b) => (
              <button
                key={b.key}
                type="button"
                onClick={() => pick(b)}
                className="flex w-full items-baseline gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted"
              >
                <span className="shrink-0 font-medium text-foreground">{b.label}</span>
                {b.caption && (
                  <span className="truncate text-muted-foreground">{b.caption}</span>
                )}
                <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                  p.{(b.pageIndex ?? 0) + 1}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </>,
    document.body,
  )
}

// 위젯 참조 피커의 초기 박스(위치+크기). 작은 화면에서도 쓸 만하게 위/아래
// 중 공간이 큰 쪽으로 펼치고, 뷰포트를 넘지 않게 클램프한다. 사용자는 이후
// 모서리를 끌어 키울 수 있다(panel 의 resize: both).
function computeBlockPickerBox(rect) {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
  const vh = typeof window !== 'undefined' ? window.innerHeight : 768
  const width = Math.min(PANEL_WIDTH, vw - 2 * MARGIN)
  const below = rect ? vh - rect.bottom - MARGIN : vh - 2 * MARGIN
  const above = rect ? rect.top - MARGIN : vh - 2 * MARGIN
  const useAbove = below < 260 && above > below
  const avail = Math.max(useAbove ? above : below, 200)
  const height = clamp(Math.min(380, avail), 180, vh - 2 * MARGIN)
  const left = clamp(
    rect ? rect.left : (vw - width) / 2,
    MARGIN,
    Math.max(MARGIN, vw - width - MARGIN),
  )
  const top = useAbove
    ? clamp((rect?.top ?? vh) - 6 - height, MARGIN, vh - height - MARGIN)
    : clamp((rect?.bottom ?? 0) + 6, MARGIN, vh - height - MARGIN)
  return { left, top, width, height }
}

export function ReportMentionDialog() {
  const mention = useReportMention()
  const popup = mention?.popup ?? null
  const { kinds } = useLinkKinds()
  const { all } = useWorkspace()
  const orgWorkspaces = useMemo(
    () => (all ?? []).filter((w) => w.kind === 'org' && !w.virtual),
    [all],
  )

  const [displayText, setDisplayText] = useState('')
  const [displayTouched, setDisplayTouched] = useState(false)
  const [type, setType] = useState('report')
  const [selected, setSelected] = useState(null) // 보고서 선택(ReportSummary)
  const [selectedDept, setSelectedDept] = useState(null) // 협업 부서 slug
  const [selectedEntity, setSelectedEntity] = useState(null) // 관련 정보 엔티티
  const [registerLink, setRegisterLink] = useState(true)
  const [kindDir, setKindDir] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [pos, setPos] = useState(null) // {left, top} | null(=초기 계산 전)

  // 팝업이 새로 열릴 때마다 폼·위치 초기화. rowIndex/atCaret 이 바뀌면 새 트리거.
  const openKey = popup ? `${popup.rowIndex}:${popup.atCaret}` : null
  useEffect(() => {
    if (!openKey) return
    setDisplayText('')
    setDisplayTouched(false)
    setType('report')
    setSelected(null)
    setSelectedDept(null)
    setSelectedEntity(null)
    setRegisterLink(true)
    setSubmitting(false)
    setPos(computeInitialPos(popup?.anchorRect))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openKey])

  // 관계 유형 기본값 — 카탈로그 첫 항목의 정방향.
  useEffect(() => {
    if (!kindDir && kinds?.length > 0) setKindDir(`${kinds[0].key}|outgoing`)
  }, [kinds, kindDir])

  // 보고서를 고르면, 사용자가 표시 문구를 아직 안 건드렸을 때 제목으로 자동 채움.
  function handleSelect(r) {
    setSelected(r)
    if (r && !displayTouched) setDisplayText(r.title ?? '')
  }

  // 협업 부서 — 단일 선택(트리는 다중이지만 같은 항목 토글 = 해제, 다른 항목
  // 선택 = 교체). 새로 고르면 표시 문구를 부서명으로 자동 채움.
  const deptSelectedSet = useMemo(
    () => new Set(selectedDept ? [selectedDept] : []),
    [selectedDept],
  )
  function handleToggleDept(slug) {
    setSelectedDept((prev) => {
      const next = prev === slug ? null : slug
      if (next && !displayTouched) {
        const name = orgWorkspaces.find((w) => w.slug === slug)?.name
        if (name) setDisplayText(name)
      }
      return next
    })
  }

  // 관련 정보(엔티티) — 단일 선택. 고르면 표시 문구를 값으로 자동 채움.
  function handleSelectEntity(ent) {
    setSelectedEntity(ent)
    if (ent && !displayTouched) setDisplayText(ent.value ?? '')
  }

  // Esc 로 닫기.
  useEffect(() => {
    if (!popup) return undefined
    function onKey(e) {
      if (e.key === 'Escape') mention.close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [popup, mention])

  // ── 헤더 드래그 이동 ───────────────────────────────────────────────────
  const dragRef = useRef(null)
  const onDragMove = useCallback((ev) => {
    const d = dragRef.current
    if (!d) return
    const vw = window.innerWidth
    const vh = window.innerHeight
    const left = clamp(d.startLeft + (ev.clientX - d.startX), MARGIN, vw - PANEL_WIDTH - MARGIN)
    const top = clamp(d.startTop + (ev.clientY - d.startY), MARGIN, vh - 60)
    setPos({ left, top })
  }, [])
  const onDragEnd = useCallback(() => {
    dragRef.current = null
    window.removeEventListener('mousemove', onDragMove)
    window.removeEventListener('mouseup', onDragEnd)
  }, [onDragMove])
  function onHeaderMouseDown(e) {
    if (e.button !== 0 || !pos) return
    e.preventDefault()
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startLeft: pos.left,
      startTop: pos.top,
    }
    window.addEventListener('mousemove', onDragMove)
    window.addEventListener('mouseup', onDragEnd)
  }
  // 언마운트/닫힘 시 드래그 리스너 정리.
  useEffect(() => () => onDragEnd(), [onDragEnd])

  if (!popup) return null

  // '#' 트리거 — 같은 보고서의 그림/표 등 위젯 참조. 별도의 간단 피커를 띄운다
  // (멘션 폼과 분리). 선택 즉시 삽입.
  if (popup.mode === 'block') {
    return (
      <BlockRefPicker
        popup={popup}
        blocks={mention?.referenceableBlocks ?? []}
        onClose={() => mention.close()}
      />
    )
  }

  const effectivePos = pos ?? computeInitialPos(popup.anchorRect)
  const maxHeight =
    (typeof window !== 'undefined' ? window.innerHeight : 800) -
    effectivePos.top -
    MARGIN

  const kindLabel = (() => {
    if (!kindDir) return ''
    const [k, dir] = kindDir.split('|')
    const meta = kinds?.find((x) => x.key === k)
    if (!meta) return ''
    return dir === 'incoming' ? meta.reverse_label : meta.forward_label
  })()

  const hasTarget =
    type === 'dept'
      ? !!selectedDept
      : type === 'entity'
        ? !!selectedEntity
        : !!selected
  const canSubmit = hasTarget && !!displayText.trim() && !submitting

  async function handleInsert() {
    if (!hasTarget || !displayText.trim()) return
    setSubmitting(true)
    try {
      // 유형별 제네릭 마크 속성(ReportLinkMark.addAttributes 키와 일치).
      //   보고서 : type+id+ws → /w/{ws}/reports/{id}
      //   협업부서 : type+id(=slug) → /w/{id}/reports
      //   관련정보 : type+id(=엔티티id)+axis(=축slug) → (v1) 이동 없음
      let attrs
      if (type === 'dept') {
        attrs = { mentionType: 'dept', mentionId: selectedDept }
      } else if (type === 'entity') {
        attrs = {
          mentionType: 'entity',
          mentionId: String(selectedEntity.id),
          mentionAxis: selectedEntity.type_slug ?? null,
        }
      } else {
        attrs = {
          mentionType: 'report',
          mentionId: String(selected.id),
          mentionWs: selected.workspace_slug ?? null,
        }
      }
      // 1) 인라인 링크 삽입 — popup.insert 는 @를 친 바로 그 에디터/행에
      //    바인딩돼 있어, 항상 올바른 위젯에 삽입된다. 내부에서 atCaret 으로
      //    '@query' 범위를 지우고 표시 문구에 reportLink 마크를 입힌다.
      popup.insert?.({
        text: displayText.trim(),
        atCaret: popup.atCaret,
        attrs,
      })
      // 2) 보고서 유형 + 체크 시 "연결된 보고서" 관계도 생성(기존 인프라 재사용).
      //    협업 부서는 보고서-보고서 관계가 아니므로 관계 생성 없음.
      if (type === 'report' && registerLink && kindDir && mention.addLink) {
        const [kind, direction] = kindDir.split('|')
        await mention.addLink({ toReportId: selected.id, kind, direction })
      }
      mention.close()
    } catch (err) {
      toast.error(err?.response?.data?.message || '삽입에 실패했습니다.')
      setSubmitting(false)
    }
  }

  return createPortal(
    <>
      {/* 클릭 아웃 닫기용 투명 백드롭 */}
      <div className="fixed inset-0 z-[60]" onMouseDown={() => mention.close()} />
      <div
        className="fixed z-[61] flex flex-col rounded-lg border bg-popover shadow-xl"
        style={{ left: effectivePos.left, top: effectivePos.top, width: PANEL_WIDTH, maxHeight }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* 헤더(드래그 핸들) — 고정 */}
        <div
          className="flex items-center justify-between gap-2 px-3 py-2 border-b cursor-move select-none shrink-0"
          onMouseDown={onHeaderMouseDown}
        >
          <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
            <GripHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
            멘션
          </div>
          <button
            type="button"
            onClick={() => mention.close()}
            onMouseDown={(e) => e.stopPropagation()}
            className="rounded p-0.5 text-muted-foreground hover:bg-muted"
            title="닫기"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* 본문 — 내부 스크롤 (작은 화면에서 잘리지 않게) */}
        <div className="min-h-0 flex-1 overflow-y-auto p-3 space-y-2.5">
          <div className="flex items-center gap-2">
            <label className="text-[10px] text-muted-foreground shrink-0 w-12">유형</label>
            {/* 세그먼트 토글 — 유형 전환 */}
            <div className="inline-flex rounded-md border bg-background p-0.5">
              {MENTION_TYPES.map((t) => {
                const active = type === t.value
                return (
                  <button
                    key={t.value}
                    type="button"
                    onClick={() => setType(t.value)}
                    aria-pressed={active}
                    className={cn(
                      'h-6 rounded px-2.5 text-xs transition-colors',
                      active
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-muted',
                    )}
                  >
                    {t.label}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-[10px] text-muted-foreground shrink-0 w-12">표시 문구</label>
            <Input
              value={displayText}
              onChange={(e) => {
                setDisplayText(e.target.value)
                setDisplayTouched(true)
              }}
              placeholder="본문에 보일 문구 (예: 지난 분기 보고서)"
              className="h-8 flex-1 text-xs"
            />
          </div>

          {type === 'dept' ? (
            <WorkspaceTreeSelect
              orgWorkspaces={orgWorkspaces}
              selected={deptSelectedSet}
              onToggle={handleToggleDept}
              autoExpandSlugs={selectedDept ? [selectedDept] : undefined}
              searchPlaceholder="부서 검색 (비우면 트리 보기)"
              maxHeightClass="max-h-[200px]"
            />
          ) : type === 'entity' ? (
            <EntityMentionPicker
              selected={selectedEntity}
              onSelect={handleSelectEntity}
            />
          ) : (
            <ReportPicker
              excludeReportId={mention.hostReportId}
              selected={selected}
              onSelect={handleSelect}
            />
          )}

          {type === 'report' && (
          <div className="border-t pt-2 space-y-2">
            <label className="flex items-center gap-2 text-[11px] text-foreground">
              <input
                type="checkbox"
                checked={registerLink}
                onChange={(e) => setRegisterLink(e.target.checked)}
              />
              연결된 보고서로도 등록
            </label>
            {registerLink && (
              <div className="flex items-center gap-2 pl-5">
                <span className="text-[10px] text-muted-foreground leading-tight">
                  상대 보고서는?
                </span>
                <select
                  value={kindDir}
                  onChange={(e) => setKindDir(e.target.value)}
                  className="h-7 rounded-md border bg-background px-2 text-xs"
                  disabled={!kinds || kinds.length === 0}
                >
                  {kinds?.flatMap((k) => [
                    <option key={`${k.key}|outgoing`} value={`${k.key}|outgoing`}>
                      {k.forward_label}
                    </option>,
                    <option key={`${k.key}|incoming`} value={`${k.key}|incoming`}>
                      {k.reverse_label}
                    </option>,
                  ])}
                </select>
                {kindLabel && (
                  <span className="text-[10px] text-muted-foreground">
                    → 상대는 이 보고서의{' '}
                    <span className="font-medium text-foreground">{kindLabel}</span>
                  </span>
                )}
              </div>
            )}
          </div>
          )}
        </div>

        {/* 푸터 — 고정 */}
        <div className="flex justify-end gap-2 px-3 py-2 border-t shrink-0">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => mention.close()}
          >
            취소
          </Button>
          <Button
            size="sm"
            className="h-7 text-xs"
            disabled={!canSubmit}
            onClick={handleInsert}
          >
            {submitting ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <>
                <Plus className="mr-1 h-3 w-3" />
                삽입
              </>
            )}
          </Button>
        </div>
      </div>
    </>,
    document.body,
  )
}
