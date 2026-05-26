/** Right-side comment panel — lists all threads for the current report,
 *  with inline reply / resolve / edit / delete.
 *
 *  Layout: a fixed-width slide-in panel anchored to the right edge.
 *  Toggle from CommentsContext (panelOpen). Auto-scroll target row when
 *  openThreadId changes (set by CommentPin clicks).
 *
 *  보직장 의견 (admin role snapshot): red accent + 📌 label.
 *  Resolved threads: collapsed by default, shown faded with a click-to-
 *  expand. Open threads always expanded.
 */
import * as React from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  CornerDownLeft,
  Crosshair,
  Loader2,
  MessageCircle,
  Pencil,
  PinIcon,
  Trash2,
  X,
} from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Textarea } from '@/shared/components/ui/textarea'
import { useComments } from './CommentsContext'
import { useAuth } from '@/shared/auth/AuthContext'
import { textToDoc, docToText } from './CommentBody'
import { cn } from '@/shared/lib/utils'

export function CommentPanel() {
  const {
    threads,
    loading,
    error,
    panelOpen,
    setPanelOpen,
    openThreadId,
    setOpenThreadId,
    pendingDraft,
    startThread,
    discardDraft,
    resolveBlock,
    navigateToBlock,
  } = useComments()

  const containerRef = React.useRef(null)
  const rowRefs = React.useRef({})

  // Auto-scroll to the focused thread when openThreadId changes.
  React.useEffect(() => {
    if (!openThreadId) return
    const el = rowRefs.current[openThreadId]
    if (el && containerRef.current) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [openThreadId, threads])

  if (!panelOpen) return null

  const openThreads = threads.filter((t) => t.status === 'open')
  const resolved = threads.filter((t) => t.status === 'resolved')

  return (
    <aside className="w-[360px] shrink-0 border-l bg-background flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b">
        <div className="flex items-center gap-2 text-sm font-medium">
          <MessageCircle className="h-4 w-4" />
          코멘트
          <span className="text-xs text-muted-foreground tabular-nums">
            {openThreads.length}건 미해결
          </span>
        </div>
        <button
          type="button"
          onClick={() => setPanelOpen(false)}
          className="p-1 hover:bg-muted rounded"
          aria-label="패널 닫기"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div ref={containerRef} className="flex-1 overflow-y-auto p-3 space-y-3">
        {loading ? (
          <div className="flex justify-center py-6 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : error ? (
          <div className="text-xs text-destructive">{error}</div>
        ) : (
          <>
            {/* Draft card renders unconditionally on top — even when
                there are no existing threads. The earlier "empty state"
                check was hiding this and the user saw nothing on pin
                click for empty reports. */}
            {pendingDraft && (
              <DraftThreadCard
                pageIndex={pendingDraft.pageIndex}
                blockId={pendingDraft.blockId}
                resolveBlock={resolveBlock}
                onSubmit={async (text) => {
                  await startThread({
                    pageIndex: pendingDraft.pageIndex,
                    blockId: pendingDraft.blockId,
                    body: textToDoc(text),
                  })
                }}
                onCancel={discardDraft}
              />
            )}
            {threads.length === 0 && !pendingDraft && (
              <div className="text-xs text-muted-foreground py-6 text-center">
                아직 코멘트가 없습니다.
                <br />
                위젯 우상단의 핀을 눌러 시작하세요.
              </div>
            )}
            {openThreads.map((t) => (
              <ThreadCard
                key={t.id}
                thread={t}
                isFocused={openThreadId === t.id}
                refSetter={(el) => (rowRefs.current[t.id] = el)}
                resolveBlock={resolveBlock}
                navigateToBlock={navigateToBlock}
              />
            ))}
            {resolved.length > 0 && (
              <>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground pt-2 border-t">
                  해결됨 ({resolved.length})
                </div>
                {resolved.map((t) => (
                  <ThreadCard
                    key={t.id}
                    thread={t}
                    isFocused={openThreadId === t.id}
                    refSetter={(el) => (rowRefs.current[t.id] = el)}
                    resolveBlock={resolveBlock}
                    navigateToBlock={navigateToBlock}
                    startCollapsed
                  />
                ))}
              </>
            )}
          </>
        )}
      </div>
    </aside>
  )
}

function ThreadCard({
  thread,
  isFocused,
  refSetter,
  resolveBlock,
  navigateToBlock,
  startCollapsed = false,
}) {
  const { reply, toggleResolved, updateComment, removeComment } = useComments()
  const { me } = useAuth()
  const anchor = resolveBlock?.(thread.page_index, thread.block_id) ?? null
  const [collapsed, setCollapsed] = React.useState(startCollapsed)
  const [replyText, setReplyText] = React.useState('')
  const [sending, setSending] = React.useState(false)
  const [editingCommentId, setEditingCommentId] = React.useState(null)
  const [editText, setEditText] = React.useState('')

  // Auto-expand on focus, even if it was collapsed.
  React.useEffect(() => {
    if (isFocused) setCollapsed(false)
  }, [isFocused])

  const isLeadComment = thread.author_role_at_creation === 'admin'

  async function handleReply() {
    const text = replyText.trim()
    if (!text) return
    setSending(true)
    try {
      await reply(thread.id, textToDoc(text))
      setReplyText('')
    } finally {
      setSending(false)
    }
  }

  async function handleSaveEdit(commentId) {
    const text = editText.trim()
    if (!text) {
      setEditingCommentId(null)
      return
    }
    try {
      await updateComment(commentId, textToDoc(text))
      setEditingCommentId(null)
    } catch (_e) {
      /* toast handled */
    }
  }

  return (
    <div
      ref={refSetter}
      className={cn(
        'rounded-lg border bg-card transition-shadow',
        isFocused && 'ring-2 ring-primary/40',
        isLeadComment && 'border-red-300 bg-red-50/30',
        thread.status === 'resolved' && 'opacity-70',
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-1.5 px-3 py-2 border-b">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="p-0.5 hover:bg-muted rounded"
        >
          {collapsed ? (
            <ChevronRight className="h-3 w-3" />
          ) : (
            <ChevronDown className="h-3 w-3" />
          )}
        </button>
        {isLeadComment && (
          <span
            className="flex items-center gap-0.5 text-[10px] font-semibold text-red-600 shrink-0"
            title="관리자가 시작한 스레드"
          >
            <PinIcon className="h-2.5 w-2.5" />
            {thread.author?.name ? `${thread.author.name} 리뷰` : '관리자 리뷰'}
          </span>
        )}
        <AnchorPill
          anchor={anchor}
          fallbackBlockId={thread.block_id}
          fallbackPageIndex={thread.page_index}
          onNavigate={
            navigateToBlock
              ? () => navigateToBlock(thread.page_index, thread.block_id)
              : null
          }
        />
        <button
          type="button"
          onClick={() => toggleResolved(thread.id, thread.status)}
          className={cn(
            'text-[10px] px-1.5 py-0.5 rounded',
            thread.status === 'resolved'
              ? 'bg-muted text-muted-foreground hover:bg-muted/60'
              : 'bg-green-50 text-green-700 hover:bg-green-100',
          )}
          title={thread.status === 'resolved' ? '재오픈' : '해결로 표시'}
        >
          {thread.status === 'resolved' ? '재오픈' : '✓ 해결'}
        </button>
      </div>

      {/* Comments */}
      {!collapsed && (
        <div className="px-3 py-2 space-y-2">
          {thread.comments.map((c) => {
            const isMine = c.author?.id === me?.user?.id
            return (
              <div key={c.id} className="text-sm">
                <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <span className="font-medium text-foreground/90">
                    {c.author?.name ?? '?'}
                  </span>
                  <span>{formatRelative(c.created_at)}</span>
                  {c.updated_at !== c.created_at && (
                    <span className="italic">(수정됨)</span>
                  )}
                  {isMine && editingCommentId !== c.id && (
                    <span className="ml-auto flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingCommentId(c.id)
                          setEditText(docToText(c.body))
                        }}
                        className="p-0.5 hover:bg-muted rounded"
                        title="수정"
                      >
                        <Pencil className="h-2.5 w-2.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (window.confirm('이 댓글을 삭제하시겠어요?')) {
                            removeComment(c.id)
                          }
                        }}
                        className="p-0.5 hover:bg-muted rounded text-destructive"
                        title="삭제"
                      >
                        <Trash2 className="h-2.5 w-2.5" />
                      </button>
                    </span>
                  )}
                </div>
                {editingCommentId === c.id ? (
                  <div className="mt-1 space-y-1">
                    <Textarea
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      rows={3}
                      className="text-sm resize-none"
                      autoFocus
                    />
                    <div className="flex justify-end gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditingCommentId(null)}
                      >
                        취소
                      </Button>
                      <Button size="sm" onClick={() => handleSaveEdit(c.id)}>
                        저장
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="whitespace-pre-wrap leading-snug mt-0.5">
                    {docToText(c.body) || (
                      <span className="italic text-muted-foreground text-xs">
                        (빈 코멘트)
                      </span>
                    )}
                  </div>
                )}
              </div>
            )
          })}

          {thread.status === 'open' && (
            <div className="pt-2 border-t space-y-1">
              <Textarea
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                placeholder="답글 작성... (Cmd/Ctrl+Enter 전송)"
                rows={2}
                className="text-sm resize-none"
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault()
                    handleReply()
                  }
                }}
              />
              <div className="flex justify-end">
                <Button
                  size="sm"
                  onClick={handleReply}
                  disabled={!replyText.trim() || sending}
                >
                  {sending ? (
                    <Loader2 className="h-3 w-3 animate-spin mr-1" />
                  ) : (
                    <CornerDownLeft className="h-3 w-3 mr-1" />
                  )}
                  답글
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Unsaved draft thread — appears at the top of the panel when the
 *  user clicks "+" on a comment-less block. No backend row exists
 *  yet. First submit persists; cancel/blur-with-empty discards. */
function DraftThreadCard({ pageIndex, blockId, resolveBlock, onSubmit, onCancel }) {
  const anchor = resolveBlock?.(pageIndex, blockId) ?? null
  const [text, setText] = React.useState('')
  const [sending, setSending] = React.useState(false)
  const inputRef = React.useRef(null)

  React.useEffect(() => {
    // Auto-focus when the draft mounts.
    inputRef.current?.focus()
  }, [pageIndex, blockId])

  async function commit() {
    const trimmed = text.trim()
    if (!trimmed) {
      onCancel()
      return
    }
    setSending(true)
    try {
      await onSubmit(trimmed)
      setText('')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="rounded-lg border border-dashed border-amber-300 bg-amber-50/40">
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-amber-200">
        <span className="text-[10px] font-semibold text-amber-700 shrink-0">새 코멘트</span>
        <AnchorPill
          anchor={anchor}
          fallbackBlockId={blockId}
          fallbackPageIndex={pageIndex}
          onNavigate={null}
        />
        <button
          type="button"
          onClick={onCancel}
          className="p-0.5 hover:bg-muted rounded shrink-0"
          aria-label="취소"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      <div className="px-3 py-2 space-y-1.5">
        <Textarea
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="코멘트 작성... (Cmd/Ctrl+Enter 전송, Esc 취소)"
          rows={3}
          className="text-sm resize-none"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault()
              commit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onCancel()
            }
          }}
        />
        <div className="flex justify-end gap-1">
          <Button size="sm" variant="ghost" onClick={onCancel}>
            취소
          </Button>
          <Button size="sm" onClick={commit} disabled={!text.trim() || sending}>
            {sending ? (
              <Loader2 className="h-3 w-3 animate-spin mr-1" />
            ) : (
              <CornerDownLeft className="h-3 w-3 mr-1" />
            )}
            등록
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Inline anchor pill — shows the widget the thread is attached to.
 *  Replaces the old opaque "블록 {id} · p.N" line so reviewers can see
 *  WHICH widget the comment talks about without leaving the panel.
 *  When `onNavigate` is provided the pill is clickable and switches
 *  the report to that page + scrolls the widget into view (handled by
 *  ReportDetailPage). Falls back to the raw ids when resolveBlock
 *  couldn't find the block (e.g. block was deleted after the thread
 *  was created — keep the thread visible, just less detailed). */
function AnchorPill({ anchor, fallbackBlockId, fallbackPageIndex, onNavigate }) {
  const clickable = !!onNavigate
  const Wrapper = clickable ? 'button' : 'span'

  let body
  if (anchor) {
    const pageLabel = anchor.pageName?.trim()
      ? `${anchor.pageName} (p.${anchor.pageNumber})`
      : `p.${anchor.pageNumber}`
    body = (
      <>
        <span className="rounded bg-muted px-1 py-px text-[9px] uppercase tracking-wide text-foreground/70 shrink-0">
          {anchor.widgetLabel || anchor.widgetType}
        </span>
        {anchor.blockLabel && (
          <span className="text-foreground/80 truncate">{anchor.blockLabel}</span>
        )}
        <span className="text-muted-foreground shrink-0">· {pageLabel}</span>
      </>
    )
  } else {
    // Block missing from current draft — surface the raw ids so the
    // thread is still distinguishable, just without the rich context.
    body = (
      <span className="text-muted-foreground truncate">
        블록 {fallbackBlockId}
        {fallbackPageIndex > 0 && ` · p.${fallbackPageIndex + 1}`}
      </span>
    )
  }

  return (
    <Wrapper
      {...(clickable
        ? {
            type: 'button',
            onClick: onNavigate,
            title: '본문 위젯으로 이동',
          }
        : {})}
      className={cn(
        'flex items-center gap-1 text-[10px] min-w-0 flex-1 rounded px-1 py-0.5',
        clickable &&
          'cursor-pointer hover:bg-primary/10 hover:text-primary text-left transition-colors',
      )}
    >
      {clickable && <Crosshair className="h-2.5 w-2.5 shrink-0 opacity-60" />}
      {body}
    </Wrapper>
  )
}

function formatRelative(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const now = new Date()
  const diff = (now - d) / 1000
  if (diff < 60) return '방금'
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}일 전`
  return d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })
}
