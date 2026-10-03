/**
 * calc.test.js —— 预置测试（FAIL_TO_PASS）。
 *
 * 三组用例当前都无法通过，任务就是让指定分组通过：
 *   precedence —— 运算符优先级 / 一元负号
 *   variables  —— 赋值语句与多语句
 *   golden     —— 与参考实现（tools/reference.js）的输出一致
 *
 * 断言不依赖任何实现细节，只比较 evaluate() 的返回值，
 * 因此不能靠「迁就断言」来刷分。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { evaluate } = require('../src/index.js')

// ===================== 分组 1：precedence =====================

test('precedence: 乘法优先于加法', () => {
  assert.strictEqual(evaluate('2 + 3 * 4'), 14)
})

test('precedence: 括号优先', () => {
  assert.strictEqual(evaluate('(2 + 3) * 4'), 20)
})

test('precedence: 同级左结合', () => {
  assert.strictEqual(evaluate('10 - 2 - 3'), 5)
  assert.strictEqual(evaluate('2 * 3 + 4 * 5'), 26)
  assert.strictEqual(evaluate('20 / 4 / 5'), 1)
})

test('precedence: 一元负号', () => {
  assert.strictEqual(evaluate('-3 + 5'), 2)
  assert.strictEqual(evaluate('-(2 + 3)'), -5)
  assert.strictEqual(evaluate('10 + -4'), 6)
})

// ===================== 分组 2：variables =====================

test('variables: 赋值后可参与运算', () => {
  assert.strictEqual(evaluate('x = 5; x * 2'), 10)
})

test('variables: 多变量与复用', () => {
  assert.strictEqual(evaluate('a = 2; b = a + 3; a * b'), 10)
})

test('variables: 引用未定义变量应报错', () => {
  assert.throws(() => evaluate('y + 1'))
})

test('variables: 赋值结果可作为最后一条语句的值', () => {
  assert.strictEqual(evaluate('z = 7'), 7)
})

// ===================== 分组 3：golden =====================

test('golden: 与参考实现的输出一致', () => {
  const casesPath = path.join(__dirname, '..', 'data', 'cases.json')
  const expectedPath = path.join(__dirname, '..', 'data', 'expected.json')
  const cases = JSON.parse(fs.readFileSync(casesPath, 'utf-8'))
  if (!fs.existsSync(expectedPath)) {
    assert.fail('缺少 data/expected.json —— 请先运行 `node tools/reference.js --emit` 生成')
  }
  const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf-8'))
  for (const expr of cases.expressions) {
    assert.strictEqual(
      evaluate(expr),
      expected[expr],
      `表达式 "${expr}" 结果应为 ${expected[expr]}`,
    )
  }
})
