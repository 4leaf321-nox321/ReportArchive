// 본문 `#` 위젯 참조 링크를 클릭했을 때, 대상 위젯이 화면 밖/다른 페이지에
// 있으면 읽던 자리를 잃지 않도록 링크 옆에 띄우는 "흘끗 보기" 카드.
//
// 렌더는 ReportDetailPage 의 snapshotBlock(pageIndex, blockId) 결과
// ({ type, props, content })를 그대로 위젯 렌더러의 Editor 에 readOnly 로
// 먹인다 — 전체화면 뷰어(FullscreenWidgetDialog)와 동일한 경로라, 차트·표 등
// 어떤 위젯이든 그 자리에서 정확히 렌더된다. "위젯으로 이동" 을 누르면 실제
// 점프(+복귀 알약)로 넘어간다.
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, ArrowRight } from 'lucide-react'
import { getRenderer } from '@/modules/templates/widgets'

const NO_OP = () => {}
const MARGIN = 12
const PREVIEW_WIDTH = 420

const clamp = (n, min, max) => Math.max(min, Math.min(max, n))

// 카드 초기 박스(위치+크기). 앵커(클릭한 링크) 아래 공간이 좁으면 위로 펼치고,
// 뷰포트를 넘지 않게 클램프한다. (BlockRefPicker 의 computeBlockPickerBox 와
// 같은 전략 — 일관된 동작을 위해 의도적으로 닮게 둔다.)
function computePreviewBox(rect) {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
  const vh = typeof window !== 'undefined' ? window.innerHeight : 768
  const width = Math.min(PREVIEW_WIDTH, vw - 2 * MARGIN)
  const below = rect ? vh - rect.bottom - MARGIN : vh - 2 * MARGIN
  const above = rect ? rect.top - MARGIN : vh - 2 * MARGIN
  const useAbove = below < 280 && above > below
  const avail = Math.max(useAbove ? above : below, 220)
  const height = clamp(Math.min(440, avail), 200, vh - 2 * MARGIN)
  const left = clamp(
    rect ? rect.left : (vw - width) / 2,
    MARGIN,
    Math.max(MARGIN, vw - width - MARGIN),
  )
  const top = useAbove
    ? clamp((rect?.top ?? vh) - 6 - height, MARGIN, vh - height - MARGIN)
    : clamp((rect?.bottom ?? 0) + 6, MARGIN, vh - height - MARGIN)
  return { left, top, width, height }
}

export default function BlockRefPreview({
  snapshot, // { type, props, content } | null  (snapshotBlock 결과)
  label, // "그림 3"
  caption,
  pageIndex,
  anchorRect, // 클릭한 링크의 DOMRect
  onJump,
  onClose,
}) {
  const [box, setBox] = useState(() => computePreviewBox(anchorRect))
  useEffect(() => setBox(computePreviewBox(anchorRect)), [anchorRect])

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const renderer = snapshot ? getRenderer(snapshot.type) : null
  const Editor = renderer?.Editor

  return createPortal(
    <>
      {/* 바깥 클릭 시 닫힘. z-[60]/[61] 은 멘션 다이얼로그 패널과 동일 레이어. */}
      <div className="fixed inset-0 z-[60]" onMouseDown={onClose} />
      <div
        className="fixed z-[61] flex flex-col rounded-lg border bg-popover shadow-xl"
        style={{
          left: box.left,
          top: box.top,
          width: box.width,
          maxHeight: box.height,
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b shrink-0">
          <span className="shrink-0 text-xs font-semibold text-foreground">
            {label}
          </span>
          {caption && (
            <span className="truncate text-xs text-muted-foreground">
              {caption}
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted"
            title="닫기"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3 report-widget-body">
          {Editor ? (
            <Editor
              props={snapshot.props}
              content={snapshot.content}
              onChange={NO_OP}
              readOnly={true}
              autoFit={false}
            />
          ) : (
            <div className="py-6 text-center text-xs text-muted-foreground">
              미리볼 수 없는 위젯입니다.
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 px-3 py-2 border-t shrink-0">
          <span className="mr-auto text-[10px] text-muted-foreground">
            p.{(pageIndex ?? 0) + 1}
          </span>
          <button
            type="button"
            onClick={onJump}
            className="inline-flex items-center gap-1 rounded-md border bg-background px-2.5 py-1 text-xs font-medium hover:bg-muted"
            title="이 위젯이 있는 위치로 이동"
          >
            위젯으로 이동 <ArrowRight className="h-3 w-3" />
          </button>
        </div>
      </div>
    </>,
    document.body,
  )
}
