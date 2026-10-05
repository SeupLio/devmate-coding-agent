/**
 * P0 端到端冒烟：权限闸门 + 人在环审批 + 可观测性。
 *
 * 验证三件事（都是真实 Agent 循环，不是单测桩）：
 *  1. plan 模式下写操作被**拒绝**（只出方案，不动文件）
 *  2. default 模式下写操作**挂起等审批**，人工放行后才执行
 *  3. 每次运行都产出**完整 trace**，并能被聚合报告读到
 *
 * 用法：bun scripts/p0-smoke.ts
 */
import fs from 'node:fs'
import { runAgent } from '../src/lib/agent/loop'
import { createWorkspace, sessionDir, workspaceExists } from '../src/lib/agent/workspace'
import { resolveApproval } from '../src/lib/agent/approvals'
import { saveTrace } from '../src/lib/agent/trace-store'

const TASK = 'mathutils.js 里的 sum 函数有 bug（结果不对），请修复它。'

function freshSession(sid: string) {
  if (workspaceExists(sid)) fs.rmSync(sessionDir(sid), { recursive: true, force: true })
  createWorkspace(sid)
}

interface Observed {
  permissionDenied: string[]
  approvals: { id: string; tool: string; reason: string }[]
  toolResults: { name: string; ok: boolean }[]
  traceEvent: unknown
}

async function runOnce(sid: string, mode: 'plan' | 'default', autoApprove: boolean): Promise<Observed> {
  freshSession(sid)
  const obs: Observed = { permissionDenied: [], approvals: [], toolResults: [], traceEvent: null }

  for await (const ev of runAgent({
    sessionId: sid,
    task: TASK,
    maxSteps: 8,
    plan: false,
    thinking: false,
    permissionMode: mode,
    onTrace: (rec) => saveTrace(rec),
  })) {
    if (ev.type === 'permission' && ev.action === 'deny') obs.permissionDenied.push(`${ev.tool}(${ev.risk})`)
    if (ev.type === 'approval_required') {
      obs.approvals.push({ id: ev.id, tool: ev.tool, reason: ev.reason })
      if (autoApprove) resolveApproval(ev.id, 'allow')
    }
    if (ev.type === 'tool_result') obs.toolResults.push({ name: ev.name, ok: ev.ok })
    if (ev.type === 'trace') obs.traceEvent = ev
  }
  return obs
}

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

// ---------- 场景 1：plan 模式，写操作必须被拒 ----------
console.log('\n▶ 场景 1：plan 模式（只出方案，不动文件）')
const r1 = await runOnce('p0-plan', 'plan', false)
console.log(`   权限拒绝：${r1.permissionDenied.join(', ') || '(无)'}`)
check('写操作被权限拒绝', r1.permissionDenied.length > 0, r1.permissionDenied[0] ?? '')
check('没有出现审批请求（plan 直接拒，不该问）', r1.approvals.length === 0)

// ---------- 场景 2：default 模式，写操作挂起等审批 ----------
console.log('\n▶ 场景 2：default 模式（写操作需人工审批，自动放行）')
const r2 = await runOnce('p0-default', 'default', true)
console.log(`   审批请求：${r2.approvals.map((a) => `${a.tool}(${a.reason})`).join(', ') || '(无)'}`)
check('写操作触发了审批请求', r2.approvals.length > 0, r2.approvals[0]?.tool ?? '')
check('放行后工具确实执行了', r2.toolResults.length > 0, `${r2.toolResults.length} 次工具调用`)
check('产出了 trace 事件', Boolean(r2.traceEvent))

// ---------- 场景 3：可观测性 ----------
console.log('\n▶ 场景 3：可观测性（trace 落盘 + 聚合）')
const { listTraces, summarizeRecent } = await import('../src/lib/agent/trace-store')
const traces = listTraces(50)
const sum = summarizeRecent(50)
check('trace 已落盘', traces.length > 0, `${traces.length} 条`)
check('聚合能算出延迟分位', sum.latencyMs.p50 > 0, `P50=${Math.round(sum.latencyMs.p50)}ms P95=${Math.round(sum.latencyMs.p95)}ms`)
check('聚合能算出成本与 token', sum.tokens.total > 0, `${sum.tokens.total} token, ¥${sum.costCny.toFixed(4)}`)
check('usage 来源是真实 API（非估算）', traces.some((t) => t.totalTokens > 0))
check('时间能按类别归因（llm/tool）', Object.keys(sum.timeByKind).length > 0, Object.keys(sum.timeByKind).join(', '))

console.log(`\n${fail === 0 ? '✓ P0 冒烟全部通过' : `✗ 有 ${fail} 项未通过`}（${pass} 通过 / ${fail} 失败）`)
process.exit(fail === 0 ? 0 : 1)
