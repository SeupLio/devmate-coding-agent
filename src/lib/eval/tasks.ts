/**
 * 评测集：每个任务在一个全新沙箱上运行 Agent，
 * 断言最终文件内容与测试结果，产出可量化报告。
 * 对应 JD 中的「效果评估 / 评测集构建」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { safeResolve, sessionDir } from '@/lib/agent/workspace'
import { runInSandbox } from '@/lib/agent/tools'

export interface EvalTask {
  id: string
  name: string
  prompt: string
  /** 断言：全部通过才算任务成功 */
  assertions: {
    name: string
    check: (sessionId: string) => Promise<boolean>
  }[]
}

export interface EvalTaskResult {
  taskId: string
  name: string
  passed: boolean
  assertionResults: { name: string; passed: boolean }[]
  stats?: unknown
}

async function testsPass(sessionId: string): Promise<boolean> {
  const { code } = await runInSandbox(sessionId, ['node', '--test'])
  return code === 0
}

function fileContains(sessionId: string, file: string, keyword: string): Promise<boolean> {
  return Promise.resolve(() => undefined).then(() => {
    try {
      return fs.readFileSync(safeResolve(sessionId, file), 'utf-8').includes(keyword)
    } catch {
      return false
    }
  })
}

export const EVAL_TASKS: EvalTask[] = [
  {
    id: 'fix-bug',
    name: '修复 mathutils 使全部测试通过',
    prompt: 'mathutils.js 中存在若干 bug，请定位并修复，使 node --test 的全部测试通过，然后提交。',
    assertions: [
      { name: '全部测试通过', check: (s) => testsPass(s) },
      { name: 'average 分母已修正', check: (s) => fileContains(s, 'mathutils.js', 'nums.length') },
    ],
  },
  {
    id: 'add-feature',
    name: '新增 clamp 函数并补测试',
    prompt:
      '请在 mathutils.js 中新增 clamp(x, lo, hi) 函数（将 x 限制在 [lo, hi] 区间内）并导出，同时在 mathutils.test.js 中补充对应用例，运行测试确保通过后提交。',
    assertions: [
      { name: '实现包含 clamp', check: (s) => fileContains(s, 'mathutils.js', 'clamp') },
      { name: '测试包含 clamp 用例', check: (s) => fileContains(s, 'mathutils.test.js', 'clamp') },
      { name: '全部测试通过', check: (s) => testsPass(s) },
    ],
  },
  {
    id: 'perf-refactor',
    name: '将 fibonacci 重构为迭代实现',
    prompt:
      'mathutils.js 中的 fibonacci 目前是低效递归，请将其重构为迭代实现，修正 n=0 的边界（应返回 0），保证全部测试通过并提交。',
    assertions: [
      { name: '全部测试通过', check: (s) => testsPass(s) },
      { name: '不再使用递归调用', check: (s) => fileContains(s, 'mathutils.js', 'for') },
    ],
  },
  {
    id: 'write-doc',
    name: '为 README 补充使用说明',
    prompt:
      '请阅读 README.md 与 mathutils.js，在 README 中补充「API 说明」章节，列出每个函数的签名与一句话说明，并提交。',
    assertions: [
      { name: 'README 含 API 章节', check: (s) => fileContains(s, 'README.md', 'API') },
      { name: 'README 含函数签名', check: (s) => fileContains(s, 'README.md', 'sum') },
    ],
  },
]
