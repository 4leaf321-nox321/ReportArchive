import { Mark, mergeAttributes } from '@tiptap/core'

/**
 * 외부 URL 하이퍼링크 인라인 마크(긴 글 위젯). `<a href target rel class>` 로
 * 저장·렌더된다. 내부 @멘션(ReportLinkMark)과 공존하기 위해 parseHTML 은
 * 멘션 앵커(data-mention-type · data-report-id · data-dept-slug)를 제외하고,
 * http(s)/mailto/tel 안전 스킴만 claim 한다.
 *
 * ReportLinkMark 와 달리 실제 href 로 이동한다(target=_blank). 뷰 모드의 클릭
 * 위임(OutlineView.handleMentionClick)은 멘션 앵커만 가로채므로 외부 링크는
 * 브라우저 기본 이동을 탄다. 렌더 sanitize(SANITIZE_OPTIONS)에 href/target/rel
 * 을 허용해야 링크가 살아남는다(DOMPurify 가 javascript: 등 위험 스킴은 제거).
 *
 * StarterKit 의 기본 Link 는 여전히 꺼둔 채로(link:false) 이 마크만 쓴다.
 */

/**
 * 사용자 입력 URL → 안전한 링크 문자열, 아니면 null.
 *  - http(s)/mailto/tel 스킴은 그대로.
 *  - 스킴 없는 도메인(example.com/…, www.…)은 https:// 를 붙인다.
 *  - javascript:/data:/vbscript: 등은 거부(null).
 */
export function normalizeExternalUrl(raw) {
  if (typeof raw !== 'string') return null
  const url = raw.trim()
  if (!url) return null
  if (/^(https?:|mailto:|tel:)/i.test(url)) return url
  // 스킴 없는 도메인/경로(점 + TLD 포함)면 https 로 승격.
  if (/^(www\.)?[\w-]+(\.[\w-]+)+([/:?#].*)?$/i.test(url)) return `https://${url}`
  return null
}

export const ExternalLink = Mark.create({
  name: 'externalLink',
  // 링크 끝에서 이어 타이핑해도 마크가 번지지 않게.
  inclusive: false,
  // 다른 인라인 마크(굵게/색/하이라이트 등)와 공존.
  excludes: '',

  addAttributes() {
    return {
      href: {
        default: null,
        parseHTML: (el) => normalizeExternalUrl(el.getAttribute('href') || ''),
        renderHTML: (attrs) => (attrs.href ? { href: attrs.href } : {}),
      },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'a[href]',
        getAttrs: (el) => {
          // 멘션 앵커는 ReportLinkMark 담당 — 넘긴다.
          if (
            el.getAttribute('data-mention-type') ||
            el.getAttribute('data-report-id') ||
            el.getAttribute('data-dept-slug')
          ) {
            return false
          }
          const href = normalizeExternalUrl(el.getAttribute('href') || '')
          return href ? { href } : false
        },
      },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'a',
      mergeAttributes(HTMLAttributes, {
        class: 'rt-link',
        target: '_blank',
        rel: 'noopener noreferrer nofollow',
      }),
      0,
    ]
  },

  addCommands() {
    return {
      setExternalLink:
        ({ href }) =>
        ({ commands }) => {
          const safe = normalizeExternalUrl(href)
          return safe
            ? commands.setMark('externalLink', { href: safe })
            : commands.unsetMark('externalLink')
        },
      unsetExternalLink:
        () =>
        ({ commands }) =>
          commands.unsetMark('externalLink'),
    }
  },
})
