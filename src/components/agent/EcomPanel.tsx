'use client'

/**
 * 电商服务商工作台面板。
 *
 * 对应 JD 第 5 条「原型设计」——让产品形态可见，而不是只有代码。
 * 展示三件事：
 *   1. 商家列表 + 打标结果（数据打标 / 结构化）
 *   2. 选中商家的经营诊断 + 推荐任务（经营诊断 / 任务推荐）
 *   3. 一键生成跟进话术 + 质量分（话术生成 / Prompt 效果）
 */
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Loader2, Stethoscope, MessageSquareText, Search, Store } from 'lucide-react'

interface Tag {
  dimension: string
  value: string
  label: string
  confidence: number
  evidence: string
  needReview: boolean
}

interface Issue {
  code: string
  metric: string
  severity: 'critical' | 'warning' | 'ok'
  current: string
  target: string
  priority: number
  conclusion: string
  actions: string[]
}

interface Diagnosis {
  headline: string
  score: number
  issues: Issue[]
  tasks: { title: string; reason: string; priority: string; owner: string }[]
  sufficient: boolean
  missingMetrics: string[]
}

interface Merchant {
  id: string
  name?: string
  monthlyGmv?: number
  note?: string
  /** 经营指标（API 会把原始记录一并返回，声明出来避免类型断言） */
  conversionRate?: number
  refundRate?: number
  avgResponseSec?: number
  traffic?: number
  tags: Tag[]
  reviewCount: number
  diagnosis: Diagnosis
}

interface ScriptResult {
  text: string
  ok: boolean
  error?: string
  variantName?: string
  knowledgeUsed?: number
  quality: { score: number; hasViolation: boolean; checks: { label: string; pass: boolean; detail?: string }[] }
}

const SEV_STYLE: Record<string, string> = {
  critical: 'bg-red-100 text-red-700 border-red-300',
  warning: 'bg-amber-100 text-amber-700 border-amber-300',
  ok: 'bg-emerald-100 text-emerald-700 border-emerald-300',
}

export function EcomPanel() {
  const [merchants, setMerchants] = useState<Merchant[]>([])
  const [summary, setSummary] = useState<{ tagging: Record<string, number>; diagnosis: { avgScore: number; criticalCount: number; topIssues: { metric: string; count: number }[] } } | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [script, setScript] = useState<ScriptResult | null>(null)
  const [scriptLoading, setScriptLoading] = useState(false)
  const [kbQuery, setKbQuery] = useState('')
  const [kbHits, setKbHits] = useState<{ file: string; heading: string; score: number; excerpt: string }[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/ecom?action=dataset')
      const d = await r.json()
      setMerchants(d.merchants ?? [])
      setSummary({ tagging: d.taggingSummary?.coverage ?? {}, diagnosis: d.diagnosisSummary })
      setActiveId((prev) => prev ?? d.merchants?.[0]?.id ?? null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const active = merchants.find((m) => m.id === activeId) ?? null

  const genScript = async () => {
    if (!active) return
    setScriptLoading(true)
    setScript(null)
    try {
      const r = await fetch('/api/ecom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'script',
          intent: 'diagnose',
          record: {
            id: active.id,
            name: active.name,
            monthlyGmv: active.monthlyGmv,
            note: active.note,
            conversionRate: active.conversionRate,
            refundRate: active.refundRate,
            avgResponseSec: active.avgResponseSec,
            traffic: active.traffic,
          },
        }),
      })
      setScript(await r.json())
    } finally {
      setScriptLoading(false)
    }
  }

  const searchKb = async () => {
    if (!kbQuery.trim()) return
    const r = await fetch(`/api/ecom?action=knowledge&q=${encodeURIComponent(kbQuery)}`)
    const d = await r.json()
    setKbHits(d.hits ?? [])
  }

  if (loading) {
    return (
      <p className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> 加载商家数据…
      </p>
    )
  }

  return (
    <div className="space-y-3 p-3 text-xs">
      {/* 概览 */}
      {summary && (
        <Card className="shadow-none">
          <CardHeader className="py-2">
            <CardTitle className="flex items-center gap-1.5 text-xs">
              <Store className="h-3.5 w-3.5" /> 服务商工作台
              <span className="ml-1 text-[10px] font-normal text-muted-foreground">
                {merchants.length} 家商家（演示数据）
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 pt-0 text-[10px] text-muted-foreground">
            <p>
              平均健康分 <span className="font-medium text-foreground">{summary.diagnosis?.avgScore ?? '—'}</span>
              ｜需干预 <span className="font-medium text-red-600">{summary.diagnosis?.criticalCount ?? 0}</span> 家
            </p>
            {summary.diagnosis?.topIssues?.length ? (
              <p>
                最集中问题：
                {summary.diagnosis.topIssues.map((t) => `${t.metric}(${t.count})`).join('、')}
              </p>
            ) : null}
          </CardContent>
        </Card>
      )}

      {/* 商家列表 */}
      <div className="space-y-1.5">
        {merchants.map((m) => {
          const pri = m.tags.find((t) => t.dimension === 'priority')
          const activeRow = m.id === activeId
          return (
            <button
              key={m.id}
              onClick={() => { setActiveId(m.id); setScript(null) }}
              className={`w-full rounded-md border p-2 text-left transition-colors ${
                activeRow ? 'border-emerald-400 bg-emerald-50/50' : 'hover:bg-muted'
              }`}
            >
              <div className="flex items-center gap-1.5">
                <span className="font-medium">{m.name ?? m.id}</span>
                {pri && (
                  <Badge
                    variant="outline"
                    className={`text-[9px] ${
                      pri.value === 'p0' ? 'border-red-300 text-red-700'
                        : pri.value === 'p1' ? 'border-amber-300 text-amber-700'
                          : 'border-muted text-muted-foreground'
                    }`}
                  >
                    {pri.label}
                  </Badge>
                )}
                <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                  {m.diagnosis.sufficient ? `${m.diagnosis.score} 分` : '数据不足'}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {m.tags
                  .filter((t) => ['scale', 'category', 'health'].includes(t.dimension))
                  .map((t) => (
                    <span
                      key={t.dimension}
                      className={`rounded border px-1 py-0.5 text-[9px] ${
                        t.needReview ? 'border-amber-300 text-amber-700' : 'border-muted text-muted-foreground'
                      }`}
                      title={t.evidence}
                    >
                      {t.label}
                      {t.needReview ? ' ⚠' : ''}
                    </span>
                  ))}
              </div>
            </button>
          )
        })}
      </div>

      {/* 诊断详情 */}
      {active && (
        <Card className="shadow-none">
          <CardHeader className="py-2">
            <CardTitle className="flex items-center gap-1.5 text-xs">
              <Stethoscope className="h-3.5 w-3.5" /> 经营诊断
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 pt-0">
            <p className="text-[11px]">{active.diagnosis.headline}</p>
            {active.diagnosis.sufficient ? (
              <>
                {active.diagnosis.issues.filter((i) => i.severity !== 'ok').map((i) => (
                  <div key={i.code} className="rounded border p-1.5">
                    <div className="flex items-center gap-1.5">
                      <span className={`rounded border px-1 text-[9px] ${SEV_STYLE[i.severity]}`}>
                        {i.severity === 'critical' ? '严重' : '预警'}
                      </span>
                      <span className="font-medium">{i.metric}</span>
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {i.current} / 目标 {i.target}
                      </span>
                      <span className="ml-auto text-[9px] text-muted-foreground">优先级 {i.priority}</span>
                    </div>
                    <p className="mt-1 text-[10px] text-muted-foreground">{i.conclusion}</p>
                  </div>
                ))}
                {active.diagnosis.tasks.length > 0 && (
                  <div className="space-y-1 border-t pt-1.5">
                    <p className="text-[10px] font-medium">推荐任务</p>
                    {active.diagnosis.tasks.map((t, i) => (
                      <p key={i} className="text-[10px] text-muted-foreground">
                        [{t.priority.toUpperCase()}] {t.title}（{t.owner}）
                      </p>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <p className="text-[10px] text-amber-700">
                缺失指标：{active.diagnosis.missingMetrics.join('、')} —— 数据不足时不硬下结论
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* 话术生成 */}
      {active && (
        <Card className="shadow-none">
          <CardHeader className="py-2">
            <CardTitle className="flex items-center gap-1.5 text-xs">
              <MessageSquareText className="h-3.5 w-3.5" /> 跟进话术
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 pt-0">
            <Button size="sm" className="h-7 text-[11px]" onClick={genScript} disabled={scriptLoading}>
              {scriptLoading ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
              生成诊断话术
            </Button>
            {script && !script.ok && (
              <p className="text-[10px] text-amber-700">
                生成失败：{script.error}（若为额度/网络问题，重试即可）
              </p>
            )}
            {script?.ok && (
              <>
                <div className="rounded bg-muted/50 p-2 text-[11px] leading-relaxed">{script.text}</div>
                <div className="flex items-center gap-2 text-[10px]">
                  <span>质量分 {(script.quality.score * 100).toFixed(0)}%</span>
                  {script.quality.hasViolation && (
                    <span className="text-red-600">⚠ 命中 SOP 禁止事项</span>
                  )}
                  {typeof script.knowledgeUsed === 'number' && (
                    <span className="ml-auto text-muted-foreground">参考知识库 {script.knowledgeUsed} 条</span>
                  )}
                </div>
                <div className="space-y-0.5">
                  {script.quality.checks.filter((c) => !c.pass).map((c, i) => (
                    <p key={i} className="text-[10px] text-amber-700">✗ {c.label}{c.detail ? ` — ${c.detail}` : ''}</p>
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* 知识库检索 */}
      <Card className="shadow-none">
        <CardHeader className="py-2">
          <CardTitle className="flex items-center gap-1.5 text-xs">
            <Search className="h-3.5 w-3.5" /> 业务知识库
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 pt-0">
          <div className="flex gap-1">
            <input
              value={kbQuery}
              onChange={(e) => setKbQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && searchKb()}
              placeholder="如：仅退款规则 / 转化率低怎么诊断"
              className="min-w-0 flex-1 rounded border bg-background px-2 py-1 text-[10px]"
            />
            <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={searchKb}>
              检索
            </Button>
          </div>
          {kbHits.map((h, i) => (
            <div key={i} className="rounded border p-1.5">
              <p className="text-[10px] text-muted-foreground">
                {h.file} / {h.heading}（{h.score}）
              </p>
              <p className="mt-0.5 text-[10px] leading-relaxed">{h.excerpt.slice(0, 150)}…</p>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
