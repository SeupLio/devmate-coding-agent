/**
 * 电商场景：评价指标库。
 *
 * ## 为什么要有这个文件
 *
 * 「打标准不准、诊断有没有用、话术合不合规」—— 这些问题的答案必须是**数字**，
 * 否则迭代就是凭感觉。这里实现四类对齐真实业务的指标：
 *
 * | 指标族 | 回答什么问题 | 业务含义 |
 * |---|---|---|
 * | 分类指标 P/R/F1 | 打标准不准？ | 沉淀的数据能不能用 |
 * | 一致性 Kappa | 新人打的标和老运营一样吗？ | 口径能否交接、能否规模化 |
 * | 排序指标 P@K / NDCG@K | 「今日优先跟进名单」准不准？ | 运营的每天时间花对地方了吗 |
 * | 数据质量四维 | 上游数据能不能用？ | 打标的上限由数据质量决定 |
 *
 * ## 口径说明（避免指标被误读）
 *
 * - **Precision 高、Recall 低** = 规则保守（宁缺毋滥）→ 会漏标
 * - **Recall 高、Precision 低** = 规则激进 → 会误标，运营要花时间纠正
 * - **Kappa**：<0.2 差 ｜ 0.2~0.4 一般 ｜ 0.4~0.6 中等 ｜ 0.6~0.8 好 ｜ >0.8 极好（Landis & Koch）
 * - 所有指标在**空集/单类别**等边界上返回确定值（0 或 1），不返回 NaN ——
 *   否则报告里出现 NaN，运营会以为系统坏了
 */

// ===================== 分类指标（单标签）=====================

export interface ClassMetric {
  label: string
  /** 真实为该类的样本数 */
  support: number
  tp: number
  fp: number
  fn: number
  precision: number
  recall: number
  f1: number
}

export interface ClassificationReport {
  perClass: ClassMetric[]
  /** 宏平均：各类等权（小类不被大类淹没） */
  macro: { precision: number; recall: number; f1: number }
  /** 微平均：按样本数加权（反映整体正确率） */
  micro: { precision: number; recall: number; f1: number }
  /** 总体准确率 */
  accuracy: number
  total: number
}

/** 混淆矩阵：rows = 真实标签，cols = 预测标签 */
export function confusionMatrix(
  truth: (string | null)[],
  pred: (string | null)[],
): { labels: string[]; matrix: number[][] } {
  const labels = [...new Set([...truth, ...pred].filter((x): x is string => x !== null))].sort()
  const idx = new Map(labels.map((l, i) => [l, i]))
  const matrix = labels.map(() => labels.map(() => 0))
  for (let i = 0; i < truth.length; i++) {
    const t = truth[i]
    const p = pred[i]
    // 真实无标签、预测也无 → 正确（不打标是对的）；真实无标签但预测有 → 误标
    if (t === null && p === null) continue
    if (t === null || p === null) continue // 交由 P/R 的 null 处理逻辑统计
    matrix[idx.get(t)!][idx.get(p)!]++
  }
  return { labels, matrix }
}

/**
 * 单标签分类报告。
 *
 * `null` 的处理（重要）：`null` 表示「不应打标」。
 *  - 真实 null + 预测 null → 计为正确（准确率分子）
 *  - 真实 null + 预测有值 → 误标（拉低 precision）
 *  - 真实有值 + 预测 null → 漏标（拉低 recall）
 */
export function classificationReport(
  truth: (string | null)[],
  pred: (string | null)[],
): ClassificationReport {
  const total = truth.length
  if (!total) {
    return { perClass: [], macro: { precision: 0, recall: 0, f1: 0 }, micro: { precision: 0, recall: 0, f1: 0 }, accuracy: 0, total: 0 }
  }

  const labels = [...new Set([...truth, ...pred].filter((x): x is string => x !== null))].sort()
  const perClass: ClassMetric[] = labels.map((label) => {
    let tp = 0, fp = 0, fn = 0, support = 0
    for (let i = 0; i < total; i++) {
      const t = truth[i] === label
      const p = pred[i] === label
      if (t) support++
      if (t && p) tp++
      else if (!t && p) fp++
      else if (t && !p) fn++
    }
    const precision = tp + fp ? tp / (tp + fp) : 0
    const recall = tp + fn ? tp / (tp + fn) : 0
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0
    return { label, support, tp, fp, fn, precision, recall, f1 }
  })

  const macroOf = (f: (m: ClassMetric) => number) =>
    perClass.length ? perClass.reduce((a, m) => a + f(m), 0) / perClass.length : 0

  // 微平均：把各类的 tp/fp/fn 汇总再算（等价于按样本加权）
  const sumTp = perClass.reduce((a, m) => a + m.tp, 0)
  const sumFp = perClass.reduce((a, m) => a + m.fp, 0)
  const sumFn = perClass.reduce((a, m) => a + m.fn, 0)
  const microP = sumTp + sumFp ? sumTp / (sumTp + sumFp) : 0
  const microR = sumTp + sumFn ? sumTp / (sumTp + sumFn) : 0
  const microF1 = microP + microR ? (2 * microP * microR) / (microP + microR) : 0

  let correct = 0
  for (let i = 0; i < total; i++) if (truth[i] === pred[i]) correct++

  return {
    perClass,
    macro: { precision: macroOf((m) => m.precision), recall: macroOf((m) => m.recall), f1: macroOf((m) => m.f1) },
    micro: { precision: microP, recall: microR, f1: microF1 },
    accuracy: correct / total,
    total,
  }
}

// ===================== 多标签指标（如「商家痛点」）=====================

export interface MultiLabelReport {
  /** 完全匹配（预测集合 == 真实集合）的比例 —— 最严格 */
  subsetAccuracy: number
  /** 逐标签的 P/R/F1 */
  perLabel: ClassMetric[]
  macro: { precision: number; recall: number; f1: number }
  total: number
}

export function multiLabelReport(truth: string[][], pred: string[][]): MultiLabelReport {
  const total = truth.length
  if (!total) {
    return { subsetAccuracy: 0, perLabel: [], macro: { precision: 0, recall: 0, f1: 0 }, total: 0 }
  }
  const labels = [...new Set([...truth.flat(), ...pred.flat()])].sort()
  const perLabel: ClassMetric[] = labels.map((label) => {
    let tp = 0, fp = 0, fn = 0, support = 0
    for (let i = 0; i < total; i++) {
      const t = truth[i].includes(label)
      const p = pred[i].includes(label)
      if (t) support++
      if (t && p) tp++
      else if (!t && p) fp++
      else if (t && !p) fn++
    }
    const precision = tp + fp ? tp / (tp + fp) : 0
    const recall = tp + fn ? tp / (tp + fn) : 0
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0
    return { label, support, tp, fp, fn, precision, recall, f1 }
  })
  const subset = truth.filter((t, i) => sameSet(t, pred[i])).length
  const macroOf = (f: (m: ClassMetric) => number) =>
    perLabel.length ? perLabel.reduce((a, m) => a + f(m), 0) / perLabel.length : 0
  return {
    subsetAccuracy: subset / total,
    perLabel,
    macro: { precision: macroOf((m) => m.precision), recall: macroOf((m) => m.recall), f1: macroOf((m) => m.f1) },
    total,
  }
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sa = [...a].sort()
  const sb = [...b].sort()
  return sa.every((x, i) => x === sb[i])
}

// ===================== 一致性（Cohen's Kappa）=====================

export interface KappaResult {
  kappa: number
  /** 观察一致率 */
  observed: number
  /** 随机一致率 */
  expected: number
  /** 文字解读（Landis & Koch） */
  interpretation: string
  n: number
}

/**
 * Cohen's Kappa：两个标注者（这里是「人工」与「规则」）的一致性。
 *
 * 为什么不用准确率？因为准确率会被「类别不平衡」骗 —— 若 90% 的商家都是 P2，
 * 一个无脑全打 P2 的规则也能有 90% 准确率。Kappa 扣掉了「随机也能猜对」的部分，
 * 才是真实的一致性水平。
 *
 * 业务含义：**Kappa 高 = 新人用这套规则打标，能和老运营打出一致结果**，
 * 这才是「口径可交接、能力可规模化」的证据。
 */
export function cohensKappa(a: (string | null)[], b: (string | null)[]): KappaResult {
  const n = Math.min(a.length, b.length)
  if (!n) return { kappa: 0, observed: 0, expected: 0, interpretation: '无样本', n: 0 }

  const labels = [...new Set([...a, ...b].map((x) => x ?? '(无)'))]
  const key = (x: string | null) => x ?? '(无)'

  let agree = 0
  const countA = new Map<string, number>()
  const countB = new Map<string, number>()
  for (let i = 0; i < n; i++) {
    if (key(a[i]) === key(b[i])) agree++
    countA.set(key(a[i]), (countA.get(key(a[i])) ?? 0) + 1)
    countB.set(key(b[i]), (countB.get(key(b[i])) ?? 0) + 1)
  }
  const po = agree / n
  const pe = labels.reduce((acc, l) => acc + ((countA.get(l) ?? 0) / n) * ((countB.get(l) ?? 0) / n), 0)

  // pe = 1（双方都只用一个类别）时 Kappa 无定义：完全一致记 1，否则记 0
  const kappa = pe >= 1 ? (po >= 1 ? 1 : 0) : (po - pe) / (1 - pe)
  return { kappa, observed: po, expected: pe, interpretation: interpretKappa(kappa), n }
}

export function interpretKappa(k: number): string {
  if (k < 0.2) return '差（口径基本不可交接）'
  if (k < 0.4) return '一般'
  if (k < 0.6) return '中等'
  if (k < 0.8) return '好（口径可交接）'
  return '极好'
}

// ===================== 排序指标（优先跟进名单准不准）=====================

/** 优先级 → 相关性等级（用于 NDCG）。P0 最相关 */
export const PRIORITY_RELEVANCE: Record<string, number> = { p0: 3, p1: 2, p2: 1 }

/**
 * Precision@K：前 K 个里有多少是真正该优先的。
 * 业务含义：运营一天只能跟 5 家，名单前 5 名里错了几个。
 */
export function precisionAtK(rankedRelevance: number[], k: number, relevantAtLeast = 3): number {
  const top = rankedRelevance.slice(0, k)
  if (!top.length) return 0
  return top.filter((r) => r >= relevantAtLeast).length / top.length
}

/**
 * NDCG@K：考虑「排序位置」与「相关性等级」的排序质量。
 *
 * 为什么需要它：Precision@K 只关心「有没有」，不关心「排得对不对」。
 * 把 P0 排在第 1 位和排在第 5 位，对运营的价值完全不同 —— NDCG 能体现这个差别。
 */
export function ndcgAtK(rankedRelevance: number[], k: number): number {
  const dcg = (rels: number[]) =>
    rels.slice(0, k).reduce((acc, rel, i) => acc + (Math.pow(2, rel) - 1) / Math.log2(i + 2), 0)
  const ideal = [...rankedRelevance].sort((x, y) => y - x)
  const idcg = dcg(ideal)
  if (idcg === 0) return 0
  return dcg(rankedRelevance) / idcg
}

// ===================== 数据质量四维 ======================

export interface DataQualityMetrics {
  /** 完整度：非空字段占比 */
  completeness: number
  /** 准确度：1 - 异常值率（异常值已被清洗层置空） */
  accuracy: number
  /** 一致性：1 - 结构性问题率（列错位等） */
  consistency: number
  /** 唯一性：1 - 重复率 */
  uniqueness: number
  /** 综合分（四维等权） */
  overall: number
  /** 明细，便于定位是哪一维拖后腿 */
  detail: {
    filledCells: number
    totalCells: number
    outliers: number
    structuralIssues: number
    duplicates: number
    rows: number
  }
}

/**
 * 数据质量四维（对齐 DAMA 数据管理的数据质量维度，只取与业务相关的四项）。
 *
 * 为什么单列出来：**打标的上限由数据质量决定**。如果上游表有 30% 的比率列是空的，
 * 打标准确率再高也没意义（无米之炊）。把数据质量作为前置指标，才能定位
 * 「准确率低」到底是规则问题还是数据问题。
 */
export function dataQualityMetrics(input: {
  rows: number
  /** 有效记录数（清洗后） */
  validRows: number
  /** 字段完整度表（0~1） */
  completeness: Record<string, number>
  outliers: number
  structuralIssues: number
  duplicates: number
}): DataQualityMetrics {
  const { rows, completeness, outliers, structuralIssues, duplicates } = input
  const fields = Object.keys(completeness)
  const totalCells = Math.max(1, rows * Math.max(1, fields.length))
  const filledCells = Math.round(
    fields.reduce((acc, f) => acc + (completeness[f] ?? 0), 0) * rows,
  )

  const completenessScore = fields.length
    ? fields.reduce((a, f) => a + (completeness[f] ?? 0), 0) / fields.length
    : 0
  // 分母用「行 × 数值字段数」近似，避免行数为 0 时除零
  const accuracyScore = 1 - Math.min(1, outliers / Math.max(1, rows * 4))
  const consistencyScore = 1 - Math.min(1, structuralIssues / Math.max(1, rows))
  const uniquenessScore = 1 - Math.min(1, duplicates / Math.max(1, rows))

  const overall = (completenessScore + accuracyScore + consistencyScore + uniquenessScore) / 4
  return {
    completeness: round4(completenessScore),
    accuracy: round4(accuracyScore),
    consistency: round4(consistencyScore),
    uniqueness: round4(uniquenessScore),
    overall: round4(overall),
    detail: {
      filledCells,
      totalCells,
      outliers,
      structuralIssues,
      duplicates,
      rows,
    },
  }
}

// ===================== 工具 ======================

export function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}

/** 百分比展示 */
export function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`
}

/** 从一组指标里找出最弱的一项（用于给「下一步该改哪里」的建议） */
export function weakestOf<T extends Record<string, number>>(obj: T): { key: keyof T; value: number } | null {
  const entries = Object.entries(obj)
  if (!entries.length) return null
  const [key, value] = entries.reduce((min, cur) => (cur[1] < min[1] ? cur : min))
  return { key: key as keyof T, value }
}
