/**
 * 电商服务商场景：标签体系（Taxonomy）。
 *
 * 对应 JD 第 2、4 条：「业务数据、商家案例、服务商跟进记录的清洗、整理、分类和打标」
 * 「把零散信息整理成结构化内容」。
 *
 * ## 为什么标签体系要单独成一层
 *
 * 打标最怕的就是「标签随手起」—— 今天叫「高价值」，明天叫「优质」，后天两个人
 * 对同一个商家打出不同标签。这里把每个维度的**取值集合、判定口径、排序权重**固定下来，
 * 让打标结果可复现、可统计、可交接。这正是「沉淀高质量基础数据」的前提。
 *
 * 设计原则：
 *  - **纯数据**：这里只有定义，没有逻辑（判定逻辑在 tagging.ts）
 *  - **每个标签有 label（中文展示）+ value（机器值）+ 口径说明**，便于产品/运营对齐
 *  - 维度之间正交，避免「一个标签同时表达两件事」
 */

/** 一个标签取值 */
export interface TagValue {
  /** 机器值（入库、统计用） */
  value: string
  /** 中文展示名 */
  label: string
  /** 判定口径：满足什么条件打这个标（给标注者/运营看的说明） */
  criteria: string
}

/** 一个标签维度 */
export interface TagDimension {
  /** 维度机器名 */
  key: string
  /** 维度中文名 */
  label: string
  /** 是否多选（如「商家痛点」可同时有多个） */
  multi: boolean
  /** 取值集合 */
  values: TagValue[]
}

// ===================== 维度定义 =====================

/** 线索阶段：服务商跟进一条线索的生命周期 */
export const STAGE: TagDimension = {
  key: 'stage',
  label: '线索阶段',
  multi: false,
  values: [
    { value: 'lead', label: '待触达', criteria: '刚录入，尚未首次联系' },
    { value: 'contacted', label: '已触达', criteria: '已完成首次沟通，尚未表达明确意向' },
    { value: 'interested', label: '意向中', criteria: '明确表达合作意向，进入方案沟通' },
    { value: 'converted', label: '已转化', criteria: '已签约 / 已开始合作' },
    { value: 'lost', label: '已流失', criteria: '明确拒绝或长期无响应（>30 天）' },
  ],
}

/** 商家类目：主营商品类目 */
export const CATEGORY: TagDimension = {
  key: 'category',
  label: '商家类目',
  multi: false,
  values: [
    { value: 'apparel', label: '服饰鞋包', criteria: '服装、鞋帽、箱包为主营' },
    { value: 'beauty', label: '美妆个护', criteria: '化妆品、护肤、个人护理' },
    { value: 'food', label: '食品生鲜', criteria: '零食、生鲜、粮油' },
    { value: '3c', label: '3C 数码', criteria: '手机、电脑、数码配件' },
    { value: 'home', label: '家居百货', criteria: '家居用品、日用百货' },
    { value: 'other', label: '其他', criteria: '上述以外或未明确' },
  ],
}

/** 经营健康度：由核心指标综合判定（口径见 diagnosis.ts） */
export const HEALTH: TagDimension = {
  key: 'health',
  label: '经营健康度',
  multi: false,
  values: [
    { value: 'healthy', label: '健康', criteria: '核心指标均达标，无明显短板' },
    { value: 'at_risk', label: '亚健康', criteria: '存在 1 项指标预警，需关注' },
    { value: 'unhealthy', label: '需干预', criteria: '存在 2 项及以上指标预警，需优先跟进' },
  ],
}

/** 商家规模：按月 GMV 分档 */
export const SCALE: TagDimension = {
  key: 'scale',
  label: '商家规模',
  multi: false,
  values: [
    { value: 'ka', label: 'KA（月GMV≥50万）', criteria: '月 GMV ≥ 500,000 元' },
    { value: 'mid', label: '腰部（10~50万）', criteria: '月 GMV 在 100,000 ~ 500,000 元' },
    { value: 'long_tail', label: '长尾（<10万）', criteria: '月 GMV < 100,000 元' },
  ],
}

/** 跟进优先级：服务商该先跟进谁（由健康度 + 规模 + 阶段综合） */
export const PRIORITY: TagDimension = {
  key: 'priority',
  label: '跟进优先级',
  multi: false,
  values: [
    { value: 'p0', label: 'P0 立即跟进', criteria: '高价值 + 高风险，或有明确转化信号' },
    { value: 'p1', label: 'P1 本周跟进', criteria: '中等价值或中等风险' },
    { value: 'p2', label: 'P2 常规维护', criteria: '健康且价值一般，常规触达即可' },
  ],
}

/** 商家痛点：可多选，一条线索常同时有多个痛点 */
export const PAIN_POINT: TagDimension = {
  key: 'pain_point',
  label: '商家痛点',
  multi: true,
  values: [
    { value: 'low_traffic', label: '流量不足', criteria: '曝光/进店量低' },
    { value: 'low_conversion', label: '转化率低', criteria: '有流量但下单转化差' },
    { value: 'high_refund', label: '退款率高', criteria: '退款/退货比例偏高' },
    { value: 'slow_response', label: '客服响应慢', criteria: '平均响应时长过长' },
    { value: 'poor_content', label: '内容/直播弱', criteria: '短视频、直播运营能力不足' },
    { value: 'price_war', label: '价格战压力', criteria: '同质化竞争、利润被压薄' },
  ],
}

/** 话术意图：一段生成话术想达成的目标 */
export const SCRIPT_INTENT: TagDimension = {
  key: 'script_intent',
  label: '话术意图',
  multi: false,
  values: [
    { value: 'icebreak', label: '破冰开场', criteria: '首次触达，建立联系' },
    { value: 'diagnose', label: '诊断建议', criteria: '基于经营数据给出改进建议' },
    { value: 'promote', label: '活动邀约', criteria: '邀约参加平台活动/大促' },
    { value: 'retain', label: '流失挽回', criteria: '针对沉默/流失商家的挽回' },
    { value: 'upsell', label: '增值推荐', criteria: '推荐增值服务/工具' },
  ],
}

/** 全部维度（供前端渲染、校验用） */
export const ALL_DIMENSIONS: TagDimension[] = [
  STAGE, CATEGORY, HEALTH, SCALE, PRIORITY, PAIN_POINT, SCRIPT_INTENT,
]

// ===================== 查询辅助 =====================

export function getDimension(key: string): TagDimension | undefined {
  return ALL_DIMENSIONS.find((d) => d.key === key)
}

/** 校验一个 value 是否属于某维度（防止脏标签入库） */
export function isValidTagValue(dimensionKey: string, value: string): boolean {
  const d = getDimension(dimensionKey)
  if (!d) return false
  return d.values.some((v) => v.value === value)
}

/** 取某维度某取值的中文名（展示用；查不到就原样返回，不报错） */
export function tagLabel(dimensionKey: string, value: string): string {
  const d = getDimension(dimensionKey)
  return d?.values.find((v) => v.value === value)?.label ?? value
}
