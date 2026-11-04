'use client'

/**
 * 工具调用卡片 —— Agent「做了什么」的一手呈现。
 *
 * 设计要点（对标 Claude Code 的工具展示）：
 *  1. 全部 18 个内置工具 + MCP 工具都有中文标签、语义图标、主参数摘要 —— 用户扫一眼就知道在干什么；
 *  2. edit_file / multi_edit / write_file 直接渲染红绿 diff —— coding agent 的核心 UX 是「看到它改了哪行」；
 *  3. run_command / run_tests 用终端样式渲染；git diff 结果按 +/- 行着色；
 *  4. 失败的工具自动展开，省一次点击；
 *  5. 展示工具耗时（来自后端 tool_result.durationMs）。
 */
import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import {
  BookOpen, Bot, Braces, CheckCircle2, ChevronRight, FilePenLine, FilePlus,
  FileSearch, FileStack, FileText, FlaskConical, FolderTree, GitBranch,
  GitPullRequest, ListTodo, Loader2, Presentation, Search, SearchCode,
  Sparkles, Terminal, Wrench, XCircle, type LucideIcon,
} from 'lucide-react'
import type { UIToolCall } from './types'

interface ToolMeta {
  label: string
  icon: LucideIcon
  /** 图标底色语义：文件=蓝、编辑=绿、检索=紫、执行=琥珀、git=玫瑰、产出=青 */
  tone: 'file' | 'edit' | 'search' | 'exec' | 'git' | 'output' | 'meta'
}

const TOOL_META: Record<string, ToolMeta> = {
  list_files: { label: '列出文件', icon: FolderTree, tone: 'file' },
  read_file: { label: '读取文件', icon: FileText, tone: 'file' },
  write_file: { label: '写入文件', icon: FilePlus, tone: 'edit' },
  edit_file: { label: '精确编辑', icon: FilePenLine, tone: 'edit' },
  multi_edit: { label: '批量编辑', icon: FileStack, tone: 'edit' },
  search_code: { label: '代码检索', icon: Search, tone: 'search' },
  grep: { label: '正则检索', icon: SearchCode, tone: 'search' },
  glob: { label: '文件匹配', icon: FileSearch, tone: 'search' },
  search_ast: { label: 'AST 检索', icon: Braces, tone: 'search' },
  search_semantic: { label: '语义检索', icon: Sparkles, tone: 'search' },
  search_knowledge: { label: '知识库检索', icon: BookOpen, tone: 'search' },
  run_command: { label: '执行命令', icon: Terminal, tone: 'exec' },
  run_tests: { label: '运行测试', icon: FlaskConical, tone: 'exec' },
  git_operation: { label: 'Git 操作', icon: GitBranch, tone: 'git' },
  review_diff: { label: '代码评审', icon: GitPullRequest, tone: 'git' },
  todo_write: { label: '任务清单', icon: ListTodo, tone: 'meta' },
  task: { label: '子 Agent', icon: Bot, tone: 'meta' },
  generate_docx: { label: '生成文档', icon: FileText, tone: 'output' },
  generate_pptx: { label: '生成演示', icon: Presentation, tone: 'output' },
}

const TONE_CLASSES: Record<ToolMeta['tone'], string> = {
  file: 'bg-sky-100 text-sky-600 dark:bg-sky-950 dark:text-sky-400',
  edit: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400',
  search: 'bg-violet-100 text-violet-600 dark:bg-violet-950 dark:text-violet-400',
  exec: 'bg-amber-100 text-amber-600 dark:bg-amber-950 dark:text-amber-400',
  git: 'bg-rose-100 text-rose-600 dark:bg-rose-950 dark:text-rose-400',
  output: 'bg-cyan-100 text-cyan-600 dark:bg-cyan-950 dark:text-cyan-400',
  meta: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
}

/** MCP 工具名形如 mcp__<server>__<tool>，展示为「MCP · server」 */
function metaFor(name: string): ToolMeta {
  const direct = TOOL_META[name]
  if (direct) return direct
  if (name.startsWith('mcp__')) {
    const server = name.split('__')[1] ?? 'mcp'
    return { label: `MCP · ${server}`, icon: Wrench, tone: 'search' }
  }
  return { label: name, icon: Wrench, tone: 'meta' }
}

function formatDuration(ms?: number): string | null {
  if (ms == null) return null
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** 工具主参数摘要：路径 / 查询词 / 命令 / git 动作等 */
function summarizeArgs(name: string, args: unknown): string {
  try {
    const a = (args ?? {}) as Record<string, unknown>
    if (name === 'git_operation') {
      const action = typeof a.action === 'string' ? a.action : ''
      const detail = typeof a.args === 'string' ? ` ${a.args}` : ''
      return action + detail
    }
    if (typeof a.path === 'string') return a.path
    if (typeof a.query === 'string') return a.query
    if (typeof a.pattern === 'string') return a.pattern
    if (typeof a.glob === 'string') return a.glob
    if (typeof a.regex === 'string') return a.regex
    if (typeof a.description === 'string') return a.description.slice(0, 60)
    if (Array.isArray(a.command)) return (a.command as string[]).join(' ').slice(0, 60)
    if (typeof a.action === 'string') return a.action
    return JSON.stringify(a).slice(0, 40)
  } catch {
    return ''
  }
}

export function ToolCallCard({ tool }: { tool: UIToolCall }) {
  /** 用户是否手动切换过展开状态；null = 未操作（此时失败自动展开） */
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const running = tool.status === 'running'
  const failed = tool.status === 'done' && tool.ok === false
  const meta = metaFor(tool.name)
  const Icon = meta.icon
  const duration = formatDuration(tool.durationMs)
  /** 失败的调用默认展开（错误原因不需要用户再点一次）；用户点过则以用户操作为准 */
  const open = userOpen ?? failed
  const toggle = () => setUserOpen(!(userOpen ?? failed))

  const subject = summarizeArgs(tool.name, tool.args)
  const isTerminal = tool.name === 'run_command' || tool.name === 'run_tests'
  const isGitDiff = tool.name === 'git_operation' && (tool.args as { action?: string })?.action === 'diff'

  return (
    <Card className="border-dashed py-2 shadow-none">
      <button
        className="flex w-full items-center gap-2 px-3 text-left"
        onClick={toggle}
        aria-expanded={open}
      >
        <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded ${TONE_CLASSES[meta.tone]}`}>
          <Icon className="h-3 w-3" />
        </span>
        <span className="shrink-0 text-xs font-medium">{meta.label}</span>
        {subject && (
          <span className="truncate font-mono text-[11px] text-muted-foreground">{subject}</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {duration && !running && (
            <span className="font-mono text-[10px] text-muted-foreground/70">{duration}</span>
          )}
          {running ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-500" aria-label="执行中" />
          ) : failed ? (
            <XCircle className="h-3.5 w-3.5 text-red-500" aria-label="失败" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" aria-label="成功" />
          )}
          <ChevronRight
            className={`h-3.5 w-3.5 text-muted-foreground/50 transition-transform ${open ? 'rotate-90' : ''}`}
          />
        </span>
      </button>

      {open && (
        <CardContent className="space-y-1.5 pt-2">
          <ToolBody tool={tool} isTerminal={isTerminal} isGitDiff={isGitDiff} />
          {tool.result !== undefined && (
            <div>
              <p className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">
                {isGitDiff ? 'Diff' : '结果'}
              </p>
              {isGitDiff ? (
                <DiffText text={tool.result} />
              ) : isTerminal ? (
                <pre className="max-h-60 overflow-auto rounded-md border border-black/10 bg-zinc-950 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-zinc-200 dark:border-white/10">
                  {tool.result}
                </pre>
              ) : (
                <pre className="max-h-60 overflow-auto rounded bg-muted p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
                  {tool.result}
                </pre>
              )}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  )
}

/** 参数区：编辑类工具渲染 diff，其余显示原始 JSON */
function ToolBody({ tool, isTerminal, isGitDiff }: { tool: UIToolCall; isTerminal: boolean; isGitDiff: boolean }) {
  if (isTerminal || isGitDiff) {
    // 命令 / diff 的参数在摘要里已可见，正文直接看结果即可
    return (
      <details className="group">
        <summary className="cursor-pointer select-none text-[10px] font-semibold uppercase text-muted-foreground/60 hover:text-muted-foreground">
          参数
        </summary>
        <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
          {JSON.stringify(tool.args, null, 2)}
        </pre>
      </details>
    )
  }

  const a = (tool.args ?? {}) as Record<string, unknown>

  if (tool.name === 'edit_file' && typeof a.old_string === 'string' && typeof a.new_string === 'string') {
    return <DiffView oldText={a.old_string} newText={a.new_string} path={String(a.path ?? '')} />
  }

  if (tool.name === 'multi_edit' && Array.isArray(a.edits)) {
    return (
      <div className="space-y-2">
        {(a.edits as { old_string?: string; new_string?: string }[]).map((e, i) => (
          <DiffView key={i} oldText={e.old_string ?? ''} newText={e.new_string ?? ''} path={String(a.path ?? '')} index={i + 1} />
        ))}
      </div>
    )
  }

  if (tool.name === 'write_file' && typeof a.content === 'string') {
    return <DiffView oldText="" newText={a.content} path={String(a.path ?? '')} write />
  }

  return (
    <div>
      <p className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">参数</p>
      <pre className="max-h-40 overflow-auto rounded bg-muted p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
        {JSON.stringify(tool.args, null, 2)}
      </pre>
    </div>
  )
}

/** 精确编辑的 diff 视图：- 为删除行（红），+ 为新增行（绿） */
function DiffView({
  oldText,
  newText,
  path,
  index,
  write,
}: {
  oldText: string
  newText: string
  path: string
  index?: number
  write?: boolean
}) {
  const oldLines = oldText ? oldText.split('\n') : []
  const newLines = newText ? newText.split('\n') : []
  // 超长内容截断展示（write_file 整文件写入可能上千行）
  const LIMIT = 60
  const truncated = oldLines.length + newLines.length > LIMIT

  return (
    <div className="overflow-hidden rounded-md border border-black/10 dark:border-white/10">
      <div className="flex items-center justify-between bg-muted/60 px-2 py-1">
        <span className="truncate font-mono text-[10px] text-muted-foreground">
          {path || '(文件)'} {index != null && <span className="text-muted-foreground/60">· #{index}</span>}
        </span>
        <Badge variant="secondary" className="h-4 rounded px-1 text-[9px]">
          {write ? `+${newLines.length} 行` : `-${oldLines.length} / +${newLines.length}`}
        </Badge>
      </div>
      <div className="max-h-72 overflow-auto font-mono text-[11px] leading-[1.5]">
        {oldLines.slice(0, LIMIT).map((line, i) => (
          <div key={`o${i}`} className="flex bg-red-50 px-2 dark:bg-red-950/40">
            <span className="w-3 shrink-0 select-none text-red-400">-</span>
            <span className="whitespace-pre-wrap break-all text-red-700 dark:text-red-300">{line || ' '}</span>
          </div>
        ))}
        {newLines.slice(0, LIMIT).map((line, i) => (
          <div key={`n${i}`} className="flex bg-emerald-50 px-2 dark:bg-emerald-950/40">
            <span className="w-3 shrink-0 select-none text-emerald-400">+</span>
            <span className="whitespace-pre-wrap break-all text-emerald-700 dark:text-emerald-300">{line || ' '}</span>
          </div>
        ))}
        {truncated && (
          <div className="bg-muted/40 px-2 py-1 text-[10px] text-muted-foreground">
            ⋯ 内容过长已截断，完整内容见结果或工作区文件
          </div>
        )}
      </div>
    </div>
  )
}

/** git diff 结果着色：+/- 行红绿、@@ 行高亮 */
export function DiffText({ text }: { text: string }) {
  const lines = text.split('\n')
  return (
    <pre className="max-h-72 overflow-auto rounded-md border border-black/10 bg-zinc-950 p-2 font-mono text-[11px] leading-[1.5] whitespace-pre dark:border-white/10">
      {lines.slice(0, 300).map((line, i) => {
        let cls = 'text-zinc-400'
        if (line.startsWith('+')) cls = 'text-emerald-400'
        else if (line.startsWith('-')) cls = 'text-red-400'
        else if (line.startsWith('@@')) cls = 'text-sky-400'
        else if (line.startsWith('diff ') || line.startsWith('index ')) cls = 'text-zinc-500'
        return (
          <div key={i} className={cls}>
            {line || ' '}
          </div>
        )
      })}
      {lines.length > 300 && <div className="text-zinc-600">⋯ 已截断（{lines.length} 行）</div>}
    </pre>
  )
}
