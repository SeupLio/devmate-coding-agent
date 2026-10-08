/**
 * 电商场景：金标准标注集（Ground Truth）。
 *
 * ## 为什么必须有这个文件
 *
 * 之前整个模块 2000+ 行代码，**没有任何 ground truth**。这意味着一个致命问题：
 * 「打标准不准？」这个问题**根本无法回答**。你能演示「它能跑」，但说不出「它有多准」。
 * 没有准确率，就没有迭代方向，也没法向业务方证明价值。
 *
 * 这个文件就是那把尺子：每条记录都**人工标注**了各维度的期望值 + 标注理由。
 *
 * ## 标注口径（必须独立于代码，否则评测是循环论证）
 *
 * 标注时**只依据 `taxonomy.ts` 里写明的 criteria 与 `thresholds.ts` 的线**，
 * 不参考打标函数的输出。若规则与人工标注不一致，那是**规则的错**，要记录、要修 ——
 * 而不是把标注改成跟规则一样（那样准确率永远是 100%，评测就失去意义）。
 *
 * 各维度口径速查（默认阈值）：
 *  - **规模**：GMV ≥ 50 万 → KA；≥ 10 万 → 腰部；否则长尾
 *  - **健康度**：数「严重项」个数（转化率 < 2%、退款率 > 10%、响应 > 60s、进店 < 1000）
 *    0 项 → 健康；1 项 → 亚健康；≥2 项 → 需干预
 *  - **阶段**：上游 `stage` 优先；否则按跟进记录关键词；完全无信号 → 不打标
 *  - **类目**：按名称/记录里的类目关键词；无命中 → 其他
 *  - **优先级**：高价值(KA/腰部) 且 有风险 → P0；或有明确意向 → P0；
 *    中等价值或中等风险 → P1；健康且价值一般 → P2
 *  - **痛点**：数值跌破**严重线**，或文本命中痛点关键词（可多选）
 *
 * ## `contested` 标记
 *
 * 有些样本**口径本身有争议**（例：已流失商家还算不算「高价值优先跟进」）。
 * 这类样本单独标记，评测时**不计入主指标**，而是单独列出来推动口径讨论 ——
 * 这比硬塞进准确率里更有价值。
 */
import type { MerchantRecord } from './tagging'

/** 需要评测的标签维度（与 taxonomy 的 key 一致） */
export type GoldenDimension = 'stage' | 'category' | 'scale' | 'health' | 'priority' | 'pain_point'

/**
 * 期望标签。
 *  - 单值维度：字符串，`null` 表示「不应打标」
 *  - 多值维度（pain_point）：字符串数组，`[]` 表示「不应打标」
 */
export interface GoldenExpectation {
  stage: string | null
  category: string | null
  scale: string | null
  health: string | null
  priority: string | null
  pain_point: string[]
}

export interface GoldenCase {
  id: string
  /** 输入记录（视为已清洗） */
  record: MerchantRecord
  /** 人工标注的期望结果 */
  expected: GoldenExpectation
  /** 标注理由（便于复核与争议仲裁） */
  rationale: string
  /**
   * 口径有争议的边界样本：不计入主指标，单独统计。
   * 用途是「把口径分歧显性化」，而不是掩盖它。
   */
  contested?: boolean
  /** 该样本想覆盖的情形（便于看覆盖率） */
  covers: string
}

export const GOLDEN_SET: GoldenCase[] = [
  {
    id: 'G01',
    record: {
      id: 'G01', name: '轻语女装旗舰店', monthlyGmv: 620_000, conversionRate: 0.012,
      refundRate: 0.16, avgResponseSec: 130, traffic: 9000,
      note: '商家说转化率低、退款多', stage: 'interested',
    },
    expected: { stage: 'interested', category: 'apparel', scale: 'ka', health: 'unhealthy', priority: 'p0', pain_point: ['high_refund', 'low_conversion', 'slow_response'] },
    rationale: 'GMV 62 万 → KA；转化 1.2%、退款 16%、响应 130s 三项跌破严重线 → 需干预；KA + 有风险 → P0。文本另命中「转化率低/退款多」。',
    covers: '高价值 + 多重严重 + 意向中（P0 最强信号）',
  },
  {
    id: 'G02',
    record: {
      id: 'G02', name: '木言家居旗舰店', monthlyGmv: 700_000, conversionRate: 0.032,
      refundRate: 0.04, avgResponseSec: 20, traffic: 9500,
      note: '经营健康，想争取大促', stage: 'converted',
    },
    expected: { stage: 'converted', category: 'home', scale: 'ka', health: 'healthy', priority: 'p1', pain_point: [] },
    rationale: '各项均达标 → 健康；KA 虽健康但值得每周维护 → P1（P2 口径是「健康且价值一般」，KA 不属于价值一般）。',
    covers: '健康 KA（验证 P1 与 P2 的边界口径）',
  },
  {
    id: 'G03',
    record: {
      id: 'G03', name: '新芽食品店', monthlyGmv: 30_000, conversionRate: 0.03,
      refundRate: 0.03, avgResponseSec: 20, traffic: 3200, note: '刚入驻', stage: 'lead',
    },
    expected: { stage: 'lead', category: 'food', scale: 'long_tail', health: 'healthy', priority: 'p2', pain_point: [] },
    rationale: 'GMV 3 万 → 长尾；四项均达标 → 健康；健康且价值一般 → P2。',
    covers: '长尾健康（P2 基线）',
  },
  {
    id: 'G04',
    record: {
      id: 'G04', name: '食光零食铺', monthlyGmv: 80_000, conversionRate: 0.02,
      refundRate: 0.05, avgResponseSec: 40, traffic: 2600,
      note: '想了解合作方案', stage: 'interested',
    },
    expected: { stage: 'interested', category: 'food', scale: 'long_tail', health: 'healthy', priority: 'p0', pain_point: [] },
    rationale: '转化 2.0% 处于预警区（未跌破 2% 严重线）、响应 40s 预警、进店 2600 预警 → 无严重项 → 健康；有明确意向 → P0（意向信号优先于规模）。',
    covers: '意向中长尾 → P0（验证「意向信号」的独立权重）',
  },
  {
    id: 'G05',
    record: {
      id: 'G05', name: '小满数码配件店', monthlyGmv: 260_000, conversionRate: 0.021,
      refundRate: 0.06, avgResponseSec: 200, traffic: 5200,
      note: '客服没人回', stage: 'contacted',
    },
    expected: { stage: 'contacted', category: '3c', scale: 'mid', health: 'at_risk', priority: 'p0', pain_point: ['slow_response'] },
    rationale: '响应 200s 跌破严重线（1 项）→ 亚健康；腰部 + 有风险 → P0。文本「没人回」与数值同向，交叉印证。',
    covers: '腰部 + 单一严重项 → P0（验证「风险」独立触发 P0）',
  },
  {
    id: 'G06',
    record: {
      id: 'G06', name: '柔光美妆店', monthlyGmv: 150_000, conversionRate: 0.03,
      refundRate: 0.05, avgResponseSec: 25, traffic: 5000,
      note: '明确拒绝，不考虑了', stage: 'lost',
    },
    expected: { stage: 'lost', category: 'beauty', scale: 'mid', health: 'healthy', priority: 'p2', pain_point: [] },
    rationale: '**口径分歧样本**：规则只看「腰部 + 健康」→ P1；但人工口径认为已流失商家不该占用优先跟进资源 → P2。列出来推动规则修订。',
    contested: true,
    covers: '已流失商家（口径争议：该不该优先跟进）',
  },
  {
    id: 'G07',
    record: { id: 'G07', name: '某某店铺', monthlyGmv: 12_000, note: '刚入驻' },
    expected: { stage: 'lead', category: 'other', scale: 'long_tail', health: null, priority: 'p2', pain_point: [] },
    rationale: '无任何经营指标 → 健康度**不打标**（不瞎猜）；无阶段关键词 → 默认「待触达」低置信；无类目关键词 → 其他。',
    covers: '数据严重缺失（验证「拒绝下结论」而不是硬猜）',
  },
  {
    id: 'G08',
    record: {
      id: 'G08', name: '边界服饰店', monthlyGmv: 200_000, conversionRate: 0.02,
      refundRate: 0.05, avgResponseSec: 30, traffic: 3000,
    },
    expected: { stage: null, category: 'apparel', scale: 'mid', health: 'healthy', priority: 'p1', pain_point: [] },
    rationale: '**边界**：转化率正好 = 严重线 2.0%、响应正好 = 达标线 30s、进店正好 = 达标线 3000。口径「≥ 严重线即非严重」→ 无严重项 → 健康。无跟进记录 → 阶段不打标。',
    covers: '边界：取值恰好落在阈值线上（验证 >= / > 的语义）',
  },
  {
    id: 'G09',
    record: {
      id: 'G09', name: '边界食品店', monthlyGmv: 200_000, conversionRate: 0.03,
      refundRate: 0.1, avgResponseSec: 25, traffic: 4000,
    },
    expected: { stage: null, category: 'food', scale: 'mid', health: 'healthy', priority: 'p1', pain_point: [] },
    rationale: '**边界**：退款率正好 = 严重线 10%。口径「≤ 严重线即非严重」→ 健康。',
    covers: '边界：退款率恰在严重线',
  },
  {
    id: 'G10',
    record: {
      id: 'G10', name: '边界家居店', monthlyGmv: 200_000, conversionRate: 0.03,
      refundRate: 0.05, avgResponseSec: 60, traffic: 4000,
    },
    expected: { stage: null, category: 'home', scale: 'mid', health: 'healthy', priority: 'p1', pain_point: [] },
    rationale: '**边界**：响应正好 = 严重线 60s → 非严重 → 健康。',
    covers: '边界：响应时长恰在严重线',
  },
  {
    id: 'G11',
    record: {
      id: 'G11', name: '低流量小店', monthlyGmv: 50_000, conversionRate: 0.03,
      refundRate: 0.03, avgResponseSec: 20, traffic: 999,
    },
    expected: { stage: null, category: 'other', scale: 'long_tail', health: 'at_risk', priority: 'p1', pain_point: ['low_traffic'] },
    rationale: '进店 999 < 1000 严重线 → 1 项严重 → 亚健康；长尾但仍有风险 → P1。',
    covers: '边界：进店量 999（严重线内）',
  },
  {
    id: 'G12',
    record: {
      id: 'G12', name: '中量服饰店', monthlyGmv: 80_000, conversionRate: 0.03,
      refundRate: 0.04, avgResponseSec: 25, traffic: 1000,
    },
    expected: { stage: null, category: 'apparel', scale: 'long_tail', health: 'healthy', priority: 'p2', pain_point: [] },
    rationale: '**边界**：进店 1000 = 严重线 → 非严重 → 健康；长尾健康 → P2。',
    covers: '边界：进店量恰在严重线',
  },
  {
    id: 'G13',
    record: {
      id: 'G13', name: '综合问题店', monthlyGmv: 300_000, conversionRate: 0.02,
      refundRate: 0.06, avgResponseSec: 40, traffic: 2500,
      note: '没流量、转化差、退款多、价格战利润薄',
    },
    expected: { stage: 'lead', category: 'other', scale: 'mid', health: 'healthy', priority: 'p1', pain_point: ['high_refund', 'low_conversion', 'low_traffic', 'price_war'] },
    rationale: '数值全部处于预警区（未跌破严重线）→ 健康；但文本命中 4 个痛点关键词 → 痛点可多选。说明「数值判健康、文本暴露痛点」是互补而非矛盾。',
    covers: '多痛点（可多选维度）+ 数值与文本信号分离',
  },
  {
    id: 'G14',
    record: {
      id: 'G14', name: '美妆服饰集合店', monthlyGmv: 400_000, conversionRate: 0.03,
      refundRate: 0.05, avgResponseSec: 25, traffic: 5000, note: '主营服装和美妆',
    },
    expected: { stage: 'lead', category: 'apparel', scale: 'mid', health: 'healthy', priority: 'p1', pain_point: [] },
    rationale: '**口径分歧样本**：同时命中「服装」与「美妆」，规则按关键词表顺序取第一个（服饰）；但人工可能认为「集合店」应归「其他」。列出来讨论。',
    contested: true,
    covers: '类目歧义（多关键词同时命中）',
  },
  {
    id: 'G15',
    record: {
      id: 'G15', name: '极光数码旗舰店', monthlyGmv: 800_000, conversionRate: 0.03,
      refundRate: 0.04, avgResponseSec: 20, traffic: 12_000,
      note: '已联系', stage: 'contacted',
    },
    expected: { stage: 'contacted', category: '3c', scale: 'ka', health: 'healthy', priority: 'p0', pain_point: [] },
    rationale: 'KA + 已触达 → P0（「KA 已触达」是规则里明确的 P0 分支：大客户已建立联系就该趁热推进）。',
    covers: 'KA 已触达 → P0（验证 KA 特殊分支）',
  },
  {
    id: 'G16',
    record: {
      id: 'G16', name: '小微服饰店', monthlyGmv: 40_000, conversionRate: 0.012,
      refundRate: 0.16, avgResponseSec: 130, traffic: 600,
    },
    expected: { stage: null, category: 'apparel', scale: 'long_tail', health: 'unhealthy', priority: 'p1', pain_point: ['high_refund', 'low_conversion', 'low_traffic', 'slow_response'] },
    rationale: '四项全部跌破严重线 → 需干预；但长尾 + 无价值 → 不能给 P0（否则长尾会挤占 KA 的跟进资源）→ P1。',
    covers: '长尾 + 多重严重 → 仍不升 P0（验证规模在优先级里的作用）',
  },
  {
    id: 'G17',
    record: { id: 'G17', monthlyGmv: 150_000 },
    expected: { stage: null, category: null, scale: 'mid', health: null, priority: 'p1', pain_point: [] },
    rationale: '只有 GMV：规模可判（腰部）；无指标 → 健康度不打标；无名称/记录 → 类目与阶段均不打标。优先级仍可判（腰部 → P1）。',
    covers: '极简输入（只够判规模）',
  },
  {
    id: 'G18',
    record: {
      id: 'G18', name: '测试店', monthlyGmv: 200_000, conversionRate: 0.03,
      refundRate: 0.05, avgResponseSec: 25, traffic: 5000,
      note: '商家明确拒绝', stage: 'interested',
    },
    expected: { stage: 'interested', category: 'other', scale: 'mid', health: 'healthy', priority: 'p0', pain_point: [] },
    rationale: '上游 `stage` 与文本冲突时，**上游优先**（口径明确：上游是人工/系统确认的事实，文本是兜底）。',
    covers: '阶段冲突：上游 vs 文本（验证优先级）',
  },
  {
    id: 'G19',
    record: {
      id: 'G19', name: '已签约家居店', monthlyGmv: 300_000, conversionRate: 0.03,
      refundRate: 0.05, avgResponseSec: 25, traffic: 5000, note: '已经签约了',
    },
    expected: { stage: 'converted', category: 'home', scale: 'mid', health: 'healthy', priority: 'p1', pain_point: [] },
    rationale: '无上游 stage，文本「签约了」→ 已转化（文本兜底）。',
    covers: '阶段文本兜底 → 已转化',
  },
  {
    id: 'G20',
    record: {
      id: 'G20', name: '失联数码店', monthlyGmv: 200_000, conversionRate: 0.03,
      refundRate: 0.05, avgResponseSec: 25, traffic: 5000, note: '联系不上，已失联',
    },
    expected: { stage: 'lost', category: '3c', scale: 'mid', health: 'healthy', priority: 'p2', pain_point: [] },
    rationale: '**口径分歧样本**：文本 → 已流失；与 G06 同一口径问题（规则会给 P1，人工期望 P2）。',
    contested: true,
    covers: '阶段文本兜底 → 已流失（同 G06 口径问题）',
  },
  {
    id: 'G21',
    record: { id: 'G21', name: '普通百货店', monthlyGmv: 60_000, conversionRate: 0.03, refundRate: 0.04, avgResponseSec: 25, traffic: 3500 },
    expected: { stage: null, category: 'home', scale: 'long_tail', health: 'healthy', priority: 'p2', pain_point: [] },
    rationale: '全部达标 → 健康；长尾健康 → P2；无记录 → 阶段不打标。',
    covers: '典型 P2（健康长尾）',
  },
  {
    id: 'G22',
    record: { id: 'G22', name: '手工服装店', note: '不会拍短视频，直播没量，同行压价' },
    expected: { stage: 'lead', category: 'apparel', scale: null, health: null, priority: 'p2', pain_point: ['poor_content', 'price_war'] },
    rationale: '无 GMV → 规模不打标；无指标 → 健康度不打标；文本命中「不会拍」「直播没量」（内容弱）与「同行压价」（价格战）。仅靠阶段 → 无风险 → P2。',
    covers: '纯文本输入（无任何数值指标）',
  },
  {
    id: 'G23',
    record: {
      id: 'G23', name: '头部美妆旗舰店', monthlyGmv: 900_000, conversionRate: 0.03,
      refundRate: 0.12, avgResponseSec: 25, traffic: 20_000, stage: 'converted',
    },
    expected: { stage: 'converted', category: 'beauty', scale: 'ka', health: 'at_risk', priority: 'p0', pain_point: ['high_refund'] },
    rationale: '退款 12% 跌破严重线（1 项）→ 亚健康；KA + 有风险 → P0。已转化但仍需干预（大客户退款率影响活动资格）。',
    covers: 'KA + 单点风险（已转化仍 P0）',
  },
  {
    id: 'G24',
    record: {
      id: 'G24', name: '标杆家居店', monthlyGmv: 150_000, conversionRate: 0.035,
      refundRate: 0.05, avgResponseSec: 22, traffic: 8000,
      note: '各项都很好', stage: 'converted',
    },
    expected: { stage: 'converted', category: 'home', scale: 'mid', health: 'healthy', priority: 'p1', pain_point: [] },
    rationale: '全部达标 → 健康；腰部 → P1（腰部即使健康也值得定期维护）。',
    covers: '标杆腰部（健康但非 P2）',
  },
]

/** 统计金标准集覆盖了哪些取值（用于检查样本是否有盲区） */
export function goldenCoverage(): Record<GoldenDimension, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {
    stage: {}, category: {}, scale: {}, health: {}, priority: {}, pain_point: {},
  }
  for (const c of GOLDEN_SET) {
    for (const dim of Object.keys(out)) {
      const v = c.expected[dim as GoldenDimension]
      if (v === null) out[dim]['(不打标)'] = (out[dim]['(不打标)'] ?? 0) + 1
      else if (Array.isArray(v)) {
        if (!v.length) out[dim]['(不打标)'] = (out[dim]['(不打标)'] ?? 0) + 1
        for (const x of v) out[dim][x] = (out[dim][x] ?? 0) + 1
      } else out[dim][v] = (out[dim][v] ?? 0) + 1
    }
  }
  return out as Record<GoldenDimension, Record<string, number>>
}

/**
 * 挑战集：专门用来**证伪**规则的样本。
 *
 * ## 为什么需要它（这是评测方法论的关键）
 *
 * 金标准集（GOLDEN_SET）是按同一份口径标的，规则自然全对 —— 上面跑出来 100%，
 * 但这个 100% **几乎不说明任何问题**，因为它是循环论证：我用口径写规则，
 * 又用口径标答案。
 *
 * 挑战集换一个问法：**真实运营说的话，和关键词表长得一样吗？**
 * 运营不会说「转化低」，他会说「转化不行」「一直没起色」；不会说「响应慢」，
 * 会说「回复要等很久」。这些同义表达是关键词规则的天然盲区。
 *
 * ## 两类失败，处理方式不同
 *
 * | 类型 | 例子 | 处理 |
 * |---|---|---|
 * | **词表覆盖不足** | 「衣服」不在类目词表 | **该修** —— 补词即可，收益明确 |
 * | **否定/时效判断** | 「之前退款多，现在降下来了」 | **不修** —— 关键词规则做不到，属能力边界，正解是 LLM 兜底 |
 *
 * 把「能修的」修掉、把「修不了的」明确记为边界，比假装全对诚实得多。
 */
export const CHALLENGE_SET: GoldenCase[] = [
  {
    id: 'C01',
    record: { id: 'C01', name: '优选衣服店', monthlyGmv: 200_000, conversionRate: 0.03, refundRate: 0.05, avgResponseSec: 25, traffic: 5000 },
    expected: { stage: null, category: 'apparel', scale: 'mid', health: 'healthy', priority: 'p1', pain_point: [] },
    rationale: '人工口径：「衣服」就是服饰鞋包类目（taxonomy 的 criteria 写的是「服装、鞋帽、箱包为主营」）。词表里只有「服装/服饰」，缺「衣服」。',
    covers: '【词表覆盖】类目同义词「衣服」',
  },
  {
    id: 'C02',
    record: { id: 'C02', name: '某某小店', note: '转化不行，一直没起色' },
    expected: { stage: 'lead', category: 'other', scale: null, health: null, priority: 'p2', pain_point: ['low_conversion'] },
    rationale: '人工口径：「转化不行」表达的就是转化率低。词表里有「转化低/转化差」，缺「转化不行」。',
    covers: '【词表覆盖】痛点口语化同义「转化不行」',
  },
  {
    id: 'C03',
    record: { id: 'C03', name: '某某店铺', monthlyGmv: 200_000, conversionRate: 0.03, refundRate: 0.03, avgResponseSec: 25, traffic: 5000, note: '已经没有仅退款问题了' },
    expected: { stage: 'lead', category: 'other', scale: 'mid', health: 'healthy', priority: 'p1', pain_point: [] },
    rationale: '人工口径：文本说的是「问题已解决」，不该打「退款率高」。⚠️ 关键词规则无法识别否定 —— 这是**能力边界**，不是词表问题。',
    covers: '【能力边界】否定句误判（预期失败，记录为局限）',
  },
  {
    id: 'C04',
    record: { id: 'C04', name: '某某店铺', monthlyGmv: 200_000, conversionRate: 0.03, refundRate: 0.04, avgResponseSec: 25, traffic: 5000, note: '之前退款多，现在已经降下来了' },
    expected: { stage: 'lead', category: 'other', scale: 'mid', health: 'healthy', priority: 'p1', pain_point: [] },
    rationale: '人工口径：这是「历史情况 + 已改善」，不该打当前痛点。⚠️ 规则无法识别时态 —— 同为**能力边界**。',
    covers: '【能力边界】时态/改善语义（预期失败，记录为局限）',
  },
  {
    id: 'C05',
    record: { id: 'C05', name: '某某店铺', monthlyGmv: 200_000, conversionRate: 0.03, refundRate: 0.04, avgResponseSec: 25, traffic: 5000, note: '客户问问题回复要等很久' },
    expected: { stage: 'lead', category: 'other', scale: 'mid', health: 'healthy', priority: 'p1', pain_point: ['slow_response'] },
    rationale: '人工口径：「回复要等很久」= 客服响应慢。词表缺这个口语表达。',
    covers: '【词表覆盖】痛点口语「回复要等很久」',
  },
  {
    id: 'C06',
    record: { id: 'C06', name: '某某店铺', monthlyGmv: 200_000, conversionRate: 0.03, refundRate: 0.04, avgResponseSec: 25, traffic: 5000, note: '客服没人理' },
    expected: { stage: 'lead', category: 'other', scale: 'mid', health: 'healthy', priority: 'p1', pain_point: ['slow_response'] },
    rationale: '人工口径：「没人理」= 响应慢。词表里是「咨询没人理」，但运营更常说「客服没人理」。',
    covers: '【词表覆盖】痛点「没人理」',
  },
  {
    id: 'C07',
    record: { id: 'C07', name: '预警店铺', monthlyGmv: 200_000, conversionRate: 0.022, refundRate: 0.09, avgResponseSec: 45, traffic: 2000 },
    expected: { stage: null, category: 'other', scale: 'mid', health: 'at_risk', priority: 'p1', pain_point: [] },
    rationale: '⚠️ **口径缺陷**：四项指标**全部**处于预警区，比「一项严重、三项优秀」更该被关注。但当前口径只数严重项 → 会判「健康」。这是真实的口径漏洞，应修。',
    covers: '【口径缺陷】全项预警 ≠ 健康（预期失败，驱动口径修订）',
  },
  {
    id: 'C08',
    record: { id: 'C08', name: '某某店铺', monthlyGmv: 200_000, conversionRate: 0.03, refundRate: 0.04, avgResponseSec: 25, traffic: 5000, note: '已经加了微信' },
    expected: { stage: 'contacted', category: 'other', scale: 'mid', health: 'healthy', priority: 'p1', pain_point: [] },
    rationale: '人工口径：「已加微信」= 已触达。词表里有「加了微信」，缺「已加微信」。',
    covers: '【词表覆盖】阶段「已加微信」',
  },
  {
    id: 'C09',
    record: { id: 'C09', name: '某某店铺', monthlyGmv: 200_000, conversionRate: 0.03, refundRate: 0.04, avgResponseSec: 25, traffic: 5000, note: '客服响应要 120 秒' },
    expected: { stage: 'lead', category: 'other', scale: 'mid', health: 'healthy', priority: 'p1', pain_point: ['slow_response'] },
    rationale: '人工口径：文本里明确写了 120 秒，显然响应慢。⚠️ 规则只从结构化字段取值，**不抽取文本中的数字** —— 能力边界。',
    covers: '【能力边界】文本内数字未抽取（预期失败，记录为局限）',
  },
  {
    id: 'C10',
    record: { id: 'C10', name: '某某宠物用品店', monthlyGmv: 200_000, conversionRate: 0.03, refundRate: 0.04, avgResponseSec: 25, traffic: 5000 },
    expected: { stage: null, category: 'other', scale: 'mid', health: 'healthy', priority: 'p1', pain_point: [] },
    rationale: '对照组：taxonomy 里没有「宠物」类目，归「其他」是**正确口径**，不是失败。用来验证挑战集本身不会「为了挑错而挑错」。',
    covers: '【对照组】不在体系内的类目应正确归「其他」',
  },
]
