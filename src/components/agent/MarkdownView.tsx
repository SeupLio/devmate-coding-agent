'use client'

/**
 * 聊天消息 Markdown 渲染：
 *  - 标题 / 列表 / 引用 / 链接 / 表格（remark-gfm）
 *  - 代码块：Prism 语法高亮 + 语言标签 + 一键复制
 *  - 行内代码：弱底色样式
 *
 * 样式手写（prose 量级），不引入 @tailwindcss/typography，
 * 保证深浅色主题都跟随 design token（muted / foreground）。
 */
import { useCallback, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, Copy } from 'lucide-react'
import { PrismAsyncLight as SyntaxHighlighter } from 'react-syntax-highlighter/dist/esm/prism-async-light'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash'
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css'
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript'
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json'
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx'
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown'
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup'
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python'
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx'
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript'
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml'

// 按需注册常用语言，控制包体；未注册语言走 PlainText 兜底
SyntaxHighlighter.registerLanguage('javascript', javascript)
SyntaxHighlighter.registerLanguage('js', javascript)
SyntaxHighlighter.registerLanguage('typescript', typescript)
SyntaxHighlighter.registerLanguage('ts', typescript)
SyntaxHighlighter.registerLanguage('jsx', jsx)
SyntaxHighlighter.registerLanguage('tsx', tsx)
SyntaxHighlighter.registerLanguage('json', json)
SyntaxHighlighter.registerLanguage('bash', bash)
SyntaxHighlighter.registerLanguage('shell', bash)
SyntaxHighlighter.registerLanguage('sh', bash)
SyntaxHighlighter.registerLanguage('css', css)
SyntaxHighlighter.registerLanguage('html', markup)
SyntaxHighlighter.registerLanguage('xml', markup)
SyntaxHighlighter.registerLanguage('markdown', markdown)
SyntaxHighlighter.registerLanguage('md', markdown)
SyntaxHighlighter.registerLanguage('python', python)
SyntaxHighlighter.registerLanguage('py', python)
SyntaxHighlighter.registerLanguage('yaml', yaml)
SyntaxHighlighter.registerLanguage('yml', yaml)

/** 扩展名 → Prism 语言名（WorkspacePanel 与代码块共用） */
export function extToLanguage(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() ?? ''
  switch (ext) {
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript'
    case 'ts':
      return 'typescript'
    case 'jsx':
      return 'jsx'
    case 'tsx':
      return 'tsx'
    case 'json':
      return 'json'
    case 'css':
      return 'css'
    case 'scss':
      return 'css'
    case 'html':
    case 'svg':
    case 'vue':
      return 'markup'
    case 'md':
    case 'mdx':
      return 'markdown'
    case 'sh':
    case 'bash':
    case 'zsh':
      return 'bash'
    case 'py':
      return 'python'
    case 'yml':
    case 'yaml':
      return 'yaml'
    default:
      return 'text'
  }
}

const HL_LANGS = new Set([
  'javascript', 'js', 'typescript', 'ts', 'jsx', 'tsx', 'json', 'bash',
  'shell', 'sh', 'css', 'html', 'xml', 'markup', 'markdown', 'md',
  'python', 'py', 'yaml', 'yml', 'text',
])

export function CodeBlock({ code, language, filename }: { code: string; language: string; filename?: string }) {
  const [copied, setCopied] = useState(false)

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      /* 剪贴板不可用时静默 */
    }
  }, [code])

  const lang = HL_LANGS.has(language) ? language : 'text'

  return (
    <div className="group/code my-2 overflow-hidden rounded-md border border-black/10 dark:border-white/10">
      <div className="flex items-center justify-between border-b border-black/10 bg-zinc-100 px-2 py-1 dark:border-white/10 dark:bg-zinc-800">
        <span className="font-mono text-[10px] font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          {filename ?? lang}
        </span>
        <button
          type="button"
          onClick={onCopy}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-zinc-500 transition-colors hover:bg-zinc-200 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
          aria-label="复制代码"
        >
          {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      {lang === 'text' ? (
        <pre className="max-h-[420px] overflow-auto bg-zinc-900 p-2.5 font-mono text-[11.5px] leading-relaxed text-zinc-100">
          {code}
        </pre>
      ) : (
        <SyntaxHighlighter
          language={lang}
          style={oneDark}
          customStyle={{ margin: 0, borderRadius: 0, background: '#18181b', fontSize: '11.5px', lineHeight: 1.6 }}
          codeTagProps={{ style: { fontFamily: 'var(--font-geist-mono), ui-monospace, monospace' } }}
        >
          {code.replace(/\n$/, '')}
        </SyntaxHighlighter>
      )}
    </div>
  )
}

function extractText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (typeof node === 'object' && 'props' in (node as unknown as Record<string, unknown>)) {
    return extractText((node as unknown as { props: { children?: ReactNode } }).props.children)
  }
  return ''
}

export function MarkdownView({ text }: { text: string }) {
  return (
    <div className="text-[13px] leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children, ...rest }) => {
            const raw = extractText(children)
            const match = /language-(\w+)/.exec(className ?? '')
            // 无语言标注且不含换行 → 行内代码
            if (!match && !raw.includes('\n')) {
              return (
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px]" {...rest}>
                  {children}
                </code>
              )
            }
            return <CodeBlock code={raw} language={match?.[1] ?? 'text'} />
          },
          p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
          h1: ({ children }) => <h3 className="mb-1 mt-3 text-base font-bold first:mt-0">{children}</h3>,
          h2: ({ children }) => <h4 className="mb-1 mt-3 text-sm font-bold first:mt-0">{children}</h4>,
          h3: ({ children }) => <h5 className="mb-0.5 mt-2 text-[13px] font-semibold first:mt-0">{children}</h5>,
          h4: ({ children }) => <h6 className="mb-0.5 mt-2 text-[12.5px] font-semibold first:mt-0">{children}</h6>,
          ul: ({ children }) => <ul className="my-1.5 list-disc space-y-0.5 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-1.5 list-decimal space-y-0.5 pl-5">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer" className="text-sky-600 underline decoration-sky-300 underline-offset-2 hover:text-sky-500 dark:text-sky-400">
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-2 border-muted-foreground/30 pl-3 text-muted-foreground">{children}</blockquote>
          ),
          hr: () => <hr className="my-3 border-border" />,
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto">
              <table className="w-full border-collapse text-[12px]">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-muted/60">{children}</thead>,
          th: ({ children }) => <th className="border border-border px-2 py-1 text-left font-semibold">{children}</th>,
          td: ({ children }) => <td className="border border-border px-2 py-1">{children}</td>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
