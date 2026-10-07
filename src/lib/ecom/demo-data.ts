/**
 * 电商服务商场景：演示数据集。
 *
 * ⚠️ **数据是合成的，不是真实业务数据**。
 * 用途是让打标/诊断/话术链路可演示、可测试。真实接入时替换成数仓导出的数据即可，
 * 字段结构（MerchantRecord）保持一致。
 *
 * 设计上刻意覆盖了几种典型情形，便于观察规则是否合理：
 *  - 高价值 + 多风险（应打 P0）
 *  - 健康 + KA（应打 P1 —— KA 始终值得每周维护，不属于 P2 的「价值一般」）
 *  - 长尾 + 无流量（应打 P1）
 *  - 数据缺失（应触发「数据不足」分支而不是硬下结论）
 *  - 文本里带口语化痛点（验证文本信号）
 */
import type { MerchantRecord } from './tagging'

export const DEMO_MERCHANTS: MerchantRecord[] = [
  {
    id: 'M1001',
    name: '轻语女装旗舰店',
    monthlyGmv: 220_000,
    conversionRate: 0.012,
    refundRate: 0.15,
    avgResponseSec: 95,
    traffic: 4200,
    note: '商家说转化率低、退款多，客服也回复慢，想找人帮忙看看',
    stage: 'interested',
  },
  {
    id: 'M1002',
    name: '食光零食铺',
    monthlyGmv: 80_000,
    conversionRate: 0.018,
    refundRate: 0.06,
    avgResponseSec: 40,
    traffic: 2600,
    note: '想做直播但不会拍，短视频也没量',
    stage: 'contacted',
  },
  {
    id: 'M1003',
    name: '木言家居官方店',
    monthlyGmv: 620_000,
    conversionRate: 0.032,
    refundRate: 0.05,
    avgResponseSec: 25,
    traffic: 9200,
    note: '经营比较健康，想争取大促资源位',
    stage: 'converted',
  },
  {
    id: 'M1004',
    name: '小满数码配件',
    monthlyGmv: 45_000,
    conversionRate: 0.021,
    refundRate: 0.07,
    avgResponseSec: 35,
    traffic: 1100,
    note: '同行压价厉害，利润薄，流量也上不来',
    stage: 'lead',
  },
  {
    id: 'M1005',
    name: '柔光美妆工作室',
    monthlyGmv: 150_000,
    conversionRate: 0.009,
    refundRate: 0.12,
    avgResponseSec: 120,
    traffic: 5400,
    note: '已签约，但商家反馈光看不买的多，加购不买',
    stage: 'converted',
  },
  {
    // 故意只给部分指标：验证「数据不足」分支不会硬下结论
    id: 'M1006',
    name: '新芽食品店',
    monthlyGmv: 12_000,
    note: '刚入驻，很多数据还没有',
    stage: 'lead',
  },
]

/** 话术生成用的意图（与 taxonomy 的 SCRIPT_INTENT 对应） */
export const DEMO_INTENTS = ['icebreak', 'diagnose', 'promote', 'retain', 'upsell'] as const
