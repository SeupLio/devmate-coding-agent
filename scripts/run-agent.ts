/**
 * 命令行单任务入口：bun scripts/run-agent.ts "任务描述"
 */
import { randomUUID } from 'node:crypto'
import { runAgent } from '../src/lib/agent/loop'
import { createWorkspace } from '../src/lib/agent/workspace'

async function main() {
  const task = process.argv[2]
  if (!task) {
    console.error('用法: bun scripts/run-agent.ts "任务描述"')
    process.exit(1)
  }
  const sessionId = `cli-${randomUUID().slice(0, 8)}`
  createWorkspace(sessionId)
  for await (const ev of runAgent({ sessionId, task })) {
    if (ev.type === 'plan') console.log('[计划]', ev.steps)
    else if (ev.type === 'tool_call') console.log(`[工具] ${ev.name}`, JSON.stringify(ev.args).slice(0, 120))
    else if (ev.type === 'tool_result') console.log(`  ↳ ${ev.result.split('\n')[0].slice(0, 140)}`)
    else if (ev.type === 'context') console.log(`[上下文] ${ev.tokensBefore}→${ev.tokensAfter} tokens`)
    else if (ev.type === 'final') {
      console.log('[总结]', ev.summary)
      console.log('[统计]', JSON.stringify(ev.stats))
    } else if (ev.type === 'error') console.error('[异常]', ev.message)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
