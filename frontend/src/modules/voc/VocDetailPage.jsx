import { useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Loader2, Paperclip, Pencil, Save, Trash2, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { Badge } from '@/shared/components/ui/badge'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { Textarea } from '@/shared/components/ui/textarea'
import { Card, CardContent } from '@/shared/components/ui/card'
import { AuthedImage } from '@/shared/components/AuthedImage'
import { ErrorState } from '@/shared/components/ErrorState'
import { uploadFile } from '@/shared/api/files'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { ConfirmDialog } from '@/shared/components/ConfirmDialog'
import { useAuth } from '@/shared/auth/AuthContext'
import { useAsync } from '@/shared/hooks/useAsync'
import {
  addVocComment,
  deleteVocComment,
  deleteVocPost,
  getVocPost,
  setVocPriority,
  setVocStatus,
  updateVocComment,
  updateVocPost,
} from '@/shared/api/voc'
import {
  VOC_CATEGORIES,
  VOC_CATEGORY_BY,
  VOC_PRIORITIES,
  VOC_PRIORITY_BY,
  VOC_STATUSES,
  VOC_STATUS_BY,
  vocDateTime,
} from './constants'

/** VOC detail — post body + comment thread. Author can edit/delete own
 *  content; admin can edit/delete anything plus change status/priority
 *  (triage). Non-admins see status/priority as read-only chips. */
export default function VocDetailPage() {
  const { postId } = useParams()
  const navigate = useNavigate()
  const { me } = useAuth()
  // VOC moderation is a system-operator task (resolving/deleting
  // others' posts). Backend gates on is_system_admin; mirror here.
  const isAdmin = me?.is_system_admin === true
  const userId = me?.user?.id

  const { data: post, loading, error, reload } = useAsync(
    () => getVocPost(postId),
    [postId],
  )
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  if (loading) return <div className="p-6"><Skeleton className="h-96" /></div>
  if (error) return <div className="p-6"><ErrorState description={error.message} onRetry={reload} /></div>
  if (!post) return null

  const isAuthor = post.author?.id === userId
  const canEdit = isAdmin || isAuthor

  async function handleStatusChange(next) {
    try {
      await setVocStatus(post.id, next)
      reload()
      toast.success(`상태: ${VOC_STATUS_BY[next].label}`)
    } catch (e) {
      toast.error(e.message || '실패')
    }
  }
  async function handlePriorityChange(next) {
    try {
      await setVocPriority(post.id, next)
      reload()
      toast.success(`우선순위: ${VOC_PRIORITY_BY[next].label}`)
    } catch (e) {
      toast.error(e.message || '실패')
    }
  }
  async function handleDelete() {
    try {
      await deleteVocPost(post.id)
      toast.success('삭제되었습니다.')
      navigate('/voc')
    } catch (e) {
      toast.error(e.message || '삭제 실패')
    }
  }

  return (
    <div className="p-6 space-y-4 max-w-4xl mx-auto w-full">
      <Button variant="ghost" size="sm" asChild className="-ml-2 h-7">
        <Link to="/voc">
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
              <div className="flex items-center gap-1.5">
                <Badge
                  variant={VOC_CATEGORY_BY[post.category]?.variant}
                  className="text-[10px]"
                >
                  {VOC_CATEGORY_BY[post.category]?.label ?? post.category}
                </Badge>
                <StatusControl
                  value={post.status}
                  editable={isAdmin}
                  onChange={handleStatusChange}
                />
                <PriorityControl
                  value={post.priority}
                  editable={isAdmin}
                  onChange={handlePriorityChange}
                />
              </div>
              <div className="ml-auto flex items-center gap-1">
                {canEdit && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7"
                    onClick={() => setEditing(true)}
                  >
                    <Pencil className="mr-1 h-3 w-3" />
                    수정
                  </Button>
                )}
                {canEdit && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-destructive"
                    onClick={() => setConfirmDelete(true)}
                  >
                    <Trash2 className="mr-1 h-3 w-3" />
                    삭제
                  </Button>
                )}
              </div>
            </div>
            <h2 className="text-xl font-semibold">{post.title}</h2>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span>{post.author?.name ?? '—'}</span>
              <span>·</span>
              <span className="tabular-nums">
                {vocDateTime(post.created_at)}
              </span>
              {post.workspace_slug && (
                <>
                  <span>·</span>
                  <span className="font-mono">{post.workspace_slug}</span>
                </>
              )}
              {Array.isArray(post.attachments) && post.attachments.length > 0 && (
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
              <div className="text-sm whitespace-pre-wrap leading-relaxed border-t pt-3">
                {post.body}
              </div>
            )}
            {Array.isArray(post.attachments) && post.attachments.length > 0 && (
              <AttachmentGallery attachments={post.attachments} />
            )}
          </CardContent>
        </Card>
      )}

      <CommentSection
        post={post}
        userId={userId}
        isAdmin={isAdmin}
        onChanged={() => reload()}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="VOC 글 삭제"
        description="이 글과 모든 댓글이 함께 삭제됩니다."
        confirmLabel="삭제"
        destructive
        onConfirm={handleDelete}
      />
    </div>
  )
}

function StatusControl({ value, editable, onChange }) {
  const cur = VOC_STATUS_BY[value]
  if (!editable) {
    return (
      <Badge variant={cur?.variant} className="text-[10px]" title="관리자만 변경 가능">
        {cur?.label ?? value}
      </Badge>
    )
  }
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-5 text-[10px] rounded border border-input bg-background px-1"
      title="상태 변경 (관리자)"
    >
      {VOC_STATUSES.map((s) => (
        <option key={s.value} value={s.value}>
          {s.label}
        </option>
      ))}
    </select>
  )
}

function PriorityControl({ value, editable, onChange }) {
  const cur = VOC_PRIORITY_BY[value]
  if (!editable) {
    if (value === 'normal') return null
    return (
      <Badge variant={cur?.variant} className="text-[10px]" title="관리자만 변경 가능">
        {cur?.label ?? value}
      </Badge>
    )
  }
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-5 text-[10px] rounded border border-input bg-background px-1"
      title="우선순위 변경 (관리자)"
    >
      {VOC_PRIORITIES.map((p) => (
        <option key={p.value} value={p.value}>
          {p.label}
        </option>
      ))}
    </select>
  )
}

function PostEditor({ post, onSaved, onCancel }) {
  const [title, setTitle] = useState(post.title)
  const [body, setBody] = useState(post.body ?? '')
  const [category, setCategory] = useState(post.category)
  const [attachments, setAttachments] = useState(
    Array.isArray(post.attachments) ? post.attachments : [],
  )
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const fileInputRef = useRef(null)

  async function handleFiles(fileList) {
    const incoming = Array.from(fileList || []).filter((f) => {
      if (!f.type.startsWith('image/')) {
        toast.error(`이미지 파일만 가능: ${f.name}`)
        return false
      }
      return true
    })
    if (incoming.length === 0) return
    setUploading(true)
    try {
      const next = []
      for (const file of incoming) {
        const meta = await uploadFile(file)
        next.push({
          file_id: meta.id,
          filename: file.name,
          size: file.size,
          mime_type: file.type,
        })
      }
      setAttachments((prev) => [...prev, ...next])
    } catch (e) {
      toast.error(e.message || '업로드 실패')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  function onPaste(e) {
    const items = Array.from(e.clipboardData?.items ?? [])
    const imageFiles = items
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter(Boolean)
    if (imageFiles.length === 0) return
    e.preventDefault()
    handleFiles(imageFiles)
  }

  async function handleSave() {
    setSaving(true)
    try {
      await updateVocPost(post.id, { title, body, category, attachments })
      onSaved()
    } catch (e) {
      toast.error(e.message || '저장 실패')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardContent className="space-y-3 py-4" onPaste={onPaste}>
        <div className="space-y-1.5">
          <Label>제목</Label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>분류</Label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
          >
            {VOC_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label>내용</Label>
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            className="min-h-[180px]"
          />
        </div>
        <div className="space-y-1.5">
          <Label>첨부 이미지</Label>
          {attachments.length > 0 && (
            <div className="grid grid-cols-3 gap-2">
              {attachments.map((a, i) => (
                <div
                  key={`${a.file_id}-${i}`}
                  className="relative aspect-video bg-muted/40 rounded-md border overflow-hidden group"
                  title={a.filename}
                >
                  <AuthedImage
                    fileId={a.file_id}
                    alt={a.filename}
                    className="absolute inset-0 w-full h-full object-cover"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setAttachments((prev) => prev.filter((_, j) => j !== i))
                    }
                    className="absolute top-1 right-1 h-5 w-5 rounded-full bg-background/90 text-destructive border flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <X className="h-3 w-3" />
                  </button>
                  <div className="absolute bottom-0 left-0 right-0 bg-background/80 px-1 py-0.5 text-[9px] truncate">
                    {a.filename}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
            >
              {uploading ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <Upload className="mr-1 h-3 w-3" />
              )}
              파일 추가
            </Button>
            <span className="text-[10px] text-muted-foreground">
              또는 Ctrl+V 로 클립보드 이미지 붙여넣기
            </span>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => handleFiles(e.target.files)}
            />
          </div>
        </div>
        <div className="flex justify-end gap-1.5 pt-2">
          <Button variant="outline" onClick={onCancel}>
            <X className="mr-1 h-3 w-3" />
            취소
          </Button>
          <Button onClick={handleSave} disabled={saving || uploading || !title.trim()}>
            <Save className="mr-1 h-3 w-3" />
            저장
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function AttachmentGallery({ attachments }) {
  return (
    <div className="border-t pt-3 space-y-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
        첨부 이미지 ({attachments.length})
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        {attachments.map((a, i) => (
          <a
            key={`${a.file_id}-${i}`}
            // Open the raw file in a new tab — the API requires auth so
            // we route through the same blob fetch the inline preview
            // uses. Click-to-zoom would be nicer; left as a follow-up.
            href={`/api/files/${a.file_id}`}
            target="_blank"
            rel="noreferrer"
            className="relative aspect-video bg-muted/40 rounded-md border overflow-hidden hover:ring-2 hover:ring-primary/40 transition-shadow"
            title={a.filename}
          >
            <AuthedImage
              fileId={a.file_id}
              alt={a.filename}
              className="absolute inset-0 w-full h-full object-cover"
            />
            <div className="absolute bottom-0 left-0 right-0 bg-background/80 px-1.5 py-0.5 text-[10px] truncate">
              {a.filename}
            </div>
          </a>
        ))}
      </div>
    </div>
  )
}

function CommentSection({ post, userId, isAdmin, onChanged }) {
  const [body, setBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const comments = post.comments ?? []

  async function handleAdd() {
    if (!body.trim()) return
    setSubmitting(true)
    try {
      await addVocComment(post.id, body)
      setBody('')
      onChanged()
    } catch (e) {
      toast.error(e.message || '댓글 등록 실패')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          댓글 ({comments.length})
        </div>
        {comments.length === 0 ? (
          <div className="text-[12px] text-muted-foreground py-4 text-center">
            아직 댓글이 없습니다.
          </div>
        ) : (
          <ul className="divide-y">
            {comments.map((c) => (
              <CommentRow
                key={c.id}
                comment={c}
                isAdmin={isAdmin}
                userId={userId}
                onChanged={onChanged}
              />
            ))}
          </ul>
        )}
        <div className="space-y-1.5 pt-2 border-t">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="댓글 작성"
            className="min-h-[60px] text-sm"
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={handleAdd}
              disabled={submitting || !body.trim()}
            >
              {submitting ? '등록 중…' : '등록'}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function CommentRow({ comment, isAdmin, userId, onChanged }) {
  const [editing, setEditing] = useState(false)
  const [body, setBody] = useState(comment.body)
  const canEdit = isAdmin || comment.author?.id === userId

  async function handleSave() {
    try {
      await updateVocComment(comment.id, body)
      setEditing(false)
      onChanged()
      toast.success('수정되었습니다.')
    } catch (e) {
      toast.error(e.message || '수정 실패')
    }
  }
  async function handleDelete() {
    try {
      await deleteVocComment(comment.id)
      onChanged()
      toast.success('삭제되었습니다.')
    } catch (e) {
      toast.error(e.message || '삭제 실패')
    }
  }

  return (
    <li className="py-3 space-y-1.5">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{comment.author?.name ?? '—'}</span>
        <span className="tabular-nums">{vocDateTime(comment.created_at)}</span>
        {comment.updated_at !== comment.created_at && (
          <span className="text-[10px]">(수정됨)</span>
        )}
        {canEdit && !editing && (
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="hover:text-foreground"
            >
              수정
            </button>
            <span>·</span>
            <button
              type="button"
              onClick={handleDelete}
              className="hover:text-destructive"
            >
              삭제
            </button>
          </div>
        )}
      </div>
      {editing ? (
        <div className="space-y-1.5">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            className="min-h-[60px] text-sm"
          />
          <div className="flex justify-end gap-1.5">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setEditing(false)
                setBody(comment.body)
              }}
            >
              취소
            </Button>
            <Button size="sm" onClick={handleSave} disabled={!body.trim()}>
              저장
            </Button>
          </div>
        </div>
      ) : (
        <div className="text-sm whitespace-pre-wrap leading-relaxed">{comment.body}</div>
      )}
    </li>
  )
}
