'use client'

import { useSyncExternalStore } from 'react'
import { useTheme } from 'next-themes'
import { Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'

const emptySubscribe = () => () => {}

/**
 * 深浅色切换（next-themes）。
 * 「是否已挂载」用 useSyncExternalStore 判定：SSR 返回 false、客户端返回 true，
 * 避免 setState-in-effect（React Compiler lint 会拦），也不会水合不一致。
 */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  const mounted = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  )

  if (!mounted) {
    return <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="切换主题" />
  }

  const isDark = resolvedTheme === 'dark'
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7"
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      title={isDark ? '切换到浅色' : '切换到深色'}
      aria-label="切换主题"
    >
      {isDark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
    </Button>
  )
}
