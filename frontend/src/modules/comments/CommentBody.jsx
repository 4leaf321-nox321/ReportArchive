/** Comment body — Phase 2A minimal: plain textarea, stored as a
 *  tiptap-compatible doc on the backend.
 *
 *  Tiptap rich editor + mentions arrive in Phase 7D. The shape we
 *  store now is forward-compatible:
 *    { type: 'doc', content: [{type:'paragraph', content:[{type:'text', text: '...'}]}] }
 *
 *  Helpers exported:
 *   - textToDoc(str)  — convert plain text → tiptap doc
 *   - docToText(doc)  — collapse doc to plain string for display/edit
 */
import * as React from 'react'

export function textToDoc(text) {
  const lines = (text ?? '').split(/\r?\n/)
  return {
    type: 'doc',
    content: lines.map((line) => ({
      type: 'paragraph',
      content: line ? [{ type: 'text', text: line }] : [],
    })),
  }
}

export function docToText(doc) {
  if (!doc || typeof doc !== 'object') return ''
  const parts = []
  function walk(node) {
    if (!node) return
    if (Array.isArray(node)) {
      for (const c of node) walk(c)
      return
    }
    if (node.type === 'paragraph') {
      walk(node.content)
      parts.push('\n')
      return
    }
    if (node.text) {
      parts.push(node.text)
    }
    if (node.content) walk(node.content)
  }
  walk(doc.content)
  return parts.join('').replace(/\n+$/, '')
}
