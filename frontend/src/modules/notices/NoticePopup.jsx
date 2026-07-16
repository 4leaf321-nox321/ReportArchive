import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Megaphone, Pin } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import { Button } from '@/shared/components/ui/button'
import { useAuth } from '@/shared/auth/AuthContext'
import { getNoticePopup, markNoticePopupSeen } from '@/shared/api/notices'
import { noticeDateTime } from './constants'
import { NoticeImages } from './NoticeImages'
import { AuthedRichText } from '@/shared/rich-text/AuthedRichText'

/** 접속 시 팝업 공지를 1회 노출. '봤음' 상태는 서버(사용자별)에 저장되므로
 *  기기·브라우저가 바뀌어도 한 번만 뜬다. 서버가 '가장 최근 공지가 아직
 *  확인 전일 때만' 1건을 돌려주므로(정책=마지막 1건), 기존 공지가 한꺼번에
 *  뜨지 않는다. AppShell 에 마운트되어 인증된 화면 전역에서 동작. */
export function NoticePopup() {
  const { me } = useAuth()
  const uid = me?.user?.id
  const navigate = useNavigate()
  const [notice, setNotice] = useState(null)

  // uid 가 바뀔 때만(로그인·로그아웃·사용자 전환) 조회. deps 가 uid 하나뿐이라
  // 화면 전환으로는 재실행되지 않는다(AppShell 은 세션 중 remount 안 됨).
  // 서버가 이미 '확인 처리(seen)'된 공지는 null 로 돌려주므로 재조회돼도
  // 중복 팝업은 없다 — 그래서 별도 1회 가드(ref) 없이도 안전하다.
  useEffect(() => {
    setNotice(null) // 사용자 전환 시 이전 팝업 즉시 제거
    if (!uid) return

    let active = true
    getNoticePopup()
      .then((data) => {
        if (active && data) setNotice(data)
      })
      .catch(() => {
        /* 공지 조회 실패는 조용히 무시 — 팝업은 부가 기능 */
      })
    return () => {
      active = false
    }
  }, [uid])

  if (!notice) return null

  function dismiss() {
    const id = notice.id
    setNotice(null)
    // 서버에 확인 기록 — 실패해도 UX 를 막지 않음(다음 접속에 다시 뜰 뿐).
    markNoticePopupSeen(id).catch(() => {})
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) dismiss() }}>
      <DialogContent className="max-w-lg max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Megaphone className="h-4 w-4 text-primary shrink-0" />
            <span className="truncate">{notice.title}</span>
            {notice.pinned && (
              <Pin className="h-3.5 w-3.5 text-primary shrink-0" />
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="overflow-y-auto pr-1 space-y-3">
          <div className="text-xs text-muted-foreground">
            {notice.author?.name ?? '—'} ·{' '}
            <span className="tabular-nums">{noticeDateTime(notice.created_at)}</span>
          </div>
          {notice.body && <AuthedRichText editable={false} value={notice.body} />}
          <NoticeImages attachments={notice.attachments} className="pt-1" />
        </div>

        <DialogFooter className="flex-row items-center justify-end gap-1.5">
          <Button
            variant="outline"
            onClick={() => {
              const id = notice.id
              dismiss()
              navigate(`/notices/${id}`)
            }}
          >
            자세히 보기
          </Button>
          <Button onClick={dismiss}>확인</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
