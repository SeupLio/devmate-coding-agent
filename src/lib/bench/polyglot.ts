/**
 * Aider polyglot-benchmark（JavaScript 子集）适配层。
 *
 * ## 为什么用这个
 *
 * 项目内原来的评测任务是**我自己挑的**（哪怕推导过程是机械的）。
 * polyglot-benchmark 是 Aider 官方用于公开排行榜的基准，题目来自 Exercism，
 * **测试用例由外部定义**，我只负责跑和判分。
 *
 * 数据来源：`github.com/Aider-AI/polyglot-benchmark`（`javascript/exercises/practice/`，49 题）
 *
 * ## 与官方跑法的对齐
 *
 * 官方在给模型之前会把测试文件里的 `xtest` 全部启用成 `test`
 * （Exercism 原版是「逐步解锁」模式，只留第一条是 `test`）。
 * 这里同样做 —— 否则模型只要不启用测试就能「通过」，那是评测漏洞。
 *
 * ## 诚实边界
 *
 * - 官方用 Docker 保证环境一致；这里直接在宿主 Node 上跑（**没有容器隔离**）
 * - 官方统计的是「所有测试通过」的题目数，这里一致
 */

import fs from 'node:fs'
import path from 'node:path'

export interface PolyglotExercise {
  /** 目录名，如 `binary` */
  slug: string
  dir: string
  /** 待实现的源文件相对路径 */
  sourceFile: string
  /** 测试文件相对路径 */
  specFile: string
}

/** 列出所有练习（有 `<slug>.spec.js` 的目录才算） */
export function listExercises(root: string): PolyglotExercise[] {
  if (!fs.existsSync(root)) return []
  const out: PolyglotExercise[] = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = path.join(root, entry.name)
    const spec = path.join(dir, `${entry.name}.spec.js`)
    const src = path.join(dir, `${entry.name}.js`)
    if (fs.existsSync(spec) && fs.existsSync(src)) {
      out.push({ slug: entry.name, dir, sourceFile: `${entry.name}.js`, specFile: `${entry.name}.spec.js` })
    }
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug))
}

/**
 * 启用测试文件里所有被跳过的用例（`xtest` / `xit` → `test` / `it`）。
 *
 * 这一步**必须做**：Exercism 原版只启用第一条断言，
 * 不启用的话模型什么都不干也能「全绿」。
 */
export function enableAllTests(specSource: string): { code: string; enabled: number } {
  let enabled = 0
  const code = specSource
    .replace(/\bxtest\s*\(/g, () => {
      enabled++
      return 'test('
    })
    .replace(/\bxit\s*\(/g, () => {
      enabled++
      return 'it('
    })
  return { code, enabled }
}

/**
 * 清空沙箱里的模板文件。
 *
 * ⚠️ 这一步是必须的：`createWorkspace()` 会把 `assets/template-project/` 整个复制进去，
 * 里面有一份 **`DEVmate.md` 明确写着「保持 CommonJS（module.exports）」** ——
 * 而 polyglot 的练习是 **ESM**（`export class ...`）。
 * 不清掉的话，Agent 会读到一份**方向相反的上下文**，这是实打实的方法论污染。
 */
export function clearTemplate(dir: string): number {
  let removed = 0
  if (!fs.existsSync(dir)) return 0
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry)
    try {
      fs.rmSync(p, { recursive: true, force: true })
      removed++
    } catch {
      /* 删不掉的（比如被占用的）跳过 */
    }
  }
  return removed
}

/** 把一道题准备进沙箱目录（返回题面信息） */
export function prepareExercise(
  ex: PolyglotExercise,
  destDir: string,
): { files: string[]; enabledTests: number; clearedTemplate: number } {
  // 先清掉模板，避免 DEVmate.md 等污染上下文
  const clearedTemplate = clearTemplate(destDir)
  fs.mkdirSync(destDir, { recursive: true })
  const copied: string[] = []
  let enabledTests = 0

  for (const f of fs.readdirSync(ex.dir)) {
    const src = path.join(ex.dir, f)
    if (!fs.statSync(src).isFile()) continue
    // 不复制 .eslintrc / .npmrc 之类无关文件
    if (f === '.npmrc' || f === '.eslintrc' || f.startsWith('.')) continue
    if (f === 'package.json' || f === 'LICENSE') continue

    let content = fs.readFileSync(src, 'utf-8')
    if (f === ex.specFile) {
      const r = enableAllTests(content)
      content = r.code
      enabledTests = r.enabled
    }
    fs.writeFileSync(path.join(destDir, f), content, 'utf-8')
    copied.push(f)
  }
  return { files: copied, enabledTests, clearedTemplate }
}

/** 生成给 Agent 的任务提示 */
export function buildTaskPrompt(ex: PolyglotExercise, destDir: string, enabledTests: number): string {
  return [
    `实现 ${ex.sourceFile}，使 ${ex.specFile} 里的**全部测试**通过。`,
    ``,
    `说明：`,
    `- 测试文件已经把所有用例都启用好了（共启用 ${enabledTests} 处），**不要修改测试文件**。`,
    `- 只改 ${ex.sourceFile}（如需新增辅助文件也可以）。`,
    `- 完成后运行 \`npx jest\` 验证；全部通过才算完成。`,
    `- 这是 Exercism 风格的练习，测试即规格 —— 请先读测试再实现。`,
  ].join('\n')
}

export interface JestOutcome {
  passed: number
  failed: number
  total: number
  /** 全部用例通过 */
  ok: boolean
  raw: string
}

/** 解析 jest 的输出（优先用 --json 结果） */
export function parseJestJson(stdout: string): JestOutcome | null {
  try {
    const j = JSON.parse(stdout) as {
      numPassedTests?: number
      numFailedTests?: number
      numTotalTests?: number
      success?: boolean
    }
    const passed = j.numPassedTests ?? 0
    const failed = j.numFailedTests ?? 0
    return {
      passed,
      failed,
      total: j.numTotalTests ?? passed + failed,
      ok: Boolean(j.success) && failed === 0 && passed > 0,
      raw: `${passed} passed / ${failed} failed`,
    }
  } catch {
    return null
  }
}

export interface PolyglotResult {
  slug: string
  ok: boolean
  passed: number
  failed: number
  total: number
  steps: number
  durationMs: number
  /** 失败时的简短原因 */
  reason?: string
}

export function summarizePolyglot(rows: PolyglotResult[]) {
  const solved = rows.filter((r) => r.ok).length
  return {
    total: rows.length,
    solved,
    passRate: rows.length ? solved / rows.length : 0,
    avgSteps: rows.length ? rows.reduce((a, r) => a + r.steps, 0) / rows.length : 0,
    avgDurationMs: rows.length ? rows.reduce((a, r) => a + r.durationMs, 0) / rows.length : 0,
  }
}
