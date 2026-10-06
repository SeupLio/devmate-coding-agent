/**
 * 知识库检索（RAG）—— JD 第 4 条明确要求的「知识库检索」。
 *
 * 与 `search_semantic` 的区别（这是两种不同的检索，不该混为一谈）：
 *
 *   | | 检索对象 | 用途 |
 *   |---|---|---|
 *   | `search_semantic` | **当前工作区里的代码** | 「这个函数在哪实现」 |
 *   | `search_knowledge` | **预先入库的文档** | 「我们的提交规范是什么」「这个模块为什么这么设计」 |
 *
 * 实现选择：**离线 TF-IDF + 余弦相似度**，而不是接 embedding 服务。
 * 理由：零依赖、确定性、可离线复现、无额外成本；对「团队文档」这种小语料
 * （几十到几百个 chunk）召回质量足够。真要做大规模/跨语义检索时，
 * 替换点就在 `embed()` 一个函数上（接口已隔离）。
 *
 * 切块策略：按 Markdown 标题层级切，而不是定长滑窗 —— 文档的语义单元就是小节。
 */
import fs from 'node:fs'
import path from 'node:path'
import { tokenizeCode } from './search'

export interface KnowledgeChunk {
  id: string
  /** 相对路径 */
  file: string
  /** 所属标题路径，如 "架构 / 上下文管理" */
  heading: string
  startLine: number
  endLine: number
  text: string
}

export interface KnowledgeHit {
  chunk: KnowledgeChunk
  score: number
  /** 命中的关键词（便于解释「为什么这条被召回」） */
  matched: string[]
}

/** 知识库默认目录（项目根） */
export const KNOWLEDGE_DIR = 'knowledge'
const MAX_CHUNK_CHARS = 1800
const MIN_CHUNK_CHARS = 40

// ===================== 文档加载与切块 =====================

/** 递归收集知识库里的 .md / .txt / .mdx 文件 */
export function collectDocs(root: string, sub = ''): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = []
  const dir = path.join(root, sub)
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const rel = sub ? `${sub}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      out.push(...collectDocs(root, rel))
    } else if (/\.(md|mdx|txt)$/i.test(entry.name)) {
      try {
        out.push({ rel, text: fs.readFileSync(path.join(root, rel), 'utf-8') })
      } catch {
        /* 跳过读不了的文件 */
      }
    }
  }
  return out
}

/**
 * 按 Markdown 标题切块。超长小节再按段落二次切分；
 * 标题路径会拼成 heading（如「架构 / 上下文管理」），便于展示与加权。
 */
export function chunkMarkdown(file: string, text: string): KnowledgeChunk[] {
  const lines = text.split('\n')
  const chunks: KnowledgeChunk[] = []

  let headingStack: { level: number; title: string }[] = []
  let buf: string[] = []
  let startLine = 1

  const flush = (endLine: number) => {
    const body = buf.join('\n').trim()
    if (body.length >= MIN_CHUNK_CHARS) {
      const heading = headingStack.map((h) => h.title).join(' / ') || '(正文)'
      // 超长小节按段落二次切
      if (body.length > MAX_CHUNK_CHARS) {
        const paras = body.split(/\n\s*\n/)
        let cur = ''
        let curStart = startLine
        for (const p of paras) {
          if (cur && cur.length + p.length > MAX_CHUNK_CHARS) {
            chunks.push(mk(file, heading, curStart, endLine, cur.trim()))
            cur = p
            curStart = endLine
          } else {
            cur += (cur ? '\n\n' : '') + p
          }
        }
        if (cur.trim().length >= MIN_CHUNK_CHARS) chunks.push(mk(file, heading, curStart, endLine, cur.trim()))
      } else {
        chunks.push(mk(file, heading, startLine, endLine, body))
      }
    }
    buf = []
  }

  const mk = (f: string, heading: string, s: number, e: number, t: string): KnowledgeChunk => ({
    id: `${f}#${s}`,
    file: f,
    heading,
    startLine: s,
    endLine: e,
    text: t,
  })

  lines.forEach((line, i) => {
    const m = /^(#{1,6})\s+(.*)$/.exec(line)
    if (m) {
      flush(i) // 标题之前的内容归上一节
      const level = m[1].length
      headingStack = headingStack.filter((h) => h.level < level)
      headingStack.push({ level, title: m[2].trim() })
      startLine = i + 1
      // 标题本身也算内容（检索「提交规范」时标题是强信号）
      buf.push(line)
    } else {
      buf.push(line)
    }
  })
  flush(lines.length)
  return chunks
}

// ===================== 索引与检索 =====================

interface IndexedChunk extends KnowledgeChunk {
  tf: Map<string, number>
  norm: number
}

export interface KnowledgeIndex {
  chunks: IndexedChunk[]
  df: Map<string, number>
  total: number
  builtAt: number
  /** 索引了哪些文件（便于前端展示） */
  files: string[]
}

/** 建索引：TF-IDF 词表 + 每块向量 L2 范数（检索时直接用） */
export function buildKnowledgeIndex(root: string, dir = KNOWLEDGE_DIR): KnowledgeIndex {
  const docs = collectDocs(path.join(root, dir))
  const chunks: IndexedChunk[] = []
  for (const d of docs) {
    for (const c of chunkMarkdown(d.rel, d.text)) {
      // 标题路径一起参与词频：标题里的词是强信号
      const toks = tokenizeCode(`${c.heading}\n${c.text}`)
      const tf = new Map<string, number>()
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1)
      let sq = 0
      for (const v of tf.values()) sq += v * v
      chunks.push({ ...c, tf, norm: Math.sqrt(sq) || 1 })
    }
  }
  const df = new Map<string, number>()
  for (const c of chunks) {
    for (const t of c.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1)
  }
  return { chunks, df, total: chunks.length, builtAt: Date.now(), files: docs.map((d) => d.rel) }
}

/** 缓存：按目录 mtime 失效，避免每次检索都重建 */
let cache: { root: string; dir: string; sig: string; index: KnowledgeIndex } | null = null

function dirSignature(dir: string): string {
  if (!fs.existsSync(dir)) return 'missing'
  const parts: string[] = []
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.')) continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(md|mdx|txt)$/i.test(e.name)) parts.push(`${e.name}:${fs.statSync(p).mtimeMs}`)
    }
  }
  walk(dir)
  return parts.join('|')
}

export function getKnowledgeIndex(root: string, dir = KNOWLEDGE_DIR): KnowledgeIndex {
  const full = path.join(root, dir)
  const sig = dirSignature(full)
  if (cache && cache.root === root && cache.dir === dir && cache.sig === sig) return cache.index
  const index = buildKnowledgeIndex(root, dir)
  cache = { root, dir, sig, index }
  return index
}

/** 检索：TF-IDF 余弦相似度 + 标题命中加权 */
export function searchKnowledge(
  root: string,
  query: string,
  topK = 5,
  dir = KNOWLEDGE_DIR,
): KnowledgeHit[] {
  const index = getKnowledgeIndex(root, dir)
  if (!index.total) return []

  const qTokens = tokenizeCode(query)
  if (!qTokens.length) return []
  const qTf = new Map<string, number>()
  for (const t of qTokens) qTf.set(t, (qTf.get(t) ?? 0) + 1)
  const qNorm = Math.sqrt([...qTf.values()].reduce((a, v) => a + v * v, 0)) || 1

  const scored: KnowledgeHit[] = []
  for (const c of index.chunks) {
    let dot = 0
    const matched: string[] = []
    for (const [t, qv] of qTf) {
      const tf = c.tf.get(t)
      if (!tf) continue
      const idf = Math.log(1 + index.total / (1 + (index.df.get(t) ?? 0)))
      dot += qv * tf * idf * idf
      matched.push(t)
    }
    if (dot <= 0) continue
    let score = dot / (qNorm * c.norm)
    // 标题命中额外加权：文档标题往往就是答案的「锚」
    const headingLower = c.heading.toLowerCase()
    for (const t of qTf.keys()) if (t.length >= 2 && headingLower.includes(t)) score *= 1.25
    scored.push({ chunk: c, score, matched: matched.slice(0, 6) })
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, topK)
}

export function formatKnowledgeHits(hits: KnowledgeHit[], query: string, dir = KNOWLEDGE_DIR): string {
  if (!hits.length) {
    return `知识库（${dir}/）中没有找到与「${query}」相关的内容。可以换关键词，或用 search_semantic 找代码。`
  }
  const parts = hits.map(
    (h, i) =>
      `【${i + 1}】${h.chunk.file}:${h.chunk.startLine}（${h.chunk.heading}） 相似度 ${h.score.toFixed(3)}\n` +
      `命中词：${h.matched.join(', ')}\n${h.chunk.text.slice(0, 900)}`,
  )
  return `知识库检索「${query}」，命中 ${hits.length} 条：\n\n${parts.join('\n\n---\n\n')}`
}
