import { NextRequest, NextResponse } from 'next/server'
import fs from 'node:fs'
import path from 'node:path'
import { sessionDir, workspaceExists } from '@/lib/agent/workspace'

/**
 * 工作区文件接口：
 *   GET /api/workspace/{sessionId}                  → { tree }
 *   GET /api/workspace/{sessionId}?file=src/a.js    → { content }（文本预览）
 *   GET /api/workspace/{sessionId}?file=out/a.docx&download=1 → 原始二进制下载
 *
 * 生成的 .docx / .pptx 等二进制文件默认也走流式返回（便于下载）。
 */
const MAX_PREVIEW_BYTES = 200_000

/** 这些扩展名不作文本预览，直接按二进制返回 */
const BINARY_EXT = new Set([
  '.docx', '.doc', '.pptx', '.ppt', '.xlsx', '.xls', '.pdf', '.zip', '.gz',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.mp4',
])

const MIME: Record<string, string> = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

interface FileNode {
  name: string
  path: string
  type: 'dir' | 'file'
  size?: number
  children?: FileNode[]
}

function buildTree(dir: string, base = ''): FileNode[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const nodes: FileNode[] = []
  // 目录在前，同类按名称排序
  entries.sort(
    (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
  )
  for (const e of entries) {
    if (e.name === '.git') continue
    const rel = base ? `${base}/${e.name}` : e.name
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) {
      nodes.push({ name: e.name, path: rel, type: 'dir', children: buildTree(abs, rel) })
    } else {
      let size: number | undefined
      try {
        size = fs.statSync(abs).size
      } catch {
        /* ignore */
      }
      nodes.push({ name: e.name, path: rel, type: 'file', size })
    }
  }
  return nodes
}

/** 把相对路径安全地解析到沙箱内（禁止目录逃逸） */
function safeJoin(root: string, rel: string): string | null {
  const resolved = path.resolve(root, rel.replace(/^[/\\]+/, ''))
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null
  return resolved
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  if (!workspaceExists(id)) return NextResponse.json({ error: '工作区不存在' }, { status: 404 })
  const root = sessionDir(id)
  const url = new URL(req.url)
  const file = url.searchParams.get('file')

  if (!file) return NextResponse.json({ tree: buildTree(root) })

  const resolved = safeJoin(root, file)
  if (!resolved) return NextResponse.json({ error: '路径越界' }, { status: 400 })
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return NextResponse.json({ error: '文件不存在' }, { status: 404 })
  }

  const ext = path.extname(resolved).toLowerCase()
  const stat = fs.statSync(resolved)
  const wantsDownload = url.searchParams.get('download') === '1'

  if (wantsDownload || BINARY_EXT.has(ext)) {
    const buf = fs.readFileSync(resolved)
    const headers: Record<string, string> = {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': String(buf.length),
      'Cache-Control': 'no-store',
    }
    if (wantsDownload) {
      // RFC 5987：中文文件名用 filename* 传
      headers['Content-Disposition'] =
        `attachment; filename="${encodeURIComponent(path.basename(resolved))}"; ` +
        `filename*=UTF-8''${encodeURIComponent(path.basename(resolved))}`
    }
    return new Response(new Uint8Array(buf), { headers })
  }

  if (stat.size > MAX_PREVIEW_BYTES) {
    return NextResponse.json(
      { error: `文件过大，无法预览（${stat.size} 字节）`, size: stat.size },
      { status: 413 },
    )
  }
  return NextResponse.json({ path: file, content: fs.readFileSync(resolved, 'utf-8'), size: stat.size })
}
