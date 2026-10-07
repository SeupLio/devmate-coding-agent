/**
 * 电商服务商场景：数据清洗。
 *
 * 对应 JD 第 2 条：「业务数据、商家案例、服务商跟进记录……的**清洗、整理**、分类和打标」。
 * 注意 JD 把「清洗」放在了「打标」**之前** —— 这不是修辞，是真实工作流：
 * 从平台/数仓导出的数据是脏的，不清洗直接打标，标签全是错的。
 *
 * ## 真实数据有多脏（本模块要处理的）
 *
 * 从运营手工表 / 数仓导出里常见的情况：
 *  - **同一含义多种写法**：转化率可能是 `1.2%` / `0.012` / `1.2`（理解为百分数）
 *  - **千分位与货币符号**：`¥1,234,567` / `1234567元` / `123.4万`
 *  - **全角字符**：中文输入法打出的 `１．２％`、全角逗号
 *  - **空值五花八门**：空串 / `-` / `N/A` / `null` / `暂无`
 *  - **重复录入**：同一个商家被录了两次（id 不同但名字一样）
 *  - **物理上不可能的值**：退款率 150%、GMV 负数、转化率 > 100%
 *
 * ## 设计原则
 *
 * 1. **清洗要留痕**：每处修改都记进 `fixes`，运营能复核「你改了我什么」
 * 2. **异常值不静默丢弃**：标为 `outlier` 并**置空**，让下游走「数据不足」分支，
 *    而不是拿一个错误的值去算诊断 —— 错误的诊断比没有诊断更糟
 * 3. **不猜**：无法确定的字段宁可留空，不填默认值
 */
import type { MerchantRecord } from './tagging'

/** 原始输入值（CSV 解析出来基本都是字符串） */
export type RawValue = string | number | null | undefined

export interface RawMerchantRow {
  [key: string]: RawValue
}

/** 一处清洗动作（留痕，供运营复核） */
export interface CleaningFix {
  merchantId: string
  field: string
  from: string
  to: string
  reason: string
}

export interface DataQualityReport {
  totalRows: number
  /** 清洗后可用记录数 */
  validRows: number
  /** 字段完整度（0~1） */
  completeness: Record<string, number>
  /** 各字段缺失行数 */
  missing: Record<string, number>
  /** 检测到的异常值（已置空） */
  outliers: { merchantId: string; field: string; value: string; reason: string }[]
  /** 重复记录（被合并的 id） */
  duplicates: { kept: string; dropped: string; reason: string }[]
  /** 清洗动作总数 */
  fixCount: number
  /** 清洗后的数据质量评级 */
  grade: 'good' | 'fair' | 'poor'
  /** 给运营的行动建议 */
  advice: string[]
}

export interface CleaningResult {
  records: MerchantRecord[]
  report: DataQualityReport
  fixes: CleaningFix[]
}

// ===================== 字段标准化 =====================

/** 视为「空」的字符串（真实数据里空值写法五花八门） */
const NULLISH = new Set(['', '-', '--', 'n/a', 'na', 'null', 'none', '暂无', '无', '未知', '/'])

export function isNullish(v: RawValue): boolean {
  if (v === null || v === undefined) return true
  if (typeof v === 'number') return Number.isNaN(v)
  return NULLISH.has(v.trim().toLowerCase())
}

/** 全角 → 半角（中文输入法常见） */
export function toHalfWidth(s: string): string {
  return s.replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
}

/**
 * 把各种写法的数值解析成 number。
 *
 * 支持：`1.2%` / `1,234` / `¥1,234.5` / `123.4万` / `1.2亿` / `１２３`（全角）
 * 返回 null 表示「无法解析」（不猜）。
 */
export function parseNumber(raw: RawValue): number | null {
  if (typeof raw === 'number') return Number.isNaN(raw) ? null : raw
  if (isNullish(raw)) return null
  let s = toHalfWidth(String(raw).trim())

  // 先判断是不是百分数，再把 % 本身去掉 ——
  // ⚠️ 这里踩过坑：原来只置了 isPercent 却忘了删掉 '%'，
  // 于是 Number('6%') = NaN，所有带百分号的字段全部解析失败（完整度直接变 0）。
  const isPercent = /%|％/.test(s)
  s = s.replace(/[¥￥$,\s元人民币]/g, '').replace(/[%％]/g, '')

  // 中文数量单位
  let multiplier = 1
  if (/万/.test(s)) multiplier = 10_000
  else if (/亿/.test(s)) multiplier = 100_000_000
  s = s.replace(/[万亿]/g, '')

  if (!s) return null
  const n = Number(s)
  if (!Number.isFinite(n)) return null
  const value = n * multiplier
  // `1.2%` → 0.012（百分比统一成小数）
  return isPercent ? value / 100 : value
}

/** 解析「率」类字段：把 `1.2%` / `1.2` / `0.012` 统一成小数 0.012 */
export function parseRate(raw: RawValue): number | null {
  if (typeof raw === 'number') {
    // 数字形态：> 1 视为百分数写法（如 1.2 表示 1.2%）
    if (Number.isNaN(raw)) return null
    return raw > 1 ? raw / 100 : raw
  }
  if (isNullish(raw)) return null
  const s = toHalfWidth(String(raw).trim())
  const n = parseNumber(s)
  if (n === null) return null
  // 带 % 的已经被 parseNumber 除过 100
  if (/%|％/.test(s)) return n
  return n > 1 ? n / 100 : n
}

/** 文本规范化：全角转半角、压掉多余空白 */
export function normalizeText(raw: RawValue): string | undefined {
  if (isNullish(raw)) return undefined
  const s = toHalfWidth(String(raw)).replace(/\s+/g, ' ').trim()
  return s || undefined
}

// ===================== 表头别名映射 =====================

/**
 * 中英文表头 → 标准字段名。
 * 真实导出表的列名千奇百怪，这里做一次归一，避免下游到处写兼容逻辑。
 */
const FIELD_ALIASES: Record<string, string> = {
  // id
  id: 'id', 商家id: 'id', 商家编号: 'id', merchant_id: 'id', merchantid: 'id', 店铺id: 'id',
  // 名称
  name: 'name', 商家名称: 'name', 商家名: 'name', 店铺名称: 'name', 店铺名: 'name', merchant_name: 'name', shop_name: 'name',
  // GMV
  monthlygmv: 'monthlyGmv', gmv: 'monthlyGmv', 月gmv: 'monthlyGmv', 月GMV: 'monthlyGmv',
  月销售额: 'monthlyGmv', 月成交额: 'monthlyGmv', 近30天gmv: 'monthlyGmv',
  // 转化率
  conversionrate: 'conversionRate', 转化率: 'conversionRate', 支付转化率: 'conversionRate', cvr: 'conversionRate',
  // 退款率
  refundrate: 'refundRate', 退款率: 'refundRate', 退货率: 'refundRate',
  // 响应时长
  avgresponsesec: 'avgResponseSec', 响应时长: 'avgResponseSec', 客服响应时长: 'avgResponseSec',
  平均响应时长: 'avgResponseSec', 响应秒数: 'avgResponseSec',
  // 流量
  traffic: 'traffic', 进店量: 'traffic', 访客数: 'traffic', uv: 'traffic', 月进店量: 'traffic',
  // 备注
  note: 'note', 备注: 'note', 跟进记录: 'note', 跟进备注: 'note', 沟通记录: 'note',
  // 阶段
  stage: 'stage', 阶段: 'stage', 线索阶段: 'stage', 跟进阶段: 'stage',
}

/** 把一行原始数据的列名映射成标准字段名 */
export function mapColumns(row: RawMerchantRow): RawMerchantRow {
  const out: RawMerchantRow = {}
  for (const [k, v] of Object.entries(row)) {
    const key = toHalfWidth(k.trim()).toLowerCase().replace(/\s+/g, '')
    const std = FIELD_ALIASES[key] ?? FIELD_ALIASES[toHalfWidth(k.trim())] ?? k.trim()
    out[std] = v
  }
  return out
}

// ===================== 异常值检测 =====================

/** 字段的物理合法范围（超出即异常） */
const RANGES: { field: string; label: string; min?: number; max?: number; hint: string }[] = [
  { field: 'monthlyGmv', label: '月GMV', min: 0, hint: 'GMV 不应为负' },
  { field: 'conversionRate', label: '转化率', min: 0, max: 1, hint: '转化率应在 0~100% 之间' },
  { field: 'refundRate', label: '退款率', min: 0, max: 1, hint: '退款率应在 0~100% 之间' },
  { field: 'avgResponseSec', label: '响应时长', min: 0, max: 86_400, hint: '响应时长超过 24 小时，疑似录入错误' },
  { field: 'traffic', label: '进店量', min: 0, hint: '进店量不应为负' },
]

// ===================== 主流程 =====================

/** 展示用数值格式化：避免留痕里出现 0.018000000000000002 这种浮点噪声 */
function fmtNum(n: number): string {
  return String(Math.round(n * 1e6) / 1e6)
}

/** 一行原始数据 → 清洗后的记录（含留痕） */
export function cleanRow(row: RawMerchantRow, fixes: CleaningFix[]): { record: MerchantRecord; outliers: DataQualityReport['outliers'] } {
  const mapped = mapColumns(row)
  const outliers: DataQualityReport['outliers'] = []

  const id = normalizeText(mapped.id) ?? normalizeText(mapped.name) ?? `row_${fixes.length}`
  const name = normalizeText(mapped.name)
  const note = normalizeText(mapped.note)
  const stage = normalizeText(mapped.stage)

  const num = (field: string, raw: RawValue, parser: (r: RawValue) => number | null): number | undefined => {
    if (isNullish(raw)) return undefined
    const parsed = parser(raw)
    if (parsed === null) {
      fixes.push({ merchantId: id, field, from: String(raw), to: '(空)', reason: '无法解析为数值，置空' })
      return undefined
    }
    // 范围校验：超范围不静默采用，标异常并置空
    const range = RANGES.find((r) => r.field === field)
    if (range && ((range.min !== undefined && parsed < range.min) || (range.max !== undefined && parsed > range.max))) {
      outliers.push({ merchantId: id, field, value: String(raw), reason: range.hint })
      fixes.push({ merchantId: id, field, from: String(raw), to: '(空)', reason: `${range.hint}，已置空` })
      return undefined
    }
    if (String(raw) !== fmtNum(parsed)) {
      fixes.push({ merchantId: id, field, from: String(raw), to: fmtNum(parsed), reason: '数值标准化' })
    }
    return parsed
  }

  const record: MerchantRecord = {
    id,
    name,
    note,
    stage,
    monthlyGmv: num('monthlyGmv', mapped.monthlyGmv, parseNumber),
    conversionRate: num('conversionRate', mapped.conversionRate, parseRate),
    refundRate: num('refundRate', mapped.refundRate, parseRate),
    avgResponseSec: num('avgResponseSec', mapped.avgResponseSec, parseNumber),
    traffic: num('traffic', mapped.traffic, parseNumber),
  }

  // 清理 undefined 字段，保持记录干净
  for (const k of Object.keys(record) as (keyof MerchantRecord)[]) {
    if (record[k] === undefined) delete record[k]
  }

  return { record, outliers }
}

/**
 * 去重：优先按 id，其次按「名称完全相同」。
 * 保留**字段更完整**的那条（信息量更大），另一条记为被合并。
 */
export function dedupe(records: MerchantRecord[]): { kept: MerchantRecord[]; dropped: DataQualityReport['duplicates'] } {
  const dropped: DataQualityReport['duplicates'] = []
  const byKey = new Map<string, MerchantRecord>()
  const completeness = (r: MerchantRecord) => Object.keys(r).length

  for (const rec of records) {
    const key = rec.name ? `name:${rec.name}` : `id:${rec.id}`
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, rec)
      continue
    }
    // 保留字段更多的
    const keepNew = completeness(rec) > completeness(existing)
    const keptRec = keepNew ? rec : existing
    const dropRec = keepNew ? existing : rec
    byKey.set(key, keptRec)
    dropped.push({ kept: keptRec.id, dropped: dropRec.id, reason: `同名「${rec.name ?? key}」，保留字段更完整的一条` })
  }

  return { kept: [...byKey.values()], dropped }
}

/** 计算字段完整度 */
export function computeCompleteness(records: MerchantRecord[]): {
  completeness: Record<string, number>
  missing: Record<string, number>
} {
  const fields = ['name', 'monthlyGmv', 'conversionRate', 'refundRate', 'avgResponseSec', 'traffic', 'note', 'stage']
  const completeness: Record<string, number> = {}
  const missing: Record<string, number> = {}
  const n = records.length || 1
  for (const f of fields) {
    const present = records.filter((r) => (r as unknown as Record<string, unknown>)[f] !== undefined).length
    completeness[f] = Math.round((present / n) * 100) / 100
    missing[f] = records.length - present
  }
  return { completeness, missing }
}

/** 数据质量评级 + 行动建议 */
export function gradeQuality(report: Omit<DataQualityReport, 'grade' | 'advice'>): {
  grade: DataQualityReport['grade']
  advice: string[]
} {
  const advice: string[] = []
  // 关键经营指标的完整度决定能否做诊断
  const keyFields = ['conversionRate', 'refundRate', 'avgResponseSec', 'traffic']
  const keyCompleteness = keyFields.reduce((a, f) => a + (report.completeness[f] ?? 0), 0) / keyFields.length

  for (const f of keyFields) {
    const c = report.completeness[f] ?? 0
    if (c < 0.5) advice.push(`「${f}」缺失率过高（完整度 ${(c * 100).toFixed(0)}%），建议补齐后再做经营诊断`)
  }
  if (report.outliers.length) {
    advice.push(`发现 ${report.outliers.length} 处异常值（已置空），建议核对源数据录入`)
  }
  if (report.duplicates.length) {
    advice.push(`发现 ${report.duplicates.length} 条重复记录（已合并），建议在录入侧加唯一性校验`)
  }
  if (!advice.length) advice.push('数据质量良好，可直接进入打标与诊断')

  const grade = keyCompleteness >= 0.8 && report.outliers.length <= report.totalRows * 0.1
    ? 'good'
    : keyCompleteness >= 0.5
      ? 'fair'
      : 'poor'
  return { grade, advice }
}

/** 主入口：清洗一批原始数据 */
export function cleanRecords(rows: RawMerchantRow[]): CleaningResult {
  const fixes: CleaningFix[] = []
  const outliers: DataQualityReport['outliers'] = []
  const cleaned: MerchantRecord[] = []

  for (const row of rows) {
    const { record, outliers: o } = cleanRow(row, fixes)
    outliers.push(...o)
    cleaned.push(record)
  }

  const { kept, dropped } = dedupe(cleaned)
  const { completeness, missing } = computeCompleteness(kept)

  const partial: Omit<DataQualityReport, 'grade' | 'advice'> = {
    totalRows: rows.length,
    validRows: kept.length,
    completeness,
    missing,
    outliers,
    duplicates: dropped,
    fixCount: fixes.length,
  }
  const { grade, advice } = gradeQuality(partial)

  return { records: kept, report: { ...partial, grade, advice }, fixes }
}

/** 渲染质量报告（给运营看的形态） */
export function formatQualityReport(r: DataQualityReport): string {
  const gradeLabel = { good: '良好', fair: '一般', poor: '较差' }[r.grade]
  const lines = [
    `数据质量报告｜${r.totalRows} 行 → 清洗后 ${r.validRows} 条有效记录｜评级：${gradeLabel}`,
    `清洗动作 ${r.fixCount} 处｜异常值 ${r.outliers.length} 处｜重复 ${r.duplicates.length} 条`,
    '',
    '字段完整度：',
  ]
  for (const [f, c] of Object.entries(r.completeness)) {
    const bar = '█'.repeat(Math.round(c * 20))
    lines.push(`  ${f.padEnd(16)} ${(c * 100).toFixed(0).padStart(3)}%  ${bar}`)
  }
  if (r.outliers.length) {
    lines.push('', '异常值（已置空）：')
    for (const o of r.outliers.slice(0, 5)) lines.push(`  ${o.merchantId}.${o.field} = ${o.value} — ${o.reason}`)
  }
  lines.push('', '建议：')
  for (const a of r.advice) lines.push(`  · ${a}`)
  return lines.join('\n')
}
