'use client'

import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { ChevronRight, Terminal, CheckCircle2, XCircle, Loader2 } from 'lucide-react'
import type { UIToolCall } from './types'

const TOOL_LABELS: Record<string, string> = {
  list_files: '列出文件',
  read_file: '读取文件',
  write_file: '写入文件',
  search_code: '代码检索',
  run_command: '执行命令',
  run_tests: '运行测试',
  git_operation: 'Git 操作',
}

export function ToolCallCard({ tool }: { tool: UIToolCall }) {
  const [open, setOpen] = useState(false)
  const running = tool.status === 'running'
  const failed = tool.status === 'done' && tool.ok === false
  return (
    <Card className="border-dashed py-2 shadow-none">
      <button
        className="flex w-full items-center gap-2 px-3 text-left"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <ChevronRight
          className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`}
        />
        {running ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-500" />
        ) : failed ? (
          <XCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
        )}
        <Terminal className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium">{TOOL_LABELS[tool.name] ?? tool.name}</span>
        <Badge variant="secondary" className="h-4 px-1.5 font-mono text-[10px] text-muted-foreground">
          {summarizeArgs(tool.args)}
        </Badge>
      </button>
      {open && (
        <CardContent className="space-y-2 px-3 pb-1 pt-2">
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">参数</p>
            <pre className="max-h-40 overflow-auto rounded bg-muted p-2 font-mono text-[11px] leading-relaxed">
              {JSON.stringify(tool.args, null, 2)}
            </pre>
          </div>
          {tool.result !== undefined && (
            <div>
              <p className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">结果</p>
              <pre className="max-h-60 overflow-auto rounded bg-muted p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
                {tool.result}
              </pre>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  )
}

function summarizeArgs(args: unknown): string {
  try {
    const a = args as Record<string, unknown>
    if (typeof a.path === 'string') return a.path
    if (typeof a.query === 'string') return a.query
    if (Array.isArray(a.command)) return (a.command as string[]).join(' ').slice(0, 40)
    if (typeof a.action === 'string') return a.action
    return JSON.stringify(a).slice(0, 30)
  } catch {
    return ''
  }
}
