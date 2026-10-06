'use client'

/**
 * 代码评审面板 —— 对应 JD 第 2 条的「代码评审」场景。
 *
 * 直接调 /api/review，不跑 Agent 循环：评审是独立动作，
 * 用户点一下就出结论，不该走「发一条消息等模型规划」那套。
 */
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ShieldCheck, ShieldAlert, Loader2, ScanSearch } from 'lucide-react'

type Severity = 'blocker' | 'major' | 'minor' | 'nit'

interface Finding {
  severity: Severity
  category: string
  file: string
  line?: number
  title: string
  detail: string
  suggestion?: string
  source: 'static' | 'llm'
}

interface ReviewResult {
  findings: Finding[]
  summary: string
  riskScore: number
  stats: { files: number; added: number; removed: number; changedFiles: string[] }
  usedLlm: boolean
  durationMs: number
}

const SEVERITY_STYLE: Record<Severity, { label: string; cls: string }> = {
  blocker: { label: '阻塞', cls: 'bg-red-100 text-red-700 border-red-300' },
  major: { label: '重要', cls: 'bg-amber-100 text-amber-700 border-amber-300' },
  minor: { label: '次要', cls: 'bg-sky-100 text-sky-700 border-sky-300' },
  nit: { label: '建议', cls: 'bg-muted text-muted-foreground border-muted' },
}

export function ReviewPanel({ sessionId }: { sessionId: string | null }) {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<ReviewResult | null>(null)
  const [error, setError] = useState('')

  const run = async () => {
    if (!sessionId) return
    setLoading(true)
    setError('')
    try {
      const r = await fetch('/api/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error ?? '评审失败')
      setResult(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  if (!sessionId) {
    return <p className="p-4 text-xs text-muted-foreground">先创建一个会话。</p>
  }

  return (
    <div className="space-y-3 p-3">
      <div className="flex items-center gap-2">
        <Button size="sm" className="h-7 text-xs" onClick={run} disabled={loading}>
          {loading ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <ScanSearch className="mr-1 h-3 w-3" />}
          评审当前改动
        </Button>
        <span className="text-[10px] text-muted-foreground">
          静态检查 + LLM 语义评审（不跑 Agent 循环）
        </span>
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}

      {result && (
        <>
          <Card className="shadow-none">
            <CardHeader className="flex flex-row items-center gap-2 py-2">
              {result.riskScore >= 50 ? (
                <ShieldAlert className="h-4 w-4 text-red-600" />
              ) : (
                <ShieldCheck className="h-4 w-4 text-emerald-600" />
              )}
              <CardTitle className="text-xs">
                风险分 {result.riskScore}/100 ｜ {result.findings.length} 个问题
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 pt-0 text-[11px] text-muted-foreground">
              <p>{result.summary}</p>
              <p>
                {result.stats.files} 个文件，+{result.stats.added}/-{result.stats.removed}｜
                {result.usedLlm ? '含 LLM 语义评审' : '仅静态检查'}｜
                {(result.durationMs / 1000).toFixed(1)}s
              </p>
            </CardContent>
          </Card>

          {result.findings.map((f, i) => {
            const st = SEVERITY_STYLE[f.severity]
            return (
              <div key={i} className="rounded-md border p-2 text-[11px]">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className={`rounded border px-1.5 py-0.5 text-[10px] ${st.cls}`}>{st.label}</span>
                  <span className="text-[10px] text-muted-foreground">{f.category}</span>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {f.file}
                    {f.line ? `:${f.line}` : ''}
                  </span>
                  <span className="ml-auto rounded bg-muted px-1 text-[9px] text-muted-foreground">
                    {f.source === 'static' ? '确定性' : 'LLM'}
                  </span>
                </div>
                <p className="mt-1 font-medium">{f.title}</p>
                {f.detail && (
                  <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-[10px] text-muted-foreground">
                    {f.detail}
                  </pre>
                )}
                {f.suggestion && <p className="mt-1 text-[10px] text-emerald-700">→ {f.suggestion}</p>}
              </div>
            )
          })}

          {!result.findings.length && (
            <p className="text-xs text-emerald-600">未发现明显问题。</p>
          )}
        </>
      )}

      {!result && !loading && (
        <p className="text-[11px] text-muted-foreground">
          点上面的按钮，对工作区里未提交的改动做一次评审。
          Agent 也可以在提交前自己调用 review_diff 工具自检。
        </p>
      )}
    </div>
  )
}
