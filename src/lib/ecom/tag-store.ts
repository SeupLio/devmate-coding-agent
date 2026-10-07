/**
 * 电商服务商场景：打标纠错回流。
 *
 * 对应 JD 第 4 条：「参与 AI 工具……的测试和优化，**记录效果问题**并协助产品经理持续迭代」。
 *
 * ## 为什么这个模块是「从能用」到「越用越准」的关键
 *
 * 规则打标一定有错。如果错标只是被人工改掉、改完就没了，
 * 那么**同一个错误会一直犯下去**，规则永远不会进步。
 *
 * 这个模块做三件事：
 *   1. **记录**：运营改了哪个标签、从什么改成什么、为什么
 *   2. **归因**：统计**每条规则**的准确率，找出最常被纠错的规则
 *   3. **给依据**：输出「哪条规则该改、往哪改」的具体建议
 *
 * 这就是「协助产品经理持续迭代」的落地形态 ——
 * 不是凭感觉说「我觉得打标准确率还行」，而是有数据、有具体待改项。
 *
 * ## 诚实边界
 *
 * 准确率是**基于人工纠错样本**的估计，不是全量准确率：
 * 运营只会去改他注意到的错误（漏标通常不会被发现），
 * 所以这个数字**偏高**，应作为「相对排序依据」而不是绝对指标。
 * 这一点在输出里会明确标注。
 */
import type { Tag } from './tagging'

export interface TagCorrection {
  merchantId: string
  dimension: string
  /** 规则打出的标签（空串表示「规则没打，人工补上」= 漏标） */
  original: string
  /** 人工修正后的标签（空串表示「规则打错了，应删除」= 误标） */
  corrected: string
  /** 修正原因（可选，但强烈建议填） */
  reason?: string
  at: number
}

/** 纠错类型：误标 / 漏标 / 改值 */
export type CorrectionKind = 'false_positive' | 'false_negative' | 'value_change'

export function classifyCorrection(c: TagCorrection): CorrectionKind {
  if (!c.original && c.corrected) return 'false_negative' // 规则没打，人工补 → 漏标
  if (c.original && !c.corrected) return 'false_positive' // 规则打了，人工删 → 误标
  return 'value_change'
}

const KIND_LABEL: Record<CorrectionKind, string> = {
  false_positive: '误标',
  false_negative: '漏标',
  value_change: '改值',
}

/** 进程内存储（真实场景应落库；这里是可复用的最小实现） */
const corrections: TagCorrection[] = []
const CORRECTION_MAX = 5000

export function recordCorrection(c: Omit<TagCorrection, 'at'>): TagCorrection {
  const full: TagCorrection = { ...c, at: Date.now() }
  corrections.push(full)
  if (corrections.length > CORRECTION_MAX) corrections.shift()
  return full
}

export function listCorrections(limit = 200): TagCorrection[] {
  return corrections.slice(-limit)
}

export function clearCorrections(): void {
  corrections.length = 0
}

// ===================== 归因分析 =====================

export interface DimensionAccuracy {
  dimension: string
  /** 纠错总数 */
  corrections: number
  falsePositive: number
  falseNegative: number
  valueChange: number
  /** 最常被纠错的具体标签（原值） */
  topWrong: { value: string; count: number }[]
  /** 该维度的主要问题类型 */
  dominantKind: CorrectionKind
  /** 迭代建议 */
  advice: string
}

export interface AccuracyReport {
  total: number
  byDimension: DimensionAccuracy[]
  /** 最该优先修的问题（按纠错数排序） */
  topPriority: string
  /** ⚠️ 口径说明：这是基于人工纠错的估计，不是全量准确率 */
  caveat: string
}

const DIM_LABEL: Record<string, string> = {
  stage: '线索阶段', category: '商家类目', health: '经营健康度',
  scale: '商家规模', priority: '跟进优先级', pain_point: '商家痛点',
}

/**
 * 汇总纠错记录，输出「哪条规则最该改、怎么改」。
 * 这是给产品经理/运营看的迭代依据。
 */
export function analyzeCorrections(limit = 1000): AccuracyReport {
  const list = corrections.slice(-limit)
  const byDim = new Map<string, TagCorrection[]>()
  for (const c of list) {
    const arr = byDim.get(c.dimension) ?? []
    arr.push(c)
    byDim.set(c.dimension, arr)
  }

  const byDimension: DimensionAccuracy[] = [...byDim.entries()]
    .map(([dimension, items]) => {
      const counts = { false_positive: 0, false_negative: 0, value_change: 0 }
      const wrongCounter = new Map<string, number>()
      for (const c of items) {
        counts[classifyCorrection(c)]++
        const wrong = c.original || '(漏标)'
        wrongCounter.set(wrong, (wrongCounter.get(wrong) ?? 0) + 1)
      }
      const topWrong = [...wrongCounter.entries()]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 3)

      const dominantKind = (Object.entries(counts) as [CorrectionKind, number][])
        .sort((a, b) => b[1] - a[1])[0][0]

      const label = DIM_LABEL[dimension] ?? dimension
      const advice =
        dominantKind === 'false_negative'
          ? `「${label}」主要是**漏标**（规则没识别出来）→ 建议补充关键词/信号，或对无信号的记录走 LLM 兜底`
          : dominantKind === 'false_positive'
            ? `「${label}」主要是**误标**（规则过度触发）→ 建议收紧触发条件，或提高阈值`
            : `「${label}」主要是**改值**（标签选错了）→ 建议检查规则优先级与互斥逻辑`

      return {
        dimension, corrections: items.length,
        ...{ falsePositive: counts.false_positive, falseNegative: counts.false_negative, valueChange: counts.value_change },
        topWrong, dominantKind, advice,
      }
    })
    .sort((a, b) => b.corrections - a.corrections)

  const topPriority = byDimension.length
    ? `优先修「${DIM_LABEL[byDimension[0].dimension] ?? byDimension[0].dimension}」：` +
      `累计 ${byDimension[0].corrections} 次纠错，最常错的是「${byDimension[0].topWrong[0]?.value ?? '—'}」`
    : '暂无纠错记录，规则准确率无从估计'

  return {
    total: list.length,
    byDimension,
    topPriority,
    caveat:
      '⚠️ 口径说明：准确率基于**人工纠错样本**估计，不是全量准确率。' +
      '运营通常只会改他注意到的错误（漏标往往不会被发现），所以该数字**偏高**，' +
      '应作为「规则间相对排序」的依据，而不是绝对指标。',
  }
}

/** 渲染迭代报告 */
export function formatAccuracyReport(r: AccuracyReport): string {
  if (!r.total) return '暂无纠错记录。'
  const lines = [
    `打标规则迭代报告（基于 ${r.total} 条人工纠错）`,
    '='.repeat(52),
    '',
  ]
  for (const d of r.byDimension) {
    lines.push(
      `${(DIM_LABEL[d.dimension] ?? d.dimension).padEnd(12)} 纠错 ${String(d.corrections).padStart(3)} 次` +
      `  误标 ${d.falsePositive} / 漏标 ${d.falseNegative} / 改值 ${d.valueChange}`,
    )
    if (d.topWrong.length) {
      lines.push(`  ↳ 最常错：${d.topWrong.map((t) => `${t.value}(${t.count})`).join('、')}`)
    }
    lines.push(`  ↳ ${d.advice}`)
    lines.push('')
  }
  lines.push(`结论：${r.topPriority}`, '', r.caveat)
  return lines.join('\n')
}

/** 把纠错结果应用到标签上（供「修正后的标签」导出） */
export function applyCorrections(tags: Tag[], merchantId: string): Tag[] {
  const mine = corrections.filter((c) => c.merchantId === merchantId)
  if (!mine.length) return tags
  let out = [...tags]
  for (const c of mine) {
    const idx = out.findIndex((t) => t.dimension === c.dimension)
    if (!c.corrected) {
      // 误标 → 删除
      if (idx >= 0) out.splice(idx, 1)
      continue
    }
    if (idx >= 0) {
      out[idx] = { ...out[idx], value: c.corrected, confidence: 1, evidence: `人工修正${c.reason ? `：${c.reason}` : ''}`, needReview: false }
    } else {
      // 漏标 → 补上（人工确认过，置信度给 1）
      out.push({
        dimension: c.dimension, value: c.corrected, label: c.corrected,
        confidence: 1, evidence: `人工补充${c.reason ? `：${c.reason}` : ''}`, needReview: false,
      })
    }
  }
  return out
}
