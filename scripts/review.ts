/**
 * 代码评审 CLI：对某个会话的工作区改动做评审。
 *
 *   bun run review <sessionId> [base]
 *   bun run review --diff <文件路径>        # 直接评审一个 .diff/.patch 文件
 *
 * 会话 id 可以从 `bun run demo` 的输出里拿到，或在浏览器 UI 的 URL / 侧栏里看。
 */
import fs from 'node:fs'
import { reviewDiff, staticChecks, parseDiffStats, formatReview, computeRiskScore } from '../src/lib/agent/review'

const args = process.argv.slice(2)

if (args[0] === '--diff') {
  // 离线模式：评审一个现成的 diff 文件（不需要会话 / 沙箱）
  const file = args[1]
  if (!file || !fs.existsSync(file)) {
    console.error('用法：bun run review --diff <path-to.diff>')
    process.exit(1)
  }
  const diff = fs.readFileSync(file, 'utf-8')
  const findings = staticChecks(diff)
  const stats = parseDiffStats(diff)
  const r = {
    findings,
    summary: findings.length ? `静态检查发现 ${findings.length} 个问题。` : '静态检查未发现问题。',
    riskScore: computeRiskScore(findings),
    stats,
    usedLlm: false,
    durationMs: 0,
  }
  console.log(formatReview(r))
  process.exit(0)
}

const sessionId = args[0]
if (!sessionId) {
  console.error('用法：bun run review <sessionId> [base]')
  console.error('  或：bun run review --diff <path-to.diff>')
  console.error('')
  console.error('提示：先跑 `bun run demo` 会产生一个会话，输出里有 sessionId。')
  process.exit(1)
}

console.log(`评审会话 ${sessionId} 的改动（base=${args[1] ?? 'HEAD'}）…\n`)
const result = await reviewDiff(sessionId, { base: args[1] })
console.log(formatReview(result))
process.exit(result.findings.some((f) => f.severity === 'blocker') ? 2 : 0)
