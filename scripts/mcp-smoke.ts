/**
 * MCP 接入冒烟测试：确认 Agent 能**在运行时**发现并调用外部 MCP 工具。
 *
 * 与单元测试的区别：这里跑的是**真实的 Agent 循环** ——
 * 模型看到的是「内置工具 + 运行时从 MCP 服务器拉到的工具」，
 * 由模型自己决定调用，验证端到端链路真的通。
 *
 * 用法：bun scripts/mcp-smoke.ts
 */
import fs from 'node:fs'
import path from 'node:path'

// ⚠️ 必须在第一次调用 MCP 注册表之前设置（注册表首次访问时才读取配置）
process.env.MCP_SERVERS = JSON.stringify([
  {
    name: 'demo',
    command: process.execPath, // 当前运行时（bun）可直接执行 .ts
    args: [path.join(process.cwd(), 'scripts', 'mcp-demo-server.ts')],
    timeoutMs: 10_000,
  },
])

const { runAgent } = await import('../src/lib/agent/loop')
const { resolveApproval } = await import('../src/lib/agent/approvals')
const { createWorkspace, sessionDir, workspaceExists } = await import('../src/lib/agent/workspace')
const { getMcpToolDefs, getMcpReadOnlySet } = await import('../src/lib/agent/mcp-registry')

const SID = 'mcp-smoke'

// 1) 工具发现
const defs = await getMcpToolDefs()
const readOnly = await getMcpReadOnlySet()
console.log(`✓ 运行时发现 ${defs.length} 个 MCP 工具：`)
for (const d of defs) console.log(`    ${d.function.name}  (readOnly=${readOnly.has(d.function.name)})`)
if (!defs.length) {
  console.error('✗ 没有发现任何 MCP 工具，冒烟测试失败')
  process.exit(1)
}

// 2) 让真实 Agent 循环用一次 MCP 工具
if (workspaceExists(SID)) fs.rmSync(sessionDir(SID), { recursive: true, force: true })
createWorkspace(SID)

const task = '请调用 get_time 工具查询当前时间（时区 Asia/Shanghai），然后告诉我结果。'
console.log(`\n▶ 任务：${task}\n`)

const usedTools: string[] = []
let finalSummary = ''
let mcpResult = ''

for await (const ev of runAgent({ sessionId: SID, task, maxSteps: 6, plan: false, thinking: false })) {
  if (ev.type === 'tool_call') {
    usedTools.push(ev.name)
    if (ev.name.startsWith('mcp__')) console.log(`  · 调用 MCP 工具 ${ev.name}`)
  }
  // MCP 工具默认 readOnly=false → 需要人工审批。冒烟脚本没有「人」，
  // 若不自动放行会等到超时按拒绝处理，于是只能验证「调用尝试」而验证不到真实返回。
  // 这里自动放行，让冒烟真正跑通「发现 → 调用 → 拿到数据」的完整往返。
  // （权限模型本身由 p0:smoke 专门验证，职责不重叠）
  if (ev.type === 'approval_required') {
    console.log(`  ⏸ 审批：${ev.tool}（${ev.reason}）→ 冒烟脚本自动放行`)
    resolveApproval(ev.id, 'allow')
  }
  if (ev.type === 'tool_result' && ev.name.startsWith('mcp__')) mcpResult = ev.result
  if (ev.type === 'final') finalSummary = ev.summary
  if (ev.type === 'error') console.error(`  ! 错误：${ev.message}`)
}

console.log(`\n调用过的工具：${usedTools.join(', ') || '(无)'}`)
console.log(`MCP 工具返回：${mcpResult || '(未调用)'}`)
console.log(`最终总结：${finalSummary.slice(0, 200)}`)

const ok = usedTools.some((n) => n.startsWith('mcp__')) && Boolean(mcpResult)
console.log(ok ? '\n✓ 冒烟通过：Agent 在运行时发现并成功调用了外部 MCP 工具' : '\n✗ 冒烟失败：Agent 未调用 MCP 工具')
process.exit(ok ? 0 : 1)
