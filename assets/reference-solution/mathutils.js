/**
 * mathutils 的参考解（人工编写，用于评测灵敏度实验的基线）。
 * 注意：本文件不参与 Agent 沙箱模板，仅作为「已知正确答案」用于校验评测器本身。
 */

function sum(nums) {
  return nums.reduce((a, b) => a + b, 0)
}

function average(nums) {
  if (nums.length === 0) return 0
  return sum(nums) / nums.length
}

function fibonacci(n) {
  if (n < 0) throw new RangeError('n must be >= 0')
  let a = 0
  let b = 1
  for (let i = 0; i < n; i++) {
    const next = a + b
    a = b
    b = next
  }
  return a
}

function maxOf(nums) {
  return Math.max(...nums)
}

function clamp(x, lo, hi) {
  if (x < lo) return lo
  if (x > hi) return hi
  return x
}

module.exports = { sum, average, fibonacci, maxOf, clamp }
