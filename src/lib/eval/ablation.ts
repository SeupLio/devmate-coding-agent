/**
 * 对照实验（ablation）执行器。
 *
 * 目的：把「Agent 效果好」从一句结论，变成一组可比较的实验数据。
 * 做法：固定任务集与模型，只改变 Agent 的一个能力维度，比较通过率与资源消耗。
 *
 * 实验组：
 *   full        — 完整配置（7 工具 + 规划 + 压缩）          基线
 *   no-plan     — 关闭任务规划                              验证「规划」的增量
 *   no-verify   — 移除 run_tests 工具                       验证「自我验证」的增量
 *   no-search   — 移除 search_code 工具                     验证「代码检索」的增量
 *   no-compress — 关闭上下文压缩                            验证压缩对长链路的影响
 *   bare        — 无工具、一次性输出（single-shot）          验证「Agent 范式」相对「裸模型」的增量
 */
import fs from 'node:fs'
import path from 'node:path'
import { chatStream } from '@/lib/agent/llm'
import { createWorkspace, newRunId, sessionDir, HOLDOUT_TEMPLATE_DIR } from '@/lib/agent/workspace'
import { runEvaluation, type AgentRunConfig, type EvalRunResult } from './runner'
import { EVAL_TASKS, HOLDOUT_TASKS, type EvalTask } from './tasks'

export const ABLATION_CONFIGS: AgentRunConfig[] = [
  {
    id: 'full',
    label: 'A · 完整配置',
    note: '7 个工具 + 任务规划 + 上下文压缩',
  },
  {
    id: 'no-plan',
    label: 'B · 无任务规划',
    plan: false,
    note: '去掉规划阶段，直接进入工具调用循环',
  },
  {
    id: 'no-verify',
    label: 'C · 无自我验证',
    toolFilter: ['list_files', 'read_file', 'write_file', 'search_code', 'run_command', 'git_operation'],
    note: '移除 run_tests，Agent 改完无法自己跑测试确认',
  },
  {
    id: 'no-search',
    label: 'D · 无代码检索',
    toolFilter: ['list_files', 'read_file', 'write_file', 'run_command', 'run_tests', 'git_operation'],
    note: '移除 search_code，只能靠 list_files + read_file 逐个看',
  },
  {
    id: 'no-compress',
    label: 'E · 无上下文压缩',
    useCompression: false,
    note: '关闭 token 预算与历史压缩',
  },
]

/** 裸模型组：无工具、单次调用、直接输出完整文件 */
export const BARE_CONFIG: AgentRunConfig = {
  id: 'bare',
  label: 'F · 裸模型（无工具·单次输出）',
  note: '同模型一次性输出全部文件内容，无工具调用、无迭代、无自验证',
}

// ===================== 裸模型（single-shot）执行器 =====================

const BARE_SYSTEM = `你是一个代码助手。用户会给你任务和项目全部文件的当前内容。
请直接输出修改后的**完整文件**，格式严格如下（可输出多个文件）：

<file path="相对路径">
完整文件内容
</file>

不要输出任何解释文字，不要使用 markdown 代码块。只输出 <file> 标签。`

function readWorkspaceFiles(sid: string): { rel: string; content: string }[] {
  const root = sessionDir(sid)
  const out: { rel: string; content: string }[] = []
  const walk = (dir: string, base = '') => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue
      const rel = base ? `${base}/${e.name}` : e.name
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full, rel)
      else out.push({ rel, content: fs.readFileSync(full, 'utf-8') })
    }
  }
  walk(root)
  return out
}

function applyFileBlocks(sid: string, text: string): string[] {
  const written: string[] = []
  const re = /<file\s+path="([^"]+)"\s*>([\s\S]*?)<\/file>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const rel = m[1].trim().replace(/^[/\\]+/, '')
    const content = m[2].replace(/^\n/, '').replace(/\n$/, '')
    if (!rel || !content) continue
    const target = path.join(sessionDir(sid), rel)
    if (!target.startsWith(sessionDir(sid))) continue
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
    written.push(rel)
  }
  return written
}

export interface BareResult {
  taskId: string
  name: string
  passed: boolean
  assertionResults: { name: string; passed: boolean }[]
  written: string[]
  durationMs: number
  tokensUsed: number
}

export async function runBareOnce(task: EvalTask): Promise<BareResult> {
  const sid = `bare-${newRunId()}-${task.id}`
  createWorkspace(sid, task.template === 'holdout' ? HOLDOUT_TEMPLATE_DIR : undefined)
  const files = readWorkspaceFiles(sid)
  const t0 = Date.now()
  const prompt = [
    '## 任务',
    task.prompt,
    '',
    '## 项目当前全部文件',
    ...files.map((f) => `### ${f.rel}\n\`\`\`\n${f.content}\n\`\`\``),
  ].join('\n')

  let text = ''
  let tokensUsed = 0
  try {
    const res = await chatStream([
      { role: 'system', content: BARE_SYSTEM },
      { role: 'user', content: prompt },
    ])
    text = res.content
    tokensUsed = res.usage?.total_tokens ?? Math.ceil((prompt.length + text.length) / 2)
  } catch (e) {
    text = ''
    tokensUsed = 0
  }
  const written = applyFileBlocks(sid, text)

  const assertionResults: { name: string; passed: boolean }[] = []
  for (const a of task.assertions) {
    let passed = false
    try {
      passed = await a.check(sid)
    } catch {
      passed = false
    }
    assertionResults.push({ name: a.name, passed })
  }
  return {
    taskId: task.id,
    name: task.name,
    passed: assertionResults.length > 0 && assertionResults.every((a) => a.passed),
    assertionResults,
    written,
    durationMs: Date.now() - t0,
    tokensUsed,
  }
}

// ===================== 汇总 =====================

export interface ConfigSummary {
  config: AgentRunConfig
  total: number
  passed: number
  passRate: number
  avgSteps: number
  avgToolCalls: number
  avgDurationMs: number
  avgTokens: number
  results: (EvalRunResult['results'][number] | BareResult)[]
}

export interface AblationReport {
  startedAt: string
  durationMs: number
  model: string
  taskScope: string
  repeat: number
  summaries: ConfigSummary[]
}

function summarize(config: AgentRunConfig, report: EvalRunResult): ConfigSummary {
  const stats = report.results.map((r) => r.stats).filter(Boolean)
  const avg = (f: (s: NonNullable<typeof stats[number]>) => number) =>
    stats.length ? stats.reduce((a, s) => a + f(s!), 0) / stats.length : 0
  return {
    config,
    total: report.total,
    passed: report.passed,
    passRate: report.total ? Number(((report.passed / report.total) * 100).toFixed(1)) : 0,
    avgSteps: Number(avg((s) => s.steps).toFixed(1)),
    avgToolCalls: Number(avg((s) => s.toolCalls).toFixed(1)),
    avgDurationMs: Math.round(avg((s) => s.durationMs)),
    avgTokens: Math.round(avg((s) => s.tokensUsed)),
    results: report.results,
  }
}

export async function runAblation(opts: {
  taskIds?: string[]
  only?: 'default' | 'holdout' | 'all'
  configIds?: string[]
  repeat?: number
  includeBare?: boolean
  onProgress?: (msg: string) => void
}): Promise<AblationReport> {
  const t0 = Date.now()
  const repeat = Math.max(1, opts.repeat ?? 1)
  const configs = ABLATION_CONFIGS.filter((c) => !opts.configIds?.length || opts.configIds.includes(c.id))
  const summaries: ConfigSummary[] = []

  const pool: EvalTask[] =
    opts.only === 'holdout' ? HOLDOUT_TASKS : opts.only === 'default' ? EVAL_TASKS : [...EVAL_TASKS, ...HOLDOUT_TASKS]
  const tasks = opts.taskIds?.length
    ? [...EVAL_TASKS, ...HOLDOUT_TASKS].filter((t) => opts.taskIds!.includes(t.id))
    : pool

  for (const config of configs) {
    opts.onProgress?.(`▶ ${config.label}（${config.note}）`)
    let report: EvalRunResult | null = null
    for await (const ev of runEvaluation({ taskIds: opts.taskIds, only: opts.only, config, repeat })) {
      if (ev.type === 'task_done') {
        opts.onProgress?.(`   ${ev.result!.passed ? '✓' : '✗'} ${ev.result!.name}`)
      }
      if (ev.type === 'run_done') report = ev.report!
    }
    if (report) summaries.push(summarize(config, report))
  }

  if (opts.includeBare) {
    opts.onProgress?.(`▶ ${BARE_CONFIG.label}（${BARE_CONFIG.note}）`)
    const bareResults: BareResult[] = []
    for (let round = 1; round <= repeat; round++) {
      for (const task of tasks) {
        const r = await runBareOnce(task)
        opts.onProgress?.(`   ${r.passed ? '✓' : '✗'} ${r.name}`)
        bareResults.push(r)
      }
    }
    const passed = bareResults.filter((r) => r.passed).length
    summaries.push({
      config: BARE_CONFIG,
      total: bareResults.length,
      passed,
      passRate: bareResults.length ? Number(((passed / bareResults.length) * 100).toFixed(1)) : 0,
      avgSteps: 1,
      avgToolCalls: 0,
      avgDurationMs: Math.round(bareResults.reduce((a, r) => a + r.durationMs, 0) / (bareResults.length || 1)),
      avgTokens: Math.round(bareResults.reduce((a, r) => a + r.tokensUsed, 0) / (bareResults.length || 1)),
      results: bareResults,
    })
  }

  return {
    startedAt: new Date(t0).toISOString(),
    durationMs: Date.now() - t0,
    model: process.env.OPENAI_MODEL ?? 'unknown',
    taskScope: opts.only ?? 'all',
    repeat,
    summaries,
  }
}

export function renderReport(r: AblationReport): string {
  const lines: string[] = []
  lines.push('')
  lines.push('='.repeat(96))
  lines.push('DevMate 对照实验报告（ablation）')
  lines.push(`模型：${r.model}｜任务范围：${r.taskScope}｜每任务重复：${r.repeat} 轮｜总用时：${(r.durationMs / 1000).toFixed(0)}s`)
  lines.push('='.repeat(96))
  lines.push(
    ['实验组', '通过率', '通过/总数', '平均步数', '平均工具调用', '平均耗时(s)', '平均token'].join('\t'),
  )
  for (const s of r.summaries) {
    lines.push(
      [
        s.config.label,
        `${s.passRate}%`,
        `${s.passed}/${s.total}`,
        s.avgSteps.toFixed(1),
        s.avgToolCalls.toFixed(1),
        (s.avgDurationMs / 1000).toFixed(1),
        String(s.avgTokens),
      ].join('\t'),
    )
  }
  lines.push('='.repeat(96))
  lines.push('逐任务明细：')
  for (const s of r.summaries) {
    lines.push(`\n【${s.config.label}】${s.config.note ?? ''}`)
    for (const res of s.results) {
      const r2 = res as { name: string; passed: boolean }
      lines.push(`  ${r2.passed ? '✓' : '✗'} ${r2.name}`)
    }
  }
  return lines.join('\n')
}
