'use client'

/**
 * 对话节点导航 —— 把一次会话里的「提问 / 回复」标成可跳转的节点。
 *
 * ## 解决什么
 *
 * Agent 一轮任务会产出几十条消息（思考块、工具卡片、审批卡片…），
 * 用户想回看「模型第二次回复我的时候说了什么」，只能一路往上滚。
 * 这里把**对话骨架**抽出来做成竖排导航，点一下就跳到那条消息。
 *
 * ## 节点的定义
 *
 * 只有 `user`（提问）和 `assistant`（回复）算节点 —— 工具卡片、思考块、
 * 审批卡片都是**过程**，不是对话骨架。这样导航条不会被几十条工具调用淹没。
 *
 * ## 当前节点高亮（scrollspy）
 *
 * 监听滚动容器的 scroll 事件，算出「哪个节点当前在视口顶部附近」，
 * 高亮它 —— 让用户随时知道自己滚到哪一轮了。
 */
import { useCallback, useEffect, useState } from 'react'
import { MessageSquare, Bot } from 'lucide-react'
import type { UIMessage } from './types'

export interface NavNode {
  id: string
  role: 'user' | 'assistant'
  /** 序号，从 1 开始（同角色内递增） */
  index: number
  label: string
}

/** 从消息流里抽出对话骨架节点 */
export function buildNavNodes(messages: UIMessage[]): NavNode[] {
  const nodes: NavNode[] = []
  let userIdx = 0
  let aiIdx = 0
  for (const m of messages) {
    if (m.kind === 'user') {
      userIdx++
      nodes.push({
        id: m.id,
        role: 'user',
        index: userIdx,
        label: (m.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 28) || '(空提问)',
      })
    } else if (m.kind === 'assistant') {
      aiIdx++
      nodes.push({
        id: m.id,
        role: 'assistant',
        index: aiIdx,
        label: (m.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 28) || '(回复)',
      })
    }
  }
  return nodes
}

/** 找到 Radix ScrollArea 真正的滚动容器 */
function findViewport(root: HTMLElement | null): HTMLElement | null {
  if (!root) return null
  return (root.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement | null) ?? null
}

export function ConversationNav({
  messages,
  containerRef,
}: {
  messages: UIMessage[]
  containerRef: React.RefObject<HTMLElement | null>
}) {
  const nodes = buildNavNodes(messages)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [open, setOpen] = useState(true)

  /** 跳到某个节点：算相对滚动容器的偏移，直接设 scrollTop（比 scrollIntoView 可控） */
  const jumpTo = useCallback((id: string) => {
    const root = containerRef.current
    const vp = findViewport(root)
    if (!vp) return
    const el = root?.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(id)}"]`)
    if (!el) return
    // 元素相对 viewport 内容顶部的偏移
    const offset = el.getBoundingClientRect().top - vp.getBoundingClientRect().top + vp.scrollTop
    // 留 8px 上边距，别让节点贴死顶部
    vp.scrollTo({ top: Math.max(0, offset - 8), behavior: 'smooth' })
    setActiveId(id)
  }, [containerRef])

  // scrollspy：滚动时算出当前最靠近顶部的节点
  useEffect(() => {
    const root = containerRef.current
    const vp = findViewport(root)
    if (!vp || !nodes.length) return

    let frame = 0
    const onScroll = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const vpTop = vp.getBoundingClientRect().top
        let current: string | null = null
        for (const n of nodes) {
          const el = root?.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(n.id)}"]`)
          if (!el) continue
          // 节点顶部进入视口上方 120px 内就算「当前」
          if (el.getBoundingClientRect().top - vpTop <= 120) current = n.id
          else break
        }
        setActiveId(current ?? nodes[0]?.id ?? null)
      })
    }

    vp.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => {
      vp.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [containerRef, nodes.length, nodes.map((n) => n.id).join(',')])

  if (!nodes.length) return null

  return (
    <div className="pointer-events-none absolute right-2 top-2 z-20 flex flex-col items-end gap-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className="pointer-events-auto flex items-center gap-1 rounded-full border bg-background/90 px-2 py-0.5 text-[10px] text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-muted"
        title="对话节点导航：点击每个节点可跳转到对应的提问/回复"
      >
        <MessageSquare className="h-3 w-3" />
        {nodes.length} 个节点
        <span className="opacity-60">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="pointer-events-auto max-h-[55vh] w-44 overflow-auto rounded-md border bg-background/95 p-1 shadow-md backdrop-blur">
          {nodes.map((n) => {
            const active = n.id === activeId
            return (
              <button
                key={n.id}
                onClick={() => jumpTo(n.id)}
                className={`flex w-full items-start gap-1.5 rounded px-1.5 py-1 text-left text-[10px] leading-tight transition-colors ${
                  active ? 'bg-emerald-50 text-emerald-800' : 'text-muted-foreground hover:bg-muted'
                }`}
                title={n.label}
              >
                {n.role === 'user' ? (
                  <MessageSquare className={`mt-px h-3 w-3 shrink-0 ${active ? 'text-emerald-600' : ''}`} />
                ) : (
                  <Bot className={`mt-px h-3 w-3 shrink-0 ${active ? 'text-emerald-600' : ''}`} />
                )}
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-mono opacity-60">
                    {n.role === 'user' ? '问' : '答'}
                    {n.index}
                  </span>{' '}
                  {n.label}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
