'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { CheckCircle2, XCircle, Loader2, PlayCircle } from 'lucide-react'
import type { EvalReportUI, EvalTaskResultUI, SSEEvent } from './types'

interface EvalProgressState {
  running: boolean
  currentTask: string | null
  doneTasks: EvalTaskResultUI[]
  report: EvalReportUI | null
  error: string | null
}

export function EvalPanel() {
  const [state, setState] = useState<EvalProgressState>({
    running: false,
    currentTask: null,
    doneTasks: [],
    report: null,
    error: null,
  })

  const runEval = async () => {
    setState({ running: true, currentTask: null, doneTasks: [], report: null, error: null })
    try {
      const res = await fetch('/api/eval', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const reader = res.body?.getReader()
      if (!reader) throw new Error('无法建立流式连接')
      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const parts = buf.split('\n\n')
        buf = parts.pop() ?? ''
        for (const part of parts) {
          const line = part.trim()
          if (!line.startsWith('data:')) continue
          try {
            const ev = JSON.parse(line.slice(5).trim()) as SSEEvent & { type: string }
            if (ev.type === 'task_start') {
              setState((s) => ({ ...s, currentTask: ev.name ?? '' }))
            } else if (ev.type === 'task_done') {
              setState((s) => ({
                ...s,
                doneTasks: [...s.doneTasks, ev.result as EvalTaskResultUI],
                currentTask: null,
              }))
            } else if (ev.type === 'run_done') {
              setState((s) => ({ ...s, report: ev.report as EvalReportUI, running: false }))
            } else if (ev.type === 'error') {
              setState((s) => ({
                ...s,
                error: (ev as unknown as { message: string }).message,
                running: false,
              }))
            }
          } catch {
            // 忽略无法解析的分片
          }
        }
      }
    } catch (e) {
      setState((s) => ({ ...s, running: false, error: e instanceof Error ? e.message : String(e) }))
    }
  }

  const total = 4
  const progress = state.running ? Math.round(((state.doneTasks.length + (state.currentTask ? 1 : 0)) / total) * 100) : state.report ? 100 : 0

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          评测集：在全新沙箱上运行 Agent，断言文件内容与测试结果
        </p>
        <Button size="sm" onClick={runEval} disabled={state.running}>
          {state.running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlayCircle className="h-3.5 w-3.5" />}
          {state.running ? '评测中…' : '运行评测'}
        </Button>
      </div>

      {state.running && (
        <div className="space-y-1">
          <Progress value={progress} className="h-1.5" />
          <p className="text-[11px] text-muted-foreground">
            {state.currentTask ? `正在执行：${state.currentTask}` : '准备中…'}
          </p>
        </div>
      )}

      {state.error && (
        <p className="rounded bg-red-50 p-2 text-xs text-red-600">{state.error}</p>
      )}

      {state.report && (
        <div className="flex items-center gap-2">
          <Badge variant={state.report.passed === state.report.total ? 'default' : 'destructive'}>
            通过率 {state.report.passRate}
          </Badge>
          <span className="text-[11px] text-muted-foreground">
            {state.report.passed}/{state.report.total} · 用时 {(state.report.durationMs / 1000).toFixed(0)}s
          </span>
        </div>
      )}

      <div className="space-y-2 overflow-auto">
        {state.doneTasks.map((t) => (
          <TaskResultCard key={t.taskId} task={t} />
        ))}
      </div>
    </div>
  )
}

function TaskResultCard({ task }: { task: EvalTaskResultUI }) {
  return (
    <div className="rounded-md border p-2">
      <div className="mb-1 flex items-center gap-1.5">
        {task.passed ? (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
        ) : (
          <XCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />
        )}
        <span className="text-xs font-medium">{task.name}</span>
        {task.stats && (
          <span className="ml-auto font-mono text-[10px] text-muted-foreground">
            {task.stats.steps}步/{task.stats.toolCalls}次调用
          </span>
        )}
      </div>
      <ul className="space-y-0.5">
        {task.assertionResults.map((a, i) => (
          <li key={i} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className={a.passed ? 'text-emerald-600' : 'text-red-500'}>{a.passed ? '✓' : '✗'}</span>
            {a.name}
          </li>
        ))}
      </ul>
    </div>
  )
}
