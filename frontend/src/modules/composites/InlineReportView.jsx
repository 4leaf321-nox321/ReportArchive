import { useMemo } from 'react'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { useAsync } from '@/shared/hooks/useAsync'
import { getReport } from '@/modules/reports/api'
import { getComposite } from '@/shared/api/composites'
import { getTemplateVersion } from '@/shared/api/templates'
import { getRenderer } from '@/modules/templates/widgets'

/**
 * Read-only inline render of a source report. Resolves the report by id,
 * fetches each page's template, then walks the page content block-by-block
 * and lets each widget's Editor render itself in readOnly mode.
 *
 * Intentionally flat: no per-page grid layout, no edit affordances. The
 * goal is "let me skim the source without leaving the composite page",
 * not "edit the source from here".
 */
export function InlineReportView({ reportId }) {
  const { data: report, loading, error } = useAsync(
    () => (reportId ? getReport(reportId) : Promise.resolve(null)),
    [reportId],
  )
  if (loading) return <Skeleton className="h-24" />
  if (error) return <div className="text-xs text-destructive">{error.message}</div>
  if (!report) return null
  const pages = Array.isArray(report.pages) && report.pages.length > 0
    ? report.pages
    : [{ template_id: report.template_id, template_version: report.template_version, content: report.content ?? {} }]
  return (
    <div className="space-y-4">
      {pages.map((p, idx) => (
        <InlinePage key={idx} page={p} index={idx} totalPages={pages.length} />
      ))}
    </div>
  )
}

function InlinePage({ page, index, totalPages }) {
  const { data: template, loading } = useAsync(
    () => getTemplateVersion(page.template_id, page.template_version),
    [page.template_id, page.template_version],
  )
  const blocks = useMemo(() => extractBlocks(template?.schema), [template])
  if (loading) return <Skeleton className="h-20" />
  if (!template) return null
  return (
    <div className="space-y-3">
      {totalPages > 1 && (
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
          페이지 {index + 1} · {page.name || template.name}
        </div>
      )}
      {blocks.map((block) => {
        const renderer = getRenderer(block.type)
        if (!renderer?.Editor) return null
        const content = page.content?.[block.id]
        const Editor = renderer.Editor
        return (
          <Editor
            key={block.id}
            props={block.props}
            content={content}
            onChange={() => {}}
            readOnly
          />
        )
      })}
    </div>
  )
}

/** Composites embedded inside other composites: show a compact summary
 *  (description + the item titles) instead of fully recursing — full
 *  rendering of a nested composite tree would explode quickly. */
export function InlineCompositeView({ compositeId }) {
  const { data: composite, loading, error } = useAsync(
    () => (compositeId ? getComposite(compositeId) : Promise.resolve(null)),
    [compositeId],
  )
  if (loading) return <Skeleton className="h-24" />
  if (error) return <div className="text-xs text-destructive">{error.message}</div>
  if (!composite) return null
  return (
    <div className="space-y-3">
      {composite.description && (
        <div className="text-sm whitespace-pre-wrap rounded-md bg-muted/40 px-3 py-2">
          {composite.description}
        </div>
      )}
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
        포함된 안건 {composite.items.length}건
      </div>
      <ul className="text-sm divide-y border rounded-md">
        {composite.items.map((it) => (
          <li key={it.id} className="py-2 px-3 flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground shrink-0 w-12">
              {it.item_type === 'report' ? '보고서' : '종합'}
            </span>
            <span className="truncate">
              {it.item_type === 'report' ? it.ref_report?.title : it.ref_composite?.title}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function extractBlocks(schema) {
  const blocks = Array.isArray(schema?.blocks) ? schema.blocks : []
  return blocks.map((b) => ({
    id: b.id,
    type: b.type,
    props: b.props ?? {},
  }))
}
