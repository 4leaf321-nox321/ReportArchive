import * as React from 'react'
import { Sparkles, FileUp, ListChecks, Wand2, ShieldCheck, BookOpen, X } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Textarea } from '@/shared/components/ui/textarea'
import { Separator } from '@/shared/components/ui/separator'
import { Badge } from '@/shared/components/ui/badge'
import { ScrollArea } from '@/shared/components/ui/scroll-area'
import { cn } from '@/shared/lib/utils'

const STEPS = [
  { id: 'intake', label: '1. 자료 수집', icon: FileUp },
  { id: 'plan', label: '2. 섹션 매핑', icon: ListChecks },
  { id: 'generate', label: '3. 섹션 생성', icon: Wand2 },
  { id: 'validate', label: '4. 스키마 검증', icon: ShieldCheck },
  { id: 'cite', label: '5. 인용 검토', icon: BookOpen },
]

/**
 * AI 작성 도크. 데이터 모델·백엔드 연결 전이라 모든 액션은 mock.
 * Step 단위로 보고서 작성 흐름을 시각화하고, 향후 실제 API에 꽂기만 하면 되도록 자리만 잡아둔다.
 */
export function AIDock({ className, sections = [], onClose }) {
  const [step, setStep] = React.useState('intake')

  return (
    <div className={cn('flex h-full flex-col bg-background', className)}>
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <Sparkles className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold">AI 도크</h3>
        <Badge variant="secondary" className="ml-auto text-[10px]">
          mock
        </Badge>
        {onClose && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 -mr-1"
            onClick={onClose}
            aria-label="AI 도크 닫기"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      <div className="flex border-b px-2 py-2 gap-1 overflow-x-auto">
        {STEPS.map((s) => {
          const Icon = s.icon
          const active = step === s.id
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setStep(s.id)}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-2 py-1 text-xs whitespace-nowrap transition-colors',
                active
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'text-muted-foreground hover:bg-muted'
              )}
            >
              <Icon className="h-3 w-3" />
              {s.label}
            </button>
          )
        })}
      </div>

      <ScrollArea className="flex-1">
        <div className="p-4 space-y-4">
          {step === 'intake' && <IntakeStep />}
          {step === 'plan' && <PlanStep sections={sections} />}
          {step === 'generate' && <GenerateStep sections={sections} />}
          {step === 'validate' && <ValidateStep />}
          {step === 'cite' && <CiteStep />}
        </div>
      </ScrollArea>
    </div>
  )
}

function IntakeStep() {
  return (
    <>
      <p className="text-xs text-muted-foreground">
        회의록·원본 데이터·자료 링크를 붙여넣으면 다음 단계에서 섹션별로 매핑된다.
      </p>
      <Textarea
        placeholder="자료 붙여넣기 또는 파일 업로드 (mock)"
        className="min-h-[120px] text-xs"
      />
      <Button variant="outline" size="sm" className="w-full">
        <FileUp className="mr-2 h-3 w-3" />
        파일 첨부
      </Button>
      <Separator />
      <p className="text-[11px] text-muted-foreground">
        붙여놓은 자료는 보고서와 함께 저장되어 인용 단계에서 출처로 사용된다.
      </p>
    </>
  )
}

function PlanStep({ sections }) {
  return (
    <>
      <p className="text-xs text-muted-foreground">
        AI가 템플릿 섹션마다 어떤 자료를 사용할지 매핑 계획을 세운다.
      </p>
      <div className="space-y-2">
        {sections.length === 0 ? (
          <div className="rounded border border-dashed p-3 text-center text-xs text-muted-foreground">
            템플릿이 비어있다.
          </div>
        ) : (
          sections.map((s) => (
            <div key={s.id} className="rounded-md border p-2 text-xs">
              <div className="font-medium">{s.title}</div>
              <div className="mt-1 text-muted-foreground">자료 매핑 결과 자리</div>
            </div>
          ))
        )}
      </div>
      <Button size="sm" className="w-full">
        <Wand2 className="mr-2 h-3 w-3" />
        매핑 생성
      </Button>
    </>
  )
}

function GenerateStep({ sections }) {
  return (
    <>
      <p className="text-xs text-muted-foreground">
        섹션을 선택하고 생성/재작성. 스키마 강제 (structured output) 적용.
      </p>
      <div className="space-y-1">
        {sections.length === 0 ? (
          <div className="rounded border border-dashed p-3 text-center text-xs text-muted-foreground">
            섹션 없음
          </div>
        ) : (
          sections.map((s) => (
            <div key={s.id} className="flex items-center gap-2 rounded-md border p-2 text-xs">
              <span className="flex-1 truncate">{s.title}</span>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs">
                생성
              </Button>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs">
                재작성
              </Button>
            </div>
          ))
        )}
      </div>
    </>
  )
}

function ValidateStep() {
  return (
    <>
      <p className="text-xs text-muted-foreground">
        JSON Schema + 비즈니스 룰 검증 결과. 실패 시 차이 표시 후 repair 루프.
      </p>
      <div className="rounded-md border bg-emerald-50 p-3 text-xs text-emerald-700">
        모든 섹션 검증 통과 (mock)
      </div>
    </>
  )
}

function CiteStep() {
  return (
    <>
      <p className="text-xs text-muted-foreground">
        각 섹션이 어떤 자료를 인용했는지 추적. 환각 방지 게이트.
      </p>
      <div className="rounded-md border p-3 text-xs">
        <div className="font-medium">개요 섹션</div>
        <div className="mt-1 text-muted-foreground">출처 0건 — 인용 필요</div>
      </div>
    </>
  )
}
