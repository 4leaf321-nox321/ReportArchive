/** 폴더 이동 — 보고서를 한 폴더로 옮긴다. 두 가지 표면을 제공:
 *   - FolderPickerButton: 헤더/툴바용 Popover(자체 트리거 버튼). MountDialog 등에서 사용.
 *   - FolderPickerDialog : controlled Dialog(트리거 없음). "더보기" 메뉴처럼
 *                          Popover 를 띄울 앵커가 없는 곳에서 사용.
 *  공통 로직(목록 로드 · 이동 API · 리스트 UI)은 아래 hook/컴포넌트로 공유.
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
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

/** 폴더 목록 로드 — active(popover/dialog 열림) 거나 이미 folderId 가 있어
 *  현재 폴더 이름을 표시해야 할 때만. 한 번 로드되면 재요청 안 함. */
function useFolderData({ mode, workspaceSlug, active, folderId }) {
  const [folders, setFolders] = React.useState([])
  const [loading, setLoading] = React.useState(false)
  React.useEffect(() => {
    if (!active && folderId == null) return
    if (folders.length > 0) return
    let cancelled = false
    setLoading(true)
    const args = mode === 'org' ? { workspaceSlug } : {}
    listFolders(args)
      .then(({ items }) => {
        if (!cancelled) setFolders(items)
      })
      .catch(() => {
        if (!cancelled && active) toast.error('폴더 목록 불러오기 실패')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [active, folderId, mode, workspaceSlug, folders.length])
  return { folders, loading }
}

/** 폴더 이동 API 호출(personal=보고서 / org=mount) + 토스트. onClose 로
 *  표면(popover/dialog)을 닫는다. */
function useFolderMove({ reportId, mode, workspaceSlug, folderId, folders, onChanged, onClose }) {
  const [saving, setSaving] = React.useState(false)
  async function pick(targetFolderId) {
    if (targetFolderId === (folderId ?? null)) {
      onClose?.()
      return
    }
    setSaving(true)
    try {
      if (mode === 'org') {
        await setMountFolder({ reportId, workspaceSlug, folderId: targetFolderId })
      } else {
        await moveReportToFolder(reportId, targetFolderId)
      }
      onChanged?.(targetFolderId)
      toast.success(
        targetFolderId === null
          ? '미분류로 이동'
          : `'${folders.find((f) => f.id === targetFolderId)?.name}'(으)로 이동`,
      )
      onClose?.()
    } catch (e) {
      toast.error(e?.response?.data?.message || '폴더 이동 실패')
    } finally {
      setSaving(false)
    }
  }
  return { saving, pick }
}

/** 폴더 검색 + 선택 리스트 — Popover/Dialog 양쪽이 공유. */
function FolderPickerList({ folders, loading, folderId, mode, onPick }) {
  const unfiledLabel = mode === 'org' ? '미분류 (이 게시판)' : '미분류'
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
                onSelect={() => onPick(null)}
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
                    onSelect={() => onPick(f.id)}
                  >
                    <Folder className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className={cn('flex-1 truncate')}>{folderPath(f)}</span>
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
  )
}

export function FolderPickerButton({
  reportId,
  folderId,
  onChanged,
  mode = 'personal', // 'personal' | 'org'
  workspaceSlug, // required when mode='org'
}) {
  const [open, setOpen] = React.useState(false)
  const { folders, loading } = useFolderData({
    mode,
    workspaceSlug,
    active: open,
    folderId,
  })
  const { saving, pick } = useFolderMove({
    reportId,
    mode,
    workspaceSlug,
    folderId,
    folders,
    onChanged,
    onClose: () => setOpen(false),
  })
  const currentFolder = folders.find((f) => f.id === folderId)
  const label = mode === 'org' ? '게시판 폴더' : '폴더 이동'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" title={label} disabled={saving}>
          {currentFolder ? (
            <FolderOpen className="mr-1 h-3 w-3 text-amber-500" />
          ) : (
            <Folder className="mr-1 h-3 w-3" />
          )}
          <span className="max-w-[120px] truncate">
            {currentFolder?.name ?? (mode === 'org' ? '폴더 선택' : '이동')}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="end">
        <FolderPickerList
          folders={folders}
          loading={loading}
          folderId={folderId}
          mode={mode}
          onPick={pick}
        />
      </PopoverContent>
    </Popover>
  )
}

/** 트리거 없는 controlled 변형 — "더보기" 메뉴 등에서 open 으로 띄운다.
 *  Popover 와 달리 앵커가 필요 없어 메뉴 항목에서 호출하기 좋다. */
export function FolderPickerDialog({
  open,
  onOpenChange,
  reportId,
  folderId,
  onChanged,
  mode = 'personal',
  workspaceSlug,
}) {
  const { folders, loading } = useFolderData({
    mode,
    workspaceSlug,
    active: open,
    folderId,
  })
  const { pick } = useFolderMove({
    reportId,
    mode,
    workspaceSlug,
    folderId,
    folders,
    onChanged,
    onClose: () => onOpenChange(false),
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="px-4 pb-2 pt-4">
          <DialogTitle className="text-base">
            {mode === 'org' ? '게시판 폴더 이동' : '폴더 이동'}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {mode === 'org'
              ? '이 게시판에서 보고서가 속할 폴더를 고릅니다.'
              : '내 작업공간에서 보고서가 속할 폴더를 고릅니다.'}
          </DialogDescription>
        </DialogHeader>
        <FolderPickerList
          folders={folders}
          loading={loading}
          folderId={folderId}
          mode={mode}
          onPick={pick}
        />
      </DialogContent>
    </Dialog>
  )
}
