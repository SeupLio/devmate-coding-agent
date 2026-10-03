/**
 * 代码检索：AST 结构化检索 + 向量语义检索。
 *
 * 为什么需要它（替代/补充纯 grep）：
 *  - grep（search_code）是**纯文本**匹配：搜 "sum" 会命中注释、字符串、变量名，
 *    且无法回答「哪些函数调用了 fibonacci」「这个文件导出了什么」这类**结构问题**；
 *  - AST 检索用 TypeScript 编译器 API 解析源码，按**符号与结构**定位，
 *    不受注释/字符串干扰，能直接回答「谁定义/谁调用/谁导出」；
 *  - 向量检索把代码切成语义块、建 TF-IDF 词袋向量，用**余弦相似度**按
 *    「意思」而非「字面」召回，适合「我该改哪个函数」这类模糊意图。
 *
 * 两者都是**离线、确定性**的：不调用任何外部 embedding 服务，可重复复现。
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

export interface CodeFile {
  rel: string
  abs: string
  text: string
}

const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'])
const SKIP_DIR = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage'])

/** 递归收集工作区内的代码文件（相对路径 + 内容） */
export function walkCodeFiles(root: string, sub = ''): CodeFile[] {
  const out: CodeFile[] = []
  const baseDir = sub ? path.join(root, sub) : root
  if (!fs.existsSync(baseDir)) return out
  const entries = fs.readdirSync(baseDir, { withFileTypes: true })
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const e of entries) {
    if (SKIP_DIR.has(e.name)) continue
    const abs = path.join(baseDir, e.name)
    const rel = sub ? `${sub}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...walkCodeFiles(root, rel))
    else if (CODE_EXT.has(path.extname(e.name).toLowerCase())) {
      try {
        out.push({ rel, abs, text: fs.readFileSync(abs, 'utf-8') })
      } catch {
        /* 忽略无法读取的文件 */
      }
    }
  }
  return out
}

// ===================== 一、AST 结构化检索 =====================

export type AstKind =
  | 'function'
  | 'class'
  | 'method'
  | 'variable'
  | 'call'
  | 'export'
  | 'import'
  | 'interface'
  | 'type'

export interface AstSymbol {
  file: string
  name: string
  kind: AstKind
  line: number
  /** 签名或简短上下文 */
  detail: string
  /** 所属容器（类名 / 函数名），用于 method */
  owner?: string
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
}

function snippet(sf: ts.SourceFile, node: ts.Node, max = 110): string {
  const text = node.getText(sf).replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max) + '…' : text
}

/** 取声明名（标识符或字符串字面量） */
function declName(node: ts.Node): string | null {
  const anyNode = node as { name?: ts.Node }
  if (anyNode.name && ts.isIdentifier(anyNode.name)) return anyNode.name.text
  if (anyNode.name && ts.isStringLiteral(anyNode.name)) return anyNode.name.text
  return null
}

/** 解析单个文件，产出结构化符号 */
export function parseFileSymbols(file: CodeFile): AstSymbol[] {
  const sf = ts.createSourceFile(
    file.rel,
    file.text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    file.rel.endsWith('.tsx') ? ts.ScriptKind.TSX : file.rel.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  )
  const symbols: AstSymbol[] = []

  const visit = (node: ts.Node, owner?: string) => {
    // 函数声明
    if (ts.isFunctionDeclaration(node) && node.name) {
      symbols.push({
        file: file.rel,
        name: node.name.text,
        kind: 'function',
        line: lineOf(sf, node),
        detail: snippet(sf, node),
      })
    } else if (ts.isClassDeclaration(node)) {
      const name = node.name?.text ?? '(anonymous)'
      symbols.push({
        file: file.rel,
        name,
        kind: 'class',
        line: lineOf(sf, node),
        detail: snippet(sf, node),
      })
      for (const m of node.members) {
        if (ts.isMethodDeclaration(m)) {
          const mn = declName(m) ?? '(computed)'
          symbols.push({
            file: file.rel,
            name: mn,
            kind: 'method',
            line: lineOf(sf, m),
            detail: snippet(sf, m),
            owner: name,
          })
        }
      }
    } else if (ts.isMethodDeclaration(node)) {
      const mn = declName(node) ?? '(computed)'
      symbols.push({
        file: file.rel,
        name: mn,
        kind: 'method',
        line: lineOf(sf, node),
        detail: snippet(sf, node),
        owner,
      })
    } else if (ts.isVariableStatement(node)) {
      // const foo = () => {} / function(){} → 视作函数；其余视作变量
      for (const d of node.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue
        const isFn = d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
        symbols.push({
          file: file.rel,
          name: d.name.text,
          kind: isFn ? 'function' : 'variable',
          line: lineOf(sf, d),
          detail: snippet(sf, d),
        })
      }
    } else if (ts.isInterfaceDeclaration(node)) {
      symbols.push({
        file: file.rel,
        name: node.name.text,
        kind: 'interface',
        line: lineOf(sf, node),
        detail: snippet(sf, node),
      })
    } else if (ts.isTypeAliasDeclaration(node)) {
      symbols.push({
        file: file.rel,
        name: node.name.text,
        kind: 'type',
        line: lineOf(sf, node),
        detail: snippet(sf, node),
      })
    } else if (ts.isCallExpression(node)) {
      // 调用：记录被调用名（标识符或 a.b 的属性名）
      let callee: string | null = null
      if (ts.isIdentifier(node.expression)) callee = node.expression.text
      else if (ts.isPropertyAccessExpression(node.expression)) callee = node.expression.name.text
      if (callee) {
        symbols.push({
          file: file.rel,
          name: callee,
          kind: 'call',
          line: lineOf(sf, node),
          detail: snippet(sf, node, 80),
          owner,
        })
      }
    } else if (ts.isImportDeclaration(node)) {
      const mod = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : ''
      const bindings: string[] = []
      const clause = node.importClause
      if (clause?.name) bindings.push(clause.name.text)
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) bindings.push(el.name.text)
      }
      symbols.push({
        file: file.rel,
        name: mod,
        kind: 'import',
        line: lineOf(sf, node),
        detail: `import { ${bindings.join(', ')} } from '${mod}'`,
      })
    } else if (ts.isExportDeclaration(node)) {
      const mod = node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : '(local)'
      symbols.push({
        file: file.rel,
        name: mod,
        kind: 'export',
        line: lineOf(sf, node),
        detail: snippet(sf, node),
      })
    } else if (ts.isExportAssignment(node)) {
      symbols.push({
        file: file.rel,
        name: '(default)',
        kind: 'export',
        line: lineOf(sf, node),
        detail: snippet(sf, node),
      })
    }

    ts.forEachChild(node, (c) => visit(c, owner ?? (ts.isFunctionDeclaration(node) ? node.name?.text : owner)))
  }

  visit(sf)
  return symbols
}

/** 全工作区 AST 索引 */
export function buildAstIndex(root: string, sub?: string): AstSymbol[] {
  const out: AstSymbol[] = []
  for (const f of walkCodeFiles(root, sub)) {
    try {
      out.push(...parseFileSymbols(f))
    } catch {
      /* 解析失败的文件跳过，不影响其他文件 */
    }
  }
  return out
}

export interface AstSearchOptions {
  kind?: AstKind | 'any'
  /** 限定子目录，如 src/ */
  sub?: string
  limit?: number
}

/** AST 检索：按符号名（子串/正则）+ 结构类别过滤 */
export function searchAst(root: string, query: string, opts: AstSearchOptions = {}): string {
  const limit = opts.limit ?? 40
  const kind = opts.kind ?? 'any'
  let re: RegExp | null = null
  try {
    re = query ? new RegExp(query, 'i') : null
  } catch {
    re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  }

  const idx = buildAstIndex(root, opts.sub)
  const hits = idx.filter((s) => {
    if (kind !== 'any' && s.kind !== kind) return false
    if (!re) return true
    return re.test(s.name) || re.test(s.detail)
  })

  if (!hits.length) {
    const kinds = [...new Set(idx.map((s) => s.kind))].join(', ')
    return `AST 检索无命中（query="${query}", kind=${kind}）。索引中共 ${idx.length} 个符号，可用类别：${kinds}`
  }
  const shown = hits.slice(0, limit)
  const lines = shown.map(
    (s) => `${s.file}:${s.line}  [${s.kind}] ${s.owner ? s.owner + '.' : ''}${s.name}  :: ${s.detail}`,
  )
  const head = `AST 命中 ${hits.length} 处${hits.length > limit ? `（显示前 ${limit} 处）` : ''}：`
  return `${head}\n${lines.join('\n')}`
}

// ===================== 二、向量语义检索（TF-IDF + 余弦） =====================

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'it', 'for', 'on', 'with', 'as', 'by',
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'new', 'this',
  'require', 'module', 'exports', 'import', 'from', 'export', 'default', 'class', 'extends',
  'true', 'false', 'null', 'undefined', 'typeof', 'async', 'await', 'try', 'catch', 'throw',
])

/** 代码分词：拆 camelCase / snake_case / kebab-case，小写，去停用词；中文按 2-gram 切分 */
export function tokenizeCode(text: string): string[] {
  const out: string[] = []
  // ASCII 标识符 + 连续中文片段
  const raw = text.match(/[A-Za-z_$][A-Za-z0-9_$]*|[\u4e00-\u9fff]+/g) ?? []
  for (const w of raw) {
    if (/^[\u4e00-\u9fff]+$/.test(w)) {
      // 中文：单字 + 相邻 2-gram（单字太碎、长串太粗，bigram 平衡）
      for (let i = 0; i < w.length; i++) {
        out.push(w[i])
        if (i + 1 < w.length) out.push(w.slice(i, i + 2))
      }
      continue
    }
    const parts = w
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_$]+/g, ' ')
      .toLowerCase()
      .split(/\s+/)
    for (const p of parts) if (p.length >= 2 && !STOP.has(p)) out.push(p)
  }
  return out
}

export interface CodeChunk {
  file: string
  startLine: number
  endLine: number
  text: string
  /** 该块的标题（函数/类名），便于展示 */
  title: string
}

/**
 * 按顶层声明切块：每个函数/类/变量声明一个块，
 * 文件头（import/注释/散落语句）单独成块。
 * 比定长滑窗更贴合「语义单元」。
 */
export function buildChunks(root: string, sub?: string): CodeChunk[] {
  const chunks: CodeChunk[] = []
  for (const f of walkCodeFiles(root, sub)) {
    let sf: ts.SourceFile
    try {
      sf = ts.createSourceFile(f.rel, f.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    } catch {
      continue
    }
    const lines = f.text.split('\n')
    const top = sf.statements
    if (!top.length) {
      chunks.push({ file: f.rel, startLine: 1, endLine: lines.length, text: f.text, title: '(file)' })
      continue
    }
    // 文件头（第一个声明之前的内容）
    const firstStart = sf.getLineAndCharacterOfPosition(top[0].getStart(sf)).line
    if (firstStart > 0) {
      chunks.push({
        file: f.rel,
        startLine: 1,
        endLine: firstStart,
        text: lines.slice(0, firstStart).join('\n'),
        title: '(file header)',
      })
    }
    top.forEach((st, i) => {
      const start = sf.getLineAndCharacterOfPosition(st.getStart(sf)).line
      const endNode = top[i + 1]
      const end = endNode
        ? sf.getLineAndCharacterOfPosition(endNode.getStart(sf)).line
        : lines.length
      const text = lines.slice(start, end).join('\n')
      if (!text.trim()) return
      const name =
        (ts.isFunctionDeclaration(st) && st.name?.text) ||
        (ts.isClassDeclaration(st) && st.name?.text) ||
        (ts.isVariableStatement(st) &&
          st.declarationList.declarations[0] &&
          ts.isIdentifier(st.declarationList.declarations[0].name) &&
          st.declarationList.declarations[0].name.text) ||
        (ts.isInterfaceDeclaration(st) && st.name.text) ||
        null
      chunks.push({
        file: f.rel,
        startLine: start + 1,
        endLine: end,
        text,
        title: name ? String(name) : `(statement ${i + 1})`,
      })
    })
  }
  return chunks
}

interface Vec {
  [term: string]: number
}

function tf(tokens: string[]): Vec {
  const v: Vec = {}
  for (const t of tokens) v[t] = (v[t] ?? 0) + 1
  return v
}

function dot(a: Vec, b: Vec): number {
  let s = 0
  for (const k in a) if (b[k]) s += a[k] * b[k]
  return s
}

function norm(a: Vec): number {
  let s = 0
  for (const k in a) s += a[k] * a[k]
  return Math.sqrt(s)
}

export interface SemanticHit {
  file: string
  startLine: number
  endLine: number
  title: string
  score: number
  preview: string
}

/**
 * 向量语义检索：
 *  1) 对每个代码块算 TF-IDF 向量；
 *  2) 对 query 用同一份 IDF 算向量（未登录词给最大 IDF）；
 *  3) 余弦相似度排序取 top-K。
 */
export function searchSemantic(root: string, query: string, topK = 5, sub?: string): SemanticHit[] {
  const chunks = buildChunks(root, sub)
  if (!chunks.length) return []

  const chunkTokens = chunks.map((c) => tokenizeCode(`${c.file} ${c.title} ${c.text}`))
  const df: Vec = {}
  for (const toks of chunkTokens) {
    for (const t of new Set(toks)) df[t] = (df[t] ?? 0) + 1
  }
  const N = chunks.length
  const idf = (t: string) => Math.log((N + 1) / ((df[t] ?? 0) + 1)) + 1

  const chunkVecs = chunkTokens.map((toks) => {
    const counts = tf(toks)
    const v: Vec = {}
    for (const t in counts) v[t] = counts[t] * idf(t)
    return v
  })

  const qCounts = tf(tokenizeCode(query))
  const qVec: Vec = {}
  const maxIdf = Math.log((N + 1) / 1) + 1
  for (const t in qCounts) qVec[t] = qCounts[t] * (df[t] ? idf(t) : maxIdf)

  const qn = norm(qVec) || 1
  const scored = chunks.map((c, i) => {
    const cn = norm(chunkVecs[i]) || 1
    return { c, score: dot(qVec, chunkVecs[i]) / (qn * cn) }
  })
  scored.sort((a, b) => b.score - a.score)

  return scored
    .filter((s) => s.score > 0)
    .slice(0, topK)
    .map((s) => ({
      file: s.c.file,
      startLine: s.c.startLine,
      endLine: s.c.endLine,
      title: s.c.title,
      score: Number(s.score.toFixed(4)),
      preview: s.c.text.split('\n').slice(0, 4).join('\n'),
    }))
}

/** 把语义检索结果格式化成工具返回值 */
export function formatSemanticHits(hits: SemanticHit[], query: string): string {
  if (!hits.length) return `语义检索无命中（query="${query}"）`
  const parts = hits.map((h, i) => {
    const head = `#${i + 1}  ${h.file}:${h.startLine}-${h.endLine}  「${h.title}」  相似度 ${h.score}`
    return `${head}\n${h.preview.split('\n').map((l) => '    ' + l).join('\n')}`
  })
  return `语义检索 top-${hits.length}（query="${query}"，TF-IDF 向量余弦）：\n${parts.join('\n\n')}`
}

// ===================== 三、glob 文件匹配 =====================

/**
 * 把 glob 模式编译为正则。
 * 支持 `**`（跨目录）、`*`（单层）、`?`、`{a,b}`；不带 `/` 的模式视为按文件名匹配。
 */
export function globToRegExp(pattern: string): RegExp {
  let p = pattern.replace(/\\/g, '/').trim()
  if (p.startsWith('./')) p = p.slice(2)
  // 不带路径分隔符 → 匹配任意层级下的文件名
  if (!p.includes('/')) p = `**/${p}`

  let re = ''
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]
    if (ch === '*') {
      if (p[i + 1] === '*') {
        // `**/` 可以匹配零层目录
        if (p[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 2
        } else {
          re += '.*'
          i += 1
        }
      } else {
        re += '[^/]*'
      }
    } else if (ch === '?') {
      re += '[^/]'
    } else if (ch === '{') {
      const end = p.indexOf('}', i)
      if (end === -1) {
        re += '\\{'
      } else {
        const alts = p.slice(i + 1, end).split(',').map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
        re += `(?:${alts.join('|')})`
        i = end
      }
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      re += '\\' + ch
    } else {
      re += ch
    }
  }
  return new RegExp(`^${re}$`)
}

/** 按 glob 匹配工作区文件（返回相对路径，按名称排序） */
export function globFiles(root: string, pattern: string, sub?: string): string[] {
  const re = globToRegExp(pattern)
  const out: string[] = []
  const walk = (dir: string, base: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (SKIP_DIR.has(e.name)) continue
      const rel = base ? `${base}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(dir, e.name), rel)
      else if (re.test(rel)) out.push(rel)
    }
  }
  walk(sub ? path.join(root, sub) : root, sub ? sub.replace(/\/$/, '') : '')
  return out.sort()
}

// ===================== 四、grep（文本检索，替代 search_code） =====================

export interface GrepOptions {
  /** content=返回命中行；files_with_matches=只返回文件名；count=返回每文件命中数 */
  outputMode?: 'content' | 'files_with_matches' | 'count'
  /** 只在这些文件里搜（glob），如 "src/**\/*.js" */
  glob?: string
  /** 忽略大小写 */
  ignoreCase?: boolean
  /** 命中行前/后各显示 N 行（仅 outputMode=content） */
  contextLines?: number
  /** 最多返回多少条命中（content 模式）或多少个文件 */
  headLimit?: number
}

/**
 * 文本检索（grep 语义）。
 * 与 AST / 语义检索互补：它不解析语法，但对任意文本（含配置、日志、注释）都有效。
 */
export function grepWorkspace(root: string, pattern: string, opts: GrepOptions = {}): string {
  const mode = opts.outputMode ?? 'files_with_matches'
  const limit = opts.headLimit ?? 50
  const ctx = opts.contextLines ?? 0
  const re = new RegExp(pattern, opts.ignoreCase ? 'i' : '')

  const files = opts.glob ? globFiles(root, opts.glob) : walkCodeFiles(root).map((f) => f.rel)
  const contentHits: string[] = []
  const matchedFiles: string[] = []
  const counts: { file: string; count: number }[] = []

  for (const rel of files) {
    let text: string
    try {
      text = fs.readFileSync(path.join(root, rel), 'utf-8')
    } catch {
      continue
    }
    const lines = text.split('\n')
    let fileCount = 0
    const local: string[] = []
    lines.forEach((line, i) => {
      if (!re.test(line)) return
      fileCount++
      if (mode !== 'content') return
      if (contentHits.length >= limit) return
      const from = Math.max(0, i - ctx)
      const to = Math.min(lines.length - 1, i + ctx)
      for (let k = from; k <= to; k++) {
        const marker = k === i ? ':' : '-'
        local.push(`${rel}${marker}${k + 1}${marker} ${lines[k]}`)
      }
      if (local.length) local.push('--')
    })
    if (fileCount > 0) {
      matchedFiles.push(rel)
      counts.push({ file: rel, count: fileCount })
      if (mode === 'content') contentHits.push(...local)
    }
  }

  if (mode === 'count') {
    if (!counts.length) return `无命中（pattern="${pattern}"）`
    const total = counts.reduce((a, c) => a + c.count, 0)
    return `共 ${total} 处命中，分布在 ${counts.length} 个文件：\n` +
      counts.sort((a, b) => b.count - a.count).map((c) => `${c.count}\t${c.file}`).join('\n')
  }
  if (mode === 'files_with_matches') {
    if (!matchedFiles.length) return `无命中（pattern="${pattern}"）`
    const shown = matchedFiles.slice(0, limit)
    return `命中 ${matchedFiles.length} 个文件${matchedFiles.length > limit ? `（显示前 ${limit}）` : ''}：\n${shown.join('\n')}`
  }
  if (!contentHits.length) return `无命中（pattern="${pattern}"）`
  const truncated = contentHits.length >= limit ? `\n...[已达上限 ${limit} 条，可加 glob 缩小范围]` : ''
  return `命中内容：\n${contentHits.join('\n')}${truncated}`
}

