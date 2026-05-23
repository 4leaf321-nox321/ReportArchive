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
import { Activity, AlignLeft, BarChartHorizontal, Box, Boxes, Brain, Circle, FileCode2, Film, Flag, GitBranch, Grid2x2, Grid3x3, Heading1, Hexagon, Image, LayoutGrid, LineChart, ListOrdered, MoreVertical, Paperclip, PieChart as PieIcon, Share2, Sigma, Table2, Type, Workflow } from 'lucide-react'

import { HeadingPropsPanel, HeadingPreview, HeadingEditor } from './Heading'
import { RichTextPropsPanel, RichTextPreview, RichTextEditor } from './RichText'
import { KeyValuePropsPanel, KeyValuePreview, KeyValueEditor } from './KeyValue'
import { BulletedListPropsPanel, BulletedListPreview, BulletedListEditor } from './BulletedList'
import { TablePropsPanel, TablePreview, TableEditor } from './Table'
import { ImagePropsPanel, ImagePreview, ImageEditor } from './Image'
import { AttachmentPropsPanel, AttachmentPreview, AttachmentEditor } from './Attachment'
import { VideoPropsPanel, VideoPreview, VideoEditor } from './Video'
import { HtmlEmbedPropsPanel, HtmlEmbedPreview, HtmlEmbedEditor } from './HtmlEmbed'
import { ChartPropsPanel, ChartPreview, ChartEditor } from './Chart'
import { ScatterPropsPanel, ScatterPreview, ScatterEditor } from './Scatter'
import { Scatter3DPropsPanel, Scatter3DPreview, Scatter3DEditor } from './Scatter3D'
import { HeatmapPropsPanel, HeatmapPreview, HeatmapEditor } from './Heatmap'
import { ContourPropsPanel, ContourPreview, ContourEditor } from './Contour'
import { TreemapPropsPanel, TreemapPreview, TreemapEditor } from './Treemap'
import { PackingPropsPanel, PackingPreview, PackingEditor } from './Packing'
import { TreePropsPanel, TreePreview, TreeEditor } from './Tree'
import { NetworkPropsPanel, NetworkPreview, NetworkEditor } from './Network'
import { MindMapPropsPanel, MindMapPreview, MindMapEditor } from './MindMap'
import { PiePropsPanel, PiePreview, PieEditor } from './Pie'
import { WafflePropsPanel, WafflePreview, WaffleEditor } from './Waffle'
import { BoxPropsPanel, BoxPreview, BoxEditor } from './Box'
import { DensityPropsPanel, DensityPreview, DensityEditor } from './Density'
import { RadarPropsPanel, RadarPreview, RadarEditor } from './Radar'
import { EquationPropsPanel, EquationPreview, EquationEditor } from './Equation'
import { MilestonePropsPanel, MilestonePreview, MilestoneEditor } from './Milestone'
import { FlowchartPropsPanel, FlowchartPreview, FlowchartEditor } from './Flowchart'
import { ProgressBarPropsPanel, ProgressBarPreview, ProgressBarEditor } from './ProgressBar'
import { RaciMatrixPropsPanel, RaciMatrixPreview, RaciMatrixEditor } from './RaciMatrix'
import { Cad3dPropsPanel, Cad3dPreview, Cad3dEditor } from './Cad3d'

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
  video: {
    Icon: Film,
    PropsPanel: VideoPropsPanel,
    Preview: VideoPreview,
    Editor: VideoEditor,
  },
  html_embed: {
    Icon: FileCode2,
    PropsPanel: HtmlEmbedPropsPanel,
    Preview: HtmlEmbedPreview,
    Editor: HtmlEmbedEditor,
  },
  chart: {
    Icon: BarChartHorizontal,
    PropsPanel: ChartPropsPanel,
    Preview: ChartPreview,
    Editor: ChartEditor,
  },
  scatter: {
    Icon: LineChart,
    PropsPanel: ScatterPropsPanel,
    Preview: ScatterPreview,
    Editor: ScatterEditor,
  },
  scatter3d: {
    Icon: Box,
    PropsPanel: Scatter3DPropsPanel,
    Preview: Scatter3DPreview,
    Editor: Scatter3DEditor,
  },
  heatmap: {
    Icon: LayoutGrid,
    PropsPanel: HeatmapPropsPanel,
    Preview: HeatmapPreview,
    Editor: HeatmapEditor,
  },
  contour: {
    Icon: LayoutGrid,
    PropsPanel: ContourPropsPanel,
    Preview: ContourPreview,
    Editor: ContourEditor,
  },
  treemap: {
    Icon: LayoutGrid,
    PropsPanel: TreemapPropsPanel,
    Preview: TreemapPreview,
    Editor: TreemapEditor,
  },
  packing: {
    Icon: Circle,
    PropsPanel: PackingPropsPanel,
    Preview: PackingPreview,
    Editor: PackingEditor,
  },
  tree: {
    Icon: GitBranch,
    PropsPanel: TreePropsPanel,
    Preview: TreePreview,
    Editor: TreeEditor,
  },
  network: {
    Icon: Share2,
    PropsPanel: NetworkPropsPanel,
    Preview: NetworkPreview,
    Editor: NetworkEditor,
  },
  mind_map: {
    Icon: Brain,
    PropsPanel: MindMapPropsPanel,
    Preview: MindMapPreview,
    Editor: MindMapEditor,
  },
  pie: {
    Icon: PieIcon,
    PropsPanel: PiePropsPanel,
    Preview: PiePreview,
    Editor: PieEditor,
  },
  waffle: {
    Icon: Grid2x2,
    PropsPanel: WafflePropsPanel,
    Preview: WafflePreview,
    Editor: WaffleEditor,
  },
  box: {
    Icon: MoreVertical,
    PropsPanel: BoxPropsPanel,
    Preview: BoxPreview,
    Editor: BoxEditor,
  },
  density: {
    Icon: Activity,
    PropsPanel: DensityPropsPanel,
    Preview: DensityPreview,
    Editor: DensityEditor,
  },
  radar: {
    Icon: Hexagon,
    PropsPanel: RadarPropsPanel,
    Preview: RadarPreview,
    Editor: RadarEditor,
  },
  equation: {
    Icon: Sigma,
    PropsPanel: EquationPropsPanel,
    Preview: EquationPreview,
    Editor: EquationEditor,
  },
  milestone: {
    Icon: Flag,
    PropsPanel: MilestonePropsPanel,
    Preview: MilestonePreview,
    Editor: MilestoneEditor,
  },
  flowchart: {
    Icon: Workflow,
    PropsPanel: FlowchartPropsPanel,
    Preview: FlowchartPreview,
    Editor: FlowchartEditor,
  },
  progress_bar: {
    Icon: BarChartHorizontal,
    PropsPanel: ProgressBarPropsPanel,
    Preview: ProgressBarPreview,
    Editor: ProgressBarEditor,
  },
  raci_matrix: {
    Icon: Grid3x3,
    PropsPanel: RaciMatrixPropsPanel,
    Preview: RaciMatrixPreview,
    Editor: RaciMatrixEditor,
  },
  cad_3d: {
    Icon: Boxes,
    PropsPanel: Cad3dPropsPanel,
    Preview: Cad3dPreview,
    Editor: Cad3dEditor,
  },
}

export function getRenderer(type) {
  return WIDGET_RENDERERS[type] ?? null
}
