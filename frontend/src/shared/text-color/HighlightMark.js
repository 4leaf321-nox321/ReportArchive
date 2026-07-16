import { Mark, mergeAttributes } from '@tiptap/core'
import { hlTokenClass, normalizeToken, tokenFromHlClassName } from './tokens'

// 하이라이트(형광펜) 배경 마크. 텍스트 색 마크(TextColor)와 같은 토큰 체계를
// 쓰되 `rt-hl-{token}` 배경 클래스로 렌더한다. 실제 색은 테마별 CSS 변수에서
// 오므로 다크/라이트에 자동 적응. TextColor(글자색)·TextStyle(글자크기)과
// 독립 마크라 겹쳐 쓸 수 있다(같은 span 에 색+하이라이트+크기 공존 가능).

function extractHlToken(el) {
  return tokenFromHlClassName(el.getAttribute('class') || '')
}

export const Highlight = Mark.create({
  name: 'highlight',

  addAttributes() {
    return {
      token: {
        default: null,
        parseHTML: (element) => extractHlToken(element),
        renderHTML: (attrs) => {
          const cls = hlTokenClass(attrs.token)
          return cls ? { class: cls } : {}
        },
      },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'span',
        // rt-hl-* 를 든 span 만 이 마크로 — 색/크기만 있는 span 은 흘려보내
        // TextColor/TextStyle 가 처리하게 한다.
        getAttrs: (el) => (extractHlToken(el) ? {} : false),
      },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes), 0]
  },

  addCommands() {
    return {
      setHighlight:
        (token) =>
        ({ commands }) => {
          const t = normalizeToken(token)
          return t
            ? commands.setMark('highlight', { token: t })
            : commands.unsetMark('highlight')
        },
      unsetHighlight:
        () =>
        ({ commands }) =>
          commands.unsetMark('highlight'),
    }
  },
})
