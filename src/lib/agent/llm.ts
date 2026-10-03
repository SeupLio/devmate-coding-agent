/**
 * LLM 路由层：根据环境变量 LLM_PROVIDER 选择底层实现。
 * - LLM_PROVIDER=openai (默认) → llm.openai.ts（OpenAI 兼容厂商，可指向 DeepSeek / 通义 / OpenAI 官方 / vLLM 等）
 * - LLM_PROVIDER=zai    → llm.zai.ts（智谱清言内部 SDK，仅在智谱沙箱内有凭证时可用）
 *
 * 所有业务代码（loop.ts / tools.ts 等）只 import 本文件，无需关心底层实现。
 */
import * as openai from './llm.openai'
import * as zai from './llm.zai'

const provider = (process.env.LLM_PROVIDER ?? 'openai').toLowerCase()
const impl = provider === 'zai' ? zai : openai

export const chatStream = impl.chatStream
export const estimateTokens = impl.estimateTokens
export type { ChatMessageParam, ChatOptions, StreamCallbacks, StreamResult, ToolCall } from './llm.openai'