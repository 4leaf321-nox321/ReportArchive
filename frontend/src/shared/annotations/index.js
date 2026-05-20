/**
 * Public surface of the annotation system. Host widgets import from
 * here; the per-module file structure is an implementation detail.
 */
export {
  ANNOTATION_TYPES,
  COORD_SPACES,
  LABEL_POSITIONS,
  BORDER_STYLES,
  Z_ORDERS,
  createAnnotation,
  defaultGeometryFor,
  generateAnnotationId,
  geometryFields,
  normalizeGeometry,
  validateAnnotation,
  withGeometry,
} from './types'

export { useAnnotationStore } from './store'
export { useAnnotationInteractions } from './useAnnotationInteractions'
export { AnnotationLabelEditor } from './AnnotationLabelEditor'
export { AnnotationStyleBar } from './AnnotationStyleBar'
export { AnnotationCountBadge } from './AnnotationCountBadge'
export { SelectionMarquee } from './SelectionMarquee'
export { labelPositionFor } from './labelPosition'

export { AnnotationLayer, AnnotationContents } from './AnnotationLayer'

export {
  AnnotationToolbar,
  isClickTool,
  isDragTool,
} from './AnnotationToolbar'

export { InteractiveCaptureRect } from './InteractiveCaptureRect'
export { InteractiveOverlay } from './InteractiveOverlay'

export {
  createChartAxesCapture,
  useChartAxesCapture,
} from './ChartAnnotationAdapter'

export { useImageAnnotationAdapter } from './ImageAnnotationAdapter'
