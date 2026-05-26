/** 추가 편집자 관리 다이얼로그 — Phase 3.
 *
 *  보고서의 "추가 편집자" (ReportEditor) 그랜트를 본다 / 추가 / 제거.
 *  명시 grant는 보직장 자동 권한 + coauthor 정책의 escape hatch — 한
 *  보고서에만 적용되고 lock에는 막힘.
 *
 *  Owner-only 작업이지만 목록 자체는 누구나 볼 수 있어야 "왜 김부장이
 *  편집권을 가진거지?" 추적이 가능. 그래서 readOnly 모드를 분기.
 */
import * as React from 'react'
import { Loader2, Search, UserPlus, X } from 'lucide-react'
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
import { toast } from 'sonner'
import {
  addReportEditor,
  listReportEditors,
  removeReportEditor,
} from '@/shared/api/editors'
import { searchUsers } from '@/shared/api/members'
import { useAuth } from '@/shared/auth/AuthContext'

export function EditorsDialog({ open, onOpenChange, report, onChanged }) {
  const { me } = useAuth()
  const isOwner = me?.user?.id && report?.owner_user_id === me.user.id
  const [editors, setEditors] = React.useState([])
  const [loading, setLoading] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [results, setResults] = React.useState([])
  const [searching, setSearching] = React.useState(false)

  React.useEffect(() => {
    if (!open || !report?.id) return
    let cancelled = false
    setLoading(true)
    listReportEditors(report.id)
      .then((items) => {
        if (!cancelled) setEditors(items)
      })
      .catch((e) => {
        if (!cancelled)
          toast.error(e?.response?.data?.message || '편집자 조회 실패')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, report?.id])

  // Debounced user search. Owner-only — readers don't get the picker.
  React.useEffect(() => {
    if (!isOwner) return
    if (!query.trim()) {
      setResults([])
      return
    }
    let cancelled = false
    setSearching(true)
    const t = setTimeout(async () => {
      try {
        const data = await searchUsers({ search: query.trim(), limit: 10 })
        if (cancelled) return
        const items = Array.isArray(data) ? data : data?.items ?? []
        // Exclude owner + already-listed editors
        const existing = new Set(editors.map((e) => e.id))
        existing.add(report.owner_user_id)
        setResults(items.filter((u) => !existing.has(u.id)))
      } catch {
        if (!cancelled) setResults([])
      } finally {
        if (!cancelled) setSearching(false)
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [query, editors, isOwner, report?.owner_user_id])

  async function handleAdd(user) {
    try {
      await addReportEditor(report.id, user.id)
      setEditors((arr) => [
        ...arr,
        {
          id: user.id,
          name: user.name,
          email: user.email,
          added_at: new Date().toISOString(),
          added_by_user_id: me?.user?.id ?? null,
        },
      ])
      setQuery('')
      setResults([])
      toast.success(`${user.name ?? user.email}를 추가 편집자로 등록`)
      onChanged?.()
    } catch (e) {
      toast.error(e?.response?.data?.message || '편집자 추가 실패')
    }
  }

  async function handleRemove(user) {
    const prev = editors
    setEditors((arr) => arr.filter((e) => e.id !== user.id))
    try {
      await removeReportEditor(report.id, user.id)
      toast.success(`${user.name ?? user.email}의 편집권 해제`)
      onChanged?.()
    } catch (e) {
      setEditors(prev)
      toast.error(e?.response?.data?.message || '편집권 해제 실패')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>추가 편집자 관리</DialogTitle>
          <DialogDescription>
            보직장 자동 권한과 별개로, 특정 사용자에게 이 보고서 편집권을
            줍니다. 작성자 잠금 시엔 추가 편집자도 차단됩니다.
            {!isOwner && (
              <span className="block mt-1 text-amber-600">
                작성자만 추가/제거할 수 있습니다 (열람만 가능).
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* Current editors */}
          <div>
            <label className="text-xs text-muted-foreground block mb-1.5">
              현재 추가 편집자 ({editors.length}명)
            </label>
            {loading ? (
              <div className="flex items-center text-sm text-muted-foreground py-3">
                <Loader2 className="h-4 w-4 animate-spin mr-2" /> 조회 중...
              </div>
            ) : editors.length === 0 ? (
              <div className="text-sm text-muted-foreground py-2 italic">
                추가 편집자 없음
              </div>
            ) : (
              <ul className="space-y-1">
                {editors.map((e) => (
                  <li
                    key={e.id}
                    className="flex items-center gap-2 rounded border px-2.5 py-1.5 text-sm"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="truncate font-medium">
                        {e.name ?? '(이름 없음)'}
                      </div>
                      {e.email && (
                        <div className="text-[11px] text-muted-foreground truncate">
                          {e.email}
                        </div>
                      )}
                    </div>
                    {isOwner && (
                      <button
                        type="button"
                        onClick={() => handleRemove(e)}
                        className="p-1 rounded hover:bg-red-100 hover:text-red-600"
                        title="편집권 해제"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Add picker (owner only) */}
          {isOwner && (
            <div className="border-t pt-3">
              <label className="text-xs text-muted-foreground block mb-1.5">
                편집자 추가
              </label>
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(ev) => setQuery(ev.target.value)}
                  placeholder="이름 또는 이메일로 검색"
                  className="pl-7 text-sm"
                />
              </div>
              {(searching || results.length > 0 || query.trim()) && (
                <div className="mt-1.5 max-h-48 overflow-y-auto border rounded">
                  {searching ? (
                    <div className="flex items-center text-xs text-muted-foreground p-2">
                      <Loader2 className="h-3 w-3 animate-spin mr-1.5" />
                      검색 중...
                    </div>
                  ) : results.length === 0 ? (
                    <div className="text-xs text-muted-foreground p-2 italic">
                      결과 없음
                    </div>
                  ) : (
                    results.map((u) => (
                      <button
                        key={u.id}
                        type="button"
                        onClick={() => handleAdd(u)}
                        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-sm hover:bg-muted/50 border-b last:border-b-0"
                      >
                        <UserPlus className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="truncate font-medium">{u.name}</div>
                          <div className="text-[11px] text-muted-foreground truncate">
                            {u.email}
                          </div>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            닫기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
