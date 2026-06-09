import { createContext, useCallback, useContext, useMemo, useState } from 'react'

/**
 * 본문 @멘션(보고서 링크) 기능을 RichText 위젯에 주입하는 컨텍스트.
 *
 * RichText 위젯은 범용 컴포넌트라 host 보고서 id·네비게이션·관계 추가 함수를
 * 모른다. 보고서 상세 페이지에서 이 Provider 로 본문 트리를 감싸 그 값들을
 * 흘려보내고, 위젯(OutlineRow/OutlineView)이 `useReportMention()` 으로 읽는다.
 *
 * Provider 가 없는 곳(예: 템플릿 에디터 캔버스)에서는 `useReportMention()` 이
 * `null` 을 돌려주므로 @멘션 기능이 조용히 비활성된다.
 *
 * 값:
 *   - hostReportId : 현재(본) 보고서 id — 관계의 from 쪽.
 *   - enabled      : @ 트리거 활성 여부(편집 모드 + 편집 권한 + id 존재).
 *                    링크 *이동*은 enabled 와 무관하게 항상 동작해야 하므로
 *                    navigate 는 별도로 항상 제공한다.
 *   - navigate     : SPA 이동 함수(react-router). 뷰 모드 링크 클릭에 사용.
 *   - addLink      : useReportLinks().addLink — "연결된 보고서" 관계 생성.
 *   - popup        : 열린 멘션 작성 팝업 상태 | null. 모양:
 *       `{ rowIndex, anchorRect, atCaret, insert }`
 *     여기서 `insert(payload)` 는 **@를 친 바로 그 에디터/행에 바인딩된** 삽입
 *     함수다. 한 페이지에 RichText 위젯이 여러 개여도(각자 별도 OutlineEditor),
 *     트리거한 위젯이 자기 insert 를 페이로드에 실어 보내므로 전역 레지스트리
 *     없이 항상 올바른 위젯에 삽입된다. (예전엔 단일 inserter 를 공유해
 *     마지막 등록 위젯이 덮어쓰는 버그가 있었다.)
 *   - open/close   : 팝업 열기/닫기.
 */
export const ReportMentionContext = createContext(null)

export function useReportMention() {
  return useContext(ReportMentionContext)
}

export function ReportMentionProvider({
  hostReportId,
  // 현재(출발) 보고서 제목 — 멘션 이동 시 도착 화면의 "돌아가기" 라벨에 쓴다.
  hostReportTitle,
  enabled,
  navigate,
  addLink,
  // Cross-reference (`#` 위젯 참조) data, all derived from the live draft:
  //   - blockIndex          : Map<blockId, {label, n, category, caption, pageIndex}>
  //                           computed from whole-report document order.
  //   - referenceableBlocks : ordered array for the `#` picker.
  //   - scrollToBlock(id)   : jump to a block (switches page if needed).
  blockIndex,
  referenceableBlocks,
  scrollToBlock,
  // onBlockRefClick(pageIndex, blockId, anchorEl) — 본문 `#` 참조 링크 클릭의
  //   "스마트" 처리. 대상이 화면에 보이면 하이라이트만, 안 보이면 미리보기
  //   팝오버, "이동" 시 점프+복귀까지 호스트(보고서 상세)가 담당한다.
  //   Provider 가 안 주면 RichText 는 scrollToBlock 으로 폴백한다.
  onBlockRefClick,
  // onDeptMentionClick(slug, anchorEl) — 본문 @멘션의 "부서" 칩 클릭 시
  //   라우트 이동 대신 미리보기 팝오버를 띄운다(호스트가 담당). 없으면
  //   RichText 는 기존처럼 부서 보고서 목록으로 navigate 한다.
  onDeptMentionClick,
  children,
}) {
  const [popup, setPopup] = useState(null) // { rowIndex, anchorRect, atCaret, insert } | null

  const open = useCallback((payload) => setPopup(payload ?? null), [])
  const close = useCallback(() => setPopup(null), [])

  const value = useMemo(
    () => ({
      hostReportId: hostReportId ?? null,
      hostReportTitle: hostReportTitle ?? null,
      enabled: !!enabled,
      navigate: navigate ?? null,
      addLink: addLink ?? null,
      blockIndex: blockIndex ?? null,
      referenceableBlocks: referenceableBlocks ?? [],
      scrollToBlock: scrollToBlock ?? null,
      onBlockRefClick: onBlockRefClick ?? null,
      onDeptMentionClick: onDeptMentionClick ?? null,
      popup,
      open,
      close,
    }),
    [
      hostReportId,
      hostReportTitle,
      enabled,
      navigate,
      addLink,
      blockIndex,
      referenceableBlocks,
      scrollToBlock,
      onBlockRefClick,
      onDeptMentionClick,
      popup,
      open,
      close,
    ],
  )

  return (
    <ReportMentionContext.Provider value={value}>
      {children}
    </ReportMentionContext.Provider>
  )
}
