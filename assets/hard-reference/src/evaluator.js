/**
 * hard-reference/src/evaluator.js —— 参考解：
 * 数学取模（符号跟随除数）、一元负号、赋值。
 */
function mod(a, b) {
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

module.exports = { evaluateNode }
