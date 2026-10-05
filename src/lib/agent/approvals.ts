/**
 * 人在环（HITL）审批。
 *
 * 当权限判定为 `ask` 时，Agent **暂停**执行，把请求挂起等人工决定。
 * 前端收到 `approval_required` 事件后弹卡片，用户点「允许 / 拒绝」，
 * 通过 `POST /api/approvals` 回传，这里 resolve 掉挂起的 Promise，循环继续。
 *
 * 关键设计（安全优先）：
 *  - **超时默认拒绝**，不是默认放行 —— 没人看着的时候不能自己往下走
 *  - 决策结果进入**审计日志**（谁、何时、放行了什么）
 *  - 进程重启后挂起请求自然失效（不做持久化，避免"幽灵授权"）
 */
import { randomUUID } from 'node:crypto'

export interface ApprovalRequest {
  id: string
  sessionId: string
  tool: string
  args: Record<string, unknown>
  risk: string
  reason: string
  createdAt: number
}

export interface AuditRecord {
  at: number
  sessionId: string
  tool: string
  risk: string
  /** 权限判定的动作 */
  action: 'allow' | 'deny' | 'ask'
  /** 最终结果（ask 才有 resolution） */
  resolution?: 'allow' | 'deny' | 'timeout'
  reason: string
  /** 被作用的对象（路径 / 命令）摘要 */
  subject: string
}

interface Pending {
  req: ApprovalRequest
  resolve: (d: 'allow' | 'deny' | 'timeout') => void
  timer: NodeJS.Timeout
}

const pending = new Map<string, Pending>()

/** 审计日志（进程内环形缓冲，同时可选落盘） */
const AUDIT_MAX = 2000
const auditLog: AuditRecord[] = []

export function recordAudit(r: AuditRecord): void {
  auditLog.push(r)
  if (auditLog.length > AUDIT_MAX) auditLog.shift()
}

export function getAuditLog(limit = 200): AuditRecord[] {
  return auditLog.slice(-limit)
}

export function listPendingApprovals(sessionId?: string): ApprovalRequest[] {
  const all = [...pending.values()].map((p) => p.req)
  return sessionId ? all.filter((r) => r.sessionId === sessionId) : all
}

/**
 * 挂起等待人工决定。
 * @param timeoutMs 超时时间；**超时按拒绝处理**（fail-safe）
 */
export function requestApproval(
  req: Omit<ApprovalRequest, 'id' | 'createdAt'>,
  timeoutMs = 120_000,
): Promise<'allow' | 'deny' | 'timeout'> {
  const full: ApprovalRequest = { ...req, id: randomUUID(), createdAt: Date.now() }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(full.id)
      resolve('timeout')
    }, timeoutMs)
    pending.set(full.id, { req: full, resolve, timer })
  })
}

/** 前端回传决定；返回是否命中了一个挂起请求 */
export function resolveApproval(id: string, decision: 'allow' | 'deny'): boolean {
  const p = pending.get(id)
  if (!p) return false
  clearTimeout(p.timer)
  pending.delete(id)
  p.resolve(decision)
  return true
}

/** 测试 / 关闭会话时清空（全部按拒绝处理） */
export function clearPendingApprovals(sessionId?: string): number {
  let n = 0
  for (const [id, p] of pending) {
    if (sessionId && p.req.sessionId !== sessionId) continue
    clearTimeout(p.timer)
    pending.delete(id)
    p.resolve('deny')
    n++
  }
  return n
}
