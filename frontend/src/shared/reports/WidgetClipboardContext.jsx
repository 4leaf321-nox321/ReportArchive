import { createContext, useContext, useMemo, useState } from 'react'

// 위젯(블록) 복사/잘라내기/붙여넣기용 단일 슬롯 클립보드 — 공유 컨텍스트.
//
// 원래는 ReportDetailPage 의 로컬 state 였는데, 분할 보기에서 우측(읽기전용)
// 패널의 위젯을 좌측 편집창에 붙여넣으려면 두 패널이 같은 클립보드를 봐야 한다.
// 우측 패널과 좌측 에디터는 서로 다른 컴포넌트 트리라 로컬 state 로는 공유가
// 안 되므로 AppShell 위(AuthedShell)에 provider 를 둔다.
//
// clip = { type, props, content, layout, section, cutSource } | null
//   - 효과(effective) 스냅샷: props/content/layout/section 이 병합돼 있어
//     붙여넣는 쪽이 self-contained extra block 으로 그대로 추가할 수 있다.
//   - cutSource: 잘라내기 출처(첫 붙여넣기 후 슬롯 비움). 복사는 null.

const WidgetClipboardContext = createContext(null)

export function WidgetClipboardProvider({ children }) {
  const [clip, setClip] = useState(null)
  const value = useMemo(() => ({ clip, setClip }), [clip])
  return (
    <WidgetClipboardContext.Provider value={value}>
      {children}
    </WidgetClipboardContext.Provider>
  )
}

export function useWidgetClipboard() {
  const ctx = useContext(WidgetClipboardContext)
  if (!ctx) {
    throw new Error('useWidgetClipboard must be used within WidgetClipboardProvider')
  }
  return ctx
}
