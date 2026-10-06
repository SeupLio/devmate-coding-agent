/**
 * 代码评审接口。
 *
 *  POST /api/review { sessionId, base? } → 结构化评审结果
 *
 * 与 `/api/agent` 的区别：这里**不跑 Agent 循环**，直接对工作区 diff 做两层评审
 * （确定性静态检查 + LLM 语义评审），用于「提交前自检」这个独立场景。
 */
import { NextRequest } from 'next/server'
import { reviewDiff } from '@/lib/agent/review'
import { workspaceExists, createWorkspace } from '@/lib/agent/workspace'

export const maxDuration = 120

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const sessionId = String(body.sessionId ?? '')
  if (!sessionId) {
    return Response.json({ error: 'sessionId 必填' }, { status: 400 })
  }
  if (!workspaceExists(sessionId)) createWorkspace(sessionId)

  try {
    const result = await reviewDiff(sessionId, {
      base: body.base ? String(body.base) : undefined,
      useLlm: body.useLlm !== false,
    })
    return Response.json(result)
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
