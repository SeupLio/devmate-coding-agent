const test = require('node:test')
const assert = require('node:assert')
const { sum, average, fibonacci, maxOf, clamp } = require('./mathutils.js')

test('sum 求和', () => {
  assert.strictEqual(sum([1, 2, 3]), 6)
  assert.strictEqual(sum([]), 0)
})

test('average 平均值', () => {
  assert.strictEqual(average([2, 4, 6]), 4)
  assert.strictEqual(average([]), 0)
})

test('fibonacci 前几项', () => {
  assert.strictEqual(fibonacci(0), 0)
  assert.strictEqual(fibonacci(1), 1)
  assert.strictEqual(fibonacci(10), 55)
})

test('fibonacci 性能（迭代要求 n=30 不超过 1s）', () => {
  const t0 = Date.now()
  assert.strictEqual(fibonacci(30), 832040)
  const cost = Date.now() - t0
  assert.ok(cost < 1000, `fibonacci(30) 耗时 ${cost}ms，应改为迭代实现`)
})

test('maxOf 最大值', () => {
  assert.strictEqual(maxOf([3, 7, 2]), 7)
})

test('clamp 边界', () => {
  assert.strictEqual(clamp(5, 1, 10), 5)
  assert.strictEqual(clamp(0, 1, 10), 1)
  assert.strictEqual(clamp(99, 1, 10), 10)
})
