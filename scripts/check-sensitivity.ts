/**
 * 评测灵敏度检查 CLI：bun scripts/check-sensitivity.ts
 * 不调用 LLM，秒级完成。
 */
import fs from 'node:fs'
import path from 'node:path'
import { checkSensitivity, renderSensitivity } from '../src/lib/eval/sensitivity'

async function main() {
  const report = await checkSensitivity()
  const text = renderSensitivity(report)
  console.log(text)
  const out = path.join(process.cwd(), 'reports')
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, 'sensitivity-report.json'), JSON.stringify(report, null, 2))
  fs.writeFileSync(path.join(out, 'sensitivity-report.txt'), text)
  console.log('\n已写入 reports/sensitivity-report.json / reports/sensitivity-report.txt')
  process.exit(report.detectionRate === 100 && report.baselinePassed ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
