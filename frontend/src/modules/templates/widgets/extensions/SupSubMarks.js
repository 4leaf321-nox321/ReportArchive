import { Mark, mergeAttributes } from '@tiptap/core'

// 긴 글 위젯(rich_text)용 위/아래 첨자 인라인 마크. 표준 <sup>/<sub> 로
// 저장·렌더되므로 구조(items[] 문단 모델)를 건드리지 않는다. 둘은 서로 배타적
// (한쪽을 켜면 다른 쪽 해제). 화면 렌더 sanitize(ALLOWED_TAGS)에 sup/sub 를
// 추가해야 표시되고, PPTX/DOCX export 변환기도 각각 첨자 옵션을 반영한다.

export const Superscript = Mark.create({
  name: 'superscript',
  // 위/아래 첨자를 동시에 걸 수 없게 서로 배타.
  excludes: 'subscript',
  parseHTML() {
    return [{ tag: 'sup' }, { style: 'vertical-align=super' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['sup', mergeAttributes(HTMLAttributes), 0]
  },
  addCommands() {
    return {
      toggleSuperscript:
        () =>
        ({ commands }) =>
          commands.toggleMark('superscript'),
    }
  },
  addKeyboardShortcuts() {
    return { 'Mod-.': () => this.editor.commands.toggleSuperscript() }
  },
})

export const Subscript = Mark.create({
  name: 'subscript',
  excludes: 'superscript',
  parseHTML() {
    return [{ tag: 'sub' }, { style: 'vertical-align=sub' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['sub', mergeAttributes(HTMLAttributes), 0]
  },
  addCommands() {
    return {
      toggleSubscript:
        () =>
        ({ commands }) =>
          commands.toggleMark('subscript'),
    }
  },
  addKeyboardShortcuts() {
    return { 'Mod-,': () => this.editor.commands.toggleSubscript() }
  },
})
