import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { loadMcpConfigs } from '@/lib/agent/mcp-registry'

/**
 * 轻量预检接口：前端启动时探测一次，用于
 *  1. 头部状态胶囊展示当前 LLM provider / model；
 *  2. LLM 未配置时给出引导横幅（否则用户会直接撞到 500 错误，体验很差）。
 *
 * 刻意不做真实 LLM 请求（避免每次打开页面都白烧一次 token / 延迟），
 * 只做「凭据是否存在」的静态检查。
 */
export async function GET() {
  const provider = (process.env.LLM_PROVIDER ?? 'openai').toLowerCase()

  // zai 走智谱沙箱内部 SDK，凭据由运行环境自动注入，无法静态校验 → 视为可用
  const llmConfigured =
    provider === 'zai' ? true : Boolean(process.env.OPENAI_API_KEY?.trim())

  const model =
    process.env.OPENAI_MODEL ??
    (provider === 'zai' ? '(SDK 默认)' : 'gpt-4o-mini')

  let dbOk = true
  try {
    await db.session.count()
  } catch {
    dbOk = false
  }

  let mcpServers = 0
  try {
    mcpServers = loadMcpConfigs().length
  } catch {
    mcpServers = 0
  }

  return NextResponse.json({
    ok: dbOk && llmConfigured,
    llm: { provider, model, configured: llmConfigured },
    db: dbOk,
    mcp: { servers: mcpServers },
  })
}
