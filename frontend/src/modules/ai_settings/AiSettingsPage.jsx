import { Sparkles } from 'lucide-react'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/shared/components/ui/tabs'
import { PromptsTab } from './PromptsTab'
import { McpTab } from './McpTab'
import { SkillTab } from './SkillTab'
import { DiagnosticsTab } from './DiagnosticsTab'
import { AccessTab } from './AccessTab'
import { JobsTab } from './JobsTab'
import { SearchTuningTab } from './SearchTuningTab'
import { EvalTab } from './EvalTab'
import { useAuth } from '@/shared/auth/AuthContext'

/**
 * "공통 → AI 설정" — system-wide page for managing AI-related catalogs
 * and (eventually) API integration. Currently exposes a single live tab
 * (프롬프트). The "모델·API" tab is reserved for Phase 4 when we wire
 * actual model invocation in; until then it shows a "준비 중" placeholder
 * so the navigation structure is stable.
 *
 * Page is unscoped to a workspace — prompts are global vocabulary,
 * shared across all workspaces (same scoping as 보고서 종류 / VOC).
 */
export default function AiSettingsPage() {
  const { me } = useAuth()
  const isAdmin = Boolean(me?.is_system_admin)
  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="flex items-center gap-2">
        <Sparkles className="h-5 w-5 text-primary" />
        <h1 className="text-xl font-semibold">AI 설정</h1>
      </div>
      <p className="text-sm text-muted-foreground -mt-2">
        AI 보고서 작성에 사용할 프롬프트를 관리하고, Claude 연동용 개인 MCP
        토큰을 발급합니다. 등록된 프롬프트는 보고서 편집기의 “AI 프롬프트”
        메뉴에서 선택해 사용할 수 있어요. 작성 규칙을 Claude 스킬로 내보내려면
        “스킬 생성” 탭을 사용하세요.
      </p>

      <Tabs defaultValue="prompts" className="flex flex-1 min-h-0 flex-col">
        <TabsList className="w-fit">
          <TabsTrigger value="prompts">프롬프트</TabsTrigger>
          <TabsTrigger value="mcp">MCP 토큰</TabsTrigger>
          <TabsTrigger value="skill">스킬 생성</TabsTrigger>
          {isAdmin && <TabsTrigger value="diag">연결·진단</TabsTrigger>}
          {isAdmin && <TabsTrigger value="jobs">작업 큐</TabsTrigger>}
          {isAdmin && <TabsTrigger value="access">AI 접근</TabsTrigger>}
          {isAdmin && <TabsTrigger value="tuning">검색 튜닝</TabsTrigger>}
          {isAdmin && <TabsTrigger value="eval">평가</TabsTrigger>}
        </TabsList>
        <TabsContent value="prompts" className="flex-1 min-h-0 mt-4">
          <PromptsTab />
        </TabsContent>
        <TabsContent value="mcp" className="flex-1 min-h-0 mt-4 overflow-y-auto">
          <McpTab />
        </TabsContent>
        <TabsContent value="skill" className="flex-1 min-h-0 mt-4 overflow-y-auto">
          <SkillTab />
        </TabsContent>
        {isAdmin && (
          <TabsContent value="diag" className="flex-1 min-h-0 mt-4 overflow-y-auto">
            <DiagnosticsTab />
          </TabsContent>
        )}
        {isAdmin && (
          <TabsContent value="jobs" className="flex-1 min-h-0 mt-4 overflow-y-auto">
            <JobsTab />
          </TabsContent>
        )}
        {isAdmin && (
          <TabsContent value="access" className="flex-1 min-h-0 mt-4 overflow-y-auto">
            <AccessTab />
          </TabsContent>
        )}
        {isAdmin && (
          <TabsContent value="tuning" className="flex-1 min-h-0 mt-4 overflow-y-auto">
            <SearchTuningTab />
          </TabsContent>
        )}
        {isAdmin && (
          <TabsContent value="eval" className="flex-1 min-h-0 mt-4 overflow-y-auto">
            <EvalTab />
          </TabsContent>
        )}
      </Tabs>
    </div>
  )
}
