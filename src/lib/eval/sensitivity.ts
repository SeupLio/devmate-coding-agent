/**
 * 评测灵敏度检查（evaluator sensitivity / mutation testing）。
 *
 * 目的：回答「你的评测会不会太松？」—— 通过率本身无法回答这个问题，
 * 但把「已知正确的参考解」故意破坏成若干退化/作弊版本，
 * 再跑一遍评测断言，就能直接量化「评测能不能抓到错」。
 *
 * 检出率 100% = 评测对该类缺陷敏感；
 * 任何一个变异体没被检出 = 评测存在盲区，必须修断言而不是修结论。
 *
 * 全程不调用 LLM，秒级完成，可随时重跑。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createWorkspace, newRunId, safeResolve } from '@/lib/agent/workspace'
import { ALL_TASKS, HARD_GOLDEN, type EvalTask } from './tasks'

const REFERENCE_DIR = path.join(process.cwd(), 'assets', 'reference-solution')
const HARD_TEMPLATE_DIR = path.join(process.cwd(), 'assets', 'hard-project')
const HARD_REF_SRC = path.join(process.cwd(), 'assets', 'hard-reference', 'src')

export interface Mutant {
  id: string
  name: string
  /** 缺陷类别：作弊类 / 逻辑退化类 */
  kind: 'cheat' | 'regression'
  /** 所属模板：default（mathutils）/ hard（多文件计算器） */
  template?: 'default' | 'hard'
  /** 说明这个变异体模拟什么 */
  note: string
  /** 期望被哪个任务的断言检出 */
  targetTaskId: string
  /** 应用到沙箱 */
  apply: (sid: string) => void
}

function write(sid: string, rel: string, content: string) {
  const p = safeResolve(sid, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}

function read(sid: string, rel: string): string {
  return fs.readFileSync(safeResolve(sid, rel), 'utf-8')
}

/** 用参考解初始化沙箱（已知正确答案） */
function seedReference(sid: string, template: 'default' | 'hard' = 'default') {
  if (template === 'hard') {
    createWorkspace(sid, HARD_TEMPLATE_DIR)
    for (const f of ['lexer.js', 'parser.js', 'evaluator.js', 'index.js']) {
      fs.copyFileSync(path.join(HARD_REF_SRC, f), safeResolve(sid, `src/${f}`))
    }
    write(sid, 'data/expected.json', JSON.stringify(HARD_GOLDEN, null, 2))
    return
  }
  createWorkspace(sid)
  for (const f of ['mathutils.js', 'mathutils.test.js', 'README.md']) {
    write(sid, f, fs.readFileSync(path.join(REFERENCE_DIR, f), 'utf-8'))
  }
}

export const MUTANTS: Mutant[] = [
  {
    id: 'cheat-empty-tests',
    name: '删空测试文件（只留一个恒过用例）',
    kind: 'cheat',
    note: 'Agent 无法修复时，最省事的作弊方式：让测试不再检验任何东西',
    targetTaskId: 'fix-bug',
    apply: (sid) => {
      write(sid, 'mathutils.test.js', `const test = require('node:test')\ntest('ok', () => {})\n`)
    },
  },
  {
    id: 'cheat-strip-asserts',
    name: '保留测试名但删掉全部 assert',
    kind: 'cheat',
    note: '保留 test() 外壳、清空断言体，比删文件更隐蔽',
    targetTaskId: 'fix-bug',
    apply: (sid) => {
      const src = read(sid, 'mathutils.test.js')
      write(sid, 'mathutils.test.js', src.replace(/assert\.[A-Za-z]+\(/g, 'void ('))
    },
  },
  {
    id: 'off-by-one',
    name: 'average 分母 off-by-one',
    kind: 'regression',
    note: '经典边界缺陷：分母写成 nums.length - 1',
    targetTaskId: 'fix-bug',
    apply: (sid) => {
      const src = read(sid, 'mathutils.js')
      write(sid, 'mathutils.js', src.replace('sum(nums) / nums.length', 'sum(nums) / (nums.length - 1)'))
    },
  },
  {
    id: 'remove-export',
    name: 'maxOf 未导出',
    kind: 'regression',
    note: '实现正确但忘了加进 module.exports',
    targetTaskId: 'fix-bug',
    apply: (sid) => {
      const src = read(sid, 'mathutils.js')
      write(sid, 'mathutils.js', src.replace('module.exports = { sum, average, fibonacci, maxOf, clamp }', 'module.exports = { sum, average, fibonacci, clamp }'))
    },
  },
  {
    id: 'recursive-fib',
    name: 'fibonacci 改回朴素递归',
    kind: 'regression',
    note: '功能正确但性能退化，靠性能断言检出',
    targetTaskId: 'perf-refactor',
    apply: (sid) => {
      const src = read(sid, 'mathutils.js')
      const bad = `function fibonacci(n) {
  if (n <= 1) return n
  return fibonacci(n - 1) + fibonacci(n - 2)
}`
      write(sid, 'mathutils.js', src.replace(/function fibonacci\(n\) \{[\s\S]*?\n\}/, bad))
    },
  },
  {
    id: 'clamp-missing-upper',
    name: 'clamp 只夹下界、漏掉上界',
    kind: 'regression',
    note: '常见遗漏：只写了 x < lo 的分支，上界完全不生效',
    targetTaskId: 'add-feature',
    apply: (sid) => {
      const src = read(sid, 'mathutils.js')
      const bad = `function clamp(x, lo, hi) {
  if (x < lo) return lo
  return x
}`
      write(sid, 'mathutils.js', src.replace(/function clamp\(x, lo, hi\) \{[\s\S]*?\n\}/, bad))
    },
  },
  {
    id: 'clamp-swap-bounds',
    name: 'clamp 上下界返回反了',
    kind: 'regression',
    note: '复制粘贴错误：x < lo 时返回 hi',
    targetTaskId: 'add-feature',
    apply: (sid) => {
      const src = read(sid, 'mathutils.js')
      write(sid, 'mathutils.js', src.replace('if (x < lo) return lo', 'if (x < lo) return hi'))
    },
  },

  // ===== 难任务项目（hard-project）的变异体 =====
  {
    id: 'hard-eq-precedence',
    name: '[难] 所有运算符同级（原优先级缺陷）',
    kind: 'regression',
    template: 'hard',
    note: '把 PRECEDENCE 全改成 1，于是 2 + 3 * 4 被算成 (2+3)*4 = 20',
    targetTaskId: 'hard-precedence',
    apply: (sid) => {
      const src = read(sid, 'src/parser.js')
      write(
        sid,
        'src/parser.js',
        src.replace(
          /const PRECEDENCE = \{[^}]*\}/,
          'const PRECEDENCE = { "+": 1, "-": 1, "*": 1, "/": 1, "%": 1 }',
        ),
      )
    },
  },
  {
    id: 'hard-no-unary',
    name: '[难] 去掉一元负号处理',
    kind: 'regression',
    template: 'hard',
    note: 'parseUnary 不再识别前缀 -，`-3 + 5` 直接抛错',
    targetTaskId: 'hard-precedence',
    apply: (sid) => {
      const src = read(sid, 'src/parser.js')
      write(sid, 'src/parser.js', src.replace(/if \(peek\(\)\.type === 'op' && \(peek\(\)\.value === '-' \|\| peek\(\)\.value === '\+'\)\) \{/, 'if (false) {'))
    },
  },
  {
    id: 'hard-js-modulo',
    name: '[难] 用 JS 余数代替数学取模',
    kind: 'regression',
    template: 'hard',
    note: '-7 % 3 得到 -1，而期望是 2',
    targetTaskId: 'hard-golden',
    apply: (sid) => {
      const src = read(sid, 'src/evaluator.js')
      write(sid, 'src/evaluator.js', src.replace(/return \(\(a % b\) \+ b\) % b/, 'return a % b'))
    },
  },
  {
    id: 'hard-cheat-golden',
    name: '[难] 伪造 expected.json 使其自洽',
    kind: 'cheat',
    template: 'hard',
    note: '同时植入 JS 余数缺陷并把 expected.json 写成与缺陷一致的值 —— golden 测试会「通过」，只有防作弊断言能拦住',
    targetTaskId: 'hard-golden',
    apply: (sid) => {
      const src = read(sid, 'src/evaluator.js')
      write(sid, 'src/evaluator.js', src.replace(/return \(\(a % b\) \+ b\) % b/, 'return a % b'))
      const selfConsistent = {
        '2 + 3 * 4': 14,
        '(2 + 3) * 4': 20,
        '10 - 2 - 3': 5,
        '-3 + 5': 2,
        '7 % 3': 1,
        '-7 % 3': -1,
        '7 % -3': 1,
        '-7 % -3': -1,
      }
      write(sid, 'data/expected.json', JSON.stringify(selfConsistent, null, 2))
    },
  },
]

/**
 * 说明：变异测试必须做「等价变异体」判别。
 * 最初写的 `x < lo` → `x <= lo` 变异体在 1200+ 组输入下与原实现输出完全一致
 * （对 x == lo，两个分支返回同一个值），属于语义等价的变异体，
 * 若把它计入分母会**误判评测存在盲区**。等价变异体应被剔除，而不是改断言去迎合。
 */
export const EQUIVALENT_MUTANT_NOTE =
  '已剔除等价变异体 1 个（clamp 的 `<` → `<=`，对全部输入语义等价，非评测盲区）'

export interface SensitivityResult {
  mutantId: string
  name: string
  kind: Mutant['kind']
  note: string
  targetTaskId: string
  detected: boolean
  failedAssertions: string[]
}

export interface SensitivityReport {
  baselinePassed: boolean
  baselineDetail: string
  total: number
  detected: number
  detectionRate: number
  byKind: Record<string, { total: number; detected: number }>
  results: SensitivityResult[]
}

async function runAssertions(task: EvalTask, sid: string) {
  const out: { name: string; passed: boolean }[] = []
  for (const a of task.assertions) {
    let passed = false
    try {
      passed = await a.check(sid)
    } catch {
      passed = false
    }
    out.push({ name: a.name, passed })
  }
  return out
}

export async function checkSensitivity(): Promise<SensitivityReport> {
  const taskById = (id: string) => ALL_TASKS.find((t) => t.id === id)!

  // ===== 基线：参考解应当让所有断言通过，否则实验前提不成立 =====
  // 默认模板（mathutils）与难任务模板（hard-project）各建一个参考沙箱；
  // holdout 集没有配套参考解，不参与基线。
  const baseSid = `sens-base-${newRunId()}`
  seedReference(baseSid, 'default')
  const hardBaseSid = `sens-hardbase-${newRunId()}`
  seedReference(hardBaseSid, 'hard')

  const baseResults: string[] = []
  let baselinePassed = true
  for (const task of ALL_TASKS.filter((t) => t.template !== 'holdout')) {
    const sid = task.template === 'hard' ? hardBaseSid : baseSid
    const rs = await runAssertions(task, sid)
    const ok = rs.every((r) => r.passed)
    if (!ok) baselinePassed = false
    baseResults.push(`${task.id}: ${ok ? '全部通过' : '存在失败 → ' + rs.filter((r) => !r.passed).map((r) => r.name).join('、')}`)
  }

  // ===== 逐个变异体：期望被目标任务的断言检出 =====
  const results: SensitivityResult[] = []
  for (const m of MUTANTS) {
    const sid = `sens-${m.id}-${newRunId()}`
    seedReference(sid, m.template ?? 'default')
    m.apply(sid)
    const rs = await runAssertions(taskById(m.targetTaskId), sid)
    const failedAssertions = rs.filter((r) => !r.passed).map((r) => r.name)
    results.push({
      mutantId: m.id,
      name: m.name,
      kind: m.kind,
      note: m.note,
      targetTaskId: m.targetTaskId,
      detected: failedAssertions.length > 0,
      failedAssertions,
    })
  }

  const byKind: Record<string, { total: number; detected: number }> = {}
  for (const r of results) {
    byKind[r.kind] ??= { total: 0, detected: 0 }
    byKind[r.kind].total++
    if (r.detected) byKind[r.kind].detected++
  }

  const detected = results.filter((r) => r.detected).length
  return {
    baselinePassed,
    baselineDetail: baseResults.join('｜'),
    total: results.length,
    detected,
    detectionRate: results.length ? Number(((detected / results.length) * 100).toFixed(1)) : 0,
    byKind,
    results,
  }
}

export function renderSensitivity(r: SensitivityReport): string {
  const L: string[] = []
  L.push('')
  L.push('='.repeat(88))
  L.push('DevMate 评测灵敏度检查（把已知正确的参考解故意破坏，看评测能否抓到）')
  L.push('='.repeat(88))
  L.push(`基线（参考解）：${r.baselinePassed ? '✓ 全部断言通过' : '✗ 存在失败'}`)
  L.push(`  ${r.baselineDetail}`)
  L.push('')
  L.push(`检出率：${r.detectionRate}%（${r.detected}/${r.total}）`)
  for (const [kind, s] of Object.entries(r.byKind)) {
    L.push(`  ${kind === 'cheat' ? '作弊类' : '逻辑退化类'}：${s.detected}/${s.total}`)
  }
  L.push('')
  L.push(['变异体', '类别', '检出', '触发的失败断言'].join('\t'))
  for (const x of r.results) {
    L.push([x.name, x.kind === 'cheat' ? '作弊' : '退化', x.detected ? '✓' : '✗ 盲区', x.failedAssertions.join(' / ') || '（无断言失败）'].join('\t'))
  }
  L.push('='.repeat(88))
  return L.join('\n')
}
