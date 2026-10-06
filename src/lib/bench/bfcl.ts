/**
 * BFCL（Berkeley Function Calling Leaderboard）评测适配层。
 *
 * ## 为什么用 BFCL
 *
 * 之前项目里的评测（`benchmarks/real-tasks.json`）虽然是从真实提交机械推导的，
 * 但**任务是我自己挑的** —— 属于「自选用例」。BFCL 是伯克利发布的
 * **函数调用权威基准**，题目和标准答案都由外部定义，我只负责跑和判分。
 *
 * 数据来源：`github.com/ShishirPatil/gorilla`（`berkeley-function-call-leaderboard/bfcl_eval/data/`）
 *
 * ## 格式
 *
 * 题目（JSONL，每行一条）：
 * ```json
 * { "id": "parallel_0",
 *   "question": [[{"role":"user","content":"..."}]],
 *   "function": [{"name":"spotify.play","parameters":{"type":"dict","properties":{...}}}] }
 * ```
 * 标准答案（另一个 JSONL）：
 * ```json
 * { "id": "parallel_0",
 *   "ground_truth": [{"spotify.play": {"artist": ["Taylor Swift"], "duration": [20]}}] }
 * ```
 * `ground_truth: null` 表示**不应该调用任何函数**（irrelevance 类）。
 *
 * ⚠️ 注意每个参数的值是一个**可选值列表**（"possible answers"），
 * 命中其中之一即算对 —— 这是 BFCL 为了容忍语义等价表达而设计的。
 *
 * ## 与官方 checker 的差异（诚实说明）
 *
 * 官方用的是完整的 AST 匹配器（`bfcl_eval/eval_checker/`，约 2k 行 Python），
 * 支持嵌套对象、可选参数、`""` 通配等复杂规则。这里实现的是**核心子集**：
 * 函数名精确匹配 + 参数值落在允许列表内（含类型归一化）。
 * 对 simple / multiple / parallel / irrelevance 四类足够；**不覆盖 multi-turn 类**。
 */

export interface BfclFunction {
  name: string
  description?: string
  parameters?: Record<string, unknown>
}

export interface BfclItem {
  id: string
  question: { role: string; content: string }[][]
  function: BfclFunction[]
}

/**
 * 标准答案：**一个数组，每个元素代表「一次函数调用」**。
 * 键是函数名，值是该调用各参数的可选值列表。
 *
 * ```json
 * [{"spotify.play": {"artist": ["Taylor Swift"], "duration": [20]}}]
 * ```
 * `null` 表示不应该调用任何函数。
 */
export type BfclGroundTruth = Record<string, Record<string, unknown[]>>[] | null

export interface BfclCase {
  item: BfclItem
  groundTruth: BfclGroundTruth
  category: string
}

export interface ProducedCall {
  name: string
  args: Record<string, unknown>
}

export interface GradeResult {
  pass: boolean
  /** 逐项说明，便于人工复核判分是否合理 */
  detail: string
}

// ===================== 加载 =====================

/** 解析 JSONL（BFCL 的 .json 文件其实是每行一个 JSON 对象） */
export function parseJsonl(text: string): unknown[] {
  const out: unknown[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t))
    } catch {
      /* 跳过坏行 */
    }
  }
  return out
}

export function indexById(rows: unknown[], key = 'id'): Map<string, Record<string, unknown>> {
  const m = new Map<string, Record<string, unknown>>()
  for (const r of rows) {
    const o = r as Record<string, unknown>
    const id = String(o[key] ?? '')
    if (id) m.set(id, o)
  }
  return m
}

/** 把题目与标准答案按 id 配对 */
export function buildCases(
  questionRows: unknown[],
  answerRows: unknown[],
  category: string,
): BfclCase[] {
  const answers = indexById(answerRows)
  const cases: BfclCase[] = []
  for (const q of questionRows) {
    const item = q as unknown as BfclItem
    if (!item?.id) continue
    const a = answers.get(item.id)
    // 答案缺失或显式为 null 都表示「不应调用函数」
    const gt = (a?.ground_truth ?? null) as BfclGroundTruth
    cases.push({ item, groundTruth: gt, category })
  }
  return cases
}

// ===================== schema 转换 =====================

/**
 * BFCL 的 schema 用的是 Python 风格类型名（`dict` / `String` / `float`），
 * 需要归一化成 JSON Schema，才能喂给 OpenAI 风格的 function calling。
 */
export function normalizeType(t: unknown): string {
  const s = String(t ?? '').toLowerCase()
  if (s === 'dict' || s === 'dictionary' || s === 'object') return 'object'
  if (s === 'array' || s === 'list' || s === 'tuple') return 'array'
  if (s === 'string' || s === 'str') return 'string'
  if (s === 'integer' || s === 'int') return 'integer'
  if (s === 'float' || s === 'number' || s === 'double') return 'number'
  if (s === 'boolean' || s === 'bool') return 'boolean'
  if (s === 'any') return 'string'
  return s || 'string'
}

function normalizeSchema(node: unknown): Record<string, unknown> {
  if (!node || typeof node !== 'object') return { type: 'string' }
  const o = { ...(node as Record<string, unknown>) }
  if (o.type) o.type = normalizeType(o.type)
  if (o.properties && typeof o.properties === 'object') {
    const props: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(o.properties as Record<string, unknown>)) {
      props[k] = normalizeSchema(v)
    }
    o.properties = props
  }
  if (o.items) o.items = normalizeSchema(o.items)
  return o
}

/** BFCL 函数定义 → OpenAI tool 定义 */
export function toOpenAiTools(fns: BfclFunction[]): {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}[] {
  return (fns ?? []).map((f) => ({
    type: 'function' as const,
    function: {
      name: f.name,
      description: f.description ?? '',
      parameters: normalizeSchema(f.parameters ?? { type: 'object', properties: {} }),
    },
  }))
}

/** 取最后一条 user 消息作为问题（BFCL 的 question 是「多轮数组」的数组，这里取单轮场景） */
export function extractUserQuery(item: BfclItem): string {
  const turns = item.question?.[0] ?? []
  const users = turns.filter((t) => t.role === 'user')
  return users.length ? users[users.length - 1].content : ''
}

// ===================== 判分 =====================

/** 值归一化：数字统一成 number，字符串去空白，便于宽松比较 */
export function normalizeValue(v: unknown): unknown {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') {
    const t = v.trim()
    // 纯数字字符串按数字比（模型常把 20 输出成 "20"）
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
    if (t === 'true') return true
    if (t === 'false') return false
    return t
  }
  if (Array.isArray(v)) return v.map(normalizeValue)
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = normalizeValue(val)
    return o
  }
  return v
}

function deepEqual(a: unknown, b: unknown): boolean {
  const na = normalizeValue(a)
  const nb = normalizeValue(b)
  if (typeof na === 'number' && typeof nb === 'number') return Math.abs(na - nb) < 1e-9
  if (Array.isArray(na) && Array.isArray(nb)) {
    return na.length === nb.length && na.every((x, i) => deepEqual(x, nb[i]))
  }
  if (na && nb && typeof na === 'object' && typeof nb === 'object') {
    const ka = Object.keys(na as object).sort()
    const kb = Object.keys(nb as object).sort()
    if (ka.length !== kb.length || ka.join() !== kb.join()) return false
    return ka.every((k) =>
      deepEqual((na as Record<string, unknown>)[k], (nb as Record<string, unknown>)[k]),
    )
  }
  return na === nb
}

/** 一个参数值是否落在允许列表里 */
export function valueAllowed(produced: unknown, allowed: unknown[]): boolean {
  if (!Array.isArray(allowed)) return false
  return allowed.some((a) => {
    // 官方 checker 里 "" 表示「任意值」
    if (a === '') return true
    return deepEqual(produced, a)
  })
}

/**
 * 判定单个函数调用是否匹配标准答案里的某一项。
 * 要求：函数名一致 + 标准答案里出现的**每个参数**都命中允许值。
 * （标准答案没列出的参数不追究 —— 与官方 checker 的宽松策略一致）
 */
export function callMatches(
  produced: ProducedCall,
  expected: Record<string, unknown[]>,
): boolean {
  const pa = normalizeValue(produced.args) as Record<string, unknown>
  for (const [param, allowed] of Object.entries(expected)) {
    if (!(param in pa)) return false
    if (!valueAllowed(pa[param], allowed)) return false
  }
  return true
}

/**
 * 判分主入口。
 *
 * - `groundTruth === null` → irrelevance：**不调用任何函数**才算通过
 * - 否则：标准答案里的每个调用都要能找到一个匹配的产出调用，
 *   且产出数量不能多于标准答案（防止「全调一遍」蒙对）
 */
export function gradeCase(groundTruth: BfclGroundTruth, produced: ProducedCall[]): GradeResult {
  if (groundTruth === null) {
    if (produced.length === 0) return { pass: true, detail: 'irrelevance：正确地没有调用任何函数' }
    return {
      pass: false,
      detail: `irrelevance：不该调用函数，却调用了 ${produced.map((p) => p.name).join(', ')}`,
    }
  }

  const expectedList = groundTruth
  if (!expectedList.length) {
    return { pass: produced.length === 0, detail: '标准答案为空，期望不调用' }
  }

  const used = new Set<number>()
  const unmatched: string[] = []
  for (const exp of expectedList) {
    const [fname, params] = Object.entries(exp)[0] ?? []
    if (!fname) continue
    const hit = produced.findIndex(
      (p, i) => !used.has(i) && p.name === fname && callMatches(p, (params as Record<string, unknown[]>) ?? {}),
    )
    if (hit >= 0) used.add(hit)
    else unmatched.push(fname)
  }

  if (unmatched.length) {
    return {
      pass: false,
      detail:
        `缺少/参数不符的调用：${unmatched.join(', ')}；` +
        `实际调用：${produced.map((p) => `${p.name}(${JSON.stringify(p.args)})`).join(' | ') || '(无)'}`,
    }
  }
  if (produced.length > expectedList.length) {
    return {
      pass: false,
      detail: `多调用了 ${produced.length - expectedList.length} 个函数（期望 ${expectedList.length} 个）`,
    }
  }
  return { pass: true, detail: `匹配 ${expectedList.length} 个调用` }
}

// ===================== 汇总 =====================

export interface BfclCategoryResult {
  category: string
  total: number
  passed: number
  accuracy: number
  failures: { id: string; query: string; detail: string }[]
  /** 平均工具调用数（看模型是否倾向于「多调」） */
  avgCalls: number
  durationMs: number
}

export function summarizeCategory(
  category: string,
  rows: { id: string; query: string; pass: boolean; detail: string; calls: number }[],
  durationMs: number,
): BfclCategoryResult {
  const passed = rows.filter((r) => r.pass).length
  return {
    category,
    total: rows.length,
    passed,
    accuracy: rows.length ? passed / rows.length : 0,
    failures: rows.filter((r) => !r.pass).slice(0, 10).map((r) => ({ id: r.id, query: r.query, detail: r.detail })),
    avgCalls: rows.length ? rows.reduce((a, r) => a + r.calls, 0) / rows.length : 0,
    durationMs,
  }
}
