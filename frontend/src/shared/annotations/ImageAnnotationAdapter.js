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
      const cRect = container.getBoundingClientRect()
      const img = imgRef?.current
      let next
      // object-contain 이미지: 엘리먼트 박스(=컨테이너를 채움)가 아니라 그 안에
      // 자연 비율로 letterbox 된 *실제 보이는 이미지 영역* 을 bounds 로 쓴다.
      // 이래야 좌표(%)가 컨테이너 모양(편집 maxHeight·fillCell·셀 폭 차이)과
      // 무관하게 이미지 픽셀에 진짜 상대적이 돼, 편집/뷰에서 위치가 일치한다.
      if (img && img.naturalWidth > 0 && img.naturalHeight > 0) {
        const eRect = img.getBoundingClientRect()
        const elW = eRect.width
        const elH = eRect.height
        const natAspect = img.naturalWidth / img.naturalHeight
        const elAspect = elW / elH || 1
        let cw
        let ch
        if (natAspect > elAspect) {
          cw = elW
          ch = elW / natAspect
        } else {
          ch = elH
          cw = elH * natAspect
        }
        next = {
          x: Math.round(eRect.left - cRect.left + (elW - cw) / 2),
          y: Math.round(eRect.top - cRect.top + (elH - ch) / 2),
          width: Math.round(cw),
          height: Math.round(ch),
        }
      } else {
        // 자연 크기 미확정(로딩 전) 또는 imgRef 없음 → 엘리먼트/컨테이너 박스.
        const t = (img ?? container).getBoundingClientRect()
        next = {
          x: Math.round(t.left - cRect.left),
          y: Math.round(t.top - cRect.top),
          width: Math.round(t.width),
          height: Math.round(t.height),
        }
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
    const ro = new ResizeObserver(measure)
    ro.observe(container)

    // AuthedImage 는 blob 을 비동기로 받아 처음엔 placeholder(div)를 그리고
    // 나중에 <img> 로 교체된다. 그래서 마운트 시점엔 imgRef 가 비어 있을 수
    // 있어, img 가 *생기고 load 될 때* 다시 측정해야 content rect 보정이 켜진다.
    let boundImg = null
    function bindImg() {
      const img = imgRef?.current
      if (img && img !== boundImg) {
        if (boundImg) {
          ro.unobserve(boundImg)
          boundImg.removeEventListener('load', measure)
        }
        boundImg = img
        ro.observe(img)
        img.addEventListener('load', measure) // 자연 크기는 load 후 확정
      }
      measure()
    }
    bindImg()
    // AuthedImage 가 placeholder div ↔ <img> 를 교체할 때(컨테이너 직계 자식)
    // 다시 바인딩 + 측정. subtree 는 안 본다 — 주석 레이어 DOM 변화까지 잡혀
    // 불필요하게 자주 측정되는 걸 피한다.
    const mo = new MutationObserver(bindImg)
    mo.observe(container, { childList: true })

    return () => {
      ro.disconnect()
      mo.disconnect()
      if (boundImg) boundImg.removeEventListener('load', measure)
    }
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
