/**
 * 代码评审（Code Review）—— JD 第 2 条明确要求的场景之一。
 *
 * 设计要点：**两层评审，而不是全丢给 LLM**。
 *
 *   第 1 层：确定性静态检查（纯代码，零成本、可复现、不幻觉）
 *     - 改了源码但没改/没加测试
 *     - 新增了 console.log / debugger / TODO
 *     - 疑似硬编码密钥
 *     - 删除测试断言
 *     - 单次新增过大的函数
 *   第 2 层：LLM 语义评审（正确性、边界、可读性、API 设计）
 *
 * 为什么这样分：**能确定性判断的事不该问 LLM**。让模型去查 `console.log`
 * 既浪费 token 又会幻觉；反过来，判断「这个边界条件处理对不对」是 LLM 的强项。
 * 两层结果合并后统一排序，并标注来源（static / llm），便于人工判断可信度。
 */
import { runInSandbox } from './tools'

export type Severity = 'blocker' | 'major' | 'minor' | 'nit'
export type Category =
  | 'correctness'
  | 'edge-case'
  | 'security'
  | 'performance'
  | 'readability'
  | 'test'
  | 'api'

export interface ReviewFinding {
  severity: Severity
  category: Category
  file: string
  line?: number
  title: string
  detail: string
  suggestion?: string
  /** 来源：static = 确定性检查；llm = 语义评审 */
  source: 'static' | 'llm'
}

export interface DiffStats {
  files: number
  added: number
  removed: number
  changedFiles: string[]
  /** 改动是否包含源码（非测试）文件 */
  touchesSource: boolean
  /** 改动是否包含测试文件 */
  touchesTest: boolean
}

export interface ReviewResult {
  findings: ReviewFinding[]
  summary: string
  /** 0（无风险）~ 100（阻塞） */
  riskScore: number
  stats: DiffStats
  /** 是否用了 LLM（false = 只有静态检查） */
  usedLlm: boolean
  durationMs: number
}

// ===================== diff 解析 =====================

const TEST_FILE_RE = /(^|\/)(tests?|__tests__|spec)\//i
const TEST_NAME_RE = /\.(test|spec)\.[cm]?[jt]sx?$/i
/** 文档 / 配置类文件：改它们不需要配套测试 */
const DOC_FILE_RE = /\.(md|mdx|txt|rst|json|ya?ml|toml|ini|cfg)$/i
const DOC_NAME_RE = /(^|\/)(README|LICENSE|CHANGELOG|NOTICE|CODEOWNERS)(\..*)?$/i
/** 代码文件：需要测试覆盖的语言 */
const CODE_FILE_RE = /\.[cm]?[jt]sx?$/i

export function isTestFile(p: string): boolean {
  return TEST_FILE_RE.test(p) || TEST_NAME_RE.test(p)
}

/** 文档 / 配置类文件（改了它们不该要求补测试） */
export function isDocFile(p: string): boolean {
  return DOC_FILE_RE.test(p) || DOC_NAME_RE.test(p)
}

/** 需要测试覆盖的代码文件 */
export function isCodeFile(p: string): boolean {
  return CODE_FILE_RE.test(p) && !isTestFile(p) && !isDocFile(p)
}

/** 解析 unified diff，统计增删行与文件列表 */
export function parseDiffStats(diff: string): DiffStats {
  const files: string[] = []
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      files.push(line.slice(6).trim())
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      added++
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      removed++
    }
  }
  return {
    files: files.length,
    added,
    removed,
    changedFiles: files,
    // 「动了源码」= 动了**需要测试覆盖的代码文件**，不含 README/JSON/测试本身
    touchesSource: files.some(isCodeFile),
    touchesTest: files.some(isTestFile),
  }
}

/** 取出新增的行（只看 + 侧），用于静态检查 */
export function extractAddedLines(diff: string): { file: string; line: number; text: string }[] {
  const out: { file: string; line: number; text: string }[] = []
  let file = ''
  let newLine = 0
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ b/')) {
      file = raw.slice(6).trim()
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (hunk) {
      newLine = Number(hunk[1])
      continue
    }
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      out.push({ file, line: newLine, text: raw.slice(1) })
      newLine++
    } else if (!raw.startsWith('-') && !raw.startsWith('\\')) {
      newLine++
    }
  }
  return out
}

// ===================== 第 1 层：确定性静态检查 =====================

const SECRET_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\b(sk|pk)-[A-Za-z0-9]{16,}/, label: '疑似 API Key' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, label: '疑似 AWS Access Key' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: '内嵌私钥' },
  { re: /\b(password|passwd|secret|token)\s*[:=]\s*['"][^'"]{8,}['"]/i, label: '疑似硬编码凭据' },
]

/** 确定性检查：能靠代码判断的，就不要问 LLM */
export function staticChecks(diff: string): ReviewFinding[] {
  const findings: ReviewFinding[] = []
  const added = extractAddedLines(diff)
  const stats = parseDiffStats(diff)

  // 1) 改了源码但没动测试
  if (stats.touchesSource && !stats.touchesTest && stats.added > 5) {
    findings.push({
      severity: 'major',
      category: 'test',
      file: stats.changedFiles.find(isCodeFile) ?? '(多个文件)',
      title: '改了实现但没有对应的测试改动',
      detail: `本次改动了 ${stats.files} 个文件（+${stats.added}/-${stats.removed}），其中没有测试文件。`,
      suggestion: '补充或更新覆盖该改动的测试；若确实是纯重构，请在提交信息里说明。',
      source: 'static',
    })
  }

  // 2) 调试残留
  const debugHits = added.filter((l) => /\b(console\.(log|debug|warn)|debugger\b|print\()/.test(l.text))
  if (debugHits.length) {
    findings.push({
      severity: 'minor',
      category: 'readability',
      file: debugHits[0].file,
      line: debugHits[0].line,
      title: `新增了 ${debugHits.length} 处调试输出`,
      detail: debugHits.slice(0, 3).map((h) => `${h.file}:${h.line}  ${h.text.trim().slice(0, 80)}`).join('\n'),
      suggestion: '提交前清掉 console.log / debugger，或改用项目统一的日志设施。',
      source: 'static',
    })
  }

  // 3) 硬编码密钥
  for (const l of added) {
    for (const p of SECRET_PATTERNS) {
      if (p.re.test(l.text)) {
        findings.push({
          severity: 'blocker',
          category: 'security',
          file: l.file,
          line: l.line,
          title: `${p.label} 被写进代码`,
          detail: `新增行疑似包含敏感凭据：${l.text.trim().slice(0, 100)}`,
          suggestion: '改用环境变量 / 密钥管理服务；若已提交，需轮换该凭据。',
          source: 'static',
        })
        break
      }
    }
  }

  // 4) 新增 TODO/FIXME
  const todos = added.filter((l) => /\b(TODO|FIXME|XXX)\b/.test(l.text))
  if (todos.length) {
    findings.push({
      severity: 'nit',
      category: 'readability',
      file: todos[0].file,
      line: todos[0].line,
      title: `新增了 ${todos.length} 处 TODO/FIXME`,
      detail: todos.slice(0, 3).map((h) => `${h.file}:${h.line}  ${h.text.trim().slice(0, 80)}`).join('\n'),
      suggestion: '确认这些待办是有意留下的；否则补齐实现或建 issue 跟踪。',
      source: 'static',
    })
  }

  // 5) 删除测试断言（删的比加的多，且是测试文件）
  const removedTestLines = diff
    .split('\n')
    .filter((l) => l.startsWith('-') && !l.startsWith('---'))
    .filter((l) => /\b(expect|assert|toBe|toEqual|should)\b/.test(l)).length
  if (removedTestLines > 0 && stats.touchesTest) {
    findings.push({
      severity: 'major',
      category: 'test',
      file: stats.changedFiles.find(isTestFile) ?? '(测试文件)',
      title: `删除了 ${removedTestLines} 行断言`,
      detail: '本次改动从测试里移除了断言。放宽/删除断言是「让测试变绿」的常见捷径。',
      suggestion: '确认断言删除是因为实现语义变化，而不是为了让测试通过。',
      source: 'static',
    })
  }

  // 6) 空实现 / 占位
  const stubs = added.filter((l) => /throw new Error\(['"]not implemented/i.test(l.text) || /return\s+null\s*\/\/\s*TODO/i.test(l.text))
  if (stubs.length) {
    findings.push({
      severity: 'major',
      category: 'correctness',
      file: stubs[0].file,
      line: stubs[0].line,
      title: '新增了未实现的占位',
      detail: stubs.map((h) => `${h.file}:${h.line}  ${h.text.trim().slice(0, 80)}`).join('\n'),
      suggestion: '补齐实现，或明确标注为有意留空的接口。',
      source: 'static',
    })
  }

  return findings
}

// ===================== 第 2 层：LLM 语义评审 =====================

const REVIEW_SYSTEM_PROMPT = `你是一位严格的资深代码评审者（Staff Engineer 视角）。你会收到一个 unified diff。

只报告**真正值得改**的问题，不要为了凑数而挑刺。重点看：
1. **正确性**：逻辑错误、边界条件（空值 / 0 / 越界 / 并发）、off-by-one
2. **安全**：注入、路径穿越、未校验输入、权限缺失
3. **性能**：明显的 O(n²)、无谓重复计算、阻塞调用
4. **API 设计**：命名、参数顺序、错误处理是否一致
5. **可读性**：只有真正影响理解时才提

**不要**报告：纯风格偏好（缩进/引号）、你无法从 diff 判断的问题、与本次改动无关的历史问题。

输出**严格 JSON**（不要 markdown 代码块）：
{
  "summary": "两三句话的整体评价，先说结论",
  "findings": [
    {
      "severity": "blocker|major|minor|nit",
      "category": "correctness|edge-case|security|performance|readability|test|api",
      "file": "相对路径",
      "line": 12,
      "title": "一句话说清问题",
      "detail": "为什么是问题，会怎么出错",
      "suggestion": "具体怎么改"
    }
  ]
}

如果 diff 没问题，findings 返回空数组 —— **不要编造问题**。`

/** 从可能带 markdown 包裹的文本里抠出 JSON */
export function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(t.slice(start, end + 1))
  } catch {
    return null
  }
}

const VALID_SEVERITY = new Set(['blocker', 'major', 'minor', 'nit'])
const VALID_CATEGORY = new Set([
  'correctness', 'edge-case', 'security', 'performance', 'readability', 'test', 'api',
])

/** 校验并规整 LLM 返回的 findings（模型可能给出非法枚举值） */
export function normalizeLlmFindings(raw: unknown): ReviewFinding[] {
  const arr = (raw as { findings?: unknown })?.findings
  if (!Array.isArray(arr)) return []
  const out: ReviewFinding[] = []
  for (const f of arr.slice(0, 30)) {
    const o = f as Record<string, unknown>
    const title = String(o.title ?? '').trim()
    if (!title) continue
    const sev = String(o.severity ?? 'minor')
    const cat = String(o.category ?? 'correctness')
    out.push({
      severity: (VALID_SEVERITY.has(sev) ? sev : 'minor') as Severity,
      category: (VALID_CATEGORY.has(cat) ? cat : 'correctness') as Category,
      file: String(o.file ?? '(未知)'),
      line: Number.isFinite(Number(o.line)) ? Number(o.line) : undefined,
      title,
      detail: String(o.detail ?? '').trim(),
      suggestion: o.suggestion ? String(o.suggestion).trim() : undefined,
      source: 'llm',
    })
  }
  return out
}

// ===================== 风险分 =====================

const SEVERITY_WEIGHT: Record<Severity, number> = { blocker: 40, major: 15, minor: 5, nit: 1 }

/** 风险分：blocker 直接顶到 100；其余按权重累加封顶 */
export function computeRiskScore(findings: ReviewFinding[]): number {
  if (findings.some((f) => f.severity === 'blocker')) return 100
  const sum = findings.reduce((a, f) => a + SEVERITY_WEIGHT[f.severity], 0)
  return Math.min(99, sum)
}

// ===================== 主入口 =====================

export interface ReviewOptions {
  /** 对比基准，默认 HEAD（即未提交改动）；传 'HEAD~1' 可评审上一次提交 */
  base?: string
  /** 是否启用 LLM 语义评审（默认 true） */
  useLlm?: boolean
  /** 传给 LLM 的 diff 上限（字符） */
  maxDiffChars?: number
}

export async function reviewDiff(sessionId: string, opts: ReviewOptions = {}): Promise<ReviewResult> {
  const t0 = Date.now()
  const base = opts.base ?? 'HEAD'

  const { stdout: diff, stderr, code } = await runInSandbox(sessionId, [
    'git', 'diff', base, '--unified=3',
  ])
  if (code !== 0) {
    return {
      findings: [],
      summary: `无法获取 diff：${stderr || 'git diff 失败'}`,
      riskScore: 0,
      stats: { files: 0, added: 0, removed: 0, changedFiles: [], touchesSource: false, touchesTest: false },
      usedLlm: false,
      durationMs: Date.now() - t0,
    }
  }

  const stats = parseDiffStats(diff)
  if (!diff.trim()) {
    return {
      findings: [],
      summary: '工作区没有改动，无需评审。',
      riskScore: 0,
      stats,
      usedLlm: false,
      durationMs: Date.now() - t0,
    }
  }

  // 第 1 层：确定性检查
  const findings = staticChecks(diff)
  let summary = ''
  let usedLlm = false

  // 第 2 层：LLM 语义评审
  if (opts.useLlm !== false) {
    try {
      const { chatStream } = await import('./llm')
      const res = await chatStream(
        [
          { role: 'system', content: REVIEW_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `请评审以下 diff（共 ${stats.files} 个文件，+${stats.added}/-${stats.removed}）：\n\n${diff.slice(0, opts.maxDiffChars ?? 40_000)}`,
          },
        ],
        undefined,
        {},
        { enableThinking: false },
      )
      const parsed = extractJson(res.content)
      if (parsed) {
        findings.push(...normalizeLlmFindings(parsed))
        summary = String((parsed as { summary?: unknown }).summary ?? '').trim()
        usedLlm = true
      }
    } catch {
      // LLM 不可用 → 只返回静态检查结果（评审仍然可用，只是少了语义层）
      summary = '（LLM 语义评审不可用，以下仅为确定性静态检查结果）'
    }
  }

  // 排序：严重度优先，同级别 static 在前（更可信）
  const order: Record<Severity, number> = { blocker: 0, major: 1, minor: 2, nit: 3 }
  findings.sort((a, b) => order[a.severity] - order[b.severity] || (a.source === 'static' ? -1 : 1))

  if (!summary) {
    summary = findings.length
      ? `共发现 ${findings.length} 个问题（其中 ${findings.filter((f) => f.severity === 'blocker').length} 个阻塞级）。`
      : '未发现明显问题。'
  }

  return {
    findings,
    summary,
    riskScore: computeRiskScore(findings),
    stats,
    usedLlm,
    durationMs: Date.now() - t0,
  }
}

/** 渲染成给 Agent / 终端看的文本 */
export function formatReview(r: ReviewResult): string {
  const icon: Record<Severity, string> = { blocker: '🛑', major: '⚠️', minor: '·', nit: '💬' }
  const lines = [
    `代码评审结果（风险分 ${r.riskScore}/100，${r.findings.length} 个问题）`,
    `改动：${r.stats.files} 个文件，+${r.stats.added}/-${r.stats.removed}`,
    '',
    r.summary,
  ]
  if (r.findings.length) {
    lines.push('')
    for (const f of r.findings) {
      lines.push(
        `${icon[f.severity]} [${f.severity}/${f.category}] ${f.file}${f.line ? `:${f.line}` : ''} — ${f.title}（${f.source}）`,
      )
      if (f.detail) lines.push(`    ${f.detail.replace(/\n/g, '\n    ')}`)
      if (f.suggestion) lines.push(`    → ${f.suggestion}`)
    }
  }
  if (!r.usedLlm) lines.push('', '（注：本次未使用 LLM 语义评审）')
  return lines.join('\n')
}
