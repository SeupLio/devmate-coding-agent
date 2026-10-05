/**
 * 本地一键 Demo —— 不需要浏览器，不需要额外配置。
 *
 *   bun run demo
 *
 * 它会完整跑一遍真实链路，并**把 P0/P1 的能力都展示出来**：
 *   1. 规划（按需）
 *   2. 权限闸门 + 人在环审批（脚本里自动放行，但你能看到每次询问）
 *   3. 子 Agent 委派（如果模型选择用 task 工具）
 *   4. 工具调用 → 改文件 → 跑测试 → git 提交
 *   5. 收尾的可观测性摘要（trace / token / 耗时归因）
 *   6. 最后打印工作区的实际改动（git diff）
 *
 * 前置：项目根目录有 .env（OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL）
 */
import fs from 'node:fs'
import { runAgent, type AgentEvent } from '../src/lib/agent/loop'
import { createWorkspace, sessionDir, workspaceExists } from '../src/lib/agent/workspace'
import { resolveApproval } from '../src/lib/agent/approvals'
import { saveTrace } from '../src/lib/agent/trace-store'

const SID = `demo-${Date.now().toString(36)}`
const TASK = process.argv.slice(2).join(' ') || '修复 mathutils.js 中的 bug，使全部测试通过，然后提交。'

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  violet: (s: string) => `\x1b[35m${s}\x1b[0m`,
}

// ---------- 0. 环境自检 ----------
if (!process.env.OPENAI_API_KEY) {
  console.error(c.red('✗ 未检测到 OPENAI_API_KEY。'))
  console.error('  请先：cp .env.example .env，并填入 OPENAI_API_KEY（以及可选的 BASE_URL / MODEL）')
  process.exit(1)
}
console.log(c.b('\n═══ DevMate 本地 Demo ═══'))
console.log(c.dim(`  模型    ${process.env.OPENAI_MODEL ?? '(默认)'}`))
console.log(c.dim(`  网关    ${process.env.OPENAI_BASE_URL ?? '(默认)'}`))
console.log(c.dim(`  会话    ${SID}`))
console.log(c.dim(`  任务    ${TASK}`))

// ---------- 1. 准备沙箱 ----------
if (workspaceExists(SID)) fs.rmSync(sessionDir(SID), { recursive: true, force: true })
createWorkspace(SID)
console.log(c.green('✓ 沙箱已就绪（模板项目已复制进去）'))

// ---------- 2. 跑 Agent ----------
console.log(c.b('\n─── 开始执行 ───\n'))
let step = 0
let toolCount = 0
let approvals = 0
let finalSummary = ''
let traceLine = ''

const fmtArgs = (a: unknown) => {
  const s = JSON.stringify(a ?? {})
  return s.length > 110 ? `${s.slice(0, 110)}…` : s
}

for await (const ev of runAgent({
  sessionId: SID,
  task: TASK,
  maxSteps: 16,
  plan: 'auto',
  thinking: false,
  // 用 default 模式，好让审批流程被真实触发（脚本里自动放行）
  permissionMode: 'default',
  approvalTimeoutMs: 60_000,
  onTrace: (rec) => saveTrace(rec),
})) {
  await handle(ev)
}

async function handle(ev: AgentEvent) {
  switch (ev.type) {
    case 'plan':
      console.log(c.cyan(`  ▸ 规划（${ev.steps.length} 步）`))
      ev.steps.forEach((s, i) => console.log(c.dim(`      ${i + 1}. ${s}`)))
      break
    case 'step_start':
      step = ev.step
      break
    case 'tool_call': {
      toolCount++
      const tag = ev.name === 'task' ? c.violet('[子Agent]') : ''
      console.log(c.dim(`  [${step}] → ${ev.name} ${tag} ${fmtArgs(ev.args)}`))
      break
    }
    case 'tool_result': {
      const head = ev.result.split('\n')[0].slice(0, 100)
      console.log(`      ${ev.ok ? c.green('✓') : c.red('✗')} ${c.dim(head)}`)
      break
    }
    case 'permission':
      if (ev.action === 'deny') console.log(c.red(`      ⛔ 权限拦截：${ev.tool} —— ${ev.reason}`))
      break
    case 'approval_required': {
      approvals++
      console.log(c.yellow(`      ⏸ 需要确认：${ev.tool}（${ev.risk}）—— ${ev.reason}`))
      // Demo 里自动放行；真实场景是前端弹卡片让人点
      resolveApproval(ev.id, 'allow')
      console.log(c.dim('        已自动放行（Demo 行为；真实使用由人工决定）'))
      break
    }
    case 'context':
      console.log(
        c.dim(
          `      ↻ 上下文压缩 ${ev.tokensBefore}→${ev.tokensAfter} tokens` +
            `（${ev.compressedCount} 条，${ev.summarized ? 'LLM 摘要' : '占位符'}）`,
        ),
      )
      break
    case 'final':
      finalSummary = ev.summary
      break
    case 'trace':
      traceLine =
        `  trace ${ev.traceId.slice(0, 8)}｜${(ev.durationMs / 1000).toFixed(1)}s｜` +
        `${ev.usage.totalTokens} tokens（${ev.usage.source}）｜` +
        Object.entries(ev.timeByKind)
          .map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}s`)
          .join(' / ')
      break
    case 'error':
      console.log(c.red(`  ! 执行异常：${ev.message}`))
      break
  }
}

// ---------- 3. 结果 ----------
console.log(c.b('\n─── 执行结果 ───\n'))
console.log(finalSummary || c.dim('(无总结)'))
console.log('')
console.log(c.dim(`  步数 ${step}｜工具调用 ${toolCount}｜审批询问 ${approvals} 次`))
if (traceLine) console.log(c.dim(traceLine))

// ---------- 4. 工作区实际改动 ----------
console.log(c.b('\n─── 工作区实际改动（git diff）───\n'))
const { execFileSync } = await import('node:child_process')
try {
  const diff = execFileSync('git', ['-C', sessionDir(SID), 'log', '--oneline'], {
    encoding: 'utf-8',
  })
  console.log(c.dim('  提交记录：'))
  diff
    .trim()
    .split('\n')
    .forEach((l) => console.log(`    ${l}`))
} catch {
  console.log(c.dim('  (未产生提交)'))
}

console.log(c.b('\n─── 下一步 ───'))
console.log('  bun run dev            打开浏览器 UI（审批卡片 / trace 面板都在里面）')
console.log('  bun run trace:report   看可观测性报告（延迟分位 / 成本 / 工具失败率）')
console.log(`  ls ${sessionDir(SID)}   查看沙箱产物\n`)
