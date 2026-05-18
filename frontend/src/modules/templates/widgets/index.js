/**
 * Frontend widget renderer registry — maps widget type → React components.
 *
 * The backend's /api/widgets returns metadata (label, description, props_schema,
 * default_props). This file complements that with the *UI components* keyed
 * by the same `type` strings:
 *
 *   PropsPanel — edits the widget's props (used in TemplateEditor)
 *   Preview    — empty placeholder, used in TemplateEditor canvas
 *   Editor     — fills the content slot when writing a report
 *
 * `Editor` is null for purely presentational widgets (heading) — those
 * have nothing for the report writer to fill in.
 *
 * To add a new widget:
 *   1. Define props_schema + content_schema_for in backend/app/widgets/registry.py
 *   2. Create <Widget>.jsx here exporting PropsPanel + Preview + (optional) Editor
 *   3. Register the components below
 */
import { Heading1, Type, ListOrdered, Table2, Image, LineChart, Paperclip, AlignLeft } from 'lucide-react'

import { HeadingPropsPanel, HeadingPreview, HeadingEditor } from './Heading'
import { RichTextPropsPanel, RichTextPreview, RichTextEditor } from './RichText'
import { KeyValuePropsPanel, KeyValuePreview, KeyValueEditor } from './KeyValue'
import { BulletedListPropsPanel, BulletedListPreview, BulletedListEditor } from './BulletedList'
import { TablePropsPanel, TablePreview, TableEditor } from './Table'
import { ImagePropsPanel, ImagePreview, ImageEditor } from './Image'
import { AttachmentPropsPanel, AttachmentPreview, AttachmentEditor } from './Attachment'
import { ChartPropsPanel, ChartPreview, ChartEditor } from './Chart'

export const WIDGET_RENDERERS = {
  heading: {
    Icon: Heading1,
    PropsPanel: HeadingPropsPanel,
    Preview: HeadingPreview,
    Editor: HeadingEditor,
  },
  rich_text: {
    Icon: AlignLeft,
    PropsPanel: RichTextPropsPanel,
    Preview: RichTextPreview,
    Editor: RichTextEditor,
  },
  key_value: {
    Icon: Type,
    PropsPanel: KeyValuePropsPanel,
    Preview: KeyValuePreview,
    Editor: KeyValueEditor,
  },
  bulleted_list: {
    Icon: ListOrdered,
    PropsPanel: BulletedListPropsPanel,
    Preview: BulletedListPreview,
    Editor: BulletedListEditor,
  },
  table: {
    Icon: Table2,
    PropsPanel: TablePropsPanel,
    Preview: TablePreview,
    Editor: TableEditor,
  },
  image: {
    Icon: Image,
    PropsPanel: ImagePropsPanel,
    Preview: ImagePreview,
    Editor: ImageEditor,
  },
  attachment: {
    Icon: Paperclip,
    PropsPanel: AttachmentPropsPanel,
    Preview: AttachmentPreview,
    Editor: AttachmentEditor,
  },
  chart: {
    Icon: LineChart,
    PropsPanel: ChartPropsPanel,
    Preview: ChartPreview,
    Editor: ChartEditor,
  },
}

export function getRenderer(type) {
  return WIDGET_RENDERERS[type] ?? null
}
