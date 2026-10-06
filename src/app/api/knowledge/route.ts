/**
 * 知识库接口。
 *
 *  GET /api/knowledge?sessionId=x            → 列出已入库文档
 *  GET /api/knowledge?sessionId=x&q=提交规范  → 检索
 *
 * 知识库来自会话工作区的 `knowledge/` 目录（模板项目里已预置 3 篇示例文档）。
 */
import { NextRequest } from 'next/server'
import { sessionDir, workspaceExists, createWorkspace } from '@/lib/agent/workspace'
import { getKnowledgeIndex, searchKnowledge } from '@/lib/agent/knowledge'

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('sessionId') ?? ''
  const q = req.nextUrl.searchParams.get('q') ?? ''
  if (!sessionId) {
    return Response.json({ error: 'sessionId 必填' }, { status: 400 })
  }
  if (!workspaceExists(sessionId)) createWorkspace(sessionId)

  const root = sessionDir(sessionId)
  const index = getKnowledgeIndex(root)

  if (q) {
    const hits = searchKnowledge(root, q, Number(req.nextUrl.searchParams.get('topK')) || 5)
    return Response.json({
      query: q,
      total: index.total,
      hits: hits.map((h) => ({
        file: h.chunk.file,
        heading: h.chunk.heading,
        startLine: h.chunk.startLine,
        score: Number(h.score.toFixed(4)),
        matched: h.matched,
        excerpt: h.chunk.text.slice(0, 300),
      })),
    })
  }

  return Response.json({
    total: index.total,
    files: index.files,
    builtAt: index.builtAt,
  })
}
