/**
 * stringutils 的测试套件。
 * 预先写好、当前部分失败 —— 即 SWE-bench 意义上的 FAIL_TO_PASS 用例。
 * 分组：slugify / camelCase / truncate / initials
 */
const test = require('node:test')
const assert = require('node:assert')
const utils = require('./stringutils.js')

test('slugify 基本转换', () => {
  assert.strictEqual(utils.slugify('Hello World'), 'hello-world')
})

test('slugify 去掉首尾分隔符', () => {
  assert.strictEqual(utils.slugify('  Hello World!  '), 'hello-world')
})

test('slugify 折叠连续分隔符', () => {
  assert.strictEqual(utils.slugify('a---b___c'), 'a-b-c')
})

test('camelCase 统一大小写', () => {
  assert.strictEqual(utils.camelCase('foo-BAR_baz'), 'fooBarBaz')
})

test('camelCase 处理空格与多分隔符', () => {
  assert.strictEqual(utils.camelCase('  hello   world  '), 'helloWorld')
})

test('camelCase 单词本身已大写', () => {
  assert.strictEqual(utils.camelCase('FOO_bar'), 'fooBar')
})

test('truncate 超长时截断并加省略号', () => {
  assert.strictEqual(utils.truncate('abcdefghij', 5), 'abcde...')
})

test('truncate 不超长时原样返回', () => {
  assert.strictEqual(utils.truncate('abc', 5), 'abc')
})

test('truncate 边界：长度恰好等于上限', () => {
  assert.strictEqual(utils.truncate('abcde', 5), 'abcde')
})

test('initials 取首字母并大写', () => {
  assert.strictEqual(utils.initials('hello world'), 'HW')
})

test('initials 忽略多余空白', () => {
  assert.strictEqual(utils.initials('  foo   bar  baz '), 'FBB')
})

test('initials 单词本身已大写', () => {
  assert.strictEqual(utils.initials('Alpha beta'), 'AB')
})
