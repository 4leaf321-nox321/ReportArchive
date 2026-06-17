import { useMemo } from 'react'
import { Package, Download, FileText, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/shared/components/ui/card'
import { Badge } from '@/shared/components/ui/badge'
import { Separator } from '@/shared/components/ui/separator'
import { copyTextToClipboard } from '@/shared/lib/clipboard'
import { makeZip } from '@/shared/lib/zip'
import {
  WIDGET_RULES_PREAMBLE,
  WIDGET_PROMPT_EXAMPLES,
  PROMPT_COVERED_WIDGETS,
} from '@/shared/ai/widgetExamples'

// 스킬 폴더 이름 — zip 내부 경로의 root 가 된다(Claude Desktop 은 폴더가
// root 에 있는 zip 을 요구). 소문자/숫자/하이픈, "claude"·"anthropic" 금지.
const SKILL_DIR = 'reportarchive-report'

// SKILL.md 본문. 보고서 편집기의 "AI 프롬프트"(promptSkeletons 의 new_report
// 골격)와 같은 출력 JSON 구조·작성 규칙·체크리스트를, 한 번 붙여넣는 프롬프트가
// 아니라 "스킬"로 쓰기 좋게 다듬은 버전. 휘발성이 큰 위젯 예시 데이터는 여기
// 박지 않고 references/widgets.md 로 분리해 항상 최신 소스에서 생성한다.
const SKILL_MD = `---
name: ${SKILL_DIR}
description: ReportArchive(사내 보고서 아카이브)에 가져올 수 있는 보고서 초안 JSON을 작성한다. 사용자가 자유 텍스트·메모·표·수치 등을 주며 "ReportArchive 보고서로 만들어줘", "이 내용을 보고서 JSON으로 정리해줘"라고 할 때 사용한다. 출력은 앱의 "JSON에서 불러오기"로 그대로 붙여넣을 수 있는 report_archive_draft_v1 형식이다.
---

# ReportArchive 보고서 작성기

당신은 ReportArchive 보고서 작성 도우미입니다. 사용자 입력(자유 텍스트, 메모, 표 등)을
분석해, 위젯들을 조합한 **JSON 한 덩어리**를 만들어 줍니다. 이 JSON은 사용자가 ReportArchive
앱의 \`로컬 → JSON에서 불러오기\`로 붙여넣어 보고서로 만듭니다.

## 출력 규칙 (가장 중요)

- 최종 산출물은 **유효한 JSON 하나**입니다. 사용자가 바로 복사해 쓸 수 있도록, 응답 본문에는
  그 JSON을 **코드블록(\`\`\`json … \`\`\`) 하나**로만 제시하세요. JSON 앞뒤에 짧은 한 줄 안내는
  괜찮지만, JSON 안에는 주석·설명을 넣지 마세요.
- JSON은 반드시 \`{\` 로 시작해 \`}\` 로 끝나야 합니다.
- top-level \`_type\` 키는 정확히 \`"report_archive_draft_v1"\` 여야 합니다. (underscore 그대로)
- 모르는 값은 지어내지 말고 생략하거나 빈 문자열 \`""\`로 두세요.

## 작성 흐름

1. 사용자 입력을 훑어 섹션 / 표 / 리스트 / 수치 / 추세 등을 식별합니다.
2. 각 조각을 어떤 위젯으로 표현할지 정합니다. (제목 → \`heading\`, 줄글 → \`rich_text\`,
   수치 카드 → \`key_value\`, 항목 나열 → \`bulleted_list\`, 표 → \`table\`, 시계열/추세 → \`chart\` 등)
3. 각 위젯 블록을 페이지의 \`extra_blocks\`에 \`{ id, type, props }\`로 선언하고, **같은 \`id\`**를 키로
   \`content\`에 데이터를 채웁니다. (블록 선언 ↔ 데이터 매핑이 1:1)
4. 위젯의 정확한 \`props\` / \`content\` 형식과 절대 규칙은 **반드시 \`references/widgets.md\`를 먼저
   읽고** 따르세요. 거기에 위젯별 예시와 교차 규칙(혼동 위젯 쌍, 키 이름 등)이 있습니다.
5. JSON을 출력합니다.

## 출력 JSON 전체 구조

\`pages\` 배열에 페이지를 1개 이상 만들고, 각 페이지 안에서 위젯 블록을 \`extra_blocks\`에 선언한 뒤
같은 \`id\`를 키로 \`content\`에 데이터를 넣습니다.

\`\`\`json
{
  "_type": "report_archive_draft_v1",
  "title": "<보고서 제목>",
  "report_date": "<YYYY-MM-DD>",
  "tags": [],
  "pages": [
    {
      "template_id": "TEMPLATE_ID_HERE",
      "template_version": 1,
      "name": null,
      "extra_blocks": [
        { "id": "<block_id_1>", "type": "<widget_type>", "props": { } },
        { "id": "<block_id_2>", "type": "<widget_type>", "props": { } }
      ],
      "content": {
        "<block_id_1>": { },
        "<block_id_2>": { }
      },
      "layout_overrides": null,
      "props_overrides": null,
      "blocks_order": [],
      "block_sections": {}
    }
  ]
}
\`\`\`

## 작성 규칙

1. \`block_id\`(= 블록의 \`id\`)는 정규식 \`^[a-z][a-z0-9_]{0,63}$\`를 만족해야 합니다. 영문 소문자로
   시작, 숫자·언더스코어 가능, **페이지 내에서 유일**.
2. 같은 \`id\`가 \`extra_blocks\`(블록 선언)와 \`content\`(데이터) **양쪽에** 존재해야 합니다.
3. \`props\`는 해당 위젯의 형식과 정확히 일치해야 하며, 형식에 없는 키를 추가하면 안 됩니다
   (\`additionalProperties: false\`). 위젯별 형식은 \`references/widgets.md\` 참조.
4. 주제가 길거나 분리되면 \`pages\`에 페이지를 더 추가해도 됩니다. 같은 \`template_id\` /
   \`template_version\`을 그대로 복사해 사용하세요.
5. \`layout_overrides\`, \`props_overrides\`, \`blocks_order\`는 비워두는 것이 안전합니다
   (\`null\` / \`[]\` 그대로).
6. \`image\` / \`attachment\` / \`cad_3d\` / \`html_embed\` / \`video\` 위젯은 시스템에 업로드된 파일을
   가리키는 \`file_id\`가 필요하므로 **절대 만들지 마세요.** 필요하다는 메모만 \`rich_text\`로 남기세요.

## template_id 에 대하여 (중요)

\`template_id\`는 ReportArchive **인스턴스(부서)마다 다른** 값입니다. 이 스킬만으로는 알 수 없습니다.

- 기본값으로 \`"TEMPLATE_ID_HERE"\`를 두고, JSON 위에 "불러온 뒤 이 페이지의 template_id를 실제
  템플릿 값으로 바꾸세요"라고 한 줄 안내하세요.
- 또는 사용자가 사용할 템플릿의 \`template_id\` / \`template_version\`을 알려주면 그 값으로 채우세요.
- 빈 템플릿으로 시작해 위젯을 \`extra_blocks\`로 직접 쌓는 방식이면 위 기본값 그대로도 동작합니다
  (불러온 뒤 앱에서 템플릿만 지정).

## block_sections (단락 구분) 에 대하여

\`block_sections\`는 \`{ "block_id": "item_code" }\` 맵으로, 각 블록이 어느 단락에 속하는지 표시하는
**선택** 메타데이터입니다. 유효한 \`item_code\` 목록 역시 인스턴스마다 다르게 등록돼 있어 이
스킬만으로는 알 수 없습니다.

- 기본은 **\`{}\` (빈 맵)** 으로 두세요. 임의의 code를 지어내면 거절됩니다.
- 사용자가 워크스페이스의 단락 코드 목록을 알려주는 경우에만, 그 \`code\` 문자열(한글 라벨 아님)을
  값으로 채우세요.

## 절대 하지 말 것 (체크리스트)

- \`bulleted_list\`의 items를 \`[{text, depth}, …]\` 객체 배열로 만들기 → 반드시 \`["문자열", …]\`
- \`key_value\`의 content를 \`{values: {…}}\`로 감싸기 → 키를 top-level에 그대로 펼치기
- \`milestone\`의 status에 \`planned\` / \`in_progress\` 사용 → \`pending\` / \`done\` / \`delayed\` 만 허용
- \`flowchart\`를 \`nodes\` / \`edges\` 그래프로 표현 → \`items: [{label, description?}]\` 순차 리스트만 지원
- \`image\` / \`attachment\` / \`cad_3d\` / \`html_embed\` / \`video\` 위젯 생성 → 불가능(file_id 필요).
  \`models\` / \`files\` 같은 다른 키로 우회도 금지.
- \`network\`에 \`links\` 키(sankey의 키) 쓰기 → network는 **\`edges\`**, sankey는 **\`links\`**
- \`radar\`의 series[] 안에 \`values\` / \`name\` 넣기 → series는 **\`label\`, \`color\`만**, values는
  **root의 2D 배열**
- \`quadrant\`에 \`points\` / \`items\` / \`dots\` 키 만들기 → mode에 따라 **\`bucket_items\` 또는
  \`plot_items\`만**
- \`comparison\` rows[]에 \`key\` 또는 \`kind\` 빠뜨리기 → 둘 다 **필수**
- \`mind_map\`에 \`orientation\` / \`direction\` / \`align\` 키 추가 → 좌우/방사 전환은 **\`layout\`**으로만
- \`network\` nodes[]에 \`id\` 빠뜨리기 → \`id\`는 **필수**(label과 별개)
- top-level \`_type\`을 \`*type\`처럼 출력 → underscore를 markdown italic으로 해석하지 마세요.
  정확히 \`"_type": "report_archive_draft_v1"\`.
- \`props\`에 위젯 형식에 없는 키 추가(\`additionalProperties: false\`)
- \`block_sections\` 값에 한글 라벨/카테고리 이름 넣기 → 반드시 \`code\` 문자열(없으면 그 항목 생략)

## 참고 파일

- **\`references/widgets.md\`** — 위젯별 \`props\` / \`content\` 예시 + 전역 규칙. JSON을 만들기 전에
  반드시 읽고, 사용할 위젯의 예시 형식을 그대로 따르세요.
`

/** references/widgets.md 본문을 현재 위젯 룰(단일 소스 authoring_rules.json)에서
 *  생성. 보고서 편집기의 "AI 프롬프트 복사"가 쓰는 데이터와 동일하므로 항상 최신. */
function buildWidgetsMd() {
  const examples = WIDGET_PROMPT_EXAMPLES.map((e) => e.body.trim()).join('\n\n')
  return [
    '# ReportArchive 위젯 작성 레퍼런스\n',
    '이 문서는 ReportArchive 보고서 JSON을 만들 때 각 위젯의 `props`/`content` 형식과 ' +
      '교차 규칙을 정리한 것입니다. `SKILL.md`의 지침과 함께 사용하세요.\n',
    '> 출처(단일 소스): 앱의 위젯 작성 규칙(`authoring_rules.json`). ' +
      'AI 설정 → 스킬 생성에서 다시 내보내면 최신 규칙으로 갱신됩니다.\n',
    '---\n',
    '## 전역 규칙 (모든 위젯 공통)\n',
    WIDGET_RULES_PREAMBLE.trim() + '\n',
    '---\n',
    '## 위젯별 props / content 예시\n',
    examples + '\n',
  ].join('\n')
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 일부 브라우저는 즉시 revoke 하면 다운로드가 취소되므로 한 박자 뒤에.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function SkillTab() {
  const widgetsMd = useMemo(() => buildWidgetsMd(), [])
  const widgetCount = PROMPT_COVERED_WIDGETS.size

  function handleDownloadZip() {
    try {
      const blob = makeZip([
        { name: `${SKILL_DIR}/SKILL.md`, data: SKILL_MD },
        { name: `${SKILL_DIR}/references/widgets.md`, data: widgetsMd },
      ])
      download(blob, `${SKILL_DIR}.zip`)
      toast.success('스킬 zip 을 내려받았습니다.', {
        description: 'Claude Desktop → Skills → Create skill 에서 업로드하세요.',
      })
    } catch (e) {
      toast.error('zip 생성 실패', { description: String(e?.message ?? e) })
    }
  }

  async function copy(text, label) {
    try {
      await copyTextToClipboard(text)
      toast.success(`${label} 복사됨`)
    } catch {
      toast.error('클립보드 복사에 실패했습니다.')
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Package className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-base">스킬 생성 (Claude Desktop)</CardTitle>
        </div>
        <CardDescription>
          ReportArchive 보고서 작성 규칙·위젯 예시를 <b>Claude 스킬(.zip)</b> 으로 내보냅니다.
          Claude Desktop/claude.ai 에 한 번 업로드해 두면, 매번 긴 프롬프트를 붙여넣지 않고도
          “이 내용 ReportArchive 보고서로 만들어줘” 한마디로 보고서 JSON 을 받을 수 있어요.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 내보내기 */}
        <div className="rounded-md border bg-muted/30 p-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" onClick={handleDownloadZip}>
              <Download className="mr-1.5 h-3.5 w-3.5" />
              스킬 zip 내려받기
            </Button>
            <Badge variant="outline" className="font-mono text-[10px]">
              {SKILL_DIR}.zip
            </Badge>
            <span className="text-xs text-muted-foreground">
              현재 위젯 {widgetCount}종 규칙 포함 · 항상 최신 규칙으로 생성
            </span>
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => copy(SKILL_MD, 'SKILL.md')}
            >
              <Copy className="mr-1.5 h-3.5 w-3.5" />
              SKILL.md 복사
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => copy(widgetsMd, 'widgets.md')}
            >
              <Copy className="mr-1.5 h-3.5 w-3.5" />
              widgets.md 복사
            </Button>
          </div>
        </div>

        <Separator />

        {/* 업로드 방법 */}
        <div className="space-y-2 text-sm">
          <div className="flex items-center gap-1.5 font-medium">
            <FileText className="h-3.5 w-3.5 text-muted-foreground" />
            Claude Desktop 에 올리는 법
          </div>
          <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
            <li>
              위 <b>「스킬 zip 내려받기」</b> 로 <code className="font-mono">{SKILL_DIR}.zip</code> 저장.
            </li>
            <li>
              Claude Desktop → <b>Customize → Skills → ＋ → Create skill</b> 에서 그 zip 업로드 후
              목록에서 활성화.
            </li>
            <li>
              채팅에서 <b>“이 내용 ReportArchive 보고서로 만들어줘”</b> → Claude 가 보고서 JSON 출력.
            </li>
            <li>
              그 JSON 을 보고서 편집기의 <b>로컬 → JSON에서 불러오기</b> 로 붙여넣기.
            </li>
          </ol>
          <p className="text-[11px] text-muted-foreground">
            ※ 전제: Pro/Max/Team/Enterprise 플랜 + 설정의 <b>Code execution</b> 켜짐. (claude.ai 웹도
            Settings → Skills 에서 동일하게 zip 업로드)
          </p>
          <p className="text-[11px] text-muted-foreground">
            ※ <b>Codex CLI · Claude Code</b> 는 업로드 대신 zip 을 풀어 폴더째 넣습니다 —
            <code className="font-mono">~/.codex/skills/{SKILL_DIR}/</code> 또는{' '}
            <code className="font-mono">~/.claude/skills/{SKILL_DIR}/</code> (같은 SKILL.md 표준이라 변환 불필요).
          </p>
        </div>

        <Separator />

        {/* 한계 안내 */}
        <div className="space-y-1.5 text-xs text-muted-foreground">
          <p>
            <b>알아두기</b> — 이 스킬은 보고서 <b>JSON 을 생성</b>해 주고, 그 JSON 을 사람이 앱에
            불러오는 방식입니다(오프라인). 스킬 샌드박스에서는 MCP 도구를 직접 호출할 수 없어서,
            Claude 가 앱에 <b>바로 작성</b>하게 하려면 「MCP 토큰」 탭의 연동을 쓰세요(둘은 상호보완).
          </p>
          <p>
            <code className="font-mono">template_id</code> 와 단락 코드(
            <code className="font-mono">block_sections</code>)는 부서마다 달라 스킬에 담기지 않습니다.
            불러온 뒤 앱에서 템플릿을 지정하면 됩니다.
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
