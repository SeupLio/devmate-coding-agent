/**
 * 电商服务商场景：话术生成 + Prompt 变体效果测试。
 *
 * 对应 JD 第 1 条「话术生成」与第 4 条「参与 AI 工具、智能助手、Prompt、工作流等方案的
 * **测试和优化**，记录效果问题并协助产品经理持续迭代」。
 *
 * ## 这里和「随便让 LLM 写一段话」的区别
 *
 * 1. **话术有据可依**：输入是打标结果 + 诊断结论 + 知识库检索片段。
 *    模型不是在凭空创作，而是在「把已有结论讲成人话」—— 这样话术不会跑偏成通用套话。
 * 2. **生成后自动质检**：按 SOP 里的禁止事项（承诺结果、索要密码）和结构要求
 *    （是否含具体观察、是否有明确下一步）逐条检查，产出可量化的质量分。
 * 3. **Prompt 变体可对比**：同一批商家跑多个 Prompt 变体，用同一套指标打分，
 *    把「哪个 Prompt 更好」从主观争论变成可统计的结论 —— 这就是「记录效果问题并迭代」。
 *
 * ## 诚实的边界
 *
 * - 质检是**启发式规则**，不是人工评审的替代品；它能挡住明显问题，挡不住微妙的不当表达。
 * - 效果分只反映「结构合规性」，不反映「商家真实回复率」——
 *   后者需要真实投放数据，本项目没有（详见 docs/ECOM-JD-ALIGNMENT.md）。
 */
import type { DiagnosisReport } from './diagnosis'
import type { Tag } from './tagging'

// ===================== 话术生成 =====================

export interface ScriptRequest {
  merchantId: string
  merchantName?: string
  /** 话术意图（taxonomy 里的 script_intent） */
  intent: string
  /** 打标结果（提供商家画像） */
  tags: Tag[]
  /** 诊断结论（提供谈话素材） */
  diagnosis?: DiagnosisReport
  /** 知识库检索到的参考片段（RAG） */
  knowledge?: string[]
}

export interface GeneratedScript {
  merchantId: string
  intent: string
  /** 生成的话术正文 */
  text: string
  /** 使用的 Prompt 变体 id */
  variantId: string
  /** 自动质检结果 */
  quality: QualityReport
  /** 是否调用成功（LLM 不可用时如实标记） */
  ok: boolean
  error?: string
}

/** Prompt 变体：同一任务的不同提示词方案 */
export interface PromptVariant {
  id: string
  name: string
  /** 变体说明（产品文档里要写清「为什么这么设计」） */
  rationale: string
  system: string
}

/**
 * 内置 Prompt 变体（对应 JD「Prompt 方案的测试和优化」）。
 * 三个变体代表三种典型设计取向，用于 A/B 对比。
 */
export const BUILTIN_VARIANTS: PromptVariant[] = [
  {
    id: 'v1_direct',
    name: 'V1 直给式',
    rationale: '直接下达任务，不约束结构。作为**基线**，用来验证「加约束到底有没有用」。',
    system:
      '你是电商平台服务商的一线运营，负责与商家沟通。请根据提供的商家信息写一段跟进话术。'
      + '要求口语化、可直接发送，控制在 150 字以内。',
  },
  {
    id: 'v2_structured',
    name: 'V2 结构约束式',
    rationale:
      '强制三段结构（具体观察 → 价值/建议 → 明确下一步）。'
      + '针对 V1 常见问题：话术空泛、没有下一步。',
    system: [
      '你是电商平台服务商的一线运营，负责与商家沟通。请根据提供的商家信息写一段跟进话术。',
      '',
      '必须严格按以下三段结构输出（不要加小标题，自然衔接）：',
      '1. **具体观察**：引用该商家的一个真实数据或事实，让对方觉得「你是懂我的」，禁止泛泛而谈。',
      '2. **价值/建议**：给出 1~2 条可执行建议，要具体到动作，不要只说「帮你提升」。',
      '3. **明确下一步**：给出一个低门槛的行动邀约（如约 15 分钟沟通、发一份诊断报告）。',
      '',
      '约束：口语化、可直接发送、150 字以内。',
      '禁止：承诺平台无法保证的结果（如「保证上首页」）；索要账号密码；编造未提供的数据。',
    ].join('\n'),
  },
  {
    id: 'v3_roleplay',
    name: 'V3 角色扮演 + 反例式',
    rationale:
      '在结构约束基础上加「反例」（明确写出什么样的句子是差的）。'
      + '针对 V2 的残留问题：模型仍可能写出「我们平台能帮你提升销量」这类空话。',
    system: [
      '你是电商平台服务商的一线运营，负责与商家沟通。请根据提供的商家信息写一段跟进话术。',
      '',
      '结构：具体观察 → 价值/建议 → 明确下一步（自然衔接，不要小标题）。',
      '',
      '**差的话术长这样（禁止这样写）：**',
      '- 「您好，我们是XX平台服务商，可以帮您提升店铺销量。」← 群发感、没信息量',
      '- 「建议您优化一下店铺运营。」← 太虚，商家不知道做什么',
      '- 「保证让您月销翻倍。」← 承诺无法保证的结果',
      '',
      '**好的话术长这样（照这个感觉写）：**',
      '- 「看到您家近30天进店 4200 但转化只有 1.2%，同行大概在 2.5% 左右 ——',
      '   我们复盘过类似的女装店，多数是详情页缺尺码表 + 客服响应超 60 秒。',
      '   要不我发您一份 3 分钟的对比清单？您看完觉得有用再聊。」',
      '',
      '约束：口语化、可直接发送、150 字以内。禁止承诺结果、索要密码、编造数据。',
    ].join('\n'),
  },
]

/** 把商家上下文拼成给模型的事实材料 */
export function buildContext(req: ScriptRequest): string {
  const lines: string[] = [`商家：${req.merchantName ?? req.merchantId}`]

  const tagText = req.tags
    .filter((t) => ['scale', 'category', 'health', 'pain_point', 'stage'].includes(t.dimension))
    .map((t) => t.label)
    .join('、')
  if (tagText) lines.push(`画像标签：${tagText}`)

  if (req.diagnosis?.sufficient && req.diagnosis.issues.length) {
    lines.push('经营诊断：')
    for (const i of req.diagnosis.issues.filter((x) => x.severity !== 'ok').slice(0, 3)) {
      lines.push(`  - ${i.metric}：${i.current}（目标 ${i.target}）`)
    }
    if (req.diagnosis.headline) lines.push(`  结论：${req.diagnosis.headline}`)
  }

  if (req.knowledge?.length) {
    lines.push('可参考的知识库片段：')
    for (const k of req.knowledge.slice(0, 2)) lines.push(`  ${k.slice(0, 300)}`)
  }

  lines.push('', `本次沟通意图：${req.intent}`)
  return lines.join('\n')
}

/** 生成一段话术（单变体） */
export async function generateScript(
  req: ScriptRequest,
  variant: PromptVariant,
): Promise<GeneratedScript> {
  const base: Omit<GeneratedScript, 'quality'> = {
    merchantId: req.merchantId,
    intent: req.intent,
    text: '',
    variantId: variant.id,
    ok: false,
  }
  try {
    const { chatStream } = await import('@/lib/agent/llm')
    const res = await chatStream(
      [
        { role: 'system', content: variant.system },
        { role: 'user', content: buildContext(req) },
      ],
      undefined,
      {},
      { enableThinking: false },
    )
    const text = res.content.trim()
    if (!text) throw new Error('模型返回空内容')
    return { ...base, text, ok: true, quality: checkQuality(text) }
  } catch (e) {
    const text = ''
    return {
      ...base,
      text,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      quality: checkQuality(text),
    }
  }
}

// ===================== 自动质检 =====================

export interface QualityCheck {
  id: string
  label: string
  pass: boolean
  /** 不通过时的说明 */
  detail?: string
}

export interface QualityReport {
  checks: QualityCheck[]
  /** 通过率 0~1 */
  score: number
  /** 是否有严重违规（禁止事项） */
  hasViolation: boolean
}

/** SOP 里的禁止事项（硬红线） */
const FORBIDDEN: { re: RegExp; label: string }[] = [
  { re: /保证[^。！？]{0,10}(上首页|爆单|翻倍|成功|第一)/, label: '承诺平台无法保证的结果' },
  { re: /(密码|账号密码|验证码)/, label: '索要账号密码或验证码' },
  { re: /一定(能|会)[^。！？]{0,8}(成功|过|通过)/, label: '绝对化承诺' },
]

/** 空话套话（结构合规性检查） */
const VAGUE: RegExp[] = [
  /帮(您|你)(提升|增加)(店铺)?(销量|业绩|流量)/,
  /建议(您|你)优化(一下)?(店铺)?运营/,
  /我们是.{0,10}服务商，可以帮/,
]

const NUMERIC_RE = /\d+(\.\d+)?%|\d{3,}/

/**
 * 话术自动质检。
 * 五个检查项对应 SOP 与「好话术」的标准，每项独立可解释。
 */
export function checkQuality(text: string): QualityReport {
  const t = text.trim()
  const checks: QualityCheck[] = []

  // 1) 禁止事项（硬红线）
  const violations = FORBIDDEN.filter((f) => f.re.test(t))
  checks.push({
    id: 'no_violation',
    label: '未触碰 SOP 禁止事项',
    pass: violations.length === 0,
    detail: violations.length ? `命中：${violations.map((v) => v.label).join('、')}` : undefined,
  })

  // 2) 有具体数据（「具体观察」的量化代理指标）
  checks.push({
    id: 'has_numbers',
    label: '含具体数据/事实（非空泛描述）',
    pass: NUMERIC_RE.test(t),
    detail: NUMERIC_RE.test(t) ? undefined : '未出现任何具体数字，易被视为群发话术',
  })

  // 3) 不空泛
  const vagueHit = VAGUE.filter((r) => r.test(t))
  checks.push({
    id: 'not_vague',
    label: '无空话套话',
    pass: vagueHit.length === 0,
    detail: vagueHit.length ? '命中「我们平台能帮您提升销量」类空话' : undefined,
  })

  // 4) 有明确下一步
  const hasNextStep = /(要不|要么|方便|约|加个微信|发您|发你|电话|语音|15分钟|明天|这周|本周)/.test(t)
  checks.push({
    id: 'has_next_step',
    label: '含明确的下一步行动邀约',
    pass: hasNextStep,
    detail: hasNextStep ? undefined : '没有给出下一步动作，商家不知道要做什么',
  })

  // 5) 长度合规
  const len = t.length
  checks.push({
    id: 'length_ok',
    label: '长度适中（60~220 字）',
    pass: len >= 60 && len <= 220,
    detail: len < 60 ? `仅 ${len} 字，信息量不足` : len > 220 ? `${len} 字，过长不利于阅读` : undefined,
  })

  const passed = checks.filter((c) => c.pass).length
  return {
    checks,
    score: checks.length ? Math.round((passed / checks.length) * 100) / 100 : 0,
    hasViolation: violations.length > 0,
  }
}

// ===================== Prompt 变体效果对比（JD 第 4 条核心）=====================

export interface VariantResult {
  variantId: string
  variantName: string
  /** 平均质量分 */
  avgScore: number
  /** 违规率 */
  violationRate: number
  /** 生成成功率 */
  successRate: number
  /** 样本数 */
  samples: number
  /** 逐条明细（便于人工复核「分数是否合理」） */
  details: { merchantId: string; score: number; violation: boolean; text: string }[]
  /** 该变体最常见的不通过项（迭代方向） */
  topFailure: string | null
}

export interface PromptComparison {
  variants: VariantResult[]
  /** 结论：哪个变体最好 */
  winner: string | null
  /** 结论说明（含「为什么」） */
  conclusion: string
}

/**
 * 用同一批商家跑多个 Prompt 变体，输出可对比的效果报告。
 *
 * 这是「Prompt 方案的测试和优化」的具体落地：把主观的「哪个提示词好」
 * 变成同一套指标下的可统计结论，并指出**下一步该改哪里**。
 */
export async function compareVariants(
  requests: ScriptRequest[],
  variants: PromptVariant[] = BUILTIN_VARIANTS,
  concurrency = 3,
): Promise<PromptComparison> {
  const results: VariantResult[] = []

  for (const v of variants) {
    const details: VariantResult['details'] = []
    const failCounter = new Map<string, number>()
    let cursor = 0

    const worker = async () => {
      while (cursor < requests.length) {
        const req = requests[cursor++]
        const r = await generateScript(req, v)
        details.push({
          merchantId: req.merchantId,
          score: r.quality.score,
          violation: r.quality.hasViolation,
          text: r.text,
        })
        for (const c of r.quality.checks) {
          if (!c.pass) failCounter.set(c.label, (failCounter.get(c.label) ?? 0) + 1)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, requests.length) }, worker))

    const n = details.length || 1
    const topFailure =
      [...failCounter.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null

    results.push({
      variantId: v.id,
      variantName: v.name,
      avgScore: Math.round((details.reduce((a, d) => a + d.score, 0) / n) * 100) / 100,
      violationRate: Math.round((details.filter((d) => d.violation).length / n) * 100) / 100,
      successRate: Math.round((details.filter((d) => d.text.length > 0).length / n) * 100) / 100,
      samples: details.length,
      details,
      topFailure,
    })
  }

  // 排序：先看有没有违规（一票否决），再比平均分
  const ranked = [...results].sort(
    (a, b) => a.violationRate - b.violationRate || b.avgScore - a.avgScore,
  )
  const best = ranked[0]
  const worst = ranked[ranked.length - 1]

  const conclusion = !best || best.samples === 0
    ? '没有有效样本，无法比较。'
    : best.violationRate === 0 && worst && worst.violationRate > 0
      ? `「${best.variantName}」在 ${best.samples} 条样本上零违规，平均质量分 ${best.avgScore}；`
        + `而「${worst.variantName}」违规率 ${(worst.violationRate * 100).toFixed(0)}%。`
        + `→ 说明「${worst.topFailure ?? '缺少约束'}」是必须显式约束的。`
      : `「${best.variantName}」综合最优（平均质量分 ${best.avgScore}，违规率 ${(best.violationRate * 100).toFixed(0)}%）。`
        + (best.topFailure ? `下一步优先改进「${best.topFailure}」。` : '各项检查均通过。')

  return { variants: ranked, winner: best?.variantId ?? null, conclusion }
}

/** 渲染对比报告（给产品经理看的形态） */
export function formatComparison(c: PromptComparison): string {
  const lines = ['Prompt 变体效果对比', '='.repeat(48)]
  for (const v of c.variants) {
    lines.push(
      `${v.variantName.padEnd(16)} 质量分 ${v.avgScore.toFixed(2)}  ` +
      `违规率 ${(v.violationRate * 100).toFixed(0).padStart(3)}%  ` +
      `成功率 ${(v.successRate * 100).toFixed(0).padStart(3)}%  (n=${v.samples})`,
    )
    if (v.topFailure) lines.push(`  ↳ 最常不通过：${v.topFailure}`)
  }
  lines.push('', `结论：${c.conclusion}`)
  return lines.join('\n')
}
