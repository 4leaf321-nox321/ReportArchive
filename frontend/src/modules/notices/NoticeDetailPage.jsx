import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Paperclip, Pencil, Pin, Save, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { Card, CardContent } from '@/shared/components/ui/card'
import { ErrorState } from '@/shared/components/ErrorState'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { ConfirmDialog } from '@/shared/components/ConfirmDialog'
import { useAuth } from '@/shared/auth/AuthContext'
import { useAsync } from '@/shared/hooks/useAsync'
import { NoticeImages } from './NoticeImages'
import { AuthedRichText } from '@/shared/rich-text/AuthedRichText'
import { deleteNotice, getNotice, updateNotice } from '@/shared/api/notices'
import { noticeDateTime } from './constants'

/** 공지 상세 — 리치 텍스트 본문 + (구버전) 첨부. 시스템 관리자만 수정/삭제/
 *  고정 토글이 가능하고 일반 사용자에게는 읽기 전용. 댓글은 없다. */
export default function NoticeDetailPage() {
  const { postId } = useParams()
  const navigate = useNavigate()
  const { me } = useAuth()
  const isAdmin = me?.is_system_admin === true

  const { data: post, loading, error, reload } = useAsync(
    () => getNotice(postId),
    [postId],
  )
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  if (loading) return <div className="p-6"><Skeleton className="h-96" /></div>
  if (error) return <div className="p-6"><ErrorState description={error.message} onRetry={reload} /></div>
  if (!post) return null

  async function handleTogglePin() {
    try {
      await updateNotice(post.id, { pinned: !post.pinned })
      reload()
      toast.success(post.pinned ? '상단 고정을 해제했습니다.' : '상단에 고정했습니다.')
    } catch (e) {
      toast.error(e.message || '실패')
    }
  }
  async function handleDelete() {
    try {
      await deleteNotice(post.id)
      toast.success('삭제되었습니다.')
      navigate('/notices')
    } catch (e) {
      toast.error(e.message || '삭제 실패')
    }
  }

  const hasLegacyAttachments =
    Array.isArray(post.attachments) && post.attachments.length > 0

  return (
    <div className="p-6 space-y-4 max-w-[1500px] mx-auto w-full">
      <Button variant="ghost" size="sm" asChild className="-ml-2 h-7">
        <Link to="/notices">
          <ArrowLeft className="mr-1 h-3.5 w-3.5" />
          목록으로
        </Link>
      </Button>

      {editing ? (
        <PostEditor
          post={post}
          onSaved={() => {
            reload()
            setEditing(false)
            toast.success('수정되었습니다.')
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <Card>
          <CardContent className="space-y-3 py-4">
            <div className="flex items-start gap-2 flex-wrap">
              {post.pinned && (
                <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                  <Pin className="h-3 w-3" />
                  상단 고정
                </span>
              )}
              {isAdmin && (
                <div className="ml-auto flex items-center gap-1">
                  <Button size="sm" variant="ghost" className="h-7" onClick={handleTogglePin}>
                    <Pin className="mr-1 h-3 w-3" />
                    {post.pinned ? '고정 해제' : '상단 고정'}
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7" onClick={() => setEditing(true)}>
                    <Pencil className="mr-1 h-3 w-3" />
                    수정
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-destructive"
                    onClick={() => setConfirmDelete(true)}
                  >
                    <Trash2 className="mr-1 h-3 w-3" />
                    삭제
                  </Button>
                </div>
              )}
            </div>
            <h2 className="text-xl font-semibold">{post.title}</h2>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span>{post.author?.name ?? '—'}</span>
              <span>·</span>
              <span className="tabular-nums">{noticeDateTime(post.created_at)}</span>
              {hasLegacyAttachments && (
                <>
                  <span>·</span>
                  <span className="inline-flex items-center gap-0.5">
                    <Paperclip className="h-3 w-3" />
                    {post.attachments.length}
                  </span>
                </>
              )}
            </div>
            {post.body && (
              <div className="border-t pt-3">
                <AuthedRichText editable={false} value={post.body} />
              </div>
            )}
            {hasLegacyAttachments && (
              <div className="border-t pt-3">
                <NoticeImages attachments={post.attachments} />
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="공지 삭제"
        description="이 공지가 삭제됩니다."
        confirmLabel="삭제"
        destructive
        onConfirm={handleDelete}
      />
    </div>
  )
}

function PostEditor({ post, onSaved, onCancel }) {
  const [title, setTitle] = useState(post.title)
  const [body, setBody] = useState(post.body ?? '')
  const [pinned, setPinned] = useState(post.pinned === true)
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    setSaving(true)
    try {
      // attachments 는 보내지 않는다(부분 업데이트) — 구버전 첨부는 그대로 보존.
      await updateNotice(post.id, { title, body, pinned })
      onSaved()
    } catch (e) {
      toast.error(e.message || '저장 실패')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="space-y-1.5">
          <Label>제목</Label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>내용</Label>
          <AuthedRichText value={body} onChange={setBody} />
        </div>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={pinned}
            onChange={(e) => setPinned(e.target.checked)}
          />
          상단 고정
        </label>
        <div className="flex justify-end gap-1.5 pt-2">
          <Button variant="outline" onClick={onCancel}>
            <X className="mr-1 h-3 w-3" />
            취소
          </Button>
          <Button onClick={handleSave} disabled={saving || !title.trim()}>
            <Save className="mr-1 h-3 w-3" />
            저장
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
