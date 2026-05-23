import { useEffect, useMemo, useState } from 'react'
import { Info, Settings2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { Separator } from '@/shared/components/ui/separator'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/components/ui/tabs'
import { listEntityTypes } from '@/shared/api/entities'
import { EntityMultiPicker } from '@/modules/entities/EntityMultiPicker'
import { cn } from '@/shared/lib/utils'
import { ReportTypePicker } from './ReportTypePicker'

/**
 * Default report content width in pixels. Matches Tailwind's `max-w-5xl`
 * (64rem at the default 16px root), which is the old "narrow" toggle
 * value — so reports that haven't picked a custom width keep the layout
 * they had before per-report width became a thing.
 *
 * Exported so the consumer pages (ReportDetailPage / TemplateEditorPage)
 * label "기본" with the same number this dialog reports.
 */
export const DEFAULT_REPORT_WIDTH_PX = 1024

/**
 * Default vertical gap (px) between widget rows inside a page. Applied
 * as the react-grid-layout vertical margin in edit/view mode, and as the
 * row gap in the read-only InlineReportView. Picked as a sensible middle
 * ground between the prior tight RGL gap (4 px) and a generous reading
 * gap — large enough that adjacent widget cards read as separate, small
 * enough that a single-screen report still feels dense.
 */
export const DEFAULT_REPORT_GAP_PX = 12

/**
 * PPT 슬라이드 가이드의 기본 비율. 사용자가 가이드를 처음 켤 때 시드값.
 * 비교적 보편적인 16:9 (PowerPoint 2013 이후 기본)로 시작하고, 보고서마다
 * 사용자가 다이얼로그에서 자유롭게 바꿀 수 있다.
 */
export const DEFAULT_SLIDE_GUIDE_RATIO = '16:9'

/**
 * 가이드를 한 번도 켜지 않은 보고서의 슬라이드 가이드 draft 시드.
 * page_slide_guide 가 null/false 인 보고서를 다이얼로그에서 열 때 이 값으로
 * 화면을 채운다. 이후 사용자가 "켬"으로 토글해야 비로소 가이드가 보인다.
 */
export const DEFAULT_SLIDE_GUIDE_CONFIG = Object.freeze({
  enabled: false,
  ratio: DEFAULT_SLIDE_GUIDE_RATIO,
  customW: null,
  customH: null,
})

/**
 * Tabbed report-level settings dialog. The dialog owns the shell + sizing
 * (80vw × 80vh, flex column so the tab body fills the modal) and ALSO
 * owns the cross-tab draft state — width + type live as drafts inside
 * the dialog until the footer's "적용" pushes them up to the parent in
 * one shot and closes the modal. "취소" drops the drafts.
 *
 * The same dialog is reused by both the report editor and the template
 * editor — the template editor writes the values to the template's
 * `report_defaults` so new reports from that template inherit them.
 */
export function ReportSettingsDialog({
  open,
  currentWidthPx,
  defaultWidthPx = DEFAULT_REPORT_WIDTH_PX,
  currentGapPx,
  defaultGapPx = DEFAULT_REPORT_GAP_PX,
  // 컨테이너 경계(border/배경/그림자)를 페이지 배경에 녹여서 위젯끼리
  // 시각적으로 구분되지 않게 하는 토글. null/false면 기존처럼 카드 경계가
  // 보이고, true면 경계가 사라진다. 보고서/템플릿 양쪽에서 사용.
  currentBlendBlocks = false,
  // PPT 슬라이드 가이드 설정. { enabled, ratio, customW, customH } 형태로
  // 들어오고, 다이얼로그는 같은 shape 으로 onApplySlideGuide 를 호출한다.
  // null 이거나 일부 필드가 비어 있으면 DEFAULT_SLIDE_GUIDE_CONFIG 를
  // 시드로 채워서 표시.
  currentSlideGuide = null,
  // 속성 탭 — editable 보고서 종류 + read-only 메타 (작성자/부서/일시 등).
  // 템플릿 편집기는 종류·메타 개념이 없으므로 이 prop을 false로 두면
  // 탭 자체가 사라진다.
  showPropertiesTab = false,
  currentTypeId = null,
  currentType = null,
  // 보고서가 현재 태깅된 엔티티(슬림 EntityRefMini 배열). 다이얼로그가
  // 열릴 때 draft 시드값으로 쓰이고, 사용자가 picker로 칩을 변경하면
  // dirty 가 되어 적용 시 onApplyEntities 로 위로 전달된다. null/빈
  // 배열이면 아무것도 태깅되지 않은 보고서.
  currentEntities = null,
  // 보고서 메타데이터 (read-only로 표시). owner_name, owner_email,
  // workspace_slug, report_date, status, created_at, updated_at,
  // updated_by_name 등을 키로 가지는 평면 객체. 일부 키가 비어 있으면
  // 해당 행은 자동으로 숨겨진다 (= 새 보고서 작성 시점에는 일부가 비어
  // 있을 수 있어서).
  metadata = null,
  onClose,
  onApplyWidth,
  onApplyGap,
  onApplyBlendBlocks,
  onApplySlideGuide,
  onApplyType,
  onApplyEntities,
}) {
  if (!open) return null
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[80vw] max-w-[80vw] h-[80vh] max-h-[80vh] flex flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Settings2 className="h-4 w-4" />
            보고서 설정
          </DialogTitle>
        </DialogHeader>
        <DialogBody
          currentWidthPx={currentWidthPx}
          defaultWidthPx={defaultWidthPx}
          currentGapPx={currentGapPx}
          defaultGapPx={defaultGapPx}
          currentBlendBlocks={currentBlendBlocks}
          currentSlideGuide={currentSlideGuide}
          showPropertiesTab={showPropertiesTab}
          currentTypeId={currentTypeId}
          currentType={currentType}
          currentEntities={currentEntities}
          metadata={metadata}
          onClose={onClose}
          onApplyWidth={onApplyWidth}
          onApplyGap={onApplyGap}
          onApplyBlendBlocks={onApplyBlendBlocks}
          onApplySlideGuide={onApplySlideGuide}
          onApplyType={onApplyType}
          onApplyEntities={onApplyEntities}
        />
      </DialogContent>
    </Dialog>
  )
}

/**
 * The dialog body lives as a sub-component so its draft state mounts
 * fresh every time the dialog re-opens — we don't need any manual sync
 * effects to reset when `open` flips back to true.
 */
function DialogBody({
  currentWidthPx,
  defaultWidthPx,
  currentGapPx,
  defaultGapPx,
  currentBlendBlocks,
  currentSlideGuide,
  showPropertiesTab,
  currentTypeId,
  currentType,
  currentEntities,
  metadata,
  onClose,
  onApplyWidth,
  onApplyGap,
  onApplyBlendBlocks,
  onApplySlideGuide,
  onApplyType,
  onApplyEntities,
}) {
  const initialWidth = Number.isFinite(currentWidthPx) ? currentWidthPx : null
  const initialGap = Number.isFinite(currentGapPx) ? currentGapPx : null
  const initialBlend = currentBlendBlocks === true
  const initialSlide = normalizeSlideGuide(currentSlideGuide)
  const initialEntities = Array.isArray(currentEntities) ? currentEntities : []
  const [widthDraft, setWidthDraft] = useState(initialWidth)
  const [widthValid, setWidthValid] = useState(true)
  const [gapDraft, setGapDraft] = useState(initialGap)
  const [gapValid, setGapValid] = useState(true)
  const [blendDraft, setBlendDraft] = useState(initialBlend)
  const [slideDraft, setSlideDraft] = useState(initialSlide)
  const [slideValid, setSlideValid] = useState(true)
  const [typeDraft, setTypeDraft] = useState({
    id: currentTypeId ?? null,
    ref: currentType ?? null,
  })
  // Flat list of slim EntityRefMini — same shape as the server emits on
  // ReportRead.entities. Picker groups by type_slug at render-time.
  const [entitiesDraft, setEntitiesDraft] = useState(initialEntities)

  const widthChanged = (widthDraft ?? null) !== (currentWidthPx ?? null)
  const gapChanged = (gapDraft ?? null) !== (currentGapPx ?? null)
  const blendChanged = blendDraft !== initialBlend
  const slideChanged = !sameSlideGuide(slideDraft, initialSlide)
  const typeChanged = (typeDraft.id ?? null) !== (currentTypeId ?? null)
  // Compare on the sorted id-set — order in the array is irrelevant to
  // the saved state (the backend stores it as an unordered link table).
  const entitiesChanged = useMemo(
    () => !sameIdSet(entitiesDraft, initialEntities),
    [entitiesDraft, initialEntities],
  )
  const dirty =
    widthChanged ||
    gapChanged ||
    blendChanged ||
    slideChanged ||
    (showPropertiesTab && (typeChanged || entitiesChanged))

  function handleApply() {
    if (!widthValid || !gapValid || !slideValid) return
    if (widthChanged) onApplyWidth?.(widthDraft ?? null)
    if (gapChanged) onApplyGap?.(gapDraft ?? null)
    if (blendChanged) onApplyBlendBlocks?.(blendDraft)
    if (slideChanged) onApplySlideGuide?.(slideDraft)
    if (showPropertiesTab && typeChanged) onApplyType?.(typeDraft)
    if (showPropertiesTab && entitiesChanged) onApplyEntities?.(entitiesDraft)
    onClose()
  }

  return (
    <>
      <Tabs defaultValue="page" className="flex-1 min-h-0 flex flex-col">
        <TabsList className="w-fit shrink-0">
          <TabsTrigger value="page" className="gap-1">
            <Settings2 className="h-3.5 w-3.5" />
            페이지 설정
          </TabsTrigger>
          {showPropertiesTab && (
            <TabsTrigger value="properties" className="gap-1">
              <Info className="h-3.5 w-3.5" />
              속성
            </TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="page" className="flex-1 min-h-0 overflow-y-auto mt-3">
          <PageSettingsTab
            widthValue={widthDraft}
            defaultPx={defaultWidthPx}
            onWidthChange={(value, valid) => {
              setWidthDraft(value)
              setWidthValid(valid)
            }}
            gapValue={gapDraft}
            defaultGapPx={defaultGapPx}
            onGapChange={(value, valid) => {
              setGapDraft(value)
              setGapValid(valid)
            }}
            blendValue={blendDraft}
            onBlendChange={setBlendDraft}
            slideValue={slideDraft}
            onSlideChange={(value, valid) => {
              setSlideDraft(value)
              setSlideValid(valid)
            }}
          />
        </TabsContent>
        {showPropertiesTab && (
          <TabsContent
            value="properties"
            className="flex-1 min-h-0 mt-3 flex flex-col data-[state=inactive]:hidden"
          >
            <ReportSettingsPropertiesTab
              draft={typeDraft}
              onChange={setTypeDraft}
              entitiesDraft={entitiesDraft}
              onEntitiesChange={setEntitiesDraft}
              metadata={metadata}
            />
          </TabsContent>
        )}
      </Tabs>
      <DialogFooter className="shrink-0 gap-2 sm:gap-2 border-t pt-3 mt-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          취소
        </Button>
        <Button
          size="sm"
          onClick={handleApply}
          disabled={!widthValid || !gapValid || !slideValid || !dirty}
        >
          적용
        </Button>
      </DialogFooter>
    </>
  )
}

/**
 * 페이지 설정 — content width + inter-widget vertical gap. Each row uses
 * `SettingRow` so the label column lines up across rows. Designed for
 * additional rows to be added below as the page-level settings grow
 * (margins, default colors, etc.).
 */
function PageSettingsTab({
  widthValue,
  defaultPx,
  onWidthChange,
  gapValue,
  defaultGapPx,
  onGapChange,
  blendValue,
  onBlendChange,
  slideValue,
  onSlideChange,
}) {
  return (
    <div className="space-y-5 pr-1">
      <SettingRow
        label="폭"
        hint={`본문 콘텐츠의 최대 가로 폭 (px). 기본값은 ${defaultPx} px.`}
      >
        <InlineWidthControl
          value={widthValue}
          defaultPx={defaultPx}
          onChange={onWidthChange}
        />
      </SettingRow>
      <SettingRow
        label="위젯 간격"
        hint={`위젯(행) 사이 세로 간격 (px). 기본값은 ${defaultGapPx} px.`}
      >
        <InlineGapControl
          value={gapValue}
          defaultPx={defaultGapPx}
          onChange={onGapChange}
        />
      </SettingRow>
      <SettingRow
        label="컨테이너 경계"
        hint="끄면 각 위젯이 카드(테두리·그림자·흰 배경)로 구분되고, 켜면 위젯 경계가 페이지 배경에 녹아 한 장처럼 보입니다."
      >
        <InlineToggleControl
          checked={blendValue === true}
          onChange={onBlendChange}
          onLabel="페이지에 녹이기"
          offLabel="경계 표시 (기본)"
        />
      </SettingRow>
      <SettingRow
        label="PPT 가이드"
        hint="본문 위에 PPT 슬라이드 한 장 분량(본문 폭 × 역비율)마다 수평 점선을 표시합니다. PPT export 시 한 슬라이드에 어디까지 들어갈지 미리 확인하는 용도이며, 인쇄/HTML/DOCX 출력에는 영향을 주지 않습니다."
      >
        <InlineSlideGuideControl value={slideValue} onChange={onSlideChange} />
      </SettingRow>
      {/* 후속 페이지 설정은 여기 같은 SettingRow 패턴으로 추가 */}
    </div>
  )
}

const SLIDE_RATIO_PRESETS = ['16:9', '4:3', '16:10', 'custom']

const SLIDE_RATIO_LABELS = {
  '16:9': '16:9',
  '4:3': '4:3',
  '16:10': '16:10',
  custom: '커스텀',
}

/**
 * `null`/일부 누락된 currentSlideGuide 를 안전한 시드값으로 정규화한다.
 * 다이얼로그가 항상 정형화된 객체로 dirty 비교를 하도록 보장.
 */
function normalizeSlideGuide(cfg) {
  if (!cfg || typeof cfg !== 'object') return { ...DEFAULT_SLIDE_GUIDE_CONFIG }
  const ratio = SLIDE_RATIO_PRESETS.includes(cfg.ratio)
    ? cfg.ratio
    : DEFAULT_SLIDE_GUIDE_RATIO
  return {
    enabled: cfg.enabled === true,
    ratio,
    customW: Number.isFinite(cfg.customW) ? cfg.customW : null,
    customH: Number.isFinite(cfg.customH) ? cfg.customH : null,
  }
}

function sameSlideGuide(a, b) {
  return (
    a.enabled === b.enabled &&
    a.ratio === b.ratio &&
    (a.customW ?? null) === (b.customW ?? null) &&
    (a.customH ?? null) === (b.customH ?? null)
  )
}

/**
 * 슬라이드 가이드 컨트롤. 한 줄에 on/off 세그먼트 + (켜진 경우) 비율
 * 세그먼트 + 커스텀 비율 입력 두 칸을 함께 보여준다. 커스텀이 아닐 땐
 * 입력 두 칸을 감춰서 행이 한 줄로 짧게 유지된다.
 *
 * `onChange(next, isValid)` 로 부모 dialog 의 draft 와 valid 플래그를 동시에
 * 갱신한다. valid 가 false 면 적용 버튼이 비활성화된다 (커스텀 비율의
 * 음수/0/공백 같은 입력 보호).
 */
function InlineSlideGuideControl({ value, onChange }) {
  const safe = normalizeSlideGuide(value)
  const enabled = safe.enabled === true
  const ratio = safe.ratio
  const isCustom = ratio === 'custom'

  const [customWText, setCustomWText] = useState(
    Number.isFinite(safe.customW) ? String(safe.customW) : '',
  )
  const [customHText, setCustomHText] = useState(
    Number.isFinite(safe.customH) ? String(safe.customH) : '',
  )

  // Sync local text when the parent value changes externally (e.g. a reset).
  // The two text states are 1:1 mirrors of value.customW/H — keeping them
  // local lets the user type partial values like "16" → "1" without us
  // immediately invalidating the draft.
  useEffect(() => {
    setCustomWText(Number.isFinite(safe.customW) ? String(safe.customW) : '')
    setCustomHText(Number.isFinite(safe.customH) ? String(safe.customH) : '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [safe.customW, safe.customH])

  function emit(next, validOverride = null) {
    // valid 는 "현재 입력이 backend 가 받을 만한 상태인가". 커스텀일 때만
    // 두 정수 입력이 모두 1 이상이어야 valid. 그 외 비율은 항상 valid.
    let valid = true
    if (validOverride != null) {
      valid = validOverride
    } else if (next.enabled && next.ratio === 'custom') {
      valid =
        Number.isFinite(next.customW) &&
        next.customW >= 1 &&
        Number.isFinite(next.customH) &&
        next.customH >= 1
    }
    onChange?.(next, valid)
  }

  function setEnabled(nextEnabled) {
    emit({ ...safe, enabled: nextEnabled })
  }
  function setRatio(nextRatio) {
    if (nextRatio === 'custom') {
      const w = Number.parseInt(customWText, 10)
      const h = Number.parseInt(customHText, 10)
      emit({
        ...safe,
        ratio: 'custom',
        customW: Number.isFinite(w) && w >= 1 ? w : null,
        customH: Number.isFinite(h) && h >= 1 ? h : null,
      })
    } else {
      // Preset 으로 돌아가면 custom 값은 보존하되 valid 검사 대상에서 제외.
      emit({ ...safe, ratio: nextRatio })
    }
  }
  function setCustomDim(key, text) {
    if (key === 'w') setCustomWText(text)
    else setCustomHText(text)
    const wText = key === 'w' ? text : customWText
    const hText = key === 'h' ? text : customHText
    const w = Number.parseInt(wText, 10)
    const h = Number.parseInt(hText, 10)
    emit({
      ...safe,
      ratio: 'custom',
      customW: Number.isFinite(w) && w >= 1 ? w : null,
      customH: Number.isFinite(h) && h >= 1 ? h : null,
    })
  }

  const customInvalid =
    enabled &&
    isCustom &&
    (!Number.isFinite(safe.customW) ||
      safe.customW < 1 ||
      !Number.isFinite(safe.customH) ||
      safe.customH < 1)

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <InlineToggleControl
          checked={enabled}
          onChange={setEnabled}
          onLabel="켬"
          offLabel="끔 (기본)"
        />
        {enabled && (
          <div className="inline-flex rounded-md border bg-background overflow-hidden">
            {SLIDE_RATIO_PRESETS.map((r, i) => (
              <button
                key={r}
                type="button"
                onClick={() => setRatio(r)}
                className={cn(
                  'h-8 px-3 text-xs transition-colors',
                  i > 0 && 'border-l',
                  ratio === r
                    ? 'bg-primary text-primary-foreground'
                    : 'hover:bg-muted',
                )}
              >
                {SLIDE_RATIO_LABELS[r]}
              </button>
            ))}
          </div>
        )}
        {enabled && isCustom && (
          <div className="flex items-center gap-1">
            <Input
              type="number"
              min={1}
              max={10000}
              value={customWText}
              placeholder="16"
              onChange={(e) => setCustomDim('w', e.target.value)}
              className="h-8 w-16"
            />
            <span className="text-xs text-muted-foreground">:</span>
            <Input
              type="number"
              min={1}
              max={10000}
              value={customHText}
              placeholder="9"
              onChange={(e) => setCustomDim('h', e.target.value)}
              className="h-8 w-16"
            />
          </div>
        )}
      </div>
      {customInvalid && (
        <p className="text-[11px] text-destructive">
          가로·세로 비율은 1 이상의 정수여야 합니다.
        </p>
      )}
    </div>
  )
}

/**
 * Compact two-state segmented control used for boolean page settings.
 * Mirrors the width/gap control row chrome so the page tab reads as a
 * cohesive column of left-labeled controls.
 */
function InlineToggleControl({ checked, onChange, onLabel, offLabel }) {
  return (
    <div className="inline-flex rounded-md border bg-background overflow-hidden">
      <button
        type="button"
        onClick={() => onChange?.(false)}
        className={cn(
          'h-8 px-3 text-xs transition-colors',
          !checked
            ? 'bg-primary text-primary-foreground'
            : 'hover:bg-muted',
        )}
      >
        {offLabel}
      </button>
      <button
        type="button"
        onClick={() => onChange?.(true)}
        className={cn(
          'h-8 px-3 text-xs transition-colors border-l',
          checked
            ? 'bg-primary text-primary-foreground'
            : 'hover:bg-muted',
        )}
      >
        {onLabel}
      </button>
    </div>
  )
}

/**
 * A label-on-the-left / control-on-the-right row. The label column is
 * fixed-width so rows line up; the control column takes only as much
 * width as the control itself needs (no flex-1) — keeps the row from
 * stretching across the whole modal for what's really a short control.
 * `hint` shows under the control, indented to match the control column.
 */
function SettingRow({ label, hint, children }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-3">
        <Label className="text-sm font-medium shrink-0 w-20">{label}</Label>
        <div className="min-w-0">{children}</div>
      </div>
      {hint && (
        <p className="text-[11px] text-muted-foreground pl-[92px]">{hint}</p>
      )}
    </div>
  )
}

/**
 * Compact one-line width control. Preset buttons + numeric input +
 * 기본값. Every interaction reports back to the parent draft via
 * onChange(parsedOrNull, isValid); the dialog footer's "적용" is what
 * eventually pushes that draft to the report.
 *
 * Same 320–3000 client-side bounds as the backend Pydantic schema so
 * the validation error fires before the user clicks 적용.
 */
function InlineWidthControl({ value, defaultPx, onChange }) {
  const PRESETS = [1024, 1280, 1440, 1920]
  const [text, setText] = useState(
    Number.isFinite(value) ? String(value) : '',
  )

  // Sync the visible input when the draft value changes from outside
  // this control (preset click, dialog mounted with a current value).
  useEffect(() => {
    setText(Number.isFinite(value) ? String(value) : '')
  }, [value])

  const trimmed = text.trim()
  const parsed = trimmed === '' ? null : Number.parseInt(trimmed, 10)
  const isValid =
    trimmed === '' ||
    (Number.isFinite(parsed) && parsed >= 320 && parsed <= 3000)

  function reportChange(nextText) {
    setText(nextText)
    const t = nextText.trim()
    if (t === '') {
      onChange?.(null, true)
      return
    }
    const p = Number.parseInt(t, 10)
    const valid = Number.isFinite(p) && p >= 320 && p <= 3000
    // While invalid we still hold the partial text locally, but tell
    // the dialog the draft is unusable (so 적용 disables).
    onChange?.(valid ? p : null, valid)
  }

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        {PRESETS.map((px) => (
          <Button
            key={px}
            variant={parsed === px ? 'default' : 'outline'}
            size="sm"
            className="h-8"
            onClick={() => reportChange(String(px))}
          >
            {px}
          </Button>
        ))}
        <span className="text-xs text-muted-foreground px-1">또는</span>
        <Input
          type="number"
          min={320}
          max={3000}
          value={text}
          placeholder={`${defaultPx}`}
          onChange={(e) => reportChange(e.target.value)}
          className="h-8 w-24"
        />
        <span className="text-xs text-muted-foreground">px</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-8"
          onClick={() => reportChange('')}
          title={`기본값 (${defaultPx} px) 로 되돌립니다.`}
        >
          기본값
        </Button>
      </div>
      {!isValid && (
        <p className="text-[11px] text-destructive">
          320 부터 3000 사이의 정수를 입력하세요.
        </p>
      )}
    </div>
  )
}

/**
 * Compact one-line gap control. Mirrors `InlineWidthControl` — preset
 * buttons + numeric input + 기본값 reset. Range 0–200 mirrors the backend
 * Pydantic schema so an invalid entry disables 적용 before the round-trip.
 */
function InlineGapControl({ value, defaultPx, onChange }) {
  const PRESETS = [8, 16, 32, 48]
  const [text, setText] = useState(
    Number.isFinite(value) ? String(value) : '',
  )

  useEffect(() => {
    setText(Number.isFinite(value) ? String(value) : '')
  }, [value])

  const trimmed = text.trim()
  const parsed = trimmed === '' ? null : Number.parseInt(trimmed, 10)
  const isValid =
    trimmed === '' ||
    (Number.isFinite(parsed) && parsed >= 0 && parsed <= 200)

  function reportChange(nextText) {
    setText(nextText)
    const t = nextText.trim()
    if (t === '') {
      onChange?.(null, true)
      return
    }
    const p = Number.parseInt(t, 10)
    const valid = Number.isFinite(p) && p >= 0 && p <= 200
    onChange?.(valid ? p : null, valid)
  }

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        {PRESETS.map((px) => (
          <Button
            key={px}
            variant={parsed === px ? 'default' : 'outline'}
            size="sm"
            className="h-8"
            onClick={() => reportChange(String(px))}
          >
            {px}
          </Button>
        ))}
        <span className="text-xs text-muted-foreground px-1">또는</span>
        <Input
          type="number"
          min={0}
          max={200}
          value={text}
          placeholder={`${defaultPx}`}
          onChange={(e) => reportChange(e.target.value)}
          className="h-8 w-24"
        />
        <span className="text-xs text-muted-foreground">px</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-8"
          onClick={() => reportChange('')}
          title={`기본값 (${defaultPx} px) 로 되돌립니다.`}
        >
          기본값
        </Button>
      </div>
      {!isValid && (
        <p className="text-[11px] text-destructive">
          0 부터 200 사이의 정수를 입력하세요.
        </p>
      )}
    </div>
  )
}

/**
 * 속성 tab — editable 종류 picker (위쪽, grow) + read-only 메타 정보
 * (아래쪽, 자기 크기). Separator로 두 영역을 시각적으로 구분한다.
 *
 * 종류 picker는 클릭 즉시 dialog의 typeDraft를 갱신하고, 부모 draft로의
 * 푸시는 dialog footer의 "적용"이 담당. 메타 섹션은 보고서 작성자·부서·
 * 일시 등 서버 권위 정보라 편집 UI 없이 표시만 한다.
 */
function ReportSettingsPropertiesTab({
  draft,
  onChange,
  entitiesDraft,
  onEntitiesChange,
  metadata,
}) {
  function handlePick(typeOrNull) {
    if (typeOrNull == null) {
      onChange({ id: null, ref: null })
      return
    }
    onChange({ id: typeOrNull.id, ref: typeOrNull })
  }

  // The whole tab scrolls as one column — the type picker has its own
  // internal scroll for the result grid (min-h-[18rem]), entity tags
  // sit below as compact one-line rows, and the metadata section is
  // last. If everything together exceeds the modal body, this outer
  // overflow-y-auto kicks in so the read-only rows are never clipped
  // off-screen. px-1 keeps a small breathing room on both sides so the
  // boxed sub-sections aren't flush with the modal edge.
  return (
    <div className="flex flex-1 min-h-0 flex-col gap-4 overflow-y-auto px-1">
      <div className="flex flex-col gap-1.5">
        <SectionLabel>보고서 종류</SectionLabel>
        <ReportTypePicker
          value={draft.id}
          currentType={draft.ref}
          onChange={handlePick}
        />
      </div>
      <Separator />
      <div className="flex flex-col gap-1.5">
        <SectionLabel>관련 정보</SectionLabel>
        <EntityTagsSection
          entities={entitiesDraft}
          onChange={onEntitiesChange}
        />
      </div>
      {metadata && (
        <>
          <Separator />
          <div className="flex flex-col gap-1.5">
            <SectionLabel>보고서 정보</SectionLabel>
            {/* Visible group-box so the read-only meta rows are clearly
                a single chunk rather than free-floating dt/dd pairs. */}
            <div className="rounded-md border bg-muted/30 p-3">
              <MetadataList metadata={metadata} />
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * One row per axis (모델명/부품명/BOM/단계/불량/시험/시뮬레이션). Loads
 * the axis catalog on first mount — small (~7 rows) + stable so a single
 * fetch per dialog open is fine. While loading, the section shows a
 * subtle placeholder rather than collapsing entirely (avoids a layout
 * shift when the data arrives).
 */
function EntityTagsSection({ entities, onChange }) {
  const [types, setTypes] = useState(null) // null = loading, [] = empty (impossible post-seed but safe)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    listEntityTypes()
      .then((res) => {
        if (cancelled) return
        setTypes(res?.items ?? [])
      })
      .catch((e) => {
        if (cancelled) return
        setError(e)
        toast.error('축 목록 불러오기 실패', {
          description: String(e?.message ?? e),
        })
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Group selected entities by type_slug — O(n) once per render. The
  // picker is controlled per-axis so swapping one row's list back into
  // the flat draft means filtering out the old axis values and
  // concatenating the new ones.
  const byTypeSlug = useMemo(() => {
    const m = new Map()
    for (const e of entities || []) {
      const slug = e.type_slug ?? ''
      if (!m.has(slug)) m.set(slug, [])
      m.get(slug).push(e)
    }
    return m
  }, [entities])

  function setAxisValue(slug, nextList) {
    const others = (entities || []).filter((e) => (e.type_slug ?? '') !== slug)
    onChange?.([...others, ...nextList])
  }

  if (types === null) {
    return (
      <p className="text-xs text-muted-foreground">축 목록 불러오는 중...</p>
    )
  }
  if (error) {
    return (
      <p className="text-xs text-destructive">
        축 목록을 불러올 수 없습니다. 새로고침 후 다시 시도하세요.
      </p>
    )
  }
  if (types.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">등록된 축이 없습니다.</p>
    )
  }

  return (
    <div className="space-y-2">
      {types.map((t) => (
        <div key={t.id} className="flex items-start gap-3">
          <Label className="w-24 shrink-0 pt-1.5 text-xs text-muted-foreground">
            {t.label}
          </Label>
          <div className="min-w-0 flex-1">
            <EntityMultiPicker
              type={t}
              value={byTypeSlug.get(t.slug) ?? []}
              onChange={(next) => setAxisValue(t.slug, next)}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

function SectionLabel({ children }) {
  return (
    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  )
}

/**
 * Read-only key/value list. Rows whose value is empty are skipped —
 * early reports / templated stubs often lack updated_by_name, for
 * instance, and an empty "마지막 수정자: —" line just adds noise.
 *
 * Rendered as plain flex rows (label column on the left, value on the
 * right) rather than a `dl + display:contents` grid; `display:contents`
 * breaks grid-cell behavior in a couple of browsers/extensions, which
 * caused the rows to collapse to a single column where the label was
 * effectively invisible above its value.
 */
function MetadataList({ metadata }) {
  const ownerLabel = formatPerson(metadata.owner_name, metadata.owner_email)
  const updatedByLabel = formatPerson(
    metadata.updated_by_name,
    metadata.updated_by_email,
  )
  const rows = [
    { label: '제목', value: metadata.title },
    { label: '작성자', value: ownerLabel },
    { label: '소속 부서', value: metadata.workspace_slug },
    { label: '보고일', value: metadata.report_date },
    { label: '상태', value: formatStatus(metadata.status) },
    { label: '작성일시', value: formatDateTime(metadata.created_at) },
    { label: '마지막 수정', value: formatDateTime(metadata.updated_at) },
    { label: '마지막 수정자', value: updatedByLabel },
  ].filter((r) => r.value != null && r.value !== '')

  if (rows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">표시할 정보가 없습니다.</p>
    )
  }

  return (
    <div className="space-y-1.5 text-sm">
      {rows.map((row) => (
        <div key={row.label} className="flex items-start gap-3">
          <div className="w-24 shrink-0 pt-0.5 text-xs text-muted-foreground">
            {row.label}
          </div>
          <div className="flex-1 min-w-0 break-all">{row.value}</div>
        </div>
      ))}
    </div>
  )
}

function formatPerson(name, email) {
  if (!name && !email) return ''
  if (name && email) return `${name} <${email}>`
  return name || email
}

function formatStatus(status) {
  if (!status) return ''
  // The backend's ReportStatus enum is small — keep the mapping inline
  // rather than wiring up a shared i18n layer for one dialog.
  const map = { draft: '초안', published: '게시됨', archived: '보관됨' }
  return map[status] || status
}

function formatDateTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * Returns true when two slim entity lists tag the same set of ids,
 * regardless of order. The backend stores links in an unordered M:N
 * table, so the dirty check should match that semantic — sorting both
 * lists before comparing avoids spurious "dirty" after a pure reorder.
 */
function sameIdSet(a, b) {
  const aIds = (Array.isArray(a) ? a : []).map((e) => e.id).sort()
  const bIds = (Array.isArray(b) ? b : []).map((e) => e.id).sort()
  if (aIds.length !== bIds.length) return false
  for (let i = 0; i < aIds.length; i += 1) {
    if (aIds[i] !== bIds[i]) return false
  }
  return true
}
