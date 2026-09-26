/**
 * 沙箱工具集：Agent 可调用的全部工具（Tool Calling）。
 * 涵盖 JD 中的文件编辑、代码检索、终端执行、Git 操作、测试运行。
 * 所有路径均经 safeResolve 限制在会话沙箱内。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { safeResolve, sessionDir } from './workspace'

export interface ToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface ToolContext {
  sessionId: string
}

const MAX_READ_LINES = 400
const MAX_OUTPUT_CHARS = 6000
const MAX_SEARCH_RESULTS = 30
const COMMAND_TIMEOUT_MS = 30_000
/** 命令白名单：只允许在沙箱内执行这些可执行文件 */
const COMMAND_ALLOWLIST = new Set([
  'node', 'ls', 'cat', 'echo', 'mkdir', 'pwd', 'wc', 'grep', 'find', 'git',
])

function truncate(text: string, max = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n...[输出已截断，原始长度 ${text.length} 字符]`
}

function listAllFiles(dir: string, base = ''): string[] {
  const out: string[] = []
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
  for (const e of entries) {
    if (e.name === '.git') continue
    const rel = base ? `${base}/${e.name}` : e.name
    if (e.isDirectory()) {
      out.push(`${rel}/`)
      out.push(...listAllFiles(path.join(dir, e.name), rel))
    } else {
      out.push(rel)
    }
  }
  return out
}

export const TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: '列出工作区中的全部文件（含目录，自动忽略 .git）。无参数。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取工作区内指定文件的内容。path 为相对工作区根目录的路径。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件相对路径，如 src/app.js' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '写入（创建或覆盖）工作区内指定文件，content 为完整文件内容。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件相对路径' },
          content: { type: 'string', description: '完整文件内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_code',
      description: '在全部工作区文件中做代码检索（支持正则），返回文件名、行号与命中行。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词或正则表达式' },
          isRegex: { type: 'boolean', description: '是否按正则解析，默认 false' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        '在沙箱内执行白名单命令（node/ls/cat/echo/mkdir/pwd/wc/grep/find/git）。command 为不含 shell 元字符的参数数组，如 ["node","--test"]。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'array', items: { type: 'string' }, description: '命令及参数数组' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_tests',
      description: '运行项目测试（node --test），解析并返回通过/失败统计。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_operation',
      description:
        'Git 操作：status（状态）、diff（改动）、commit（提交，需 message）。在沙箱内真实执行 git。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'diff', 'commit'] },
          message: { type: 'string', description: 'commit 时的提交信息' },
        },
        required: ['action'],
      },
    },
  },
]

/** 执行单个工具调用，返回字符串形式的结果（会进入对话上下文） */
export async function executeTool(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case 'list_files': {
      const files = listAllFiles(sessionDir(ctx.sessionId))
      if (!files.length) return '(工作区为空)'
      return files.join('\n')
    }
    case 'read_file': {
      const p = safeResolve(ctx.sessionId, String(args.path ?? ''))
      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return `错误：文件不存在 ${args.path}`
      const lines = fs.readFileSync(p, 'utf-8').split('\n')
      const shown = lines.slice(0, MAX_READ_LINES)
      const prefix = lines.length > MAX_READ_LINES ? `\n[仅显示前 ${MAX_READ_LINES} 行 / 共 ${lines.length} 行]` : ''
      return shown.map((l, i) => `${String(i + 1).padStart(3)}| ${l}`).join('\n') + prefix
    }
    case 'write_file': {
      const p = safeResolve(ctx.sessionId, String(args.path ?? ''))
      fs.mkdirSync(path.dirname(p), { recursive: true })
      const content = String(args.content ?? '')
      const existed = fs.existsSync(p)
      const before = existed ? fs.readFileSync(p, 'utf-8') : ''
      fs.writeFileSync(p, content)
      const kind = existed ? (before === content ? '覆盖（内容无变化）' : '覆盖') : '新建'
      return `已${kind} ${args.path}（${content.length} 字符）`
    }
    case 'search_code': {
      const query = String(args.query ?? '')
      const isRegex = Boolean(args.isRegex)
      let re: RegExp
      try {
        re = isRegex ? new RegExp(query) : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      } catch (e) {
        return `错误：非法正则 ${query}`
      }
      const hits: string[] = []
      const walk = (dir: string, base = '') => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.name === '.git' || e.name === 'node_modules') continue
          const rel = base ? `${base}/${e.name}` : e.name
          const full = path.join(dir, e.name)
          if (e.isDirectory()) walk(full, rel)
          else {
            const lines = fs.readFileSync(full, 'utf-8').split('\n')
            lines.forEach((l, i) => {
              if (hits.length >= MAX_SEARCH_RESULTS) return
              if (re.test(l)) hits.push(`${rel}:${i + 1}: ${l.trim().slice(0, 160)}`)
            })
          }
        }
      }
      walk(sessionDir(ctx.sessionId))
      return hits.length ? `共 ${hits.length} 处命中：\n${hits.join('\n')}` : '无命中结果'
    }
    case 'run_command': {
      const command = args.command
      if (!Array.isArray(command) || !command.length) return '错误：command 必须为非空数组'
      const cmd = command.map(String)
      if (!COMMAND_ALLOWLIST.has(cmd[0])) {
        return `错误：命令 ${cmd[0]} 不在白名单内，允许：${[...COMMAND_ALLOWLIST].join(', ')}`
      }
      const { stdout, stderr, code } = await runInSandbox(ctx.sessionId, cmd)
      const out = [stdout && `stdout:\n${stdout}`, stderr && `stderr:\n${stderr}`, `exit code: ${code}`]
        .filter(Boolean)
        .join('\n')
      return truncate(out) || '(无输出)'
    }
    case 'run_tests': {
      const { stdout, stderr, code } = await runInSandbox(ctx.sessionId, ['node', '--test', '--test-reporter=spec'])
      const text = `${stdout}\n${stderr}`
      const pass = (text.match(/✔/g) || []).length
      const fail = (text.match(/✖/g) || []).length
      return `测试执行完成（exit ${code}）：通过 ${pass} 项，失败 ${fail} 项。\n${truncate(text, 4000)}`
    }
    case 'git_operation': {
      const action = String(args.action ?? 'status')
      if (action === 'status') {
        const { stdout, stderr, code } = await runInSandbox(ctx.sessionId, ['git', 'status', '--short', '-b'])
        return code === 0 ? truncate(stdout) : `git status 失败：${stderr}`
      }
      if (action === 'diff') {
        const { stdout, stderr, code } = await runInSandbox(ctx.sessionId, ['git', 'diff', 'HEAD'])
        return code === 0 ? truncate(stdout || '(无改动)') : `git diff 失败：${stderr}`
      }
      if (action === 'commit') {
        const message = String(args.message ?? 'DevMate: update files')
        await runInSandbox(ctx.sessionId, ['git', 'add', '-A'])
        const { stdout, stderr, code } = await runInSandbox(ctx.sessionId, ['git', 'commit', '-m', message])
        return code === 0 ? `提交成功：${truncate(stdout)}` : `提交失败（可能无改动）：${truncate(stderr)}`
      }
      return `错误：未知 git 操作 ${action}`
    }
    default:
      return `错误：未知工具 ${name}`
  }
}

/** 在沙箱目录内执行白名单命令（无 shell，参数数组直传），带超时控制 */
export function runInSandbox(
  sessionId: string,
  cmd: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), {
      cwd: sessionDir(sessionId),
      env: { ...process.env, GIT_AUTHOR_NAME: 'DevMate', GIT_AUTHOR_EMAIL: 'devmate@local', GIT_COMMITTER_NAME: 'DevMate', GIT_COMMITTER_EMAIL: 'devmate@local' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      stdout += '\n[超时：命令被强制终止]'
      child.kill('SIGKILL')
    }, COMMAND_TIMEOUT_MS)
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout: truncate(stdout, 4000), stderr: truncate(stderr, 2000), code: code ?? -1 })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ stdout: '', stderr: String(err), code: -1 })
    })
  })
}
