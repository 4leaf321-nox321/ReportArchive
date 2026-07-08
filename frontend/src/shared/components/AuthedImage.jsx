import { forwardRef, useEffect, useState } from 'react'
import { ImageIcon } from 'lucide-react'
import { fetchImageObjectURL } from '@/shared/api/files'

/**
 * Renders an image whose source requires the JWT auth header. Browsers
 * can't attach headers to <img src>, so we fetch as a blob via the API
 * client (which carries the token) and display via an object URL. The
 * URL is revoked on unmount / fileId change so we don't leak memory.
 *
 * Forwards refs to the underlying <img>, which lets callers attach
 * ResizeObservers (e.g. the annotation adapter measures the image's
 * actual rendered box for image_pct ↔ pixel conversion).
 */
export const AuthedImage = forwardRef(function AuthedImage(
  { fileId, alt = '', className = '', style },
  ref,
) {
  const [url, setUrl] = useState(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    // Clear the displayed URL *before* the previous effect's cleanup runs
    // — otherwise the cleanup revokes the old blob URL while `url` state
    // still points at it, so `<img src>` briefly references a dead blob
    // and the browser renders a broken-image placeholder. Resetting here
    // lets the skeleton show during the refetch instead.
    setUrl(null)
    setError(false)
    if (!fileId) return undefined
    let cancelled = false
    let createdUrl = null
    fetchImageObjectURL(fileId)
      .then((u) => {
        if (cancelled) {
          URL.revokeObjectURL(u)
          return
        }
        createdUrl = u
        setUrl(u)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
      if (createdUrl) URL.revokeObjectURL(createdUrl)
    }
  }, [fileId])

  if (!fileId || error) {
    return (
      <div
        className={`flex items-center justify-center bg-muted/40 text-muted-foreground ${className}`}
        style={style}
      >
        <ImageIcon className="h-6 w-6" />
      </div>
    )
  }
  if (!url) {
    return (
      <div className={`bg-muted/40 animate-pulse ${className}`} style={style} />
    )
  }
  return <img ref={ref} src={url} alt={alt} className={className} style={style} />
})
