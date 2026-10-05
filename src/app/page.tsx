'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { ToolCallCard } from '@/components/agent/ToolCallCard'
import { WorkspacePanel } from '@/components/agent/WorkspacePanel'
import { EvalPanel } from '@/components/agent/EvalPanel'
import type {
  AgentStats,
  PermissionModeUI,
  SessionInfo,
  SSEEvent,
  TodoItemUI,
  UIMessage,
} from '@/components/agent/types'
import {
  Activity,
  Bot,
  Brain,
  GitBranch,
  ListChecks,
  Plus,
  Send,
  ShieldAlert,
  Sparkles,
  Square,
  User,
  Zap,
} from 'lucide-react'

const QUICK_TASKS = [
  '修复 mathutils.js 中的 bug，使全部测试通过并提交',
  '新增 clamp(x, lo, hi) 函数并补充测试用例',
  '将 fibonacci 重构为迭代实现，修正 n=0 边界',
]

export default function Home() {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<UIMessage[]>([])
  const [task, setTask] = useState('')
  const [running, setRunning] = useState(false)
  const [stats, setStats] = useState<AgentStats | null>(null)
  const [todos, setTodos] = useState<TodoItemUI[]>([])
  const [showReasoning, setShowReasoning] = useState(true)
  const [planMode, setPlanMode] = useState<'auto' | 'on' | 'off'>('auto')
  const [deepThinking, setDeepThinking] = useState(true)
  /** 权限模式（P0）：default 每次写/执行都问；plan 只读；acceptEdits 自动接受编辑 */
  const [permissionMode, setPermissionMode] = useState<PermissionModeUI>('default')
  /** 当前是否处于一段连续的「思考」中（用于把同一次思考合并成一个块） */
  const reasoningOpenRef = useRef(false)
  const [fileRefreshKey, setFileRefreshKey] = useState(0)

  /**
   * 回传人工审批决定。
   * 失败（多半是已超时）时**如实标记为 expired**，不假装成功 ——
   * 因为后端超时是按「拒绝」处理的，UI 必须和后端一致。
   */
  const decideApproval = async (msgId: string, approvalId: string, decision: 'allow' | 'deny') => {
    setMessages((ms) =>
      ms.map((m) =>
        m.id === msgId && m.approval
          ? { ...m, approval: { ...m.approval, status: decision === 'allow' ? 'allowed' : 'denied' } }
          : m,
      ),
    )
    try {
      const r = await fetch('/api/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: approvalId, decision }),
      })
      if (!r.ok) {
        setMessages((ms) =>
          ms.map((m) =>
            m.id === msgId && m.approval ? { ...m, approval: { ...m.approval, status: 'expired' } } : m,
          ),
        )
      }
    } catch {
      /* 网络异常：保持已标记的本地状态 */
    }
  }

  const abortRef = useRef<AbortController | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  const loadSessions = useCallback(async () => {
    const res = await fetch('/api/sessions')
    const data = await res.json()
    setSessions(data.sessions ?? [])
  }, [])

  useEffect(() => {
    loadSessions()
  }, [loadSessions])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const openSession = async (id: string) => {
    const res = await fetch(`/api/sessions/${id}`)
    if (!res.ok) return
    const { session } = await res.json()
    setActiveId(id)
    setStats(null)
    // 将持久化消息还原为 UI 消息
    const ui: UIMessage[] = (session.messages ?? []).map((m: Record<string, unknown>, i: number) => {
      if (m.role === 'user') return { id: `h${i}`, kind: 'user', text: String(m.content) }
      if (m.role === 'assistant') return { id: `h${i}`, kind: 'assistant', text: String(m.content) }
      if (m.role === 'plan')
        return { id: `h${i}`, kind: 'plan', steps: JSON.parse(String(m.content || '[]')) as string[] }
      if (m.role === 'tool_call')
        return {
          id: `h${i}`,
          kind: 'tool',
          tool: { id: `h${i}`, name: String(m.content), args: JSON.parse(String(m.meta ?? '{}')), status: 'done', ok: true },
        }
      return { id: `h${i}`, kind: 'assistant', text: '' }
    })
    setMessages(ui)
    setFileRefreshKey((k) => k + 1)
  }

  const newSession = async () => {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '新任务' }),
    })
    const { session } = await res.json()
    await loadSessions()
    setActiveId(session.id)
    setMessages([])
    setStats(null)
    setFileRefreshKey((k) => k + 1)
  }

  const stop = () => {
    abortRef.current?.abort()
    setRunning(false)
  }

  const runTask = async () => {
    const text = task.trim()
    if (!text || running) return
    let sid = activeId
    if (!sid) {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: text.slice(0, 40) }),
      })
      const { session } = await res.json()
      sid = session.id
      setActiveId(sid)
      await loadSessions()
    }
    setTask('')
    setRunning(true)
    setTodos([])
    reasoningOpenRef.current = false
    setMessages((ms) => [...ms, { id: `u${Date.now()}`, kind: 'user', text }])

    const controller = new AbortController()
    abortRef.current = controller
    try {
      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: sid,
          task: text,
          plan: planMode === 'on' ? true : planMode === 'off' ? false : 'auto',
          thinking: deepThinking,
          permissionMode,
        }),
        signal: controller.signal,
      })
      const reader = res.body?.getReader()
      if (!reader) throw new Error('无法建立流式连接')
      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const parts = buf.split('\n\n')
        buf = parts.pop() ?? ''
        for (const part of parts) {
          const line = part.trim()
          if (!line.startsWith('data:')) continue
          let ev: SSEEvent
          try {
            ev = JSON.parse(line.slice(5).trim()) as SSEEvent
          } catch {
            continue
          }
          applyEvent(ev)
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setMessages((ms) => [
          ...ms,
          { id: `e${Date.now()}`, kind: 'error', text: e instanceof Error ? e.message : String(e) },
        ])
      }
    } finally {
      setRunning(false)
      abortRef.current = null
      setFileRefreshKey((k) => k + 1)
      loadSessions()
    }

    function applyEvent(ev: SSEEvent) {
      const now = Date.now()
      switch (ev.type) {
        case 'reasoning':
          // 同一次思考的增量合并到一个块里；遇到正文/工具调用就断开
          setMessages((ms) => {
            const last = ms[ms.length - 1]
            if (reasoningOpenRef.current && last?.kind === 'reasoning') {
              return [...ms.slice(0, -1), { ...last, text: (last.text ?? '') + ev.text }]
            }
            reasoningOpenRef.current = true
            return [...ms, { id: `r${now}`, kind: 'reasoning', text: ev.text }]
          })
          break
        case 'plan':
          reasoningOpenRef.current = false
          setMessages((ms) => [...ms, { id: `p${now}`, kind: 'plan', steps: ev.steps }])
          break
        case 'token':
          reasoningOpenRef.current = false
          setMessages((ms) => {
            const last = ms[ms.length - 1]
            if (last?.kind === 'assistant') {
              return [...ms.slice(0, -1), { ...last, text: (last.text ?? '') + ev.text }]
            }
            return [...ms, { id: `a${now}`, kind: 'assistant', text: ev.text }]
          })
          break
        case 'tool_call':
          reasoningOpenRef.current = false
          setMessages((ms) => [
            ...ms,
            { id: `t${now}`, kind: 'tool', tool: { id: ev.id, name: ev.name, args: ev.args, status: 'running' } },
          ])
          break
        case 'tool_result':
          setMessages((ms) =>
            ms.map((m) =>
              m.kind === 'tool' && m.tool?.id === ev.id
                ? { ...m, tool: { ...m.tool, result: ev.result, ok: ev.ok, status: 'done' } }
                : m,
            ),
          )
          setFileRefreshKey((k) => k + 1)
          break
        case 'todos':
          setTodos(ev.todos)
          break
        case 'context':
          setMessages((ms) => [
            ...ms,
            {
              id: `c${now}`,
              kind: 'context',
              text: `上下文压缩：${ev.tokensBefore} → ${ev.tokensAfter} tokens（压缩 ${ev.compressedCount} 条历史工具结果）`,
            },
          ])
          break
        case 'permission':
          // 只提示被拒绝的（allow 每次都推会太吵）
          if (ev.action === 'deny') {
            setMessages((ms) => [
              ...ms,
              { id: `pd${now}`, kind: 'permission_denied', text: `${ev.tool}（${ev.risk}）：${ev.reason}` },
            ])
          }
          break
        case 'approval_required':
          setMessages((ms) => [
            ...ms,
            {
              id: `ap${now}`,
              kind: 'approval',
              approval: {
                id: ev.id,
                tool: ev.tool,
                args: ev.args,
                risk: ev.risk,
                reason: ev.reason,
                status: 'pending',
              },
            },
          ])
          break
        case 'trace':
          setMessages((ms) => [
            ...ms,
            {
              id: `tr${now}`,
              kind: 'trace',
              trace: {
                traceId: ev.traceId,
                durationMs: ev.durationMs,
                costCny: ev.costCny,
                totalTokens: ev.usage.totalTokens,
                usageSource: ev.usage.source,
                timeByKind: ev.timeByKind,
              },
            },
          ])
          break
        case 'final':
          setStats(ev.stats)
          setMessages((ms) => {
            const last = ms[ms.length - 1]
            // token 已流式输出过 → 用最终总结替换草稿，避免重复
            if (last?.kind === 'assistant') {
              return [...ms.slice(0, -1), { ...last, text: ev.summary || last.text }]
            }
            return [...ms, { id: `f${now}`, kind: 'assistant', text: ev.summary }]
          })
          break
        case 'error':
          setMessages((ms) => [...ms, { id: `x${now}`, kind: 'error', text: ev.message }])
          break
      }
    }
  }

  return (
    <div className="flex h-screen min-h-0 flex-col bg-background">
      {/* Header */}
      <header className="flex shrink-0 items-center gap-3 border-b px-4 py-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-600 text-white">
          <Bot className="h-4.5 w-4.5" />
        </div>
        <div>
          <h1 className="text-sm font-bold leading-tight">DevMate Coding Agent</h1>
          <p className="text-[10px] text-muted-foreground">
            Next.js 16 · React · TypeScript · Tool Calling · SSE 流式
          </p>
        </div>
        <Badge variant="outline" className="ml-2 hidden gap-1 border-emerald-200 text-emerald-700 sm:flex">
          <GitBranch className="h-3 w-3" /> 沙箱 Git / 文件 / 终端 / 测试
        </Badge>
        <div className="ml-auto flex items-center gap-2">
          {stats && (
            <span className="hidden font-mono text-[10px] text-muted-foreground md:inline">
              {stats.steps} 步 · {stats.toolCalls} 次工具调用 · {(stats.durationMs / 1000).toFixed(1)}s
            </span>
          )}
          <Button size="sm" variant="outline" onClick={newSession}>
            <Plus className="h-3.5 w-3.5" /> 新任务
          </Button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-12 gap-0">
        {/* 左：会话列表 */}
        <aside className="col-span-2 hidden min-h-0 flex-col border-r md:flex">
          <ScrollArea className="min-h-0 flex-1 p-2">
            {sessions.length === 0 && (
              <p className="px-2 py-4 text-center text-xs text-muted-foreground">暂无会话</p>
            )}
            <ul className="space-y-1">
              {sessions.map((s) => (
                <li key={s.id}>
                  <button
                    onClick={() => openSession(s.id)}
                    className={`w-full truncate rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted ${
                      activeId === s.id ? 'bg-muted font-medium' : 'text-muted-foreground'
                    }`}
                  >
                    {s.title}
                  </button>
                </li>
              ))}
            </ul>
          </ScrollArea>
        </aside>

        {/* 中：对话 */}
        <main className="col-span-12 flex min-h-0 flex-col md:col-span-7">
          <ScrollArea className="min-h-0 flex-1 p-4">
            {todos.length > 0 && <TodoPanel todos={todos} />}
            {messages.length === 0 && <EmptyState onPick={(t) => setTask(t)} />}
            <div className="space-y-3">
              {messages
                .filter((m) => showReasoning || m.kind !== 'reasoning')
                .map((m) => (
                  <MessageRow key={m.id} message={m} onDecide={decideApproval} />
                ))}
              {running && !messages.some((m) => m.kind === 'tool' && m.tool?.status === 'running') && (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Sparkles className="h-3.5 w-3.5 animate-pulse text-emerald-600" /> Agent 思考中…
                </p>
              )}
              <div ref={bottomRef} />
            </div>
          </ScrollArea>
          <Separator />
          <div className="shrink-0 space-y-2 p-3">
            <Textarea
              value={task}
              onChange={(e) => setTask(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runTask()
              }}
              placeholder="描述任务，如：修复 mathutils.js 的 bug 并提交（⌘+Enter 发送）"
              rows={2}
              disabled={running}
            />
            <div className="flex flex-wrap items-center gap-2">
              {/* P0：权限模式。写/执行类操作是否需要人工确认，由它决定 */}
              <div
                className="flex items-center overflow-hidden rounded-full border"
                title="权限模式：默认=写/执行都要确认；自动改=自动接受文件编辑；只读=只出方案；全放行=不拦截（慎用）"
              >
                {(
                  [
                    ['default', '默认'],
                    ['acceptEdits', '自动改'],
                    ['plan', '只读'],
                    ['bypassPermissions', '全放行'],
                  ] as [PermissionModeUI, string][]
                ).map(([m, label]) => (
                  <button
                    key={m}
                    onClick={() => setPermissionMode(m)}
                    className={`px-2 py-0.5 text-[10px] transition-colors ${
                      permissionMode === m
                        ? m === 'bypassPermissions'
                          ? 'bg-red-500 text-white'
                          : 'bg-sky-500 text-white'
                        : 'text-muted-foreground hover:bg-muted'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button
                onClick={() => setDeepThinking((v) => !v)}
                className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] transition-colors ${
                  deepThinking
                    ? 'border-amber-300 bg-amber-50 text-amber-700'
                    : 'border-muted text-muted-foreground'
                }`}
                title="关闭后请求带 enable_thinking=false，响应约快 2×；复杂任务准确率可能下降"
              >
                <Zap className="h-3 w-3" />
                {deepThinking ? '深度思考' : '快速模式'}
              </button>
              <button
                onClick={() => setShowReasoning((v) => !v)}
                className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] transition-colors ${
                  showReasoning
                    ? 'border-violet-300 bg-violet-50 text-violet-700'
                    : 'border-muted text-muted-foreground'
                }`}
                title="是否展示模型的思考过程"
              >
                <Brain className="h-3 w-3" />
                {showReasoning ? '显示思考' : '隐藏思考'}
              </button>
              <span className="text-[10px] text-muted-foreground">任务规划</span>
              <div className="flex overflow-hidden rounded-full border">
                {(
                  [
                    ['auto', '自动'],
                    ['on', '开'],
                    ['off', '关'],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    onClick={() => setPlanMode(k)}
                    className={`px-2 py-0.5 text-[10px] ${
                      planMode === k ? 'bg-emerald-600 text-white' : 'text-muted-foreground'
                    }`}
                    title={k === 'auto' ? '短任务自动跳过规划（更快）' : k === 'on' ? '总是先规划' : '从不规划'}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between">
              <p className="text-[10px] text-muted-foreground">
                Agent 将在独立沙箱内读写文件、执行命令、跑测试并提交 Git
              </p>
              {running ? (
                <Button size="sm" variant="destructive" onClick={stop}>
                  <Square className="h-3.5 w-3.5" /> 停止
                </Button>
              ) : (
                <Button size="sm" onClick={runTask} disabled={!task.trim()}>
                  <Send className="h-3.5 w-3.5" /> 执行
                </Button>
              )}
            </div>
          </div>
        </main>

        {/* 右：工作区 / 评测 */}
        <aside className="col-span-12 min-h-0 border-l md:col-span-3">
          <Tabs defaultValue="files" className="flex h-full min-h-0 flex-col">
            <TabsList className="mx-3 mt-2 grid w-auto grid-cols-2 shrink-0">
              <TabsTrigger value="files" className="text-xs">工作区</TabsTrigger>
              <TabsTrigger value="eval" className="text-xs">评测</TabsTrigger>
            </TabsList>
            <TabsContent value="files" className="min-h-0 flex-1 mt-0">
              <WorkspacePanel sessionId={activeId} refreshKey={fileRefreshKey} />
            </TabsContent>
            <TabsContent value="eval" className="min-h-0 flex-1 mt-0 overflow-auto">
              <EvalPanel />
            </TabsContent>
          </Tabs>
        </aside>
      </div>
    </div>
  )
}

function EmptyState({ onPick }: { onPick: (t: string) => void }) {
  return (
    <div className="flex flex-col items-center gap-4 py-12 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-600/10">
        <Bot className="h-6 w-6 text-emerald-600" />
      </div>
      <div>
        <h2 className="text-base font-bold">给 Agent 一个编码任务</h2>
        <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
          DevMate 会先规划，再通过工具调用在沙箱中读代码、改代码、跑测试、提交 Git，
          全程流式可视化。
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {QUICK_TASKS.map((t) => (
          <button
            key={t}
            onClick={() => onPick(t)}
            className="rounded-full border px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-emerald-300 hover:text-emerald-700"
          >
            {t}
          </button>
        ))}
      </div>
    </div>
  )
}

/** 任务清单（对标 Claude Code 的 TodoWrite 展示） */
function TodoPanel({ todos }: { todos: TodoItemUI[] }) {
  const done = todos.filter((t) => t.status === 'completed').length
  return (
    <Card className="mb-3 border-sky-200 bg-sky-50/50 shadow-none">
      <CardHeader className="flex flex-row items-center gap-2 py-2">
        <ListChecks className="h-4 w-4 text-sky-600" />
        <CardTitle className="text-xs">任务清单</CardTitle>
        <span className="ml-auto text-[10px] text-muted-foreground">
          {done}/{todos.length}
        </span>
      </CardHeader>
      <CardContent className="pt-0">
        <ul className="space-y-0.5 text-xs">
          {todos.map((t, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className="mt-[1px] w-3 shrink-0 text-center">
                {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▶' : '○'}
              </span>
              <span
                className={
                  t.status === 'completed'
                    ? 'text-muted-foreground line-through'
                    : t.status === 'in_progress'
                      ? 'font-medium text-sky-700'
                      : 'text-muted-foreground'
                }
              >
                {t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

function MessageRow({
  message,
  onDecide,
}: {
  message: UIMessage
  onDecide?: (msgId: string, approvalId: string, decision: 'allow' | 'deny') => void
}) {
  if (message.kind === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-emerald-600 px-3 py-2 text-xs text-white">
          <p className="whitespace-pre-wrap break-words">{message.text}</p>
        </div>
      </div>
    )
  }
  if (message.kind === 'assistant') {
    return (
      <div className="flex items-start gap-2">
        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted">
          <Bot className="h-3.5 w-3.5 text-emerald-600" />
        </div>
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg bg-muted px-3 py-2 text-xs leading-relaxed">
          {message.text}
        </div>
      </div>
    )
  }
  if (message.kind === 'reasoning') {
    return (
      <details className="rounded-md border border-dashed bg-muted/30 px-3 py-1.5">
        <summary className="flex cursor-pointer select-none items-center gap-1.5 text-[11px] text-muted-foreground">
          <Brain className="h-3.5 w-3.5 text-violet-500" />
          思考过程
          <span className="text-[10px] opacity-60">（点击展开/收起）</span>
        </summary>
        <div className="mt-1.5 max-h-72 overflow-auto whitespace-pre-wrap break-words border-t pt-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {message.text}
        </div>
      </details>
    )
  }
  if (message.kind === 'tool' && message.tool) {
    return <ToolCallCard tool={message.tool} />
  }
  // ===== P0：人在环审批卡片 =====
  if (message.kind === 'approval' && message.approval) {
    const a = message.approval
    const tone =
      a.risk === 'destructive'
        ? 'border-red-300 bg-red-50/60'
        : 'border-amber-300 bg-amber-50/60'
    return (
      <Card className={`shadow-none ${tone}`}>
        <CardHeader className="flex flex-row items-center gap-2 py-2">
          <ShieldAlert
            className={`h-4 w-4 ${a.risk === 'destructive' ? 'text-red-600' : 'text-amber-600'}`}
          />
          <CardTitle className="text-xs">需要你确认（{a.risk}）</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 pt-0">
          <p className="text-xs text-muted-foreground">{a.reason}</p>
          <pre className="max-h-32 overflow-auto rounded bg-background/70 p-2 font-mono text-[10px] leading-relaxed">
            {a.tool}
            {'\n'}
            {JSON.stringify(a.args, null, 2)}
          </pre>
          {a.status === 'pending' ? (
            <div className="flex gap-2">
              <Button size="sm" className="h-7 text-[11px]" onClick={() => onDecide?.(message.id, a.id, 'allow')}>
                允许
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[11px]"
                onClick={() => onDecide?.(message.id, a.id, 'deny')}
              >
                拒绝
              </Button>
              <span className="self-center text-[10px] text-muted-foreground">
                超时未处理将按**拒绝**处理
              </span>
            </div>
          ) : (
            <p className="text-[11px] font-medium">
              {a.status === 'allowed' ? '✓ 已允许' : a.status === 'denied' ? '✗ 已拒绝' : '⚠ 已超时（按拒绝处理）'}
            </p>
          )}
        </CardContent>
      </Card>
    )
  }
  if (message.kind === 'permission_denied') {
    return (
      <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50/50 px-3 py-2">
        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600" />
        <p className="text-[11px] text-red-700">权限拦截 —— {message.text}</p>
      </div>
    )
  }
  // ===== P0：可观测性摘要 =====
  if (message.kind === 'trace' && message.trace) {
    const t = message.trace
    const kinds = Object.entries(t.timeByKind).sort((a, b) => b[1] - a[1])
    const total = kinds.reduce((a, [, v]) => a + v, 0) || 1
    return (
      <details className="rounded-md border border-dashed bg-muted/30 px-3 py-1.5">
        <summary className="flex cursor-pointer select-none items-center gap-1.5 text-[10px] text-muted-foreground">
          <Activity className="h-3 w-3 text-sky-500" />
          trace {t.traceId.slice(0, 8)}｜{(t.durationMs / 1000).toFixed(1)}s｜{t.totalTokens} token
          {t.usageSource === 'api' ? '' : `（${t.usageSource}）`}
        </summary>
        <div className="mt-1.5 space-y-0.5 border-t pt-1.5 text-[10px] text-muted-foreground">
          {kinds.map(([k, v]) => (
            <div key={k} className="flex items-center gap-2">
              <span className="w-8">{k}</span>
              <span className="h-1.5 rounded bg-sky-400/60" style={{ width: `${(v / total) * 140}px` }} />
              <span>{(v / 1000).toFixed(1)}s</span>
            </div>
          ))}
        </div>
      </details>
    )
  }
  if (message.kind === 'plan') {
    return (
      <Card className="border-emerald-200 bg-emerald-50/50 shadow-none">
        <CardHeader className="flex flex-row items-center gap-2 py-2">
          <ListChecks className="h-4 w-4 text-emerald-600" />
          <CardTitle className="text-xs">任务规划</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <ol className="list-inside list-decimal space-y-0.5 marker:text-emerald-600 text-xs text-muted-foreground">
            {(message.steps ?? []).map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </CardContent>
      </Card>
    )
  }
  if (message.kind === 'context') {
    return (
      <p className="rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-700">⤴ {message.text}</p>
    )
  }
  if (message.kind === 'error') {
    return (
      <p className="flex items-start gap-1.5 rounded bg-red-50 px-2 py-1.5 text-xs text-red-600">
        <User className="mt-0.5 h-3 w-3 shrink-0" /> {message.text}
      </p>
    )
  }
  return null
}
