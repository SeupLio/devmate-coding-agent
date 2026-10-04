/**
 * LLM Judge：给**开放式任务**打分（例如「生成一份汇报 PPT」——没有可断言的期望值）。
 *
 * 用 LLM 当裁判很容易退化成「随便给分」，所以这里加了四道约束：
 *  1. **必须提供 rubric**：没有评分标准就不许判（rubric 为空直接报错）
 *  2. **强制结构化输出**：只接受 JSON，逐条给 met + evidence
 *  3. **必须引用证据**：判 met=true 时必须给出产物中的原文片段，否则该条不算数
 *  4. **温度 0**：减少同一产物两次判定不一致
 *
 * 另外：judge 的结果单独记录 `judged: true`，与断言判定的任务区分开 ——
 * 混在一起报通过率会掩盖「哪些结论是硬的、哪些是软的」。
 */
import { chatStream } from '../agent/llm'

export interface JudgeInput {
  task: string
  rubric: string[]
  /** 产物（文档正文 / 文件清单 / 摘要），由调用方准备 */
  artifact: string
}

export interface JudgeItem {
  criterion: string
  met: boolean
  evidence: string
}

export interface JudgeVerdict {
  pass: boolean
  score: number
  items: JudgeItem[]
  rationale: string
}

const JUDGE_SYSTEM = `你是一个严格的任务验收裁判。你会收到「任务描述」「评分标准(rubric)」「产物」。
请逐条判断产物是否满足每条标准。

硬性要求：
- 只输出 JSON，不要输出任何其他文字。
- 对每一条标准，若判定满足(met=true)，必须在 evidence 里引用产物中的**原文片段**；
  引用不出原文的一律判 met=false。
- 不要因为产物「看起来不错」就放宽标准。

输出格式：
{"items":[{"criterion":"...","met":true,"evidence":"原文片段"}],"rationale":"一句话总评"}`

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = fenced ? fenced[1] : text
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end === -1) return null
  try {
    return JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
}

export async function judgeWithLlm(input: JudgeInput): Promise<JudgeVerdict> {
  if (!input.rubric.length) {
    throw new Error('LLM judge 必须提供 rubric（评分标准），否则判定无意义')
  }
  const res = await chatStream(
    [
      { role: 'system', content: JUDGE_SYSTEM },
      {
        role: 'user',
        content: [
          `## 任务\n${input.task}`,
          `## 评分标准\n${input.rubric.map((r, i) => `${i + 1}. ${r}`).join('\n')}`,
          `## 产物\n${input.artifact.slice(0, 12_000)}`,
        ].join('\n\n'),
      },
    ],
    undefined,
    undefined,
    { enableThinking: false },
  )

  const parsed = extractJson(res.content) as { items?: JudgeItem[]; rationale?: string } | null
  if (!parsed?.items?.length) {
    return {
      pass: false,
      score: 0,
      items: [],
      rationale: `裁判输出无法解析为 JSON（原始输出前 200 字：${res.content.slice(0, 200)}）`,
    }
  }

  // 逐条对齐 rubric：缺失的标准按未满足计（防止裁判「少判几条」蒙混）
  const byCriterion = new Map(parsed.items.map((i) => [String(i.criterion), i]))
  const items: JudgeItem[] = input.rubric.map((c) => {
    const hit = byCriterion.get(c) ?? parsed.items!.find((i) => i.criterion?.includes(c.slice(0, 12)))
    const met = Boolean(hit?.met) && Boolean((hit?.evidence ?? '').trim())
    return { criterion: c, met, evidence: hit?.evidence ?? '(裁判未给出证据)' }
  })

  const metCount = items.filter((i) => i.met).length
  return {
    pass: metCount === items.length,
    score: metCount / items.length,
    items,
    rationale: parsed.rationale ?? '',
  }
}
