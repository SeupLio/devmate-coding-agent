import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { deleteWorkspace } from '@/lib/agent/workspace'

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const session = await db.session.findUnique({
    where: { id },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  })
  if (!session) return NextResponse.json({ error: '会话不存在' }, { status: 404 })
  return NextResponse.json({ session })
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  // 先清磁盘工作区再删记录：即使会话记录已不存在，也不残留孤儿目录
  deleteWorkspace(id)
  await db.session.delete({ where: { id } }).catch(() => null)
  return NextResponse.json({ ok: true })
}
