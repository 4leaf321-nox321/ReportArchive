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

export { AnnotationLayer, AnnotationContents } from './AnnotationLayer'

export {
  createChartAxesCapture,
  useChartAxesCapture,
} from './ChartAnnotationAdapter'
