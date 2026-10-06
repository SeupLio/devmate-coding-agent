/**
 * 通用 MCP 服务器：把一份 JSON 里的工具定义当作 MCP 工具暴露出去。
 *
 * 用途：让 **BFCL 的题目工具集走我的 MCP 通道** —— 这样权威基准就直接验证了
 * 「MCP 运行时工具发现 → 调用」这条链路，而不是只验证原生 tool calling。
 *
 * 工具定义文件路径由环境变量 `BFCL_TOOLS_FILE` 指定，**每次 tools/list 都重新读取**，
 * 因为 BFCL 每道题的工具集都不一样。
 *
 * 运行：BFCL_TOOLS_FILE=... bun scripts/mcp-bfcl-server.ts
 */
import fs from 'node:fs'
import { createInterface } from 'node:readline'

const PROTOCOL_VERSION = '2024-11-05'
const TOOLS_FILE = process.env.BFCL_TOOLS_FILE ?? ''

interface ToolSpec {
  type: 'function'
  function: { name: string; description?: string; parameters?: Record<string, unknown> }
}

function loadTools(): ToolSpec[] {
  if (!TOOLS_FILE || !fs.existsSync(TOOLS_FILE)) return []
  try {
    const arr = JSON.parse(fs.readFileSync(TOOLS_FILE, 'utf-8'))
    return Array.isArray(arr) ? (arr as ToolSpec[]) : []
  } catch {
    return []
  }
}

function reply(msg: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(msg)}\n`)
}

const rl = createInterface({ input: process.stdin })

rl.on('line', (line) => {
  const t = line.trim()
  if (!t) return
  let msg: { id?: number | string; method?: string; params?: Record<string, unknown> }
  try {
    msg = JSON.parse(t)
  } catch {
    return
  }
  const { id, method, params } = msg
  if (method === 'notifications/initialized') return
  if (id === undefined) return

  switch (method) {
    case 'initialize':
      reply({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'bfcl-tools', version: '1.0.0' },
        },
      })
      break

    case 'tools/list': {
      // 每次重新读文件：BFCL 每道题的工具集不同
      const tools = loadTools().map((t) => ({
        name: t.function.name,
        description: t.function.description ?? '',
        inputSchema: t.function.parameters ?? { type: 'object', properties: {} },
        // 这些工具是「被测对象」，没有真实副作用；声明为只读让调度器可并发
        annotations: { readOnlyHint: true },
      }))
      reply({ jsonrpc: '2.0', id, result: { tools } })
      break
    }

    case 'tools/call': {
      // 评测只关心「模型有没有调对函数、参数对不对」，不关心副作用
      const name = String((params?.name as string) ?? '')
      reply({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: `ok: ${name}` }], isError: false },
      })
      break
    }

    default:
      reply({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
  }
})

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
