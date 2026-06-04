import { Mark, mergeAttributes } from '@tiptap/core'

/**
 * 본문 @멘션 보고서 링크 — 표시 문구(텍스트 런)를 감싸는 인라인 Mark.
 *
 * Node 가 아니라 Mark 인 이유: RichText 행 에디터의 분할/병합은 html 을
 * DOMSerializer 로 직렬화하고(`sliceAtChar`), 행 병합은 `<p>` 안쪽 innerHTML 을
 * 문자열로 이어붙인다(`unwrapParagraph`). Mark 는 `<a>...</a>` 가 텍스트와 함께
 * 통째로 round-trip 되어 이 경로들을 그대로 통과하고, `editor.getText()` 가
 * 표시 문구를 그대로 돌려줘 글자수·prefix·`//` 콤보 로직에 영향이 없다.
 *
 * 두 종류의 멘션을 한 마크로 표현(폴리모픽):
 *   - 보고서 : `<a data-report-id data-workspace-slug class="report-mention">`
 *              → /w/{ws}/reports/{id} 로 이동.
 *   - 협업 부서 : `<a data-dept-slug class="dept-mention">`
 *              → /w/{deptSlug}/reports (그 부서 게시판)로 이동.
 * 실제 이동은 href 가 아니라 뷰 모드의 클릭 위임(OutlineView)에서 SPA navigate
 * 로 처리하므로, 렌더 시 sanitizer 는 href 를 허용하지 않는다(javascript: 차단).
 *
 * ⚠️ StarterKit v3 는 Link 마크가 기본 활성이라 `<a>` parseHTML 이 충돌한다.
 * RichTextRowEditor 의 StarterKit.configure 에서 반드시 `link: false` 로 끈다.
 */
export const ReportLinkMark = Mark.create({
  name: 'reportLink',
  // 링크 끝에서 타이핑을 이어가도 마크가 번지지 않게 한다.
  inclusive: false,
  // bold/italic/color 등 다른 인라인 마크와 공존.
  excludes: '',

  addAttributes() {
    return {
      reportId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-report-id'),
        renderHTML: (attrs) =>
          attrs.reportId ? { 'data-report-id': String(attrs.reportId) } : {},
      },
      workspaceSlug: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-workspace-slug'),
        renderHTML: (attrs) =>
          attrs.workspaceSlug
            ? { 'data-workspace-slug': attrs.workspaceSlug }
            : {},
      },
      // 협업 부서 멘션의 대상 워크스페이스 slug. reportId 없이 이것만 있으면
      // 부서 게시판으로 이동하는 링크가 된다.
      deptSlug: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-dept-slug'),
        renderHTML: (attrs) =>
          attrs.deptSlug ? { 'data-dept-slug': attrs.deptSlug } : {},
      },
    }
  },

  parseHTML() {
    return [{ tag: 'a[data-report-id]' }, { tag: 'a[data-dept-slug]' }]
  },

  renderHTML({ HTMLAttributes }) {
    const isDept = !!HTMLAttributes['data-dept-slug']
    return [
      'a',
      mergeAttributes(HTMLAttributes, {
        class: isDept ? 'dept-mention' : 'report-mention',
        href: '#',
      }),
      0,
    ]
  },

  addCommands() {
    return {
      setReportLink:
        (attrs) =>
        ({ commands }) =>
          commands.setMark(this.name, attrs),
      unsetReportLink:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    }
  },
})
