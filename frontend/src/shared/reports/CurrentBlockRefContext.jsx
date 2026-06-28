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

/**
 * Per-block section number ("1", "1.1", "1.1.1") for the *currently rendering*
 * heading block, when the report has 절 번호 자동매김 (page_heading_numbering)
 * on. Same threading model as CurrentBlockRefContext: the rendering parent sets
 * it from the whole-report heading-number map (buildHeadingNumbers); HeadingEditor
 * reads it to prefix the title — without threading through every widget.
 *
 * null when numbering is off, the block isn't a heading, or outside a report
 * context (template editor).
 */
export const CurrentBlockHeadingNumberContext = createContext(null)

export function useCurrentBlockHeadingNumber() {
  return useContext(CurrentBlockHeadingNumberContext)
}
