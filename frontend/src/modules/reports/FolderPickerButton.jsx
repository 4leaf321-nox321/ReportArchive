/** 폴더 이동 popover — 보고서 헤더에서 한 번 클릭 + 폴더 선택.
 *
 * Two scopes:
 *   - mode='personal': 본인 작업공간의 Report.folder_id 변경
 *                       (PUT /api/reports/{id}/folder)
 *   - mode='org':      현재 게시판의 ReportMount.folder_id 변경
 *                       (PUT /api/mounts/{id}/{ws}/folder)
 *
 * 같은 보고서가 mode='personal' 헤더와 mode='org' 헤더에서 다른 폴더에
 * 있을 수 있음 — 폴더는 배치 속성이고 personal은 owner의 정리, org는
 * 게시판의 정리.
 */
import * as React from 'react'
import { Folder, FolderOpen, Inbox, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
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
import { listFolders } from '@/shared/api/folders'
import { setMountFolder } from '@/shared/api/mounts'
import { moveReportToFolder } from './api'
import { cn } from '@/shared/lib/utils'

export function FolderPickerButton({
  reportId,
  folderId,
  onChanged,
  mode = 'personal', // 'personal' | 'org'
  workspaceSlug, // required when mode='org'
}) {
  const [open, setOpen] = React.useState(false)
  const [folders, setFolders] = React.useState([])
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    const args = mode === 'org' ? { workspaceSlug } : {}
    listFolders(args)
      .then(({ items }) => {
        if (!cancelled) setFolders(items)
      })
      .catch(() => {
        if (!cancelled) toast.error('폴더 목록 불러오기 실패')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, mode, workspaceSlug])

  const currentFolder = folders.find((f) => f.id === folderId)
  const label = mode === 'org' ? '게시판 폴더' : '폴더 이동'
  const unfiledLabel = mode === 'org' ? '미분류 (이 게시판)' : '미분류'

  async function pick(targetFolderId) {
    if (targetFolderId === (folderId ?? null)) {
      setOpen(false)
      return
    }
    setSaving(true)
    try {
      if (mode === 'org') {
        await setMountFolder({
          reportId,
          workspaceSlug,
          folderId: targetFolderId,
        })
      } else {
        await moveReportToFolder(reportId, targetFolderId)
      }
      onChanged?.(targetFolderId)
      toast.success(
        targetFolderId === null
          ? '미분류로 이동'
          : `'${folders.find((f) => f.id === targetFolderId)?.name}'(으)로 이동`,
      )
      setOpen(false)
    } catch (e) {
      toast.error(e?.response?.data?.message || '폴더 이동 실패')
    } finally {
      setSaving(false)
    }
  }

  function folderPath(f) {
    const parts = [f.name]
    let cur = f
    const seen = new Set([f.id])
    while (cur.parent_id != null && !seen.has(cur.parent_id)) {
      const parent = folders.find((x) => x.id === cur.parent_id)
      if (!parent) break
      seen.add(parent.id)
      parts.unshift(parent.name)
      cur = parent
    }
    return parts.join(' / ')
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          title={label}
          disabled={saving}
        >
          {currentFolder ? (
            <FolderOpen className="mr-1 h-3 w-3 text-amber-500" />
          ) : (
            <Folder className="mr-1 h-3 w-3" />
          )}
          <span className="max-w-[120px] truncate">
            {currentFolder?.name ?? '미분류'}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="end">
        <Command>
          <CommandInput placeholder="폴더 검색..." />
          <CommandList>
            {loading ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <>
                <CommandEmpty>일치하는 폴더가 없습니다.</CommandEmpty>
                <CommandGroup>
                  <CommandItem
                    value="__uncategorized__"
                    onSelect={() => pick(null)}
                  >
                    <Inbox className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="flex-1">{unfiledLabel}</span>
                    {folderId == null && (
                      <span className="text-xs text-primary">현재</span>
                    )}
                  </CommandItem>
                </CommandGroup>
                <CommandGroup heading={mode === 'org' ? '게시판 폴더' : '폴더'}>
                  {folders.map((f) => {
                    const isCurrent = folderId === f.id
                    return (
                      <CommandItem
                        key={f.id}
                        value={`${f.name} ${f.id}`}
                        onSelect={() => pick(f.id)}
                      >
                        <Folder className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className={cn('flex-1 truncate')}>
                          {folderPath(f)}
                        </span>
                        {isCurrent && (
                          <span className="text-xs text-primary">현재</span>
                        )}
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
