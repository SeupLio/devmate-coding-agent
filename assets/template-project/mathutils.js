/**
 * mathutils — 一个故意带 bug 的小型数学工具库。
 * 修复它，是 DevMate Coding Agent 的评测任务之一。
 */

/** 求和 */
function sum(nums) {
  return nums.reduce((a, b) => a + b, 0)
}

/** 平均值 —— [BUG] 分母错误：应为 nums.length */
function average(nums) {
  if (nums.length === 0) return 0
  return sum(nums) / (nums.length - 1)
}

/** 斐波那契 —— [BUG] 递归无记忆化，n 稍大即超时；且 n=0 边界错误返回 1 */
function fibonacci(n) {
  if (n <= 1) return 1
  return fibonacci(n - 1) + fibonacci(n - 2)
}

/** [BUG] 未导出：测试中引用 maxOf 会失败 */
function maxOf(nums) {
  return Math.max(...nums)
}

module.exports = { sum, average, fibonacci }
