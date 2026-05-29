// docx-js 9.x emits an empty `word/comments.xml` part in every output —
// along with the matching Content_Types Override and the
// `document.xml.rels` Relationship that points to it. The part itself
// is `<w:comments xmlns=…/>` (no `<w:comment>` children) AND
// `document.xml` carries no `<w:commentReference>` markers, so the
// declared comments part is *orphaned* from Word`s perspective: it`s
// listed but unreferenced and empty. Word`s structural validator
// classifies this as recoverable damage and pops the
// "이 문서의 컨텐츠를 복구하겠습니까?" dialog on every open.
//
// Fix: post-process the .docx zip and strip the orphan part + its two
// declarations. The rest of the package is untouched. ~30–50ms.
//
// JSZip is already a transitive dep of docx-js (uses it internally for
// packing) so importing here costs nothing extra in the bundle —
// Vite dedupes the import.

import JSZip from 'jszip'

const COMMENTS_PART_PATH = 'word/comments.xml'
const COMMENTS_RELS_PATH = 'word/_rels/comments.xml.rels'
const CONTENT_TYPES_PATH = '[Content_Types].xml'
const DOCUMENT_RELS_PATH = 'word/_rels/document.xml.rels'

// Match `<Override PartName="/word/comments.xml" ContentType="…"/>`
// anywhere in `[Content_Types].xml`. The attribute order is fixed by
// docx-js (PartName before ContentType) so a simple non-greedy match
// is safe, but we explicitly anchor on the PartName value to be
// defensive against future docx-js attribute reorderings.
const CONTENT_TYPE_OVERRIDE_RE =
  /<Override[^>]+PartName="\/word\/comments\.xml"[^/]*\/>/

// Match the comments `<Relationship .../>` in `document.xml.rels`,
// keyed on its OOXML `Type` URL ending in `/comments`. Same anchoring
// reason as above.
const DOCUMENT_RELS_COMMENTS_RE =
  /<Relationship[^>]+Type="[^"]*\/comments"[^/]*\/>/

export async function stripOrphanDocxParts(blob) {
  const buf = await blob.arrayBuffer()
  const zip = await JSZip.loadAsync(buf)

  // Drop the orphan part + its (currently always-empty) rels sidecar.
  // JSZip.remove is a no-op if the entry is absent, so this stays
  // forward-compatible if a future docx-js version stops emitting
  // them on its own.
  zip.remove(COMMENTS_PART_PATH)
  zip.remove(COMMENTS_RELS_PATH)

  const ctFile = zip.file(CONTENT_TYPES_PATH)
  if (ctFile) {
    const ct = await ctFile.async('string')
    const stripped = ct.replace(CONTENT_TYPE_OVERRIDE_RE, '')
    if (stripped !== ct) zip.file(CONTENT_TYPES_PATH, stripped)
  }

  const docRelsFile = zip.file(DOCUMENT_RELS_PATH)
  if (docRelsFile) {
    const rels = await docRelsFile.async('string')
    const stripped = rels.replace(DOCUMENT_RELS_COMMENTS_RE, '')
    if (stripped !== rels) zip.file(DOCUMENT_RELS_PATH, stripped)
  }

  return zip.generateAsync({
    type: 'blob',
    mimeType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    compression: 'DEFLATE',
  })
}
