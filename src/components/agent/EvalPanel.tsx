'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { CheckCircle2, XCircle, Loader2, PlayCircle } from 'lucide-react'
import type { EvalReportUI, EvalSSEEvent, EvalTaskResultUI } from './types'

interface EvalProgressState {
  running: boolean
  currentTask: string | null
  plannedTotal: number
  doneTasks: EvalTaskResultUI[]
  report: EvalReportUI | null
  error: string | null
}

const SCOPES: { id: 'default' | 'holdout' | 'hard' | 'all'; label: string }[] = [
  { id: 'default', label: '常规' },
  { id: 'holdout', label: 'held-out' },
  { id: 'hard', label: '难任务' },
  { id: 'all', label: '全部' },
]

export function EvalPanel() {
  const [scope, setScope] = useState<'default' | 'holdout' | 'hard' | 'all'>('default')
  const [state, setState] = useState<EvalProgressState>({
    running: false,
    currentTask: null,
    plannedTotal: 0,
    doneTasks: [],
    report: null,
    error: null,
  })

  const runEval = async () => {
    setState({ running: true, currentTask: null, plannedTotal: 0, doneTasks: [], report: null, error: null })
    try {
      const res = await fetch('/api/eval', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ only: scope }),
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
            const ev = JSON.parse(line.slice(5).trim()) as EvalSSEEvent
            if (ev.type === 'run_start') {
              setState((s) => ({ ...s, plannedTotal: ev.total }))
            } else if (ev.type === 'task_start') {
              setState((s) => ({ ...s, currentTask: ev.name ?? '' }))
            } else if (ev.type === 'task_done') {
              setState((s) => ({
                ...s,
                doneTasks: [...s.doneTasks, ev.result],
                currentTask: null,
              }))
            } else if (ev.type === 'run_done') {
              setState((s) => ({ ...s, report: ev.report, running: false }))
            } else if (ev.type === 'error') {
              setState((s) => ({ ...s, error: ev.message, running: false }))
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

  const total = state.plannedTotal || state.report?.total || 1
  const progress = state.running
    ? Math.min(99, Math.round((state.doneTasks.length / total) * 100))
    : state.report
      ? 100
      : 0

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1">
          {SCOPES.map((s) => (
            <Button
              key={s.id}
              size="sm"
              variant={scope === s.id ? 'default' : 'outline'}
              className="h-6 px-2 text-[11px]"
              onClick={() => setScope(s.id)}
              disabled={state.running}
            >
              {s.label}
            </Button>
          ))}
        </div>
        <Button size="sm" onClick={runEval} disabled={state.running}>
          {state.running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlayCircle className="h-3.5 w-3.5" />}
          {state.running ? '评测中…' : '运行评测'}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        评测集：在全新沙箱上运行 Agent，断言文件内容与测试结果；失败会给出「失败模式」归因
      </p>

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
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Badge variant={state.report.passed === state.report.total ? 'default' : 'destructive'}>
              通过率 {state.report.passRate}
            </Badge>
            <span className="text-[11px] text-muted-foreground">
              {state.report.passed}/{state.report.total} · 用时 {(state.report.durationMs / 1000).toFixed(0)}s
            </span>
          </div>
          {state.report.failureSummary && state.report.failureSummary.byMode.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {state.report.failureSummary.byMode.map((m) => (
                <Badge key={m.mode} variant="outline" className="text-[10px]">
                  {m.label} × {m.count}
                </Badge>
              ))}
            </div>
          )}
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
      {!task.passed && task.diagnosis && (
        <p className="mt-1 rounded bg-amber-50 p-1.5 text-[10px] text-amber-700">
          失败模式：{task.diagnosis.label}
          {task.diagnosis.evidence.length > 0 && `（${task.diagnosis.evidence[0]}）`}
        </p>
      )}
    </div>
  )
}
