import { useState } from 'react'
import { Settings2 } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/components/ui/tabs'

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
 * Tabbed report-level settings dialog. The dialog owns the tab shell +
 * close behavior; individual tabs render their own bodies and call back
 * into the parent to commit changes. Currently only the 폭 tab is wired —
 * the structure is in place so future report-wide settings (e.g. 기본
 * 단락 색, 출력 옵션) can land as additional TabsTrigger / TabsContent
 * pairs without another dialog round-trip.
 *
 * The same dialog is reused by both the report editor and the template
 * editor — the template editor writes the values to the template's
 * `report_defaults` so new reports from that template inherit them.
 *
 * Each tab is responsible for its own draft → apply round-trip; the
 * dialog does NOT batch changes across tabs. That keeps the "변경했지만
 * 저장 안 함" risk low — switching tabs without applying leaves the
 * previous tab's local state intact, but no further commit flows
 * through unless the user explicitly clicks the tab's 적용.
 */
export function ReportSettingsDialog({
  open,
  currentWidthPx,
  defaultWidthPx = DEFAULT_REPORT_WIDTH_PX,
  onClose,
  onApplyWidth,
}) {
  if (!open) return null
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings2 className="h-4 w-4" />
            보고서 설정
          </DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="width" className="pt-2">
          <TabsList>
            <TabsTrigger value="width">폭</TabsTrigger>
          </TabsList>
          <TabsContent value="width">
            <ReportSettingsWidthTab
              currentPx={currentWidthPx}
              defaultPx={defaultWidthPx}
              onClose={onClose}
              onApply={onApplyWidth}
            />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Body of the 폭 tab — preset buttons + numeric input + 기본값/취소/적용.
 * Lives as its own component so the tab body has a stable identity
 * across tab switches (state resets on remount, which is what we want
 * here). Same 320–3000 client-side bounds as the backend Pydantic
 * schema so the validation error fires before the user clicks 적용.
 */
function ReportSettingsWidthTab({ currentPx, defaultPx, onClose, onApply }) {
  const [text, setText] = useState(
    Number.isFinite(currentPx) ? String(currentPx) : '',
  )
  const PRESETS = [1024, 1280, 1440, 1920]
  const trimmed = text.trim()
  const parsed = trimmed === '' ? null : Number.parseInt(trimmed, 10)
  const isValid =
    trimmed === '' ||
    (Number.isFinite(parsed) && parsed >= 320 && parsed <= 3000)
  function apply() {
    if (!isValid) return
    onApply(trimmed === '' ? null : parsed)
  }
  return (
    <div className="space-y-4 pt-2">
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((px) => (
          <Button
            key={px}
            variant={parsed === px ? 'default' : 'outline'}
            size="sm"
            onClick={() => setText(String(px))}
          >
            {px} px
          </Button>
        ))}
      </div>
      <div>
        <Label className="text-xs">직접 입력 (320–3000 px)</Label>
        <Input
          type="number"
          min={320}
          max={3000}
          value={text}
          placeholder={`비워두면 기본값 (${defaultPx} px)`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && isValid) {
              e.preventDefault()
              apply()
            }
          }}
          className="mt-1 h-9"
        />
        {!isValid && (
          <p className="mt-1 text-[11px] text-destructive">
            320 부터 3000 사이의 정수를 입력하세요.
          </p>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">
        변경 사항은 “저장”을 누르면 반영됩니다.
      </p>
      <DialogFooter className="gap-2 sm:gap-2 px-0">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onApply(null)}
          title={`기본값 (${defaultPx} px) 로 되돌립니다.`}
        >
          기본값
        </Button>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onClose}>
          취소
        </Button>
        <Button size="sm" onClick={apply} disabled={!isValid}>
          적용
        </Button>
      </DialogFooter>
    </div>
  )
}
