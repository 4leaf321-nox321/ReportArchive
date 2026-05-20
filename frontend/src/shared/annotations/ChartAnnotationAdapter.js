/**
 * Recharts → annotation-layer coordinate bridge.
 *
 * Recharts doesn't expose its computed scales through a public hook, but
 * it does expose them to children of `<Customized>` as named props
 * (`xAxisMap`, `yAxisMap`, `offset`). We use a tiny invisible
 * Customized child to harvest those maps into a ref that the host
 * component can read into an adapter object on each render.
 *
 *   const { CaptureAxes, buildAdapter } = createChartAxesCapture()
 *
 *   <ResponsiveContainer ...>
 *     <BarChart ...>
 *       <XAxis ... />
 *       <YAxis ... />
 *       <CaptureAxes />
 *     </BarChart>
 *   </ResponsiveContainer>
 *
 *   const adapter = buildAdapter({ supportedTypes: [...] })
 *
 * The returned adapter implements the AnnotationLayer contract:
 *   - toPx(geometry)   → pixel coords (per-field, matches geometry shape)
 *   - fromPx(px)       → data coords (per-field)
 *   - snap(value, axis)→ nearest data tick value
 *   - bounds           → { x, y, width, height } of the plot area
 *   - supportedTypes   → ['vline','vrange','hline','hrange','point','rect','arrow','text']
 *   - coordSpace       → 'data'
 */
import { useRef } from 'react'

/** Recharts' Customized receives (xAxisMap, yAxisMap, offset, ...) as
 *  props. We render nothing — just side-effect into the ref so the
 *  parent can read the scales after Recharts finishes layout. */
function makeCaptureComponent(ref) {
  function CaptureAxes(props) {
    // Recharts hands props with the internal maps. Treat the call as
    // a pure capture — no JSX, no DOM impact.
    ref.current = props
    return null
  }
  CaptureAxes.displayName = 'CaptureAxes'
  return CaptureAxes
}

/** Wraps {xAxisMap, yAxisMap, offset} into a usable scale pair. Recharts
 *  axis maps are keyed by axis id (default '0') so we pick the first
 *  entry — every chart in this app has a single x/y axis pair. */
function pickAxes(captured) {
  if (!captured) return null
  const xMap = captured.xAxisMap
  const yMap = captured.yAxisMap
  if (!xMap || !yMap) return null
  const xAxis = Object.values(xMap)[0]
  const yAxis = Object.values(yMap)[0]
  if (!xAxis?.scale || !yAxis?.scale) return null
  return { xAxis, yAxis, offset: captured.offset ?? null }
}

/** Try to read a numeric pixel from a scale. Categorical scales
 *  return undefined for unknown labels — caller treats that as "skip
 *  this annotation" so an orphaned reference doesn't crash render. */
function scaleToPx(scale, value) {
  if (scale == null) return NaN
  const out = scale(value)
  if (typeof out === 'number' && Number.isFinite(out)) {
    // For band scales (categorical x), Recharts' scale(x) returns the
    // bar's LEFT edge. Center it so annotations sit visually on the
    // category, not at its edge.
    if (typeof scale.bandwidth === 'function') {
      return out + scale.bandwidth() / 2
    }
    return out
  }
  return NaN
}

/** Inverse — pixel → data value. Continuous scales expose `.invert()`;
 *  band scales don't (we walk the domain looking for the nearest band
 *  start). */
function pxToData(scale, px) {
  if (scale == null || !Number.isFinite(px)) return null
  if (typeof scale.invert === 'function') {
    return scale.invert(px)
  }
  // Band scale fallback — pick the nearest category by center distance.
  if (typeof scale.domain === 'function' && typeof scale.bandwidth === 'function') {
    const domain = scale.domain()
    let best = null
    let bestDist = Infinity
    const half = scale.bandwidth() / 2
    for (const v of domain) {
      const left = scale(v)
      if (typeof left !== 'number') continue
      const center = left + half
      const d = Math.abs(center - px)
      if (d < bestDist) {
        bestDist = d
        best = v
      }
    }
    return best
  }
  return null
}

/** Snap a value to the nearest "tick" the axis natively has — for
 *  categorical scales that's the domain entry, for continuous scales
 *  we just return the value unchanged (caller can use fromPx → toPx
 *  round-trip to get pixel-perfect alignment in continuous space). */
function snapValue(scale, value) {
  if (scale == null) return value
  if (
    typeof scale.domain === 'function' &&
    typeof scale.bandwidth === 'function'
  ) {
    return value
  }
  return value
}

/** Build the capture component + a factory that turns captured scales
 *  into an adapter object suitable for AnnotationLayer.
 *
 *  `buildAdapter` reads the most-recent capture from the ref, so the
 *  caller MUST call it after Recharts has rendered (i.e. inside the
 *  same render pass as the chart, AFTER the <Customized> has had a
 *  chance to run). In practice every adapter consumer gets a fresh
 *  one on each render via useMemo([capture, deps]). */
export function createChartAxesCapture() {
  const ref = { current: null }
  const CaptureAxes = makeCaptureComponent(ref)
  function buildAdapter({ supportedTypes } = {}) {
    const axes = pickAxes(ref.current)
    if (!axes) return null
    const { xAxis, yAxis, offset } = axes
    // Recharts puts the plot rectangle inside the chart SVG at the
    // position described by xAxis.{x, width} and yAxis.{y, height}. We
    // surface those so the overlay SVG can pin itself to the same
    // pixel box — no manual margin guessing.
    const bounds = {
      x: xAxis.x ?? offset?.left ?? 0,
      y: yAxis.y ?? offset?.top ?? 0,
      width: xAxis.width ?? offset?.width ?? 0,
      height: yAxis.height ?? offset?.height ?? 0,
    }
    function toPx(geometry) {
      // Each annotation type's geometry has its own field set; just
      // translate every field that looks like an x/y coord. The
      // AnnotationLayer's per-type drawer pulls only what it needs.
      const out = {}
      if ('x' in geometry) out.x = scaleToPx(xAxis.scale, geometry.x)
      if ('y' in geometry) out.y = scaleToPx(yAxis.scale, geometry.y)
      if ('x_from' in geometry) out.x_from = scaleToPx(xAxis.scale, geometry.x_from)
      if ('x_to' in geometry) out.x_to = scaleToPx(xAxis.scale, geometry.x_to)
      if ('y_from' in geometry) out.y_from = scaleToPx(yAxis.scale, geometry.y_from)
      if ('y_to' in geometry) out.y_to = scaleToPx(yAxis.scale, geometry.y_to)
      if (geometry.from) {
        out.from = {
          x: scaleToPx(xAxis.scale, geometry.from.x),
          y: scaleToPx(yAxis.scale, geometry.from.y),
        }
      }
      if (geometry.to) {
        out.to = {
          x: scaleToPx(xAxis.scale, geometry.to.x),
          y: scaleToPx(yAxis.scale, geometry.to.y),
        }
      }
      return out
    }
    function fromPx(px) {
      const out = {}
      if ('x' in px) out.x = pxToData(xAxis.scale, px.x)
      if ('y' in px) out.y = pxToData(yAxis.scale, px.y)
      return out
    }
    function snap(value, axis) {
      const sc = axis === 'x' ? xAxis.scale : yAxis.scale
      return snapValue(sc, value)
    }
    return {
      coordSpace: 'data',
      supportedTypes: supportedTypes ?? [
        'vline',
        'vrange',
        'hline',
        'hrange',
        'point',
        'rect',
        'arrow',
        'text',
      ],
      bounds,
      toPx,
      fromPx,
      snap,
    }
  }
  return { CaptureAxes, buildAdapter }
}

/** Hook variant — wraps the capture pair behind a stable React ref so
 *  the chart can mount CaptureAxes once and re-read scales on every
 *  render without the parent juggling refs by hand.
 *
 *   const axesCapture = useChartAxesCapture()
 *   ...render <axesCapture.CaptureAxes /> inside the chart...
 *   const adapter = axesCapture.buildAdapter() // null until first paint
 */
export function useChartAxesCapture() {
  const refHolder = useRef(null)
  if (refHolder.current === null) {
    refHolder.current = createChartAxesCapture()
  }
  return refHolder.current
}
