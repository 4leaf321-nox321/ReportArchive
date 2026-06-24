import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, ImageIcon, Loader2, Upload, X } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { AuthedImage } from '@/shared/components/AuthedImage'
import { Dialog, DialogContent, DialogTitle } from '@/shared/components/ui/dialog'
import { uploadFile } from '@/shared/api/files'
import { cn } from '@/shared/lib/utils'
import {
  pickBestPastedImage,
  pastedImageToFile,
  logPastedImageDiagnostics,
  lowResWarning,
} from '@/shared/lib/clipboardImage'
import { toast } from 'sonner'
import {
  CaptionInput,
  EditorOptionBar,
  EditorOptionNumber,
  EditorOptionSelect,
  LabelField,
  NoteInput,
  PreviewLabel,
  captionSkipProps,
  captionPositionOf,
  effectiveNumber,
  effectiveString,
  pruneOverrideKeys,
} from './_shared'

// Aspect-ratio choices the renderer (`aspectRatioToClass`) actually
// honors — any other string falls back to `aspect-video`, so exposing a
// curated dropdown matches what the writer will actually see while also
// preventing partial-typing values like "4:" from sneaking past the
// content schema's strict pattern.
const ASPECT_RATIO_OPTIONS = [
  { value: '', label: '기본 (16:9)' },
  { value: '16:9', label: '16:9' },
  { value: '4:3', label: '4:3' },
  { value: '1:1', label: '1:1' },
  { value: '3:2', label: '3:2' },
  { value: '2:1', label: '2:1' },
]
import {
  AnnotationContents,
  AnnotationCountBadge,
  AnnotationLabelEditor,
  AnnotationStyleBar,
  AnnotationToolbar,
  InteractiveOverlay,
  SelectionMarquee,
  useAnnotationInteractions,
  useAnnotationStore,
  useImageAnnotationAdapter,
} from '@/shared/annotations'

export function ImagePropsPanel({ props, onChange }) {
  return (
    <div className="space-y-4">
      <LabelField
        label="라벨"
        value={props.label}
        onChange={(v) => onChange({ ...props, label: v })}
        placeholder="증거 자료"
      />
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-xs">최대 장수</Label>
          <Input
            type="number"
            min={1}
            max={50}
            value={props.max_count ?? 1}
            onChange={(e) => onChange({ ...props, max_count: Number(e.target.value) })}
            className="mt-1 h-9"
          />
          <p className="mt-0.5 text-[10px] text-muted-foreground">1=단일, 2+=갤러리</p>
        </div>
        <div>
          <Label className="text-xs">화면비 (선택)</Label>
          <Input
            value={props.aspect_ratio ?? ''}
            onChange={(e) =>
              onChange({
                ...props,
                aspect_ratio: e.target.value || undefined,
              })
            }
            placeholder="16:9"
            className="mt-1 h-9"
          />
        </div>
      </div>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={!!props.caption_required}
          onChange={(e) => onChange({ ...props, caption_required: e.target.checked })}
        />
        캡션 필수
      </label>
    </div>
  )
}

export function ImageEditor({ props, content, onChange, readOnly, autoFit }) {
  const caption = content?.caption ?? ''
  const note = content?.note ?? ''
  // 헤더(제목) 위치 — 'below' 면 내용 아래, 그 외엔 위(기본).
  const capPos = captionPositionOf(content)
  const files = content?.files ?? []
  // Per-report soft UI cap on the image count; hard cap stays in
  // props.max_count via the content schema's maxItems. content wins,
  // then template, then 1.
  const max = Math.min(
    effectiveNumber(content, props, 'max_count', 1),
    props.max_count ?? 50,
  )
  // Per-report aspect-ratio override.
  const aspectRatio = effectiveString(content, props, 'aspect_ratio', '')
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(0)
  const fileInputRef = useRef(null)
  // 뷰(읽기전용) 모드에서 이미지를 클릭하면 확대 팝업으로 보여줄 대상 파일.
  const [zoomFile, setZoomFile] = useState(null)
  // Cell-fill mode: when the widget cell has an explicit height
  // (autoFit=false) and there's a single image with no user-set aspect
  // ratio, let the image grow to fill the available space instead of
  // squeezing it into a fixed 16:9 box that leaves big gaps or overflows.
  const hasUserAspect = Boolean(aspectRatio)
  const fillCell = max === 1 && autoFit === false && !hasUserAspect

  // Annotations only make sense when there's a single canonical image
  // to mark up — pinning a mark to "image #2 of 5" gets confusing fast
  // and the saved geometry has no concept of which file it belongs to.
  // Skip the entire annotation surface for galleries.
  const annotationsEnabled = max === 1 && files.length === 1

  // Always emit both fields so the saved content shape stays stable
  // regardless of which one the user touched first.
  function patchContent(patch) {
    const next = { ...(content ?? {}), caption, files, ...patch }
    if (!next.caption) delete next.caption
    if (!next.caption_skip_autofill) delete next.caption_skip_autofill
    if (!next.note || !next.note.trim()) delete next.note
    // Mirror the chart's behavior: empty annotation arrays stay out
    // of the wire payload so the JSON stays tight.
    if (Array.isArray(next.annotations) && next.annotations.length === 0) {
      delete next.annotations
    }
    pruneOverrideKeys(next, props, {
      max_count: 1,
      aspect_ratio: undefined,
    })
    onChange(next)
  }
  function update(idx, patch) {
    patchContent({
      files: files.map((f, i) => (i === idx ? { ...f, ...patch } : f)),
    })
  }
  function remove(idx) {
    patchContent({ files: files.filter((_, i) => i !== idx) })
  }
  function move(idx, dir) {
    const newIdx = idx + dir
    if (newIdx < 0 || newIdx >= files.length) return
    const next = [...files]
    const [item] = next.splice(idx, 1)
    next.splice(newIdx, 0, item)
    patchContent({ files: next })
  }

  async function handleFiles(fileList) {
    const incoming = Array.from(fileList || [])
    const slots = max - files.length
    if (slots <= 0) {
      toast.error(`최대 ${max}장까지 업로드 가능합니다.`)
      return
    }
    const accepted = incoming.slice(0, slots).filter((f) => {
      if (!f.type.startsWith('image/')) {
        toast.error(`이미지 파일만 가능: ${f.name}`)
        return false
      }
      return true
    })
    if (accepted.length === 0) return

    setUploading(true)
    setProgress(0)
    const uploaded = []
    try {
      for (let i = 0; i < accepted.length; i += 1) {
        const file = accepted[i]
        const meta = await uploadFile(file, {
          onProgress: (p) => setProgress((i + p) / accepted.length),
        })
        uploaded.push({ file_id: meta.id, alt: file.name })
      }
      patchContent({ files: [...files, ...uploaded] })
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
    handleFiles(e.dataTransfer.files)
  }

  // Pulls image blobs out of the system clipboard (screenshots, copies
  // from image viewers, "copy image" from browsers). Falls through when
  // the clipboard only carries text so the default paste behavior of any
  // ancestor input still works.
  //
  // 같은 복사라도 클립보드에 여러 포맷·해상도가 들어있을 수 있어(특히 PPT),
  // 가장 큰 해상도를 골라 올린다. preventDefault 와 동기 후보 수집은 await
  // 이전에 끝나야 한다(pickBestPastedImage 가 그 순서를 보장).
  async function onPaste(e) {
    const hasImage = Array.from(e.clipboardData?.items ?? []).some(
      (it) => it.kind === 'file' && it.type.startsWith('image/'),
    )
    if (!hasImage) return
    e.preventDefault()
    const { chosen, candidates } = await pickBestPastedImage(e)
    // 상세 후보·해상도는 콘솔에만(필요 시 디버깅). 화면엔 저해상도일 때만 경고.
    logPastedImageDiagnostics(candidates, chosen)
    if (!chosen) {
      toast.error('클립보드에서 이미지를 찾지 못했습니다.')
      return
    }
    const warn = lowResWarning(chosen)
    if (warn) toast.warning(warn, { duration: 6000 })
    const file = pastedImageToFile(chosen)
    if (file) handleFiles([file])
  }

  const canAdd = files.length < max
  const aspectClass = aspectRatioToClass(aspectRatio || undefined)
  // In edit mode, cap the aspect-ratio cell's height so a wide
  // surface (the 80vw "위젯 편집" modal in particular) doesn't make
  // the cell tall enough to push the dialog's Apply/Cancel footer
  // out of view. fillCell mode already binds height to the available
  // flex space, so the cap is only relevant when an explicit
  // aspect_ratio is driving the layout. Read-only renders stay
  // uncapped so reports show the image at its full requested ratio.
  const editCellHeightCap = !readOnly && !fillCell ? { maxHeight: '50vh' } : undefined

  if (readOnly) {
    if (!caption && files.length === 0 && !note.trim()) return null
    return (
      <div
        className={cn(
          'flex flex-col gap-2',
          fillCell && 'h-full',
        )}
      >
        {capPos !== 'below' && (
          <CaptionInput
            value={caption}
            readOnly
            placeholder={props.label}
            skipAutofill={content?.caption_skip_autofill}
            color={content?.caption_color}
            html={content?.caption_html}
          />
        )}
        {files.length > 0 && (
          <div
            className={cn(
              'grid gap-2',
              max > 1 ? 'grid-cols-3' : 'grid-cols-1',
              fillCell && 'flex-1 min-h-0',
            )}
          >
            {files.map((file, idx) => (
              <figure key={idx} className="flex flex-col gap-1 min-h-0">
                {annotationsEnabled ? (
                  <AnnotatableImageBox
                    file={file}
                    aspectClass={aspectClass}
                    fillCell={fillCell}
                    annotations={content?.annotations}
                    readOnly
                    onZoom={() => setZoomFile(file)}
                  />
                ) : (
                  <div
                    role="button"
                    tabIndex={0}
                    aria-label="이미지 확대 보기"
                    onClick={() => setZoomFile(file)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setZoomFile(file)
                      }
                    }}
                    className={cn(
                      'relative bg-muted/30 rounded-md overflow-hidden cursor-zoom-in',
                      'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      fillCell ? 'flex-1 min-h-0' : aspectClass,
                    )}
                  >
                    <AuthedImage
                      fileId={file.file_id}
                      alt={file.alt}
                      className="absolute inset-0 w-full h-full object-contain"
                    />
                  </div>
                )}
                {file.caption && (
                  <figcaption className="text-xs text-muted-foreground text-center">
                    {file.caption}
                  </figcaption>
                )}
              </figure>
            ))}
          </div>
        )}
        {capPos === 'below' && (
          <CaptionInput
            value={caption}
            readOnly
            placeholder={props.label}
            skipAutofill={content?.caption_skip_autofill}
            color={content?.caption_color}
            html={content?.caption_html}
          />
        )}
        <NoteInput value={note} readOnly color={content?.note_color} html={content?.note_html} />
        <Dialog open={!!zoomFile} onOpenChange={(o) => !o && setZoomFile(null)}>
          <DialogContent className="w-[80vw] max-w-[80vw] h-[80vh] max-h-[80vh] flex items-center justify-center p-2">
            <DialogTitle className="sr-only">{zoomFile?.caption || props.label || '이미지 확대 보기'}</DialogTitle>
            {zoomFile && (
              <AuthedImage
                fileId={zoomFile.file_id}
                alt={zoomFile.alt}
                className="max-w-full max-h-full object-contain"
              />
            )}
          </DialogContent>
        </Dialog>
      </div>
    )
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
          onChange={(v) => patchContent({ caption: v })}
          placeholder={props.label}
          {...captionSkipProps({ content, patch: patchContent })}
        />
      )}
      <EditorOptionBar>
        <EditorOptionNumber
          label="최대 장수"
          value={max}
          min={1}
          max={props.max_count ?? 50}
          onChange={(v) => patchContent({ max_count: v })}
          suffix={`(현재 ${files.length}장)`}
          width="w-14"
          hint="1이면 단일 이미지, 2 이상이면 갤러리. 템플릿 한도 안에서만 줄일 수 있습니다."
        />
        <EditorOptionSelect
          label="화면비"
          value={aspectRatio}
          options={ASPECT_RATIO_OPTIONS}
          onChange={(v) => patchContent({ aspect_ratio: v })}
          width="w-24"
          hint="템플릿 설정을 보고서마다 다른 비율로 바꿀 수 있습니다."
        />
      </EditorOptionBar>
      {files.length > 0 && (
        <div
          className={cn(
            'grid gap-2',
            max > 1 ? 'grid-cols-3' : 'grid-cols-1',
            fillCell && 'flex-1 min-h-0',
          )}
        >
          {files.map((file, idx) => (
            <div
              key={idx}
              className="rounded-md border bg-muted/10 overflow-hidden flex flex-col min-h-0"
            >
              {annotationsEnabled ? (
                <AnnotatableImageBox
                  file={file}
                  aspectClass={aspectClass}
                  fillCell={fillCell}
                  cellStyle={editCellHeightCap}
                  annotations={content?.annotations}
                  onChangeAnnotations={(next) => patchContent({ annotations: next })}
                  topRightSlot={
                    <ImageFileActions
                      idx={idx}
                      total={files.length}
                      onMove={move}
                      onRemove={remove}
                    />
                  }
                />
              ) : (
                <div
                  className={cn(
                    'relative bg-muted/30',
                    fillCell ? 'flex-1 min-h-0' : aspectClass,
                  )}
                  style={editCellHeightCap}
                >
                  <AuthedImage
                    fileId={file.file_id}
                    alt={file.alt}
                    className="absolute inset-0 w-full h-full object-contain"
                  />
                  <div className="absolute top-1 right-1 flex items-center gap-0.5 bg-background/80 rounded">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    disabled={idx === 0}
                    onClick={(e) => {
                      e.stopPropagation()
                      move(idx, -1)
                    }}
                  >
                    <ChevronUp className="h-3 w-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    disabled={idx === files.length - 1}
                    onClick={(e) => {
                      e.stopPropagation()
                      move(idx, 1)
                    }}
                  >
                    <ChevronDown className="h-3 w-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-destructive"
                    onClick={(e) => {
                      e.stopPropagation()
                      remove(idx)
                    }}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
                </div>
              )}
              <div className="p-1.5 space-y-1">
                <Input
                  value={file.caption ?? ''}
                  onChange={(e) =>
                    update(idx, { caption: e.target.value || undefined })
                  }
                  placeholder={
                    props.caption_required ? '캡션 (필수)' : '캡션 (선택)'
                  }
                  className="h-7 text-xs"
                />
                <Input
                  value={file.alt ?? ''}
                  onChange={(e) =>
                    update(idx, { alt: e.target.value || undefined })
                  }
                  placeholder="alt 텍스트"
                  className="h-7 text-xs"
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {canAdd && (
        // Dropzone is now a **paste target**, not a picker trigger —
        // clicking it just focuses the div (tabIndex auto-focuses on
        // click) so the user can immediately Ctrl+V. Opening the file
        // dialog is now an explicit button below so the two actions
        // don't conflict.
        <div
          tabIndex={0}
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDrop}
          onPaste={onPaste}
          className="border-2 border-dashed rounded-md p-6 text-center shrink-0 hover:bg-muted/20 focus:bg-muted/30 focus:outline-none focus:ring-2 focus:ring-primary/40 transition-colors"
        >
          {uploading ? (
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-xs">업로드 중… {Math.round(progress * 100)}%</span>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <Upload className="h-5 w-5" />
              <div className="text-xs">
                이미지 드래그·앤·드롭, 또는 클릭해서 포커스 후{' '}
                <kbd className="px-1 rounded bg-muted">Ctrl</kbd>+
                <kbd className="px-1 rounded bg-muted">V</kbd>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={(e) => {
                  // Stop the dropzone's tabIndex-driven focus shift so
                  // the file dialog gets the focus instead, which keeps
                  // keyboard flow predictable when it closes.
                  e.stopPropagation()
                  fileInputRef.current?.click()
                }}
                className="h-7 text-xs"
              >
                파일 선택
              </Button>
              <div className="text-[10px]">
                남은 슬롯 {max - files.length}/{max}
              </div>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple={max > 1}
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
        </div>
      )}
      {capPos === 'below' && (
        <CaptionInput
          value={caption}
          onChange={(v) => patchContent({ caption: v })}
          placeholder={props.label}
          {...captionSkipProps({ content, patch: patchContent })}
        />
      )}
      {/* 하단 참고 내용 — ※ 프리픽스로 표시. */}
      <NoteInput
        value={note}
        onChange={(v) => patchContent({ note: v })}
        html={content?.note_html}
        onChangeRich={(h, t) =>
          patchContent({
            note_html: t?.trim() ? h : undefined,
            note: t?.trim() ? t : undefined,
          })
        }
      />
    </div>
  )
}

/**
 * Image cell with an annotation overlay. Used in single-image mode
 * (max_count === 1 + files.length === 1) for both view and edit.
 *
 * Owns the annotation store + tool state. Wires the same surface the
 * chart uses: AnnotationContents (rendering), InteractiveOverlay
 * (creating), AnnotationLabelEditor (labeling), AnnotationStyleBar
 * (styling), SelectionMarquee (multi-select). Read-only mode strips
 * everything but AnnotationContents.
 *
 * `topRightSlot` is for host-supplied controls (move ↑/↓, delete) so
 * the file actions can sit at the top-right corner without colliding
 * with the annotation toolbar that lives ABOVE the image in edit mode.
 */
function AnnotatableImageBox({
  file,
  aspectClass,
  fillCell = false,
  // Inline style applied to the container that holds the image +
  // annotation overlay. Used by the host to cap height in edit mode so
  // a wide modal can't make the cell tall enough to push the dialog
  // footer out of view.
  cellStyle = undefined,
  annotations,
  onChangeAnnotations,
  readOnly = false,
  topRightSlot = null,
  // 뷰(읽기전용) 모드에서 이미지를 클릭하면 호출 — 확대 팝업을 연다.
  // 편집 모드에서는 클릭이 어노테이션 도구용이라 무시한다.
  onZoom = null,
}) {
  const containerRef = useRef(null)
  const imgRef = useRef(null)
  const [annotationTool, setAnnotationTool] = useState(null)
  // Stable source-of-truth array. Without useMemo, an absent value
  // produces a fresh `[]` per render → churns useAnnotationStore's
  // prop-sync effect (same pitfall the chart hit).
  const stableAnnotations = useMemo(
    () => (Array.isArray(annotations) ? annotations : []),
    [annotations],
  )
  const annotationStore = useAnnotationStore({
    annotations: stableAnnotations,
    onChange: (next) => onChangeAnnotations?.(next),
  })
  const adapter = useImageAnnotationAdapter(containerRef, { imgRef })
  const interactions = useAnnotationInteractions({
    store: annotationStore,
    adapter,
    readOnly,
  })

  // Esc / Delete / Cmd+Z bindings. Document-level — when multiple
  // editable images are on a page they each register, but each only
  // does something for THEIR selection / tool, so they don't
  // interfere. Skip the binding entirely in read-only mode.
  //
  // ⚠ 리스너는 마운트 시 *한 번만* 등록한다(deps=[readOnly]). 도구/선택을
  // deps 에 넣어 재등록하면, Radix Dialog 의 capture Esc 리스너(위젯 편집
  // 모달)보다 등록 순서가 *뒤로* 밀려 모달이 먼저 닫힌다. 현재 도구/스토어는
  // ref 로 읽어 항상 최신값을 보면서도 재등록을 피한다.
  const escStateRef = useRef(null)
  escStateRef.current = { annotationTool, annotationStore }
  useEffect(() => {
    if (readOnly) return undefined
    function isEditableTarget() {
      const active = document.activeElement
      const tag = active?.tagName?.toLowerCase()
      return (
        tag === 'input' ||
        tag === 'textarea' ||
        active?.isContentEditable
      )
    }
    function onKey(e) {
      const { annotationTool, annotationStore } = escStateRef.current
      if (e.key === 'Escape') {
        // 라벨 입력 중 Esc 는 입력이 처리하도록 양보.
        if (isEditableTarget()) return
        // 주석 도구/선택이 활성일 때 Esc 는 그것만 취소하고 이벤트를 *소비*한다 —
        // 안 그러면 위젯 편집 모달(Radix Dialog)이 같이 닫힌다. capture 단계라
        // 모달의 Esc 핸들러보다 먼저 잡아 stopPropagation 으로 막는다.
        if (annotationTool) {
          e.preventDefault()
          e.stopPropagation()
          e.stopImmediatePropagation?.()
          setAnnotationTool(null)
        } else if (annotationStore.selectedIds.size > 0) {
          e.preventDefault()
          e.stopPropagation()
          e.stopImmediatePropagation?.()
          annotationStore.clearSelection()
        }
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (isEditableTarget()) return
        const ids = Array.from(annotationStore.selectedIds)
        if (ids.length > 0) {
          e.preventDefault()
          annotationStore.removeMany(ids)
        }
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
        if (isEditableTarget()) return
        e.preventDefault()
        if (e.shiftKey) annotationStore.history.redo()
        else annotationStore.history.undo()
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || e.key === 'Y')) {
        if (isEditableTarget()) return
        e.preventDefault()
        annotationStore.history.redo()
      }
    }
    // ⚠ window capture 에 등록한다. 이벤트 capture 경로는 window → document
    // → … 라, window capture 리스너는 Radix Dialog 의 document capture Esc
    // 핸들러보다 *항상 먼저* 실행된다(등록 순서와 무관). 소비 시 stopPropagation
    // 하면 document 까지 안 내려가 모달이 안 닫힌다.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [readOnly])

  return (
    <div
      className={cn(
        'flex flex-col gap-2',
        fillCell && 'h-full min-h-0',
      )}
    >
      {!readOnly && (
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground shrink-0">
          <span>어노테이션:</span>
          <AnnotationToolbar
            tool={annotationTool}
            onChange={setAnnotationTool}
            supportedTypes={[
              'vline',
              'vrange',
              'hline',
              'hrange',
              'point',
              'rect',
              'arrow',
              'text',
            ]}
          />
          {annotationStore.annotations.length > 0 && (
            <AnnotationCountBadge count={annotationStore.annotations.length} />
          )}
          {annotationTool && <span>이미지를 클릭해 표시 (Esc 취소)</span>}
        </div>
      )}
      <div
        ref={containerRef}
        role={readOnly && onZoom ? 'button' : undefined}
        tabIndex={readOnly && onZoom ? 0 : undefined}
        aria-label={readOnly && onZoom ? '이미지 확대 보기' : undefined}
        onClick={readOnly && onZoom ? () => onZoom() : undefined}
        onKeyDown={
          readOnly && onZoom
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onZoom()
                }
              }
            : undefined
        }
        className={cn(
          'relative bg-muted/30 rounded-md overflow-hidden',
          readOnly && onZoom && 'cursor-zoom-in focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          fillCell ? 'flex-1 min-h-0' : aspectClass,
        )}
        style={cellStyle}
      >
        <AuthedImage
          ref={imgRef}
          fileId={file.file_id}
          alt={file.alt}
          className="absolute inset-0 w-full h-full object-contain"
        />
        {topRightSlot && (
          <div className="absolute top-1 right-1 z-20 flex items-center gap-0.5 bg-background/80 rounded">
            {topRightSlot}
          </div>
        )}
        {/* Annotation surface — only mounts once the adapter has
            measured the image. Same SVG pattern the chart uses: a
            top-level overlay <svg> with pointer-events: none, with
            the per-shape pointer-events: auto granted by drawers. */}
        {adapter && (
          <svg
            className="absolute inset-0"
            width="100%"
            height="100%"
            style={{ pointerEvents: 'none' }}
          >
            {!readOnly && annotationTool == null && (
              <SelectionMarquee store={annotationStore} adapter={adapter} />
            )}
            <AnnotationContents
              drawable={stableAnnotations}
              adapter={adapter}
              selectedIds={annotationStore.selectedIds}
              readOnly={readOnly}
              onSelect={(id, opts) => annotationStore.setSelected(id, opts)}
              interactions={interactions}
            />
          </svg>
        )}
        {adapter && !readOnly && (
          <InteractiveOverlay
            bounds={adapter.bounds}
            fromPx={(p) => adapter.fromPx(p)}
            toPx={(g) => adapter.toPx(g)}
            tool={annotationTool}
            onCreate={(init) => annotationStore.add(init)}
            // Tool stays active after each create — matches the
            // chart pattern so the user can drop a series of marks
            // without re-picking the tool every time. Esc / completed
            // button / clicking the same tool again exits.
          />
        )}
        {!readOnly && (
          <AnnotationLabelEditor
            interactions={interactions}
            annotations={annotationStore.annotations}
            adapter={adapter}
          />
        )}
        {!readOnly && (
          <AnnotationStyleBar
            store={annotationStore}
            adapter={adapter}
            editingId={interactions?.editingId}
            onDone={() => setAnnotationTool(null)}
          />
        )}
      </div>
    </div>
  )
}

/** Tiny adapter so the file ↑/↓/× buttons can be reused inside the
 *  annotatable image box (where they need to sit on top of the
 *  annotation overlay) as well as the non-annotatable branch. */
function ImageFileActions({ idx, total, onMove, onRemove }) {
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        disabled={idx === 0}
        onClick={(e) => {
          e.stopPropagation()
          onMove(idx, -1)
        }}
      >
        <ChevronUp className="h-3 w-3" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        disabled={idx === total - 1}
        onClick={(e) => {
          e.stopPropagation()
          onMove(idx, 1)
        }}
      >
        <ChevronDown className="h-3 w-3" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 text-destructive"
        onClick={(e) => {
          e.stopPropagation()
          onRemove(idx)
        }}
      >
        <X className="h-3 w-3" />
      </Button>
    </>
  )
}

function aspectRatioToClass(ratio) {
  if (!ratio) return 'aspect-video'
  // Tailwind aspect-* presets we ship with by default
  const map = {
    '16:9': 'aspect-video',
    '4:3': 'aspect-[4/3]',
    '1:1': 'aspect-square',
    '3:2': 'aspect-[3/2]',
    '2:1': 'aspect-[2/1]',
  }
  return map[ratio] || 'aspect-video'
}

export function ImagePreview({ props }) {
  const count = Math.min(props.max_count ?? 1, 3)
  const isGallery = (props.max_count ?? 1) > 1
  return (
    <div className="space-y-2">
      <PreviewLabel
        hint={isGallery ? `최대 ${props.max_count}장` : '단일 이미지'}
      >
        {props.label || '(라벨 없음)'}
      </PreviewLabel>
      <div className={`grid gap-2 ${isGallery ? 'grid-cols-3' : 'grid-cols-1'}`}>
        {Array.from({ length: count }).map((_, i) => (
          <div
            key={i}
            className="aspect-video bg-muted/40 border border-dashed rounded-md flex items-center justify-center text-muted-foreground"
          >
            <ImageIcon className="h-6 w-6" />
          </div>
        ))}
      </div>
    </div>
  )
}
