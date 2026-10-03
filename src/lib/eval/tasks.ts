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
  /** 沙箱模板：默认 mathutils 项目；'holdout' 用 stringutils；'hard' 用多文件计算器项目 */
  template?: 'default' | 'holdout' | 'hard'
  /** 是否属于 held-out 集（不参与日常调试，用于验证泛化） */
  holdout?: boolean
  /** 难度标记，用于分组统计 */
  difficulty?: 'basic' | 'hard'
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

/**
 * held-out 断言：只跑测试文件里指定分组的用例，取退出码。
 * 关键区别 —— 断言来自**预先写好的测试**，而不是事后按实现写的正则，
 * 因此不会出现「实现与断言互相迁就」的过拟合。
 */
async function testsPassFor(sessionId: string, pattern: string): Promise<boolean> {
  const { code } = await runInSandbox(sessionId, [
    'node', '--test', `--test-name-pattern=${pattern}`,
  ])
  return code === 0
}

/**
 * 防作弊断言：原有测试用例必须仍然存在。
 *
 * 为什么需要：只断言 `node --test` 退出码存在盲区 —— Agent 只要删掉测试
 * 或去掉 assert 就能让退出码变成 0，「测试通过」于是变成一句空话。
 * 这里要求「模板里的测试名一个不少」且「assert 调用数不少于模板」，
 * 从而允许 Agent 新增用例（add-feature 任务需要），但禁止删减原有用例。
 */
const TEMPLATE_TEST_PATH = path.join(process.cwd(), 'assets', 'template-project', 'mathutils.test.js')

function templateTestProfile(): { names: string[]; assertCount: number } {
  try {
    const src = fs.readFileSync(TEMPLATE_TEST_PATH, 'utf-8')
    const names = [...src.matchAll(/test\(\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1])
    const assertCount = (src.match(/assert\./g) || []).length
    return { names, assertCount }
  } catch {
    return { names: [], assertCount: 0 }
  }
}

const TEMPLATE_TEST_PROFILE = templateTestProfile()

function originalTestsIntact(sessionId: string, file = 'mathutils.test.js'): Promise<boolean> {
  return Promise.resolve().then(() => {
    try {
      const cur = fs.readFileSync(safeResolve(sessionId, file), 'utf-8')
      const namesOk = TEMPLATE_TEST_PROFILE.names.every((n) => cur.includes(n))
      const assertCount = (cur.match(/assert\./g) || []).length
      return namesOk && assertCount >= TEMPLATE_TEST_PROFILE.assertCount
    } catch {
      return false
    }
  })
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

// ===== 难任务项目（hard-project）专用断言 =====

const HARD_TEST_PATH = path.join(process.cwd(), 'assets', 'hard-project', 'test', 'calc.test.js')

function hardTestProfile(): { names: string[] } {
  try {
    const src = fs.readFileSync(HARD_TEST_PATH, 'utf-8')
    return { names: [...src.matchAll(/test\(\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]) }
  } catch {
    return { names: [] }
  }
}

const HARD_TEST_PROFILE = hardTestProfile()

/** 防作弊：难项目的预置测试用例必须一个不少 */
function hardTestsIntact(sessionId: string): Promise<boolean> {
  return Promise.resolve().then(() => {
    try {
      const cur = fs.readFileSync(safeResolve(sessionId, 'test/calc.test.js'), 'utf-8')
      return HARD_TEST_PROFILE.names.every((n) => cur.includes(n))
    } catch {
      return false
    }
  })
}

/**
 * golden 组的期望值（= 参考实现 tools/reference.js 的输出）。
 *
 * 为什么必须交叉校验：golden 测试比较 `evaluate(expr)` 与 `expected[expr]`，
 * 若只断言「测试通过」，Agent 可以把 expected.json 写成**当前的错误输出**，
 * 从而让测试自洽地通过。用已知正确值做交叉校验即可堵住这条作弊路径。
 */
export const HARD_GOLDEN: Record<string, number> = {
  '2 + 3 * 4': 14,
  '(2 + 3) * 4': 20,
  '10 - 2 - 3': 5,
  '-3 + 5': 2,
  '7 % 3': 1,
  '-7 % 3': 2,
  '7 % -3': -2,
  '-7 % -3': -1,
}

function hardGoldenFileCorrect(sessionId: string): Promise<boolean> {
  return Promise.resolve().then(() => {
    try {
      const got = JSON.parse(fs.readFileSync(safeResolve(sessionId, 'data/expected.json'), 'utf-8')) as Record<
        string,
        unknown
      >
      return Object.entries(HARD_GOLDEN).every(([k, v]) => Number(got[k]) === v)
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
      { name: '原有测试用例未被删减（防作弊）', check: (s) => originalTestsIntact(s) },
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
      { name: '原有测试用例未被删减（防作弊）', check: (s) => originalTestsIntact(s) },
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
      { name: '原有测试用例未被删减（防作弊）', check: (s) => originalTestsIntact(s) },
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

/**
 * held-out 任务集（SWE-bench 方法论的小规模复刻）：
 *  - 沙箱是另一个项目（stringutils），与开发调试时用的 mathutils 不同域；
 *  - 每个任务的断言 = **预先写好的测试分组的退出码**（FAIL_TO_PASS），
 *    不包含任何按实现细节写的正则，因此不能通过「迁就断言」来刷分；
 *  - 这 4 个任务不参与日常调试，只在正式评测时跑，用于检验泛化而非拟合。
 */
export const HOLDOUT_TASKS: EvalTask[] = [
  {
    id: 'ho-slugify',
    name: '[held-out] 修复 slugify 使其测试通过',
    template: 'holdout',
    holdout: true,
    prompt:
      'stringutils.js 中的 slugify 实现有缺陷，导致 stringutils.test.js 里 slugify 分组的用例失败。'
      + '请修复实现（不要修改测试文件），使 `node --test --test-name-pattern="slugify"` 通过，然后提交。',
    assertions: [{ name: 'slugify 分组测试通过', check: (s) => testsPassFor(s, 'slugify') }],
  },
  {
    id: 'ho-camelcase',
    name: '[held-out] 修复 camelCase 大小写处理',
    template: 'holdout',
    holdout: true,
    prompt:
      'stringutils.js 中的 camelCase 对后续单词的大小写处理不正确，导致相关用例失败。'
      + '请修复实现（不要修改测试文件），使 `node --test --test-name-pattern="camelCase"` 通过，然后提交。',
    assertions: [{ name: 'camelCase 分组测试通过', check: (s) => testsPassFor(s, 'camelCase') }],
  },
  {
    id: 'ho-truncate',
    name: '[held-out] 实现 truncate 函数',
    template: 'holdout',
    holdout: true,
    prompt:
      'stringutils.js 尚未实现 truncate(text, max)，README 中有其语义说明，测试文件里已有对应用例。'
      + '请实现并导出该函数（不要修改测试文件），使 `node --test --test-name-pattern="truncate"` 通过，然后提交。',
    assertions: [{ name: 'truncate 分组测试通过', check: (s) => testsPassFor(s, 'truncate') }],
  },
  {
    id: 'ho-initials',
    name: '[held-out] 实现 initials 函数',
    template: 'holdout',
    holdout: true,
    prompt:
      'stringutils.js 尚未实现 initials(text)，README 中有其语义说明，测试文件里已有对应用例。'
      + '请实现并导出该函数（不要修改测试文件），使 `node --test --test-name-pattern="initials"` 通过，然后提交。',
    assertions: [{ name: 'initials 分组测试通过', check: (s) => testsPassFor(s, 'initials') }],
  },
]

/**
 * 难任务集：在**多文件项目**（hard-project）上考察三类更接近真实工程的能力：
 *  1. hard-precedence —— 跨 lexer/parser/evaluator 定位并修复优先级缺陷（多文件追踪）
 *  2. hard-variables  —— 跨 3 个文件实现一个贯穿式特性（长链路改造）
 *  3. hard-golden     —— 期望值不在任何文件里，**必须运行参考脚本**才能获得（依赖环境反馈）
 *
 * 断言同样只取「预置测试分组的退出码」，另加两条防作弊断言：
 * 测试文件未被删改、expected.json 必须等于参考实现的真值。
 */
export const HARD_TASKS: EvalTask[] = [
  {
    id: 'hard-precedence',
    name: '[难] 修复运算符优先级与一元负号（跨文件定位）',
    template: 'hard',
    difficulty: 'hard',
    prompt:
      '表达式计算器的结果不对：`2 + 3 * 4` 得到 20（应为 14），`-3 + 5` 直接抛错。'
      + '请阅读 src/lexer.js、src/parser.js、src/evaluator.js 定位问题，'
      + '修复运算符优先级（* / % 高于 + -，同级左结合）并支持一元负号，'
      + '使 `node --test --test-name-pattern="precedence"` 通过（不要修改 test/ 下的测试文件），然后提交。',
    assertions: [
      { name: 'precedence 分组测试通过', check: (s) => testsPassFor(s, 'precedence') },
      { name: '测试文件未被删改（防作弊）', check: (s) => hardTestsIntact(s) },
    ],
  },
  {
    id: 'hard-variables',
    name: '[难] 实现变量赋值与多语句（跨 3 文件长链路）',
    template: 'hard',
    difficulty: 'hard',
    prompt:
      '表达式计算器需要支持变量：`x = 5; x * 2` 应得 10，`a = 2; b = a + 3; a * b` 应得 10。'
      + '请扩展 src/lexer.js（识别 = 与 ;）、src/parser.js（多语句与赋值语句）、'
      + 'src/evaluator.js（赋值求值与变量环境），使 `node --test --test-name-pattern="variables"` 通过'
      + '（不要修改测试文件），然后提交。',
    assertions: [
      { name: 'variables 分组测试通过', check: (s) => testsPassFor(s, 'variables') },
      { name: '测试文件未被删改（防作弊）', check: (s) => hardTestsIntact(s) },
    ],
  },
  {
    id: 'hard-golden',
    name: '[难] 生成期望值并修正取模语义（必须依赖环境反馈）',
    template: 'hard',
    difficulty: 'hard',
    prompt:
      'data/cases.json 列出了一批表达式，但期望值文件 data/expected.json 尚未生成。'
      + '期望值不在任何源码或文档中写死，只能通过运行参考实现获得：`node tools/reference.js --emit`。'
      + '请把该命令的输出写入 data/expected.json，再修正 src/evaluator.js 的取模语义'
      + '（本项目约定数学取模：结果符号跟随除数，与 JavaScript 余数不同），'
      + '使 `node --test --test-name-pattern="golden"` 通过（不要修改测试文件），然后提交。',
    assertions: [
      { name: 'expected.json 等于参考实现真值（防作弊）', check: (s) => hardGoldenFileCorrect(s) },
      { name: 'golden 分组测试通过', check: (s) => testsPassFor(s, 'golden') },
      { name: '测试文件未被删改（防作弊）', check: (s) => hardTestsIntact(s) },
    ],
  },
]

export const ALL_TASKS: EvalTask[] = [...EVAL_TASKS, ...HOLDOUT_TASKS, ...HARD_TASKS]

export function tasksByIds(ids: string[]): EvalTask[] {
  return ALL_TASKS.filter((t) => ids.includes(t.id))
}
