/**
 * OpenAI 兼容接口适配器。
 * 通过环境变量切换模型供应商，无需改业务代码。
 *
 * 用法：
 *   LLM_PROVIDER=openai
 *   OPENAI_API_KEY=sk-xxx
 *   OPENAI_BASE_URL=https://api.deepseek.com   (可选，默认 OpenAI 官方)
 *   OPENAI_MODEL=deepseek-chat                  (可选，默认 gpt-4o-mini)
 *
 * 支持任意 OpenAI 兼容厂商：OpenAI / DeepSeek / 通义千问 DashScope /
 * 智谱开放平台 / 火山引擎 / 任意本地 vLLM / Ollama / LM Studio。
 */
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
  /** 推理模型（Qwen / DeepSeek-R1 等）的思考过程增量 */
  onReasoning?: (text: string) => void
}

export interface ChatOptions {
  /**
   * 是否允许模型「深度思考」。
   *  - true（默认）：思考过程会流式输出（更准，但更慢）
   *  - false：请求体带 enable_thinking=false，**显著变快**（实测约 2×）
   * 若网关不支持该字段，可用 OPENAI_EXTRA_BODY 覆盖。
   */
  enableThinking?: boolean
}

export interface StreamResult {
  content: string
  /** 推理内容（思考过程），可能为空 */
  reasoning: string
  toolCalls: ToolCall[]
  finishReason: string | null
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

/** 粗略 token 估算：与原实现保持一致 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2)
}

function backoffDelay(attempt: number): number {
  return Math.min(2 ** attempt, 40) * 1000 + Math.random() * 1000
}

function isRetryable(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  // HTTP 限流/网关抖动
  if (/429|Too many requests|502|503|504/.test(msg)) return true
  // 网络层中断：连接被对端关闭、DNS/TLS 抖动、undici 的 "fetch failed"
  // （长流式响应下中转站偶发断连，重试即可恢复；不重试会直接把任务判失败）
  if (/fetch failed|socket|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|UND_ERR|terminated|other side closed/i.test(msg)) {
    return true
  }
  // 流读取中途断开时抛出的 TypeError（undici 把 cause 藏在 error.cause 里）
  const cause = (e as { cause?: unknown })?.cause
  if (cause && cause !== e) return isRetryable(cause)
  return false
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * 流式对话补全：解析 SSE 字节流、累积 content 与 tool_calls 分片。
 * 429 / 5xx 时指数退避重试（与 ZAI 实现策略一致）。
 */
export async function chatStream(
  messages: ChatMessageParam[],
  tools?: unknown[],
  cb?: StreamCallbacks,
  opts?: ChatOptions,
): Promise<StreamResult> {
  const base = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'
  const key = process.env.OPENAI_API_KEY ?? ''
  const model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini'
  if (!key) {
    throw new Error(
      'OPENAI_API_KEY 未配置。请设置 LLM_PROVIDER=openai + OPENAI_API_KEY(+ 可选 OPENAI_BASE_URL / OPENAI_MODEL) 后重启服务。',
    )
  }

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    temperature: 0.2,
  }
  if (tools && tools.length) {
    body.tools = tools
    body.tool_choice = 'auto'
  }
  // 关闭深度思考 → 显著更快（环境变量可作为全局默认）
  const thinking =
    opts?.enableThinking ?? (process.env.OPENAI_ENABLE_THINKING ?? 'true').toLowerCase() !== 'false'
  if (!thinking) body.enable_thinking = false
  // 逃生口：把额外字段并入请求体（优先级最高）。
  // 例：OPENAI_EXTRA_BODY={"enable_thinking":false}
  //     OPENAI_EXTRA_BODY={"reasoning_effort":"low"}
  if (process.env.OPENAI_EXTRA_BODY) {
    try {
      Object.assign(body, JSON.parse(process.env.OPENAI_EXTRA_BODY))
    } catch {
      /* 配置非法则忽略，不影响主流程 */
    }
  }

  const MAX_RETRIES = 5
  let lastError: unknown
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`)
      }
      if (!res.body) throw new Error('No response body')

      const reader = (res.body as ReadableStream<Uint8Array>).getReader()
      const dec = new TextDecoder()
      let buf = ''
      let content = ''
      let reasoning = ''
      let finishReason: string | null = null
      let usage: StreamResult['usage']
      const toolAcc = new Map<number, ToolCall>()

      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
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
          // 推理内容：不同网关字段名不同（Qwen/DeepSeek 用 reasoning_content，
          // 也有用 reasoning 的），两个都取
          const rDelta =
            (typeof delta.reasoning_content === 'string' && delta.reasoning_content) ||
            (typeof delta.reasoning === 'string' && delta.reasoning) ||
            ''
          if (rDelta) {
            reasoning += rDelta
            cb?.onReasoning?.(rDelta)
          }
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
        reasoning,
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