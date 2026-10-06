/**
 * BFCL v4 评测运行器。
 *
 *   bun run bfcl                                   # 跑默认几个类别（各 50 题）
 *   bun run bfcl simple_javascript,parallel 30     # 指定类别与题量
 *   bun run bfcl parallel 20 mcp                   # 用 MCP 通道跑（验证 MCP 工具发现）
 *
 * 与项目内 `bench:run` 的区别：**题目和标准答案都来自外部权威基准（BFCL）**，
 * 不是我自己挑的用例。这才是「可被外部复核」的评测。
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  buildCases,
  extractUserQuery,
  gradeCase,
  parseJsonl,
  summarizeCategory,
  toOpenAiTools,
  type BfclCategoryResult,
  type ProducedCall,
} from '../src/lib/bench/bfcl'

const DATA = path.join(process.cwd(), 'benchmarks', 'external', 'bfcl')

const DEFAULT_CATEGORIES = ['simple_javascript', 'multiple', 'parallel', 'irrelevance']

let mcpClient: import('../src/lib/agent/mcp').McpClient | null = null

const argv = process.argv.slice(2)
const mode = argv.includes('mcp') ? 'mcp' : 'native'
const rest = argv.filter((a) => a !== 'mcp')
const categories = (rest[0] ? rest[0].split(',') : DEFAULT_CATEGORIES).map((c) => c.trim()).filter(Boolean)
const limit = Number(rest[1]) || 50

function load(category: string) {
  const qFile = path.join(DATA, `BFCL_v4_${category}.json`)
  const aFile = path.join(DATA, 'possible_answer', `BFCL_v4_${category}.json`)
  if (!fs.existsSync(qFile) || !fs.existsSync(aFile)) return null
  return buildCases(
    parseJsonl(fs.readFileSync(qFile, 'utf-8')),
    parseJsonl(fs.readFileSync(aFile, 'utf-8')),
    category,
  )
}

/** 用原生 OpenAI 风格工具跑一题 */
async function runNative(tools: ReturnType<typeof toOpenAiTools>, query: string): Promise<ProducedCall[]> {
  const { chatStream } = await import('../src/lib/agent/llm')
  const res = await chatStream([{ role: 'user', content: query }], tools as never, {}, { enableThinking: false })
  return res.toolCalls.map((tc) => {
    let args: Record<string, unknown> = {}
    try {
      args = JSON.parse(tc.function.arguments || '{}')
    } catch {
      /* 参数不是合法 JSON → 当作空参数，判分时会失败，这是真实失败 */
    }
    return { name: tc.function.name, args }
  })
}

// ===================== MCP 通道 =====================

const TOOLS_FILE = path.join(DATA, '_tools_current.json')

/**
 * 用 MCP 通道跑一题：把 BFCL 的函数定义交给一个通用 MCP 服务器托管，
 * 让**我的 MCP 客户端**去发现并调用 —— 这样 BFCL 就直接验证了 MCP 接入这条链路。
 */
async function runViaMcp(
  fns: ReturnType<typeof toOpenAiTools>,
  query: string,
): Promise<ProducedCall[]> {
  if (!mcpClient) {
    const { McpClient } = await import('../src/lib/agent/mcp')
    mcpClient = await McpClient.connect({
      name: 'bfcl',
      command: process.execPath,
      args: [path.join(process.cwd(), 'scripts', 'mcp-bfcl-server.ts')],
      env: { BFCL_TOOLS_FILE: TOOLS_FILE },
      timeoutMs: 20_000,
    })
  }
  // 服务器每次 tools/list 都重读这个文件，所以先写入当前题目的工具集
  fs.writeFileSync(TOOLS_FILE, JSON.stringify(fns, null, 2), 'utf-8')
  const tools = await mcpClient.listTools()

  // ⚠️ 关键：MCP 会把工具名做命名空间化并**把非法字符替换掉**
  //    （`spotify.play` → `mcp__bfcl__spotify_play`，点号变下划线）。
  //    判分时需要还原成 BFCL 原始函数名，**必须用映射表**，
  //    不能用 `replace(/^mcp__[^_]+__/,'')` 这种字符串剥离 ——
  //    那样得到的是 `spotify_play`，永远匹配不上 `spotify.play`。
  const qualifiedToOriginal = new Map<string, string>()
  for (const t of tools) qualifiedToOriginal.set(t.qualifiedName, t.name)

  const { chatStream } = await import('../src/lib/agent/llm')
  const res = await chatStream(
    [{ role: 'user', content: query }],
    tools.map((t) => ({
      type: 'function' as const,
      function: { name: t.qualifiedName, description: t.description, parameters: t.inputSchema },
    })) as never,
    {},
    { enableThinking: false },
  )
  return res.toolCalls.map((tc) => {
    let args: Record<string, unknown> = {}
    try {
      args = JSON.parse(tc.function.arguments || '{}')
    } catch {
      /* 同上 */
    }
    // 用映射表还原原始函数名；查不到再退回字符串剥离（防御性）
    const original =
      qualifiedToOriginal.get(tc.function.name) ?? tc.function.name.replace(/^mcp__[^_]+__/, '')
    return { name: original, args }
  })
}

// ===================== 主流程 =====================

console.log(`\nBFCL v4 评测｜通道=${mode}｜类别=${categories.join(', ')}｜每类上限=${limit} 题`)
console.log('数据来源：github.com/ShishirPatil/gorilla（berkeley-function-call-leaderboard）\n')

const results: BfclCategoryResult[] = []

for (const category of categories) {
  const cases = load(category)
  if (!cases) {
    console.log(`⚠ 跳过 ${category}（数据文件缺失，未下载该类别）`)
    continue
  }
  const picked = cases.slice(0, limit)
  const t0 = Date.now()
  const rows: { id: string; query: string; pass: boolean; detail: string; calls: number }[] = []

  for (let i = 0; i < picked.length; i++) {
    const c = picked[i]
    const query = extractUserQuery(c.item)
    const tools = toOpenAiTools(c.item.function)
    let produced: ProducedCall[] = []
    try {
      produced = mode === 'mcp' ? await runViaMcp(tools, query) : await runNative(tools, query)
    } catch (e) {
      rows.push({ id: c.item.id, query, pass: false, detail: `调用异常：${e instanceof Error ? e.message : String(e)}`, calls: 0 })
      continue
    }
    const g = gradeCase(c.groundTruth, produced)
    rows.push({ id: c.item.id, query, pass: g.pass, detail: g.detail, calls: produced.length })
    process.stdout.write(`\r  ${category}: ${i + 1}/${picked.length}  通过 ${rows.filter((r) => r.pass).length}`)
  }
  process.stdout.write('\n')

  const r = summarizeCategory(category, rows, Date.now() - t0)
  results.push(r)
  console.log(
    `  ✓ ${category.padEnd(20)} 准确率 ${(r.accuracy * 100).toFixed(1)}%  (${r.passed}/${r.total})` +
      `  平均调用 ${r.avgCalls.toFixed(2)}  ${(r.durationMs / 1000).toFixed(0)}s`,
  )
}

if (mcpClient) await (mcpClient as import('../src/lib/agent/mcp').McpClient).close()

// ===================== 汇总 =====================

const total = results.reduce((a, r) => a + r.total, 0)
const passed = results.reduce((a, r) => a + r.passed, 0)

console.log('\n' + '='.repeat(64))
console.log(`BFCL v4 总览（通道=${mode}）`)
console.log('='.repeat(64))
console.log(`总体准确率：${total ? ((passed / total) * 100).toFixed(1) : '0.0'}%  (${passed}/${total})`)
console.log('')
console.log('按类别：')
for (const r of results) {
  const bar = '█'.repeat(Math.round(r.accuracy * 24))
  console.log(`  ${r.category.padEnd(20)} ${(r.accuracy * 100).toFixed(1).padStart(5)}%  ${bar}`)
}

const allFailures = results.flatMap((r) => r.failures.map((f) => ({ ...f, category: r.category })))
if (allFailures.length) {
  console.log('\n失败样例（最多 8 条）：')
  for (const f of allFailures.slice(0, 8)) {
    console.log(`  ✗ [${f.category}] ${f.id}`)
    console.log(`     Q: ${f.query.slice(0, 90)}`)
    console.log(`     ${f.detail.slice(0, 160)}`)
  }
}

const out = path.join(DATA, `bfcl-report-${mode}.json`)
fs.writeFileSync(out, JSON.stringify({ mode, total, passed, results, at: new Date().toISOString() }, null, 2), 'utf-8')
console.log(`\n✓ 报告已写入 ${out}\n`)
