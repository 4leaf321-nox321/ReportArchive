import { createContext, useContext } from 'react'

/**
 * Multiplier applied to widget text sizes when the report is being
 * printed to PDF. Default is 1 (no change) — ReportDetailPage flips it
 * to the user's selected scale (e.g. 0.8, 1.1) right before invoking
 * window.print(), so SVG-rendered text (Recharts charts) re-renders
 * with the right font size. CSS-rendered text uses a sibling mechanism:
 * the `--print-scale` CSS variable, also set by ReportDetailPage.
 *
 * Kept as a tiny standalone module so the Chart widget can subscribe
 * without circular-importing ReportDetailPage.
 */
export const PrintScaleContext = createContext(1)

export function usePrintScale() {
  const value = useContext(PrintScaleContext)
  return Number.isFinite(value) && value > 0 ? value : 1
}
