import { useEffect, useMemo, useState } from 'react'

/**
 * Image → annotation-layer coordinate bridge.
 *
 * Annotations on an image live in `image_pct` space — each coord is a
 * fraction in [0, 1] of the displayed image's bounding box. That keeps
 * the saved geometry independent of the rendered pixel size: the same
 * payload works whether the image is 300px wide on a phone or 1600px
 * wide on a print PDF.
 *
 *   const containerRef = useRef(null)
 *   const adapter = useImageAnnotationAdapter(containerRef, {
 *     supportedTypes: ['vline','vrange','hline','hrange','point','rect','arrow','text'],
 *   })
 *
 *   <div ref={containerRef} className="relative aspect-video">
 *     <img ... />
 *     {adapter && <AnnotationLayer adapter={adapter} ... />}
 *   </div>
 *
 * Sizing model: bounds match the CONTAINER's box, not the natural
 * image dimensions. The image is expected to fill the container
 * (object-cover / object-fill / etc.), so its visible area equals
 * the container box and annotations land on the visible pixels.
 *
 * Hosts using object-contain (letterboxing) should pass an imgRef to
 * `useImageAnnotationAdapter` so the bounds shrink to the image's
 * actual rendered box rather than the surrounding empty space.
 */
export function useImageAnnotationAdapter(
  containerRef,
  { supportedTypes, imgRef } = {},
) {
  const [bounds, setBounds] = useState(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return undefined
    function measure() {
      const target = imgRef?.current ?? container
      const tRect = target.getBoundingClientRect()
      const cRect = container.getBoundingClientRect()
      // Round to integers so subpixel jitter doesn't churn renders.
      const next = {
        x: Math.round(tRect.left - cRect.left),
        y: Math.round(tRect.top - cRect.top),
        width: Math.round(tRect.width),
        height: Math.round(tRect.height),
      }
      setBounds((prev) =>
        prev &&
        prev.x === next.x &&
        prev.y === next.y &&
        prev.width === next.width &&
        prev.height === next.height
          ? prev
          : next,
      )
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(container)
    if (imgRef?.current) ro.observe(imgRef.current)
    return () => ro.disconnect()
    // containerRef / imgRef are refs — their identity is stable, the
    // .current values change without triggering re-runs (which is what
    // we want — ResizeObserver picks up DOM mutations).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return useMemo(() => {
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null
    return buildImageAdapter(bounds, supportedTypes)
  }, [bounds, supportedTypes])
}

function buildImageAdapter(bounds, supportedTypes) {
  function px(axis, frac) {
    if (axis === 'x') return bounds.x + bounds.width * Number(frac)
    return bounds.y + bounds.height * Number(frac)
  }
  function frac(axis, pixel) {
    if (axis === 'x') {
      const f = (pixel - bounds.x) / bounds.width
      return clamp01(f)
    }
    const f = (pixel - bounds.y) / bounds.height
    return clamp01(f)
  }
  return {
    coordSpace: 'image_pct',
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
    toPx(geometry) {
      const out = {}
      if ('x' in geometry) out.x = px('x', geometry.x)
      if ('y' in geometry) out.y = px('y', geometry.y)
      if ('x_from' in geometry) out.x_from = px('x', geometry.x_from)
      if ('x_to' in geometry) out.x_to = px('x', geometry.x_to)
      if ('y_from' in geometry) out.y_from = px('y', geometry.y_from)
      if ('y_to' in geometry) out.y_to = px('y', geometry.y_to)
      if (geometry.from) {
        out.from = {
          x: px('x', geometry.from.x),
          y: px('y', geometry.from.y),
        }
      }
      if (geometry.to) {
        out.to = {
          x: px('x', geometry.to.x),
          y: px('y', geometry.to.y),
        }
      }
      return out
    },
    fromPx(p) {
      const out = {}
      if ('x' in p) out.x = frac('x', p.x)
      if ('y' in p) out.y = frac('y', p.y)
      return out
    },
    snap(value) {
      // Round to 0.001 (~0.1% of the image). Plenty fine for typical
      // 1000px-wide images and keeps the saved JSON readable.
      if (typeof value !== 'number' || !Number.isFinite(value)) return value
      return Math.round(value * 1000) / 1000
    },
  }
}

function clamp01(v) {
  if (!Number.isFinite(v)) return v
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}
