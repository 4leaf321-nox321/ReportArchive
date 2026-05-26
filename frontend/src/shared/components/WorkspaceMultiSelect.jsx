import { useState } from 'react'
import { Check, ChevronsUpDown, Eraser, Globe, User, X } from 'lucide-react'
import { Badge } from '@/shared/components/ui/badge'
import { Button } from '@/shared/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/shared/components/ui/command'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/shared/components/ui/popover'
import { cn } from '@/shared/lib/utils'

/**
 * Searchable multi-select for workspace slugs. The selected list is
 * passed in as `value: string[] | null` where:
 *   - null  → 전사 (글로벌) — visible to everyone
 *   - []    → also treated as global by the backend, but the UI uses null
 *   - [...] → scoped to those workspaces' trees
 *
 * Picking the "전사" item clears any specific selections; picking any
 * specific workspace flips out of global mode.
 *
 * `myUserId` (optional) — when supplied, the caller's own personal
 * workspace is offered as a "나 자신" pseudo-option. Other users'
 * personal workspaces are always hidden (sharing a template to "박세현
 * 의 개인 공간" is nonsensical — personal spaces are 1-user areas).
 */
export function WorkspaceMultiSelect({
  value,
  onChange,
  workspaces,
  disabled,
  myUserId,
}) {
  const [open, setOpen] = useState(false)
  const selected = Array.isArray(value) ? value : []
  const isGlobal = !selected.length
  // Org workspaces only — virtuals are aggregate views (not assignable),
  // and personals belong to individuals (not pickable by name).
  const options = (workspaces ?? []).filter(
    (w) => !w.virtual && w.kind !== 'personal',
  )
  // The current user's own personal workspace gets a special "나 자신"
  // row so personal-scoped templates are still expressible without
  // exposing other people's private spaces.
  const myPersonal = myUserId
    ? (workspaces ?? []).find(
        (w) => w.kind === 'personal' && w.personal_owner_user_id === myUserId,
      )
    : null
  const bySlug = new Map(
    [...options, myPersonal].filter(Boolean).map((w) => [w.slug, w]),
  )

  function toggle(slug) {
    if (selected.includes(slug)) {
      const next = selected.filter((s) => s !== slug)
      onChange(next.length === 0 ? null : next)
    } else {
      onChange([...selected, slug])
    }
  }

  function clear() {
    onChange(null)
  }

  return (
    <div className="space-y-1.5">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={disabled}
            className="w-full justify-between font-normal"
          >
            <span className="flex items-center gap-2 truncate">
              {isGlobal ? (
                <>
                  <Globe className="h-3.5 w-3.5 text-muted-foreground" />
                  <span>전사 (글로벌)</span>
                </>
              ) : (
                (() => {
                  const orgCount = selected.filter(
                    (s) => bySlug.get(s)?.kind !== 'personal',
                  ).length
                  const mine = selected.some(
                    (s) => bySlug.get(s)?.kind === 'personal',
                  )
                  const parts = []
                  if (mine) parts.push('나 자신')
                  if (orgCount > 0) parts.push(`${orgCount}개 부서`)
                  return <span className="text-sm">{parts.join(' + ')}</span>
                })()
              )}
            </span>
            <ChevronsUpDown className="h-3.5 w-3.5 opacity-50 shrink-0" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="p-0 w-[--radix-popover-trigger-width]" align="start">
          <Command>
            <CommandInput placeholder="부서 검색…" />
            <CommandList>
              <CommandEmpty>일치하는 부서가 없습니다.</CommandEmpty>
              <CommandGroup>
                <CommandItem
                  onSelect={() => {
                    clear()
                    setOpen(false)
                  }}
                >
                  <Globe className="h-3.5 w-3.5 text-muted-foreground" />
                  <span>전사 (글로벌)</span>
                  {isGlobal && <Check className="ml-auto h-3.5 w-3.5" />}
                </CommandItem>
                {myPersonal && (
                  <CommandItem
                    value={`나 자신 ${myPersonal.slug}`}
                    onSelect={() => toggle(myPersonal.slug)}
                  >
                    <span
                      className={cn(
                        'h-3.5 w-3.5 rounded border flex items-center justify-center',
                        selected.includes(myPersonal.slug)
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'border-input',
                      )}
                    >
                      {selected.includes(myPersonal.slug) && (
                        <Check className="h-3 w-3" />
                      )}
                    </span>
                    <User className="h-3.5 w-3.5 text-amber-500" />
                    <span className="flex-1">나 자신 (내 공간)</span>
                  </CommandItem>
                )}
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup heading="부서">
                {options.map((w) => {
                  const isSelected = selected.includes(w.slug)
                  return (
                    <CommandItem
                      key={w.slug}
                      value={`${w.name} ${w.slug}`}
                      onSelect={() => toggle(w.slug)}
                    >
                      <span
                        className={cn(
                          'h-3.5 w-3.5 rounded border flex items-center justify-center',
                          isSelected
                            ? 'bg-primary text-primary-foreground border-primary'
                            : 'border-input'
                        )}
                      >
                        {isSelected && <Check className="h-3 w-3" />}
                      </span>
                      <span className="flex-1 truncate">{w.name}</span>
                      <span className="text-[10px] font-mono text-muted-foreground">
                        {w.slug}
                      </span>
                    </CommandItem>
                  )
                })}
              </CommandGroup>
              {!isGlobal && (
                <>
                  <CommandSeparator />
                  <CommandGroup>
                    <CommandItem
                      value="__clear__"
                      onSelect={() => clear()}
                      className="text-muted-foreground"
                    >
                      <Eraser className="h-3.5 w-3.5" />
                      <span>선택 초기화</span>
                      <span className="ml-auto text-[10px]">{selected.length}개</span>
                    </CommandItem>
                  </CommandGroup>
                </>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {!isGlobal && (
        <div className="flex flex-wrap items-center gap-1">
          {selected.map((slug) => {
            const w = bySlug.get(slug)
            const isMine = w && w.kind === 'personal'
            const label = isMine ? '나 자신' : (w?.name ?? slug)
            return (
              <Badge key={slug} variant="secondary" className="gap-1 pr-1">
                {isMine && <User className="h-3 w-3 text-amber-500" />}
                <span className="text-xs">{label}</span>
                <button
                  type="button"
                  onClick={() => toggle(slug)}
                  className="hover:bg-muted-foreground/20 rounded p-0.5"
                  aria-label={`${slug} 제거`}
                  disabled={disabled}
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </Badge>
            )
          })}
          <button
            type="button"
            onClick={clear}
            disabled={disabled}
            className="text-[10px] text-muted-foreground hover:text-foreground underline underline-offset-2 px-1"
          >
            모두 지우기
          </button>
        </div>
      )}
    </div>
  )
}
