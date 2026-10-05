/**
 * MCP 服务器注册表：把外部 MCP 服务器接入 Agent 的工具集。
 *
 * 配置来源（优先级从高到低）：
 *  1. 环境变量 `MCP_SERVERS` —— JSON 数组，便于 CI / 容器注入
 *  2. 项目根目录 `mcp.servers.json`
 * 两者都没有 → 不启用 MCP（零成本，不影响原有行为）
 *
 * 接入后：MCP 工具会以 `mcp__<server>__<tool>` 出现在模型可见的工具列表里，
 * 调用时路由到对应服务器的 `tools/call`。
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  connectMcpServers,
  isMcpToolName,
  type McpClient,
  type McpServerConfig,
  type McpToolDef,
} from './mcp'

/** OpenAI function 形态的工具定义 */
export interface ToolDef {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export function loadMcpConfigs(cwd = process.cwd()): McpServerConfig[] {
  const fromEnv = process.env.MCP_SERVERS
  if (fromEnv) {
    try {
      const parsed = JSON.parse(fromEnv)
      if (Array.isArray(parsed)) return parsed as McpServerConfig[]
    } catch {
      console.warn('[mcp] MCP_SERVERS 不是合法 JSON，已忽略')
    }
  }
  const file = path.join(cwd, 'mcp.servers.json')
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
      // 允许 { "servers": [...] } 或直接 [...]
      const arr = Array.isArray(parsed) ? parsed : parsed?.servers
      if (Array.isArray(arr)) return arr as McpServerConfig[]
    } catch (e) {
      console.warn(`[mcp] 解析 ${file} 失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return []
}

interface McpState {
  clients: McpClient[]
  tools: McpToolDef[]
  failures: { name: string; error: string }[]
}

let cache: Promise<McpState> | null = null

/** 连接所有已配置的 MCP 服务器（进程内只连一次） */
export async function getMcpState(): Promise<McpState> {
  if (!cache) {
    const configs = loadMcpConfigs()
    cache = configs.length
      ? connectMcpServers(configs)
      : Promise.resolve({ clients: [], tools: [], failures: [] })
  }
  return cache
}

/** 把 MCP 工具转成模型可见的工具定义 */
export async function getMcpToolDefs(): Promise<ToolDef[]> {
  const { tools } = await getMcpState()
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.qualifiedName,
      // 标注来源，便于模型理解这是外部工具
      description: `[MCP:${t.qualifiedName.split('__')[1]}] ${t.description}`,
      parameters: t.inputSchema,
    },
  }))
}

/** 调用 MCP 工具（入参是命名空间后的名字） */
export async function callMcpTool(qualifiedName: string, args: unknown): Promise<string> {
  const { clients, tools } = await getMcpState()
  const def = tools.find((t) => t.qualifiedName === qualifiedName)
  if (!def) return `错误：未知的 MCP 工具 ${qualifiedName}`
  const serverName = qualifiedName.split('__')[1]
  const client = clients.find((c) => c.serverName === serverName)
  if (!client) return `错误：MCP 服务器 ${serverName} 未连接`
  const r = await client.callTool(def.name, args)
  return r.isError ? `错误：${r.text}` : r.text
}

/** 只读的 MCP 工具集合（并发调度的安全白名单） */
export async function getMcpReadOnlySet(): Promise<Set<string>> {
  const { tools } = await getMcpState()
  return new Set(tools.filter((t) => t.readOnly).map((t) => t.qualifiedName))
}

/** 关闭所有 MCP 连接（进程退出/测试清理用） */
export async function closeMcp(): Promise<void> {
  if (!cache) return
  const st = await cache
  await Promise.all(st.clients.map((c) => c.close()))
  cache = null
}

export { isMcpToolName }
export type { McpToolDef }
