/**
 * 人在环审批接口。
 *
 *  GET  /api/approvals?sessionId=xxx  → 当前挂起的审批请求
 *  GET  /api/approvals?audit=200      → 审计日志
 *  POST /api/approvals { id, decision, remember? } → 允许 / 拒绝（可选「以后同类都这样」）
 *
 * 前端收到 SSE 的 `approval_required` 事件后渲染卡片，
 * 用户点击即回传到这里，挂起的 Agent 循环随即继续。
 *
 * `remember: true`：把「这个工具」记进**会话级规则**，后续同类操作不再询问。
 * ⚠️ 安全性质：记住的 allow 走权限判定第 4 步，而破坏性命令（rm -rf 等）拦截在第 3 步、
 * 敏感文件在第 1 步 —— 所以「记住 run_command」不会让危险命令静默执行。
 */
import { NextRequest } from 'next/server'
import { getAuditLog, listPendingApprovals, resolveApproval } from '@/lib/agent/approvals'
import { addSessionRule } from '@/lib/agent/permissions'

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
  const remember = Boolean(body.remember)
  if (!id || !decision) {
    return Response.json({ error: 'id 与 decision(allow|deny) 必填' }, { status: 400 })
  }

  // remember 需要在 resolve 前拿到请求详情（resolve 后 pending 就删了）
  let remembered: { sessionId: string; tool: string } | null = null
  if (remember) {
    const req0 = listPendingApprovals().find((r) => r.id === id)
    if (req0) remembered = { sessionId: req0.sessionId, tool: req0.tool }
  }

  const ok = resolveApproval(id, decision)
  if (!ok) {
    // 请求可能已超时（超时按拒绝处理），如实告知而不是假装成功
    return Response.json({ ok: false, reason: '该审批请求不存在或已超时（超时按拒绝处理）' }, { status: 404 })
  }

  if (remembered) {
    addSessionRule(remembered.sessionId, {
      tool: remembered.tool,
      action: decision, // allow → 记住放行；deny → 记住拒绝
    })
  }

  return Response.json({ ok: true, id, decision, rememberedTool: remembered?.tool ?? null })
}
