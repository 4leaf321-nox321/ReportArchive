import { createContext, useContext } from 'react'

/**
 * Per-block reference label ("그림 3", "표 2") for the *currently rendering*
 * block. ReportDetailPage's BlockEditorCard sets this from the whole-report
 * numbering index; CaptionInput (rendered deep inside each widget) reads it to
 * prefix the caption — without threading the label through every widget.
 *
 * null when the block isn't referenceable (prose body, headings) or outside a
 * report context (template editor, exports).
 */
export const CurrentBlockRefContext = createContext(null)

export function useCurrentBlockRef() {
  return useContext(CurrentBlockRefContext)
}
