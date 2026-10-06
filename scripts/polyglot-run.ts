/**
 * Aider polyglot-benchmark（JavaScript）运行器。
 *
 *   bun run polyglot              # 跑前 10 题（冒烟）
 *   bun run polyglot 20           # 跑前 20 题
 *   bun run polyglot 49 8         # 跑 49 题，并发 8
 *
 * 每道题：准备沙箱 → 让 Agent 实现 → 用 jest 跑外部定义的测试 → 判定全绿。
 *
 * 与项目内评测的区别：**测试用例来自 Exercism / Aider 官方基准**，不是我写的。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  buildTaskPrompt,
  listExercises,
  parseJestJson,
  prepareExercise,
  summarizePolyglot,
  type PolyglotResult,
} from '../src/lib/bench/polyglot'

const execFileAsync = promisify(execFile)

const POLYGLOT_ROOT = path.join(process.cwd(), 'benchmarks', 'external', 'polyglot')
const EXERCISES_DIR = path.join(
  POLYGLOT_ROOT,
  'polyglot-benchmark-main',
  'javascript',
  'exercises',
  'practice',
)
const NODE_MODULES = path.join(POLYGLOT_ROOT, 'node_modules')

const argv = process.argv.slice(2)
const limit = Number(argv[0]) || 10
const concurrency = Number(argv[1]) || 4

const all = listExercises(EXERCISES_DIR)
if (!all.length) {
  console.error('✗ 未找到练习。请先下载 polyglot-benchmark（见 docs/EXTERNAL-BENCHMARKS.md）')
  process.exit(1)
}
const picked = all.slice(0, limit)

console.log(`\nAider polyglot-benchmark（JavaScript）｜${picked.length}/${all.length} 题｜并发 ${concurrency}`)
console.log('数据来源：github.com/Aider-AI/polyglot-benchmark（Exercism 题库）\n')

/** 跑一道题 */
async function runOne(slug: string, idx: number): Promise<PolyglotResult> {
  const t0 = Date.now()
  const ex = all.find((e) => e.slug === slug)!
  const sid = `poly-${slug}`.slice(0, 40)
  const { createWorkspace, sessionDir, workspaceExists } = await import('../src/lib/agent/workspace')

  if (workspaceExists(sid)) fs.rmSync(sessionDir(sid), { recursive: true, force: true })
  createWorkspace(sid)
  const dir = sessionDir(sid)

  const { enabledTests } = prepareExercise(ex, dir)

  // jest / babel 的依赖解析：把共享 node_modules 以**目录联接**挂进沙箱，
  // 这样 node 的模块解析能一路向上找到 jest 与 babel-jest
  const link = path.join(dir, 'node_modules')
  try {
    if (!fs.existsSync(link)) fs.symlinkSync(NODE_MODULES, link, 'junction')
  } catch {
    /* 创建失败则后面的 jest 会报错，如实记录 */
  }

  const { runAgent } = await import('../src/lib/agent/loop')
  let steps = 0
  let summary = ''
  let agentError = ''
  try {
    for await (const ev of runAgent({
      sessionId: sid,
      task: buildTaskPrompt(ex, dir, enabledTests),
      maxSteps: 20,
      plan: false,
      thinking: false,
      permissionMode: 'bypassPermissions', // 评测环境，不需要人工审批
      toolFilter: [
        'list_files', 'read_file', 'write_file', 'edit_file', 'multi_edit',
        'glob', 'grep', 'run_command', 'run_tests', 'search_ast', 'search_semantic',
      ],
    })) {
      if (ev.type === 'final') {
        steps = ev.stats.steps
        summary = ev.summary
      }
      if (ev.type === 'error') agentError = ev.message
    }
  } catch (e) {
    agentError = e instanceof Error ? e.message : String(e)
  }

  // 判分：直接调 jest（不依赖 Agent 自己跑没跑）
  const jestBin = path.join(NODE_MODULES, 'jest', 'bin', 'jest.js')
  const configPath = path.join(dir, 'jest.config.json')
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        rootDir: dir,
        testEnvironment: 'node',
        testMatch: ['**/*.spec.js'],
        transform: { '^.+\\.[jt]sx?$': ['babel-jest', { presets: ['@exercism/babel-preset-javascript'] }] },
      },
      null,
      2,
    ),
    'utf-8',
  )

  let outcome = { ok: false, passed: 0, failed: 0, total: 0, raw: '' }
  let reason = agentError
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [jestBin, '--config', configPath, '--json', '--silent'],
      { cwd: dir, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 },
    )
    const j = parseJestJson(stdout)
    if (j) outcome = j
  } catch (e) {
    // jest 在测试失败时以非 0 退出，但 stdout 里仍有 --json 结果
    const err = e as { stdout?: string; message?: string }
    const j = err.stdout ? parseJestJson(err.stdout) : null
    if (j) outcome = j
    else reason = reason || (err.message ?? 'jest 执行失败').slice(0, 200)
  }

  return {
    slug,
    ok: outcome.ok,
    passed: outcome.passed,
    failed: outcome.failed,
    total: outcome.total,
    steps,
    durationMs: Date.now() - t0,
    reason: outcome.ok ? undefined : reason || `${outcome.failed}/${outcome.total} 用例失败`,
  }
}

// ===================== 并发执行 =====================

const results: PolyglotResult[] = []
let cursor = 0
let done = 0

async function worker() {
  while (cursor < picked.length) {
    const i = cursor++
    const ex = picked[i]
    const r = await runOne(ex.slug, i)
    results.push(r)
    done++
    const mark = r.ok ? '✓' : '✗'
    process.stdout.write(
      `\r  [${String(done).padStart(2)}/${picked.length}] ${mark} ${ex.slug.padEnd(24)} ` +
        `通过 ${results.filter((x) => x.ok).length}`,
    )
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, picked.length) }, worker))
process.stdout.write('\n')

// ===================== 报告 =====================

const s = summarizePolyglot(results)
console.log('\n' + '='.repeat(64))
console.log('Aider polyglot-benchmark（JavaScript）结果')
console.log('='.repeat(64))
console.log(`解决率：${(s.passRate * 100).toFixed(1)}%  (${s.solved}/${s.total})`)
console.log(`平均步数：${s.avgSteps.toFixed(1)}｜平均耗时：${(s.avgDurationMs / 1000).toFixed(0)}s`)
console.log('')
console.log('未通过的题目：')
const failed = results.filter((r) => !r.ok)
if (!failed.length) console.log('  （无）')
for (const f of failed) {
  console.log(`  ✗ ${f.slug.padEnd(24)} ${f.passed}/${f.total} 通过  — ${(f.reason ?? '').slice(0, 90)}`)
}

const out = path.join(POLYGLOT_ROOT, 'polyglot-report.json')
fs.writeFileSync(
  out,
  JSON.stringify({ summary: s, results, at: new Date().toISOString() }, null, 2),
  'utf-8',
)
console.log(`\n✓ 报告已写入 ${out}\n`)
