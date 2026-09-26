import { NextRequest } from 'next/server'
import { runEvaluation } from '@/lib/eval/runner'

export const maxDuration = 600

/** SSE 评测进度接口：POST { taskIds?, only?, repeat? } */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const taskIds = Array.isArray(body.taskIds) ? (body.taskIds as string[]).map(String) : undefined
  const only = body.only === 'holdout' || body.only === 'default' ? body.only : undefined
  const repeat = Number.isFinite(body.repeat) ? Number(body.repeat) : 1

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }
      try {
        for await (const ev of runEvaluation({ taskIds, only, repeat })) {
          send(ev)
        }
      } catch (e) {
        send({ type: 'error', message: e instanceof Error ? e.message : String(e) })
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
