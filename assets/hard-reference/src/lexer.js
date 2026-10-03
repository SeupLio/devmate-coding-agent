/**
 * hard-reference/src/lexer.js —— 参考解：支持 '=' 与 ';'。
 */
function isDigit(c) { return c >= '0' && c <= '9' }
function isAlpha(c) { return /[A-Za-z_]/.test(c) }

function tokenize(src) {
  const tokens = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (/\s/.test(ch)) { i++; continue }
    if (isDigit(ch)) {
      let j = i
      while (j < src.length && (isDigit(src[j]) || src[j] === '.')) j++
      tokens.push({ type: 'num', value: Number(src.slice(i, j)), pos: i })
      i = j
      continue
    }
    if (isAlpha(ch)) {
      let j = i
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++
      tokens.push({ type: 'ident', value: src.slice(i, j), pos: i })
      i = j
      continue
    }
    if (ch === '(' || ch === ')') { tokens.push({ type: ch, value: ch, pos: i }); i++; continue }
    if (ch === '=') { tokens.push({ type: 'assign', value: '=', pos: i }); i++; continue }
    if (ch === ';') { tokens.push({ type: 'sep', value: ';', pos: i }); i++; continue }
    if ('+-*/%'.includes(ch)) { tokens.push({ type: 'op', value: ch, pos: i }); i++; continue }
    throw new Error(`非法字符 '${ch}'（位置 ${i}）`)
  }
  tokens.push({ type: 'eof', value: '', pos: i })
  return tokens
}

module.exports = { tokenize }
