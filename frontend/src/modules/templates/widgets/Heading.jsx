import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'

export function HeadingPropsPanel({ props, onChange }) {
  return (
    <div className="space-y-4">
      <div>
        <Label className="text-xs">레벨</Label>
        <select
          value={props.level ?? 2}
          onChange={(e) => onChange({ ...props, level: Number(e.target.value) })}
          className="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
        >
          <option value={1}>제목 1 (가장 큼)</option>
          <option value={2}>제목 2</option>
          <option value={3}>제목 3</option>
        </select>
      </div>
      <div>
        <Label className="text-xs">기본 텍스트 (선택)</Label>
        <Input
          value={props.default_text ?? ''}
          onChange={(e) =>
            onChange({ ...props, default_text: e.target.value || undefined })
          }
          className="mt-1 h-9"
          placeholder="작성 시 미리 채워질 제목"
        />
        <p className="mt-1 text-[10px] text-muted-foreground">
          제목 텍스트는 보고서 작성 시 입력됩니다. 기본값은 작성자가 수정 가능.
        </p>
      </div>
    </div>
  )
}

function levelClass(level) {
  if (level === 1) return 'text-2xl font-bold'
  if (level === 3) return 'text-lg font-medium'
  return 'text-xl font-semibold'
}

export function HeadingPreview({ props }) {
  const text = props.default_text || '(보고서에서 입력)'
  const isPlaceholder = !props.default_text
  const cls = levelClass(props.level ?? 2)
  // Centering is handled by the BlockCard's CardContent — for heading
  // it sets `flex items-center` so this element auto-centers vertically
  // without depending on an h-full chain.
  return (
    <div
      className={`px-2 ${cls} ${isPlaceholder ? 'text-muted-foreground italic' : ''}`}
    >
      {text}
    </div>
  )
}

export function HeadingEditor({ props, content, onChange, readOnly }) {
  const value = content?.text ?? ''
  const cls = levelClass(props.level ?? 2)
  if (readOnly) {
    if (!value) return null
    return <div className={`px-2 py-1 ${cls}`}>{value}</div>
  }
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange({ text: e.target.value })}
      placeholder={props.default_text || '제목 입력'}
      className={`w-full bg-transparent border-0 outline-none focus:ring-0 placeholder:text-muted-foreground/50 px-2 py-1 ${cls}`}
    />
  )
}
