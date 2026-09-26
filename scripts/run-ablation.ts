/**
 * 对照实验 CLI：bun scripts/run-ablation.ts
 *
 * 用法：
 *   bun scripts/run-ablation.ts                                  # 全部实验组 × 全部任务
 *   bun scripts/run-ablation.ts --configs full,bare              # 只跑指定组
 *   bun scripts/run-ablation.ts --tasks fix-bug,ho-slugify       # 只跑指定任务
 *   bun scripts/run-ablation.ts --only holdout --repeat 2        # held-out 集，重复 2 轮
 *   bun scripts/run-ablation.ts --no-bare                        # 不含裸模型组
 *
 * 结果同时写入 ablation-report.json 与 ablation-report.txt（供报告引用）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { runAblation, renderReport } from '../src/lib/eval/ablation'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const configs = arg('configs')?.split(',').filter(Boolean)
  const tasks = arg('tasks')?.split(',').filter(Boolean)
  const only = (arg('only') as 'default' | 'holdout' | 'all') ?? 'default'
  const repeat = Number(arg('repeat') ?? 1) || 1
  const includeBare = !process.argv.includes('--no-bare')

  console.log('========== DevMate 对照实验（ablation）==========')
  const report = await runAblation({
    taskIds: tasks,
    only,
    configIds: configs,
    repeat,
    includeBare,
    onProgress: (m) => console.log(m),
  })

  const text = renderReport(report)
  console.log(text)

  const outDir = path.join(process.cwd(), 'reports')
  fs.mkdirSync(outDir, { recursive: true })
  const prefix = arg('out') ?? 'ablation-report'
  fs.writeFileSync(path.join(outDir, `${prefix}.json`), JSON.stringify(report, null, 2))
  fs.writeFileSync(path.join(outDir, `${prefix}.txt`), text)
  console.log(`\n已写入 reports/${prefix}.json / reports/${prefix}.txt`)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
