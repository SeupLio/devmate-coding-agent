/**
 * evaluator.js —— 对 AST 求值。
 *
 * [BUG] `%` 直接用了 JavaScript 的 `%`（余数，符号跟随被除数），
 *       但本项目约定的是**数学取模**（与 Python 一致，结果符号跟随除数）。
 *       参考实现 tools/reference.js 的 `--emit` 输出为准。
 * [TODO] 尚未实现赋值语句（`x = 5`）与多语句环境。
 */

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
    case 'binary': {
      const a = evaluateNode(node.left, env)
      const b = evaluateNode(node.right, env)
      switch (node.op) {
        case '+':
          return a + b
        case '-':
          return a - b
        case '*':
          return a * b
        case '/':
          return a / b
        case '%':
          // [BUG] JS 余数：-7 % 3 === -1；期望为数学取模 2
          return a % b
        default:
          throw new Error(`未知运算符：${node.op}`)
      }
    }
    case 'assign': {
      // [TODO] 赋值尚未实现
      throw new Error('赋值语句尚未实现')
    }
    default:
      throw new Error(`未知节点类型：${node.type}`)
  }
}

module.exports = { evaluateNode }
