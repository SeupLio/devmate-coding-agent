/**
 * hard-reference/src/index.js —— 参考解对外 API（与模板一致）。
 */
const { parse } = require('./parser')
const { evaluateNode } = require('./evaluator')

function evaluate(src, env = {}) {
  const ast = parse(src)
  return evaluateNode(ast, env)
}

module.exports = { evaluate }
