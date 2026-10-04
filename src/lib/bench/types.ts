/**
 * 基准测试的任务模型与结果模型。
 *
 * 设计目标（对应五条原则）：
 *  - **真实性**：`provenance` 强制记录任务出处（真实 issue / 仓库 / commit），
 *    自造任务必须显式标注为 `synthetic`，不能冒充真实任务。
 *  - **可验证性**：`verification.mode` 明确写出验证方式；
 *    `tests` 用 FAIL_TO_PASS / PASS_TO_PASS（可自动判定），
 *    开放式任务走 `llm-judge`（必须给出 rubric）。
 *  - **防泄露**：`provenance.collectedAt` + `modelCutoff` 支持**时间切分**；
 *    `hiddenTests` 只在评测侧拉取，**不写入 Agent 沙箱**。
 *  - **多维度**：结果模型分 success / toolUse / efficiency / safety / reasoning 五维，
 *    而不是只报一个通过率。
 *  - **抗游戏性**：隐藏测试 + 变异体自检 + 多样化任务池（见 sensitivity.ts）。
 */

export type TaskCategory =
  | 'bug-fix'
  | 'feature'
  | 'refactor'
  | 'perf'
  | 'docs'
  | 'analysis'
  | 'doc-gen'

export type Difficulty = 'easy' | 'medium' | 'hard'

/** 任务出处。真实性靠这个字段可审计。 */
export interface TaskProvenance {
  /**
   *  - `real-issue`：真实仓库的真实 issue 原文（最强）
   *  - `real-commit`：真实仓库的真实修复提交，但**没有对应 issue**，
   *     任务描述由改动范围中性改写（不含解法）
   *  - `synthetic`：自造任务（必须显式标注，不得冒充真实任务）
   */
  kind: 'real-issue' | 'real-commit' | 'synthetic'
  repo: string
  /** 任务开始时的代码状态（修复提交的父提交） */
  baseCommit: string
  /** 真实修复提交（参考解来源，不暴露给 Agent） */
  fixCommit?: string
  issueNumber?: number
  issueUrl?: string
  /** 采集时间：用于「只用采集晚于模型训练截止的数据」这类时间切分 */
  collectedAt: string
  /** 该任务对应的模型训练截止时间（早于 collectedAt 视为未污染） */
  modelCutoff?: string
  license?: string
  /** 人工备注：这条任务为什么算真实、难点在哪 */
  note?: string
}

/** 环境准备与测试命令 */
export interface TaskSetup {
  /** 需要在任务沙箱里预先执行的准备命令（如 npm install），由 harness 执行，不是 Agent */
  prepare?: string[][]
  /** 测试命令（不含测试文件名，由 harness 追加具体测试文件） */
  testCommand: string[]
}

export type VerificationMode = 'tests' | 'llm-judge' | 'file-assert'

export interface TaskVerification {
  mode: VerificationMode
  /** 修复前必须失败、修复后必须通过（SWE-bench 的核心判据） */
  failToPass?: string[]
  /** 修复前后都必须通过（防回归） */
  passToPass?: string[]
  /** 参考解改动的文件（仅评测侧统计用，不写入沙箱） */
  goldPatchFiles?: string[]
  /** llm-judge 的评分标准 */
  rubric?: string[]
  /** file-assert 的断言 */
  fileAsserts?: { path: string; contains?: string[]; regex?: string }[]
}

export interface BenchTask {
  id: string
  /** 交给 Agent 的任务描述。真实任务优先直接用 issue 原文 */
  prompt: string
  category: TaskCategory
  difficulty: Difficulty
  provenance: TaskProvenance
  setup: TaskSetup
  verification: TaskVerification
  /** 期望用到的工具（用于「工具使用正确性」维度） */
  requiredTools?: string[]
  maxSteps?: number
  budget?: { maxTokens?: number; maxSeconds?: number }
  /**
   * 隐藏测试：评测时才从远端拉取并覆盖到沙箱（Agent 全程看不到）。
   * 这是抗游戏性的关键 —— 测试不在沙箱里，就没法针对断言写死。
   */
  hiddenTests?: { path: string; ref: string }[]
}

// ===================== 结果模型 =====================

export interface ToolUseScore {
  /** 0-1 */
  score: number
  used: string[]
  /** requiredTools 里没用到的 */
  missing: string[]
  /** 未声明却大量使用的工具（可疑：绕路） */
  unexpected: string[]
  /** 工具报错次数 */
  erroredCalls: number
}

export interface EfficiencyScore {
  steps: number
  toolCalls: number
  tokens: number
  ms: number
  /** 是否超出任务预算 */
  overBudget: boolean
}

export interface SafetyScore {
  /** 0-1，初始 1，每次违规扣分 */
  score: number
  violations: string[]
}

export interface ReasoningScore {
  /** 0-1 */
  score: number
  rationale: string
  /** 由 LLM judge 给出 */
  judged: boolean
}

export interface DimensionScores {
  taskSuccess: boolean
  toolUse: ToolUseScore
  efficiency: EfficiencyScore
  safety: SafetyScore
  reasoning?: ReasoningScore
}

export interface BenchRunResult {
  taskId: string
  category: TaskCategory
  difficulty: Difficulty
  provenanceKind: TaskProvenance['kind']
  success: boolean
  dimensions: DimensionScores
  /** 失败模式（复用 eval/failure-modes 的分类） */
  failureMode: string
  failureEvidence: string[]
  /** 失败/通过的具体断言明细 */
  assertions: { name: string; ok: boolean; detail?: string }[]
  /** 是否被判定为「可能已污染」（任务时间早于模型训练截止） */
  contaminationRisk: boolean
}
