import { useMemo, useState } from 'react'
import { Building2, Globe, Layers, Lock, User } from 'lucide-react'
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
 * @param items 분류할 배열(각 항목은 owner_workspace_slugs, created_by_user_id 보유)
 * @param currentUserId 현재 사용자 id — '개인' 판정용
 * @param getName (slug) => 표시이름 — 조직별 라벨용
 */
export function useScopeCategories(items, { currentUserId, getName } = {}) {
  // 분류 선택: { type: 'all' | 'mine' | 'global' | 'org', slug? }
  const [cat, setCat] = useState({ type: 'all' })

  const isMine = (it) =>
    Boolean(currentUserId) && it?.created_by_user_id === currentUserId
  const isGlobal = (it) => (it?.owner_workspace_slugs ?? []).length === 0

  const orgGroups = useMemo(() => {
    const m = new Map()
    for (const it of items ?? []) {
      for (const s of it?.owner_workspace_slugs ?? []) {
        // 개인(personal-*) 소유는 '조직별' 버킷으로 만들지 않는다 — 사용자마다
        // "(개인)" 버킷이 난립하는 것을 막는다. 비공개는 '개인 비공개' 그룹으로.
        if (isPersonalSlug(s)) continue
        m.set(s, (m.get(s) ?? 0) + 1)
      }
    }
    return [...m.entries()]
      .map(([slug, count]) => ({
        slug,
        count,
        name: getName ? getName(slug) : slug,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, getName])

  const list = items ?? []
  const counts = {
    all: list.length,
    mine: list.filter(isMine).length,
    global: list.filter(isGlobal).length,
    private: list.filter(isPrivateItem).length,
  }

  const filter = (it) => {
    if (cat.type === 'mine') return isMine(it)
    if (cat.type === 'global') return isGlobal(it)
    if (cat.type === 'private') return isPrivateItem(it)
    if (cat.type === 'org') return (it?.owner_workspace_slugs ?? []).includes(cat.slug)
    return true // 'all'
  }

  return { cat, setCat, counts, orgGroups, filter }
}

/** 분류 사이드바 — 전체 / 개인 / 전사 / 조직별(slug별). 세 소비처가 동일한
 *  세로 사이드바를 쓰도록 공용화. `mineLabel` 로 '개인' 라벨만 소비처별로 조정. */
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
      {orgGroups.length === 0 ? (
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
    </aside>
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
