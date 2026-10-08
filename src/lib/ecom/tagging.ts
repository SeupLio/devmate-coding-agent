/**
 * 电商服务商场景：数据打标引擎。
 *
 * 对应 JD 第 2 条：「业务数据、商家案例、服务商跟进记录……的清洗、整理、分类和打标，
 * 沉淀可用于 AI 能力建设的高质量基础数据」。
 *
 * ## 设计取舍：规则打标优先，而不是全交给 LLM
 *
 * 打标是**基础设施**，不是创作任务。这里用**确定性规则**做主判定，理由：
 *  1. **可解释**：每个标签都带「命中了什么」，运营能复核、能纠错
 *  2. **可复现**：同样的输入永远同样的输出，能进统计、能交接
 *  3. **零成本零幻觉**：不会把「退款率 3%」打成「高退款」
 *
 * LLM 的位置是**兜底**：规则覆盖不到的自由文本（如跟进记录里的口语化痛点），
 * 由调用方决定是否再叠一层 LLM 抽取。本模块只做规则层，保持纯粹可测。
 *
 * ## 置信度怎么来的
 *
 * 每条标签带 confidence（0~1）：
 *  - 数值硬判定（GMV 分档）→ 1.0
 *  - 关键词命中文本 → 按命中强度给 0.6~0.9
 *  - 多信号交叉印证 → 取最高并小幅加成
 * 置信度低的标签在前端标黄，提示「需人工复核」—— 这才是「高质量数据」的诚实做法。
 */
import {
  CATEGORY, HEALTH, PAIN_POINT, PRIORITY, SCALE, STAGE,
  isValidTagValue, type TagValue,
} from './taxonomy'
import { DEFAULT_THRESHOLDS, fmtMetric, gradeMetric, isCritical, type EcomThresholds } from './thresholds'

/** 商家的一条结构化记录（清洗后的输入） */
export interface MerchantRecord {
  id: string
  /** 商家名 */
  name?: string
  /** 月 GMV（元），可缺 */
  monthlyGmv?: number
  /** 支付转化率（0~1），可缺 */
  conversionRate?: number
  /** 退款率（0~1），可缺 */
  refundRate?: number
  /** 平均客服响应时长（秒），可缺 */
  avgResponseSec?: number
  /** 近 30 天曝光/进店量，可缺 */
  traffic?: number
  /** 自由文本：跟进记录、商家案例、咨询内容等 */
  note?: string
  /** 已知阶段（若上游已确定，规则不再覆盖） */
  stage?: string
}

/** 一个打出来的标签 */
export interface Tag {
  dimension: string
  value: string
  label: string
  confidence: number
  /** 命中依据（可解释性：为什么打这个标） */
  evidence: string
  /** 是否需要人工复核（低置信度） */
  needReview: boolean
}

export interface TaggingResult {
  merchantId: string
  tags: Tag[]
  /** 各维度是否成功打上标（便于统计覆盖率） */
  coverage: Record<string, boolean>
  /** 需要人工复核的标签数 */
  reviewCount: number
}

// ===================== 文本信号 =====================

/** 痛点关键词表：命中即打对应痛点标（可多选） */
const PAIN_KEYWORDS: { value: string; words: string[] }[] = [
  { value: 'low_traffic', words: ['没流量', '流量少', '流量低', '没曝光', '曝光少', '进店少', '没人看', '引流难'] },
  { value: 'low_conversion', words: ['转化低', '转化差', '转化不行', '转化起不来', '不下单', '光看不买', '加购不买', '成交少', '转化率低'] },
  { value: 'high_refund', words: ['退款多', '退货多', '退款率高', '退货率高', '仅退款', '售后多'] },
  { value: 'slow_response', words: ['回复慢', '响应慢', '客服不够', '没人回', '没人理', '回复不及时', '回复要等很久', '等很久才回'] },
  { value: 'poor_content', words: ['不会拍', '不会直播', '短视频差', '内容不行', '直播没量', '不会做内容'] },
  { value: 'price_war', words: ['价格战', '同行压价', '利润薄', '没利润', '卷价格', '同质化'] },
]

/** 类目关键词表 */
const CATEGORY_KEYWORDS: { value: string; words: string[] }[] = [
  { value: 'apparel', words: ['服装', '服饰', '衣服', '女装', '男装', '鞋', '包', '童装', '内衣'] },
  { value: 'beauty', words: ['美妆', '化妆', '护肤', '彩妆', '个护', '面膜', '口红'] },
  { value: 'food', words: ['食品', '生鲜', '零食', '水果', '粮油', '特产', '饮料'] },
  { value: '3c', words: ['数码', '手机', '电脑', '耳机', '3c', '电子', '配件'] },
  { value: 'home', words: ['家居', '百货', '日用', '厨房', '收纳', '家纺'] },
]

/** 阶段关键词（仅当上游未给 stage 时用文本兜底） */
const STAGE_KEYWORDS: { value: string; words: string[] }[] = [
  { value: 'converted', words: ['已签约', '签约了', '已合作', '开始合作', '成交客户'] },
  { value: 'lost', words: ['拒绝', '不做了', '失联', '不回复', '已流失', '不考虑'] },
  { value: 'interested', words: ['有意向', '感兴趣', '想了解', '约了', '要看方案', '考虑中'] },
  { value: 'contacted', words: ['已联系', '联系上', '沟通过', '加了微信', '已加微信', '加过微信', '首次触达'] },
]

/** 命中关键词 → 返回命中的词（用于 evidence） */
function matchWords(text: string, words: string[]): string[] {
  const lower = text.toLowerCase()
  return words.filter((w) => lower.includes(w.toLowerCase()))
}

function makeTag(
  dimension: string,
  tv: TagValue,
  confidence: number,
  evidence: string,
  t: EcomThresholds = DEFAULT_THRESHOLDS,
): Tag {
  return {
    dimension,
    value: tv.value,
    label: tv.label,
    confidence: Math.round(confidence * 100) / 100,
    evidence,
    needReview: confidence < t.confidence.reviewBelow,
  }
}

function findTagValue(dim: { values: TagValue[] }, value: string): TagValue | undefined {
  return dim.values.find((v) => v.value === value)
}

// ===================== 各维度打标 =====================

/** 规模：按 GMV 分档（阈值可配置），confidence = 1（数值判定，无歧义） */
export function tagScale(rec: MerchantRecord, t: EcomThresholds = DEFAULT_THRESHOLDS): Tag | null {
  if (typeof rec.monthlyGmv !== 'number' || rec.monthlyGmv < 0) return null
  const gmv = rec.monthlyGmv
  const value = gmv >= t.scale.ka ? 'ka' : gmv >= t.scale.mid ? 'mid' : 'long_tail'
  const tv = findTagValue(SCALE, value)!
  return makeTag(SCALE.key, tv, 1.0, `月GMV=${gmv} 元，落入 ${tv.label} 档`, t)
}

/**
 * 痛点：数值信号（强）+ 文本关键词（弱）交叉。
 * 两者都命中 → 置信度加成；只命中一个 → 按来源给分。
 */
export function tagPainPoints(rec: MerchantRecord, t: EcomThresholds = DEFAULT_THRESHOLDS): Tag[] {
  const out: Tag[] = []
  const hit = new Map<string, { conf: number; ev: string[] }>()

  const bump = (value: string, conf: number, ev: string) => {
    const cur = hit.get(value)
    if (!cur) hit.set(value, { conf, ev: [ev] })
    else {
      // 多信号交叉：取最高 + 加成（封顶由阈值控制）
      cur.conf = Math.min(t.confidence.bothCap, Math.max(cur.conf, conf) + t.confidence.bothBonus)
      cur.ev.push(ev)
    }
  }

  // 数值信号（强）—— 判定走 thresholds 的统一函数，与诊断口径一致
  if (typeof rec.conversionRate === 'number' && isCritical('conversionRate', rec.conversionRate, t)) {
    bump('low_conversion', t.confidence.numeric, `转化率 ${fmtMetric('conversionRate', rec.conversionRate)} 低于严重线 ${fmtMetric('conversionRate', t.metrics.conversionRate.critical)}`)
  }
  if (typeof rec.refundRate === 'number' && isCritical('refundRate', rec.refundRate, t)) {
    bump('high_refund', t.confidence.numeric, `退款率 ${fmtMetric('refundRate', rec.refundRate)} 高于严重线 ${fmtMetric('refundRate', t.metrics.refundRate.critical)}`)
  }
  if (typeof rec.avgResponseSec === 'number' && isCritical('avgResponseSec', rec.avgResponseSec, t)) {
    bump('slow_response', t.confidence.numeric, `平均响应 ${fmtMetric('avgResponseSec', rec.avgResponseSec)} 高于严重线 ${fmtMetric('avgResponseSec', t.metrics.avgResponseSec.critical)}`)
  }
  if (typeof rec.traffic === 'number' && isCritical('traffic', rec.traffic, t)) {
    bump('low_traffic', t.confidence.numeric, `近30天进店 ${fmtMetric('traffic', rec.traffic)} 低于严重线 ${fmtMetric('traffic', t.metrics.traffic.critical)}`)
  }

  // 文本信号（弱）
  const note = rec.note ?? ''
  if (note) {
    for (const pk of PAIN_KEYWORDS) {
      const words = matchWords(note, pk.words)
      if (words.length) bump(pk.value, t.confidence.text, `跟进记录命中「${words.join('、')}」`)
    }
  }

  for (const [value, { conf, ev }] of hit) {
    const tv = findTagValue(PAIN_POINT, value)
    if (tv) out.push(makeTag(PAIN_POINT.key, tv, conf, ev.join('；'), t))
  }
  return out.sort((a, b) => b.confidence - a.confidence)
}

/** 类目：优先数值无、走文本关键词；命中多个取第一个但降低置信度 */
export function tagCategory(rec: MerchantRecord, t: EcomThresholds = DEFAULT_THRESHOLDS): Tag | null {
  const text = `${rec.name ?? ''} ${rec.note ?? ''}`
  if (!text.trim()) return null
  const matched: { value: string; words: string[] }[] = []
  for (const ck of CATEGORY_KEYWORDS) {
    const words = matchWords(text, ck.words)
    if (words.length) matched.push({ value: ck.value, words })
  }
  if (!matched.length) {
    const tv = findTagValue(CATEGORY, 'other')!
    return makeTag(CATEGORY.key, tv, 0.4, '未命中任何类目关键词，归为「其他」', t)
  }
  // 命中唯一类目 → 高置信；命中多个 → 取第一个但降置信（有歧义）
  const first = matched[0]
  const tv = findTagValue(CATEGORY, first.value)!
  const conf = matched.length === 1 ? 0.8 : 0.55
  const ev = matched.length === 1
    ? `命中「${first.words.join('、')}」`
    : `命中多个类目（${matched.map((m) => m.words[0]).join('/')}），取「${tv.label}」，需复核`
  return makeTag(CATEGORY.key, tv, conf, ev, t)
}

/** 阶段：上游给了就用（confidence=1），否则文本兜底 */
export function tagStage(rec: MerchantRecord, t: EcomThresholds = DEFAULT_THRESHOLDS): Tag | null {
  if (rec.stage && isValidTagValue(STAGE.key, rec.stage)) {
    const tv = findTagValue(STAGE, rec.stage)!
    return makeTag(STAGE.key, tv, 1.0, '上游已确定阶段', t)
  }
  const note = rec.note ?? ''
  if (!note) return null
  for (const sk of STAGE_KEYWORDS) {
    const words = matchWords(note, sk.words)
    if (words.length) {
      const tv = findTagValue(STAGE, sk.value)!
      return makeTag(STAGE.key, tv, 0.7, `跟进记录命中「${words.join('、')}」`, t)
    }
  }
  // 完全没信号 → 默认「待触达」，低置信
  const tv = findTagValue(STAGE, 'lead')!
  return makeTag(STAGE.key, tv, 0.4, '无阶段信号，默认「待触达」', t)
}

/**
 * 数一条记录有几个「严重项」—— 健康度与优先级共用。
 * 单独抽出来是因为优先级不该依赖 health 标签（那个标签混入了「全项平庸」情形）。
 */
export function countCriticals(rec: MerchantRecord, t: EcomThresholds = DEFAULT_THRESHOLDS): number {
  let n = 0
  if (typeof rec.conversionRate === 'number' && isCritical('conversionRate', rec.conversionRate, t)) n++
  if (typeof rec.refundRate === 'number' && isCritical('refundRate', rec.refundRate, t)) n++
  if (typeof rec.avgResponseSec === 'number' && isCritical('avgResponseSec', rec.avgResponseSec, t)) n++
  if (typeof rec.traffic === 'number' && isCritical('traffic', rec.traffic, t)) n++
  return n
}

/**
 * 经营健康度：数「严重项」的个数（口径与 thresholds 一致）。
 * 严重项 = 转化率 / 退款率 / 响应 / 流量 任一跌破严重线。
 *
 * ⚠️ 这里刻意用**严重线**而非达标线：若用达标线，多数商家都会中招，
 * 「需干预」标签就失去区分度（见 thresholds.ts 的三层线说明）。
 */
export function tagHealth(rec: MerchantRecord, t: EcomThresholds = DEFAULT_THRESHOLDS): Tag | null {
  const warnings: string[] = []
  const grades: string[] = []
  const check = (key: Parameters<typeof isCritical>[0], label: string, v: number | undefined) => {
    if (typeof v !== 'number') return
    const g = gradeMetric(key, v, t)
    grades.push(g)
    if (g === 'critical') warnings.push(label)
  }
  check('conversionRate', '转化率低', rec.conversionRate)
  check('refundRate', '退款率高', rec.refundRate)
  check('avgResponseSec', '响应慢', rec.avgResponseSec)
  check('traffic', '流量低', rec.traffic)
  const criticalCount = warnings.length

  // 没有任何数值指标 → 不打健康度标（不瞎猜）
  const hasMetric =
    typeof rec.conversionRate === 'number' || typeof rec.refundRate === 'number' ||
    typeof rec.avgResponseSec === 'number' || typeof rec.traffic === 'number'
  if (!hasMetric) return null

  // 除了「严重项个数」，还要看「预警项个数」：
  // 四项指标全部处于预警区（0 项严重）的商家，比「一项严重、三项优秀」更该被关注，
  // 但只数严重项会把它判成「健康」—— 这是真实的口径漏洞（由挑战集 C07 暴露）。
  const warnCount = grades.filter((g) => g === 'warning').length
  // 「全项低于达标线」也判亚健康：全项平庸 ≠ 健康。
  // 但要求「全部」而非「N 项以上」，否则会把多数正常商家误伤（见 thresholds 注释）。
  const allWarn = t.health.atRiskAllWarn && grades.length >= 2 && grades.every((g) => g !== 'ok')
  const value =
    criticalCount >= t.health.unhealthyMinCritical ? 'unhealthy'
    : criticalCount >= t.health.atRiskMinCritical || allWarn ? 'at_risk'
    : 'healthy'
  const tv = findTagValue(HEALTH, value)!
  const ev = warnings.length
    ? `严重项：${warnings.join('、')}${warnCount ? `（另有 ${warnCount} 项预警）` : ''}`
    : warnCount
      ? `无严重项，但 ${warnCount} 项处于预警区`
      : '各项指标未跌破严重线'
  return makeTag(HEALTH.key, tv, 0.9, ev, t)
}

/**
 * 跟进优先级：健康度 × 规模 × 阶段 的综合。
 * P0 = 高价值(KA/腰部) 且 (需干预 或 意向中)；P2 = 健康且长尾；其余 P1。
 * 这是「该先跟进谁」的产品判断，规则写死便于运营理解和调整。
 */
export function tagPriority(rec: MerchantRecord, tags: Tag[], t: EcomThresholds = DEFAULT_THRESHOLDS): Tag | null {
  const get = (dim: string) => tags.find((tag) => tag.dimension === dim)?.value
  const health = get(HEALTH.key)
  const scale = get(SCALE.key)
  const stage = get(STAGE.key)
  if (!health && !scale && !stage) return null // 信息不足，不打优先级

  const highValue = scale === 'ka' || scale === 'mid'
  /**
   * 「有风险」以**是否存在严重项**为准，而不是看 health 标签。
   *
   * 原因：health 的 at_risk 包含「全项平庸但无严重项」这种情形，
   * 而 P0（立即跟进）是**稀缺资源**，不该被「平庸」占用 ——
   * 否则真正有严重问题的商家会被挤到后面。
   * 这个区分由挑战集 C07（全项预警）与回归集 G13 共同校准出来。
   */
  const risky = countCriticals(rec, t) >= 1
  const hotLead = stage === 'interested'

  let value: string
  let ev: string
  if ((highValue && risky) || hotLead || (scale === 'ka' && stage === 'contacted')) {
    value = 'p0'
    ev = hotLead ? '有明确意向信号' : highValue && risky ? '高价值 + 有风险，需立即干预' : 'KA 已触达，趁热跟进'
  } else if (highValue || risky) {
    value = 'p1'
    ev = '中等价值或中等风险，本周内跟进'
  } else {
    value = 'p2'
    ev = '健康且价值一般，常规维护'
  }
  const tv = findTagValue(PRIORITY, value)!
  return makeTag(PRIORITY.key, tv, 0.85, ev, t)
}

// ===================== 主入口 =====================

/** 对一条商家记录做全维度打标（thresholds 决定判定口径，默认用 DEFAULT_THRESHOLDS） */
export function tagMerchant(rec: MerchantRecord, t: EcomThresholds = DEFAULT_THRESHOLDS): TaggingResult {
  const tags: Tag[] = []

  const stage = tagStage(rec, t)
  const category = tagCategory(rec, t)
  const scale = tagScale(rec, t)
  const health = tagHealth(rec, t)
  if (stage) tags.push(stage)
  if (category) tags.push(category)
  if (scale) tags.push(scale)
  if (health) tags.push(health)
  tags.push(...tagPainPoints(rec, t))

  // 优先级依赖前面的标签，最后算
  const priority = tagPriority(rec, tags, t)
  if (priority) tags.push(priority)

  const coverage: Record<string, boolean> = {}
  for (const dim of [STAGE, CATEGORY, SCALE, HEALTH, PRIORITY, PAIN_POINT]) {
    coverage[dim.key] = tags.some((t) => t.dimension === dim.key)
  }

  return {
    merchantId: rec.id,
    tags,
    coverage,
    reviewCount: tags.filter((t) => t.needReview).length,
  }
}

/** 批量打标 + 汇总统计（数据覆盖率、需复核比例）——对应「沉淀高质量基础数据」 */
export function tagBatch(records: MerchantRecord[], t: EcomThresholds = DEFAULT_THRESHOLDS): {
  results: TaggingResult[]
  summary: {
    total: number
    avgTagsPerRecord: number
    reviewRate: number
    coverage: Record<string, number>
  }
} {
  const results = records.map((r) => tagMerchant(r, t))
  const total = results.length
  const totalTags = results.reduce((a, r) => a + r.tags.length, 0)
  const totalReview = results.reduce((a, r) => a + r.reviewCount, 0)
  const coverage: Record<string, number> = {}
  for (const dim of [STAGE, CATEGORY, SCALE, HEALTH, PRIORITY, PAIN_POINT]) {
    const n = results.filter((r) => r.coverage[dim.key]).length
    coverage[dim.key] = total ? Math.round((n / total) * 100) / 100 : 0
  }
  return {
    results,
    summary: {
      total,
      avgTagsPerRecord: total ? Math.round((totalTags / total) * 100) / 100 : 0,
      reviewRate: totalTags ? Math.round((totalReview / totalTags) * 100) / 100 : 0,
      coverage,
    },
  }
}

/** 渲染成给运营/前端看的文本 */
export function formatTagging(r: TaggingResult): string {
  const lines = [`商家 ${r.merchantId} 打标结果（${r.tags.length} 个标签，${r.reviewCount} 个需复核）`]
  for (const t of r.tags) {
    const flag = t.needReview ? ' ⚠需复核' : ''
    lines.push(`  [${t.dimension}] ${t.label}（置信 ${(t.confidence * 100).toFixed(0)}%${flag}）— ${t.evidence}`)
  }
  return lines.join('\n')
}
