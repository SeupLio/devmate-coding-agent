/**
 * 权限模型：Agent 会**自主执行写操作**，没有闸门就是事故。
 *
 * 这一层回答三个问题：
 *  1. **这个操作有多危险？** → 工具风险分级（read / write / execute / destructive）
 *  2. **当前策略下该不该放行？** → 权限模式 + 规则化 allow/deny/ask
 *  3. **碰到了敏感文件吗？** → 硬拦截（`.env` / 私钥 / 凭据）
 *
 * 设计参照 Claude Code 的权限模式，但把判定逻辑抽成**纯函数**，便于测试与审计。
 *
 * ⚠️ 一个诚实的边界：`run_command` 白名单里有 `node`，而 node 是图灵完备的
 * （`node -e "require('fs').writeFileSync(...)"` 可以绕过所有路径校验）。
 * 所以这层权限是**纵深防御的一环，不是隔离**。真正的隔离要靠容器。
 */
import path from 'node:path'

export type PermissionMode =
  /** 每次写/执行都问（默认，最安全） */
  | 'default'
  /** 自动接受文件编辑，但执行命令仍要问 */
  | 'acceptEdits'
  /** 只读：先出方案，不改任何东西 */
  | 'plan'
  /** 全部放行（仅用于可信环境 / 自动化评测） */
  | 'bypassPermissions'

export type RiskLevel = 'read' | 'write' | 'execute' | 'destructive'

export type PermissionAction = 'allow' | 'deny' | 'ask'

export interface PermissionDecision {
  action: PermissionAction
  risk: RiskLevel
  /** 给人看的理由（会写进审计日志 / 前端提示） */
  reason: string
  /** 命中的规则（审计用） */
  rule?: string
}

/** 规则化 allow / deny / ask。越具体的规则优先级越高。 */
export interface PermissionRule {
  /** 工具名，支持 `*` 通配（如 `mcp__*`） */
  tool: string
  /** 可选：路径 glob 或命令子串（大小写不敏感） */
  pattern?: string
  action: PermissionAction
}

export interface PermissionContext {
  mode: PermissionMode
  rules?: PermissionRule[]
  /** 额外的敏感文件正则（叠加在内置清单之上） */
  extraSensitive?: RegExp[]
}

// ===================== 工具风险分级 =====================

/** 只读工具：无副作用 */
const READ_TOOLS = new Set([
  'list_files', 'read_file', 'glob', 'grep', 'search_ast', 'search_semantic',
  // `task`（子 Agent 委派）归为只读：子 Agent 的工具集被强制限制为只读，
  // 所以「委派调研」这个动作本身不会改动任何文件。若它真能写文件，这里必须改回 execute。
  'task',
])

/** 写工具：改文件内容 */
const WRITE_TOOLS = new Set([
  'edit_file', 'multi_edit', 'write_file', 'generate_docx', 'generate_pptx',
])

/** 执行工具：起子进程 */
const EXECUTE_TOOLS = new Set(['run_command', 'run_tests', 'git_operation'])

/** `todo_write` 只改 UI 状态，不碰文件系统 */
const NEUTRAL_TOOLS = new Set(['todo_write'])

export function classifyRisk(toolName: string): RiskLevel {
  if (READ_TOOLS.has(toolName) || NEUTRAL_TOOLS.has(toolName)) return 'read'
  if (WRITE_TOOLS.has(toolName)) return 'write'
  if (EXECUTE_TOOLS.has(toolName)) return 'execute'
  // 未知工具（含 MCP 工具）保守当作 execute —— 外部行为不可知
  return 'execute'
}

// ===================== 敏感文件 =====================

/**
 * 默认硬拦截的敏感文件。命中即 **deny**（不可被规则覆盖），
 * 因为一次提示注入就能让 Agent 把密钥写进产物。
 */
export const DEFAULT_SENSITIVE_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\..+)?$/i,
  /(^|\/)\.env$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.git-credentials$/i,
  /(^|\/)\.aws(\/|$)/i,
  /(^|\/)\.ssh(\/|$)/i,
  /(^|\/)(secrets?|credentials?)\.[a-z0-9]+$/i,
]

export function isSensitivePath(p: string, extra: RegExp[] = []): boolean {
  const norm = String(p).replace(/\\/g, '/')
  const base = path.basename(norm)
  return [...DEFAULT_SENSITIVE_PATTERNS, ...extra].some((re) => re.test(norm) || re.test(base))
}

// ===================== 破坏性命令 =====================

/** 破坏性 / 不可逆操作：命中一律 `ask`（即使 acceptEdits 也要问） */
const DESTRUCTIVE_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i, label: '递归强制删除' },
  { re: /\brm\s+-rf?\b/i, label: '强制删除' },
  { re: /git\s+reset\s+--hard/i, label: 'git reset --hard（丢弃未提交改动）' },
  { re: /git\s+push\s+.*(--force|-f)\b/i, label: 'git push --force（覆盖远端历史）' },
  { re: /git\s+clean\s+-[a-z]*[fd]/i, label: 'git clean（删除未跟踪文件）' },
  { re: /git\s+branch\s+-D/i, label: 'git 强制删除分支' },
  { re: /\bdel\s+\/[sq]\b/i, label: 'Windows 递归删除' },
  { re: /\b(format|fdisk|mkfs)\b/i, label: '磁盘格式化' },
  { re: /\bdrop\s+(table|database)\b/i, label: 'DROP TABLE/DATABASE' },
  { re: /\btruncate\s+table\b/i, label: 'TRUNCATE TABLE' },
  { re: />\s*\/dev\/(sd|nvme)/i, label: '直写块设备' },
  { re: /\bchmod\s+-R\s+777\b/i, label: 'chmod -R 777' },
  { re: /:\s*\(\)\s*\{.*\};\s*:/, label: 'fork bomb' },
]

export function findDestructive(command: string): string | null {
  for (const p of DESTRUCTIVE_PATTERNS) if (p.re.test(command)) return p.label
  return null
}

/** 网络访问（数据外泄面） */
const NETWORK_PATTERNS = /\b(curl|wget|Invoke-WebRequest|nc|ncat|telnet|ssh|scp|rsync)\b/i

export function findNetworkUse(command: string): string | null {
  return NETWORK_PATTERNS.test(command) ? '命令涉及网络访问' : null
}

// ===================== 规则匹配 =====================

/** `*` 通配转正则 */
function globToRe(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${esc}$`, 'i')
}

/** 规则的「具体度」：越具体优先级越高 */
function specificity(r: PermissionRule): number {
  return (r.pattern ? 2 : 0) + (r.tool.includes('*') ? 0 : 1)
}

/** 从工具参数里取出「被作用的路径」或「命令文本」，用于规则匹配 */
export function extractSubject(tool: string, args: Record<string, unknown>): string {
  if (typeof args.command === 'string') return args.command
  if (typeof args.path === 'string') return args.path
  if (typeof args.file_path === 'string') return args.file_path
  if (typeof args.pattern === 'string') return args.pattern
  // multi_edit 的 edits[].path
  const edits = args.edits
  if (Array.isArray(edits) && edits.length && typeof (edits[0] as { path?: unknown })?.path === 'string') {
    return String((edits[0] as { path: string }).path)
  }
  return ''
}

// ===================== 主判定 =====================

/**
 * 判定一次工具调用是否放行。**纯函数**（不读全局状态），便于测试与回放。
 *
 * 判定顺序（重要）：
 *  1. 敏感文件 → **硬 deny**（任何模式、任何规则都覆盖不了）
 *  2. 显式 deny 规则
 *  3. 破坏性操作 → ask（bypassPermissions 除外）
 *  4. 显式 allow/ask 规则（按具体度）
 *  5. 按权限模式的默认策略
 */
export function evaluatePermission(
  tool: string,
  args: Record<string, unknown>,
  ctx: PermissionContext,
): PermissionDecision {
  const risk = classifyRisk(tool)
  const subject = extractSubject(tool, args)

  // 1) 敏感文件硬拦截 —— 即使 bypassPermissions 也不放行
  if (subject && isSensitivePath(subject, ctx.extraSensitive)) {
    return {
      action: 'deny',
      risk,
      reason: `命中敏感文件保护（${path.basename(subject.replace(/\\/g, '/'))}）：禁止读取或写入凭据类文件`,
    }
  }
  if (tool === 'run_command' && typeof args.command === 'string' && isSensitivePath(args.command)) {
    return { action: 'deny', risk, reason: '命令中涉及敏感文件路径，已拦截' }
  }

  // 2) 显式规则（deny 优先；同 action 取最具体）
  const rules = (ctx.rules ?? [])
    .filter((r) => globToRe(r.tool).test(tool))
    .filter((r) => (r.pattern ? subject.toLowerCase().includes(r.pattern.toLowerCase()) : true))
    .sort((a, b) => specificity(b) - specificity(a))
  const denyRule = rules.find((r) => r.action === 'deny')
  if (denyRule) {
    return { action: 'deny', risk, reason: `命中 deny 规则（${denyRule.tool}${denyRule.pattern ? `:${denyRule.pattern}` : ''}）`, rule: `${denyRule.tool}` }
  }

  // 3) 破坏性 / 网络：不可逆操作即便在 acceptEdits 下也要问
  if (tool === 'run_command' && typeof args.command === 'string') {
    const dest = findDestructive(args.command)
    if (dest && ctx.mode !== 'bypassPermissions') {
      return { action: 'ask', risk: 'destructive', reason: `检测到不可逆操作：${dest}` }
    }
    const net = findNetworkUse(args.command)
    if (net && ctx.mode !== 'bypassPermissions' && ctx.mode !== 'acceptEdits') {
      return { action: 'ask', risk, reason: net }
    }
  }
  if (tool === 'git_operation' && typeof args.operation === 'string') {
    const dest = findDestructive(String(args.operation))
    if (dest && ctx.mode !== 'bypassPermissions') {
      return { action: 'ask', risk: 'destructive', reason: `检测到不可逆 git 操作：${dest}` }
    }
  }

  // 4) 显式 allow / ask 规则
  const allowRule = rules.find((r) => r.action === 'allow')
  if (allowRule) {
    return { action: 'allow', risk, reason: `命中 allow 规则（${allowRule.tool}${allowRule.pattern ? `:${allowRule.pattern}` : ''}）`, rule: allowRule.tool }
  }
  const askRule = rules.find((r) => r.action === 'ask')
  if (askRule && ctx.mode !== 'bypassPermissions') {
    return { action: 'ask', risk, reason: `命中 ask 规则（${askRule.tool}）`, rule: askRule.tool }
  }

  // 5) 按权限模式的默认策略
  switch (ctx.mode) {
    case 'bypassPermissions':
      return { action: 'allow', risk, reason: 'bypassPermissions：全部放行' }
    case 'plan':
      return risk === 'read'
        ? { action: 'allow', risk, reason: 'plan 模式：只读放行' }
        : { action: 'deny', risk, reason: 'plan 模式：只出方案，不执行写操作与命令' }
    case 'acceptEdits':
      return risk === 'write'
        ? { action: 'allow', risk, reason: 'acceptEdits：自动接受文件编辑' }
        : risk === 'read'
          ? { action: 'allow', risk, reason: 'acceptEdits：只读放行' }
          : { action: 'ask', risk, reason: `acceptEdits 下仍需确认 ${risk} 类操作` }
    case 'default':
    default:
      return risk === 'read'
        ? { action: 'allow', risk, reason: '默认模式：只读放行' }
        : { action: 'ask', risk, reason: `默认模式：${risk} 类操作需要确认` }
  }
}

export const PERMISSION_MODES: PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
]

export function isPermissionMode(v: unknown): v is PermissionMode {
  return typeof v === 'string' && (PERMISSION_MODES as string[]).includes(v)
}
