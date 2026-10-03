/**
 * trace.js —— 诊断脚本：打印某个表达式的 token 流与 AST。
 *
 * 用法：node tools/trace.js "2 + 3 * 4"
 *
 * 用来观察**当前 src/ 实现**到底把表达式解析成了什么结构，
 * 是定位优先级 / 一元负号问题的环境反馈手段。
 */
const { tokenize } = require('../src/lexer')
const { parse } = require('../src/parser')

const expr = process.argv.slice(2).join(' ')
if (!expr) {
  console.error('用法：node tools/trace.js "表达式"')
  process.exit(1)
}

console.log('表达式：', expr)

try {
  console.log('\n== token 流 ==')
  console.log(JSON.stringify(tokenize(expr), null, 2))
} catch (e) {
  console.log('词法阶段失败：', e.message)
}

try {
  console.log('\n== AST ==')
  console.log(JSON.stringify(parse(expr), null, 2))
} catch (e) {
  console.log('语法阶段失败：', e.message)
}

try {
  const { evaluate } = require('../src/index')
  console.log('\n== 求值结果 ==')
  console.log(evaluate(expr))
} catch (e) {
  console.log('求值阶段失败：', e.message)
}
