/** 공유 컨트롤 — 트리거(공유 뱃지) 클릭 시 팝오버로 그 자리에서 공유 편집.
 *
 *  보고서·종합보고·게시판·폴더 공통. ShareEditor 를 팝오버에 띄운다(모달 아님).
 *  뱃지로 공유 대상 개수/전체공개를 항상 표시, 호버하면 대상 목록(title).
 *
 *  props: contentType/contentId(+ownerUserId) | boardSlug | folderId (모드 택1),
 *         canManage, label, compact(아이콘만), initialGrants(뱃지 시드 — 폴더
 *         목록처럼 이미 grant 를 알 때 추가 조회 방지), onChanged, triggerClassName.
 */
import * as React from 'react'
import { Share2 } from 'lucide-react'
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/shared/components/ui/popover'
import { ShareBadge } from '@/shared/components/ShareBadge'
import { ShareEditor } from '@/shared/components/ShareEditor'
import { shareApi } from '@/shared/api/shares'
import { cn } from '@/shared/lib/utils'

export function SharePopover({
  contentType,
  contentId,
  ownerUserId,
  boardSlug,
  folderId,
  canManage,
  label = '공유',
  compact = false,
  initialGrants,
  onChanged,
  triggerClassName,
}) {
  const [open, setOpen] = React.useState(false)
  const [grants, setGrants] = React.useState(initialGrants || [])

  React.useEffect(() => {
    if (initialGrants !== undefined) setGrants(initialGrants || [])
  }, [initialGrants])

  // initialGrants 가 없으면(상세 등) 뱃지용으로 한 번 조회.
  React.useEffect(() => {
    if (initialGrants !== undefined) return
    if (!contentId && !boardSlug && !folderId) return
    const api = shareApi({ contentType, contentId, boardSlug, folderId })
    let cancelled = false
    api
      .list()
      .then((g) => !cancelled && setGrants(g))
      .catch(() => {})
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentType, contentId, boardSlug, folderId])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          title="공유 설정"
          className={cn(
            'inline-flex items-center gap-1 text-sm',
            triggerClassName,
          )}
        >
          {compact ? (
            // 컴팩트(폴더 등): 공유가 있으면 뱃지 하나만, 없으면 추가용 아이콘만
            // — 아이콘+칩이 두 버튼처럼 보이지 않게 한 요소로.
            grants.length > 0 ? (
              <ShareBadge grants={grants} />
            ) : (
              <Share2 className="h-3.5 w-3.5 shrink-0" />
            )
          ) : (
            <>
              <Share2 className="h-3.5 w-3.5 shrink-0" />
              <span className="flex-1 truncate text-left">{label}</span>
              <ShareBadge grants={grants} />
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 max-h-[70vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <ShareEditor
          contentType={contentType}
          contentId={contentId}
          ownerUserId={ownerUserId}
          boardSlug={boardSlug}
          folderId={folderId}
          canManage={canManage}
          active={open}
          onGrantsChange={setGrants}
          onChanged={onChanged}
        />
      </PopoverContent>
    </Popover>
  )
}
