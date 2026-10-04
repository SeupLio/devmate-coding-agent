/**
 * 失败模式分类（failure mode classification）。
 *
 * 目的：把「任务没通过」从一句 0/1 的结论，升级为**可归因、可统计、可迭代**的诊断。
 * 通过率只告诉你「差多少」，失败模式才告诉你「差在哪」——是模型能力不足、
 * 还是评测本身有坑，还是 Agent 流程缺失（比如从不自我验证）。
 *
 * 信号来源：Agent 事件流（工具调用/结果、是否跑测试、是否改文件、是否超步数、是否 API 异常）
 *          + 任务的断言结果（哪条断言挂了）。
 *
 * 分类按「信息量最大」优先：作弊 > 基础设施异常 > 超步数 > 未改动 > 未验证 >
 * 测试仍失败 > 工具报错 > 其他断言不符。
 */
import type { AgentEvent, AgentStats } from '@/lib/agent/loop'

export type FailureMode =
  | 'passed'
  | 'api_error'
  | 'cheated'
  | 'max_steps'
  | 'no_edit'
  | 'not_verified'
  | 'tests_still_failing'
  | 'tool_error'
  | 'assertion_mismatch'
  | 'unknown'

export interface RunSignals {
  finished: boolean
  steps: number
  maxSteps: number
  toolCalls: { name: string; ok: boolean }[]
  /** 被 write_file 写过的文件（相对路径） */
  editedFiles: string[]
  ranTests: boolean
  /** 运行测试且失败的次数 */
  testRunFailures: number
  apiError: string | null
}

export interface FailureDiagnosis {
  mode: FailureMode
  label: string
  /** 支撑该判定的证据（原始信号） */
  evidence: string[]
  /** 针对该模式的改进建议 */
  suggestion: string
}

const MODE_META: Record<FailureMode, { label: string; suggestion: string }> = {
  passed: { label: '通过', suggestion: '无需处理。' },
  api_error: {
    label: '模型/接口异常',
    suggestion: '属基础设施问题，非 Agent 能力问题；重跑或检查网关限流。',
  },
  cheated: {
    label: '改测试/伪造产物（作弊）',
    suggestion: 'Agent 绕过了真正的修复；需加强防作弊断言或在提示中明确禁止改测试。',
  },
  max_steps: {
    label: '超出步数上限',
    suggestion: '任务链路过长或 Agent 打转；可提高 maxSteps、改进规划或提供更强检索。',
  },
  no_edit: {
    label: '未产出任何文件改动',
    suggestion: 'Agent 未真正动手；检查是否误解任务、工具选择错误或提前收尾。',
  },
  not_verified: {
    label: '未运行验证',
    suggestion: '改完不跑测试＝盲改；应强制「改动后必须自验证」的流程。',
  },
  tests_still_failing: {
    label: '测试仍然失败',
    suggestion: 'Agent 修了但没修对；属能力/上下文问题，可加大检索或拆细任务。',
  },
  tool_error: {
    label: '工具执行报错',
    suggestion: '工具参数或环境有问题（如路径错、命令不在白名单）；检查工具调用日志。',
  },
  assertion_mismatch: {
    label: '断言不符（非测试类）',
    suggestion: '产物不符合预期但测试通过；检查是否改错了目标文件或遗漏要求。',
  },
  unknown: { label: '未分类', suggestion: '补充信号采集。' },
}

/** 从 Agent 事件流采集失败诊断所需的信号 */
/** 会改动文件内容的工具（edit_file / multi_edit 是现在的首选，write_file 只用于新建） */
const EDIT_TOOLS = new Set(['write_file', 'edit_file', 'multi_edit'])

export function collectSignals(
  events: AgentEvent[],
  maxSteps: number,
  stats?: AgentStats,
): RunSignals {
  const toolCalls: { name: string; ok: boolean }[] = []
  const editedFiles: string[] = []
  let ranTests = false
  let testRunFailures = 0
  let apiError: string | null = null
  let finished = false
  const pending = new Map<string, { name: string; args: unknown }>() // tool_call id → 调用信息

  for (const ev of events) {
    if (ev.type === 'tool_call') {
      pending.set(ev.id, { name: ev.name, args: ev.args })
      if (EDIT_TOOLS.has(ev.name)) {
        const p = (ev.args as { path?: unknown })?.path
        if (typeof p === 'string') editedFiles.push(p)
      }
    } else if (ev.type === 'tool_result') {
      const info = pending.get(ev.id)
      const name = info?.name ?? ev.name
      toolCalls.push({ name, ok: ev.ok })
      // 跑测试既可能是 run_tests，也可能是 run_command ["node","--test",...]
      const argsText = JSON.stringify(info?.args ?? {})
      const isTestRun =
        name === 'run_tests' ||
        (name === 'run_command' && /--test|jest|vitest|mocha|\btest\b/i.test(argsText))
      if (isTestRun) {
        ranTests = true
        const m = ev.result.match(/失败\s*(\d+)\s*项/)
        if (m && Number(m[1]) > 0) testRunFailures++
        else if (/exit\s+[1-9]/.test(ev.result)) testRunFailures++
      }
    } else if (ev.type === 'error') {
      apiError = ev.message
    } else if (ev.type === 'final') {
      finished = true
    }
  }

  return {
    finished,
    steps: stats?.steps ?? 0,
    maxSteps,
    toolCalls,
    editedFiles,
    ranTests,
    testRunFailures,
    apiError,
  }
}

const CHEAT_HINTS = ['防作弊', '未被删改', '真值']

/** 依据信号 + 断言结果给出失败模式诊断 */
export function classifyFailure(
  signals: RunSignals,
  assertionResults: { name: string; passed: boolean }[],
  passed: boolean,
): FailureDiagnosis {
  const failed = assertionResults.filter((a) => !a.passed)
  const ev: string[] = []

  if (passed) {
    return { mode: 'passed', ...MODE_META.passed, evidence: [] }
  }

  const wrap = (mode: FailureMode, evidence: string[]): FailureDiagnosis => ({
    mode,
    label: MODE_META[mode].label,
    suggestion: MODE_META[mode].suggestion,
    evidence,
  })

  // 1) 基础设施异常
  if (signals.apiError) return wrap('api_error', [`Agent 事件流报错：${signals.apiError.slice(0, 120)}`])

  // 2) 作弊：防作弊类断言失败
  const cheatFailed = failed.filter((a) => CHEAT_HINTS.some((h) => a.name.includes(h)))
  if (cheatFailed.length) {
    return wrap('cheated', cheatFailed.map((a) => `防作弊断言失败：${a.name}`))
  }

  // 3) 超步数：未正常收尾且已到上限
  if (!signals.finished && signals.steps >= signals.maxSteps) {
    return wrap('max_steps', [`步数 ${signals.steps}/${signals.maxSteps}，未产出 final 事件`])
  }

  // 4) 未改动任何文件
  if (signals.editedFiles.length === 0) {
    return wrap('no_edit', ['全程未改动任何文件（write_file / edit_file / multi_edit 均未调用）'])
  }

  // 5) 改动了但从未验证
  if (!signals.ranTests) {
    return wrap('not_verified', [
      `写入了 ${signals.editedFiles.length} 个文件，但从未调用 run_tests`,
      `失败断言：${failed.map((a) => a.name).join('、') || '（无）'}`,
    ])
  }

  // 6) 跑过测试且失败
  if (signals.testRunFailures > 0) {
    ev.push(`run_tests 失败 ${signals.testRunFailures} 次`)
    ev.push(`失败断言：${failed.map((a) => a.name).join('、') || '（无）'}`)
    return wrap('tests_still_failing', ev)
  }

  // 7) 工具报错
  const toolErrs = signals.toolCalls.filter((t) => !t.ok)
  if (toolErrs.length) {
    return wrap('tool_error', [
      `${toolErrs.length} 次工具调用失败：${toolErrs.map((t) => t.name).join('、')}`,
      `失败断言：${failed.map((a) => a.name).join('、') || '（无）'}`,
    ])
  }

  // 8) 其余断言不符
  if (failed.length) {
    return wrap('assertion_mismatch', [`失败断言：${failed.map((a) => a.name).join('、')}`])
  }

  return wrap('unknown', ['任务判定为失败，但无匹配的信号组合'])
}

export interface FailureSummary {
  total: number
  passed: number
  failed: number
  /** 每个失败模式出现的次数 */
  byMode: { mode: FailureMode; label: string; count: number }[]
}

export function summarizeFailures(diagnoses: { passed: boolean; diagnosis: FailureDiagnosis }[]): FailureSummary {
  const counts = new Map<FailureMode, number>()
  for (const d of diagnoses) {
    if (d.passed) continue
    counts.set(d.diagnosis.mode, (counts.get(d.diagnosis.mode) ?? 0) + 1)
  }
  const byMode = [...counts.entries()]
    .map(([mode, count]) => ({ mode, label: MODE_META[mode].label, count }))
    .sort((a, b) => b.count - a.count)
  return {
    total: diagnoses.length,
    passed: diagnoses.filter((d) => d.passed).length,
    failed: diagnoses.filter((d) => !d.passed).length,
    byMode,
  }
}

export function renderFailureSummary(s: FailureSummary): string {
  const L: string[] = []
  L.push(`失败模式分布（共 ${s.total} 个任务，通过 ${s.passed}，失败 ${s.failed}）：`)
  if (!s.byMode.length) {
    L.push('  （无失败）')
    return L.join('\n')
  }
  const max = Math.max(...s.byMode.map((b) => b.count))
  for (const b of s.byMode) {
    const bar = '█'.repeat(Math.max(1, Math.round((b.count / max) * 20)))
    L.push(`  ${b.label.padEnd(16, '　')} ${String(b.count).padStart(2)} ${bar}`)
  }
  return L.join('\n')
}
