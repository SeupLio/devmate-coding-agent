/**
 * ZAI（智谱清言内部 SDK）实现：流式 SSE 解析、tool_calls 分片累积、指数退避重试。
 * 默认 provider；通过环境变量 LLM_PROVIDER=openai 切换到 llm.openai.ts。
 */
import ZAI from 'z-ai-web-dev-sdk'

export interface ChatMessageParam {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
}

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface StreamCallbacks {
  onToken?: (text: string) => void
  /** 推理模型的思考过程增量（该 SDK 路径暂不产出，仅为类型对齐） */
  onReasoning?: (text: string) => void
}

/** 与 llm.openai.ts 对齐（该 SDK 路径暂不支持关闭思考） */
export interface ChatOptions {
  enableThinking?: boolean
}

export interface StreamResult {
  content: string
  /** 推理内容（该 SDK 路径暂不解析） */
  reasoning: string
  toolCalls: ToolCall[]
  finishReason: string | null
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

let zaiPromise: Promise<ZAI> | null = null
async function getClient(): Promise<ZAI> {
  if (!zaiPromise) zaiPromise = ZAI.create() as Promise<ZAI>
  return zaiPromise
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2)
}

function backoffDelay(attempt: number): number {
  return Math.min(2 ** attempt, 40) * 1000 + Math.random() * 1000
}

function isRetryable(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.includes('429') || msg.includes('Too many requests') || msg.includes('502') || msg.includes('503')
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

export async function chatStream(
  messages: ChatMessageParam[],
  tools?: unknown[],
  cb?: StreamCallbacks,
  _opts?: ChatOptions,
): Promise<StreamResult> {
  const zai = await getClient()
  const body: Record<string, unknown> = { messages, stream: true }
  if (tools && tools.length) {
    body.tools = tools
    body.tool_choice = 'auto'
  }

  const MAX_RETRIES = 5
  let lastError: unknown
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const stream = (await zai.chat.completions.create(
        body as unknown as Parameters<typeof zai.chat.completions.create>[0],
      )) as AsyncIterable<unknown>
      let buf = ''
      let content = ''
      let finishReason: string | null = null
      let usage: StreamResult['usage']
      const toolAcc = new Map<number, ToolCall>()

      for await (const chunk of stream) {
        const text =
          typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf-8')
        buf += text
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          const l = line.trim()
          if (!l.startsWith('data:')) continue
          const payload = l.slice(5).trim()
          if (!payload || payload === '[DONE]') continue
          let j: any
          try {
            j = JSON.parse(payload)
          } catch {
            continue
          }
          if (j?.usage) usage = j.usage
          const choice = j?.choices?.[0]
          if (!choice) continue
          if (choice.finish_reason) finishReason = choice.finish_reason
          const delta = choice.delta
          if (!delta) continue
          if (typeof delta.content === 'string' && delta.content) {
            content += delta.content
            cb?.onToken?.(delta.content)
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx: number = tc.index ?? 0
              let acc = toolAcc.get(idx)
              if (!acc) {
                acc = { id: '', type: 'function', function: { name: '', arguments: '' } }
                toolAcc.set(idx, acc)
              }
              if (tc.id) acc.id = tc.id
              if (tc.function?.name) acc.function.name += tc.function.name
              if (tc.function?.arguments) acc.function.arguments += tc.function.arguments
            }
          }
        }
      }
      return {
        content,
        reasoning: '', // 该 SDK 路径暂不解析思考内容
        toolCalls: [...toolAcc.values()].filter((t) => t.function.name),
        finishReason,
        usage,
      }
    } catch (e) {
      lastError = e
      if (isRetryable(e) && attempt < MAX_RETRIES) {
        await sleep(backoffDelay(attempt))
        continue
      }
      throw e
    }
  }
  throw lastError
}