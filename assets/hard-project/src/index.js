/**
 * index.js —— 对外 API。
 *
 * evaluate(expr, env?) → number
 *   expr: 表达式源码字符串
 *   env:  可选的初始变量表（会被就地更新）
 */
const { parse } = require('./parser')
const { evaluateNode } = require('./evaluator')

function evaluate(src, env = {}) {
  const ast = parse(src)
  return evaluateNode(ast, env)
}

module.exports = { evaluate }
