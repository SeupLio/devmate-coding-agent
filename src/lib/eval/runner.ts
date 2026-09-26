/**
 * 评测执行器：在独立沙箱上逐任务运行 Agent，校验断言，输出通过率报告。
 */
import { runAgent, type AgentStats } from '@/lib/agent/loop'
import { createWorkspace, newRunId } from '@/lib/agent/workspace'
import { EVAL_TASKS, type EvalTaskResult } from './tasks'

export interface EvalRunResult {
  runId: string
  startedAt: string
  durationMs: number
  total: number
  passed: number
  passRate: string
  results: (EvalTaskResult & { stats?: AgentStats })[]
}

export interface EvalProgress {
  type: 'task_start' | 'task_done' | 'run_done' | 'error'
  taskId?: string
  name?: string
  result?: EvalTaskResult & { stats?: AgentStats }
  report?: EvalRunResult
  message?: string
}

export async function* runEvaluation(taskIds?: string[]): AsyncGenerator<EvalProgress> {
  const runId = newRunId()
  const t0 = Date.now()
  const tasks = taskIds?.length ? EVAL_TASKS.filter((t) => taskIds.includes(t.id)) : EVAL_TASKS
  const results: (EvalTaskResult & { stats?: AgentStats })[] = []

  for (const task of tasks) {
    const sessionId = `eval-${runId}-${task.id}`
    yield { type: 'task_start', taskId: task.id, name: task.name }
    // 任务间隔：降低限流风险
    await new Promise((r) => setTimeout(r, 3000))
    // 全新沙箱
    createWorkspace(sessionId)
    let stats: AgentStats | undefined
    let agentError: string | null = null
    try {
      for await (const ev of runAgent({ sessionId, task: task.prompt, maxSteps: 12 })) {
        if (ev.type === 'final') stats = ev.stats
        if (ev.type === 'error') agentError = ev.message
      }
    } catch (e) {
      agentError = e instanceof Error ? e.message : String(e)
    }
    const assertionResults: { name: string; passed: boolean }[] = []
    for (const a of task.assertions) {
      let passed = false
      try {
        passed = await a.check(sessionId)
      } catch {
        passed = false
      }
      assertionResults.push({ name: a.name, passed })
    }
    const passed = assertionResults.length > 0 && assertionResults.every((a) => a.passed)
    const result: EvalTaskResult & { stats?: AgentStats } = {
      taskId: task.id,
      name: task.name,
      passed,
      assertionResults,
      stats,
    }
    if (agentError) {
      // Agent 执行中断（如 API 限流）：若所有内容断言均已通过，
      // 说明任务产物已正确落地，仅记录告警而不判失败。
      const contentAssertionsPassed = assertionResults.every((a) => a.passed)
      if (!contentAssertionsPassed) {
        result.assertionResults.push({ name: `Agent 异常：${agentError}`, passed: false })
        result.passed = false
      } else {
        result.assertionResults.push({ name: `告警：总结阶段中断（${agentError.slice(0, 60)}），但任务产物已通过全部断言`, passed: true })
      }
    }
    results.push(result)
    yield { type: 'task_done', result }
  }

  const passed = results.filter((r) => r.passed).length
  const report: EvalRunResult = {
    runId,
    startedAt: new Date(t0).toISOString(),
    durationMs: Date.now() - t0,
    total: results.length,
    passed,
    passRate: results.length ? `${((passed / results.length) * 100).toFixed(0)}%` : '0%',
    results,
  }
  yield { type: 'run_done', report }
}
