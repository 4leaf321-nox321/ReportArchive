import * as React from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/shared/components/ui/popover'
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
 * 검색 가능한 단일 선택 드롭다운 (범용). 단순 `<select>` 를 대체 — 항목이 많거나
 * 타이핑 필터가 필요할 때. Popover + cmdk Command 기반.
 *
 *   options:  [{ value, label }]
 *   value:    현재 선택 value (문자열/숫자) | ''/null
 *   onChange: (value) => void   — 선택한 option 의 value 를 그대로 넘긴다
 */
export function Combobox({
  options = [],
  value,
  onChange,
  placeholder = '선택...',
  searchPlaceholder = '검색...',
  emptyMessage = '일치하는 항목이 없습니다.',
  disabled = false,
  className,
  id,
}) {
  const [open, setOpen] = React.useState(false)
  const selected = React.useMemo(
    () => options.find((o) => String(o.value) === String(value)) ?? null,
    [options, value],
  )

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
          className={cn('w-full justify-between font-normal', className)}
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected ? selected.label : placeholder}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="p-0"
        align="start"
        style={{ width: 'var(--radix-popover-trigger-width)' }}
      >
        <Command
          filter={(v, s) => (v.toLowerCase().includes(s.toLowerCase()) ? 1 : 0)}
        >
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList className="max-h-[280px]">
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            <CommandGroup>
              {options.map((o) => (
                <CommandItem
                  key={o.value}
                  value={o.label}
                  onSelect={() => {
                    onChange(o.value)
                    setOpen(false)
                  }}
                  className="cursor-pointer"
                >
                  <span className="flex-1 truncate text-sm">{o.label}</span>
                  {String(value) === String(o.value) && (
                    <Check className="h-4 w-4 shrink-0 text-primary" />
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
