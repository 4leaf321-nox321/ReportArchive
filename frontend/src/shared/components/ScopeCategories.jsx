import { Fragment, useMemo, useState } from 'react'
import {
  Archive,
  Building2,
  ChevronDown,
  ChevronRight,
  Globe,
  Layers,
  Lock,
  Search,
  User,
} from 'lucide-react'
import { cn } from '@/shared/lib/utils'

// 개인(비공개) 항목 — 소유가 personal-* 뿐(백엔드 is_private_template 와 동일 정의).
const isPersonalSlug = (s) => String(s).startsWith('personal-')
const isPrivateItem = (it) => {
  const owners = it?.owner_workspace_slugs ?? []
  return owners.length > 0 && owners.every(isPersonalSlug)
}

/**
 * 가시성 스코프 + 소유자 기준 분류 — 보고서 템플릿·종합보고 양식처럼
 * `owner_workspace_slugs`(전사/조직별)와 `created_by_user_id`(개인)를 가진
 * 목록을 전사/조직별/개인으로 분류하는 공용 로직. 템플릿 관리의 두 탭과
 * 종합보고 "시작 양식 선택" 모달이 같은 방식으로 분류하도록 한 곳에 모았다.
 *
 * 한 항목이 여러 분류에 동시에 들 수 있다(예: 내가 만든 전사 항목 →
 * 개인·전사 양쪽). 그래서 분류는 배타적 버킷이 아니라 "현재 보기" 필터다.
 *
 * `orgWorkspaces`(전체 org 워크스페이스, parent_slug 보유)를 주면 "조직별"을
 * 평면 리스트 대신 **계층 트리 + 하위포함(rollup)** 로 다룰 수 있는 `orgTree`
 * 와 `rollup` 상태를 함께 돌려준다. 안 주면 종전대로 `orgGroups`(평면)만.
 *
 * @param items 분류할 배열(각 항목은 owner_workspace_slugs, created_by_user_id 보유)
 * @param currentUserId 현재 사용자 id — '개인' 판정용
 * @param getName (slug) => 표시이름 — 조직별 라벨용
 * @param orgWorkspaces (선택) 전체 org 워크스페이스 [{slug,name,parent_slug}]
 */
export function useScopeCategories(items, { currentUserId, getName, orgWorkspaces } = {}) {
  // 분류 선택: { type: 'all' | 'mine' | 'global' | 'org', slug? }
  const [cat, setCat] = useState({ type: 'all' })
  // 조직별 트리에서 부모 선택 시 하위 부서까지 포함할지(rollup). 기본 ON.
  const [rollup, setRollup] = useState(true)

  const isMine = (it) =>
    Boolean(currentUserId) && it?.created_by_user_id === currentUserId
  const isGlobal = (it) => (it?.owner_workspace_slugs ?? []).length === 0
  // 보관(아카이브)된 항목 — 템플릿만 archived_at 을 가진다. 다른 소비처(프리셋
  // 등)는 이 필드가 없어 항상 false → 보관 분류가 자동으로 안 뜬다.
  const isArchived = (it) => Boolean(it?.archived_at)

  // 조직 slug → 그 조직이 "직접" 소유한(비보관) 항목 수.
  const ownCounts = useMemo(() => {
    const m = new Map()
    for (const it of items ?? []) {
      if (isArchived(it)) continue
      for (const s of it?.owner_workspace_slugs ?? []) {
        if (isPersonalSlug(s)) continue
        m.set(s, (m.get(s) ?? 0) + 1)
      }
    }
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items])

  const orgGroups = useMemo(() => {
    return [...ownCounts.entries()]
      .map(([slug, count]) => ({
        slug,
        count,
        name: getName ? getName(slug) : slug,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownCounts, getName])

  // 계층 트리(가지치기 + rollup 카운트) + 서브트리 slug 집합(rollup 필터용).
  // orgWorkspaces 가 없으면 undefined → 소비처는 평면 orgGroups 로 폴백.
  const { orgTree, descMap } = useMemo(() => {
    if (!orgWorkspaces || orgWorkspaces.length === 0) {
      return { orgTree: undefined, descMap: null }
    }
    const slugSet = new Set(orgWorkspaces.map((w) => w.slug))
    const byParent = new Map()
    for (const w of orgWorkspaces) {
      // 부모가 org 집합 밖이면(예: 부모가 TF·가상) 루트로 취급.
      const p = slugSet.has(w.parent_slug) ? w.parent_slug : null
      const arr = byParent.get(p) ?? []
      arr.push(w)
      byParent.set(p, arr)
    }
    // 서브트리(self+자손) slug 집합 — rollup 필터에서 owner 교집합 판정용.
    const dmap = new Map()
    const collect = (slug) => {
      const set = new Set([slug])
      for (const c of byParent.get(slug) ?? []) {
        for (const s of collect(c.slug)) set.add(s)
      }
      dmap.set(slug, set)
      return set
    }
    for (const root of byParent.get(null) ?? []) collect(root.slug)

    // 비어 있는 가지(자신·자손 모두 템플릿 0개)는 잘라낸다.
    const build = (node, depth) => {
      const children = (byParent.get(node.slug) ?? [])
        .map((c) => build(c, depth + 1))
        .filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name))
      const ownCount = ownCounts.get(node.slug) ?? 0
      const rollupCount = ownCount + children.reduce((s, c) => s + c.rollupCount, 0)
      if (rollupCount === 0) return null
      return {
        slug: node.slug,
        name: node.name ?? (getName ? getName(node.slug) : node.slug),
        depth,
        ownCount,
        rollupCount,
        children,
      }
    }
    const tree = (byParent.get(null) ?? [])
      .map((r) => build(r, 0))
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name))
    return { orgTree: tree, descMap: dmap }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownCounts, orgWorkspaces, getName])

  const list = items ?? []
  // 보관은 전체/전사/개인/조직별 어디에도 안 들어가고 '보관' 분류로만 모인다.
  const live = list.filter((it) => !isArchived(it))
  const counts = {
    all: live.length,
    mine: live.filter(isMine).length,
    global: live.filter(isGlobal).length,
    private: live.filter(isPrivateItem).length,
    archived: list.filter(isArchived).length,
  }

  const filter = (it) => {
    if (cat.type === 'archived') return isArchived(it)
    if (isArchived(it)) return false // 보관은 다른 분류에서 전부 제외
    if (cat.type === 'mine') return isMine(it)
    if (cat.type === 'global') return isGlobal(it)
    if (cat.type === 'private') return isPrivateItem(it)
    if (cat.type === 'org') {
      const owners = it?.owner_workspace_slugs ?? []
      // 하위포함(rollup)이면 선택 조직의 서브트리 중 하나라도 소유하면 포함.
      if (rollup && descMap) {
        const sub = descMap.get(cat.slug)
        return sub ? owners.some((s) => sub.has(s)) : owners.includes(cat.slug)
      }
      return owners.includes(cat.slug)
    }
    return true // 'all'
  }

  return { cat, setCat, counts, orgGroups, orgTree, rollup, setRollup, filter }
}

/** 분류 사이드바 — 전체 / 개인 / 전사 / 조직별(slug별). 세 소비처가 동일한
 *  세로 사이드바를 쓰도록 공용화. `mineLabel` 로 '개인' 라벨만 소비처별로 조정.
 *
 *  `orgTree` 를 주면 "조직별"을 계층 트리(검색 + 하위포함 토글)로 렌더한다.
 *  안 주면 종전 평면 `orgGroups` 리스트(하위호환). */
export function ScopeCategorySidebar({
  counts,
  orgGroups,
  cat,
  onChange,
  mineLabel = '개인',
  emptyOrgText = '조직 항목이 없습니다.',
  // 모든 사용자의 개인(비공개) 항목을 한 칸으로 묶어 보여준다. 시스템 관리자
  // 전용(일반 사용자는 자기 것만이라 '개인' 탭과 중복 → 숨김).
  showPrivate = false,
  // 계층 트리 모드 — orgTree/rollup 상태(useScopeCategories 가 돌려줌).
  orgTree,
  orgRollup,
  onOrgRollupChange,
  className,
}) {
  return (
    <aside className={cn('space-y-0.5', className)}>
      <CategoryButton
        icon={Layers}
        label="전체"
        count={counts.all}
        active={cat.type === 'all'}
        onClick={() => onChange({ type: 'all' })}
      />
      <CategoryButton
        icon={User}
        label={mineLabel}
        count={counts.mine}
        active={cat.type === 'mine'}
        onClick={() => onChange({ type: 'mine' })}
      />
      <CategoryButton
        icon={Globe}
        label="전사"
        count={counts.global}
        active={cat.type === 'global'}
        onClick={() => onChange({ type: 'global' })}
      />
      {showPrivate && (
        <CategoryButton
          icon={Lock}
          label="개인 비공개"
          count={counts.private}
          active={cat.type === 'private'}
          onClick={() => onChange({ type: 'private' })}
        />
      )}
      <div className="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        조직별
      </div>
      {orgTree ? (
        <OrgScopeTree
          tree={orgTree}
          cat={cat}
          onChange={onChange}
          rollup={orgRollup ?? true}
          onRollupChange={onOrgRollupChange}
          emptyOrgText={emptyOrgText}
        />
      ) : orgGroups.length === 0 ? (
        <p className="px-2 py-1 text-[11px] text-muted-foreground">{emptyOrgText}</p>
      ) : (
        orgGroups.map((o) => (
          <CategoryButton
            key={o.slug}
            icon={Building2}
            label={o.name}
            count={o.count}
            active={cat.type === 'org' && cat.slug === o.slug}
            onClick={() => onChange({ type: 'org', slug: o.slug })}
          />
        ))
      )}
      {/* 보관(사용 안 함) — 보관된 항목이 있을 때만 노출. 보관은 위의 어떤
          분류에도 안 들어가고 여기로만 모인다. 항목 없는 소비처(프리셋 등)는
          counts.archived=0 이라 자동으로 숨는다. */}
      {counts.archived > 0 && (
        <>
          <div className="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            사용 안 함
          </div>
          <CategoryButton
            icon={Archive}
            label="보관"
            count={counts.archived}
            active={cat.type === 'archived'}
            onClick={() => onChange({ type: 'archived' })}
          />
        </>
      )}
    </aside>
  )
}

/** 검색 일치(이름) 또는 일치하는 자손을 가진 노드만 남기는 가지치기. */
function filterTreeByName(nodes, q) {
  if (!q) return nodes
  const out = []
  for (const n of nodes) {
    const kids = filterTreeByName(n.children ?? [], q)
    if (n.name.toLowerCase().includes(q) || kids.length) {
      out.push({ ...n, children: kids })
    }
  }
  return out
}

/** "조직별" 계층 트리 — 접기/펼치기 + 검색 + 하위포함 토글. 빈 가지는
 *  useScopeCategories 단계에서 이미 잘려 들어온다(템플릿 있는 가지만). */
function OrgScopeTree({ tree, cat, onChange, rollup, onRollupChange, emptyOrgText }) {
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState(() => new Set())
  const q = query.trim().toLowerCase()
  const searching = q.length > 0
  const shown = useMemo(() => filterTreeByName(tree, q), [tree, q])

  const toggleCollapse = (slug) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(slug)) next.delete(slug)
      else next.add(slug)
      return next
    })

  if (tree.length === 0) {
    return <p className="px-2 py-1 text-[11px] text-muted-foreground">{emptyOrgText}</p>
  }

  const renderNodes = (nodes) =>
    nodes.map((n) => {
      const hasKids = (n.children?.length ?? 0) > 0
      // 검색 중엔 전부 펼친다(일치 결과를 가리지 않도록).
      const isCollapsed = !searching && collapsed.has(n.slug)
      // 하위포함이면 모두 선택 가능, 아니면 직접 소유분이 있어야 선택 가능.
      const selectable = rollup || n.ownCount > 0
      const count = rollup ? n.rollupCount : n.ownCount
      const active = cat.type === 'org' && cat.slug === n.slug
      return (
        <Fragment key={n.slug}>
          <div
            className={cn(
              'flex items-center rounded-md text-sm transition-colors',
              active ? 'bg-primary/10 font-medium text-primary' : 'hover:bg-muted',
            )}
            style={{ paddingLeft: n.depth * 12 }}
          >
            {hasKids ? (
              <button
                type="button"
                onClick={() => toggleCollapse(n.slug)}
                className="flex h-6 w-5 shrink-0 items-center justify-center text-muted-foreground"
                title={isCollapsed ? '펼치기' : '접기'}
              >
                {isCollapsed ? (
                  <ChevronRight className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
              </button>
            ) : (
              <span className="w-5 shrink-0" />
            )}
            <button
              type="button"
              onClick={() =>
                selectable ? onChange({ type: 'org', slug: n.slug }) : toggleCollapse(n.slug)
              }
              className={cn(
                'flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pr-2 text-left',
                !selectable && 'text-muted-foreground',
              )}
              title={n.name}
            >
              <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{n.name}</span>
              {count > 0 && (
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {count}
                </span>
              )}
            </button>
          </div>
          {hasKids && !isCollapsed && renderNodes(n.children)}
        </Fragment>
      )
    })

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 px-1">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="조직 검색"
            className="h-7 w-full rounded border bg-background pl-6 pr-2 text-xs"
          />
        </div>
        <label
          className="flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-muted-foreground"
          title="부모 조직을 고르면 하위 부서 템플릿까지 함께 봅니다"
        >
          <input
            type="checkbox"
            checked={rollup}
            onChange={(e) => onRollupChange?.(e.target.checked)}
            className="h-3 w-3"
          />
          하위포함
        </label>
      </div>
      {searching && shown.length === 0 ? (
        <p className="px-2 py-1 text-[11px] text-muted-foreground">검색 결과 없음</p>
      ) : (
        <div>{renderNodes(shown)}</div>
      )}
    </div>
  )
}

/** 사이드바 한 줄 — 아이콘 + 라벨 + 건수. */
function CategoryButton({ icon: Icon, label, count, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
        active ? 'bg-primary/10 font-medium text-primary' : 'hover:bg-muted',
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
        {count}
      </span>
    </button>
  )
}
