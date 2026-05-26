/** Comments context — fetches threads once per report, exposes mutators
 *  with optimistic refresh, and lets nested components subscribe.
 *
 *  Why context instead of per-component hooks: the pin on each widget
 *  needs the count for THIS block; the side panel needs the full list;
 *  the activity log shares the same source. Single fetch + single cache
 *  beats N requests per widget.
 */
import * as React from 'react'
import { toast } from 'sonner'
import {
  listThreadsForReport,
  createThread,
  replyToThread,
  setThreadStatus,
  editComment,
  deleteComment,
} from '@/shared/api/comments'

const CommentsContext = React.createContext(null)

export function CommentsProvider({ reportId, reportPhase, children }) {
  const [threads, setThreads] = React.useState([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState(null)
  // Pin clicks open the panel + scroll to a specific thread. Children
  // dispatch via `openThread(threadId)`; the panel listens.
  const [openThreadId, setOpenThreadId] = React.useState(null)
  // Side panel visibility — controlled here so the pin button can
  // toggle it from inside the tree without prop-drilling. Default-open
  // when the report is in reviewing/finalized phase (the comments are
  // the point of the page at that stage); collapsed by default in
  // drafting (writer is composing, not reviewing).
  const [panelOpen, setPanelOpen] = React.useState(
    reportPhase === 'reviewing' || reportPhase === 'finalized',
  )
  // Pending new-thread draft. When the user clicks a "+" pin on a
  // block with no existing threads, we don't persist anything yet —
  // we just stash the (page_index, block_id) anchor here. The panel
  // renders a draft thread card with an empty textarea, and only on
  // first submit does the backend row get created. This avoids
  // zombie empty threads when the user dismisses the dialog/panel.
  const [pendingDraft, setPendingDraft] = React.useState(null)

  const refresh = React.useCallback(async () => {
    if (!reportId) return
    setLoading(true)
    setError(null)
    try {
      const rows = await listThreadsForReport(reportId)
      setThreads(rows)
    } catch (e) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }, [reportId])

  React.useEffect(() => {
    refresh()
  }, [refresh])

  // Refresh on tab visibility — if the user comes back from another
  // tab where mutations happened (or where they didn't see the page
  // for a while), pull the latest. Cheap GET, runs at most once per
  // visibility change.
  React.useEffect(() => {
    function onVisibility() {
      if (document.visibilityState === 'visible') {
        refresh()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', refresh)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', refresh)
    }
  }, [refresh])

  // Bucket threads by (page_index, block_id) for cheap pin lookups.
  const byBlock = React.useMemo(() => {
    const m = new Map()
    for (const t of threads) {
      const key = `${t.page_index}::${t.block_id}`
      if (!m.has(key)) m.set(key, [])
      m.get(key).push(t)
    }
    return m
  }, [threads])

  function threadsForBlock(pageIndex, blockId) {
    return byBlock.get(`${pageIndex}::${blockId}`) ?? []
  }

  async function startThread({ pageIndex, blockId, body }) {
    try {
      const created = await createThread(reportId, { pageIndex, blockId, body })
      await refresh()
      // Open the panel + scroll to the new thread.
      setPanelOpen(true)
      setOpenThreadId(created?.id ?? null)
      setPendingDraft(null)
      return created
    } catch (e) {
      toast.error(e?.response?.data?.message || '코멘트 추가 실패')
      throw e
    }
  }

  /** Open the panel and stage a draft for this block — does NOT
   *  create a backend row. The panel renders the draft card; the
   *  first submit calls startThread which persists + clears draft. */
  function beginDraft(pageIndex, blockId) {
    setPendingDraft({ pageIndex, blockId })
    setPanelOpen(true)
  }

  function discardDraft() {
    setPendingDraft(null)
  }

  // Wrap panel toggle so closing also clears any unsaved draft —
  // otherwise reopening the panel would resurrect the stale draft
  // anchored to a block the user may have already navigated past.
  function setPanelOpenSafe(next) {
    if (!next) setPendingDraft(null)
    setPanelOpen(next)
  }

  async function reply(threadId, body) {
    try {
      await replyToThread(threadId, body)
      await refresh()
    } catch (e) {
      toast.error(e?.response?.data?.message || '답글 실패')
      throw e
    }
  }

  async function toggleResolved(threadId, currentStatus) {
    const next = currentStatus === 'resolved' ? 'open' : 'resolved'
    try {
      await setThreadStatus(threadId, next)
      await refresh()
    } catch (e) {
      toast.error(e?.response?.data?.message || '상태 변경 실패')
    }
  }

  async function updateComment(commentId, body) {
    try {
      await editComment(commentId, body)
      await refresh()
    } catch (e) {
      toast.error(e?.response?.data?.message || '수정 실패')
      throw e
    }
  }

  async function removeComment(commentId) {
    try {
      await deleteComment(commentId)
      await refresh()
    } catch (e) {
      toast.error(e?.response?.data?.message || '삭제 실패')
    }
  }

  function openThread(threadId) {
    setPanelOpen(true)
    setOpenThreadId(threadId)
  }

  const value = {
    threads,
    loading,
    error,
    threadsForBlock,
    startThread,
    reply,
    toggleResolved,
    updateComment,
    removeComment,
    refresh,
    // panel state
    panelOpen,
    setPanelOpen: setPanelOpenSafe,
    openThreadId,
    openThread,
    setOpenThreadId,
    // draft (unsaved new thread)
    pendingDraft,
    beginDraft,
    discardDraft,
  }

  return (
    <CommentsContext.Provider value={value}>
      {children}
    </CommentsContext.Provider>
  )
}

export function useComments() {
  const ctx = React.useContext(CommentsContext)
  if (!ctx) {
    // Return a no-op shape so components rendered outside the provider
    // (e.g. a report viewer in another context) don't crash.
    return {
      threads: [],
      loading: false,
      error: null,
      threadsForBlock: () => [],
      startThread: async () => {},
      reply: async () => {},
      toggleResolved: async () => {},
      updateComment: async () => {},
      removeComment: async () => {},
      refresh: async () => {},
      panelOpen: false,
      setPanelOpen: () => {},
      openThreadId: null,
      openThread: () => {},
      setOpenThreadId: () => {},
      pendingDraft: null,
      beginDraft: () => {},
      discardDraft: () => {},
    }
  }
  return ctx
}
