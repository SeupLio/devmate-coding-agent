/**
 * 构建并**验证**真实任务清单。
 *
 *   bun scripts/bench-build.ts                # 构建全部种子
 *   bun scripts/bench-build.ts pfe-whatwg-url # 只构建指定任务
 *
 * 对每个种子：从真实仓库拉 base 快照 → 覆盖修复后的测试 → 跑测试 →
 * 套用参考解 → 再跑。两阶段都成立才收录。
 *
 * 产出：
 *   benchmarks/real-tasks.json   任务清单（含 FAIL_TO_PASS / PASS_TO_PASS）
 *   benchmarks/build-report.txt  构建日志（哪些种子被拒、为什么）
 *
 * 需要环境变量：GITHUB_TOKEN（或 GH_TOKEN）
 */
import fs from 'node:fs'
import path from 'node:path'
import { buildTaskFromFixCommit, fetchIssuePrompt, toBenchTask, writeTasks } from '../src/lib/bench/builder'
import { TASK_SEEDS, type TaskSeed } from '../src/lib/bench/registry'
import type { BenchTask } from '../src/lib/bench/types'

const OUT_DIR = path.join(process.cwd(), 'benchmarks')
const WORK_DIR = path.join(OUT_DIR, '_work')

async function resolvePrompt(seed: TaskSeed): Promise<{ prompt: string; issueUrl?: string }> {
  if (seed.promptSource.kind === 'neutral') return { prompt: seed.promptSource.text }
  const issue = await fetchIssuePrompt(seed.repo, seed.promptSource.issueNumber)
  const body = (issue.body ?? '').trim()
  // issue 正文可能很长，截断避免超出上下文
  const clipped = body.length > 2500 ? `${body.slice(0, 2500)}\n...(issue 正文已截断)` : body
  const prompt = [
    `# ${issue.title}`,
    '',
    clipped,
    '',
    '---',
    `以上是 ${seed.repo} 仓库的真实 issue（#${issue.number}）。请在该仓库中修复它。`,
    '要求：不要修改任何测试文件；改完后运行测试确认通过。',
  ].join('\n')
  return { prompt, issueUrl: issue.html_url }
}

async function main() {
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'))
  const seeds = only.length ? TASK_SEEDS.filter((s) => only.includes(s.id)) : TASK_SEEDS

  if (!process.env.GITHUB_TOKEN && !process.env.GH_TOKEN) {
    console.error('✗ 需要 GITHUB_TOKEN（或 GH_TOKEN）才能拉取真实任务源')
    process.exit(1)
  }

  fs.mkdirSync(WORK_DIR, { recursive: true })
  const tasks: BenchTask[] = []
  const log: string[] = [`DevMate 真实任务构建报告  ${new Date().toISOString()}`, '='.repeat(70), '']

  for (const seed of seeds) {
    process.stdout.write(`▶ ${seed.id}  (${seed.repo}@${seed.fixCommit.slice(0, 10)}) ... `)
    const r = await buildTaskFromFixCommit(seed.repo, seed.fixCommit, {
      workDir: WORK_DIR,
      testArgs: seed.testArgs,
    })
    if (r.verdict !== 'VALID') {
      console.log(`✗ ${r.verdict}`)
      log.push(`✗ ${seed.id}  → ${r.verdict}${r.detail ? `：${r.detail}` : ''}`)
      continue
    }
    const { prompt, issueUrl } = await resolvePrompt(seed)
    const task = toBenchTask(r, {
      id: seed.id,
      prompt,
      category: seed.category,
      difficulty: seed.difficulty,
      issueNumber: seed.promptSource.kind === 'issue' ? seed.promptSource.issueNumber : undefined,
      issueUrl,
      testCommand: ['node', '--test'],
      requiredTools: seed.requiredTools,
      maxSteps: seed.maxSteps,
      modelCutoff: seed.modelCutoff,
      note: seed.note,
    })
    // 没有 issue 的种子，出处标为 real-commit
    if (seed.promptSource.kind === 'neutral') task.provenance.kind = 'real-commit'
    tasks.push(task)
    console.log(`✓ FAIL_TO_PASS=${r.failToPass.length} PASS_TO_PASS=${r.passToPass.length}`)
    log.push(
      `✓ ${seed.id}  [${task.provenance.kind}] ${seed.repo}@${r.baseCommit.slice(0, 10)}\n` +
        `    FAIL_TO_PASS(${r.failToPass.length}): ${r.failToPass.slice(0, 6).join(' | ')}\n` +
        `    PASS_TO_PASS(${r.passToPass.length})${r.passToPass.length ? `: ${r.passToPass.slice(0, 4).join(' | ')}…` : ''}`,
    )
  }

  writeTasks(tasks, path.join(OUT_DIR, 'real-tasks.json'))
  log.push('', '='.repeat(70), `收录 ${tasks.length}/${seeds.length} 个任务 → benchmarks/real-tasks.json`)
  fs.writeFileSync(path.join(OUT_DIR, 'build-report.txt'), log.join('\n'), 'utf-8')
  console.log(`\n✓ 收录 ${tasks.length}/${seeds.length} → benchmarks/real-tasks.json`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
