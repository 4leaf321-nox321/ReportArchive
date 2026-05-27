import { createContext, useContext, useMemo } from 'react'

/**
 * 보고서 단위로 결정되는 시각 스타일 묶음. 에디터 / InlineReportView /
 * 미리보기 등 보고서 콘텐츠를 렌더하는 곳을 감싼 Provider 에서 값을
 * 주입하고, 위젯(특히 RichText)이 `useReportStyle()` 로 읽는다.
 *
 * 현재 키:
 *   - depthGlyphs: 긴 글 위젯의 depth-별 머리 기호 override 배열.
 *     길이 3 (= depth 0 / 1 / 2). depth 2 글리프는 depth 2+ 모두에
 *     적용된다 (= 깊은 들여쓰기는 depth 2 값을 이어 씀). 각 칸이
 *     null/undefined 면 그 depth 만 위젯 기본 글리프로 폴백한다.
 *
 * 추가할 때 주의: 값을 객체 리터럴로 인라인 전달하면 매 렌더마다 새
 * 객체가 만들어져 Consumer 들이 불필요하게 리렌더된다. 아래
 * `useReportStyleValue()` 헬퍼로 안정적인 참조를 만들어 쓰자.
 */
export const ReportStyleContext = createContext({
  depthGlyphs: [null, null, null],
})

export function useReportStyle() {
  return useContext(ReportStyleContext)
}

/** Provider 측에서 한 줄로 안정적인 value 객체를 만들 때 쓰는 헬퍼.
 *  같은 입력에 대해 같은 참조를 돌려준다.
 *
 *  Args:
 *    depthGlyphs — `[g0, g1, g2]` 형태 (또는 더 짧은 배열). 각 원소가
 *      string non-empty 면 그 값을 trim 해서 채택, 아니면 null. 길이가
 *      3 보다 짧으면 모자란 자리는 null 로 패딩한다. */
export function useReportStyleValue({ depthGlyphs }) {
  const g0 = depthGlyphs?.[0]
  const g1 = depthGlyphs?.[1]
  const g2 = depthGlyphs?.[2]
  return useMemo(() => {
    const norm = (v) =>
      typeof v === 'string' && v.trim() !== '' ? v.trim() : null
    return { depthGlyphs: [norm(g0), norm(g1), norm(g2)] }
  }, [g0, g1, g2])
}
