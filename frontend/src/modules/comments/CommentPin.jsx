/** CommentPin — small floating button on each widget showing the
 *  thread count and toggling the comment panel.
 *
 *  Behavior:
 *   - No threads + hover-only visibility (or "always" when review mode)
 *     → small "+" pin appears on hover; click opens panel + starts a
 *       new thread anchored on this block.
 *   - Has threads → always visible (small badge with count). Click
 *     opens panel + scrolls to the first unresolved thread for this
 *     block.
 *
 *  Anchor = (page_index, block_id). Comment data comes from
 *  CommentsContext.
 */
import * as React from 'react'
import { MessageCircle, MessageCirclePlus } from 'lucide-react'
import { useComments } from './CommentsContext'
import { useAuth } from '@/shared/auth/AuthContext'
import { cn } from '@/shared/lib/utils'

export function CommentPin({ reportId, pageIndex, blockId }) {
  const {
    threadsForBlock,
    openThread,
    beginDraft,
  } = useComments()
  const { me } = useAuth()

  if (!reportId || !blockId) return null

  const threads = threadsForBlock(pageIndex, blockId)
  const openCount = threads.filter((t) => t.status === 'open').length
  const hasAny = threads.length > 0

  function handleClick(e) {
    e.stopPropagation()
    if (hasAny) {
      // Jump to the first unresolved (else first) thread on this block.
      const target =
        threads.find((t) => t.status === 'open') ?? threads[0]
      openThread(target.id)
      return
    }
    // No existing thread → stage a draft (panel-only, no backend row
    // until the user types and submits). Prevents zombie empty threads.
    if (!me?.user?.id) return
    beginDraft(pageIndex, blockId)
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      onMouseDown={(e) => e.stopPropagation()}
      className={cn(
        // Position is owned by the parent flex container. Visibility
        //  - has comments → always visible (count is information; it
        //    tells reviewers which blocks have feedback at a glance)
        //  - empty → hover-only (no noise on widgets with nothing).
        // Phase doesn't change this rule — phase signal lives in the
        // top banner instead of glowing every pin.
        'inline-flex items-center justify-center gap-0.5 rounded-md border bg-background/95 px-1.5 h-7 text-[11px] shadow-sm transition',
        hasAny
          ? 'opacity-100 border-amber-300 text-amber-700'
          : 'opacity-0 group-hover:opacity-100 text-muted-foreground border-transparent hover:border-border',
      )}
      title={
        hasAny
          ? `코멘트 ${threads.length}건 (미해결 ${openCount})`
          : '코멘트 추가'
      }
    >
      {hasAny ? (
        <>
          <MessageCircle className="h-3 w-3" />
          <span className="tabular-nums">
            {openCount > 0 ? openCount : threads.length}
          </span>
        </>
      ) : (
        <MessageCirclePlus className="h-3 w-3" />
      )}
    </button>
  )
}
