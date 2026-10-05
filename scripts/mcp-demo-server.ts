/**
 * 一个最小但**真实**的 MCP 服务器（stdio 传输）。
 *
 * 用途：
 *  1. 给 DevMate 的 MCP 客户端做端到端验证
 *  2. 演示「运行时动态发现工具」——这些工具不在 Agent 的内置工具集里，
 *     是启动时从外部服务器拉到的
 *
 * 手写 JSON-RPC 循环（零依赖），只实现 tools 能力。
 *
 * 运行：bun scripts/mcp-demo-server.ts
 * 配置：写进 mcp.servers.json 或 MCP_SERVERS 环境变量即可被 Agent 发现
 */
import { createInterface } from 'node:readline'
import { createHash } from 'node:crypto'

const PROTOCOL_VERSION = '2024-11-05'

interface JsonRpc {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: Record<string, unknown>
}

/** 本服务器暴露的工具 */
const TOOLS = [
  {
    name: 'get_time',
    description: '获取当前时间（可指定 IANA 时区，如 Asia/Shanghai）。Agent 自身没有时钟工具。',
    inputSchema: {
      type: 'object',
      properties: { timezone: { type: 'string', description: 'IANA 时区名，默认 Asia/Shanghai' } },
    },
  },
  {
    name: 'word_count',
    description: '统计一段文本的字符数、词数与行数。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '待统计文本' } },
      required: ['text'],
    },
  },
  {
    name: 'sha256',
    description: '计算一段文本的 SHA-256（用于校验产物完整性）。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
]

function callTool(name: string, args: Record<string, unknown>): { text: string; isError?: boolean } {
  switch (name) {
    case 'get_time': {
      const tz = (args.timezone as string) || 'Asia/Shanghai'
      try {
        const s = new Date().toLocaleString('zh-CN', { timeZone: tz, hour12: false })
        return { text: `${s}（${tz}）` }
      } catch {
        return { text: `未知时区：${tz}`, isError: true }
      }
    }
    case 'word_count': {
      const text = String(args.text ?? '')
      const chars = [...text].length
      const words = text.trim() ? text.trim().split(/\s+/).length : 0
      const lines = text ? text.split('\n').length : 0
      return { text: `字符 ${chars}｜词 ${words}｜行 ${lines}` }
    }
    case 'sha256': {
      const text = String(args.text ?? '')
      return { text: createHash('sha256').update(text, 'utf-8').digest('hex') }
    }
    default:
      return { text: `未知工具：${name}`, isError: true }
  }
}

function reply(msg: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(msg)}\n`)
}

const rl = createInterface({ input: process.stdin })

rl.on('line', (line) => {
  const t = line.trim()
  if (!t) return
  let msg: JsonRpc
  try {
    msg = JSON.parse(t)
  } catch {
    return
  }
  const { id, method, params } = msg

  // 通知（无 id）不需要回复
  if (method === 'notifications/initialized') return
  if (id === undefined) return

  switch (method) {
    case 'initialize':
      reply({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'devmate-demo', version: '1.0.0' },
        },
      })
      break

    case 'tools/list':
      reply({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
      break

    case 'tools/call': {
      const name = String((params?.name as string) ?? '')
      const args = (params?.arguments as Record<string, unknown>) ?? {}
      const r = callTool(name, args)
      reply({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: r.text }], isError: r.isError ?? false },
      })
      break
    }

    default:
      reply({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      })
  }
})

// 退出时干净收尾
process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
