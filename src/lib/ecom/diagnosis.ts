/**
 * 电商服务商场景：经营诊断 + 任务推荐引擎。
 *
 * 对应 JD 第 1 条：「围绕商家服务、线索跟进、**经营诊断**、**任务推荐**……梳理 AI 可落地的业务机会」。
 *
 * ## 为什么诊断要做成「规则引擎」而不是丢给 LLM
 *
 * 诊断的结论要能**对商家讲、被运营复核、按口径统计**。如果让 LLM 自由发挥：
 *  - 同一个商家今天诊断「转化率低」，明天诊断「流量不足」，无法复盘
 *  - 阈值藏在提示词里，运营改不了、产品说不清
 *
 * 所以这里把《商家经营方法论》里的**达标线**固化成问题模板，而**判定口径统一取自
 * `thresholds.ts`**（打标与诊断共用同一份阈值，避免同一个商家两处结论打架）：
 * 指标 → 命中问题 → 按「影响 × 可改度」排序 → 输出带预期收益的行动项。
 * LLM 的位置在后面（话术生成时把结论讲成人话），而不是在这里下结论。
 *
 * ## 排序逻辑（这是产品判断，不是技术细节）
 *
 * 方法论里明确写了「先看影响最大且最好改的」。所以每个问题带两个维度：
 *  - `impact`：对 GMV 的影响权重
 *  - `effort`：改进难度（越大越难）
 * 优先级 = impact / effort —— 让「客服响应慢」这类好改的先冒出来，
 * 而不是一股脑把最严重但最难改的排在前面（商家做不完就失去信任）。
 */
import type { MerchantRecord } from './tagging'
import {
  DEFAULT_THRESHOLDS, METRIC_DIRECTION, fmtMetric, gradeMetric,
  type EcomThresholds, type MetricKey,
} from './thresholds'

export type IssueSeverity = 'critical' | 'warning' | 'ok'

export interface DiagnosisIssue {
  /** 问题标识 */
  code: string
  /** 指标名 */
  metric: string
  /** 严重度 */
  severity: IssueSeverity
  /** 当前值（展示用字符串） */
  current: string
  /** 达标线 */
  target: string
  /** 对 GMV 的影响权重 1~5 */
  impact: number
  /** 改进难度 1~5（越小越好改） */
  effort: number
  /** 优先级分（impact / effort，越大越该先做） */
  priority: number
  /** 一句话结论 */
  conclusion: string
  /** 可执行动作（负责人 + 时间 + 预期指标） */
  actions: string[]
}

export interface DiagnosisReport {
  merchantId: string
  /** 一句话总结论 */
  headline: string
  /** 健康分 0~100 */
  score: number
  /** 命中问题（按优先级降序） */
  issues: DiagnosisIssue[]
  /** 推荐任务（从问题里提炼，按优先级排序，最多 3 条） */
  tasks: RecommendedTask[]
  /** 数据是否充足（指标太少时如实说明，不给虚假结论） */
  sufficient: boolean
  /** 缺失的指标（提示补数据） */
  missingMetrics: string[]
}

export interface RecommendedTask {
  title: string
  reason: string
  /** 预期收益描述 */
  expected: string
  /** 优先级 p0/p1/p2 */
  priority: 'p0' | 'p1' | 'p2'
  /** 建议负责人角色 */
  owner: string
}

// ===================== 问题模板（判定口径全部来自 thresholds.ts）=====================

/**
 * 一个「问题模板」：说明该指标为什么重要、该怎么做。
 *
 * 注意：**判定逻辑不在这里** —— 好/预警/严重统一走 `thresholds.gradeMetric`。
 * 之前这里自己写了一套 `pct < 2 ? critical : pct < 2.5 ? warning`，
 * 打标模块又写了另一套（<2% 才算），结果同一个商家会出现
 * 「打标说没问题、诊断说要干预」。现在两处读同一份阈值，口径不可能再分裂。
 */
interface IssueTemplate {
  code: string
  /** 指标中文名 */
  metric: string
  /** 对应的阈值指标（判定与达标线展示都取自它） */
  metricKey: MetricKey
  /** 从记录里取原始值（缺失返回 undefined） */
  pick: (r: MerchantRecord) => number | undefined
  /** 对 GMV 的影响权重 1~5 */
  impact: number
  /** 改进难度 1~5（越小越好改） */
  effort: number
  /** 一句话结论（按严重度给不同措辞） */
  conclusion: (severity: IssueSeverity, r: MerchantRecord) => string
  actions: string[]
}

const ISSUE_TEMPLATES: IssueTemplate[] = [
  {
    code: 'conversion_low',
    metric: '支付转化率',
    metricKey: 'conversionRate',
    pick: (r) => r.conversionRate,
    impact: 5,
    effort: 3,
    conclusion: (sev, r) => {
      if (sev === 'ok') return '转化率达标。'
      const pct = (r.conversionRate ?? 0) * 100
      // 拆成因：曝光高但点击低 vs 点击高但下单低 —— 方法论里的关键区分
      return pct < 2
        ? '转化率明显偏低，需先区分是「流量不精准」还是「承接不行」：若曝光/点击正常，问题多在详情页、评价与客服响应。'
        : '转化率略低于达标线，属可优化区间。'
    },
    actions: [
      '检查详情页：补全尺码表/参数表，增加真人买家秀（负责人：运营，1 周）',
      '排查 SKU 与价格带是否匹配进店人群（负责人：运营，3 天）',
      '主图突出「7 天无理由 + 运费险」降低决策门槛（负责人：视觉，3 天）',
    ],
  },
  {
    code: 'refund_high',
    metric: '退款率',
    metricKey: 'refundRate',
    pick: (r) => r.refundRate,
    impact: 4,
    effort: 4,
    conclusion: (sev, r) =>
      sev === 'ok'
        ? '退款率达标。'
        : (r.refundRate ?? 0) > 0.1
          ? '退款率偏高，直接拉低体验分并影响活动报名资格。需先做「退款原因分布」，再对症下药。'
          : '退款率接近预警线，建议提前排查。',
    actions: [
      '拉取近 30 天退款原因分布，区分质量类 / 描述类 / 物流类（负责人：运营，3 天）',
      '描述类 → 修正详情页夸大表述；质量类 → 溯源供应链抽检（负责人：运营+供应链，2 周）',
      '物流类 → 更换缓冲包装并约定时效（负责人：供应链，1 周）',
    ],
  },
  {
    code: 'response_slow',
    metric: '客服响应时长',
    metricKey: 'avgResponseSec',
    pick: (r) => r.avgResponseSec,
    impact: 4,
    effort: 1, // 最容易改 → 优先级会很高
    conclusion: (sev) =>
      sev === 'ok'
        ? '客服响应达标。'
        : sev === 'critical'
          ? '客服响应过慢，直接拉低转化率与体验分。这是**最容易改、见效最快**的一项，建议优先处理。'
          : '客服响应略慢，仍有优化空间。',
    actions: [
      '调整客服排班覆盖高峰时段（负责人：客服主管，立即）',
      '接入快捷回复/智能客服兜底常见问题（负责人：运营，3 天）',
      '设置 30 秒未响应的内部提醒（负责人：客服主管，立即）',
    ],
  },
  {
    code: 'traffic_low',
    metric: '月进店量',
    metricKey: 'traffic',
    pick: (r) => r.traffic,
    impact: 4,
    effort: 4,
    conclusion: (sev) =>
      sev === 'ok'
        ? '进店量达标。'
        : sev === 'critical'
          ? '进店量偏低，曝光或点击率不足。建议先做免费流量（搜索优化、短视频），再考虑付费投放。'
          : '进店量有提升空间。',
    actions: [
      '优化 3 个引流款的标题关键词与主图（负责人：运营，1 周）',
      '稳定短视频更新频率，测试内容方向（负责人：内容，2 周）',
      '评估是否参与平台新店/类目扶持活动（负责人：服务商 BD，1 周）',
    ],
  },
]

/**
 * 按当前阈值把一条记录判定成问题清单。
 * 导出它是为了让评测/校准能复用同一套判定，而不是另写一遍。
 */
export function evaluateIssues(
  r: MerchantRecord,
  t: EcomThresholds = DEFAULT_THRESHOLDS,
): { issues: DiagnosisIssue[]; missing: string[] } {
  const issues: DiagnosisIssue[] = []
  const missing: string[] = []
  for (const it of ISSUE_TEMPLATES) {
    const v = it.pick(r)
    if (typeof v !== 'number') {
      missing.push(it.metric)
      continue
    }
    const severity = gradeMetric(it.metricKey, v, t)
    const line = t.metrics[it.metricKey]
    const cmp = METRIC_DIRECTION[it.metricKey] === 'higher_is_better' ? '≥' : '≤'
    issues.push({
      code: it.code,
      metric: it.metric,
      severity,
      current: fmtMetric(it.metricKey, v),
      target: `${cmp} ${fmtMetric(it.metricKey, line.target)}`,
      impact: it.impact,
      effort: it.effort,
      priority: Math.round((it.impact / it.effort) * 100) / 100,
      conclusion: it.conclusion(severity, r),
      actions: it.actions,
    })
  }
  return { issues, missing }
}

// ===================== 诊断主流程 =====================

const METRIC_KEYS: { key: keyof MerchantRecord; label: string }[] = [
  { key: 'conversionRate', label: '支付转化率' },
  { key: 'refundRate', label: '退款率' },
  { key: 'avgResponseSec', label: '客服响应时长' },
  { key: 'traffic', label: '月进店量' },
]

/** 健康分：从 100 起扣，critical 扣 25、warning 扣 10，最低 0 */
export function computeScore(issues: DiagnosisIssue[]): number {
  let score = 100
  for (const i of issues) {
    if (i.severity === 'critical') score -= 25
    else if (i.severity === 'warning') score -= 10
  }
  return Math.max(0, score)
}

/** 把问题提炼成任务（最多 3 条，避免商家做不完） */
export function toTasks(issues: DiagnosisIssue[]): RecommendedTask[] {
  return issues
    .filter((i) => i.severity !== 'ok')
    .slice(0, 3)
    .map((i) => ({
      title: `改进「${i.metric}」（当前 ${i.current}，目标 ${i.target}）`,
      reason: i.conclusion,
      expected: `优先级分 ${i.priority}（影响 ${i.impact} / 难度 ${i.effort}），建议优先执行`,
      priority: i.priority >= 3 ? 'p0' : i.priority >= 1.5 ? 'p1' : 'p2',
      owner: i.effort <= 2 ? '运营（可快速落地）' : '运营 + 供应链',
    }))
}

/**
 * 对一条商家记录做经营诊断。
 *
 * 数据不足时**如实说明**（sufficient=false + missingMetrics），
 * 而不是用一两个指标硬凑结论 —— 这关系到服务商在商家面前的可信度。
 */
export function diagnose(rec: MerchantRecord, th: EcomThresholds = DEFAULT_THRESHOLDS): DiagnosisReport {
  const { issues, missing } = evaluateIssues(rec, th)

  // 按优先级（影响/难度）降序；同级按严重度
  const sevRank: Record<IssueSeverity, number> = { critical: 0, warning: 1, ok: 2 }
  issues.sort((a, b) => b.priority - a.priority || sevRank[a.severity] - sevRank[b.severity])

  const problems = issues.filter((i) => i.severity !== 'ok')
  const score = computeScore(issues)
  const sufficient = issues.length >= 2 // 至少两个指标才下结论

  const headline = !sufficient
    ? `数据不足（仅 ${issues.length} 项指标），暂不下结论；请补充：${missing.join('、')}`
    : problems.length === 0
      ? '各项指标均达标，经营状况健康。建议保持节奏并关注复购。'
      : `发现 ${problems.length} 项待改进，其中最优先的是「${problems[0].metric}」（当前 ${problems[0].current}，目标 ${problems[0].target}）。`

  return {
    merchantId: rec.id,
    headline,
    score,
    issues,
    tasks: toTasks(issues),
    sufficient,
    missingMetrics: missing,
  }
}

/** 渲染成给服务商/前端看的文本 */
export function formatDiagnosis(r: DiagnosisReport): string {
  const icon: Record<IssueSeverity, string> = { critical: '🔴', warning: '🟡', ok: '🟢' }
  const lines = [
    `经营诊断｜商家 ${r.merchantId}｜健康分 ${r.score}/100`,
    r.headline,
  ]
  if (!r.sufficient) {
    lines.push(`（缺失指标：${r.missingMetrics.join('、')}）`)
    return lines.join('\n')
  }
  lines.push('', '指标明细（按「影响/难度」优先级排序）：')
  for (const i of r.issues) {
    lines.push(
      `  ${icon[i.severity]} ${i.metric}：${i.current}（目标 ${i.target}）｜优先级 ${i.priority}`,
    )
    if (i.severity !== 'ok') {
      lines.push(`      ${i.conclusion}`)
      for (const a of i.actions) lines.push(`      · ${a}`)
    }
  }
  if (r.tasks.length) {
    lines.push('', '推荐任务：')
    for (const t of r.tasks) lines.push(`  [${t.priority.toUpperCase()}] ${t.title}（${t.owner}）`)
  }
  return lines.join('\n')
}

/** 批量诊断 + 汇总（服务商视角：手上一批商家该先管谁） */
export function diagnoseBatch(records: MerchantRecord[], th: EcomThresholds = DEFAULT_THRESHOLDS): {
  reports: DiagnosisReport[]
  summary: {
    total: number
    avgScore: number
    criticalCount: number
    /** 最集中的问题 Top3（按命中商家数） */
    topIssues: { metric: string; count: number }[]
  }
} {
  const reports = records.map((r) => diagnose(r, th))
  const total = reports.length
  const avgScore = total ? Math.round(reports.reduce((a, r) => a + r.score, 0) / total) : 0
  const criticalCount = reports.filter((r) => r.issues.some((i) => i.severity === 'critical')).length

  const counter = new Map<string, number>()
  for (const r of reports) {
    for (const i of r.issues) {
      if (i.severity === 'ok') continue
      counter.set(i.metric, (counter.get(i.metric) ?? 0) + 1)
    }
  }
  const topIssues = [...counter.entries()]
    .map(([metric, count]) => ({ metric, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)

  return { reports, summary: { total, avgScore, criticalCount, topIssues } }
}
