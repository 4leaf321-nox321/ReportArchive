import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/shared/lib/utils'

/**
 * 안전한 마크다운 렌더러 — LLM 답변(질문하기·에이전트·RAG 요약 등)처럼 이미
 * 마크다운으로 오는 텍스트를 제목·굵게·목록·표(GFM)·코드로 렌더한다.
 *
 * 보안: 원시 HTML 은 렌더하지 않는다(react-markdown 기본값 + skipHtml). rehype-raw
 * 를 절대 붙이지 말 것 — LLM/외부 입력의 HTML 주입을 막기 위함. 링크는 새 탭 +
 * rel=noopener 로 연다.
 *
 * 스타일은 앱 디자인 토큰(text-foreground/muted, border, bg-muted)에 맞춰 요소별로
 * 매핑한다(typography 플러그인 비의존). `className` 으로 바깥 컨테이너를 조정.
 */

// react-markdown 이 각 컴포넌트에 넘기는 내부 `node` prop 은 DOM 으로 흘리면 React
// 경고가 나므로 제거한다(이름을 짓지 않아 no-unused-vars 도 피함).
function omitNode(props) {
  const rest = { ...props }
  delete rest.node
  return rest
}

const components = {
  p: (props) => <p {...omitNode(props)} className="my-2" />,
  h1: (props) => <h1 {...omitNode(props)} className="mb-1 mt-3 text-base font-semibold" />,
  h2: (props) => <h2 {...omitNode(props)} className="mb-1 mt-3 text-sm font-semibold" />,
  h3: (props) => (
    <h3 {...omitNode(props)} className="mb-1 mt-2 text-sm font-semibold text-foreground/90" />
  ),
  h4: (props) => <h4 {...omitNode(props)} className="mb-1 mt-2 text-sm font-medium" />,
  ul: (props) => <ul {...omitNode(props)} className="my-2 list-disc space-y-0.5 pl-5" />,
  ol: (props) => <ol {...omitNode(props)} className="my-2 list-decimal space-y-0.5 pl-5" />,
  li: (props) => <li {...omitNode(props)} className="leading-relaxed" />,
  a: (props) => (
    <a
      {...omitNode(props)}
      className="font-medium text-primary underline underline-offset-2 hover:opacity-80"
      target="_blank"
      rel="noopener noreferrer"
    />
  ),
  strong: (props) => <strong {...omitNode(props)} className="font-semibold text-foreground" />,
  em: (props) => <em {...omitNode(props)} className="italic" />,
  blockquote: (props) => (
    <blockquote
      {...omitNode(props)}
      className="my-2 border-l-2 border-border pl-3 text-muted-foreground"
    />
  ),
  hr: (props) => <hr {...omitNode(props)} className="my-3 border-border" />,
  code: (props) => {
    // 펜스 코드블록은 language-* 클래스를 가진다 → 블록 chrome 은 pre 가 담당하고
    // 여기선 폰트만. 인라인 코드(className 없음)는 배경칩으로.
    const { className, ...rest } = omitNode(props)
    const isBlock = /language-/.test(className || '')
    return (
      <code
        {...rest}
        className={
          isBlock
            ? cn('font-mono text-xs', className)
            : 'rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]'
        }
      />
    )
  },
  pre: (props) => (
    <pre
      {...omitNode(props)}
      className="my-2 overflow-x-auto rounded-md border bg-muted/50 p-3 text-xs"
    />
  ),
  // GFM 표 — 좁은 폭에서 가로 스크롤.
  table: (props) => (
    <div className="my-2 overflow-x-auto">
      <table {...omitNode(props)} className="w-full border-collapse text-xs" />
    </div>
  ),
  th: (props) => (
    <th
      {...omitNode(props)}
      className="border border-border bg-muted/50 px-2 py-1 text-left font-medium"
    />
  ),
  td: (props) => <td {...omitNode(props)} className="border border-border px-2 py-1 align-top" />,
}

export function Markdown({ children, className }) {
  return (
    <div
      className={cn(
        'break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components}>
        {typeof children === 'string' ? children : ''}
      </ReactMarkdown>
    </div>
  )
}
