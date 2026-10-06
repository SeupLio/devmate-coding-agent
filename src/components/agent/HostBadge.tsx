'use client'

/**
 * 宿主环境徽标 —— 对应 JD 第 5 条的跨端 WebView 场景。
 *
 * 显示当前跑在什么宿主里（浏览器 / Electron / UE / Maya），
 * 以及**哪些能力不可用**。把降级信息摆到明面上，而不是让用户
 * 在点了「复制」没反应之后自己猜。
 */
import { useEffect, useState } from 'react'
import { Monitor, Cpu } from 'lucide-react'
import { getHostBridge, describeCapabilities, type HostInfo } from '@/lib/host/bridge'

export function HostBadge() {
  const [info, setInfo] = useState<HostInfo | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    // 只在客户端探测（SSR 时没有 window）
    try {
      setInfo(getHostBridge().info)
    } catch {
      /* 探测失败就不显示徽标 */
    }
  }, [])

  if (!info) return null

  const caps = describeCapabilities(info)
  const missing = caps.filter((c) => !c.ok)
  const Icon = info.kind === 'browser' ? Monitor : Cpu

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted"
        title="当前宿主环境与可用能力"
      >
        <Icon className="h-3 w-3" />
        {info.label}
        {missing.length > 0 && (
          <span className="rounded bg-amber-100 px-1 text-[9px] text-amber-700">
            {missing.length} 项降级
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-1 w-56 rounded-md border bg-popover p-2 text-[10px] shadow-md">
          <p className="mb-1 font-medium">
            {info.label}
            {info.version ? ` v${info.version}` : ''}
          </p>
          <ul className="space-y-0.5">
            {caps.map((c) => (
              <li key={c.name} className="flex items-center gap-1.5">
                <span className={c.ok ? 'text-emerald-600' : 'text-amber-600'}>{c.ok ? '✓' : '✗'}</span>
                <span className={c.ok ? '' : 'text-muted-foreground'}>{c.name}</span>
                {!c.ok && <span className="text-[9px] text-muted-foreground">（已降级）</span>}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 border-t pt-1.5 text-[9px] leading-relaxed text-muted-foreground">
            能力不可用时走降级路径并明确提示，不会静默失败。
          </p>
        </div>
      )}
    </div>
  )
}
