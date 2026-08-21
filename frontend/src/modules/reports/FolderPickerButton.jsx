/** 폴더 이동 — 보고서를 폴더에 배치한다. 두 가지 표면을 제공:
 *   - FolderPickerButton: 헤더/툴바용 Popover(자체 트리거 버튼). MountDialog 등에서 사용.
 *   - FolderPickerDialog : controlled Dialog(트리거 없음). "더보기" 메뉴처럼
 *                          Popover 를 띄울 앵커가 없는 곳에서 사용.
 *  공통 로직(목록 로드 · 이동 API · 리스트 UI)은 아래 hook/컴포넌트로 공유.
 *
 * Two scopes:
 *   - mode='personal': 본인 작업공간의 Report.folder_id 변경
 *                       (PUT /api/reports/{id}/folder)
 *   - mode='org':      현재 게시판의 폴더 배치 변경
 *                       (PUT /api/mounts/{id}/{ws}/folder(s))
 *
 * 같은 보고서가 mode='personal' 헤더와 mode='org' 헤더에서 다른 폴더에
 * 있을 수 있음 — 폴더는 배치 속성이고 personal은 owner의 정리, org는
 * 게시판의 정리.
 *
 * 선택 모드는 두 가지:
 *   - 단일(기본): `folderId` 를 주면 한 폴더로 **이동**(기존 배치 대체).
 *   - 다중: `folderIds` 배열을 주면 체크 토글로 한 게시판의 **여러 폴더**에
 *     동시에 배치한다(p89). onChanged 는 바뀐 id 배열을 받는다.
 */
import * as React from 'react'
import { Check, Folder, FolderOpen, Inbox, Loader2 } from 'lucide-react'
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
import { setMountFolder, setMountFolders } from '@/shared/api/mounts'
import { moveReportToFolder } from './api'
import { cn } from '@/shared/lib/utils'

/** 폴더 목록 로드 — active(popover/dialog 열림) 거나 이미 배치된 폴더가 있어
 *  이름을 표시해야 할 때만. 한 번 로드되면 재요청 안 함. */
function useFolderData({ mode, workspaceSlug, active, folderId, selectedIds }) {
  const [folders, setFolders] = React.useState([])
  const [loading, setLoading] = React.useState(false)
  const needNames = folderId != null || (selectedIds?.length ?? 0) > 0
  React.useEffect(() => {
    if (!active && !needNames) return
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
  }, [active, needNames, mode, workspaceSlug, folders.length])
  return { folders, loading }
}

/** 다중 배치(org 전용) — 체크 토글마다 폴더 집합을 통째로 저장한다.
 *  단일 이동(useFolderMove)과 달리 표면을 닫지 않아 연속 선택이 가능하다. */
function useFolderMultiSelect({
  reportId,
  workspaceSlug,
  selectedIds,
  folders,
  onChanged,
}) {
  const [saving, setSaving] = React.useState(false)
  async function apply(nextIds, { label }) {
    setSaving(true)
    try {
      await setMountFolders({ reportId, workspaceSlug, folderIds: nextIds })
      onChanged?.(nextIds)
      toast.success(label)
    } catch (e) {
      toast.error(e?.response?.data?.message || '폴더 배치 변경 실패')
    } finally {
      setSaving(false)
    }
  }
  function toggle(folderId) {
    // '미분류' 선택 = 배치 전부 해제.
    if (folderId === null) {
      if (selectedIds.length === 0) return
      return apply([], { label: '미분류로 이동' })
    }
    const has = selectedIds.includes(folderId)
    const next = has
      ? selectedIds.filter((id) => id !== folderId)
      : [...selectedIds, folderId]
    const name = folders.find((f) => f.id === folderId)?.name ?? '폴더'
    return apply(next, {
      label: has ? `'${name}'에서 제외` : `'${name}'에 추가`,
    })
  }
  return { saving, toggle }
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

/** 폴더 검색 + 선택 리스트 — Popover/Dialog 양쪽이 공유.
 *  `multiple` 이면 체크 토글(여러 폴더 동시 배치), 아니면 단일 이동. */
function FolderPickerList({
  folders,
  loading,
  folderId,
  mode,
  onPick,
  multiple = false,
  selectedIds = [],
}) {
  const selected = React.useMemo(() => new Set(selectedIds), [selectedIds])
  const isPicked = (id) => (multiple ? selected.has(id) : folderId === id)
  const unfiledPicked = multiple ? selected.size === 0 : folderId == null
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
                {unfiledPicked && (
                  <span className="text-xs text-primary">현재</span>
                )}
              </CommandItem>
            </CommandGroup>
            <CommandGroup
              heading={
                mode === 'org'
                  ? multiple
                    ? '게시판 폴더 (여러 개 선택 가능)'
                    : '게시판 폴더'
                  : '폴더'
              }
            >
              {folders.map((f) => {
                const picked = isPicked(f.id)
                return (
                  <CommandItem
                    key={f.id}
                    value={`${f.name} ${f.id}`}
                    onSelect={() => onPick(f.id)}
                  >
                    {multiple ? (
                      // 체크박스형 — 선택된 폴더는 채워진 사각형에 체크.
                      <span
                        className={cn(
                          'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border',
                          picked
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-muted-foreground/40',
                        )}
                      >
                        {picked && <Check className="h-2.5 w-2.5" />}
                      </span>
                    ) : (
                      <Folder className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                    <span className={cn('flex-1 truncate')}>{folderPath(f)}</span>
                    {!multiple && picked && (
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
  folderIds, // 주어지면 다중 선택 모드(org 전용). onChanged 는 id 배열을 받는다.
  onChanged,
  mode = 'personal', // 'personal' | 'org'
  workspaceSlug, // required when mode='org'
}) {
  const multiple = mode === 'org' && Array.isArray(folderIds)
  const selectedIds = React.useMemo(() => folderIds ?? [], [folderIds])
  const [open, setOpen] = React.useState(false)
  const { folders, loading } = useFolderData({
    mode,
    workspaceSlug,
    active: open,
    folderId,
    selectedIds,
  })
  const single = useFolderMove({
    reportId,
    mode,
    workspaceSlug,
    folderId,
    folders,
    onChanged,
    onClose: () => setOpen(false),
  })
  const multi = useFolderMultiSelect({
    reportId,
    workspaceSlug,
    selectedIds,
    folders,
    onChanged,
  })
  const { saving, pick } = multiple
    ? { saving: multi.saving, pick: multi.toggle }
    : single
  const label = mode === 'org' ? '게시판 폴더' : '폴더 이동'

  // 트리거 라벨 — 다중 모드는 "첫 폴더 +N", 단일 모드는 현재 폴더명.
  const picked = multiple
    ? selectedIds
        .map((id) => folders.find((f) => f.id === id))
        .filter(Boolean)
    : []
  const hasPick = multiple ? selectedIds.length > 0 : folderId != null
  const triggerLabel = multiple
    ? selectedIds.length === 0
      ? '폴더 선택'
      : picked.length === 0
        ? `폴더 ${selectedIds.length}개` // 이름 로드 전
        : picked.length === 1
          ? picked[0].name
          : `${picked[0].name} +${selectedIds.length - 1}`
    : (folders.find((f) => f.id === folderId)?.name ??
      (mode === 'org' ? '폴더 선택' : '이동'))

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          title={
            multiple && picked.length > 1
              ? `${label}: ${picked.map((f) => f.name).join(', ')}`
              : label
          }
          disabled={saving}
        >
          {hasPick ? (
            <FolderOpen className="mr-1 h-3 w-3 text-amber-500" />
          ) : (
            <Folder className="mr-1 h-3 w-3" />
          )}
          <span className="max-w-[120px] truncate">{triggerLabel}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="end">
        <FolderPickerList
          folders={folders}
          loading={loading}
          folderId={folderId}
          mode={mode}
          onPick={pick}
          multiple={multiple}
          selectedIds={selectedIds}
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
  folderIds, // 주어지면 다중 선택 모드(org 전용)
  onChanged,
  mode = 'personal',
  workspaceSlug,
}) {
  const multiple = mode === 'org' && Array.isArray(folderIds)
  const selectedIds = React.useMemo(() => folderIds ?? [], [folderIds])
  const { folders, loading } = useFolderData({
    mode,
    workspaceSlug,
    active: open,
    folderId,
    selectedIds,
  })
  const single = useFolderMove({
    reportId,
    mode,
    workspaceSlug,
    folderId,
    folders,
    onChanged,
    onClose: () => onOpenChange(false),
  })
  const multi = useFolderMultiSelect({
    reportId,
    workspaceSlug,
    selectedIds,
    folders,
    onChanged,
  })
  const pick = multiple ? multi.toggle : single.pick
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="px-4 pb-2 pt-4">
          <DialogTitle className="text-base">
            {mode === 'org' ? '게시판 폴더' : '폴더 이동'}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {mode === 'org'
              ? multiple
                ? '이 게시판에서 보고서가 놓일 폴더를 고릅니다 — 여러 개 선택할 수 있습니다.'
                : '이 게시판에서 보고서가 속할 폴더를 고릅니다.'
              : '내 작업공간에서 보고서가 속할 폴더를 고릅니다.'}
          </DialogDescription>
        </DialogHeader>
        <FolderPickerList
          folders={folders}
          loading={loading}
          folderId={folderId}
          mode={mode}
          onPick={pick}
          multiple={multiple}
          selectedIds={selectedIds}
        />
      </DialogContent>
    </Dialog>
  )
}
