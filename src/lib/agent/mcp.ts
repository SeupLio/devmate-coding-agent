/**
 * 最小 MCP（Model Context Protocol）客户端。
 *
 * 为什么要接 MCP：内置工具再多也是「我写死的」。MCP 让 Agent 在**运行时**
 * 连上任意工具服务器并动态发现工具 —— 这是「工具无关的 Agent 运行时」与
 * 「一堆硬编码函数」的分界线。
 *
 * 为什么手写而不是引官方 SDK：
 *  - 协议本身很小（JSON-RPC 2.0 + 换行分隔），零依赖
 *  - 手写能证明真的读懂了协议，而不是「会调库」
 *
 * 支持的 MCP 能力（最小可用集）：
 *  - `initialize` 握手（含协议版本协商）
 *  - `tools/list`  动态发现工具
 *  - `tools/call`  调用工具
 *  - 优雅关闭 + 请求超时 + 进程崩溃感知
 *
 * 传输：stdio，**换行分隔的 JSON-RPC 2.0**。
 * ⚠️ 注意不是 LSP 的 `Content-Length` 分帧 —— 这一点很容易搞混。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

/** 客户端声明支持的 MCP 协议版本 */
export const MCP_PROTOCOL_VERSION = '2024-11-05'

export interface McpServerConfig {
  /** 服务器名，用于工具命名空间 */
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
  /** 单次请求超时（毫秒） */
  timeoutMs?: number
}

export interface McpToolDef {
  /** 服务器内原始工具名 */
  name: string
  /** 命名空间后的名字：mcp__<server>__<tool>（避免与内置工具撞名） */
  qualifiedName: string
  description: string
  inputSchema: Record<string, unknown>
  /**
   * 是否只读（来自 MCP annotations.readOnlyHint）。
   * 只读工具才允许被并发调度 —— 否则两个写工具并发会互相踩。
   * 默认 false（**保守**：没声明就当作有副作用）。
   */
  readOnly: boolean
}

export interface McpCallResult {
  text: string
  isError: boolean
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
  method: string
}

/** 把 MCP 工具名规范成 `mcp__<server>__<tool>`，并保证可逆 */
export function qualifyToolName(server: string, tool: string): string {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_')
  return `mcp__${safe(server)}__${safe(tool)}`
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith('mcp__')
}

export class McpClient {
  private child: ChildProcessWithoutNullStreams
  private pending = new Map<number, Pending>()
  private nextId = 1
  private stderrBuf: string[] = []
  private closed = false
  private tools: McpToolDef[] = []

  readonly serverName: string
  serverInfo: { name?: string; version?: string } = {}
  /** 服务器声明的能力 */
  capabilities: Record<string, unknown> = {}

  private constructor(cfg: McpServerConfig) {
    this.serverName = cfg.name
    this.timeoutMs = cfg.timeoutMs ?? 15_000

    this.child = spawn(cfg.command, cfg.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(cfg.env ?? {}) },
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams

    // stdout：换行分隔的 JSON-RPC 帧
    const rl = createInterface({ input: this.child.stdout })
    rl.on('line', (line) => this.onLine(line))

    // stderr：服务器日志，留作诊断（不计入协议）
    const rlErr = createInterface({ input: this.child.stderr })
    rlErr.on('line', (l) => {
      this.stderrBuf.push(l)
      if (this.stderrBuf.length > 50) this.stderrBuf.shift()
    })

    this.child.on('exit', (code, signal) => {
      this.closed = true
      const err = new Error(
        `MCP 服务器 ${cfg.name} 退出（code=${code} signal=${signal}）` +
          (this.stderrBuf.length ? `；stderr: ${this.stderrBuf.slice(-3).join(' | ')}` : ''),
      )
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(err)
      }
      this.pending.clear()
    })
    this.child.on('error', (e) => {
      this.closed = true
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(e)
      }
      this.pending.clear()
    })
  }

  private timeoutMs: number

  /** 启动并完成 initialize 握手 */
  static async connect(cfg: McpServerConfig): Promise<McpClient> {
    const c = new McpClient(cfg)
    try {
      const res = (await c.request('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        clientInfo: { name: 'devmate', version: '1.0.0' },
      })) as {
        protocolVersion?: string
        capabilities?: Record<string, unknown>
        serverInfo?: { name?: string; version?: string }
      }
      c.serverInfo = res.serverInfo ?? {}
      c.capabilities = res.capabilities ?? {}
      // 握手完成后必须发这条通知，服务器才会开始正常工作
      c.notify('notifications/initialized', {})
      return c
    } catch (e) {
      await c.close()
      throw e
    }
  }

  private onLine(line: string) {
    const t = line.trim()
    if (!t) return
    let msg: {
      id?: number
      result?: unknown
      error?: { code: number; message: string }
      method?: string
    }
    try {
      msg = JSON.parse(t)
    } catch {
      return // 非 JSON 行直接忽略（有些服务器会往 stdout 打日志）
    }
    // 服务器主动发起的通知/请求：本最小实现只忽略，不处理
    if (msg.id === undefined) return
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.error) p.reject(new Error(`MCP ${p.method} 失败：${msg.error.message}（code=${msg.error.code}）`))
    else p.resolve(msg.result)
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error(`MCP 服务器 ${this.serverName} 已关闭`))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP ${this.serverName}.${method} 超时（${this.timeoutMs}ms）`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer, method })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  private notify(method: string, params: unknown) {
    if (this.closed) return
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  /** 动态发现工具，并加上命名空间 */
  async listTools(): Promise<McpToolDef[]> {
    const res = (await this.request('tools/list', {})) as {
      tools?: {
        name: string
        description?: string
        inputSchema?: Record<string, unknown>
        annotations?: { readOnlyHint?: boolean }
      }[]
    }
    this.tools = (res.tools ?? []).map((t) => ({
      name: t.name,
      qualifiedName: qualifyToolName(this.serverName, t.name),
      description: t.description ?? '',
      inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
      // 未声明 readOnlyHint 一律视为「有副作用」，避免并发踩踏
      readOnly: t.annotations?.readOnlyHint === true,
    }))
    return this.tools
  }

  /** 调用工具；把 MCP 的 content 数组拍平成纯文本 */
  async callTool(toolName: string, args: unknown): Promise<McpCallResult> {
    try {
      const res = (await this.request('tools/call', { name: toolName, arguments: args ?? {} })) as {
        content?: { type: string; text?: string }[]
        isError?: boolean
      }
      const text = (res.content ?? [])
        .map((c) => (c.type === 'text' ? (c.text ?? '') : `[${c.type}]`))
        .join('\n')
        .trim()
      return { text: text || '(工具返回空内容)', isError: Boolean(res.isError) }
    } catch (e) {
      return { text: `错误：${e instanceof Error ? e.message : String(e)}`, isError: true }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error('MCP 客户端已关闭'))
    }
    this.pending.clear()
    try {
      this.child.stdin.end()
      this.child.kill()
    } catch {
      /* ignore */
    }
  }
}

/** 一次性连接多个 MCP 服务器；单个失败不影响其余（返回失败清单） */
export async function connectMcpServers(configs: McpServerConfig[]): Promise<{
  clients: McpClient[]
  tools: McpToolDef[]
  failures: { name: string; error: string }[]
}> {
  const clients: McpClient[] = []
  const tools: McpToolDef[] = []
  const failures: { name: string; error: string }[] = []
  for (const cfg of configs) {
    try {
      const c = await McpClient.connect(cfg)
      clients.push(c)
      tools.push(...(await c.listTools()))
    } catch (e) {
      failures.push({ name: cfg.name, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return { clients, tools, failures }
}
