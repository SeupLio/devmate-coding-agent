'use client'

import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react'
import type { HealthInfo } from './types'

/**
 * 头部 LLM 状态胶囊：进入页面即回答「我现在连的是什么模型、服务正常吗」。
 * 未配置 / 数据库异常时给出红色状态 + 引导文案，而不是让用户发第一条消息才撞 500。
 */
export function HealthPill({ health }: { health: HealthInfo | null }) {
  if (!health) {
    return (
      <span className="flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        探测服务中
      </span>
    )
  }

  const configured = health.llm.configured
  const dbOk = health.db

  return (
    <span
      className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
        configured && dbOk
          ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300'
          : 'border-red-200 bg-red-50 text-red-600 dark:border-red-800 dark:bg-red-950/60 dark:text-red-400'
      }`}
      title={
        configured
          ? `provider: ${health.llm.provider} · model: ${health.llm.model}${dbOk ? '' : ' · ⚠ 数据库异常'}`
          : 'LLM 未配置：请设置环境变量后重启服务'
      }
    >
      {configured && dbOk ? (
        <CheckCircle2 className="h-3 w-3" />
      ) : (
        <AlertTriangle className="h-3 w-3" />
      )}
      {configured ? `${health.llm.model}` : 'LLM 未配置'}
      {health.mcp.servers > 0 && (
        <span className="hidden text-muted-foreground sm:inline">· MCP×{health.mcp.servers}</span>
      )}
    </span>
  )
}

/** 未配置 LLM 时的置顶引导横幅 */
export function HealthBanner({ health }: { health: HealthInfo | null }) {
  if (!health || health.llm.configured) return null
  return (
    <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="space-y-1">
        <p className="font-medium">LLM 凭证未配置，Agent 暂时无法工作</p>
        <p className="leading-relaxed text-red-600/80 dark:text-red-300/80">
          复制 <code className="rounded bg-red-100 px-1 font-mono text-[11px] dark:bg-red-900/50">.env.example</code> 为{' '}
          <code className="rounded bg-red-100 px-1 font-mono text-[11px] dark:bg-red-900/50">.env</code>
          ，填入 <code className="rounded bg-red-100 px-1 font-mono text-[11px] dark:bg-red-900/50">OPENAI_API_KEY</code>
          （支持 DeepSeek / GLM / OpenAI 等任意兼容接口）后重启服务。
        </p>
      </div>
    </div>
  )
}
