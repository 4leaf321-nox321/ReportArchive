import * as React from 'react'
import { useLocation, matchPath } from 'react-router-dom'
import { deleteReport, trashReport } from '@/modules/reports/api'
import {
  readPresetEditSession,
  clearPresetEditSession,
} from '@/shared/layout/presetEditSession'

const REPORT_PATH = '/w/:workspace/reports/:reportId'

function currentReportId(pathname) {
  const m = matchPath({ path: REPORT_PATH }, pathname)
  const rid = m?.params?.reportId
  return rid && /^\d+$/.test(rid) ? Number(rid) : null
}

/**
 * 프리셋 편집 세션 정리 watcher (UI 없음).
 *
 * 프리셋 "수정" 진입 시 만든 임시 보고서의 "프리셋 저장 / 돌아가기" 버튼은
 * ReportDetailPage 툴바(프리셋 편집 모드)가 담당한다. 이 컴포넌트는 사용자가 그
 * 버튼들 없이 임시 보고서를 떠났을 때(abandon — 사이드바·링크로 이동) 그 임시
 * 보고서를 정리한다. AppShell 상주라 보고서↔보고서 이동까지 잡는다.
 *
 * commit/cancel(에디터 툴바)은 navigate 전에 세션을 비우므로 여기서 중복
 * 삭제되지 않는다. 기존 보고서 저장(onSave)은 같은 경로에 머물러 오발동 없음.
 */
export function PresetEditBar() {
  const location = useLocation()
  React.useEffect(() => {
    const s = readPresetEditSession()
    if (!s) return
    if (currentReportId(location.pathname) !== s.reportId) {
      clearPresetEditSession()
      // 영구삭제 시도, 실패하면 휴지통으로 — 내 공간에 임시 보고서가 남지 않게.
      deleteReport(s.reportId).catch(() => {
        trashReport(s.reportId).catch(() => {})
      })
    }
  }, [location.pathname])
  return null
}
