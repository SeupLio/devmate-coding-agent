/**
 * 可观测性接口。
 *
 *  GET /api/traces              → 最近运行的索引（耗时 / 成本 / 瓶颈 / 是否完成）
 *  GET /api/traces?summary=1    → 聚合统计（P50/P95、成本、工具失败率、最慢 span）
 *  GET /api/traces?id=<traceId> → 单次运行的完整 trace（可回放）
 */
import { NextRequest } from 'next/server'
import { listTraces, loadTrace, summarizeRecent } from '@/lib/agent/trace-store'

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams
  const id = p.get('id')
  if (id) {
    const rec = loadTrace(id)
    if (!rec) return Response.json({ error: 'trace 不存在' }, { status: 404 })
    return Response.json(rec)
  }
  if (p.get('summary')) {
    return Response.json(summarizeRecent(Number(p.get('limit')) || 100))
  }
  return Response.json({ traces: listTraces(Number(p.get('limit')) || 50) })
}
