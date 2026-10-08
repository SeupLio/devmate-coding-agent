/**
 * 电商场景：判定阈值（业务口径的**单一来源**）。
 *
 * ## 为什么阈值要单独成一层
 *
 * 之前的写法是 `refundRate > 0.1`、`avgResponseSec > 60` 这类数字**散落在打标逻辑里**，
 * 而且**诊断模块又维护了另一套**（退款率 8% / 10%、响应 30s / 60s）。
 * 结果是同一个商家可能「打标说退款率高、诊断说没问题」—— 这就是典型的口径分裂。
 *
 * 抽成单一来源后解决三件事：
 *  1. **运营改得了**：不同类目水位不同（服饰退货 18% 正常、家居 7% 就偏高），
 *     阈值可配置、可按类目给预设，运营不必等排期。
 *  2. **可校准**：阈值成了结构化参数，才能用手上的标注数据做网格搜索
 *     （见 `calibrate.ts` / `bun run ecom:eval --calibrate`）。
 *  3. **口径一致**：打标与诊断读同一份配置，不会各说各话。
 *
 * ## 两条线产生三档：达标线 + 严重线
 *
 * 只设一条线是不够的 —— 若把「达标线」直接当「出问题」的判据，
 * 几乎所有商家都会被打上「响应慢」（多数商家做不到 30 秒），标签就失去区分度。
 * 但也不需要三条线：**三档严重度只需要两条边界**。
 *
 * ```
 *   越高越好（转化率 / 进店量）      越低越好（退款率 / 响应时长）
 *   critical ──── target            target ──── critical
 *     ✗严重   ⚠预警    ✓达标          ✓达标   ⚠预警    ✗严重
 * ```
 *
 *  - `target`：方法论里的**达标线**（做到算优秀）
 *  - `critical`：**严重线**（越过即必须处理）
 *  - 两者之间 = 预警（低于优秀，但还没到必须干预）
 *
 * 两个消费方的口径因此完全对齐，且都只读这两条线：
 *  - **打标健康度**：只把 `critical` 记为「预警项」（保守，保住区分度）
 *  - **经营诊断**：按 severity 分 critical / warning / ok 三档给建议
 *
 * ⚠️ **诚实边界**：`DEFAULT_THRESHOLDS` 的数值来自公开的电商经营经验线与
 * 项目内《经营方法论》，**不是**从真实商家数据拟合的（本环境拿不到真实数据）。
 * 它的价值是「把口径显性化 + 让校准成为可能」，而不是宣称这就是最优阈值。
 */

/** 四个核心经营指标 */
export type MetricKey = 'conversionRate' | 'refundRate' | 'avgResponseSec' | 'traffic'

/** 指标方向：决定「数值变大」是变好还是变差 */
export const METRIC_DIRECTION: Record<MetricKey, 'higher_is_better' | 'lower_is_better'> = {
  conversionRate: 'higher_is_better',
  refundRate: 'lower_is_better',
  avgResponseSec: 'lower_is_better',
  traffic: 'higher_is_better',
}

/** 指标中文名（报告与前端展示用） */
export const METRIC_LABEL: Record<MetricKey, string> = {
  conversionRate: '支付转化率',
  refundRate: '退款率',
  avgResponseSec: '客服响应时长',
  traffic: '近30天进店量',
}

/**
 * 一个指标的两条线。约束：
 *  - higher_is_better（转化率/进店量）：`target ≥ critical`
 *  - lower_is_better（退款率/响应）：`target ≤ critical`
 */
export interface MetricLines {
  /** 达标线（做到算优秀） */
  target: number
  /** 严重线（越过即必须处理） */
  critical: number
}

export interface EcomThresholds {
  /** 规模分档（月 GMV，元）—— ≥ka 为 KA，≥mid 为腰部，其余长尾 */
  scale: { ka: number; mid: number }
  /** 四个核心指标的三层线 */
  metrics: Record<MetricKey, MetricLines>
  /** 健康度分档：严重项个数 + 预警项个数 共同判定 */
  health: {
    /** 严重项 ≥ 此值 → 亚健康 */
    atRiskMinCritical: number
    /** 严重项 ≥ 此值 → 需干预 */
    unhealthyMinCritical: number
    /**
     * 已测指标**全部**低于达标线 → 亚健康（即使没有严重项）。
     *
     * 为什么是「全部」而不是「N 项以上」：达标线是**优秀线**，
     * 多数商家天然低于它 —— 若用「预警项 ≥ 3 就判亚健康」，
     * 会把大量正常商家打成亚健康，标签立刻失去区分度
     * （实测：改这一条会让回归集里 2 个正常样本被误判）。
     * 而「所有指标都不到优秀线」确实值得关注，且不会误伤。
     * 这个边界由挑战集样本 C07 暴露、由回归集 G04/G13 校准。
     */
    atRiskAllWarn: boolean
  }
  /** 打标置信度口径 */
  confidence: {
    /** 数值信号命中的基础置信度 */
    numeric: number
    /** 文本关键词命中的基础置信度（弱于数值） */
    text: number
    /** 数值 + 文本双信号交叉的加成 */
    bothBonus: number
    /** 加成后的上限 */
    bothCap: number
    /** 低于此置信度 → 标记「需人工复核」 */
    reviewBelow: number
  }
}

/**
 * 默认口径（全类目通用）。
 *
 * `target` 取自《经营方法论》的达标线；`critical` 取「已影响流量/活动资格」的严重线。
 */
export const DEFAULT_THRESHOLDS: EcomThresholds = {
  scale: { ka: 500_000, mid: 100_000 },
  metrics: {
    // 转化率：达标 2.5%，严重 2.0%（2.0~2.5% 之间为预警）
    conversionRate: { target: 0.025, critical: 0.02 },
    // 退款率：达标 8%，严重 10%（8~10% 之间为预警）
    refundRate: { target: 0.08, critical: 0.1 },
    // 响应时长：达标 30s，严重 60s（30~60s 之间为预警）
    avgResponseSec: { target: 30, critical: 60 },
    // 进店量：达标 3000，严重 1000（1000~3000 之间为预警）
    traffic: { target: 3000, critical: 1000 },
  },
  health: {
    atRiskMinCritical: 1,
    unhealthyMinCritical: 2,
    atRiskAllWarn: true,
  },
  confidence: {
    numeric: 0.85,
    text: 0.6,
    bothBonus: 0.1,
    bothCap: 0.98,
    reviewBelow: 0.7,
  },
}

/**
 * 类目预设：不同类目的「正常水位」差别很大，用同一套阈值会误伤。
 *
 * 例：服饰退货率天然偏高（尺码/色差），用 8% 一刀切会把大量正常服饰商家
 * 标成「退款率高」。类目预设是**必要的业务适配**，不是过度设计。
 */
export const PRESETS: Record<string, EcomThresholds> = {
  /** 服饰鞋包：退货率行业性偏高，转化率相对高 */
  apparel: {
    ...DEFAULT_THRESHOLDS,
    metrics: {
      ...DEFAULT_THRESHOLDS.metrics,
      refundRate: { target: 0.15, critical: 0.18 },
      conversionRate: { target: 0.03, critical: 0.025 },
    },
  },
  /** 美妆个护：试用后退货多，但客单与复购要求转化更高 */
  beauty: {
    ...DEFAULT_THRESHOLDS,
    metrics: {
      ...DEFAULT_THRESHOLDS.metrics,
      refundRate: { target: 0.1, critical: 0.13 },
      conversionRate: { target: 0.03, critical: 0.025 },
    },
  },
  /** 食品生鲜：生鲜损耗天然退款高；咨询急，响应要求更严 */
  food: {
    ...DEFAULT_THRESHOLDS,
    metrics: {
      ...DEFAULT_THRESHOLDS.metrics,
      refundRate: { target: 0.12, critical: 0.14 },
      avgResponseSec: { target: 25, critical: 45 },
    },
  },
  /** 3C 数码：客单高、决策慢，转化率天然低 */
  '3c': {
    ...DEFAULT_THRESHOLDS,
    metrics: {
      ...DEFAULT_THRESHOLDS.metrics,
      conversionRate: { target: 0.012, critical: 0.008 },
    },
  },
  /** 家居百货：决策周期长、退货率低 */
  home: {
    ...DEFAULT_THRESHOLDS,
    metrics: {
      ...DEFAULT_THRESHOLDS.metrics,
      refundRate: { target: 0.05, critical: 0.07 },
      conversionRate: { target: 0.02, critical: 0.015 },
    },
  },
}

export type MetricSeverity = 'ok' | 'warning' | 'critical'

/**
 * 判定某指标取值落在哪一档 —— **打标与诊断共用的唯一判定函数**。
 * 之前两处各写一遍判定，是口径分裂的根源。
 */
export function gradeMetric(key: MetricKey, value: number, t: EcomThresholds = DEFAULT_THRESHOLDS): MetricSeverity {
  const lines = t.metrics[key]
  if (METRIC_DIRECTION[key] === 'higher_is_better') {
    if (value >= lines.target) return 'ok'
    if (value >= lines.critical) return 'warning'
    return 'critical'
  }
  if (value <= lines.target) return 'ok'
  if (value <= lines.critical) return 'warning'
  return 'critical'
}

/** 该指标是否触发「严重」预警（打标健康度用；保守口径，保住标签区分度） */
export function isCritical(key: MetricKey, value: number, t: EcomThresholds = DEFAULT_THRESHOLDS): boolean {
  return gradeMetric(key, value, t) === 'critical'
}

/** 该指标是否偏离达标线（诊断用：warning 或 critical 都算需要给建议） */
export function isBelowTarget(key: MetricKey, value: number, t: EcomThresholds = DEFAULT_THRESHOLDS): boolean {
  return gradeMetric(key, value, t) !== 'ok'
}

/** 深拷贝一份阈值（校准时会改值，避免污染默认预设） */
export function cloneThresholds(t: EcomThresholds): EcomThresholds {
  const metrics = {} as Record<MetricKey, MetricLines>
  for (const k of Object.keys(t.metrics) as MetricKey[]) metrics[k] = { ...t.metrics[k] }
  return {
    scale: { ...t.scale },
    metrics,
    health: { ...t.health },
    confidence: { ...t.confidence },
  }
}

/** 把阈值渲染成可读清单（给运营 review，也进评测报告） */
export function describeThresholds(t: EcomThresholds): string {
  const lines = [`规模分档：KA ≥ ${fmt(t.scale.ka)} ｜ 腰部 ≥ ${fmt(t.scale.mid)}`, '指标两条线（达标 / 严重，之间为预警）：']
  for (const k of Object.keys(t.metrics) as MetricKey[]) {
    const l = t.metrics[k]
    const dir = METRIC_DIRECTION[k] === 'higher_is_better' ? '越高越好' : '越低越好'
    lines.push(`  ${METRIC_LABEL[k]}（${dir}）：达标 ${fmtMetric(k, l.target)} ｜ 严重 ${fmtMetric(k, l.critical)}`)
  }
  lines.push(
    `健康度：严重项 ≥ ${t.health.unhealthyMinCritical} → 需干预 ｜ 严重项 ≥ ${t.health.atRiskMinCritical} 或 已测指标全低于达标线 → 亚健康`,
    `置信度：数值 ${t.confidence.numeric} ｜ 文本 ${t.confidence.text} ｜ 双信号 +${t.confidence.bothBonus}` +
      ` ｜ < ${t.confidence.reviewBelow} 标记需复核`,
  )
  return lines.join('\n')
}

function fmt(n: number): string {
  if (n >= 10_000) return `${(n / 10_000).toFixed(n % 10_000 === 0 ? 0 : 1)} 万`
  return String(n)
}

/** 指标值展示（比率转百分比、时长加 s、量加千分位） */
export function fmtMetric(key: MetricKey, v: number): string {
  if (key === 'conversionRate' || key === 'refundRate') return `${(v * 100).toFixed(1)}%`
  if (key === 'avgResponseSec') return `${v}s`
  return v >= 1000 ? `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k` : String(v)
}
