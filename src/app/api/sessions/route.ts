import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { createWorkspace } from '@/lib/agent/workspace'

export async function GET() {
  const sessions = await db.session.findMany({
    orderBy: { updatedAt: 'desc' },
    include: { messages: { select: { id: true } } },
  })
  return NextResponse.json({ sessions })
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const title = (body.title as string)?.slice(0, 80) || '新任务'
  const session = await db.session.create({ data: { title } })
  createWorkspace(session.id)
  return NextResponse.json({ session })
}
