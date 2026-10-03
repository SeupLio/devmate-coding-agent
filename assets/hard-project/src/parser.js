/**
 * parser.js —— 递归下降语法分析，把 token 流解析成 AST。
 *
 * [BUG] 当前把**所有二元运算符当成同一优先级、左结合**，
 *       于是 `2 + 3 * 4` 被解析为 `(2 + 3) * 4` = 20，而不是 14。
 * [BUG] 不支持一元负号，`-3 + 5` 会在 parsePrimary 抛错。
 * [TODO] 不支持多语句（`;` 分隔）与赋值（`x = 5`）。
 *
 * 正确语义见 tools/reference.js 与 README.md。
 */
const { tokenize } = require('./lexer')

function parse(src) {
  const tokens = tokenize(src)
  let pos = 0

  const peek = () => tokens[pos]
  const next = () => tokens[pos++]

  // [BUG] 所有运算符同一优先级、左结合
  function parseExpr() {
    let left = parsePrimary()
    while (peek().type === 'op') {
      const op = next().value
      const right = parsePrimary()
      left = { type: 'binary', op, left, right }
    }
    return left
  }

  function parsePrimary() {
    const t = next()
    if (t.type === 'num') return { type: 'num', value: t.value }
    if (t.type === 'ident') return { type: 'ident', name: t.value }
    if (t.type === '(') {
      const e = parseExpr()
      if (next().type !== ')') throw new Error('缺少右括号')
      return e
    }
    throw new Error(`意外的 token：${t.type} "${t.value}"`)
  }

  const expr = parseExpr()
  if (peek().type !== 'eof') {
    throw new Error(`多余输入："${peek().value}"（当前仅支持单条表达式）`)
  }
  return { type: 'program', body: [expr] }
}

module.exports = { parse }
