/**
 * 从**真实修复提交**构建可自动验证的任务实例（SWE-bench 方法论）。
 *
 * 这是让基准「真实 + 可验证」的核心机器：
 *
 *   1. base = 修复提交的父提交，拉取 base 的仓库快照
 *   2. 把**修复后**的测试文件覆盖到 base 上
 *      （等价于「issue 里带了回归测试」，但 Agent 全程看不到这些测试）
 *   3. 跑测试 → 失败集合 = **FAIL_TO_PASS 候选**
 *   4. 套用修复提交的**源码**改动 → 再跑 → 全通过
 *   5. 两段都成立才产出 `VALID` 任务；否则如实报告失败原因
 *
 * 关键性质：
 *  - **判据是机器产生的**，不是我手写的期望值 → 无法「迁就断言」
 *  - 测试在 base 上确实失败 → 任务不是「本来就能过」的伪任务
 *  - 测试文件只在评测侧拉取 → Agent 沙箱里没有 → 抗游戏性
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  downloadTarball,
  fetchFileText,
  ghApi,
  isTestPath,
  materializeFile,
  type GhCommitDetail,
  type GhIssue,
} from './github'
import type { BenchTask, Difficulty } from './types'

/** node 可执行文件（bun 下 process.execPath 是 bun，需要显式指定 node 才能用 TAP 报告器） */
export function nodeBin(): string {
  return process.env.BENCH_NODE_BIN ?? process.execPath
}

export interface TapResult {
  code: number
  passed: Set<string>
  failed: Set<string>
  output: string
}

/** 跑 node --test 并解析 TAP，拿到结构化的通过/失败用例名 */
export function runTap(cwd: string, args: string[], timeoutMs = 240_000): TapResult {
  const r = spawnSync(nodeBin(), ['--test', '--test-reporter=tap', ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  })
  const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
  const passed = new Set<string>()
  const failed = new Set<string>()
  for (const line of output.split('\n')) {
    const m = /^(ok|not ok) \d+ - (.*)$/.exec(line.trim())
    if (!m) continue
    const name = m[2].trim()
    if (m[1] === 'ok') passed.add(name)
    else failed.add(name)
  }
  return { code: r.status ?? -1, passed, failed, output }
}

export type BuildVerdict =
  | 'VALID'
  | 'no_fail_at_base'
  | 'gold_incomplete'
  | 'no_test_change'
  | 'no_src_change'
  | 'error'

export interface BuildResult {
  verdict: BuildVerdict
  repo: string
  fixCommit: string
  baseCommit: string
  testFiles: string[]
  srcFiles: string[]
  failToPass: string[]
  passToPass: string[]
  message?: string
  detail?: string
}

export interface BuildOptions {
  /** 解压工作目录 */
  workDir: string
  /** 每个任务独立的测试命令；不传则直接用改动的测试文件路径 */
  testArgs?: (testFiles: string[]) => string[]
  /** 是否在完成后保留工作区（调试用） */
  keep?: boolean
}

/**
 * 对单个修复提交做两阶段验证。
 * 不产生任何副作用到项目源码 —— 全部在 workDir 下的临时快照里进行。
 */
export async function buildTaskFromFixCommit(
  repo: string,
  fixCommit: string,
  opts: BuildOptions,
): Promise<BuildResult> {
  const base: BuildResult = {
    verdict: 'error',
    repo,
    fixCommit,
    baseCommit: '',
    testFiles: [],
    srcFiles: [],
    failToPass: [],
    passToPass: [],
  }
  try {
    const commit = await ghApi<GhCommitDetail>(`/repos/${repo}/commits/${fixCommit}`)
    if (!commit.parents?.length) {
      return { ...base, verdict: 'error', detail: '根提交，无父提交' }
    }
    const parent = commit.parents[0].sha
    base.baseCommit = parent

    const files = commit.files ?? []
    const testFiles = files.filter((f) => isTestPath(f.filename)).map((f) => f.filename)
    const srcFiles = files.filter((f) => !isTestPath(f.filename)).map((f) => f.filename)
    base.testFiles = testFiles
    base.srcFiles = srcFiles
    base.message = commit.commit.message.split('\n')[0]

    if (!testFiles.length) return { ...base, verdict: 'no_test_change' }
    if (!srcFiles.length) return { ...base, verdict: 'no_src_change' }

    // 1) base 快照 + 修复后的测试文件
    const dir = path.join(opts.workDir, `${repo.replace(/\//g, '_')}-${parent.slice(0, 10)}`)
    const root = await downloadTarball(repo, parent, dir)
    for (const tf of testFiles) await materializeFile(repo, tf, fixCommit, root)

    const args = opts.testArgs ? opts.testArgs(testFiles) : testFiles
    const phase1 = runTap(root, args)
    if (!phase1.failed.size) {
      return { ...base, verdict: 'no_fail_at_base', detail: `base 上 ${phase1.passed.size} 个用例全通过` }
    }

    // 2) 套用参考解（源码）
    for (const sf of srcFiles) await materializeFile(repo, sf, fixCommit, root)
    const phase2 = runTap(root, args)
    if (phase2.failed.size) {
      return {
        ...base,
        verdict: 'gold_incomplete',
        failToPass: [...phase1.failed].sort(),
        detail: `套用参考解后仍有 ${phase2.failed.size} 个失败：${[...phase2.failed].slice(0, 3).join(' | ')}`,
      }
    }

    return {
      ...base,
      verdict: 'VALID',
      failToPass: [...phase1.failed].sort(),
      passToPass: [...phase1.passed].filter((n) => phase2.passed.has(n)).sort(),
    }
  } catch (e) {
    return { ...base, verdict: 'error', detail: e instanceof Error ? e.message : String(e) }
  }
}

/** 由验证结果生成正式任务定义 */
export function toBenchTask(
  r: BuildResult,
  meta: {
    id: string
    prompt: string
    category: BenchTask['category']
    difficulty: Difficulty
    issueNumber?: number
    issueUrl?: string
    testCommand: string[]
    prepare?: string[][]
    requiredTools?: string[]
    maxSteps?: number
    modelCutoff?: string
    license?: string
    note?: string
  },
): BenchTask {
  return {
    id: meta.id,
    prompt: meta.prompt,
    category: meta.category,
    difficulty: meta.difficulty,
    provenance: {
      kind: 'real-issue',
      repo: r.repo,
      baseCommit: r.baseCommit,
      fixCommit: r.fixCommit,
      issueNumber: meta.issueNumber,
      issueUrl: meta.issueUrl,
      collectedAt: new Date().toISOString(),
      modelCutoff: meta.modelCutoff,
      license: meta.license,
      note: meta.note,
    },
    setup: {
      prepare: meta.prepare,
      testCommand: meta.testCommand,
    },
    verification: {
      mode: 'tests',
      failToPass: r.failToPass,
      passToPass: r.passToPass,
      goldPatchFiles: r.srcFiles,
    },
    requiredTools: meta.requiredTools,
    maxSteps: meta.maxSteps,
    // 隐藏测试：Agent 沙箱里不存在，评测时才覆盖进去
    hiddenTests: r.testFiles.map((f) => ({ path: f, ref: r.fixCommit })),
  }
}

/** 便捷函数：从 GitHub issue 取正文，作为任务描述 */
export async function fetchIssuePrompt(repo: string, issueNumber: number): Promise<GhIssue> {
  return ghApi<GhIssue>(`/repos/${repo}/issues/${issueNumber}`)
}

export function writeTasks(tasks: BenchTask[], outFile: string) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, JSON.stringify(tasks, null, 2), 'utf-8')
}
