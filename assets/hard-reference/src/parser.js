/**
 * hard-reference/src/parser.js —— 参考解：
 * 运算符优先级（* / % > + -）、同级左结合、一元负号、多语句与赋值。
 */
const { tokenize } = require('./lexer')

const PRECEDENCE = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2 }

function parse(src) {
  const tokens = tokenize(src)
  let pos = 0
  const peek = () => tokens[pos]
  const next = () => tokens[pos++]

  function parseProgram() {
    const body = []
    while (peek().type !== 'eof') {
      body.push(parseStatement())
      if (peek().type === 'sep') next()
      else if (peek().type !== 'eof') throw new Error(`期望 ';' 或结束，得到 "${peek().value}"`)
    }
    return { type: 'program', body }
  }

  function parseStatement() {
    if (peek().type === 'ident' && tokens[pos + 1] && tokens[pos + 1].type === 'assign') {
      const name = next().value
      next()
      return { type: 'assign', name, value: parseExpr(0) }
    }
    return parseExpr(0)
  }

  function parseExpr(minPrec) {
    let left = parseUnary()
    while (peek().type === 'op' && PRECEDENCE[peek().value] > minPrec) {
      const op = next().value
      const right = parseExpr(PRECEDENCE[op])
      left = { type: 'binary', op, left, right }
    }
    return left
  }

  function parseUnary() {
    if (peek().type === 'op' && (peek().value === '-' || peek().value === '+')) {
      const op = next().value
      const operand = parseUnary()
      return op === '-' ? { type: 'unary', op: '-', operand } : operand
    }
    return parsePrimary()
  }

  function parsePrimary() {
    const t = next()
    if (t.type === 'num') return { type: 'num', value: t.value }
    if (t.type === 'ident') return { type: 'ident', name: t.value }
    if (t.type === '(') {
      const e = parseExpr(0)
      if (next().type !== ')') throw new Error('缺少右括号')
      return e
    }
    throw new Error(`意外的 token：${t.type} "${t.value}"`)
  }

  return parseProgram()
}

module.exports = { parse }
