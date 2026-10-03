/**
 * 文档生成：把结构化内容渲染成真正的 .docx / .pptx 文件。
 *
 * 这是让 DevMate 从「只会改代码」变成「能交付文档」的关键一环：
 * Agent 可以用 generate_docx / generate_pptx 直接把结论产出为可交付文件。
 *
 * 依赖：docx（OOXML Word）、pptxgenjs（OOXML PowerPoint）—— 均为纯 JS 实现，
 * 在 Node 运行时内直接生成，不需要 Office / 不需要联网。
 */
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from 'docx'
import PptxGenJS from 'pptxgenjs'

// ===================== Word (.docx) =====================

export interface DocxSection {
  heading?: string
  paragraphs?: string[]
  bullets?: string[]
}

export interface DocxSpec {
  title?: string
  subtitle?: string
  sections?: DocxSection[]
}

function para(text: string, opts: { bullet?: boolean } = {}) {
  return new Paragraph({
    ...(opts.bullet ? { bullet: { level: 0 } } : {}),
    children: [new TextRun({ text, size: 22 })],
    spacing: { after: 120 },
  })
}

export async function buildDocx(spec: DocxSpec): Promise<Buffer> {
  const children: Paragraph[] = []

  if (spec.title) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.TITLE,
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: spec.title, bold: true })],
      }),
    )
  }
  if (spec.subtitle) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: spec.subtitle, color: '666666', size: 22 })],
        spacing: { after: 240 },
      }),
    )
  }

  for (const sec of spec.sections ?? []) {
    if (sec.heading) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          children: [new TextRun({ text: sec.heading, bold: true })],
          spacing: { before: 200, after: 120 },
        }),
      )
    }
    for (const p of sec.paragraphs ?? []) children.push(para(p))
    for (const b of sec.bullets ?? []) children.push(para(b, { bullet: true }))
  }

  if (!children.length) children.push(para('（空文档）'))

  const doc = new Document({
    creator: 'DevMate',
    title: spec.title ?? 'DevMate 文档',
    sections: [{ children }],
  })
  const buf = await Packer.toBuffer(doc)
  return Buffer.from(buf)
}

// ===================== PowerPoint (.pptx) =====================

export interface PptxSlide {
  title: string
  bullets?: string[]
  /** 备注页内容 */
  notes?: string
}

export interface PptxSpec {
  title?: string
  subtitle?: string
  slides: PptxSlide[]
}

const THEME = {
  bg: 'FFFFFF',
  title: '0A1628',
  accent: '0F766E',
  body: '1F2937',
}

export async function buildPptx(spec: PptxSpec): Promise<Buffer> {
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_16x9'
  pptx.author = 'DevMate'
  pptx.title = spec.title ?? 'DevMate 演示文稿'

  // 封面页
  if (spec.title) {
    const cover = pptx.addSlide()
    cover.background = { color: THEME.bg }
    cover.addShape('rect', { x: 0, y: 2.5, w: 0.18, h: 2.0, fill: { color: THEME.accent } })
    cover.addText(spec.title, {
      x: 0.6, y: 2.6, w: 12.1, h: 1.0,
      fontSize: 34, bold: true, color: THEME.title, breakLine: false,
    })
    if (spec.subtitle) {
      cover.addText(spec.subtitle, { x: 0.65, y: 3.7, w: 12.1, h: 0.7, fontSize: 16, color: '6B7280' })
    }
  }

  // 内容页
  for (const s of spec.slides) {
    const slide = pptx.addSlide()
    slide.background = { color: THEME.bg }
    slide.addShape('rect', { x: 0.5, y: 0.45, w: 0.12, h: 0.5, fill: { color: THEME.accent } })
    slide.addText(s.title, {
      x: 0.75, y: 0.42, w: 11.9, h: 0.7,
      fontSize: 24, bold: true, color: THEME.title,
    })
    if (s.bullets?.length) {
      slide.addText(
        s.bullets.map((b) => ({ text: b, options: { bullet: true, breakLine: true } })),
        { x: 0.85, y: 1.4, w: 11.7, h: 4.6, fontSize: 16, color: THEME.body, lineSpacingMultiple: 1.3 },
      )
    }
    if (s.notes) slide.addNotes(s.notes)
  }

  const out = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer
  return Buffer.from(out)
}

// ===================== 入参校验 =====================

export interface ParseResult<T> {
  ok: boolean
  value?: T
  error?: string
}

export function parseDocxSpec(raw: unknown): ParseResult<DocxSpec> {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'spec 必须是对象' }
  const s = raw as DocxSpec
  const sections = Array.isArray(s.sections) ? s.sections : []
  const hasContent = Boolean(s.title) || sections.some((x) => x?.heading || x?.paragraphs?.length || x?.bullets?.length)
  if (!hasContent) return { ok: false, error: 'spec 至少要有 title 或非空 sections' }
  return {
    ok: true,
    value: {
      title: typeof s.title === 'string' ? s.title : undefined,
      subtitle: typeof s.subtitle === 'string' ? s.subtitle : undefined,
      sections: sections.map((x) => ({
        heading: typeof x?.heading === 'string' ? x.heading : undefined,
        paragraphs: Array.isArray(x?.paragraphs) ? x.paragraphs.map(String) : [],
        bullets: Array.isArray(x?.bullets) ? x.bullets.map(String) : [],
      })),
    },
  }
}

export function parsePptxSpec(raw: unknown): ParseResult<PptxSpec> {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'spec 必须是对象' }
  const s = raw as PptxSpec
  const slides = Array.isArray(s.slides) ? s.slides : []
  if (!slides.length) return { ok: false, error: 'spec.slides 不能为空' }
  const bad = slides.findIndex((x) => !x || typeof x.title !== 'string' || !x.title.trim())
  if (bad >= 0) return { ok: false, error: `第 ${bad + 1} 张幻灯片缺少 title` }
  return {
    ok: true,
    value: {
      title: typeof s.title === 'string' ? s.title : undefined,
      subtitle: typeof s.subtitle === 'string' ? s.subtitle : undefined,
      slides: slides.map((x) => ({
        title: x.title.trim(),
        bullets: Array.isArray(x.bullets) ? x.bullets.map(String) : [],
        notes: typeof x.notes === 'string' ? x.notes : undefined,
      })),
    },
  }
}
