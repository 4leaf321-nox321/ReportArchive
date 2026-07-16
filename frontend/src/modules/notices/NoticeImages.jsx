import { AuthedImage } from '@/shared/components/AuthedImage'

/** 공지 첨부 이미지를 본문의 일부처럼 전체 폭·원본 비율로 크게 인라인 표시.
 *  예전엔 작은 3열 썸네일(object-cover 로 잘림) + 원본 URL 링크였는데, 링크는
 *  새 탭에서 인증 헤더가 빠져 401 이 났다. 여기선 AuthedImage(토큰 fetch)로
 *  바로 크게 그리므로 링크가 필요 없다. 팝업·상세 공용. */
export function NoticeImages({ attachments, className = '' }) {
  const list = Array.isArray(attachments) ? attachments : []
  if (list.length === 0) return null
  return (
    <div className={`space-y-2 ${className}`}>
      {list.map((a, i) => (
        <figure key={`${a.file_id}-${i}`} className="space-y-1">
          <AuthedImage
            fileId={a.file_id}
            alt={a.filename}
            className="w-full h-auto rounded-md border bg-muted/20"
          />
          {a.filename && (
            <figcaption className="text-[10px] text-muted-foreground truncate">
              {a.filename}
            </figcaption>
          )}
        </figure>
      ))}
    </div>
  )
}
