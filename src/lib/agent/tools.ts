/**
 * 沙箱工具集：Agent 可调用的全部工具（Tool Calling）。
 *
 * 设计对标 Claude Code 的工具范式：
 *  - **edit_file / multi_edit**：精确字符串替换，而不是整文件重写（省 token、不易覆盖无关改动）
 *  - **read_file(offset/limit)**：按行区间读取，长文件不必全量读入
 *  - **glob**：按文件名模式定位文件
 *  - **grep**：文本检索（输出模式 / glob 过滤 / 上下文行）
 *  - **search_ast / search_semantic**：语法树结构化检索 + 向量语义检索（grep 答不了的结构问题）
 *  - **todo_write**：维护结构化任务清单，长任务可追踪
 *  - **run_command / run_tests / git_operation**：终端、测试、Git
 *
 * 所有路径均经 safeResolve 限制在会话沙箱内。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { safeResolve, sessionDir } from './workspace'
import {
  searchAst,
  searchSemantic,
  formatSemanticHits,
  globFiles,
  grepWorkspace,
  type AstKind,
} from './search'
import { buildDocx, buildPptx, parseDocxSpec, parsePptxSpec } from './docgen'

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
const COMMAND_TIMEOUT_MS = 30_000
/** 命令白名单：只允许在沙箱内执行这些可执行文件 */
const COMMAND_ALLOWLIST = new Set([
  'node', 'ls', 'cat', 'echo', 'mkdir', 'pwd', 'wc', 'grep', 'find', 'git',
])

/** todo 状态取值（与 Claude Code 的 TodoWrite 对齐） */
export const TODO_STATUSES = ['pending', 'in_progress', 'completed'] as const
export type TodoStatus = (typeof TODO_STATUSES)[number]
export interface TodoItem {
  content: string
  status: TodoStatus
  activeForm?: string
}

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

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  return haystack.split(needle).length - 1
}

/**
 * 重复读取抑制。
 *
 * 真实仓库任务里观察到 Agent 会**反复读取同一文件的同一区间**
 * （实测一次 30 步的任务里把 lib/parser.js 读了 8 遍，最后耗尽步数还没改完）。
 * 这里记录「会话 + 文件 + 行区间 → 内容摘要 + 读取序号」，
 * 若同一区间在**最近 N 次工具调用内**读到完全相同的内容，就不再重复返回全文。
 *
 * 只压制「近期重复」是刻意的：如果早先的结果已被上下文压缩掉，
 * 再读时应当正常返回全文，否则 Agent 会永久丢失这段内容。
 */
const RECENT_READ_WINDOW = 6
let toolSeq = 0
const readCache = new Map<string, Map<string, { digest: string; seq: number }>>()

function suppressDuplicateRead(sessionId: string, key: string, digest: string): boolean {
  toolSeq++
  let cache = readCache.get(sessionId)
  if (!cache) {
    cache = new Map()
    readCache.set(sessionId, cache)
  }
  const prev = cache.get(key)
  const isDup = Boolean(prev && prev.digest === digest && toolSeq - prev.seq <= RECENT_READ_WINDOW)
  cache.set(key, { digest, seq: toolSeq })
  return isDup
}

/** 校验并归一化 todo 列表（供 executeTool 与 loop 的事件发射共用） */
export function normalizeTodos(raw: unknown): { ok: true; todos: TodoItem[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'todos 必须是非空数组' }
  const todos: TodoItem[] = []
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i] as { content?: unknown; status?: unknown; activeForm?: unknown }
    if (!t || typeof t.content !== 'string' || !t.content.trim()) {
      return { ok: false, error: `第 ${i + 1} 项缺少 content（string）` }
    }
    if (!TODO_STATUSES.includes(String(t.status) as TodoStatus)) {
      return { ok: false, error: `第 ${i + 1} 项 status 非法，应为 ${TODO_STATUSES.join(' | ')}` }
    }
    todos.push({
      content: t.content.trim(),
      status: String(t.status) as TodoStatus,
      activeForm: typeof t.activeForm === 'string' ? t.activeForm : undefined,
    })
  }
  return { ok: true, todos }
}

export function formatTodos(todos: TodoItem[]): string {
  const mark = (s: TodoStatus) => (s === 'completed' ? '[x]' : s === 'in_progress' ? '[>]' : '[ ]')
  const done = todos.filter((t) => t.status === 'completed').length
  const lines = todos.map((t, i) => `${mark(t.status)} ${i + 1}. ${t.content}`)
  return `任务清单已更新（${done}/${todos.length} 已完成）：\n${lines.join('\n')}`
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
      description: '读取工作区内文件内容（带行号）。大文件建议用 offset/limit 只读相关片段。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件相对路径，如 src/app.js' },
          offset: { type: 'number', description: '起始行号（1 起，默认 1）' },
          limit: { type: 'number', description: `最多读取行数（默认 ${MAX_READ_LINES}）` },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        '对已存在文件做**精确字符串替换**（修改代码的首选方式）。'
        + 'old_string 必须与文件内容逐字符一致（含缩进与换行）；若它在文件中出现多次，'
        + '需扩大上下文使其唯一，或显式设置 replace_all=true。找不到 old_string 会报错。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件相对路径' },
          old_string: { type: 'string', description: '要被替换的原文（需唯一）' },
          new_string: { type: 'string', description: '替换后的新内容' },
          replace_all: { type: 'boolean', description: '是否替换全部出现处，默认 false' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'multi_edit',
      description:
        '对**同一个文件**按顺序施加多处替换，全部成功才写入（原子）。'
        + '适合一次改多处的场景，避免多次往返。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件相对路径' },
          edits: {
            type: 'array',
            description: '替换列表，按顺序应用',
            items: {
              type: 'object',
              properties: {
                old_string: { type: 'string' },
                new_string: { type: 'string' },
                replace_all: { type: 'boolean' },
              },
              required: ['old_string', 'new_string'],
            },
          },
        },
        required: ['path', 'edits'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        '写入（创建或整体覆盖）文件。**仅用于新建文件或需要整体重写的场景**；'
        + '修改已有文件的局部内容请优先用 edit_file。',
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
      name: 'glob',
      description:
        '按文件名模式查找文件（支持 **、*、?、{a,b}），如 "**/*.test.js"、"src/**/*.js"。'
        + '用于快速定位文件，比 list_files 更聚焦。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'glob 模式，如 **/*.test.js' },
          path: { type: 'string', description: '限定子目录，如 src/' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description:
        '在工作区文件里做文本检索（正则）。适合找标识符、字符串、配置项。'
        + 'output_mode：content=返回命中行（可带上下文）、files_with_matches=只返回文件名、count=每文件命中数。'
        + '需要「谁定义/谁调用」这类结构信息时请改用 search_ast。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '正则或普通文本' },
          output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] },
          glob: { type: 'string', description: '只搜匹配该 glob 的文件，如 src/**/*.js' },
          ignore_case: { type: 'boolean', description: '忽略大小写，默认 false' },
          context_lines: { type: 'number', description: '命中行前后各显示 N 行（仅 content 模式）' },
          head_limit: { type: 'number', description: '最多返回条数，默认 50' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_ast',
      description:
        'AST 结构化检索（基于语法树，不受注释/字符串干扰）：按符号名查找函数/类/方法/变量/调用/导入导出。'
        + '适合回答「谁定义了 X」「哪些地方调用了 X」「这个文件导出了什么」。'
        + 'kind 可选 function|class|method|variable|call|export|import|interface|type|any。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '符号名（子串或正则）' },
          kind: { type: 'string', description: '结构类别，默认 any' },
          sub: { type: 'string', description: '限定子目录，如 src/' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_semantic',
      description:
        '向量语义检索（TF-IDF 词袋向量 + 余弦相似度）：用自然语言描述意图，按「意思」而非字面召回最相关的代码块。'
        + '适合不确定函数名、只想找「处理某某逻辑的那段代码」时使用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '自然语言意图，如「解析运算符优先级的地方」' },
          topK: { type: 'number', description: '返回条数，默认 5' },
          sub: { type: 'string', description: '限定子目录，如 src/' },
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
        '在沙箱内执行白名单命令（node/ls/cat/echo/mkdir/pwd/wc/grep/find/git）。'
        + 'command 为不含 shell 元字符的参数数组，如 ["node","tools/reference.js","--emit"]。',
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
      description: '运行项目测试（node --test），解析并返回通过/失败统计。改完代码务必用它自验证。',
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
  {
    type: 'function',
    function: {
      name: 'generate_docx',
      description:
        '生成 Word 文档（.docx）并写入工作区。用于产出报告、方案、说明书等**交付物**。'
        + 'spec 结构：{ title?, subtitle?, sections: [{ heading?, paragraphs?: string[], bullets?: string[] }] }',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '输出文件相对路径，如 docs/方案.docx' },
          spec: {
            type: 'object',
            description: '文档结构',
            properties: {
              title: { type: 'string', description: '文档标题' },
              subtitle: { type: 'string', description: '副标题' },
              sections: {
                type: 'array',
                description: '章节列表',
                items: {
                  type: 'object',
                  properties: {
                    heading: { type: 'string', description: '章节标题' },
                    paragraphs: { type: 'array', items: { type: 'string' }, description: '正文段落' },
                    bullets: { type: 'array', items: { type: 'string' }, description: '项目符号条目' },
                  },
                },
              },
            },
            required: ['sections'],
          },
        },
        required: ['path', 'spec'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_pptx',
      description:
        '生成 PowerPoint 演示文稿（.pptx）并写入工作区，用于产出汇报 / 讲解材料。'
        + 'spec 结构：{ title?, subtitle?, slides: [{ title, bullets?: string[], notes? }] }（会额外生成封面页）',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '输出文件相对路径，如 docs/汇报.pptx' },
          spec: {
            type: 'object',
            description: '演示文稿结构',
            properties: {
              title: { type: 'string', description: '封面标题' },
              subtitle: { type: 'string', description: '封面副标题' },
              slides: {
                type: 'array',
                description: '内容页列表',
                items: {
                  type: 'object',
                  properties: {
                    title: { type: 'string', description: '页面标题' },
                    bullets: { type: 'array', items: { type: 'string' }, description: '要点' },
                    notes: { type: 'string', description: '演讲者备注' },
                  },
                  required: ['title'],
                },
              },
            },
            required: ['slides'],
          },
        },
        required: ['path', 'spec'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'todo_write',
      description:
        '维护结构化任务清单。任务多于 2-3 步、或用户给了多项要求时使用。'
        + '每次调用传入**完整**清单（不是增量）：pending 待办 / in_progress 进行中（同一时刻最多一个）/ completed 已完成。'
        + '完成一项就立即更新状态，让进度对用户可见。',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: '完整任务清单',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', description: '任务内容（祈使句）' },
                status: { type: 'string', enum: [...TODO_STATUSES] },
                activeForm: { type: 'string', description: '进行中的展示文案' },
              },
              required: ['content', 'status'],
            },
          },
        },
        required: ['todos'],
      },
    },
  },
]

/** 按名称过滤工具集（对照实验用）。传 undefined = 返回全部工具；传 [] = 返回空 */
export function filterTools(names?: string[]): ToolDef[] {
  if (!names) return TOOLS
  return TOOLS.filter((t) => names.includes(t.function.name))
}

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
      const offsetRaw = Number(args.offset)
      const start = Number.isFinite(offsetRaw) && offsetRaw > 1 ? Math.floor(offsetRaw) - 1 : 0
      const limitRaw = Number(args.limit)
      const limit =
        Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 2000) : MAX_READ_LINES
      const end = Math.min(lines.length, start + limit)
      const shown = lines.slice(start, end)
      const numbered = shown.map((l, i) => `${String(start + i + 1).padStart(5)}| ${l}`).join('\n')
      const tail =
        end < lines.length
          ? `\n...[共 ${lines.length} 行，已显示 ${start + 1}-${end}；可用 offset/limit 继续]`
          : ''
      // 同一区间刚刚读过且内容没变 → 不重复返回，省下上下文与步数
      const digest = createHash('sha1').update(numbered).digest('hex')
      if (suppressDuplicateRead(ctx.sessionId, `${args.path}:${start}:${end}`, digest)) {
        return `(重复读取：${args.path} 第 ${start + 1}-${end} 行与刚才读到的内容完全一致，不再重复返回。请直接基于已读内容继续，或用 grep/search_ast 精确定位。)`
      }
      return numbered + tail
    }
    case 'edit_file': {
      const p = safeResolve(ctx.sessionId, String(args.path ?? ''))
      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
        return `错误：文件不存在 ${args.path}（新建请用 write_file）`
      }
      const oldStr = String(args.old_string ?? '')
      const newStr = String(args.new_string ?? '')
      if (!oldStr) return '错误：old_string 不能为空'
      if (oldStr === newStr) return '错误：old_string 与 new_string 相同，无需修改'
      const before = fs.readFileSync(p, 'utf-8')
      const count = countOccurrences(before, oldStr)
      if (count === 0) {
        return '错误：未找到 old_string。请先用 read_file 确认精确内容（注意缩进/换行/全角半角）。'
      }
      const replaceAll = Boolean(args.replace_all)
      if (count > 1 && !replaceAll) {
        return `错误：old_string 在文件中出现 ${count} 次，不唯一。请扩大上下文使其唯一，或设置 replace_all=true。`
      }
      const after = replaceAll ? before.split(oldStr).join(newStr) : before.replace(oldStr, newStr)
      fs.writeFileSync(p, after)
      return `已编辑 ${args.path}：替换 ${replaceAll ? count : 1} 处（${before.length} → ${after.length} 字符）`
    }
    case 'multi_edit': {
      const p = safeResolve(ctx.sessionId, String(args.path ?? ''))
      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
        return `错误：文件不存在 ${args.path}（新建请用 write_file）`
      }
      const edits = Array.isArray(args.edits) ? (args.edits as Record<string, unknown>[]) : []
      if (!edits.length) return '错误：edits 不能为空'
      const before = fs.readFileSync(p, 'utf-8')
      let text = before
      const applied: string[] = []
      for (let i = 0; i < edits.length; i++) {
        const o = String(edits[i].old_string ?? '')
        const n = String(edits[i].new_string ?? '')
        const all = Boolean(edits[i].replace_all)
        if (!o) return `错误：第 ${i + 1} 处 old_string 为空（未做任何修改）`
        const c = countOccurrences(text, o)
        if (c === 0) return `错误：第 ${i + 1} 处未找到 old_string（未做任何修改）`
        if (c > 1 && !all) return `错误：第 ${i + 1} 处 old_string 不唯一（${c} 次）（未做任何修改）`
        text = all ? text.split(o).join(n) : text.replace(o, n)
        applied.push(`第 ${i + 1} 处替换 ${all ? c : 1} 次`)
      }
      fs.writeFileSync(p, text)
      return `已对 ${args.path} 应用 ${edits.length} 处替换（${before.length} → ${text.length} 字符）：\n${applied.join('\n')}`
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
    case 'glob': {
      const pattern = String(args.pattern ?? '')
      if (!pattern) return '错误：pattern 不能为空'
      try {
        const files = globFiles(sessionDir(ctx.sessionId), pattern, args.path ? String(args.path) : undefined)
        if (!files.length) return `无匹配（pattern="${pattern}"）`
        return `匹配 ${files.length} 个文件：\n${files.join('\n')}`
      } catch (e) {
        return `glob 异常：${e instanceof Error ? e.message : String(e)}`
      }
    }
    case 'grep': {
      const pattern = String(args.pattern ?? '')
      if (!pattern) return '错误：pattern 不能为空'
      const mode = args.output_mode ? String(args.output_mode) : 'files_with_matches'
      if (!['content', 'files_with_matches', 'count'].includes(mode)) {
        return '错误：output_mode 只能是 content | files_with_matches | count'
      }
      try {
        return grepWorkspace(sessionDir(ctx.sessionId), pattern, {
          outputMode: mode as 'content' | 'files_with_matches' | 'count',
          glob: args.glob ? String(args.glob) : undefined,
          ignoreCase: Boolean(args.ignore_case),
          contextLines: Number.isFinite(Number(args.context_lines)) ? Number(args.context_lines) : 0,
          headLimit: Number.isFinite(Number(args.head_limit)) ? Number(args.head_limit) : 50,
        })
      } catch (e) {
        return `错误：非法正则 ${pattern}（${e instanceof Error ? e.message : String(e)}）`
      }
    }
    case 'search_ast': {
      const query = String(args.query ?? '')
      const kind = (args.kind ? String(args.kind) : 'any') as AstKind | 'any'
      const sub = args.sub ? String(args.sub) : undefined
      try {
        return searchAst(sessionDir(ctx.sessionId), query, { kind, sub })
      } catch (e) {
        return `AST 检索异常：${e instanceof Error ? e.message : String(e)}`
      }
    }
    case 'search_semantic': {
      const query = String(args.query ?? '')
      const topK = Number.isFinite(args.topK) ? Math.max(1, Math.min(20, Number(args.topK))) : 5
      const sub = args.sub ? String(args.sub) : undefined
      try {
        const hits = searchSemantic(sessionDir(ctx.sessionId), query, topK, sub)
        return formatSemanticHits(hits, query)
      } catch (e) {
        return `语义检索异常：${e instanceof Error ? e.message : String(e)}`
      }
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
    case 'generate_docx': {
      const parsed = parseDocxSpec(args.spec)
      if (!parsed.ok) return `错误：${parsed.error}`
      const rel = String(args.path ?? '')
      if (!/\.docx$/i.test(rel)) return '错误：path 需以 .docx 结尾'
      const p = safeResolve(ctx.sessionId, rel)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      try {
        const buf = await buildDocx(parsed.value!)
        fs.writeFileSync(p, buf)
        const secs = parsed.value!.sections?.length ?? 0
        return `已生成 Word 文档 ${rel}（${buf.length} 字节，${secs} 个章节）。可在工作区面板下载打开。`
      } catch (e) {
        return `生成 docx 失败：${e instanceof Error ? e.message : String(e)}`
      }
    }
    case 'generate_pptx': {
      const parsed = parsePptxSpec(args.spec)
      if (!parsed.ok) return `错误：${parsed.error}`
      const rel = String(args.path ?? '')
      if (!/\.pptx$/i.test(rel)) return '错误：path 需以 .pptx 结尾'
      const p = safeResolve(ctx.sessionId, rel)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      try {
        const buf = await buildPptx(parsed.value!)
        fs.writeFileSync(p, buf)
        return `已生成 PPT ${rel}（${buf.length} 字节，${parsed.value!.slides.length} 页内容 + 封面）。可在工作区面板下载打开。`
      } catch (e) {
        return `生成 pptx 失败：${e instanceof Error ? e.message : String(e)}`
      }
    }
    case 'todo_write': {
      const norm = normalizeTodos(args.todos)
      if (!norm.ok) return `错误：${norm.error}`
      return formatTodos(norm.todos)
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
