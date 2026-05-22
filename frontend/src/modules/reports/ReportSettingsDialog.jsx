import { useEffect, useState } from 'react'
import { Info, Settings2 } from 'lucide-react'
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
  // 속성 탭 — editable 보고서 종류 + read-only 메타 (작성자/부서/일시 등).
  // 템플릿 편집기는 종류·메타 개념이 없으므로 이 prop을 false로 두면
  // 탭 자체가 사라진다.
  showPropertiesTab = false,
  currentTypeId = null,
  currentType = null,
  // 보고서 메타데이터 (read-only로 표시). owner_name, owner_email,
  // workspace_slug, report_date, status, created_at, updated_at,
  // updated_by_name 등을 키로 가지는 평면 객체. 일부 키가 비어 있으면
  // 해당 행은 자동으로 숨겨진다 (= 새 보고서 작성 시점에는 일부가 비어
  // 있을 수 있어서).
  metadata = null,
  onClose,
  onApplyWidth,
  onApplyType,
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
          showPropertiesTab={showPropertiesTab}
          currentTypeId={currentTypeId}
          currentType={currentType}
          metadata={metadata}
          onClose={onClose}
          onApplyWidth={onApplyWidth}
          onApplyType={onApplyType}
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
  showPropertiesTab,
  currentTypeId,
  currentType,
  metadata,
  onClose,
  onApplyWidth,
  onApplyType,
}) {
  const initialWidth = Number.isFinite(currentWidthPx) ? currentWidthPx : null
  const [widthDraft, setWidthDraft] = useState(initialWidth)
  const [widthValid, setWidthValid] = useState(true)
  const [typeDraft, setTypeDraft] = useState({
    id: currentTypeId ?? null,
    ref: currentType ?? null,
  })

  const widthChanged = (widthDraft ?? null) !== (currentWidthPx ?? null)
  const typeChanged = (typeDraft.id ?? null) !== (currentTypeId ?? null)
  const dirty = widthChanged || (showPropertiesTab && typeChanged)

  function handleApply() {
    if (!widthValid) return
    if (widthChanged) onApplyWidth?.(widthDraft ?? null)
    if (showPropertiesTab && typeChanged) onApplyType?.(typeDraft)
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
          disabled={!widthValid || !dirty}
        >
          적용
        </Button>
      </DialogFooter>
    </>
  )
}

/**
 * 페이지 설정 — currently just the content width control. Designed
 * for additional rows to be added below as the page-level settings
 * grow (margins, default colors, etc.). Each row uses `SettingRow`
 * so the label column lines up across rows.
 */
function PageSettingsTab({ widthValue, defaultPx, onWidthChange }) {
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
      {/* 후속 페이지 설정은 여기 같은 SettingRow 패턴으로 추가 */}
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
 * 속성 tab — editable 종류 picker (위쪽, grow) + read-only 메타 정보
 * (아래쪽, 자기 크기). Separator로 두 영역을 시각적으로 구분한다.
 *
 * 종류 picker는 클릭 즉시 dialog의 typeDraft를 갱신하고, 부모 draft로의
 * 푸시는 dialog footer의 "적용"이 담당. 메타 섹션은 보고서 작성자·부서·
 * 일시 등 서버 권위 정보라 편집 UI 없이 표시만 한다.
 */
function ReportSettingsPropertiesTab({ draft, onChange, metadata }) {
  function handlePick(typeOrNull) {
    if (typeOrNull == null) {
      onChange({ id: null, ref: null })
      return
    }
    onChange({ id: typeOrNull.id, ref: typeOrNull })
  }

  // The whole tab scrolls as one column — the type picker has its own
  // internal scroll for the result grid (min-h-[18rem]), and the metadata
  // section sits below. If both together exceed the modal body, this
  // outer overflow-y-auto kicks in so the read-only rows are never
  // clipped off-screen. px-1 keeps a small breathing room on both
  // sides so the boxed sub-sections aren't flush with the modal edge
  // (which read as "clipped on the left" in the prior layout).
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
