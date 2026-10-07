/**
 * 电商服务商工作台接口。
 *
 *  GET  /api/ecom?action=dataset                → 演示数据集 + 批量打标/诊断汇总
 *  GET  /api/ecom?action=knowledge&q=仅退款规则  → 业务知识库检索
 *  GET  /api/ecom?action=accuracy               → 打标纠错归因报告（规则迭代依据）
 *  POST /api/ecom { action: 'tag',      record }          → 单条打标
 *  POST /api/ecom { action: 'diagnose', record }          → 单条经营诊断
 *  POST /api/ecom { action: 'script',   ... }             → 话术生成
 *  POST /api/ecom { action: 'compare',  merchants, ... }  → Prompt 变体效果对比
 *  POST /api/ecom { action: 'clean',    csv }             → 清洗 + 打标 + 诊断全链路
 *  POST /api/ecom { action: 'correct',  ... }             → 记录打标纠错（回流迭代）
 *
 * 设计说明：这里**不跑 Agent 循环**。打标/诊断是确定性计算，
 * 话术生成是一次 LLM 调用 —— 都不需要走「规划 + 工具编排」那套重流程。
 * 用 Agent 去干这些反而是过度设计（这正是产品判断）。
 */
import { NextRequest } from 'next/server'
import { DEMO_MERCHANTS } from '@/lib/ecom/demo-data'
import { tagBatch, tagMerchant, type MerchantRecord } from '@/lib/ecom/tagging'
import { diagnose, diagnoseBatch } from '@/lib/ecom/diagnosis'
import { BUILTIN_VARIANTS, compareVariants, generateScript, type ScriptRequest } from '@/lib/ecom/script'
import { ALL_DIMENSIONS } from '@/lib/ecom/taxonomy'
import { searchKnowledge } from '@/lib/agent/knowledge'
import { runPipelineFromCsv, exportEnriched } from '@/lib/ecom/pipeline'
import { recordCorrection, analyzeCorrections, applyCorrections } from '@/lib/ecom/tag-store'
import path from 'node:path'

export const maxDuration = 120

const ECOM_KB_DIR = 'ecom-knowledge'

export async function GET(req: NextRequest) {
  const action = req.nextUrl.searchParams.get('action') ?? 'dataset'

  if (action === 'knowledge') {
    const q = req.nextUrl.searchParams.get('q') ?? ''
    if (!q) return Response.json({ error: '缺少 q 参数' }, { status: 400 })
    // 知识库放在 assets/ 下，root 指到 assets，dir 指到 ecom-knowledge
    const assetsRoot = path.join(process.cwd(), 'assets')
    const hits = searchKnowledge(assetsRoot, q, Number(req.nextUrl.searchParams.get('topK')) || 3, ECOM_KB_DIR)
    return Response.json({
      query: q,
      hits: hits.map((h) => ({
        file: h.chunk.file,
        heading: h.chunk.heading,
        score: Number(h.score.toFixed(3)),
        excerpt: h.chunk.text.slice(0, 400),
      })),
    })
  }

  if (action === 'accuracy') {
    return Response.json(analyzeCorrections())
  }

  // 默认：数据集 + 批量打标 + 批量诊断汇总
  const tagging = tagBatch(DEMO_MERCHANTS)
  const diag = diagnoseBatch(DEMO_MERCHANTS)
  return Response.json({
    dimensions: ALL_DIMENSIONS,
    merchants: DEMO_MERCHANTS.map((m, i) => ({
      ...m,
      tags: tagging.results[i].tags,
      reviewCount: tagging.results[i].reviewCount,
      diagnosis: diag.reports[i],
    })),
    taggingSummary: tagging.summary,
    diagnosisSummary: diag.summary,
  })
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const action = String(body.action ?? '')

  if (action === 'tag') {
    const rec = body.record as MerchantRecord
    if (!rec?.id) return Response.json({ error: 'record.id 必填' }, { status: 400 })
    return Response.json(tagMerchant(rec))
  }

  if (action === 'diagnose') {
    const rec = body.record as MerchantRecord
    if (!rec?.id) return Response.json({ error: 'record.id 必填' }, { status: 400 })
    return Response.json(diagnose(rec))
  }

  if (action === 'script') {
    const rec = body.record as MerchantRecord
    if (!rec?.id) return Response.json({ error: 'record.id 必填' }, { status: 400 })
    const variantId = String(body.variantId ?? BUILTIN_VARIANTS[1].id)
    const variant = BUILTIN_VARIANTS.find((v) => v.id === variantId) ?? BUILTIN_VARIANTS[1]

    // 组装上下文：打标 + 诊断 + 知识库检索（RAG 提供事实依据）
    const assetsRoot = path.join(process.cwd(), 'assets')
    const kbQuery = `${body.intent ?? 'diagnose'} ${rec.note ?? ''} 经营建议`
    const hits = searchKnowledge(assetsRoot, kbQuery, 2, ECOM_KB_DIR)

    const scriptReq: ScriptRequest = {
      merchantId: rec.id,
      merchantName: rec.name,
      intent: String(body.intent ?? 'diagnose'),
      tags: tagMerchant(rec).tags,
      diagnosis: diagnose(rec),
      knowledge: hits.map((h) => h.chunk.text.slice(0, 300)),
    }
    const result = await generateScript(scriptReq, variant)
    return Response.json({ ...result, variantName: variant.name, knowledgeUsed: hits.length })
  }

  if (action === 'compare') {
    const merchants = (body.merchants as MerchantRecord[]) ?? DEMO_MERCHANTS.slice(0, 3)
    const intent = String(body.intent ?? 'diagnose')
    const reqs: ScriptRequest[] = merchants.map((m) => ({
      merchantId: m.id,
      merchantName: m.name,
      intent,
      tags: tagMerchant(m).tags,
      diagnosis: diagnose(m),
    }))
    const comparison = await compareVariants(reqs)
    return Response.json(comparison)
  }

  if (action === 'clean') {
    // 全链路：CSV 文本 → 清洗 → 打标 → 诊断
    const csv = String(body.csv ?? '')
    if (!csv.trim()) return Response.json({ error: 'csv 必填' }, { status: 400 })
    const r = runPipelineFromCsv(csv)
    return Response.json({
      report: r.cleaning.report,
      summary: r.summary,
      structuralIssues: r.structuralIssues,
      fixes: r.cleaning.fixes.slice(0, 50),
      merchants: r.enriched.map((e) => ({
        id: e.record.id,
        name: e.record.name,
        tags: e.tags,
        diagnosis: e.diagnosis,
      })),
      exportPreview: body.wantCsv ? exportEnriched(r.enriched) : undefined,
    })
  }

  if (action === 'correct') {
    // 记录人工纠错 → 回流到规则迭代
    const c = recordCorrection({
      merchantId: String(body.merchantId ?? ''),
      dimension: String(body.dimension ?? ''),
      original: String(body.original ?? ''),
      corrected: String(body.corrected ?? ''),
      reason: body.reason ? String(body.reason) : undefined,
    })
    return Response.json({ ok: true, correction: c, accuracy: analyzeCorrections() })
  }

  if (action === 'applyCorrections') {
    const tags = (body.tags as never[]) ?? []
    return Response.json({ tags: applyCorrections(tags, String(body.merchantId ?? '')) })
  }

  return Response.json({ error: `未知 action：${action}` }, { status: 400 })
}
