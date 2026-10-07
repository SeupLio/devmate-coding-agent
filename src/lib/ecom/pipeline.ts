/**
 * 电商服务商场景：CSV 导入 / 导出 + 全链路 pipeline。
 *
 * 对应 JD 第 2 条（数据清洗的**输入端**）与真实工作流：
 * 服务商手里的数据不是 API，是**从平台后台/数仓导出的 CSV/Excel**。
 * 一个工具如果不能吃 CSV，在真实场景里就没法用。
 *
 * ## CSV 解析为什么要自己写
 *
 * 真实导出的 CSV 有一堆坑，标准 split(',') 全都会踩：
 *  - 字段里有逗号（`"某某公司, 分公司"`）
 *  - 字段里有换行（跟进记录常常是多行）
 *  - 引号转义（`""` 表示一个 `"`）
 *  - **BOM 头**（Excel 存 UTF-8 CSV 会加 `\ufeff`，不去掉第一列名就匹配不上）
 *  - CRLF / LF 混用
 *
 * ## pipeline 的价值
 *
 * 把「导入 → 清洗 → 打标 → 诊断 → 导出」串成一条链路，
 * 让运营**一条命令**从原始表拿到可执行的任务清单。
 * 这是从「能演示」到「能上手用」的关键一步。
 */
import type { MerchantRecord } from './tagging'
import { cleanRecords, type RawMerchantRow, type CleaningResult } from './cleaning'
import { tagMerchant, type Tag } from './tagging'
import { diagnose, type DiagnosisReport } from './diagnosis'

// ===================== CSV 解析 =====================

/** 去掉 BOM（Excel 存 UTF-8 CSV 必带，不去掉第一列列名匹配不上） */
export function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
}

/**
 * 解析 CSV 文本为对象数组。
 * 手写状态机处理引号/逗号/换行，不依赖第三方库。
 */
export function parseCsv(text: string): RawMerchantRow[] {
  return parseCsvWithIssues(text).rows
}

export interface StructuralIssue {
  /** 行号（1-based，含表头，方便运营回 Excel 定位） */
  line: number
  expected: number
  actual: number
  /** 该行的前几个字段预览，便于快速定位 */
  preview: string
}

/**
 * 解析 CSV 并**报告结构性问题**。
 *
 * ⚠️ 为什么需要这个：如果某行的字段数与表头不一致，说明该行很可能有
 * **未加引号的逗号**（如 `¥220,000` 没加引号会被拆成两列）。
 * 后果是**从该列起全部错位**，而解析器不会报错 —— 数据静默变脏。
 *
 * 这比"解析失败"更危险：解析失败你能发现，静默错位你会拿着错误的数据做决策。
 * 所以这里显式检出并交给运营核对，而不是假装没事。
 */
export function parseCsvWithIssues(text: string): { rows: RawMerchantRow[]; issues: StructuralIssue[] } {
  const src = stripBom(text)
  const rawRows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let line = 1
  const rowLines: number[] = []

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++ }
        else inQuotes = false
      } else {
        field += ch
        if (ch === '\n') line++
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(field); field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some((c) => c.trim() !== '')) {
        rawRows.push(row)
        rowLines.push(line)
      }
      line++
      row = []
    } else {
      field += ch
    }
  }
  if (field !== '' || row.length) {
    row.push(field)
    if (row.some((c) => c.trim() !== '')) {
      rawRows.push(row)
      rowLines.push(line)
    }
  }

  if (rawRows.length < 2) return { rows: [], issues: [] }
  const header = rawRows[0].map((h) => stripBom(h).trim())
  const issues: StructuralIssue[] = []

  const rows = rawRows.slice(1).map((r, idx) => {
    if (r.length !== header.length) {
      issues.push({
        line: rowLines[idx + 1] ?? idx + 2,
        expected: header.length,
        actual: r.length,
        preview: r.slice(0, 4).join(' | ').slice(0, 80),
      })
    }
    const obj: RawMerchantRow = {}
    header.forEach((h, i) => { obj[h] = r[i] ?? '' })
    return obj
  })

  return { rows, issues }
}

// ===================== CSV 导出 =====================

/** 需要转义的字段：含逗号/引号/换行时用引号包起来 */
export function escapeCsv(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(escapeCsv).join(',')]
  for (const r of rows) lines.push(r.map(escapeCsv).join(','))
  // 加 BOM 让 Excel 正确识别 UTF-8 中文
  return '\ufeff' + lines.join('\r\n')
}

export interface EnrichedRow {
  record: MerchantRecord
  tags: Tag[]
  diagnosis: DiagnosisReport
}

/** 导出「打标 + 诊断」结果表（运营直接可用） */
export function exportEnriched(rows: EnrichedRow[]): string {
  const headers = [
    '商家ID', '商家名称', '月GMV', '转化率', '退款率', '响应时长(s)', '进店量',
    '线索阶段', '商家类目', '规模', '经营健康度', '跟进优先级',
    '商家痛点', '健康分', '诊断结论', '推荐任务1', '推荐任务2', '推荐任务3',
    '需复核标签数',
  ]
  const body = rows.map(({ record, tags, diagnosis }) => {
    const tag = (dim: string) => tags.find((t) => t.dimension === dim)?.label ?? ''
    const pains = tags.filter((t) => t.dimension === 'pain_point').map((t) => t.label).join(' / ')
    return [
      record.id,
      record.name ?? '',
      record.monthlyGmv ?? '',
      record.conversionRate !== undefined ? `${(record.conversionRate * 100).toFixed(2)}%` : '',
      record.refundRate !== undefined ? `${(record.refundRate * 100).toFixed(2)}%` : '',
      record.avgResponseSec ?? '',
      record.traffic ?? '',
      tag('stage'), tag('category'), tag('scale'), tag('health'), tag('priority'),
      pains,
      diagnosis.sufficient ? diagnosis.score : '',
      diagnosis.headline,
      diagnosis.tasks[0]?.title ?? '',
      diagnosis.tasks[1]?.title ?? '',
      diagnosis.tasks[2]?.title ?? '',
      tags.filter((t) => t.needReview).length,
    ]
  })
  return toCsv(headers, body)
}

// ===================== 全链路 pipeline =====================

export interface PipelineResult {
  cleaning: CleaningResult
  enriched: EnrichedRow[]
  /** CSV 结构性问题（列数不匹配等）——静默错位比解析失败更危险 */
  structuralIssues: StructuralIssue[]
  summary: {
    inputRows: number
    validRows: number
    /** 打标后的覆盖统计 */
    priorityCount: Record<string, number>
    /** 有多少商家数据足够做诊断 */
    diagnosable: number
    /** 平均健康分（仅统计数据足够的） */
    avgScore: number
    /** 需要人工复核的标签总数 */
    reviewTags: number
  }
}

/**
 * 全链路：原始行 → 清洗 → 打标 → 诊断。
 *
 * 这是服务商批量处理的实际工作流：把导出的表丢进来，
 * 拿到「谁该先跟、跟他说什么」的清单。
 */
export function runPipeline(rawRows: RawMerchantRow[], structuralIssues: StructuralIssue[] = []): PipelineResult {
  const cleaning = cleanRecords(rawRows)
  const enriched: EnrichedRow[] = cleaning.records.map((record) => {
    const tagging = tagMerchant(record)
    return { record, tags: tagging.tags, diagnosis: diagnose(record) }
  })

  const priorityCount: Record<string, number> = { p0: 0, p1: 0, p2: 0 }
  for (const e of enriched) {
    const p = e.tags.find((t) => t.dimension === 'priority')?.value
    if (p && p in priorityCount) priorityCount[p]++
  }

  const diagnosable = enriched.filter((e) => e.diagnosis.sufficient)
  const avgScore = diagnosable.length
    ? Math.round(diagnosable.reduce((a, e) => a + e.diagnosis.score, 0) / diagnosable.length)
    : 0

  return {
    cleaning,
    enriched,
    structuralIssues,
    summary: {
      inputRows: rawRows.length,
      validRows: enriched.length,
      priorityCount,
      diagnosable: diagnosable.length,
      avgScore,
      reviewTags: enriched.reduce((a, e) => a + e.tags.filter((t) => t.needReview).length, 0),
    },
  }
}

/** 从 CSV 文本直接跑全链路（真实场景的入口） */
export function runPipelineFromCsv(text: string): PipelineResult {
  const { rows, issues } = parseCsvWithIssues(text)
  return runPipeline(rows, issues)
}

/** 渲染 pipeline 结果摘要 */
export function formatPipeline(r: PipelineResult): string {
  const s = r.summary
  const lines = [
    `处理完成：${s.inputRows} 行输入 → ${s.validRows} 条有效记录`,
    `数据质量：${r.cleaning.report.grade === 'good' ? '良好' : r.cleaning.report.grade === 'fair' ? '一般' : '较差'}` +
      `（清洗 ${r.cleaning.report.fixCount} 处，异常 ${r.cleaning.report.outliers.length} 处，重复 ${r.cleaning.report.duplicates.length} 条）`,
  ]

  // 结构性问题优先提示：会导致整行数据错位，必须先核对
  if (r.structuralIssues.length) {
    lines.push('')
    lines.push(`⚠️ 发现 ${r.structuralIssues.length} 行列数与表头不一致（很可能有未加引号的逗号）：`)
    for (const i of r.structuralIssues.slice(0, 3)) {
      lines.push(`   第 ${i.line} 行：期望 ${i.expected} 列，实际 ${i.actual} 列 —— ${i.preview}`)
    }
    lines.push('   → 这些行的数据可能已错位，建议在源表修正后重新导入')
  }

  lines.push(
    '',
    `跟进优先级分布：P0 ${s.priorityCount.p0} 家 ｜ P1 ${s.priorityCount.p1} 家 ｜ P2 ${s.priorityCount.p2} 家`,
    `可做诊断：${s.diagnosable}/${s.validRows} 家（平均健康分 ${s.avgScore}）`,
    `需人工复核的标签：${s.reviewTags} 个`,
    '',
    '今日建议优先跟进：',
  )
  const p0 = r.enriched.filter((e) => e.tags.find((t) => t.dimension === 'priority')?.value === 'p0')
  if (!p0.length) lines.push('  （无 P0，按 P1 顺序处理即可）')
  for (const e of p0.slice(0, 5)) {
    lines.push(`  · ${e.record.name ?? e.record.id}（健康分 ${e.diagnosis.sufficient ? e.diagnosis.score : '数据不足'}）`)
    lines.push(`    ${e.diagnosis.headline}`)
  }
  return lines.join('\n')
}
