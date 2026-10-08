/**
 * 电商场景：评测引擎（跑金标准 → 出指标报告）+ 阈值校准。
 *
 * ## 这个文件回答的问题
 *
 * 「这套打标/诊断到底有多准？」—— 之前这个问题无法回答（没有 ground truth），
 * 现在可以给出：各维度 P/R/F1、Kappa、排序质量、以及**哪个维度最弱、该怎么改**。
 *
 * ## 评测设计上的三个刻意选择
 *
 * 1. **Kappa 与 F1 都报**：F1 看「打得准不准」，Kappa 看「口径能不能交接」。
 *    两者都低 → 规则本身有问题；F1 高但 Kappa 低 → 规则在某些类别上系统性偏移。
 * 2. **有争议样本单独统计**：`contested` 的样本不计入主指标（见 golden.ts），
 *    否则「口径分歧」会被伪装成「规则错误」，掩盖真正需要讨论的问题。
 * 3. **报排序指标而非只报分类指标**：运营真正消费的是「今日优先跟进名单」，
 *    名单前几名准不准（P@K / NDCG）比「全体分类准确率」更贴近业务价值。
 */
import { GOLDEN_SET, goldenCoverage, type GoldenCase, type GoldenDimension } from './golden'
import {
  PRIORITY_RELEVANCE, classificationReport, cohensKappa, multiLabelReport, ndcgAtK, pct, precisionAtK, round4,
} from './metrics'
import { DEFAULT_THRESHOLDS, cloneThresholds, type EcomThresholds } from './thresholds'
import { tagMerchant, type MerchantRecord, type TaggingResult } from './tagging'
import { diagnose } from './diagnosis'

export const SINGLE_LABEL_DIMS: GoldenDimension[] = ['stage', 'category', 'scale', 'health', 'priority']

export interface DimensionEval {
  dimension: GoldenDimension
  kind: 'single' | 'multi'
  /** 单标签：总体准确率；多标签：完全匹配率 */
  accuracy: number
  macroF1: number
  kappa: number
  kappaInterpretation: string
  /** 最弱类别（precision 或 recall 最低），用于定位 */
  weakestLabel: { label: string; f1: number } | null
  detail: string
}

export interface Mismatch {
  id: string
  dimension: GoldenDimension
  expected: string
  predicted: string
  rationale: string
  contested: boolean
}

export interface RankingEval {
  /**
   * 前 3 名里有多少是真该优先的（运营一天只跟得动几家）。
   * `null` = 该样本集中没有任何「真该优先（P0）」的样本，此时 P@3 无意义 ——
   * 报 0% 会让人误以为「系统全错」，实际是分母为 0。
   */
  precisionAt3: number | null
  /** 前 5 名的排序质量（考虑顺序） */
  ndcgAt5: number
  /** 全体排序质量 */
  ndcgAll: number
  n: number
}

export interface TaggingEval {
  n: number
  /** 有争议样本数（不计入主指标） */
  contested: number
  dimensions: DimensionEval[]
  /** 主指标：单标签维度的宏平均 F1 */
  overallMacroF1: number
  /** 主指标：单标签维度的平均 Kappa */
  overallKappa: number
  mismatches: Mismatch[]
  ranking: RankingEval
  coverage: Record<GoldenDimension, Record<string, number>>
}

/** 取某维度的预测值（pain_point 为多值） */
function predict(res: TaggingResult, dim: GoldenDimension): string | null | string[] {
  if (dim === 'pain_point') {
    return res.tags.filter((t) => t.dimension === 'pain_point').map((t) => t.value).sort()
  }
  return res.tags.find((t) => t.dimension === dim)?.value ?? null
}

function expectOf(c: GoldenCase, dim: GoldenDimension): string | null | string[] {
  return c.expected[dim]
}

/** 跑一遍打标评测 */
export function evaluateTagging(t: EcomThresholds = DEFAULT_THRESHOLDS, cases: GoldenCase[] = GOLDEN_SET): TaggingEval {
  const scored = cases.filter((c) => !c.contested)
  const results = new Map<string, TaggingResult>()
  for (const c of cases) results.set(c.id, tagMerchant(c.record, t))

  const dimensions: DimensionEval[] = []
  const mismatches: Mismatch[] = []

  for (const dim of SINGLE_LABEL_DIMS) {
    const truth = scored.map((c) => expectOf(c, dim) as string | null)
    const pred = scored.map((c) => predict(results.get(c.id)!, dim) as string | null)
    const rep = classificationReport(truth, pred)
    const k = cohensKappa(truth, pred)
    const weakest = rep.perClass.length
      ? rep.perClass.reduce((min, m) => (m.f1 < min.f1 ? m : min))
      : null
    dimensions.push({
      dimension: dim,
      kind: 'single',
      accuracy: round4(rep.accuracy),
      macroF1: round4(rep.macro.f1),
      kappa: round4(k.kappa),
      kappaInterpretation: k.interpretation,
      weakestLabel: weakest ? { label: weakest.label, f1: round4(weakest.f1) } : null,
      detail: `准确率 ${pct(rep.accuracy)}｜宏 F1 ${pct(rep.macro.f1)}｜微 F1 ${pct(rep.micro.f1)}｜Kappa ${k.kappa.toFixed(2)}（${k.interpretation}）`,
    })
    for (let i = 0; i < scored.length; i++) {
      if (truth[i] !== pred[i]) {
        mismatches.push({
          id: scored[i].id,
          dimension: dim,
          expected: truth[i] ?? '(不打标)',
          predicted: pred[i] ?? '(未打标)',
          rationale: scored[i].rationale,
          contested: false,
        })
      }
    }
  }

  // 多标签：痛点
  {
    const truth = scored.map((c) => expectOf(c, 'pain_point') as string[])
    const pred = scored.map((c) => predict(results.get(c.id)!, 'pain_point') as string[])
    const rep = multiLabelReport(truth, pred)
    // 多标签用「集合完全一致」当作单标签对位，便于算 Kappa
    const k = cohensKappa(
      truth.map((x) => x.join('+') || '(无)'),
      pred.map((x) => x.join('+') || '(无)'),
    )
    const weakest = rep.perLabel.length
      ? rep.perLabel.reduce((min, m) => (m.f1 < min.f1 ? m : min))
      : null
    dimensions.push({
      dimension: 'pain_point',
      kind: 'multi',
      accuracy: round4(rep.subsetAccuracy),
      macroF1: round4(rep.macro.f1),
      kappa: round4(k.kappa),
      kappaInterpretation: k.interpretation,
      weakestLabel: weakest ? { label: weakest.label, f1: round4(weakest.f1) } : null,
      detail: `完全匹配率 ${pct(rep.subsetAccuracy)}｜宏 F1 ${pct(rep.macro.f1)}｜Kappa ${k.kappa.toFixed(2)}（${k.interpretation}）`,
    })
    for (let i = 0; i < scored.length; i++) {
      const same = truth[i].length === pred[i].length && [...truth[i]].sort().every((x, j) => x === [...pred[i]].sort()[j])
      if (!same) {
        mismatches.push({
          id: scored[i].id,
          dimension: 'pain_point',
          expected: truth[i].join('、') || '(不打标)',
          predicted: pred[i].join('、') || '(未打标)',
          rationale: scored[i].rationale,
          contested: false,
        })
      }
    }
  }

  // 排序质量：把「系统认为该先跟的」排在前面，看真该先跟的是否在前面
  const ranking = evaluateRanking(scored, results)

  const singles = dimensions.filter((d) => d.kind === 'single')
  const overallMacroF1 = singles.length ? round4(singles.reduce((a, d) => a + d.macroF1, 0) / singles.length) : 0
  const overallKappa = singles.length ? round4(singles.reduce((a, d) => a + d.kappa, 0) / singles.length) : 0

  return {
    n: scored.length,
    contested: cases.length - scored.length,
    dimensions,
    overallMacroF1,
    overallKappa,
    mismatches,
    ranking,
    coverage: goldenCoverage(),
  }
}

/**
 * 排序评测：模拟「系统给出的今日跟进顺序」。
 * 排序键 = 预测优先级（p0 优先），同优先级按诊断健康分升序（越差越靠前）。
 */
export function evaluateRanking(
  scored: GoldenCase[],
  results: Map<string, TaggingResult>,
): RankingEval {
  const rows = scored.map((c) => {
    const res = results.get(c.id)!
    const predPriority = (res.tags.find((x) => x.dimension === 'priority')?.value ?? 'p2') as string
    const score = diagnose(c.record).score
    return {
      // 系统排序：优先级降序，同优先级按健康分升序
      sortKey: (3 - (PRIORITY_RELEVANCE[predPriority] ?? 1)) * 1000 + score,
      /** 真实相关性（人工标注的优先级） */
      relevance: PRIORITY_RELEVANCE[c.expected.priority ?? 'p2'] ?? 1,
    }
  })
  rows.sort((a, b) => a.sortKey - b.sortKey)
  const ranked = rows.map((r) => r.relevance)
  // 样本集中若无任何 P0（relevance=3），P@3 的分母为 0 → 返回 null 而不是 0
  const hasRelevant = rows.some((r) => r.relevance >= 3)
  return {
    precisionAt3: hasRelevant ? round4(precisionAtK(ranked, 3)) : null,
    ndcgAt5: round4(ndcgAtK(ranked, 5)),
    ndcgAll: round4(ndcgAtK(ranked, ranked.length)),
    n: rows.length,
  }
}

/** 渲染评测报告 */
export function formatTaggingEval(r: TaggingEval): string {
  const lines: string[] = []
  lines.push('电商打标评测报告')
  lines.push('='.repeat(64))
  lines.push(`样本：${r.n} 条（另有 ${r.contested} 条口径争议样本，不计入主指标）`)
  lines.push('')
  lines.push('各维度指标：')
  const w = Math.max(...r.dimensions.map((d) => d.dimension.length))
  for (const d of r.dimensions) {
    lines.push(`  ${d.dimension.padEnd(w + 2)} ${d.detail}`)
    if (d.weakestLabel) lines.push(`  ${' '.repeat(w + 2)} ↳ 最弱类别：${d.weakestLabel.label}（F1 ${pct(d.weakestLabel.f1)}）`)
  }
  lines.push('')
  const multi = r.dimensions.filter((d) => d.kind === 'multi')
  lines.push(`主指标｜单标签宏平均 F1：${pct(r.overallMacroF1)}　平均 Kappa：${r.overallKappa.toFixed(2)}`)
  if (multi.length) {
    lines.push(`多标签（可多选维度）宏 F1：${multi.map((d) => `${d.dimension} ${pct(d.macroF1)}`).join('　')}`)
  }
  lines.push('')
  lines.push('排序质量（运营真正消费的是「今日优先名单」）：')
  const p3 = r.ranking.precisionAt3 === null
    ? 'N/A（该样本集中无 P0 样本，分母为 0）'
    : pct(r.ranking.precisionAt3)
  lines.push(`  前 3 名精确率 P@3：${p3}`)
  lines.push(`  前 5 名 NDCG@5：${pct(r.ranking.ndcgAt5)}　全体 NDCG：${pct(r.ranking.ndcgAll)}`)
  lines.push('')

  if (r.mismatches.length) {
    lines.push(`逐条差异（${r.mismatches.length} 处）：`)
    for (const m of r.mismatches) {
      lines.push(`  ✗ ${m.id} [${m.dimension}] 人工=${m.expected} / 规则=${m.predicted}`)
    }
    lines.push('')
  } else {
    lines.push('逐条差异：无（全部与人工标注一致）')
    lines.push('')
  }

  // 结论：最弱维度 + 下一步
  const weakest = r.dimensions.reduce((min, d) => (d.macroF1 < min.macroF1 ? d : min))
  lines.push('结论：')
  lines.push(`  · 最弱维度是「${weakest.dimension}」（宏 F1 ${pct(weakest.macroF1)}）→ 优先改进这里`)
  if (weakest.weakestLabel) {
    lines.push(`  · 该维度最弱类别是「${weakest.weakestLabel.label}」（F1 ${pct(weakest.weakestLabel.f1)}）`)
  }
  lines.push(`  · 口径可交接性：平均 Kappa ${r.overallKappa.toFixed(2)}（${r.overallKappa >= 0.6 ? '好' : r.overallKappa >= 0.4 ? '中等' : '偏低'}）`)
  return lines.join('\n')
}

// ===================== 阈值校准 =====================

export interface CalibrationResult {
  baseline: { macroF1: number; kappa: number }
  best: { macroF1: number; kappa: number; thresholds: EcomThresholds }
  /** 搜索过的组合数 */
  tried: number
  /** 提升幅度（宏 F1） */
  gain: number
  /** 是否达到「值得改线上阈值」的程度 */
  significant: boolean
  /** 诚实提示 */
  caveat: string
}

/** 校准目标：阈值敏感的三个维度的宏平均 F1 */
function objective(t: EcomThresholds, cases: GoldenCase[]): { macroF1: number; kappa: number } {
  const r = evaluateTagging(t, cases)
  const sensitive = r.dimensions.filter((d) => ['scale', 'health', 'priority'].includes(d.dimension))
  const macroF1 = sensitive.length ? sensitive.reduce((a, d) => a + d.macroF1, 0) / sensitive.length : 0
  return { macroF1: round4(macroF1), kappa: r.overallKappa }
}

/**
 * 网格搜索校准阈值。
 *
 * ⚠️ **诚实提示（很重要）**：样本量只有 24 条，而待调参数有 5~6 个。
 * 在这个规模上做网格搜索**很容易过拟合** —— 很可能只是把阈值调到恰好匹配这 24 条，
 * 换一批数据反而更差。所以本函数会判断提升幅度：
 *  - 提升 < 0.05 → 判为「未达显著」，**建议不要据此改线上阈值**
 *  - 提升 ≥ 0.05 → 仍需在更大样本上复验
 * 这个「校准本身也可能不可靠」的自觉，比多调几个参数重要。
 */
export function calibrate(
  cases: GoldenCase[] = GOLDEN_SET,
  baseline: EcomThresholds = DEFAULT_THRESHOLDS,
): CalibrationResult {
  const base = objective(baseline, cases)

  const convCrit = [0.015, 0.018, 0.02, 0.022]
  const refundCrit = [0.08, 0.1, 0.12, 0.15]
  const respCrit = [45, 60, 90, 120]
  const trafficCrit = [300, 500, 800, 1000]
  const scaleKa = [400_000, 500_000, 600_000]
  const scaleMid = [80_000, 100_000, 120_000]

  let best = { macroF1: -1, kappa: 0, thresholds: cloneThresholds(baseline) }
  let tried = 0

  for (const c of convCrit) {
    for (const rf of refundCrit) {
      for (const rs of respCrit) {
        for (const tf of trafficCrit) {
          for (const ka of scaleKa) {
            for (const mid of scaleMid) {
              if (mid >= ka) continue
              const t = cloneThresholds(baseline)
              t.metrics.conversionRate.critical = c
              t.metrics.refundRate.critical = rf
              t.metrics.avgResponseSec.critical = rs
              t.metrics.traffic.critical = tf
              t.scale.ka = ka
              t.scale.mid = mid
              tried++
              const o = objective(t, cases)
              // 先看 F1，再看 Kappa（同分时选一致性更高的）
              if (o.macroF1 > best.macroF1 || (o.macroF1 === best.macroF1 && o.kappa > best.kappa)) {
                best = { macroF1: o.macroF1, kappa: o.kappa, thresholds: t }
              }
            }
          }
        }
      }
    }
  }

  const gain = round4(best.macroF1 - base.macroF1)
  const significant = gain >= 0.05
  return {
    baseline: base,
    best,
    tried,
    gain,
    significant,
    caveat: significant
      ? `提升 ${pct(gain)} 达显著线，但仍需在更大样本（n≥100）上复验后再改线上阈值。`
      : `提升仅 ${pct(Math.max(0, gain))}，**未达显著**（样本 n=${cases.length} 而待调参数 6 个，搜索空间极易过拟合）。` +
        '结论：默认口径已接近该样本上的最优，不建议据此修改线上阈值。',
  }
}

/** 渲染校准报告 */
export function formatCalibration(r: CalibrationResult): string {
  const lines: string[] = []
  lines.push('阈值校准报告（网格搜索）')
  lines.push('='.repeat(64))
  lines.push(`搜索组合数：${r.tried}`)
  lines.push(`基线（默认口径）：宏 F1 ${pct(r.baseline.macroF1)}　Kappa ${r.baseline.kappa.toFixed(2)}`)
  lines.push(`最优（搜索得到）：宏 F1 ${pct(r.best.macroF1)}　Kappa ${r.best.kappa.toFixed(2)}`)
  lines.push(`提升：${pct(r.gain)}　→ ${r.significant ? '达显著线' : '**未达显著**'}`)
  lines.push('')
  lines.push('⚠️ ' + r.caveat)
  if (r.significant) {
    const t = r.best.thresholds
    lines.push('')
    lines.push('搜索到的最优阈值（仅供参考，不要直接上线）：')
    lines.push(`  转化率严重线 ${pct(t.metrics.conversionRate.critical)}　退款率严重线 ${pct(t.metrics.refundRate.critical)}` +
      `　响应严重线 ${t.metrics.avgResponseSec.critical}s　进店严重线 ${t.metrics.traffic.critical}`)
    lines.push(`  规模 KA ≥ ${t.scale.ka}　腰部 ≥ ${t.scale.mid}`)
  }
  return lines.join('\n')
}

/** 供外部（CLI/API）复用的「跑一遍全部评测」入口 */
export function runFullEval(t: EcomThresholds = DEFAULT_THRESHOLDS): { tagging: TaggingEval; calibration: CalibrationResult } {
  return { tagging: evaluateTagging(t), calibration: calibrate(GOLDEN_SET, t) }
}

export type { MerchantRecord }
