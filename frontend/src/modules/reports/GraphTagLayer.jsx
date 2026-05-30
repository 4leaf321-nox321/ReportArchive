// 관계도 관련정보(entity) 레이어 컨트롤 (지식그래프 Phase 2) — 그래프에
// 태그를 노드로 덧씌울지 + 어떤 축을 + 공유된 것만 그릴지 고른다. 모달·글로벌
// 페이지가 공유한다.
//
// 부품처럼 값이 많은 축은 1회성 태그가 잎사귀로 매달려 헤어볼이 되므로:
//   - 축 선택   : 기본은 저카디널리티 축(모델명·개발단계)만. 부품 등은 수동 on.
//   - 공유된 것만: 2개 이상 보고서가 공유한 태그만(min_degree=2) — 잡음 제거.
// 둘 다 백엔드 _entity_layer 의 axes/min_degree 와 짝.
import { useEffect, useState } from 'react'
import { Tag } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/shared/components/ui/popover'
import { listEntityTypes } from '@/shared/api/entities'

// 처음 켰을 때 기본 on 인 축(slug) — 종류가 적어 잘 묶이는 축만 (사용자 결정).
export const DEFAULT_TAG_AXES = ['model', 'phase']

/**
 * @param {object}   props
 * @param {boolean}  props.enabled      레이어 표시 여부
 * @param {string[]} props.axes         그릴 축 slug 목록
 * @param {boolean}  props.sharedOnly   공유된 태그만(2+) 표시
 * @param {(next:{enabled:boolean, axes:string[], sharedOnly:boolean})=>void} props.onChange
 */
export function GraphTagLayer({ enabled, axes, sharedOnly, onChange }) {
  const [axisOptions, setAxisOptions] = useState([]) // EntityTypeRead[]

  useEffect(() => {
    let cancelled = false
    listEntityTypes()
      .then((res) => {
        if (!cancelled) setAxisOptions(res?.items ?? [])
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const setEnabled = (v) => onChange({ enabled: v, axes, sharedOnly })
  const setSharedOnly = (v) => onChange({ enabled, axes, sharedOnly: v })
  const toggleAxis = (slug) => {
    const next = axes.includes(slug)
      ? axes.filter((s) => s !== slug)
      : [...axes, slug]
    onChange({ enabled, axes: next, sharedOnly })
  }

  const summary = !enabled
    ? '끔'
    : `${axes.length}축${sharedOnly ? '·공유만' : ''}`

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1 rounded-md border bg-background px-2 text-[11px]"
        >
          <Tag className="h-3 w-3 text-muted-foreground" />
          <span className="text-muted-foreground">관련정보</span>
          <span className={enabled ? 'text-foreground' : 'text-muted-foreground'}>
            {summary}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[240px] p-2" align="start">
        <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-xs font-medium">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="accent-indigo-500"
          />
          관련정보 노드 표시
        </label>

        {enabled && (
          <>
            <div className="mt-1 border-t pt-2">
              <p className="px-1 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                축
              </p>
              <div className="max-h-[200px] space-y-0.5 overflow-y-auto">
                {axisOptions.length === 0 ? (
                  <p className="px-1 py-1 text-[11px] text-muted-foreground italic">
                    축 없음
                  </p>
                ) : (
                  axisOptions.map((t) => (
                    <label
                      key={t.slug}
                      className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted"
                    >
                      <input
                        type="checkbox"
                        checked={axes.includes(t.slug)}
                        onChange={() => toggleAxis(t.slug)}
                        className="accent-indigo-500"
                      />
                      <span className="truncate">{t.label}</span>
                    </label>
                  ))
                )}
              </div>
            </div>

            <label className="mt-2 flex cursor-pointer items-center gap-2 rounded border-t px-1 pt-2 text-xs">
              <input
                type="checkbox"
                checked={sharedOnly}
                onChange={(e) => setSharedOnly(e.target.checked)}
                className="accent-indigo-500"
              />
              공유된 것만 (2개 이상 보고서)
            </label>
            <p className="px-1 pt-1 text-[10px] leading-snug text-muted-foreground">
              부품처럼 값이 많은 축은 1회성 태그가 잡음이 됩니다. 공유 태그만
              두면 여러 보고서를 잇는 허브만 남습니다.
            </p>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}
