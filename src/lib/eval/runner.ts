/**
 * 评测执行器：在独立沙箱上逐任务运行 Agent，校验断言，输出通过率报告。
 *
 * 支持传入「运行配置」（AgentRunConfig），用于对照实验（ablation）：
 * 同一批任务在不同配置下跑，比较通过率与资源消耗的差异。
 */
import { runAgent, type AgentStats } from '@/lib/agent/loop'
import { createWorkspace, newRunId, HOLDOUT_TEMPLATE_DIR } from '@/lib/agent/workspace'
import { ALL_TASKS, EVAL_TASKS, HOLDOUT_TASKS, type EvalTask, type EvalTaskResult } from './tasks'

/** Agent 运行配置 —— 对照实验的自变量 */
export interface AgentRunConfig {
  id: string
  label: string
  /** 参与编排的工具名；undefined = 全部 7 个，[] = 无工具 */
  toolFilter?: string[]
  /** 是否生成任务规划 */
  plan?: boolean
  /** 是否启用上下文压缩 */
  useCompression?: boolean
  /** 配置说明（写进报告） */
  note?: string
}

export const DEFAULT_CONFIG: AgentRunConfig = { id: 'full', label: '完整配置' }

export interface EvalRunResult {
  runId: string
  startedAt: string
  durationMs: number
  total: number
  passed: number
  passRate: string
  /** 平均步数 / 平均工具调用 / 平均耗时 */
  avgSteps: number
  avgToolCalls: number
  avgDurationMs: number
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

export interface RunEvaluationOptions {
  taskIds?: string[]
  /** 只用 held-out 集 / 只用常规集 */
  only?: 'default' | 'holdout' | 'all'
  config?: AgentRunConfig
  /** 每个任务重复次数（用于观察 LLM 随机性带来的方差） */
  repeat?: number
  maxSteps?: number
}

function selectTasks(opts: RunEvaluationOptions): EvalTask[] {
  // 显式指定任务 ID 时以 ID 为准（可跨常规集与 held-out 集）
  if (opts.taskIds?.length) return ALL_TASKS.filter((t) => opts.taskIds!.includes(t.id))
  if (opts.only === 'holdout') return HOLDOUT_TASKS
  if (opts.only === 'default') return EVAL_TASKS
  return ALL_TASKS
}

export async function* runEvaluation(opts: RunEvaluationOptions = {}): AsyncGenerator<EvalProgress> {
  const config = opts.config ?? DEFAULT_CONFIG
  const repeat = Math.max(1, opts.repeat ?? 1)
  const runId = newRunId()
  const t0 = Date.now()
  const tasks = selectTasks(opts)
  const results: (EvalTaskResult & { stats?: AgentStats })[] = []

  for (let round = 1; round <= repeat; round++) {
    for (const task of tasks) {
      const sessionId = `eval-${runId}-${task.id}-r${round}`
      const name = repeat > 1 ? `${task.name}（第 ${round}/${repeat} 轮）` : task.name
      yield { type: 'task_start', taskId: task.id, name }
      // 任务间隔：降低限流风险
      await new Promise((r) => setTimeout(r, 2000))
      // 全新沙箱（按任务指定的模板）
      createWorkspace(sessionId, task.template === 'holdout' ? HOLDOUT_TEMPLATE_DIR : undefined)

      let stats: AgentStats | undefined
      let agentError: string | null = null
      try {
        for await (const ev of runAgent({
          sessionId,
          task: task.prompt,
          maxSteps: opts.maxSteps ?? 12,
          plan: config.plan,
          toolFilter: config.toolFilter,
          useCompression: config.useCompression,
        })) {
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
        name,
        passed,
        assertionResults,
        stats,
      }
      if (agentError) {
        // Agent 执行中断（如 API 限流）：若所有断言均已通过，
        // 说明任务产物已正确落地，仅记录告警而不判失败。
        const allPassed = assertionResults.every((a) => a.passed)
        if (!allPassed) {
          result.assertionResults.push({ name: `Agent 异常：${agentError}`, passed: false })
          result.passed = false
        } else {
          result.assertionResults.push({
            name: `告警：总结阶段中断（${agentError.slice(0, 60)}），但任务产物已通过全部断言`,
            passed: true,
          })
        }
      }
      results.push(result)
      yield { type: 'task_done', result }
    }
  }

  const passed = results.filter((r) => r.passed).length
  const withStats = results.filter((r) => r.stats)
  const avg = (f: (s: AgentStats) => number) =>
    withStats.length ? withStats.reduce((a, r) => a + f(r.stats!), 0) / withStats.length : 0
  const report: EvalRunResult = {
    runId,
    startedAt: new Date(t0).toISOString(),
    durationMs: Date.now() - t0,
    total: results.length,
    passed,
    passRate: results.length ? `${((passed / results.length) * 100).toFixed(0)}%` : '0%',
    avgSteps: Number(avg((s) => s.steps).toFixed(1)),
    avgToolCalls: Number(avg((s) => s.toolCalls).toFixed(1)),
    avgDurationMs: Math.round(avg((s) => s.durationMs)),
    results,
  }
  yield { type: 'run_done', report }
}
