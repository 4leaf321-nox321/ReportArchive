import * as React from 'react'
import { Bell, Check, FileText, Sparkles, AlertTriangle } from 'lucide-react'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/shared/components/ui/sheet'
import { Button } from '@/shared/components/ui/button'
import { ScrollArea } from '@/shared/components/ui/scroll-area'
import { EmptyState } from '@/shared/components/EmptyState'
import { cn } from '@/shared/lib/utils'

const ICON = {
  report: FileText,
  ai: Sparkles,
  alert: AlertTriangle,
}

const MOCK_NOTIFS = [
  {
    id: 'n-1',
    kind: 'report',
    title: '검토 요청',
    message: '"개발 주간 보고 #3"이 검토 단계로 이동했습니다.',
    at: '5분 전',
    read: false,
  },
  {
    id: 'n-2',
    kind: 'ai',
    title: 'AI 작성 완료',
    message: '인시던트 보고 #1의 4개 섹션 생성이 완료되었습니다.',
    at: '1시간 전',
    read: false,
  },
  {
    id: 'n-3',
    kind: 'alert',
    title: '스키마 검증 실패',
    message: '월간 부서 요약 #2의 KPI 섹션이 검증 실패했습니다.',
    at: '어제',
    read: true,
  },
]

export function NotificationDrawer({ open, onOpenChange }) {
  const [items, setItems] = React.useState(MOCK_NOTIFS)
  const unread = items.filter((n) => !n.read).length

  function markAllRead() {
    setItems((xs) => xs.map((x) => ({ ...x, read: true })))
  }

  function clearAll() {
    setItems([])
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full max-w-sm p-0 flex flex-col">
        <SheetHeader className="border-b px-4 py-3 space-y-0">
          <div className="flex items-center justify-between">
            <SheetTitle className="text-base flex items-center gap-2">
              알림
              {unread > 0 && (
                <span className="rounded-full bg-primary text-primary-foreground text-[10px] px-1.5 py-0.5 font-mono">
                  {unread}
                </span>
              )}
            </SheetTitle>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" onClick={markAllRead} disabled={unread === 0}>
                <Check className="h-3 w-3 mr-1" />
                모두 읽음
              </Button>
            </div>
          </div>
          <SheetDescription className="text-xs">
            보고서 워크플로 / AI 작업 결과 알림 (mock)
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="flex-1">
          {items.length === 0 ? (
            <div className="p-6">
              <EmptyState icon={Bell} title="알림 없음" description="새 알림이 도착하면 여기에 표시됩니다." />
            </div>
          ) : (
            <ul className="divide-y">
              {items.map((n) => {
                const Icon = ICON[n.kind] ?? Bell
                return (
                  <li
                    key={n.id}
                    className={cn(
                      'px-4 py-3 hover:bg-muted/40 transition-colors',
                      !n.read && 'bg-primary/5'
                    )}
                  >
                    <div className="flex gap-3">
                      <div className="rounded-md bg-muted p-1.5 h-fit">
                        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium truncate">{n.title}</span>
                          {!n.read && (
                            <span className="h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">{n.message}</p>
                        <span className="text-[10px] text-muted-foreground mt-1 block">{n.at}</span>
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </ScrollArea>

        {items.length > 0 && (
          <div className="border-t p-3">
            <Button variant="outline" size="sm" className="w-full" onClick={clearAll}>
              모두 지우기
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
