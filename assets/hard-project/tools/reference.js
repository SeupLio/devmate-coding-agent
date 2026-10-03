/**
 * reference.js —— 参考实现（环境反馈 oracle）。
 *
 * 这是一份**已知正确**的实现，用来回答「这些表达式到底应该等于多少」。
 * 由于测试文件里并没有写死期望值，你**必须运行本脚本**才能拿到它们。
 *
 * 用法：
 *   node tools/reference.js            # 打印用例与期望值对照表
 *   node tools/reference.js --emit     # 只输出 JSON（可直接写入 data/expected.json）
 *   node tools/reference.js "2 + 3*4"  # 计算单个表达式
 *
 * 与 src/ 下实现的语义差异（关键点）：
 *   - 运算符优先级：* / % 高于 + -，同级左结合
 *   - 支持一元负号
 *   - 支持 `;` 分隔的多语句与 `x = expr` 赋值
 *   - `%` 为**数学取模**（结果符号跟随除数，与 Python 一致）：
 *       -7 % 3 === 2     7 % -3 === -2     -7 % -3 === -1
 */
const fs = require('node:fs')
const path = require('node:path')

// ---------------- 词法 ----------------
function tokenize(src) {
  const tokens = []
  let i = 0
  const isDigit = (c) => c >= '0' && c <= '9'
  const isAlpha = (c) => /[A-Za-z_]/.test(c)
  while (i < src.length) {
    const ch = src[i]
    if (/\s/.test(ch)) { i++; continue }
    if (isDigit(ch)) {
      let j = i
      while (j < src.length && (isDigit(src[j]) || src[j] === '.')) j++
      tokens.push({ type: 'num', value: Number(src.slice(i, j)) })
      i = j
      continue
    }
    if (isAlpha(ch)) {
      let j = i
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++
      tokens.push({ type: 'ident', value: src.slice(i, j) })
      i = j
      continue
    }
    if (ch === '(' || ch === ')') { tokens.push({ type: ch, value: ch }); i++; continue }
    if (ch === '=') { tokens.push({ type: 'assign', value: '=' }); i++; continue }
    if (ch === ';') { tokens.push({ type: 'sep', value: ';' }); i++; continue }
    if ('+-*/%'.includes(ch)) { tokens.push({ type: 'op', value: ch }); i++; continue }
    throw new Error(`非法字符 '${ch}'（位置 ${i}）`)
  }
  tokens.push({ type: 'eof', value: '' })
  return tokens
}

// ---------------- 语法（优先级爬升） ----------------
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
    // 赋值：ident '=' expr
    if (peek().type === 'ident' && tokens[pos + 1] && tokens[pos + 1].type === 'assign') {
      const name = next().value
      next() // '='
      const value = parseExpr(0)
      return { type: 'assign', name, value }
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

// ---------------- 求值 ----------------
function mod(a, b) {
  // 数学取模（floored modulo）：结果符号跟随除数
  return ((a % b) + b) % b
}

function evaluateNode(node, env) {
  switch (node.type) {
    case 'program': {
      let last
      for (const stmt of node.body) last = evaluateNode(stmt, env)
      return last
    }
    case 'num':
      return node.value
    case 'ident': {
      if (!(node.name in env)) throw new Error(`未定义变量：${node.name}`)
      return env[node.name]
    }
    case 'unary':
      return -evaluateNode(node.operand, env)
    case 'binary': {
      const a = evaluateNode(node.left, env)
      const b = evaluateNode(node.right, env)
      switch (node.op) {
        case '+': return a + b
        case '-': return a - b
        case '*': return a * b
        case '/': return a / b
        case '%': return mod(a, b)
        default: throw new Error(`未知运算符：${node.op}`)
      }
    }
    case 'assign': {
      const v = evaluateNode(node.value, env)
      env[node.name] = v
      return v
    }
    default:
      throw new Error(`未知节点类型：${node.type}`)
  }
}

function refEvaluate(src, env = {}) {
  return evaluateNode(parse(src), env)
}

// ---------------- CLI ----------------
function main() {
  const args = process.argv.slice(2)

  if (args[0] && !args[0].startsWith('--')) {
    console.log(refEvaluate(args[0]))
    return
  }

  const casesPath = path.join(__dirname, '..', 'data', 'cases.json')
  const cases = JSON.parse(fs.readFileSync(casesPath, 'utf-8'))
  const expected = {}
  for (const expr of cases.expressions) {
    expected[expr] = refEvaluate(expr)
  }

  if (args.includes('--emit')) {
    console.log(JSON.stringify(expected, null, 2))
    return
  }

  console.log('表达式\t期望值')
  console.log('-'.repeat(40))
  for (const expr of cases.expressions) {
    console.log(`${expr}\t${expected[expr]}`)
  }
  console.log('\n提示：用 `node tools/reference.js --emit` 输出可写入 data/expected.json 的 JSON。')
}

if (require.main === module) main()

module.exports = { refEvaluate, parse, tokenize }
