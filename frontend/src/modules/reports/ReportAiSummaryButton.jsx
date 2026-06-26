import { useEffect, useState } from 'react'
import { Sparkles, RotateCw, X, Plus } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Textarea } from '@/shared/components/ui/textarea'
import { Label } from '@/shared/components/ui/label'
import {
  getReportAiSummary,
  bulkAiSummary,
  applyAiSummary,
} from '@/modules/reports/api'
import { listReportTypes } from '@/shared/api/reportTypes'
import { useAuth } from '@/shared/auth/AuthContext'

/**
 * 헤더 "i" 옆 "AI 요약" 버튼 (B). 클릭 시 모달로 요약을 보여주고, 편집 가능자
 * (canEdit)에겐 **검토·수정·적용** 섹션을 제공 — 추천 태그/분류는 자동 반영이
 * 아니라 사람이 수정 후 적용한다. 요약 없으면 버튼 자체 렌더 안 함.
 */
export function ReportAiSummaryButton({ reportId, canEdit = false }) {
  const { me } = useAuth()
  const canRegenerate = !!me?.ai_features?.includes('auto_summary')
  const [data, setData] = useState(null) // null=없음/미로딩
  const [open, setOpen] = useState(false)
  const [regenerating, setRegenerating] = useState(false)

  // 검토·적용 상태
  const [reviewing, setReviewing] = useState(false)
  const [editSummary, setEditSummary] = useState('')
  const [applyTags, setApplyTags] = useState([])
  const [newTag, setNewTag] = useState('')
  const [reportTypes, setReportTypes] = useState([])
  const [reportTypeId, setReportTypeId] = useState('')
  const [applyType, setApplyType] = useState(false)
  const [applying, setApplying] = useState(false)

  useEffect(() => {
    if (reportId == null) return undefined
    let cancelled = false
    getReportAiSummary(reportId)
      .then((d) => !cancelled && setData(d))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [reportId])

  async function openReview() {
    // 추천값을 편집 가능한 상태로 시드.
    setEditSummary(data.summary || '')
    setApplyTags([...(data.tags ?? [])])
    setApplyType(false)
    setReportTypeId('')
    setReviewing(true)
    try {
      const res = await listReportTypes({ limit: 200 })
      const types = res?.items ?? res ?? []
      setReportTypes(types)
      // 추천 분류 이름과 일치하는 종류가 있으면 미리 선택.
      const match = data.suggested_category
        ? types.find(
            (t) =>
              (t.name || '').trim() === data.suggested_category.trim(),
          )
        : null
      if (match) {
        setReportTypeId(String(match.id))
        setApplyType(true)
      }
    } catch {
      setReportTypes([])
    }
  }

  async function handleApply() {
    setApplying(true)
    try {
      await applyAiSummary(reportId, {
        summary: editSummary !== (data.summary || '') ? editSummary : undefined,
        tags: applyTags,
        reportTypeId: applyType && reportTypeId ? Number(reportTypeId) : null,
        setReportType: applyType,
      })
      toast.success('적용되었습니다.')
      // 화면 갱신을 위해 요약 다시 로드.
      try {
        setData(await getReportAiSummary(reportId))
      } catch {
        /* noop */
      }
      setReviewing(false)
    } catch (e) {
      toast.error(e?.response?.data?.message || e?.message || '적용 실패')
    } finally {
      setApplying(false)
    }
  }

  async function handleRegenerate() {
    setRegenerating(true)
    try {
      await bulkAiSummary([reportId])
      toast.success('요약을 다시 생성 요청했습니다 — 잠시 후 갱신됩니다.')
      setOpen(false)
    } catch (e) {
      toast.error(e?.response?.data?.message || e?.message || '요청 실패')
    } finally {
      setRegenerating(false)
    }
  }

  if (!data || !data.summary) return null

  const hasMeta = data.tags?.length > 0 || data.suggested_category

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="AI 자동 요약 보기"
        className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-medium text-violet-600 hover:bg-violet-500/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring dark:text-violet-400"
      >
        <Sparkles className="h-3 w-3" />
        AI 요약
      </button>

      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o)
          if (!o) setReviewing(false)
        }}
      >
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-violet-500" /> AI 요약
            </DialogTitle>
            <DialogDescription>
              B300이 본문에서 자동 생성한 요약입니다. 태그·분류는 추천이며,
              검토·수정 후 적용해야 보고서에 반영됩니다.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
              {data.summary}
            </p>
            {hasMeta && (
              <div className="flex flex-wrap items-center gap-1 border-t pt-3">
                {data.suggested_category && (
                  <span className="rounded-full border border-dashed px-2 py-0.5 text-[11px] text-muted-foreground">
                    분류 추천: {data.suggested_category}
                  </span>
                )}
                {(data.tags ?? []).map((t) => (
                  <span
                    key={t}
                    className="rounded-full border border-dashed px-2 py-0.5 text-[11px] text-muted-foreground"
                  >
                    {t}
                  </span>
                ))}
                <span className="text-[10px] text-muted-foreground/70">
                  · 추천(미적용)
                </span>
              </div>
            )}

            {/* 검토·수정·적용 — 편집 가능자만. */}
            {canEdit && reviewing && (
              <div className="space-y-3 rounded-md border bg-muted/20 p-3">
                <div>
                  <Label className="text-xs">요약 (수정 가능)</Label>
                  <Textarea
                    value={editSummary}
                    onChange={(e) => setEditSummary(e.target.value)}
                    rows={3}
                    className="mt-1 text-sm"
                  />
                </div>

                <div>
                  <Label className="text-xs">적용할 태그 (수정·추가·삭제)</Label>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {applyTags.length === 0 && (
                      <span className="text-[11px] text-muted-foreground">
                        적용할 태그 없음
                      </span>
                    )}
                    {applyTags.map((t) => (
                      <span
                        key={t}
                        className="inline-flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-[11px]"
                      >
                        {t}
                        <button
                          type="button"
                          onClick={() =>
                            setApplyTags((prev) => prev.filter((x) => x !== t))
                          }
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <X className="h-2.5 w-2.5" />
                        </button>
                      </span>
                    ))}
                  </div>
                  <div className="mt-1.5 flex gap-1">
                    <Input
                      value={newTag}
                      onChange={(e) => setNewTag(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          const v = newTag.trim()
                          if (v && !applyTags.includes(v))
                            setApplyTags((prev) => [...prev, v])
                          setNewTag('')
                        }
                      }}
                      placeholder="태그 추가 후 Enter"
                      className="h-8 text-xs"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        const v = newTag.trim()
                        if (v && !applyTags.includes(v))
                          setApplyTags((prev) => [...prev, v])
                        setNewTag('')
                      }}
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>

                <div>
                  <label className="flex items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      checked={applyType}
                      onChange={() => setApplyType((v) => !v)}
                      className="h-3.5 w-3.5"
                    />
                    보고서 종류(분류) 적용
                  </label>
                  {applyType && (
                    <select
                      value={reportTypeId}
                      onChange={(e) => setReportTypeId(e.target.value)}
                      className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-xs"
                    >
                      <option value="">선택 안 함(해제)</option>
                      {reportTypes.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="gap-2">
            {canEdit && !reviewing && (
              <Button variant="default" size="sm" onClick={openReview}>
                검토·적용
              </Button>
            )}
            {canEdit && reviewing && (
              <Button
                variant="default"
                size="sm"
                onClick={handleApply}
                disabled={applying}
              >
                {applying ? '적용 중…' : '적용'}
              </Button>
            )}
            {canRegenerate && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleRegenerate}
                disabled={regenerating}
              >
                <RotateCw className="mr-1 h-3.5 w-3.5" />
                {regenerating ? '요청 중…' : '다시 생성'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
