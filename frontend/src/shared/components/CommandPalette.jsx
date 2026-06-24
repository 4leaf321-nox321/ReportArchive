import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Building2,
  FileText,
  FileCode2,
  LayoutDashboard,
  Plus,
  Search,
  Sun,
  Moon,
} from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/shared/components/ui/dialog'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/shared/components/ui/command'
import { useWorkspace } from '@/shared/workspace/WorkspaceContext'
import { useTheme } from '@/shared/theme/ThemeContext'
import { useAsync } from '@/shared/hooks/useAsync'
import { listReports } from '@/modules/reports/api'
import { listTemplates } from '@/shared/api/templates'

const PaletteContext = React.createContext({ open: () => {}, close: () => {} })

export function useCommandPalette() {
  return React.useContext(PaletteContext)
}

/**
 * Global command palette. Mounted once at app root. Open via ⌘K / Ctrl+K
 * or by calling useCommandPalette().open().
 */
export function CommandPaletteProvider({ children }) {
  const [open, setOpen] = React.useState(false)
  const value = React.useMemo(
    () => ({ open: () => setOpen(true), close: () => setOpen(false) }),
    []
  )

  React.useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((prev) => !prev)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <PaletteContext.Provider value={value}>
      {children}
      <Palette open={open} onOpenChange={setOpen} />
    </PaletteContext.Provider>
  )
}

function Palette({ open, onOpenChange }) {
  const navigate = useNavigate()
  const { slug, switchWorkspace, all, buildTree, flattenTree, getPath } = useWorkspace()
  const { theme, toggleTheme } = useTheme()

  // Lazy load reports + templates only when palette is opened so we don't burn
  // a request on every page mount. Re-fetched each open to stay fresh.
  const { data: reports } = useAsync(
    () => (open ? listReports() : Promise.resolve([])),
    [open]
  )
  // 템플릿으로 새 보고서 시작(아래) — 작성용이라 소유 부서 무관 전체를 띄운다.
  const { data: templates } = useAsync(
    () => (open ? listTemplates({ scope: 'all' }) : Promise.resolve([])),
    [open]
  )

  // 입력값을 제어해 서버 본문검색에 쓴다. cmdk 의 정적 그룹 필터도 이 값을 본다.
  const [query, setQuery] = React.useState('')
  const [debounced, setDebounced] = React.useState('')
  React.useEffect(() => {
    if (!open) setQuery('')
  }, [open])
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250)
    return () => clearTimeout(t)
  }, [query])

  function go(to) {
    navigate(to)
    onOpenChange(false)
  }

  // Command palette switcher hides personals (they're per-user and live
  // in the dedicated "내 공간" section of the sidebar selector instead).
  const tree = React.useMemo(
    () => buildTree({ includeVirtual: false, includePersonal: false }),
    [buildTree]
  )
  const flatWorkspaces = React.useMemo(
    () => [...flattenTree(tree), ...all.filter((w) => w.virtual)],
    [tree, flattenTree, all]
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl p-0 gap-0 overflow-hidden">
        <DialogTitle className="sr-only">명령 팔레트</DialogTitle>
        <Command>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="검색하거나 명령을 입력하세요... (제목·본문)"
            autoFocus
          />
          <CommandList>
            <CommandEmpty>일치하는 결과가 없습니다.</CommandEmpty>

            {/* 본문 전문검색 진입 — 검색어가 있으면 최상단에 "전체 결과 보기".
                cmdk 가 첫 항목을 자동 하이라이트하므로 Enter 로 바로 검색
                페이지로 간다. value 에 query 를 박아 필터에 안 걸리게. */}
            {slug && debounced.length >= 2 && (
              <>
                <CommandGroup heading="검색">
                  <CommandItem
                    value={`검색 ${query} search 전체 결과`}
                    onSelect={() =>
                      go(`/w/${slug}/search?q=${encodeURIComponent(debounced)}`)
                    }
                  >
                    <Search className="h-4 w-4" />
                    <span>“{debounced}” 검색 결과 전체 보기</span>
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      제목·본문
                    </span>
                  </CommandItem>
                </CommandGroup>
                <CommandSeparator />
              </>
            )}

            <CommandGroup heading="액션">
              {slug && (
                <CommandItem
                  value="새 보고서 작성 new report create"
                  onSelect={() => go(`/w/${slug}/reports/new`)}
                >
                  <Plus className="h-4 w-4" />
                  <span>새 보고서 작성</span>
                  <span className="ml-auto text-[10px] text-muted-foreground">현재 부서</span>
                </CommandItem>
              )}
              <CommandItem
                value={`테마 ${theme === 'dark' ? '라이트' : '다크'} 모드`}
                onSelect={() => {
                  toggleTheme()
                  onOpenChange(false)
                }}
              >
                {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                <span>{theme === 'dark' ? '라이트 모드' : '다크 모드'}로 전환</span>
              </CommandItem>
            </CommandGroup>
            <CommandSeparator />

            <CommandGroup heading="이동">
              {slug && (
                <>
                  <CommandItem value="홈 home" onSelect={() => go(`/w/${slug}`)}>
                    <LayoutDashboard className="h-4 w-4" />
                    부서 홈
                  </CommandItem>
                  <CommandItem value="보고서 목록 reports" onSelect={() => go(`/w/${slug}/reports`)}>
                    <FileText className="h-4 w-4" />
                    보고서 목록
                  </CommandItem>
                  <CommandItem value="대시보드" onSelect={() => go(`/w/${slug}/dashboard`)}>
                    <LayoutDashboard className="h-4 w-4" />
                    대시보드
                  </CommandItem>
                </>
              )}
              <CommandItem value="템플릿 templates" onSelect={() => go('/templates')}>
                <FileCode2 className="h-4 w-4" />
                템플릿 관리
              </CommandItem>
            </CommandGroup>
            <CommandSeparator />

            <CommandGroup heading="부서 전환">
              {flatWorkspaces.map((w) => {
                const path = getPath(w.slug).map((p) => p.name).slice(0, -1).join(' / ')
                return (
                  <CommandItem
                    key={w.slug}
                    value={`workspace ${w.slug} ${w.name} ${path}`}
                    onSelect={() => {
                      switchWorkspace(w.slug)
                      onOpenChange(false)
                    }}
                  >
                    <Building2 className="h-4 w-4" />
                    <div className="flex flex-col min-w-0">
                      <span className="truncate">{w.name}</span>
                      {path && (
                        <span className="truncate text-[10px] text-muted-foreground">{path}</span>
                      )}
                    </div>
                  </CommandItem>
                )
              })}
            </CommandGroup>
            <CommandSeparator />

            <CommandGroup heading="보고서">
              {(reports ?? []).slice(0, 30).map((r) => (
                <CommandItem
                  key={r.id}
                  value={`report ${r.title} ${r.template_id}`}
                  onSelect={() => go(`/w/${r.workspace_slug}/reports/${r.id}`)}
                >
                  <FileText className="h-4 w-4" />
                  <div className="flex flex-col min-w-0">
                    <span className="truncate">{r.title}</span>
                    <span className="truncate text-[10px] text-muted-foreground">
                      {r.template_id} · {r.workspace_slug}
                    </span>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />

            <CommandGroup heading="템플릿">
              {(templates ?? []).map((t) => (
                <CommandItem
                  key={`${t.template_id}-${t.version}`}
                  value={`template ${t.name} ${t.description}`}
                  onSelect={() =>
                    slug && go(`/w/${slug}/reports/new/${t.template_id}/${t.version}`)
                  }
                >
                  <FileCode2 className="h-4 w-4" />
                  <div className="flex flex-col min-w-0">
                    <span className="truncate">{t.name}</span>
                    <span className="truncate text-[10px] text-muted-foreground">
                      {t.description}
                    </span>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
