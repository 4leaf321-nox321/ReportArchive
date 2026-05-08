import { useEffect, useState } from 'react'
import { ImageIcon } from 'lucide-react'
import { fetchImageObjectURL } from '@/shared/api/files'

/**
 * Renders an image whose source requires the JWT auth header. Browsers
 * can't attach headers to <img src>, so we fetch as a blob via the API
 * client (which carries the token) and display via an object URL. The
 * URL is revoked on unmount / fileId change so we don't leak memory.
 */
export function AuthedImage({ fileId, alt = '', className = '' }) {
  const [url, setUrl] = useState(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!fileId) {
      setUrl(null)
      return
    }
    let cancelled = false
    let createdUrl = null
    setError(false)
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
      >
        <ImageIcon className="h-6 w-6" />
      </div>
    )
  }
  if (!url) {
    return <div className={`bg-muted/40 animate-pulse ${className}`} />
  }
  return <img src={url} alt={alt} className={className} />
}
