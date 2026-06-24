import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Axis3d,
  Box,
  Eye,
  EyeOff,
  Grid3x3,
  Layers,
  Loader2,
  Magnet,
  Maximize2,
  Minimize2,
  Move3d,
  RotateCcw,
  Ruler,
  SquareDashed,
  Trash2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/shared/components/ui/dropdown-menu'
import { cn } from '@/shared/lib/utils'
import { uploadFile, fetchFileBlob } from '@/shared/api/files'
import { CaptionInput, LabelField, PreviewLabel, captionPositionOf, captionSkipProps } from './_shared'

// All three.js modules are pulled in via dynamic import inside the
// editor so the main bundle stays clean for pages that don't render a
// CAD widget. Vite splits these into their own chunk automatically.
async function loadThreeStack() {
  const [THREE, controlsMod, gltfMod, stlMod, objMod, bguMod] = await Promise.all([
    import('three'),
    import('three/examples/jsm/controls/OrbitControls.js'),
    import('three/examples/jsm/loaders/GLTFLoader.js'),
    import('three/examples/jsm/loaders/STLLoader.js'),
    import('three/examples/jsm/loaders/OBJLoader.js'),
    import('three/examples/jsm/utils/BufferGeometryUtils.js'),
  ])
  return {
    THREE,
    OrbitControls: controlsMod.OrbitControls,
    GLTFLoader: gltfMod.GLTFLoader,
    STLLoader: stlMod.STLLoader,
    OBJLoader: objMod.OBJLoader,
    BufferGeometryUtils: bguMod,
  }
}

const VIEW_PRESETS = ['iso', 'front', 'top', 'side']
const PRESET_LABELS = { iso: '아이소', front: '정면', top: '평면', side: '측면' }
// Extensions accepted by Phase 1 (browser-renderable meshes). Server
// already accepts STEP/IGES with a larger upload cap, but Phase 1 has
// no client-side conversion yet — those formats land in Phase 5.
const ACCEPTED_EXTS = ['.glb', '.gltf', '.stl', '.obj']
const ACCEPT_ATTR = ACCEPTED_EXTS.join(',')

// Snap threshold (in screen pixels) for vertex-snap during measure
// clicks — vertices within this radius of the cursor take priority
// over the raw face-hit point. Tuned so a user clicking "near" a
// corner reliably grabs the corner.
const VERTEX_SNAP_PX = 24

// Pure-data measurement helpers. Coordinates are in the model's
// native unit (assumed mm by convention); props.unit only changes how
// distances render.
function distanceBetween(p1, p2) {
  const dx = p2.x - p1.x
  const dy = p2.y - p1.y
  const dz = p2.z - p1.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function formatDistance(mm, unit) {
  const div = unit === 'm' ? 1000 : unit === 'cm' ? 10 : 1
  const value = mm / div
  // 3 decimals for m (small numbers), 2 for cm/mm — matches engineering
  // drawing conventions without surfacing float jitter.
  const decimals = unit === 'm' ? 3 : 2
  return `${value.toFixed(decimals)} ${unit}`
}

function freshAnnotationId(existingIds, prefix = 'm') {
  let n = 1
  while (existingIds.has(`${prefix}_${n}`)) n += 1
  return `${prefix}_${n}`
}

/** Extract a "parts" list (toggleable hide/show units) from the imported
 *  model. CAD-tool GLB exports vary wildly in hierarchy — some flatten
 *  every component to the top level, others nest several wrapper groups,
 *  others bury the named meshes a few levels deep. We try two strategies
 *  and pick whichever gives a useful list:
 *
 *  1. **Wrapper-strip**: walk past single-child Groups, take the first
 *     multi-child level. Works for `Scene → Assembly → [Part1..]`.
 *  2. **Traversal fallback**: collect every *named* renderable node
 *     in the tree, suppressing children whose named ancestor is
 *     already in the list. Works for deeply nested assemblies where
 *     the meaningful parts live at varying depths.
 *
 *  Returns `[]` only when neither strategy finds 2+ pieces — typical for
 *  single-mesh STL/OBJ exports, where the toggle button stays hidden.
 *
 *  IDs are stable across re-exports of the same model (use the node
 *  `name`); when names collide we suffix `#<index>` so the persisted
 *  `hidden_parts` list can still distinguish them. */
function findParts(rootObj) {
  if (!rootObj) return []

  // Strategy 1: strip wrappers.
  let node = rootObj
  while (node?.children?.length === 1) {
    node = node.children[0]
  }
  const directKids = (node?.children ?? []).filter(hasRenderableDescendant)
  if (directKids.length >= 2) return toPartList(directKids)

  // Strategy 2: traverse and collect named renderables. Suppress nodes
  // whose ancestor is already collected so we don't double-count
  // (e.g. "Part" + "Part > Mesh001" both showing up).
  const collected = []
  const collectedSet = new Set()
  rootObj.traverse?.((n) => {
    if (!n.name) return
    if (!hasRenderableDescendant(n)) return
    let ancestor = n.parent
    while (ancestor) {
      if (collectedSet.has(ancestor)) return
      ancestor = ancestor.parent
    }
    collected.push(n)
    collectedSet.add(n)
  })
  if (collected.length >= 2) return toPartList(collected)

  return []
}

function toPartList(nodes) {
  // Name collision guard — if the model has multiple `Mesh001`s
  // (Blender's default export, for one), give each a `#<idx>` suffix
  // so toggling one doesn't toggle them all.
  const counts = {}
  for (const n of nodes) {
    const k = n.name || ''
    counts[k] = (counts[k] || 0) + 1
  }
  return nodes.map((n, i) => {
    const displayName = n.name || `Part ${i + 1}`
    let id
    if (!n.name) id = `_unnamed_${i}`
    else if (counts[n.name] > 1) id = `${n.name}#${i}`
    else id = n.name
    return { id, name: displayName, node: n }
  })
}

function hasRenderableDescendant(obj) {
  let found = false
  obj.traverse?.((n) => {
    if (n.isMesh || n.isLine || n.isLineSegments || n.isPoints) found = true
  })
  return found
}

// Edge-detection threshold (degrees). 30° gets the dihedral corners
// CAD users expect (cube faces, fillets boundary) without flooding
// curved surfaces with triangle edges. Anything smaller starts
// looking like noise; bigger drops important feature lines.
const EDGES_THRESHOLD_DEG = 30

/** Decorate one part: traverse its meshes, attach EdgesGeometry +
 *  WireframeGeometry LineSegments as siblings. Returns the part
 *  augmented with `.edges[]` and `.wireframes[]` references — the
 *  apply-mode effect uses those to flip visibility on render.
 *
 *  Adding lines as siblings (vs children) means the lines inherit the
 *  exact transform chain of the mesh from the mesh's parent — same
 *  result without nesting structural noise into the model tree. */
function decorateParts(part, THREE) {
  const edges = []
  const wireframes = []
  part.node.traverse?.((n) => {
    if (!n.isMesh) return
    if (n.userData.__cadDecorated) return
    const { edge, wireframe } = attachDecorations(n, THREE)
    if (edge) edges.push(edge)
    if (wireframe) wireframes.push(wireframe)
  })
  return { ...part, edges, wireframes }
}

/** Same as `decorateParts` but operates on the *whole* imported tree.
 *  Used as a fallback for single-mesh files where findParts returned
 *  nothing — we still want feature edges to render. */
function decorateMeshTree(rootObj, THREE) {
  rootObj.traverse?.((n) => {
    if (!n.isMesh) return
    if (n.userData.__cadDecorated) return
    attachDecorations(n, THREE)
  })
}

function attachDecorations(mesh, THREE) {
  if (!mesh.geometry) return { edge: null, wireframe: null }
  mesh.userData.__cadDecorated = true
  mesh.userData.isCadSolid = true
  const parent = mesh.parent
  if (!parent) return { edge: null, wireframe: null }

  // Feature edges — only the sharp corners. Drawn slightly above the
  // surface to dodge z-fighting (polygonOffset on the solid would be
  // cleaner, but most STL imports lack the precision for it to help).
  let edge = null
  try {
    const edgesGeom = new THREE.EdgesGeometry(mesh.geometry, EDGES_THRESHOLD_DEG)
    const edgesMat = new THREE.LineBasicMaterial({
      color: 0x1f2937,
      transparent: true,
      opacity: 0.9,
    })
    edge = new THREE.LineSegments(edgesGeom, edgesMat)
    edge.position.copy(mesh.position)
    edge.rotation.copy(mesh.rotation)
    edge.scale.copy(mesh.scale)
    edge.userData.isCadEdges = true
    edge.renderOrder = 1
    parent.add(edge)
  } catch (err) {
    console.warn('[Cad3d] EdgesGeometry failed:', err)
  }

  // Full wireframe — every triangle edge. Hidden until the user puts
  // this part in wireframe mode.
  let wireframe = null
  try {
    const wireGeom = new THREE.WireframeGeometry(mesh.geometry)
    const wireMat = new THREE.LineBasicMaterial({
      color: 0x475569,
      transparent: true,
      opacity: 0.85,
    })
    wireframe = new THREE.LineSegments(wireGeom, wireMat)
    wireframe.position.copy(mesh.position)
    wireframe.rotation.copy(mesh.rotation)
    wireframe.scale.copy(mesh.scale)
    wireframe.userData.isCadWireframe = true
    wireframe.visible = false
    parent.add(wireframe)
  } catch (err) {
    console.warn('[Cad3d] WireframeGeometry failed:', err)
  }
  return { edge, wireframe }
}

/** Project a Three.js world position into screen-space pixels relative
 *  to the canvas container. Returns null when the point is behind the
 *  camera so callers can hide the label. */
function projectToScreen(worldPos, camera, width, height) {
  // Vector3.project gives -1..1 NDC; behind-camera points have z > 1.
  const ndc = worldPos.clone().project(camera)
  if (ndc.z > 1 || ndc.z < -1) return null
  return {
    x: ((ndc.x + 1) / 2) * width,
    y: ((-ndc.y + 1) / 2) * height,
  }
}

export function Cad3dPropsPanel({ props, onChange }) {
  return (
    <div className="space-y-4">
      <LabelField
        label="라벨"
        value={props.label}
        onChange={(v) => onChange({ ...props, label: v })}
        placeholder="3D 모델"
      />
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-xs">단위</Label>
          <select
            value={props.unit ?? 'mm'}
            onChange={(e) => onChange({ ...props, unit: e.target.value })}
            className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="mm">mm</option>
            <option value="cm">cm</option>
            <option value="m">m</option>
          </select>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            (Phase 2 거리 측정에 적용)
          </p>
        </div>
        <div>
          <Label className="text-xs">기본 뷰</Label>
          <select
            value={props.default_view ?? 'iso'}
            onChange={(e) => onChange({ ...props, default_view: e.target.value })}
            className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
          >
            {VIEW_PRESETS.map((v) => (
              <option key={v} value={v}>
                {PRESET_LABELS[v]}
              </option>
            ))}
            <option value="fit">맞춤 (자동)</option>
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={props.show_grid !== false}
            onChange={(e) => onChange({ ...props, show_grid: e.target.checked })}
          />
          그리드 표시
        </label>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={props.show_axes !== false}
            onChange={(e) => onChange({ ...props, show_axes: e.target.checked })}
          />
          축 표시
        </label>
      </div>
      <div>
        <Label className="text-xs">배경색</Label>
        <Input
          type="color"
          value={props.background ?? '#f8fafc'}
          onChange={(e) => onChange({ ...props, background: e.target.value })}
          className="mt-1 h-9 w-full"
        />
      </div>
    </div>
  )
}

export function Cad3dPreview({ props }) {
  return (
    <div className="space-y-2">
      <PreviewLabel hint={props.default_view ?? 'iso'}>
        {props.label || '(라벨 없음)'}
      </PreviewLabel>
      <div className="aspect-video bg-muted/40 border border-dashed rounded-md flex items-center justify-center text-muted-foreground">
        <Box className="h-8 w-8" />
      </div>
    </div>
  )
}

export function Cad3dEditor({ props, content, onChange, readOnly, autoFit }) {
  const caption = content?.caption ?? ''
  const fileId = content?.file_id ?? null
  const loadedFilename = content?.loaded_filename ?? null
  const viewState = content?.view_state ?? null
  const capPos = captionPositionOf(content)

  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(0)
  const fileInputRef = useRef(null)

  // The viewer takes the cell's full height when the cell has a fixed
  // size (autoFit=false). When autoFit=true we fall back to a fixed
  // aspect box — same trade-off image widget makes.
  const fillCell = autoFit === false

  function patchContent(patch) {
    const next = { ...(content ?? {}), caption, ...patch }
    if (next.file_id == null) {
      // Model removed → strip every per-model field. Annotation
      // world coordinates and part names are meaningless once the
      // model is gone.
      delete next.file_id
      delete next.loaded_filename
      delete next.view_state
      delete next.annotations
      delete next.hidden_parts
      delete next.wireframe_parts
    }
    if (!next.caption) delete next.caption
    if (!next.caption_skip_autofill) delete next.caption_skip_autofill
    if (!next.view_state) delete next.view_state
    if (Array.isArray(next.annotations) && next.annotations.length === 0) {
      delete next.annotations
    }
    if (Array.isArray(next.hidden_parts) && next.hidden_parts.length === 0) {
      delete next.hidden_parts
    }
    if (Array.isArray(next.wireframe_parts) && next.wireframe_parts.length === 0) {
      delete next.wireframe_parts
    }
    onChange(next)
  }

  async function handleFile(file) {
    if (!file) return
    const ext = '.' + (file.name.split('.').pop() ?? '').toLowerCase()
    if (!ACCEPTED_EXTS.includes(ext)) {
      toast.error(
        `지원하지 않는 형식: ${ext || '(확장자 없음)'} — ${ACCEPTED_EXTS.join(', ')} 만 가능`,
      )
      return
    }
    setUploading(true)
    setProgress(0)
    try {
      const meta = await uploadFile(file, { onProgress: setProgress })
      patchContent({
        file_id: meta.id,
        loaded_filename: file.name,
        view_state: null,
      })
    } catch (err) {
      toast.error(err.message || '업로드 실패')
    } finally {
      setUploading(false)
      setProgress(0)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  function onDrop(e) {
    e.preventDefault()
    const f = e.dataTransfer.files?.[0]
    if (f) handleFile(f)
  }

  function clear() {
    patchContent({ file_id: null, loaded_filename: null, view_state: null })
  }

  return (
    <div
      className={cn(
        'flex flex-col gap-3',
        fillCell && 'h-full',
      )}
    >
      {capPos !== 'below' && (
        <CaptionInput
          value={caption}
          onChange={readOnly ? undefined : (v) => patchContent({ caption: v })}
          readOnly={readOnly}
          placeholder={props.label}
          {...(readOnly
            ? { skipAutofill: content?.caption_skip_autofill }
            : captionSkipProps({ content, patch: patchContent }))}
        />
      )}

      {fileId ? (
        <CadCanvas
          fileId={fileId}
          loadedFilename={loadedFilename}
          props={props}
          viewState={viewState}
          annotations={content?.annotations ?? []}
          hiddenParts={content?.hidden_parts ?? []}
          wireframeParts={content?.wireframe_parts ?? []}
          onSaveView={readOnly ? null : (state) => patchContent({ view_state: state })}
          onClearView={readOnly ? null : () => patchContent({ view_state: null })}
          onChangeAnnotations={
            readOnly ? null : (next) => patchContent({ annotations: next })
          }
          // Single atomic callback for parts state — combines hidden +
          // wireframe updates into ONE patchContent call. Splitting them
          // caused the second call to read stale `content` from the
          // closure and clobber the first, so toggling an individual
          // part to "hidden" looked like a no-op (but "전부 숨김" worked
          // because it only fires one callback).
          onChangePartsState={
            readOnly ? null : (patch) => patchContent(patch)
          }
          onClear={readOnly ? null : clear}
          fillCell={fillCell}
        />
      ) : (
        !readOnly && (
          <UploadDropzone
            uploading={uploading}
            progress={progress}
            onDrop={onDrop}
            onPick={() => fileInputRef.current?.click()}
            fileInputRef={fileInputRef}
            onFile={handleFile}
          />
        )
      )}
      {capPos === 'below' && (
        <CaptionInput
          value={caption}
          onChange={readOnly ? undefined : (v) => patchContent({ caption: v })}
          readOnly={readOnly}
          placeholder={props.label}
          {...(readOnly
            ? { skipAutofill: content?.caption_skip_autofill }
            : captionSkipProps({ content, patch: patchContent }))}
        />
      )}
    </div>
  )
}

function UploadDropzone({ uploading, progress, onDrop, onPick, fileInputRef, onFile }) {
  return (
    <div
      tabIndex={0}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
      className="border-2 border-dashed rounded-md p-6 text-center shrink-0 hover:bg-muted/20 focus:bg-muted/30 focus:outline-none focus:ring-2 focus:ring-primary/40 transition-colors"
    >
      {uploading ? (
        <div className="flex flex-col items-center gap-2 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-xs">업로드 중… {Math.round(progress * 100)}%</span>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2 text-muted-foreground">
          <Box className="h-5 w-5" />
          <div className="text-xs">
            3D 모델 파일 드래그·앤·드롭, 또는{' '}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={(e) => {
                e.stopPropagation()
                onPick()
              }}
              className="h-7 text-xs"
            >
              파일 선택
            </Button>
          </div>
          <div className="text-[10px]">
            지원 형식: {ACCEPTED_EXTS.join(', ')} (Phase 5에서 STEP/IGES 추가 예정)
          </div>
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT_ATTR}
        className="hidden"
        onChange={(e) => onFile(e.target.files?.[0])}
      />
    </div>
  )
}

/**
 * Three.js-backed 3D canvas. Mounts a renderer + scene + OrbitControls,
 * fetches the model bytes through AuthedImage's blob-fetch path so the
 * JWT header is attached, and disposes everything on unmount or model
 * swap. Renders **on demand** — frame is only drawn after a control
 * event so an idle widget consumes ~0% CPU.
 */
function CadCanvas({
  fileId,
  loadedFilename,
  props,
  viewState,
  annotations,
  hiddenParts,
  wireframeParts,
  // readOnly is no longer needed inside the canvas — the existence of
  // `onChangeAnnotations` (and similarly onSaveView / onClear) tells
  // us whether each side of the UI is a writer or a viewer. Cleaner
  // contract than threading a redundant flag.
  onSaveView,
  onClearView,
  onChangeAnnotations,
  onChangePartsState,
  onClear,
  fillCell,
}) {
  const containerRef = useRef(null)
  const stateRef = useRef(null) // holds THREE objects so cleanup can dispose them
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [bbox, setBbox] = useState(null)
  const [showGrid, setShowGrid] = useState(props.show_grid !== false)
  const [showAxes, setShowAxes] = useState(props.show_axes !== false)
  // Measure-mode UI state. `pendingPoint` is the first click of an
  // in-progress distance — null when nothing's pending.
  const [measureMode, setMeasureMode] = useState(false)
  const [snapEnabled, setSnapEnabled] = useState(true)
  const [pendingPoint, setPendingPoint] = useState(null)
  const [selectedAnnoId, setSelectedAnnoId] = useState(null)
  // Transient (= unsaved) measurements created by the *viewer* in
  // read-only mode. The toolbar lets readers measure ad-hoc without
  // dirtying the report's persisted state; these live only as long as
  // the component is mounted. In edit mode this stays empty — writes
  // go straight to `content.annotations` via onChangeAnnotations.
  const [transientAnnotations, setTransientAnnotations] = useState([])
  // Top-level part list extracted from the loaded model. Populated
  // after init() resolves; rebuilt when the model file changes. Each
  // entry carries the part's Three.js node plus arrays of the
  // companion edges / wireframe LineSegments created during decorate
  // (so we can flip mode without retraversing the scene).
  const [parts, setParts] = useState([])
  // Viewer's ad-hoc visibility overrides — partId → boolean.
  const [transientPartVis, setTransientPartVis] = useState({})
  // Viewer's ad-hoc wireframe overrides — partId → boolean. Same
  // override-takes-precedence pattern as transientPartVis.
  const [transientWireframe, setTransientWireframe] = useState({})
  const [partsSearch, setPartsSearch] = useState('')
  // Persistent sidebar (replaces the previous popover). Default to
  // open so multi-part models show their structure immediately.
  const [sidebarOpen, setSidebarOpen] = useState(true)
  // Feature-edges overlay (the sharp-angle outline that makes shape
  // boundaries readable). Default on — it's the main reason we built
  // the decoration pipeline.
  const [showEdges, setShowEdges] = useState(true)
  // Hover preview point during measure mode — world coords of the
  // snap target under the cursor. Drives the in-scene ghost marker
  // so the user sees what they'd lock in *before* clicking.
  const [hoverPoint, setHoverPoint] = useState(null)
  // Browser fullscreen toggle — drives the toolbar icon and is kept
  // in sync with the actual document state via `fullscreenchange` so
  // an Esc keypress (which exits fullscreen) updates the icon too.
  const outerRef = useRef(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  // Bumps every Three.js render — keeps the SVG label overlay in
  // lockstep with the camera without coupling React state to the
  // animation loop.
  const [renderTick, setRenderTick] = useState(0)
  const background = props.background ?? '#f8fafc'
  const defaultView = props.default_view ?? 'iso'
  const unit = props.unit ?? 'mm'
  // Persisted annotations (saved with the report).
  const persistedList = useMemo(
    () => (Array.isArray(annotations) ? annotations : []),
    [annotations],
  )
  // Combined list with a `transient` flag so the renderer can color
  // them differently. Persisted are drawn cyan, transient amber.
  const annoList = useMemo(
    () => [
      ...persistedList.map((a) => ({ ...a, transient: false })),
      ...transientAnnotations.map((a) => ({ ...a, transient: true })),
    ],
    [persistedList, transientAnnotations],
  )

  const hiddenSet = useMemo(
    () => new Set(Array.isArray(hiddenParts) ? hiddenParts : []),
    [hiddenParts],
  )
  const wireframeSet = useMemo(
    () => new Set(Array.isArray(wireframeParts) ? wireframeParts : []),
    [wireframeParts],
  )
  const isPartVisible = useCallback(
    (partId) => {
      if (Object.prototype.hasOwnProperty.call(transientPartVis, partId)) {
        return transientPartVis[partId]
      }
      return !hiddenSet.has(partId)
    },
    [hiddenSet, transientPartVis],
  )
  /** 'shaded' | 'wireframe' | 'hidden' — combined resolution of
   *  per-part visibility + wireframe flag, with transient overrides
   *  taking precedence over persisted state. */
  const getPartMode = useCallback(
    (partId) => {
      if (!isPartVisible(partId)) return 'hidden'
      const transientWf = Object.prototype.hasOwnProperty.call(
        transientWireframe,
        partId,
      )
        ? transientWireframe[partId]
        : null
      const wf = transientWf !== null ? transientWf : wireframeSet.has(partId)
      return wf ? 'wireframe' : 'shaded'
    },
    [isPartVisible, transientWireframe, wireframeSet],
  )

  // Schedules a single render-on-next-frame. OrbitControls + button
  // handlers call this so we don't burn frames while idle. After the
  // render, bump renderTick so the SVG label overlay re-projects.
  const requestRender = useCallback(() => {
    const s = stateRef.current
    if (!s || s.disposed) return
    if (s.renderPending) return
    s.renderPending = true
    requestAnimationFrame(() => {
      if (!stateRef.current || stateRef.current.disposed) return
      stateRef.current.renderPending = false
      stateRef.current.renderer.render(stateRef.current.scene, stateRef.current.camera)
      setRenderTick((t) => (t + 1) % 1_000_000)
    })
  }, [])

  // One-time scene init keyed by fileId — a new model = a new scene.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return undefined

    let cancelled = false
    setLoading(true)
    setError(null)
    setBbox(null)
    // A new model = its own parts list and its own ad-hoc overrides.
    // Persisted hidden_parts / wireframe_parts stay — names that
    // don't match anything in the new model just have no effect.
    setParts([])
    setTransientPartVis({})
    setTransientWireframe({})
    setHoverPoint(null)

    let state = null

    const init = async () => {
      let stack
      try {
        stack = await loadThreeStack()
      } catch (err) {
        if (!cancelled) setError(`three.js 로드 실패: ${err.message}`)
        return
      }
      if (cancelled) return
      const { THREE, OrbitControls } = stack

      const width = container.clientWidth || 1
      const height = container.clientHeight || 1

      const scene = new THREE.Scene()
      scene.background = new THREE.Color(background)

      const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100000)

      // preserveDrawingBuffer = true so canvas.toDataURL() works for
      // Phase-4 PNG capture into DOCX / PDF exports.
      const renderer = new THREE.WebGLRenderer({
        antialias: true,
        preserveDrawingBuffer: true,
      })
      renderer.setPixelRatio(window.devicePixelRatio)
      renderer.setSize(width, height, false)
      // Explicit CSS so the canvas always tracks its container's
      // layout box (we pass updateStyle=false to setSize because we
      // want CSS-driven sizing, not pixel-buffer-driven). Without
      // this, fullscreen exit could leave the canvas at its
      // pre-fullscreen intrinsic size while the container shrank back —
      // model appears "off-screen" even though the scene is fine.
      renderer.domElement.style.display = 'block'
      renderer.domElement.style.width = '100%'
      renderer.domElement.style.height = '100%'
      container.appendChild(renderer.domElement)

      // WebGL context loss / restore — happens on some browsers
      // (notably Chrome/Edge) when the canvas transitions in or out
      // of fullscreen. Without these handlers the scene goes blank
      // and only a full remount recovers it.
      renderer.domElement.addEventListener('webglcontextlost', (e) => {
        e.preventDefault()
        console.warn('[Cad3d] WebGL context lost')
      })
      renderer.domElement.addEventListener('webglcontextrestored', () => {
        console.info('[Cad3d] WebGL context restored — repainting')
        requestRender()
      })

      const controls = new OrbitControls(camera, renderer.domElement)
      controls.enableDamping = false
      controls.addEventListener('change', () => {
        if (stateRef.current && !stateRef.current.disposed) {
          stateRef.current.renderPending = false // force fresh schedule
          requestRender()
        }
      })

      // Lights — ambient + key + fill, matches the MechaGen viewer's
      // recipe (verified to give clean rendering on grey-PBR models).
      scene.add(new THREE.AmbientLight(0xffffff, 0.55))
      const key = new THREE.DirectionalLight(0xffffff, 0.85)
      key.position.set(60, 80, 60)
      scene.add(key)
      const fill = new THREE.DirectionalLight(0xffffff, 0.35)
      fill.position.set(-40, 30, -40)
      scene.add(fill)

      // Grid + axes helpers (toggleable). Sized after we know the model.
      const gridHelper = new THREE.GridHelper(10, 10, 0x999999, 0xdddddd)
      const axesHelper = new THREE.AxesHelper(5)
      gridHelper.visible = showGrid
      axesHelper.visible = showAxes
      scene.add(gridHelper)
      scene.add(axesHelper)

      const modelGroup = new THREE.Group()
      scene.add(modelGroup)

      state = {
        THREE,
        scene,
        camera,
        renderer,
        controls,
        modelGroup,
        gridHelper,
        axesHelper,
        disposed: false,
        renderPending: false,
      }
      stateRef.current = state

      // Fetch model bytes via authenticated blob fetch, then load with
      // the right loader for the extension.
      let blob
      try {
        blob = await fetchFileBlob(fileId)
      } catch (err) {
        if (!cancelled) setError(`파일을 받아오지 못했습니다: ${err.message}`)
        return
      }
      if (cancelled) return

      const ext = '.' + (loadedFilename ?? '').split('.').pop()?.toLowerCase()
      try {
        let obj = await loadModelFromBlob(blob, ext, stack)
        if (cancelled) {
          disposeObject3D(obj, THREE)
          return
        }
        // STL has no native hierarchy — recover one by splitting
        // spatially-disconnected bodies into separate Meshes when the
        // file actually has multiple. No-op for already-hierarchical
        // formats (GLB/GLTF/OBJ).
        obj = await maybeSplitConnectedComponents(obj, ext, stack)
        if (cancelled) {
          disposeObject3D(obj, THREE)
          return
        }
        modelGroup.add(obj)
        const box = new THREE.Box3().setFromObject(modelGroup)
        const size = new THREE.Vector3()
        const center = new THREE.Vector3()
        box.getSize(size)
        box.getCenter(center)

        // Resize helpers to fit the model so the grid is meaningful.
        const helperSize = Math.max(size.x, size.y, size.z, 1) * 1.5
        scene.remove(gridHelper)
        scene.remove(axesHelper)
        const newGrid = new THREE.GridHelper(
          helperSize,
          10,
          0x999999,
          0xdddddd,
        )
        newGrid.position.y = box.min.y
        newGrid.visible = showGrid
        const newAxes = new THREE.AxesHelper(helperSize / 2)
        newAxes.visible = showAxes
        scene.add(newGrid)
        scene.add(newAxes)
        state.gridHelper = newGrid
        state.axesHelper = newAxes

        // Camera placement: prefer saved view_state, else apply preset.
        if (viewState?.position && viewState?.target) {
          camera.position.fromArray(viewState.position)
          controls.target.fromArray(viewState.target)
          if (typeof viewState.zoom === 'number' && viewState.zoom > 0) {
            camera.zoom = viewState.zoom
          } else {
            camera.zoom = 1
          }
          camera.updateProjectionMatrix()
          camera.updateMatrixWorld(true)
        } else {
          applyViewPreset(defaultView, { camera, controls, box, center, size, THREE })
        }
        controls.update()

        if (!cancelled) {
          setBbox({
            size: [size.x, size.y, size.z],
            center: [center.x, center.y, center.z],
          })
          // Extract the part list from the imported object's tree so
          // the toolbar can offer per-part hide/show. Decorate each
          // part's meshes with feature-edge + wireframe LineSegments
          // tracked on the part entry — applyMode then flips their
          // visibility without re-traversing the scene.
          const rawParts = findParts(obj)
          const enrichedParts = rawParts.map((p) =>
            decorateParts(p, THREE),
          )
          // If findParts returned the imported object itself as a
          // single fallback (single-mesh STL/OBJ), still decorate it
          // so global "feature edges" overlay works.
          if (enrichedParts.length === 0) {
            decorateMeshTree(obj, THREE)
          }
          setParts(enrichedParts)
          setLoading(false)
          requestRender()
        }
      } catch (err) {
        if (!cancelled) setError(`모델 파싱 실패: ${err.message}`)
      }
    }

    init()

    // ResizeObserver keeps the renderer + aspect synced with the
    // widget cell (RGL resize, autoFit changes, fullscreen toggles).
    const ro = new ResizeObserver(() => {
      const s = stateRef.current
      if (!s || s.disposed) return
      const w = container.clientWidth || 1
      const h = container.clientHeight || 1
      s.renderer.setSize(w, h, false)
      s.camera.aspect = w / h
      s.camera.updateProjectionMatrix()
      requestRender()
    })
    ro.observe(container)

    return () => {
      cancelled = true
      ro.disconnect()
      const s = stateRef.current
      if (s && !s.disposed) {
        s.disposed = true
        s.controls.dispose()
        // Walk the scene and dispose all geometries/materials/textures.
        s.scene.traverse((obj) => disposeObject3D(obj, s.THREE, { onlyOwn: true }))
        s.renderer.dispose()
        if (s.renderer.domElement.parentNode === container) {
          container.removeChild(s.renderer.domElement)
        }
      }
      stateRef.current = null
    }
    // showGrid/showAxes are toggled via a separate effect below so we
    // don't tear down the whole scene when the user clicks a checkbox.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, loadedFilename])

  // Background, grid, axes can all be flipped without rebuilding.
  useEffect(() => {
    const s = stateRef.current
    if (!s || s.disposed) return
    s.scene.background = new s.THREE.Color(background)
    requestRender()
  }, [background, requestRender])
  useEffect(() => {
    const s = stateRef.current
    if (!s || s.disposed) return
    if (s.gridHelper) s.gridHelper.visible = showGrid
    requestRender()
  }, [showGrid, requestRender])
  useEffect(() => {
    const s = stateRef.current
    if (!s || s.disposed) return
    if (s.axesHelper) s.axesHelper.visible = showAxes
    requestRender()
  }, [showAxes, requestRender])

  // ---- Saved view re-apply on viewState change. ----
  // The init effect captures viewState at mount/file change time, so
  // if the report's content arrives in two stages (or if the user
  // hits "뷰 저장" / "뷰 초기화" while the widget is already
  // mounted), init won't re-fire. This effect handles those updates.
  // Runs *after* the scene exists and the model has loaded, so the
  // first-load path also flows through here for parity. It also
  // mirrors show_grid / show_axes onto local state — that's why the
  // grid / axis toggles weren't surviving a reload before.
  useEffect(() => {
    const s = stateRef.current
    if (!s || s.disposed || !s.modelGroup) return
    if (loading || error) return
    if (!viewState) return
    if (
      Array.isArray(viewState.position) &&
      Array.isArray(viewState.target) &&
      viewState.position.length === 3 &&
      viewState.target.length === 3
    ) {
      s.camera.position.fromArray(viewState.position)
      s.controls.target.fromArray(viewState.target)
      if (typeof viewState.zoom === 'number' && viewState.zoom > 0) {
        s.camera.zoom = viewState.zoom
      } else {
        s.camera.zoom = 1
      }
      s.camera.updateProjectionMatrix()
      s.camera.updateMatrixWorld(true)
      s.controls.update()
    }
    if (typeof viewState.show_grid === 'boolean') setShowGrid(viewState.show_grid)
    if (typeof viewState.show_axes === 'boolean') setShowAxes(viewState.show_axes)
    if (typeof viewState.sidebar_open === 'boolean') setSidebarOpen(viewState.sidebar_open)
    requestRender()
  }, [viewState, loading, error, requestRender])

  // ---- Measure: re-build in-scene markers whenever annotations change. ----
  useEffect(() => {
    const s = stateRef.current
    if (!s || s.disposed || !s.modelGroup) return
    if (!s.measureGroup) {
      s.measureGroup = new s.THREE.Group()
      s.measureGroup.name = 'measure'
      s.scene.add(s.measureGroup)
    }
    // Tear down previous geometry — required, GPU memory doesn't GC.
    while (s.measureGroup.children.length) {
      const child = s.measureGroup.children.pop()
      disposeObject3D(child, s.THREE)
    }
    // Marker size is proportional to the model — too small disappears,
    // too big covers what you're trying to measure.
    const radius = bbox ? Math.max(...bbox.size, 1) * 0.008 : 1
    for (const a of annoList) {
      // Persisted = cyan; viewer's ad-hoc = amber. Selected always
      // overrides with the warm orange so it pops in either palette.
      const baseColor = a.transient ? 0xf59e0b : 0x0ea5e9
      const color = a.id === selectedAnnoId ? 0xff5722 : (a.color ?? baseColor)
      addMeasureMarker(s.measureGroup, s.THREE, a.p1, { radius, color })
      if (a.type === 'distance_3d' && a.p2) {
        addMeasureMarker(s.measureGroup, s.THREE, a.p2, { radius, color })
        addMeasureLine(s.measureGroup, s.THREE, a.p1, a.p2, { color })
      }
    }
    requestRender()
  }, [annoList, bbox, selectedAnnoId, requestRender])

  // ---- Parts: apply per-part rendering mode (shaded/wireframe/hidden)
  //      + global feature-edges toggle. ----
  useEffect(() => {
    if (parts.length === 0) return
    for (const p of parts) {
      const mode = getPartMode(p.id)
      const partVisible = mode !== 'hidden'
      p.node.visible = partVisible
      // Solid + edges + wireframe must be set explicitly EVEN when
      // the part is hidden: edges/wireframes are attached to each
      // mesh's *parent*, which sits outside part.node when part.node
      // IS a leaf mesh (STL split parts and flat-GLB parts both hit
      // this case). Inheriting `.visible = false` from p.node only
      // covers the nested-group case.
      p.node.traverse?.((n) => {
        if (n.userData?.isCadSolid) {
          n.visible = partVisible && mode === 'shaded'
        }
      })
      for (const e of p.edges) {
        e.visible = partVisible && mode === 'shaded' && showEdges
      }
      for (const w of p.wireframes) {
        w.visible = partVisible && mode === 'wireframe'
      }
    }
    requestRender()
  }, [parts, getPartMode, showEdges, requestRender])

  // Persist or stash a single part's mode change. Three modes:
  //  - 'shaded'    : visible, solid + (optionally) feature edges
  //  - 'wireframe' : visible, all-triangle wireframe, no solid
  //  - 'hidden'    : invisible
  // Maintenance: hidden_parts and wireframe_parts are independent lists
  // (a part may live in both, but `hidden` wins on the resolution side).
  const setPartMode = useCallback(
    (partId, mode) => {
      if (onChangePartsState) {
        // Writer path: derive next hidden/wireframe sets and persist
        // both in a single patch — splitting into two callbacks
        // caused the second to clobber the first via stale-closure
        // content reads in patchContent.
        const h = new Set(Array.isArray(hiddenParts) ? hiddenParts : [])
        const w = new Set(Array.isArray(wireframeParts) ? wireframeParts : [])
        if (mode === 'hidden') {
          h.add(partId)
          w.delete(partId)
        } else if (mode === 'wireframe') {
          h.delete(partId)
          w.add(partId)
        } else {
          h.delete(partId)
          w.delete(partId)
        }
        onChangePartsState({
          hidden_parts: Array.from(h),
          wireframe_parts: Array.from(w),
        })
      } else {
        // Viewer path: transient overrides for both axes. Two
        // separate local setState calls are fine here — React
        // batches them automatically within the same event handler.
        if (mode === 'hidden') {
          setTransientPartVis((prev) => ({ ...prev, [partId]: false }))
        } else {
          setTransientPartVis((prev) => ({ ...prev, [partId]: true }))
          setTransientWireframe((prev) => ({
            ...prev,
            [partId]: mode === 'wireframe',
          }))
        }
      }
    },
    [hiddenParts, wireframeParts, onChangePartsState],
  )

  // Quick "make every part visible / hidden" used by sidebar buttons.
  const setAllPartsVisible = useCallback(
    (visible) => {
      const ids = parts.map((p) => p.id)
      if (onChangePartsState) {
        // Hiding everything also clears wireframe overrides — they're
        // moot once nothing's visible, and leaving them around looks
        // weird when the user later un-hides.
        onChangePartsState({
          hidden_parts: visible ? [] : ids,
          wireframe_parts: visible ? wireframeParts : [],
        })
      } else {
        const next = {}
        for (const id of ids) next[id] = visible
        setTransientPartVis(next)
      }
    },
    [parts, wireframeParts, onChangePartsState],
  )

  // Reset all transient overrides — viewer's "임시 복원" button.
  const resetTransientPartState = useCallback(() => {
    setTransientPartVis({})
    setTransientWireframe({})
  }, [])

  // Pending point (between click 1 and click 2). Visualized as a
  // pulsing marker; same color we'll use for the finalized line.
  useEffect(() => {
    const s = stateRef.current
    if (!s || s.disposed) return
    if (!s.pendingGroup) {
      s.pendingGroup = new s.THREE.Group()
      s.pendingGroup.name = 'measure-pending'
      s.scene.add(s.pendingGroup)
    }
    while (s.pendingGroup.children.length) {
      const child = s.pendingGroup.children.pop()
      disposeObject3D(child, s.THREE)
    }
    if (pendingPoint) {
      const radius = bbox ? Math.max(...bbox.size, 1) * 0.012 : 1
      addMeasureMarker(s.pendingGroup, s.THREE, pendingPoint, {
        radius,
        color: 0xf97316,
      })
    }
    requestRender()
  }, [pendingPoint, bbox, requestRender])

  // Hover preview marker — the snap target under the cursor while in
  // measure mode. Translucent and slightly larger than the committed
  // markers so it reads as a "ghost" the user hasn't locked in yet.
  useEffect(() => {
    const s = stateRef.current
    if (!s || s.disposed) return
    if (!s.hoverGroup) {
      s.hoverGroup = new s.THREE.Group()
      s.hoverGroup.name = 'measure-hover'
      s.scene.add(s.hoverGroup)
    }
    while (s.hoverGroup.children.length) {
      const child = s.hoverGroup.children.pop()
      disposeObject3D(child, s.THREE)
    }
    if (hoverPoint && measureMode) {
      const radius = bbox ? Math.max(...bbox.size, 1) * 0.014 : 1
      const geom = new s.THREE.SphereGeometry(radius, 16, 12)
      const mat = new s.THREE.MeshBasicMaterial({
        color: 0xfbbf24, // amber-400, distinct from pending orange + finalized cyan
        depthTest: false,
        transparent: true,
        opacity: 0.55,
        wireframe: true,
      })
      const sphere = new s.THREE.Mesh(geom, mat)
      sphere.position.set(hoverPoint.x, hoverPoint.y, hoverPoint.z)
      sphere.renderOrder = 1500
      s.hoverGroup.add(sphere)
    }
    requestRender()
  }, [hoverPoint, measureMode, bbox, requestRender])

  // Mouse-move on the canvas: while measure mode is on, run the same
  // raycast + snap logic that handleCanvasClick uses and surface the
  // would-be hit position. We throttle with rAF so a fast move doesn't
  // queue up dozens of raycasts.
  const hoverRafRef = useRef(0)
  const handleCanvasMouseMove = useCallback(
    (e) => {
      if (!measureMode) return
      if (hoverRafRef.current) return
      const clientX = e.clientX
      const clientY = e.clientY
      hoverRafRef.current = requestAnimationFrame(() => {
        hoverRafRef.current = 0
        const s = stateRef.current
        if (!s || s.disposed) return
        const rect = s.renderer.domElement.getBoundingClientRect()
        const ndc = new s.THREE.Vector2(
          ((clientX - rect.left) / rect.width) * 2 - 1,
          -((clientY - rect.top) / rect.height) * 2 + 1,
        )
        const raycaster = new s.THREE.Raycaster()
        raycaster.setFromCamera(ndc, s.camera)
        const hits = raycaster.intersectObjects(s.modelGroup.children, true)
        if (hits.length === 0) {
          setHoverPoint(null)
          return
        }
        const hit = hits[0]
        let point = hit.point.clone()
        if (snapEnabled && hit.face && hit.object.geometry?.attributes?.position) {
          const snap = snapToVertex(
            hit,
            s.camera,
            rect.width,
            rect.height,
            { clientX: clientX - rect.left, clientY: clientY - rect.top },
            s.THREE,
          )
          if (snap) point = snap
        }
        setHoverPoint({ x: point.x, y: point.y, z: point.z })
      })
    },
    [measureMode, snapEnabled],
  )

  // Clear hover when leaving measure mode or canvas.
  useEffect(() => {
    if (!measureMode) setHoverPoint(null)
  }, [measureMode])

  // ---- Measure: handle clicks on the canvas while in measure mode. ----
  // Works in both edit and view mode. Edit mode persists via
  // `onChangeAnnotations`; view mode keeps the measurement in local
  // `transientAnnotations` so a reader can take ad-hoc measurements
  // without dirtying the report.
  const handleCanvasClick = useCallback(
    (e) => {
      if (!measureMode) return
      const s = stateRef.current
      if (!s || s.disposed) return
      const rect = s.renderer.domElement.getBoundingClientRect()
      const ndc = new s.THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      )
      const raycaster = new s.THREE.Raycaster()
      raycaster.setFromCamera(ndc, s.camera)
      const hits = raycaster.intersectObjects(s.modelGroup.children, true)
      if (hits.length === 0) return
      const hit = hits[0]
      // Snap-to-vertex: pick the face's nearest vertex within a screen
      // pixel threshold — much closer to engineering "click corner"
      // intent than a raw face hit ever is.
      let point = hit.point.clone()
      if (snapEnabled && hit.face && hit.object.geometry?.attributes?.position) {
        const snap = snapToVertex(
          hit,
          s.camera,
          rect.width,
          rect.height,
          { clientX: e.clientX - rect.left, clientY: e.clientY - rect.top },
          s.THREE,
        )
        if (snap) point = snap
      }
      const p = { x: point.x, y: point.y, z: point.z }
      if (!pendingPoint) {
        setPendingPoint(p)
        return
      }
      // Second click — commit a distance annotation. Persist when we
      // have a writer (edit mode), otherwise file it under the
      // viewer's transient list.
      const existingIds = new Set(annoList.map((a) => a.id))
      const next = {
        id: freshAnnotationId(existingIds),
        type: 'distance_3d',
        p1: pendingPoint,
        p2: p,
      }
      if (onChangeAnnotations) {
        onChangeAnnotations([...persistedList, next])
      } else {
        setTransientAnnotations((prev) => [...prev, next])
      }
      setPendingPoint(null)
    },
    [measureMode, snapEnabled, pendingPoint, annoList, persistedList, onChangeAnnotations],
  )

  // Esc cancels the pending measurement; Delete drops the selected
  // one. Routes the delete to the right list — persisted ones go back
  // to the writer (only effective in edit mode); transient ones come
  // out of local state regardless. Document-level so the key works
  // whether or not the canvas has focus.
  useEffect(() => {
    function isEditableTarget() {
      const a = document.activeElement
      const tag = a?.tagName?.toLowerCase()
      return tag === 'input' || tag === 'textarea' || a?.isContentEditable
    }
    function onKey(e) {
      if (e.key === 'Escape') {
        if (pendingPoint) {
          e.preventDefault()
          setPendingPoint(null)
        } else if (measureMode) {
          e.preventDefault()
          setMeasureMode(false)
        }
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (isEditableTarget()) return
        if (!selectedAnnoId) return
        const inTransient = transientAnnotations.some((a) => a.id === selectedAnnoId)
        const inPersisted = persistedList.some((a) => a.id === selectedAnnoId)
        if (inTransient) {
          e.preventDefault()
          setTransientAnnotations((prev) => prev.filter((a) => a.id !== selectedAnnoId))
          setSelectedAnnoId(null)
        } else if (inPersisted && onChangeAnnotations) {
          e.preventDefault()
          onChangeAnnotations(persistedList.filter((a) => a.id !== selectedAnnoId))
          setSelectedAnnoId(null)
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [
    pendingPoint,
    measureMode,
    selectedAnnoId,
    transientAnnotations,
    persistedList,
    onChangeAnnotations,
  ])

  function applyPreset(name) {
    const s = stateRef.current
    if (!s || s.disposed) return
    const box = new s.THREE.Box3().setFromObject(s.modelGroup)
    const size = new s.THREE.Vector3()
    const center = new s.THREE.Vector3()
    box.getSize(size)
    box.getCenter(center)
    applyViewPreset(name, {
      camera: s.camera,
      controls: s.controls,
      box,
      center,
      size,
      THREE: s.THREE,
    })
    s.controls.update()
    requestRender()
  }

  // Keep `isFullscreen` in sync with the document — Esc or the
  // browser's UI buttons can exit fullscreen outside our control.
  useEffect(() => {
    function onChange() {
      setIsFullscreen(document.fullscreenElement === outerRef.current)
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  // Fullscreen transitions sometimes leave the renderer with stale
  // dimensions, especially on exit — the ResizeObserver fires while
  // layout is mid-transition and reads the wrong size. Defer one
  // frame so the browser has finished laying out, then force a fresh
  // resize + render. Catches the "objects disappeared after fullscreen
  // exit in view mode" case without relying on the user to interact.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const s = stateRef.current
      const container = containerRef.current
      if (!s || s.disposed || !container) return
      const w = container.clientWidth || 1
      const h = container.clientHeight || 1
      s.renderer.setSize(w, h, false)
      s.camera.aspect = w / h
      s.camera.updateProjectionMatrix()
      requestRender()
    })
    return () => cancelAnimationFrame(id)
  }, [isFullscreen, requestRender])

  function toggleFullscreen() {
    const el = outerRef.current
    if (!el) return
    if (document.fullscreenElement === el) {
      document.exitFullscreen?.()
    } else if (el.requestFullscreen) {
      el.requestFullscreen().catch((err) => {
        toast.error(err?.message || '전체화면 진입 실패')
      })
    } else {
      toast.error('이 브라우저는 전체화면 모드를 지원하지 않습니다.')
    }
  }

  function saveCurrentView() {
    const s = stateRef.current
    if (!s || s.disposed) return
    // Sync OrbitControls before reading — handles edge cases where
    // damping is on or where a pointer-up hadn't committed yet.
    s.controls.update()
    s.camera.updateMatrixWorld(true)
    const payload = {
      position: [s.camera.position.x, s.camera.position.y, s.camera.position.z],
      target: [s.controls.target.x, s.controls.target.y, s.controls.target.z],
      zoom: s.camera.zoom,
      // Capture toolbar toggles so the reader lands on the exact
      // setup the author intended (grid/axes/sidebar).
      show_grid: showGrid,
      show_axes: showAxes,
      sidebar_open: sidebarOpen,
    }
    // Guard against NaN/Inf — would silently break the restore path
    // (validation rejects, viewState stays unset, no "saved view" chip).
    const flat = [...payload.position, ...payload.target, payload.zoom]
    if (flat.some((v) => !Number.isFinite(v))) {
      toast.error('뷰 저장 실패: 카메라 상태가 비정상입니다. 재시도해주세요.')
      return
    }
    onSaveView(payload)
    toast.success('현재 뷰가 저장되었습니다 (카메라 + 그리드 + 축 + 사이드바).')
  }

  return (
    <div
      ref={outerRef}
      className={cn(
        'flex flex-col gap-2 rounded-md border overflow-hidden bg-muted/10',
        // In fullscreen the outer div fills the screen — drop the
        // aspect-video cap so it actually uses the available area.
        isFullscreen
          ? 'h-full w-full'
          : fillCell
            ? 'flex-1 min-h-0'
            : 'aspect-video',
      )}
    >
      <div className="flex items-center gap-1 px-2 py-1.5 text-[10px] text-muted-foreground border-b shrink-0 flex-wrap">
        <Move3d className="h-3 w-3" />
        <span>좌클릭 회전 · 우클릭 이동 · 휠 줌</span>
        <span className="mx-1">·</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[10px]"
              disabled={loading || !!error}
              title="뷰 프리셋"
            >
              <Eye className="mr-1 h-3 w-3" />뷰
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-32">
            {VIEW_PRESETS.map((v) => (
              <DropdownMenuItem
                key={v}
                onClick={() => applyPreset(v)}
                className="text-xs"
              >
                <Eye className="mr-2 h-3 w-3" />
                {PRESET_LABELS[v]}
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem
              onClick={() => applyPreset('fit')}
              className="text-xs"
            >
              <Maximize2 className="mr-2 h-3 w-3" />
              맞춤
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="mx-1">·</span>
        <Button
          type="button"
          size="sm"
          variant={showGrid ? 'secondary' : 'ghost'}
          className="h-6 px-2 text-[10px]"
          onClick={() => setShowGrid((v) => !v)}
        >
          <Grid3x3 className="mr-1 h-3 w-3" />그리드
        </Button>
        <Button
          type="button"
          size="sm"
          variant={showAxes ? 'secondary' : 'ghost'}
          className="h-6 px-2 text-[10px]"
          onClick={() => setShowAxes((v) => !v)}
        >
          <Axis3d className="mr-1 h-3 w-3" />축
        </Button>
        <Button
          type="button"
          size="sm"
          variant={showEdges ? 'secondary' : 'ghost'}
          className="h-6 px-2 text-[10px]"
          onClick={() => setShowEdges((v) => !v)}
          title="형상 경계선 (sharp-angle 엣지) 표시"
        >
          <SquareDashed className="mr-1 h-3 w-3" />엣지
        </Button>
        {!loading && !error && (
          <Button
            type="button"
            size="sm"
            variant={sidebarOpen ? 'secondary' : 'ghost'}
            className="h-6 px-2 text-[10px]"
            onClick={() => setSidebarOpen((v) => !v)}
            title="부품 리스트 사이드바 토글"
          >
            <Layers className="mr-1 h-3 w-3" />
            파트 ({parts.length})
          </Button>
        )}
        <span className="mx-1">·</span>
        <Button
          type="button"
          size="sm"
          variant={measureMode ? 'secondary' : 'ghost'}
          className="h-6 px-2 text-[10px]"
          onClick={() => {
            setMeasureMode((v) => !v)
            setPendingPoint(null)
          }}
          disabled={loading || !!error}
          title={
            onChangeAnnotations
              ? '두 점 클릭으로 거리 측정 (Esc 취소). 저장됩니다.'
              : '두 점 클릭으로 거리 측정 (Esc 취소). 임시 — 저장되지 않습니다.'
          }
        >
          <Ruler className="mr-1 h-3 w-3" />
          측정{!onChangeAnnotations && ' (임시)'}
        </Button>
        {measureMode && (
          <Button
            type="button"
            size="sm"
            variant={snapEnabled ? 'secondary' : 'ghost'}
            className="h-6 px-2 text-[10px]"
            onClick={() => setSnapEnabled((v) => !v)}
            title="가까운 꼭지점으로 자동 스냅"
          >
            <Magnet className="mr-1 h-3 w-3" />스냅
          </Button>
        )}
        {(() => {
          // Clear button drains whichever list we're allowed to touch:
          // edit mode wipes the persisted set, view mode wipes the
          // viewer's transient set. We never let a viewer delete the
          // author's saved measurements.
          const targetCount = onChangeAnnotations
            ? persistedList.length
            : transientAnnotations.length
          if (targetCount === 0) return null
          return (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[10px] text-destructive"
              onClick={() => {
                if (onChangeAnnotations) {
                  onChangeAnnotations([])
                } else {
                  setTransientAnnotations([])
                }
                setSelectedAnnoId(null)
                setPendingPoint(null)
              }}
              title={
                onChangeAnnotations
                  ? '모든 측정 지우기 (저장됨)'
                  : '내 임시 측정 지우기'
              }
            >
              <Trash2 className="mr-1 h-3 w-3" />
              지우기 ({targetCount})
            </Button>
          )
        })()}
        <div className="ml-auto flex items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[10px]"
            onClick={toggleFullscreen}
            disabled={loading || !!error}
            title={isFullscreen ? '전체화면 종료 (Esc)' : '전체화면으로 보기'}
          >
            {isFullscreen ? (
              <Minimize2 className="mr-1 h-3 w-3" />
            ) : (
              <Maximize2 className="mr-1 h-3 w-3" />
            )}
            {isFullscreen ? '전체화면 종료' : '전체화면'}
          </Button>
          {viewState && (
            <span className="text-[10px] text-muted-foreground px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
              저장된 뷰 사용 중
            </span>
          )}
          {onSaveView && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[10px]"
              onClick={saveCurrentView}
              disabled={loading || !!error}
              title="이 카메라 각도를 보고서의 기본 뷰로 저장"
            >
              <RotateCcw className="mr-1 h-3 w-3" />
              뷰 저장
            </Button>
          )}
          {onClearView && viewState && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[10px]"
              onClick={() => {
                onClearView()
                applyPreset(defaultView)
                toast.success('저장된 뷰가 삭제되었습니다.')
              }}
              title="저장된 뷰 삭제 (기본 프리셋으로 복귀)"
            >
              뷰 초기화
            </Button>
          )}
          {onClear && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0 text-destructive"
              onClick={onClear}
              title="다른 모델로 교체 / 비우기"
            >
              <X className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>
      {/* Canvas + overlay sidebar share this `relative` parent so the
          sidebar can absolute-position on top of the canvas. Previous
          push-layout (shrink-0 240px) clipped the sidebar off-screen
          when the widget cell got narrow — overlay keeps the canvas
          at full width regardless. */}
      <div className="relative flex-1 min-h-0 flex">
      <div
        ref={containerRef}
        className="relative flex-1 min-h-0"
        onClick={handleCanvasClick}
        onMouseMove={handleCanvasMouseMove}
        onMouseLeave={() => setHoverPoint(null)}
        style={{ cursor: measureMode && !loading && !error ? 'crosshair' : undefined }}
      >
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-xs text-muted-foreground bg-background/40 z-10">
            <Loader2 className="h-4 w-4 animate-spin" />
            모델 로딩 중…
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-destructive px-4 text-center">
            {error}
          </div>
        )}
        {/* SVG overlay for measurement labels — re-projected on every
            renderTick so the labels track camera motion 1:1 with the
            canvas underneath. Pointer events pass through except on
            the label itself, which lets the user click to select. */}
        <MeasureOverlay
          containerRef={containerRef}
          camera={stateRef.current?.camera}
          annotations={annoList}
          pendingPoint={pendingPoint}
          unit={unit}
          selectedId={selectedAnnoId}
          // Selection works in both modes — viewer can select their
          // transient measurements (delete-key clears them). The
          // keybinding effect prevents deleting persisted ones when no
          // writer is available.
          onSelect={setSelectedAnnoId}
          renderTick={renderTick}
          loading={loading}
        />
        {measureMode && (
          <div className="absolute top-1.5 left-1.5 text-[10px] bg-amber-500/90 text-white px-2 py-0.5 rounded shadow pointer-events-none">
            측정 모드: {pendingPoint ? '두 번째 점 클릭' : '첫 번째 점 클릭'}
            {' '}· Esc 취소
          </div>
        )}
      </div>
      {sidebarOpen && !loading && !error && (
        <PartsSidebar
          parts={parts}
          getPartMode={getPartMode}
          setPartMode={setPartMode}
          setAllPartsVisible={setAllPartsVisible}
          transientPartVis={transientPartVis}
          transientWireframe={transientWireframe}
          resetTransient={resetTransientPartState}
          hasWriter={!!onChangePartsState}
          search={partsSearch}
          setSearch={setPartsSearch}
          onClose={() => setSidebarOpen(false)}
        />
      )}
      </div>
      {loadedFilename && (bbox || loading) && (
        <div className="px-2 py-1 text-[10px] text-muted-foreground border-t bg-muted/30 shrink-0 flex items-center gap-3 flex-wrap">
          <span className="font-mono truncate max-w-[40%]" title={loadedFilename}>
            {loadedFilename}
          </span>
          {bbox && (
            <span className="font-mono">
              크기: {bbox.size.map((v) => v.toFixed(2)).join(' × ')} {props.unit ?? 'mm'}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

/** Resolve a fresh camera position for a named preset, sized off the
 *  model's bounding box so it always lands "inside the room". */
function applyViewPreset(name, { camera, controls, center, size, THREE }) {
  const radius = Math.max(size.x, size.y, size.z, 1) * 1.5
  // Camera FOV is fixed at 45° in the renderer init; back off enough
  // that the whole box fits inside the frustum with a small margin.
  const dist = radius / Math.tan((45 / 2) * (Math.PI / 180)) * 1.1
  controls.target.copy(center)
  switch (name) {
    case 'front':
      camera.position.set(center.x, center.y, center.z + dist)
      break
    case 'top':
      camera.position.set(center.x, center.y + dist, center.z + 0.001)
      break
    case 'side':
      camera.position.set(center.x + dist, center.y, center.z)
      break
    case 'fit':
    case 'iso':
    default: {
      const d = dist / Math.sqrt(3)
      camera.position.set(center.x + d, center.y + d, center.z + d)
      break
    }
  }
  camera.up.set(0, 1, 0)
  camera.lookAt(center)
  camera.zoom = 1
  camera.updateProjectionMatrix()
  // Suppress unused warning — `THREE` is part of the destructured args
  // for symmetry with sites that need extra math types.
  void THREE
}

/** STL is a flat triangle soup — no node hierarchy, no per-part names.
 *  But when an STL is exported from a multi-body assembly, the bodies
 *  are usually still **spatially disconnected** (no shared vertices),
 *  so we can recover them via connected-component analysis on the
 *  triangle adjacency graph. Returns a `Group` of per-component
 *  Meshes when 2..200 components are found; otherwise leaves the
 *  original mesh alone (single body, or too many micro-fragments to
 *  be useful).
 *
 *  Only called for STL — GLB has its own hierarchy, OBJ's loader
 *  already builds per-group Meshes, so connected-component splitting
 *  would either duplicate that work or fight it.
 */
async function maybeSplitConnectedComponents(obj, ext, stack) {
  if (ext !== '.stl') return obj
  if (!obj.isMesh) return obj
  const { THREE, BufferGeometryUtils } = stack

  // Safety cap — connected-component split on a multi-million-tri STL
  // can stall the main thread for several seconds. Below the cap we
  // do it sync (<1s for typical assemblies).
  const triCountRaw = (obj.geometry.getAttribute('position')?.count ?? 0) / 3
  if (triCountRaw > 500_000) {
    console.warn('[Cad3d] STL too large for auto-split:', triCountRaw, 'tris')
    return obj
  }

  // STL stores each triangle's vertices independently, AND each
  // triangle carries its own flat-shaded normal. mergeVertices treats
  // vertices as "different" when ANY attribute (including normal)
  // differs — so two triangles meeting at an edge keep distinct
  // copies of the shared position because the per-face normals are
  // different. The fix: copy positions only into a fresh geometry
  // and let three.js recompute smooth vertex normals after the
  // merge. This recovers the actual mesh topology.
  let indexed
  try {
    const positionOnly = new THREE.BufferGeometry()
    positionOnly.setAttribute('position', obj.geometry.getAttribute('position'))
    // 1e-4 is generous enough to absorb f32 round-trip noise from
    // different STL writers without merging actually distinct bodies.
    indexed = BufferGeometryUtils.mergeVertices(positionOnly, 1e-4)
    indexed.computeVertexNormals()
  } catch (err) {
    console.warn('[Cad3d] mergeVertices failed, keeping single mesh:', err)
    return obj
  }
  const components = findConnectedComponentsTris(indexed)
  if (components.length < 2 || components.length > 200) {
    indexed.dispose()
    return obj
  }

  // Build a Group with one Mesh per component, sharing the original
  // material. Sort components by triangle count desc so the largest
  // body becomes "Part 1" — usually the part the user thinks of first.
  components.sort((a, b) => b.length - a.length)
  const group = new THREE.Group()
  group.name = obj.name || 'STL Model'
  for (let i = 0; i < components.length; i += 1) {
    const subGeom = buildSubGeometryFromTris(indexed, components[i], THREE)
    const mesh = new THREE.Mesh(subGeom, obj.material)
    mesh.name = `Part ${i + 1}`
    group.add(mesh)
  }
  // Free the merged + original — the new sub-geometries own their own
  // attribute buffers and don't reference back.
  indexed.dispose()
  obj.geometry.dispose()
  return group
}

/** Union-Find over the triangle adjacency graph. Two triangles are
 *  connected iff they share at least one vertex index (after vertex
 *  merging). Returns an array of arrays of triangle indices, one per
 *  connected component. */
function findConnectedComponentsTris(geom) {
  const indexAttr = geom.getIndex()
  if (!indexAttr) return []
  const indices = indexAttr.array
  const triCount = indices.length / 3
  if (triCount === 0) return []

  // Bucket triangles by vertex index — every (vIdx → [t1, t2, ...]).
  const vertexToTris = new Map()
  for (let t = 0; t < triCount; t += 1) {
    for (let k = 0; k < 3; k += 1) {
      const v = indices[t * 3 + k]
      let list = vertexToTris.get(v)
      if (!list) {
        list = []
        vertexToTris.set(v, list)
      }
      list.push(t)
    }
  }

  // Union triangles that share a vertex. Path compression keeps the
  // amortized cost near O(1) per find().
  const parent = new Int32Array(triCount)
  for (let i = 0; i < triCount; i += 1) parent[i] = i
  function find(x) {
    let root = x
    while (parent[root] !== root) root = parent[root]
    while (parent[x] !== root) {
      const next = parent[x]
      parent[x] = root
      x = next
    }
    return root
  }
  for (const tris of vertexToTris.values()) {
    if (tris.length < 2) continue
    const ra = find(tris[0])
    for (let i = 1; i < tris.length; i += 1) {
      const rb = find(tris[i])
      if (ra !== rb) parent[rb] = ra
    }
  }

  // Group by component root.
  const compMap = new Map()
  for (let t = 0; t < triCount; t += 1) {
    const r = find(t)
    let list = compMap.get(r)
    if (!list) {
      list = []
      compMap.set(r, list)
    }
    list.push(t)
  }
  return Array.from(compMap.values())
}

/** Build a fresh BufferGeometry containing only the triangles whose
 *  indices appear in `triIndices`, copying position + normal data
 *  from the merged source. Non-indexed (flat) layout is fine here —
 *  the merge already collapsed shared vertices, and re-indexing per
 *  component would just add work for no perceptible win at the sizes
 *  we cap at. */
function buildSubGeometryFromTris(srcGeom, triIndices, THREE) {
  const srcIdx = srcGeom.getIndex().array
  const posAttr = srcGeom.getAttribute('position')
  const normAttr = srcGeom.getAttribute('normal')
  const tc = triIndices.length
  const positions = new Float32Array(tc * 9)
  const normals = normAttr ? new Float32Array(tc * 9) : null
  for (let ti = 0; ti < tc; ti += 1) {
    const t = triIndices[ti]
    for (let k = 0; k < 3; k += 1) {
      const vIdx = srcIdx[t * 3 + k]
      const off = ti * 9 + k * 3
      positions[off + 0] = posAttr.getX(vIdx)
      positions[off + 1] = posAttr.getY(vIdx)
      positions[off + 2] = posAttr.getZ(vIdx)
      if (normals) {
        normals[off + 0] = normAttr.getX(vIdx)
        normals[off + 1] = normAttr.getY(vIdx)
        normals[off + 2] = normAttr.getZ(vIdx)
      }
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  if (normals) {
    g.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  } else {
    g.computeVertexNormals()
  }
  return g
}

/** Pick a loader based on the filename extension and return the loaded
 *  Object3D. STL produces a buffer geometry → wrap in a Mesh with a
 *  default material. */
async function loadModelFromBlob(blob, ext, { THREE, GLTFLoader, STLLoader, OBJLoader }) {
  const buf = await blob.arrayBuffer()
  if (ext === '.glb' || ext === '.gltf') {
    const loader = new GLTFLoader()
    const gltf = await loader.parseAsync(buf, '')
    return gltf.scene ?? gltf.scenes?.[0]
  }
  if (ext === '.stl') {
    const loader = new STLLoader()
    const geom = loader.parse(buf)
    geom.computeVertexNormals()
    // DoubleSide — STL files (especially when exported from
    // open-source CAD tools) frequently have inconsistent triangle
    // winding, which makes some faces invisible from one side under
    // default front-face culling. Drawing both sides costs a bit of
    // fill rate but is robust for arbitrary STL input.
    const mat = new THREE.MeshStandardMaterial({
      color: 0xb0bec5,
      metalness: 0.05,
      roughness: 0.65,
      side: THREE.DoubleSide,
    })
    return new THREE.Mesh(geom, mat)
  }
  if (ext === '.obj') {
    const loader = new OBJLoader()
    const text = new TextDecoder('utf-8').decode(buf)
    return loader.parse(text)
  }
  throw new Error(`지원하지 않는 형식: ${ext}`)
}

/** Recursive disposal — geometry/material/texture all live on the GPU
 *  and aren't reachable by JS GC. Called both per-model (when swapping)
 *  and per-scene (on unmount). */
function disposeObject3D(obj, THREE, { onlyOwn = false } = {}) {
  if (!obj) return
  obj.traverse?.((node) => {
    if (node.isMesh) {
      node.geometry?.dispose?.()
      const mats = Array.isArray(node.material) ? node.material : [node.material]
      for (const m of mats) {
        if (!m) continue
        for (const key of Object.keys(m)) {
          const v = m[key]
          if (v && v.isTexture) v.dispose?.()
        }
        m.dispose?.()
      }
    }
    if (node.isLine || node.isLineSegments) {
      node.geometry?.dispose?.()
      const m = node.material
      if (m) m.dispose?.()
    }
  })
  void THREE
  void onlyOwn
}

// =========================================================================
// Measure helpers
// =========================================================================
/** Add a small sphere at `p` (world coords) into `group`. Used both for
 *  finalized measurement endpoints and the pending first-click marker. */
function addMeasureMarker(group, THREE, p, { radius = 1, color = 0x0ea5e9 } = {}) {
  const geom = new THREE.SphereGeometry(radius, 16, 12)
  const mat = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 })
  const sphere = new THREE.Mesh(geom, mat)
  sphere.position.set(p.x, p.y, p.z)
  sphere.renderOrder = 1000 // draw on top of the model
  group.add(sphere)
}

/** Add a thin line segment between two world points, used as the
 *  visible part of a finalized distance measurement. */
function addMeasureLine(group, THREE, p1, p2, { color = 0x0ea5e9 } = {}) {
  const geom = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(p1.x, p1.y, p1.z),
    new THREE.Vector3(p2.x, p2.y, p2.z),
  ])
  const mat = new THREE.LineBasicMaterial({
    color,
    depthTest: false,
    transparent: true,
    opacity: 0.95,
  })
  const line = new THREE.Line(geom, mat)
  line.renderOrder = 999
  group.add(line)
}

/** Vertex snap: take the raycast hit's face vertices, project each to
 *  screen pixels, and return the world-space vertex whose projection is
 *  closest to the mouse position — provided it's within VERTEX_SNAP_PX.
 *  Returns null when no vertex is close enough; the caller then keeps
 *  the raw face-hit point. */
function snapToVertex(hit, camera, width, height, mouse, THREE) {
  const face = hit.face
  const geom = hit.object.geometry
  const posAttr = geom?.attributes?.position
  if (!face || !posAttr) return null
  const candidates = [face.a, face.b, face.c]
  let best = null
  let bestDist = VERTEX_SNAP_PX * VERTEX_SNAP_PX
  for (const idx of candidates) {
    const local = new THREE.Vector3().fromBufferAttribute(posAttr, idx)
    const world = local.clone().applyMatrix4(hit.object.matrixWorld)
    const screen = projectToScreen(world, camera, width, height)
    if (!screen) continue
    const dx = screen.x - mouse.clientX
    const dy = screen.y - mouse.clientY
    const d2 = dx * dx + dy * dy
    if (d2 < bestDist) {
      best = world
      bestDist = d2
    }
  }
  return best
}

/** SVG overlay that prints distance labels above each annotation midpoint
 *  and a small "1" / "2" hint while a measurement is in progress. Has
 *  no opinions on camera state — just re-reads from the camera prop on
 *  every `renderTick` change. */
function MeasureOverlay({
  containerRef,
  camera,
  annotations,
  pendingPoint,
  unit,
  selectedId,
  onSelect,
  renderTick,
  loading,
}) {
  // We rerender whenever the camera ticks or annotations change. The
  // projection itself is recomputed here on every render — fast enough
  // for the realistic count of measurements (tens, not thousands).
  void renderTick

  if (!camera || loading) return null
  const container = containerRef.current
  if (!container) return null
  const w = container.clientWidth
  const h = container.clientHeight

  const items = []
  for (const a of annotations) {
    const transient = !!a.transient
    if (a.type === 'distance_3d' && a.p1 && a.p2) {
      const mid = {
        x: (a.p1.x + a.p2.x) / 2,
        y: (a.p1.y + a.p2.y) / 2,
        z: (a.p1.z + a.p2.z) / 2,
      }
      const screen = projectToScreen(toVec3(mid, camera), camera, w, h)
      if (!screen) continue
      const dist = distanceBetween(a.p1, a.p2)
      items.push({
        id: a.id,
        x: screen.x,
        y: screen.y,
        text: formatDistance(dist, unit),
        selected: a.id === selectedId,
        transient,
      })
    } else if (a.type === 'point_3d' && a.p1) {
      const screen = projectToScreen(toVec3(a.p1, camera), camera, w, h)
      if (!screen) continue
      items.push({
        id: a.id,
        x: screen.x,
        y: screen.y,
        text: a.label ?? '·',
        selected: a.id === selectedId,
        transient,
      })
    }
  }

  // Pending first-click — show a "1" badge until the user picks the
  // second point.
  let pending = null
  if (pendingPoint) {
    const screen = projectToScreen(toVec3(pendingPoint, camera), camera, w, h)
    if (screen) pending = { x: screen.x, y: screen.y }
  }

  return (
    <svg
      className="absolute inset-0 pointer-events-none"
      width="100%"
      height="100%"
    >
      {items.map((it) => (
        <g
          key={it.id}
          transform={`translate(${it.x}, ${it.y})`}
          style={{ pointerEvents: onSelect ? 'auto' : 'none', cursor: onSelect ? 'pointer' : 'default' }}
          onClick={(e) => {
            if (!onSelect) return
            e.stopPropagation()
            onSelect(it.selected ? null : it.id)
          }}
        >
          <rect
            x={-it.text.length * 3.6 - 6}
            y={-10}
            width={it.text.length * 7.2 + 12}
            height={18}
            rx={3}
            ry={3}
            fill={
              it.selected
                ? '#ff5722'
                : it.transient
                  ? 'rgba(245,158,11,0.95)' // amber for viewer's ad-hoc
                  : 'rgba(14,165,233,0.95)' // cyan for persisted
            }
            stroke="white"
            strokeWidth={1}
          />
          <text
            x={0}
            y={3}
            textAnchor="middle"
            fontSize={11}
            fontFamily="ui-monospace, monospace"
            fill="white"
            style={{ userSelect: 'none' }}
          >
            {it.text}
          </text>
        </g>
      ))}
      {pending && (
        <g transform={`translate(${pending.x}, ${pending.y})`}>
          <circle r={9} fill="#f97316" stroke="white" strokeWidth={1.5} />
          <text x={0} y={3} textAnchor="middle" fontSize={10} fontFamily="ui-sans-serif" fill="white" fontWeight="bold">
            1
          </text>
        </g>
      )}
    </svg>
  )
}

/** Always-visible side panel listing the model's parts with a
 *  3-state mode selector per row (shaded / wireframe / hidden). Edit
 *  mode persists the choice into hidden_parts + wireframe_parts; view
 *  mode keeps it as a transient override (amber "임시" chip). */
function PartsSidebar({
  parts,
  getPartMode,
  setPartMode,
  setAllPartsVisible,
  transientPartVis,
  transientWireframe,
  resetTransient,
  hasWriter,
  search,
  setSearch,
  onClose,
}) {
  const hasParts = parts.length > 0
  const hasTransient =
    Object.keys(transientPartVis).length > 0 ||
    Object.keys(transientWireframe).length > 0
  const visibleCount = parts.reduce(
    (n, p) => (getPartMode(p.id) !== 'hidden' ? n + 1 : n),
    0,
  )
  const q = (search || '').trim().toLowerCase()
  const filtered = q
    ? parts.filter((p) => p.name.toLowerCase().includes(q))
    : parts
  const showSearch = parts.length > 8

  return (
    <aside
      // Float over the canvas (absolute right) so a narrow widget cell
      // doesn't have to choose between canvas width and sidebar
      // visibility. Solid bg + shadow keeps text readable on top of
      // the 3D scene. max-w cap ensures it never eats more than half
      // the widget on tiny cells; user can still close via X.
      className="absolute top-0 right-0 bottom-0 z-20 w-[240px] max-w-[60%] border-l bg-background/95 backdrop-blur-sm shadow-lg flex flex-col min-h-0"
    >
      <div className="flex items-center justify-between px-2 py-1.5 border-b shrink-0">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
          파트 {hasParts ? `(${visibleCount}/${parts.length})` : '(없음)'}
        </span>
        <div className="flex items-center gap-1">
          {hasTransient && !hasWriter && (
            <button
              type="button"
              onClick={resetTransient}
              className="text-[10px] text-amber-600 hover:underline"
              title="저자의 기본 가시성으로 되돌리기"
            >
              임시 복원
            </button>
          )}
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-5 w-5"
            onClick={onClose}
            title="사이드바 닫기"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      </div>
      {!hasParts ? (
        <div className="text-[11px] text-muted-foreground p-3 leading-relaxed">
          이 모델에서 토글 가능한 부품을 찾지 못했습니다.
          <div className="mt-1.5 text-[10px]">
            가능한 원인:
            <ul className="list-disc ml-4 mt-1 space-y-0.5">
              <li>단일 mesh로 export 됨 (CAD에서 통합)</li>
              <li>STL/OBJ — hierarchy 없는 포맷</li>
              <li>node 이름 없는 GLB</li>
            </ul>
          </div>
        </div>
      ) : (
        <>
          <div className="px-2 py-1.5 shrink-0 space-y-1.5 border-b">
            {showSearch && (
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="부품명 검색…"
                className="h-7 text-xs"
              />
            )}
            <div className="flex items-center gap-1 text-[10px]">
              <button
                type="button"
                className="px-1.5 py-0.5 rounded hover:bg-muted"
                onClick={() => setAllPartsVisible(true)}
              >
                전부 표시
              </button>
              <button
                type="button"
                className="px-1.5 py-0.5 rounded hover:bg-muted"
                onClick={() => setAllPartsVisible(false)}
              >
                전부 숨김
              </button>
            </div>
          </div>
          <ul className="flex-1 min-h-0 overflow-y-auto py-1">
            {filtered.length === 0 && (
              <li className="text-[11px] text-muted-foreground px-2 py-3 text-center">
                일치하는 부품 없음
              </li>
            )}
            {filtered.map((p) => {
              const mode = getPartMode(p.id)
              const isOverridden =
                Object.prototype.hasOwnProperty.call(transientPartVis, p.id) ||
                Object.prototype.hasOwnProperty.call(transientWireframe, p.id)
              return (
                <li
                  key={p.id}
                  className="px-2 py-1 hover:bg-muted/40 text-xs"
                  title={p.id !== p.name ? `id: ${p.id}` : undefined}
                >
                  <div className="flex items-center gap-1.5">
                    <span
                      className={cn(
                        'truncate flex-1',
                        mode === 'hidden' && 'line-through text-muted-foreground',
                      )}
                    >
                      {p.name}
                    </span>
                    {isOverridden && !hasWriter && (
                      <span
                        className="text-[9px] px-1 rounded bg-amber-500/15 text-amber-700 dark:text-amber-400"
                        title="저장된 기본값에서 임시로 바뀐 상태"
                      >
                        임시
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex items-center gap-0.5">
                    <PartModeButton
                      active={mode === 'shaded'}
                      onClick={() => setPartMode(p.id, 'shaded')}
                      title="셰이딩 (실루엣 + 엣지)"
                      icon={Eye}
                      label="셰이딩"
                    />
                    <PartModeButton
                      active={mode === 'wireframe'}
                      onClick={() => setPartMode(p.id, 'wireframe')}
                      title="와이어프레임 (선만)"
                      icon={SquareDashed}
                      label="와이어"
                    />
                    <PartModeButton
                      active={mode === 'hidden'}
                      onClick={() => setPartMode(p.id, 'hidden')}
                      title="숨김"
                      icon={EyeOff}
                      label="숨김"
                    />
                  </div>
                </li>
              )
            })}
          </ul>
          <p className="text-[10px] text-muted-foreground border-t px-2 py-1 shrink-0">
            {hasWriter
              ? '여기서 바꾸면 보고서에 저장됩니다.'
              : '여기서 바꾸는 건 임시로 본인 화면에만 적용됩니다.'}
          </p>
        </>
      )}
    </aside>
  )
}

function PartModeButton({ active, onClick, title, icon: Icon, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'flex-1 flex items-center justify-center gap-1 h-6 rounded text-[10px] transition-colors',
        active
          ? 'bg-primary text-primary-foreground'
          : 'bg-muted/60 hover:bg-muted text-muted-foreground',
      )}
    >
      <Icon className="h-3 w-3" />
      <span className="hidden xl:inline">{label}</span>
    </button>
  )
}


/** Convert a `{x,y,z}` literal to a THREE.Vector3-ish object the
 *  projector accepts. We use `camera.matrixWorld` for context but
 *  don't actually need it — projectToScreen calls `.clone().project()`
 *  on whatever's passed, and any object with a `clone()` and a
 *  `project()` works. We just need a Vector3 here. */
function toVec3(p, camera) {
  // Reach into camera's THREE constructor — we don't want to import
  // three statically here because this file is loaded eagerly
  // (overlay must render before three is dynamic-imported on edit
  // mount). Falls back to a literal Vector3 polyfill if the camera
  // hasn't been initialized yet.
  const Vec3 = camera?.position?.constructor
  if (Vec3) return new Vec3(p.x, p.y, p.z)
  // Fallback: build a minimal object with .clone().project() that
  // projectToScreen needs. Should never actually run.
  return {
    x: p.x, y: p.y, z: p.z,
    clone() { return { ...this, project: () => ({ x: 0, y: 0, z: 2 }) } },
  }
}
