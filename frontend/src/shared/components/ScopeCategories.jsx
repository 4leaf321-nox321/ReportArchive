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
  Star,
  User,
} from 'lucide-react'
import { cn } from '@/shared/lib/utils'
import { useOrgScopeFavorites } from '@/shared/scope/useOrgScopeFavorites'

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
        // 트리 파생 색(compute_workspace_colors) — 형제끼리 다른 색이라 부서
        // 식별/형제 구분용 점으로 쓴다(깊이 표현 아님).
        color: node.color,
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

/** 트리를 slug → { node, pathSlugs, ancestorNames } 로 평탄화(드릴다운/검색/
 *  즐겨찾기가 공통으로 쓴다). pathSlugs 는 루트부터 자신까지의 slug 체인. */
function indexTree(nodes) {
  const map = new Map()
  const walk = (arr, ancestors) => {
    for (const n of arr) {
      const chain = [...ancestors, n]
      map.set(n.slug, {
        node: n,
        pathSlugs: chain.map((c) => c.slug),
        ancestorNames: ancestors.map((a) => a.name),
      })
      if (n.children?.length) walk(n.children, chain)
    }
  }
  walk(nodes ?? [], [])
  return map
}

/** "조직별" 계층 트리 — 접기/펼치기(아코디언). 깊이가 가로폭을 잠식해 이름이
 *  잘리던 문제를, 깊이 표현을 들여쓰기에서 **색 점 + 폰트 농도**로 이양하고
 *  들여쓰기는 **작게(8px) + 상한(5단계)** 로만 남겨 해소했다. 이름은 말줄임 대신
 *  **2줄 줄바꿈**(line-clamp-2)이라 어떤 깊이에서도 안 잘린다. 색은 트리 파생
 *  (compute_workspace_colors)이라 형제 부서를 색으로 구분해준다. 상단엔 계정별
 *  즐겨찾기(자주 쓰는 부서 바로가기), 검색 시엔 전체 트리를 평면으로 훑어 경로와
 *  함께 보여준다. 빈 가지는 useScopeCategories 단계에서 이미 잘려 들어온다. */
function OrgScopeTree({ tree, cat, onChange, rollup, onRollupChange, emptyOrgText }) {
  const { favorites, toggleFavorite, isFavorite } = useOrgScopeFavorites()
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState(() => new Set())
  const q = query.trim().toLowerCase()
  const searching = q.length > 0

  const index = useMemo(() => indexTree(tree), [tree])
  const activeSlug = cat.type === 'org' ? cat.slug : null

  const toggleCollapse = (slug) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(slug)) next.delete(slug)
      else next.add(slug)
      return next
    })

  // 즐겨찾기/검색 결과에서 고른 부서를 필터로 선택 + 트리에서 보이도록 조상 펼침.
  const selectAndReveal = (slug) => {
    const info = index.get(slug)
    if (!info) return
    const selectable = rollup || info.node.ownCount > 0
    if (selectable) onChange({ type: 'org', slug })
    setQuery('')
    const ancestors = info.pathSlugs.slice(0, -1)
    if (ancestors.length) {
      setCollapsed((prev) => {
        const next = new Set(prev)
        ancestors.forEach((s) => next.delete(s))
        return next
      })
    }
  }

  const results = useMemo(() => {
    if (!searching) return []
    return [...index.values()]
      .filter((info) => info.node.name.toLowerCase().includes(q))
      .sort((a, b) => a.node.name.localeCompare(b.node.name))
  }, [index, q, searching])

  const favoriteInfos = useMemo(
    () => favorites.map((slug) => index.get(slug)).filter(Boolean),
    [favorites, index],
  )

  if (tree.length === 0) {
    return <p className="px-2 py-1 text-[11px] text-muted-foreground">{emptyOrgText}</p>
  }

  // 즐겨찾기 별 토글 버튼(행 오른쪽) — hover 시 노출, 즐겨찾기면 상시 노랑.
  const favButton = (slug) => {
    const fav = isFavorite(slug)
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          toggleFavorite(slug)
        }}
        className={cn(
          'flex h-7 w-4 shrink-0 items-center justify-center transition-opacity',
          fav
            ? 'text-amber-500'
            : 'text-muted-foreground/40 opacity-0 group-hover:opacity-100 focus:opacity-100',
        )}
        title={fav ? '즐겨찾기 해제' : '즐겨찾기에 추가'}
      >
        <Star className={cn('h-3 w-3', fav && 'fill-current')} />
      </button>
    )
  }

  // 색 점 — 트리 파생 색(형제 구분). 깊이 표현이 아니라 부서 식별용.
  const colorDot = (color) => (
    <span
      className="mt-1 h-2 w-2 shrink-0 rounded-full"
      style={{ backgroundColor: color || '#64748b' }}
    />
  )

  // 아코디언 재귀 렌더 — 캡 들여쓰기(6px×min(depth,5)) + 색 점 + 폰트 농도 + 줄바꿈.
  const renderNodes = (nodes) =>
    nodes.map((n) => {
      const hasKids = (n.children?.length ?? 0) > 0
      const isCollapsed = collapsed.has(n.slug)
      const selectable = rollup || n.ownCount > 0
      const count = rollup ? n.rollupCount : n.ownCount
      const active = activeSlug === n.slug
      return (
        <Fragment key={n.slug}>
          <div
            className={cn(
              'group flex items-start rounded-md text-sm transition-colors',
              active ? 'bg-primary/10 text-primary' : 'hover:bg-muted',
            )}
            style={{ paddingLeft: Math.min(n.depth, 5) * 6 }}
          >
            {hasKids ? (
              <button
                type="button"
                onClick={() => toggleCollapse(n.slug)}
                className="flex h-7 w-4 shrink-0 items-center justify-center text-muted-foreground"
                title={isCollapsed ? '펼치기' : '접기'}
              >
                {isCollapsed ? (
                  <ChevronRight className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
              </button>
            ) : (
              <span className="w-4 shrink-0" />
            )}
            <button
              type="button"
              onClick={() =>
                selectable ? onChange({ type: 'org', slug: n.slug }) : toggleCollapse(n.slug)
              }
              className={cn(
                'flex min-w-0 flex-1 items-start gap-1.5 py-1 pr-1 text-left',
                !selectable && 'text-muted-foreground',
              )}
              title={n.name}
            >
              {colorDot(n.color)}
              <span
                className={cn(
                  'line-clamp-2 min-w-0 flex-1 break-words leading-snug',
                  n.depth === 0 || active ? 'font-medium' : 'font-normal',
                )}
              >
                {n.name}
              </span>
              {count > 0 && (
                <span className="mt-0.5 shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {count}
                </span>
              )}
            </button>
            {favButton(n.slug)}
          </div>
          {hasKids && !isCollapsed && renderNodes(n.children)}
        </Fragment>
      )
    })

  // 평면 행(즐겨찾기·검색) — 색 점 + 이름 + 경로(muted) + 건수 + 별. 들여쓰기 없음.
  const renderFlatRow = (info) => {
    const n = info.node
    const selectable = rollup || n.ownCount > 0
    const count = rollup ? n.rollupCount : n.ownCount
    const active = activeSlug === n.slug
    const pathLabel = info.ancestorNames.join(' › ')
    return (
      <div
        key={n.slug}
        className={cn(
          'group flex items-start rounded-md text-sm transition-colors',
          active ? 'bg-primary/10 text-primary' : 'hover:bg-muted',
        )}
      >
        <button
          type="button"
          onClick={() => selectAndReveal(n.slug)}
          className={cn(
            'flex min-w-0 flex-1 items-start gap-1.5 py-1 pl-1 pr-1 text-left',
            !selectable && 'text-muted-foreground',
          )}
          title={pathLabel ? `${pathLabel} › ${n.name}` : n.name}
        >
          {colorDot(n.color)}
          <span className="min-w-0 flex-1 leading-snug">
            <span className={cn('break-words', active && 'font-medium')}>{n.name}</span>
            {pathLabel && (
              <span className="ml-1 text-[10px] text-muted-foreground">{pathLabel}</span>
            )}
          </span>
          {count > 0 && (
            <span className="mt-0.5 shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {count}
            </span>
          )}
        </button>
        {favButton(n.slug)}
      </div>
    )
  }

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

      {/* 즐겨찾기 — 자주 쓰는 부서 바로가기(계정별). 검색 중엔 숨김. */}
      {!searching && favoriteInfos.length > 0 && (
        <div className="space-y-0.5">
          <div className="px-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
            즐겨찾기
          </div>
          {favoriteInfos.map(renderFlatRow)}
          <div className="mx-1 border-t pt-0.5" />
        </div>
      )}

      {searching ? (
        results.length === 0 ? (
          <p className="px-2 py-1 text-[11px] text-muted-foreground">검색 결과 없음</p>
        ) : (
          <div className="space-y-0.5">{results.map(renderFlatRow)}</div>
        )
      ) : (
        <div className="space-y-0.5">{renderNodes(tree)}</div>
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
