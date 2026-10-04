/**
 * 真实任务清单（种子）。
 *
 * 每一条都指向**真实仓库的真实修复提交**，FAIL_TO_PASS / PASS_TO_PASS
 * 由 `builder.ts` 在构建时**机器推导并验证**，不是手写期望值。
 *
 * 收录标准（三条都要满足，缺一不可）：
 *  1. 仓库是真实开源项目（不是本项目的玩具模板）
 *  2. 修复提交同时改了源码与测试 → 能推导出非空 FAIL_TO_PASS
 *  3. 构建时两阶段验证通过（base 上失败、套用参考解后全通过）
 *
 * 已用 `scripts/bench-build.ts` 扫描验证过：
 *  cel-js 与 proxy-from-env 上共 9 个提交满足条件，这里收录其中 6 个。
 */
import type { Difficulty, TaskCategory } from './types'

export interface TaskSeed {
  id: string
  repo: string
  /** 真实修复提交（参考解来源；不暴露给 Agent） */
  fixCommit: string
  category: TaskCategory
  difficulty: Difficulty
  /**
   * 任务描述来源：
   *  - issue：直接用真实 issue 标题 + 正文（首选，issue 写在修复之前，不泄露解法）
   *  - neutral：没有对应 issue，按改动范围中性改写（严禁包含解法）
   */
  promptSource: { kind: 'issue'; issueNumber: number } | { kind: 'neutral'; text: string }
  /** 测试命令构造：默认直接把改动的测试文件喂给 node --test */
  testArgs?: (testFiles: string[]) => string[]
  /** 期望用到的工具（用于「工具使用正确性」维度） */
  requiredTools?: string[]
  maxSteps?: number
  /** 模型训练截止时间：早于它的任务存在污染风险 */
  modelCutoff?: string
  note?: string
}

/** 这些任务对应的模型训练截止（保守取值；晚于此时间的提交视为未污染） */
const CUTOFF = '2025-06-01'

export const TASK_SEEDS: TaskSeed[] = [
  {
    id: 'pfe-whatwg-url',
    repo: 'Rob--W/proxy-from-env',
    fixCommit: 'e32b37e7df',
    category: 'bug-fix',
    difficulty: 'medium',
    promptSource: { kind: 'issue', issueNumber: 32 },
    requiredTools: ['read_file', 'edit_file'],
    maxSteps: 20,
    modelCutoff: CUTOFF,
    note: '真实 issue #32：用 WHATWG URL 替换已废弃的 url.parse。修复提交同时改了 index.js 与 test.js。',
  },
  {
    id: 'pfe-drop-npm-config',
    repo: 'Rob--W/proxy-from-env',
    fixCommit: '00ac7ff5c3',
    category: 'bug-fix',
    difficulty: 'medium',
    promptSource: { kind: 'issue', issueNumber: 13 },
    requiredTools: ['read_file', 'edit_file'],
    maxSteps: 20,
    modelCutoff: CUTOFF,
    note: '真实 issue #13：npm_config_* 前缀的优先级问题，修复为不再支持该前缀。',
  },
  {
    id: 'pfe-esm-migration',
    repo: 'Rob--W/proxy-from-env',
    fixCommit: '7c0264eb15',
    category: 'refactor',
    difficulty: 'medium',
    promptSource: { kind: 'issue', issueNumber: 18 },
    requiredTools: ['read_file', 'edit_file'],
    maxSteps: 20,
    modelCutoff: CUTOFF,
    note: '真实 issue #18：ESM 导入报错，修复为迁移到 ESM。PASS_TO_PASS 为 0（测试文件整体重写）。',
  },
  {
    id: 'celjs-source-ranges',
    repo: 'marcbachmann/cel-js',
    fixCommit: '0e8f13b102',
    category: 'feature',
    difficulty: 'hard',
    promptSource: { kind: 'issue', issueNumber: 90 },
    requiredTools: ['read_file', 'edit_file', 'run_tests'],
    maxSteps: 30,
    modelCutoff: CUTOFF,
    note: '真实 issue #90：为 AST 节点加上稳定的 source range。跨 parser/AST 多文件改动。',
  },
  {
    id: 'celjs-error-compat',
    repo: 'marcbachmann/cel-js',
    fixCommit: '1af976d8c4',
    category: 'bug-fix',
    difficulty: 'hard',
    promptSource: {
      kind: 'neutral',
      text: [
        'cel-js 的错误处理改动引入了一处**向后兼容回归**，并且导出的类型定义与实际行为不一致。',
        '具体现象：自定义类型注册、类型检查（type checking）以及属性访问（property access）相关的既有用法会失败。',
        '',
        '请定位问题并修复，使仓库现有测试全部通过。不要修改测试文件。',
      ].join('\n'),
    },
    requiredTools: ['read_file', 'edit_file', 'run_tests'],
    maxSteps: 30,
    modelCutoff: CUTOFF,
    note: '无对应 issue，按改动范围中性改写。FAIL_TO_PASS=4，PASS_TO_PASS=106（回归面很大）。',
  },
  {
    id: 'celjs-diagnostics',
    repo: 'marcbachmann/cel-js',
    fixCommit: '795b6929b5',
    category: 'feature',
    difficulty: 'hard',
    promptSource: {
      kind: 'neutral',
      text: [
        'cel-js 的错误对象目前信息不足：调用方拿不到结构化的诊断信息，',
        '也无法在求值失败时把 AST 位置信息带上。',
        '',
        '请实现结构化诊断：让错误可以携带诊断元数据，并在运行时求值错误上附加 AST 元数据，',
        '同时保留普通对象形式的 cause。完成后仓库测试应当全部通过，不要修改测试文件。',
      ].join('\n'),
    },
    requiredTools: ['read_file', 'edit_file', 'run_tests'],
    maxSteps: 30,
    modelCutoff: CUTOFF,
    note: '无对应 issue，中性改写自提交范围。FAIL_TO_PASS=7。',
  },
]

export function findSeed(id: string): TaskSeed | undefined {
  return TASK_SEEDS.find((s) => s.id === id)
}
