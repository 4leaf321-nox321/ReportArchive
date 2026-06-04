import { Mark, mergeAttributes } from '@tiptap/core'

/**
 * 본문 @멘션 — 표시 문구(텍스트 런)를 감싸는 인라인 Mark. 보고서·협업 부서·
 * 관련 정보(엔티티) 등 여러 종류를 "하나의 제네릭 마크"로 표현한다. 종류가
 * 늘어도 마크/​sanitizer/​클릭 위임은 안 건드리고, 새 종류는 dialog 의 provider
 * 레지스트리(+ CSS 아이콘)에만 추가하면 된다.
 *
 * 저장 스키마(제네릭):
 *   <a data-mention-type="report|dept|entity"
 *      data-mention-id="<식별자>"
 *      [data-mention-ws="<workspace slug>"]   // 보고서: 게시 워크스페이스
 *      [data-mention-axis="<entity type slug>"] // 엔티티: 축
 *      class="{type}-mention" href="#">표시 문구</a>
 *   - report : id=보고서id, ws=workspace slug → /w/{ws}/reports/{id}
 *   - dept   : id=workspace slug              → /w/{id}/reports
 *   - entity : id=엔티티id, axis=축 slug      → (v1) 이동 없음, 표시 전용 칩
 *
 * 하위호환: 구형 저장분(`data-report-id`/`data-workspace-slug`/`data-dept-slug`)
 * 도 parseHTML 에서 인식해 제네릭 attrs 로 매핑한다. 이미 저장된 보고서가
 * 깨지지 않으며, 에디터에서 다시 저장되면 제네릭 형식으로 승급된다. 뷰 모드는
 * 저장된 html 을 그대로 렌더하므로 RichText 의 sanitizer/클릭 위임이 구형
 * 속성도 함께 처리한다.
 *
 * 실제 이동은 href 가 아니라 뷰 모드의 클릭 위임(OutlineView)에서 SPA navigate
 * 로 처리하므로, 렌더 시 sanitizer 는 href 를 허용하지 않는다(javascript: 차단).
 *
 * ⚠️ StarterKit v3 는 Link 마크가 기본 활성이라 `<a>` parseHTML 이 충돌한다.
 * RichTextRowEditor 의 StarterKit.configure 에서 반드시 `link: false` 로 끈다.
 */

// 구형 속성 → 종류 추론. parseHTML 의 여러 attr 에서 공통으로 쓴다.
function legacyType(el) {
  if (el.getAttribute('data-report-id')) return 'report'
  if (el.getAttribute('data-dept-slug')) return 'dept'
  return null
}

export const ReportLinkMark = Mark.create({
  name: 'reportLink',
  // 링크 끝에서 타이핑을 이어가도 마크가 번지지 않게 한다.
  inclusive: false,
  // bold/italic/color 등 다른 인라인 마크와 공존.
  excludes: '',

  addAttributes() {
    return {
      mentionType: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-mention-type') || legacyType(el),
        renderHTML: (attrs) =>
          attrs.mentionType ? { 'data-mention-type': attrs.mentionType } : {},
      },
      mentionId: {
        default: null,
        parseHTML: (el) =>
          el.getAttribute('data-mention-id') ||
          el.getAttribute('data-report-id') ||
          el.getAttribute('data-dept-slug') ||
          null,
        renderHTML: (attrs) =>
          attrs.mentionId ? { 'data-mention-id': String(attrs.mentionId) } : {},
      },
      // 보고서 멘션의 게시 워크스페이스 slug (이동 경로 구성용).
      mentionWs: {
        default: null,
        parseHTML: (el) =>
          el.getAttribute('data-mention-ws') ||
          el.getAttribute('data-workspace-slug') ||
          null,
        renderHTML: (attrs) =>
          attrs.mentionWs ? { 'data-mention-ws': attrs.mentionWs } : {},
      },
      // 엔티티 멘션의 축(EntityType) slug — 표시(아이콘/색)·구분용.
      mentionAxis: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-mention-axis') || null,
        renderHTML: (attrs) =>
          attrs.mentionAxis ? { 'data-mention-axis': attrs.mentionAxis } : {},
      },
    }
  },

  parseHTML() {
    // 제네릭 + 구형 두 형식 모두 인식.
    return [
      { tag: 'a[data-mention-type]' },
      { tag: 'a[data-report-id]' },
      { tag: 'a[data-dept-slug]' },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    const type = HTMLAttributes['data-mention-type'] || 'report'
    return [
      'a',
      mergeAttributes(HTMLAttributes, {
        class: `${type}-mention`,
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
