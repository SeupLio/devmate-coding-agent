/**
 * 电商服务商工作台接口。
 *
 *  GET  /api/ecom?action=dataset                → 演示数据集 + 批量打标/诊断汇总
 *  GET  /api/ecom?action=knowledge&q=仅退款规则  → 业务知识库检索
 *  POST /api/ecom { action: 'tag',      record }          → 单条打标
 *  POST /api/ecom { action: 'diagnose', record }          → 单条经营诊断
 *  POST /api/ecom { action: 'script',   ... }             → 话术生成
 *  POST /api/ecom { action: 'compare',  merchants, ... }  → Prompt 变体效果对比
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

  return Response.json({ error: `未知 action：${action}` }, { status: 400 })
}
