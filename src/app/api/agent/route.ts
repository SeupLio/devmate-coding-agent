import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { runAgent } from '@/lib/agent/loop'
import { workspaceExists, createWorkspace } from '@/lib/agent/workspace'

export const maxDuration = 300

/**
 * SSE 流式 Agent 接口。
 * POST { sessionId, task } → text/event-stream
 * 事件：plan / step_start / token / tool_call / tool_result / context / final / error
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const sessionId = String(body.sessionId ?? '')
  const task = String(body.task ?? '').slice(0, 2000)
  // 规划模式：'auto'（短任务跳过，默认由前端传）/ true / false
  const plan: boolean | 'auto' = body.plan === true || body.plan === false ? body.plan : 'auto'
  // 是否允许深度思考：false 时显著更快
  const thinking = body.thinking !== false
  if (!sessionId || !task) {
    return new Response(JSON.stringify({ error: 'sessionId 与 task 必填' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const session = await db.session.findUnique({ where: { id: sessionId } })
  if (!session) {
    return new Response(JSON.stringify({ error: '会话不存在' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  if (!workspaceExists(sessionId)) createWorkspace(sessionId)

  // 取历史消息（最近 20 条）用于多轮对话
  const history = await db.message.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
    take: 20,
  })
  const historyMessages = history.map((m) => ({
    role: (m.role === 'user' || m.role === 'assistant' ? m.role : 'user') as 'user' | 'assistant',
    content: m.content,
  }))

  await db.session.update({ where: { id: sessionId }, data: { status: 'running', title: session.title === '新任务' ? task.slice(0, 40) : session.title } })
  await db.message.create({ data: { sessionId, role: 'user', content: task } })

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }
      try {
        for await (const ev of runAgent({ sessionId, task, history: historyMessages, plan, thinking })) {
          send(ev)
          // 持久化关键事件
          if (ev.type === 'tool_call') {
            await db.message.create({
              data: { sessionId, role: 'tool_call', content: ev.name, meta: JSON.stringify(ev.args) },
            })
          } else if (ev.type === 'tool_result') {
            await db.message.create({
              data: { sessionId, role: 'tool_result', content: ev.name, meta: JSON.stringify({ result: ev.result.slice(0, 2000), ok: ev.ok }) },
            })
          } else if (ev.type === 'plan') {
            await db.message.create({
              data: { sessionId, role: 'plan', content: JSON.stringify(ev.steps) },
            })
          } else if (ev.type === 'final') {
            await db.message.create({
              data: { sessionId, role: 'assistant', content: ev.summary, meta: JSON.stringify(ev.stats) },
            })
          } else if (ev.type === 'error') {
            await db.message.create({
              data: { sessionId, role: 'assistant', content: `[执行异常] ${ev.message}` },
            })
          }
        }
        await db.session.update({ where: { id: sessionId }, data: { status: 'done' } })
      } catch (e) {
        send({ type: 'error', message: e instanceof Error ? e.message : String(e) })
        await db.session.update({ where: { id: sessionId }, data: { status: 'error' } }).catch(() => null)
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  })
}
