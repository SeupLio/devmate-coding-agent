'use client'

/**
 * 「粘底」滚动：新内容到达时自动跟到最底部，但**用户手动往上翻时不打断他**。
 *
 * ## 为什么原来的实现不好用
 *
 * 原来是 `bottomRef.current?.scrollIntoView({ behavior: 'smooth' })`，挂在 `[messages]` 上。
 * 问题在于流式输出时 messages **每秒会变几十次**，每次都是一次「平滑滚动」——
 * 上一次还没滚完就被下一次重置，结果就是**看起来卡在原地，看不到新内容**。
 *
 * ## 现在的做法
 *
 * 1. **用 instant 而不是 smooth**：流式场景下「立刻到最新」才是对的行为，
 *    平滑动画在持续更新时只会互相打架。
 * 2. **区分「用户翻上去了」和「程序在跟随」**：
 *    只有用户**主动**滚动（wheel / touch / key）才解除粘底；
 *    程序自己的滚动不算，否则会自己把自己解除掉。
 * 3. 解除粘底后显示「回到底部」按钮，而不是粗暴地把人拽回去。
 *
 * ⚠️ Radix 的 ScrollArea 把真正的滚动容器藏在
 * `[data-radix-scroll-area-viewport]` 里，直接对根节点设 scrollTop 是无效的。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

/** 距底部多少像素内算「还在底部」 */
const PIN_THRESHOLD_PX = 80

export interface StickToBottom<T extends HTMLElement> {
  /** 挂在 ScrollArea 的外层容器上 */
  containerRef: React.RefObject<T | null>
  /** 是否处于粘底状态 */
  pinned: boolean
  /** 是否需要显示「回到底部」按钮（已解除粘底且有新内容） */
  showJumpButton: boolean
  /** 手动滚到底部并恢复粘底 */
  scrollToBottom: () => void
}

export function useStickToBottom<T extends HTMLElement>(
  /** 触发自动跟随的依赖（通常是 messages 长度或最后一条内容） */
  dep: unknown,
): StickToBottom<T> {
  const containerRef = useRef<T | null>(null)
  const [pinned, setPinned] = useState(true)
  const [hasNewWhileUnpinned, setHasNew] = useState(false)

  /** 程序滚动时置位，避免把自己的滚动误判成「用户翻页」 */
  const selfScrolling = useRef(false)

  const getViewport = useCallback((): HTMLElement | null => {
    return containerRef.current?.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement | null
  }, [])

  const scrollToBottom = useCallback(() => {
    const vp = getViewport()
    if (!vp) return
    selfScrolling.current = true
    vp.scrollTop = vp.scrollHeight
    setPinned(true)
    setHasNew(false)
    // 下一帧再解除标记，确保 scroll 事件已经被忽略掉
    requestAnimationFrame(() => {
      selfScrolling.current = false
    })
  }, [getViewport])

  // 监听用户滚动：只有**用户主动**滚动才解除粘底
  useEffect(() => {
    const vp = getViewport()
    if (!vp) return

    const onScroll = () => {
      if (selfScrolling.current) return // 程序滚动，忽略
      const distance = vp.scrollHeight - vp.scrollTop - vp.clientHeight
      const atBottom = distance <= PIN_THRESHOLD_PX
      setPinned(atBottom)
      if (atBottom) setHasNew(false)
    }

    // 用户意图信号：滚轮 / 触摸 / 键盘。只有这些才算「主动翻页」
    const markUserIntent = () => {
      // 等一拍让 scroll 事件先到，再判断是否真的离开了底部
      requestAnimationFrame(() => {
        const distance = vp.scrollHeight - vp.scrollTop - vp.clientHeight
        if (distance > PIN_THRESHOLD_PX) setPinned(false)
      })
    }

    vp.addEventListener('scroll', onScroll, { passive: true })
    vp.addEventListener('wheel', markUserIntent, { passive: true })
    vp.addEventListener('touchmove', markUserIntent, { passive: true })
    vp.addEventListener('keydown', markUserIntent)
    return () => {
      vp.removeEventListener('scroll', onScroll)
      vp.removeEventListener('wheel', markUserIntent)
      vp.removeEventListener('touchmove', markUserIntent)
      vp.removeEventListener('keydown', markUserIntent)
    }
  }, [getViewport])

  // 内容变化：粘底时跟随；已解除时只记「有新内容」
  useEffect(() => {
    if (pinned) {
      const vp = getViewport()
      if (!vp) return
      selfScrolling.current = true
      vp.scrollTop = vp.scrollHeight
      requestAnimationFrame(() => {
        selfScrolling.current = false
      })
    } else {
      setHasNew(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dep])

  return {
    containerRef,
    pinned,
    showJumpButton: !pinned && hasNewWhileUnpinned,
    scrollToBottom,
  }
}
