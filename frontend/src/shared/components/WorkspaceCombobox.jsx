import * as React from 'react'
import { Check, ChevronDown, Building2 } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/shared/components/ui/command'
import { cn } from '@/shared/lib/utils'

/**
 * Searchable workspace picker. Uses Popover + cmdk Command so the user
 * can type to filter when there are many workspaces.
 *
 * Self-contained — takes the workspace list as a prop instead of pulling
 * from WorkspaceContext, so it works on the public signup page (where
 * the user isn't logged in yet).
 *
 * Each workspace is rendered with its full path (본부 / 팀) so the user
 * can disambiguate teams that share a name.
 *
 *   workspaces: [{ slug, name, parent_slug? }]
 *   value:      currently selected slug | ''
 *   onChange:   (slug) => void
 */
export function WorkspaceCombobox({
  workspaces,
  value,
  onChange,
  placeholder = '소속 부서 선택...',
  searchPlaceholder = '부서명으로 검색...',
  emptyMessage = '일치하는 부서가 없습니다.',
  disabled = false,
  id,
  className,
  compact = false,
  // When set, the popover gets a "(none)" item at the top that calls
  // onChange('') so the caller can model an "unset" state.
  allowNone = false,
  noneLabel = '선택 없음',
  // When true, the trigger button does NOT truncate the selected label —
  // its text expresses natural width and (combined with a w-fit parent
  // container) lets the parent grow to fully reveal long workspace
  // paths. Used by the WorkspaceEdit / WorkspaceCreate dialogs so they
  // size up to the combobox content rather than clipping the path.
  // Default false keeps the existing truncation behavior everywhere else.
  noTruncate = false,
  // When true, the selected label WRAPS to multiple lines instead of
  // truncating or expanding horizontally — the trigger button grows
  // TALLER. Use inside fixed-width dialogs where a deep workspace path
  // would otherwise overflow the modal horizontally (truncate hides it,
  // noTruncate spills it out). Takes precedence over noTruncate.
  wrap = false,
  // When true, 보관(archived) 부서는 선택지에서 감춘다 — 은퇴한 부서를 새로
  // 배정(가입·home 지정·이관 등)하지 못하게. 단 *이미 선택된* 값이 보관 부서면
  // 라벨이 깨지지 않도록 그 항목만은 남긴다.
  excludeArchived = false,
}) {
  const [open, setOpen] = React.useState(false)

  const selected = React.useMemo(
    () => workspaces.find((w) => w.slug === value) ?? null,
    [workspaces, value]
  )

  // Build tree-traversal order with depth so children appear under parents
  // and indent reflects hierarchy.
  const ordered = React.useMemo(() => buildOrderedTree(workspaces), [workspaces])

  // 드롭다운에 실제로 보여줄 선택지. excludeArchived 면 보관 부서를 뺀다(현재
  // 선택값은 유지). O1(부모는 활성 자식이 있으면 보관 불가) 덕분에 보관 노드를
  // 빼도 활성 부서가 고아가 되지 않는다.
  const options = React.useMemo(
    () =>
      excludeArchived
        ? ordered.filter((w) => w.status !== 'archived' || w.slug === value)
        : ordered,
    [ordered, excludeArchived, value]
  )

  // Map slug → full path string ("개발본부 / 플랫폼팀") for the trigger label
  // and search matching.
  const pathBySlug = React.useMemo(() => {
    const bySlug = new Map(workspaces.map((w) => [w.slug, w]))
    function getPath(slug) {
      const segments = []
      let cur = slug
      const seen = new Set()
      while (cur && !seen.has(cur)) {
        seen.add(cur)
        const node = bySlug.get(cur)
        if (!node) break
        segments.unshift(node.name)
        cur = node.parent_slug
      }
      return segments.join(' / ')
    }
    const out = new Map()
    for (const w of workspaces) out.set(w.slug, getPath(w.slug))
    return out
  }, [workspaces])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          // Tooltip surfaces the full path when truncation hides it. Cheap
          // to set even in noTruncate mode (just no-op there).
          title={
            selected
              ? pathBySlug.get(selected.slug) || selected.name
              : undefined
          }
          className={cn(
            'justify-between font-normal',
            compact ? 'h-9 text-sm' : 'w-full',
            // wrap: 버튼이 세로로 자라도록 고정 높이 해제.
            wrap && 'h-auto min-h-9 py-1.5',
            className,
          )}
        >
          {selected ? (
            // Two layout modes:
            //   default (truncate)  — `flex-1 min-w-0` on the content
            //     wrapper bounds it so `truncate` on the text span can
            //     clip overflow with ellipsis. Keeps the ChevronDown
            //     inside the button regardless of label length.
            //   noTruncate          — drops min-w-0/flex-1/truncate so
            //     the text expresses natural width. The button itself
            //     widens accordingly (and pushes a w-fit parent),
            //     revealing the full workspace path.
            <span
              className={cn(
                'flex gap-2',
                wrap ? 'items-start flex-1 min-w-0' : 'items-center',
                !wrap && !noTruncate ? 'flex-1 min-w-0' : '',
              )}
            >
              <Building2 className="h-4 w-4 shrink-0 text-muted-foreground mt-0.5" />
              <span
                className={cn(
                  'text-left',
                  wrap
                    ? 'whitespace-normal break-words min-w-0 flex-1'
                    : noTruncate
                      ? 'whitespace-nowrap'
                      : 'truncate min-w-0 flex-1',
                )}
              >
                <span>{selected.name}</span>
                {!compact && pathBySlug.get(selected.slug) !== selected.name && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    {pathBySlug.get(selected.slug)}
                  </span>
                )}
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground truncate">{placeholder}</span>
          )}
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="p-0"
        align="start"
        style={{ width: 'var(--radix-popover-trigger-width)' }}
      >
        <Command
          // We compute our own filter (slug + name + path) so substring
          // matches across the path work — cmdk's default filter only sees
          // the value string we pass per item.
          filter={(value, search) => {
            return value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0
          }}
        >
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList className="max-h-[280px]">
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            <CommandGroup>
              {allowNone && (
                <CommandItem
                  value={`__none ${noneLabel}`}
                  onSelect={() => {
                    onChange('')
                    setOpen(false)
                  }}
                  className="cursor-pointer text-muted-foreground"
                >
                  <span className="flex-1">{noneLabel}</span>
                  {!value && <Check className="h-4 w-4 text-primary shrink-0" />}
                </CommandItem>
              )}
              {options.map((opt) => {
                const path = pathBySlug.get(opt.slug) ?? opt.name
                const searchValue = `${opt.slug} ${opt.name} ${path}`
                return (
                  <CommandItem
                    key={opt.slug}
                    value={searchValue}
                    onSelect={() => {
                      onChange(opt.slug)
                      setOpen(false)
                    }}
                    className="cursor-pointer"
                  >
                    <span
                      className="flex items-center gap-1 min-w-0 flex-1"
                      style={{ paddingLeft: opt.depth * 12 }}
                    >
                      <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <div className="flex flex-col min-w-0">
                        <span className="truncate text-sm">{opt.name}</span>
                        {opt.depth > 0 && (
                          <span className="truncate text-[10px] text-muted-foreground">
                            {path}
                          </span>
                        )}
                      </div>
                    </span>
                    {value === opt.slug && (
                      <Check className="h-4 w-4 text-primary shrink-0" />
                    )}
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function buildOrderedTree(list) {
  const byParent = new Map()
  for (const w of list) {
    const arr = byParent.get(w.parent_slug ?? null) ?? []
    arr.push(w)
    byParent.set(w.parent_slug ?? null, arr)
  }
  const out = []
  function walk(parentSlug, depth) {
    const children = byParent.get(parentSlug ?? null) ?? []
    for (const c of children) {
      out.push({ slug: c.slug, name: c.name, depth })
      walk(c.slug, depth + 1)
    }
  }
  walk(null, 0)
  return out
}
