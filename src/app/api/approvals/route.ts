/**
 * 人在环审批接口。
 *
 *  GET  /api/approvals?sessionId=xxx  → 当前挂起的审批请求
 *  POST /api/approvals { id, decision } → 允许 / 拒绝
 *
 * 前端收到 SSE 的 `approval_required` 事件后渲染卡片，
 * 用户点击即回传到这里，挂起的 Agent 循环随即继续。
 */
import { NextRequest } from 'next/server'
import { getAuditLog, listPendingApprovals, resolveApproval } from '@/lib/agent/approvals'

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('sessionId') ?? undefined
  const audit = req.nextUrl.searchParams.get('audit')
  if (audit) {
    return Response.json({ audit: getAuditLog(Number(audit) || 200) })
  }
  return Response.json({ pending: listPendingApprovals(sessionId) })
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const id = String(body.id ?? '')
  const decision = body.decision === 'allow' ? 'allow' : body.decision === 'deny' ? 'deny' : ''
  if (!id || !decision) {
    return Response.json({ error: 'id 与 decision(allow|deny) 必填' }, { status: 400 })
  }
  const ok = resolveApproval(id, decision)
  if (!ok) {
    // 请求可能已超时（超时按拒绝处理），如实告知而不是假装成功
    return Response.json({ ok: false, reason: '该审批请求不存在或已超时（超时按拒绝处理）' }, { status: 404 })
  }
  return Response.json({ ok: true, id, decision })
}
