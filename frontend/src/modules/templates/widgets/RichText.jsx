import { useEffect, useLayoutEffect, useRef } from 'react'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { Textarea } from '@/shared/components/ui/textarea'
import { CaptionInput, LabelField, PreviewLabel } from './_shared'

export function RichTextPropsPanel({ props, onChange }) {
  return (
    <div className="space-y-4">
      <LabelField
        label="라벨"
        value={props.label}
        onChange={(v) => onChange({ ...props, label: v })}
        placeholder="주간 요약"
      />
      <LabelField
        label="플레이스홀더"
        value={props.placeholder}
        onChange={(v) => onChange({ ...props, placeholder: v })}
        placeholder="이번 주 핵심 내용을 3-5줄로"
        hint="작성자에게 보여줄 힌트"
      />
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-xs">최소 글자 수</Label>
          <Input
            type="number"
            min={0}
            value={props.min_length ?? ''}
            onChange={(e) =>
              onChange({
                ...props,
                min_length: e.target.value === '' ? undefined : Number(e.target.value),
              })
            }
            className="mt-1 h-9"
          />
        </div>
        <div>
          <Label className="text-xs">최대 글자 수</Label>
          <Input
            type="number"
            min={1}
            value={props.max_length ?? ''}
            onChange={(e) =>
              onChange({
                ...props,
                max_length: e.target.value === '' ? undefined : Number(e.target.value),
              })
            }
            className="mt-1 h-9"
          />
        </div>
      </div>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={!!props.required}
          onChange={(e) => onChange({ ...props, required: e.target.checked })}
        />
        필수 입력
      </label>
      <label className="flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          checked={!!props.expand_with_content}
          onChange={(e) =>
            onChange({ ...props, expand_with_content: e.target.checked || undefined })
          }
          className="mt-0.5"
        />
        <span>
          내용에 따라 자동 확장
          <span className="block text-[10px] text-muted-foreground mt-0.5">
            켜면 글이 길어질수록 입력창과 블록 높이가 자동으로 커집니다 (스크롤 없음).
          </span>
        </span>
      </label>
    </div>
  )
}

export function RichTextPreview({ props }) {
  return (
    <div className="space-y-2">
      <PreviewLabel
        hint={
          [props.required && '필수', props.expand_with_content && '자동 확장']
            .filter(Boolean)
            .join(' · ') || null
        }
      >
        {props.label || '(라벨 없음)'}
      </PreviewLabel>
      <Textarea
        readOnly
        value=""
        placeholder={props.placeholder || '여기에 마크다운으로 작성합니다.'}
        className="bg-muted/30"
        rows={3}
      />
    </div>
  )
}

/**
 * Auto-resizing textarea — keeps the rendered height in sync with the
 * content's scrollHeight so the textarea grows as the user types.
 * Used when rich_text has `expand_with_content`.
 */
function AutoResizeTextarea({ value, onChange, placeholder, className }) {
  const ref = useRef(null)
  // useLayoutEffect avoids a flicker on first paint with seeded content.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      className={className}
      style={{ overflow: 'hidden', resize: 'none' }}
      rows={1}
    />
  )
}

export function RichTextEditor({ props, content, onChange, readOnly }) {
  const caption = content?.caption ?? ''
  const value = content?.markdown ?? ''
  const charCount = value.length
  const min = props.min_length
  const max = props.max_length
  const baseClass =
    'font-mono text-sm flex w-full rounded-md border border-input bg-background px-3 py-2 ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50'

  function patch(next) {
    const merged = { caption, markdown: value, ...next }
    if (!merged.caption) delete merged.caption
    if (!merged.markdown) delete merged.markdown
    onChange(merged)
  }

  if (readOnly) {
    return (
      <div className="space-y-2">
        <CaptionInput value={caption} readOnly />
        {value ? (
          <pre className="whitespace-pre-wrap font-mono text-sm bg-muted/30 rounded-md p-3 border">
            {value}
          </pre>
        ) : null}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <CaptionInput
        value={caption}
        onChange={(v) => patch({ caption: v })}
        placeholder={props.label}
      />
      {props.expand_with_content ? (
        <AutoResizeTextarea
          value={value}
          onChange={(e) => patch({ markdown: e.target.value })}
          placeholder={props.placeholder || '마크다운으로 작성'}
          className={`${baseClass} min-h-[6rem]`}
        />
      ) : (
        <Textarea
          value={value}
          onChange={(e) => patch({ markdown: e.target.value })}
          placeholder={props.placeholder || '마크다운으로 작성'}
          rows={6}
          className="font-mono text-sm"
        />
      )}
      {(min || max) && (
        <p className="text-[10px] text-muted-foreground text-right">
          {charCount}자 {min ? `(최소 ${min})` : ''} {max ? `(최대 ${max})` : ''}
        </p>
      )}
    </div>
  )
}
