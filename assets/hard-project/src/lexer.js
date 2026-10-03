/**
 * lexer.js —— 表达式词法分析。
 *
 * 把源码字符串切成 token 流。当前只覆盖：数字、标识符、括号、四则运算符。
 * [TODO] 尚未支持 `=`（赋值）与 `;`（语句分隔），遇到会抛「非法字符」。
 */

function isDigit(c) {
  return c >= '0' && c <= '9'
}

function isAlpha(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_'
}

function isAlphaNum(c) {
  return isAlpha(c) || isDigit(c)
}

/**
 * @param {string} src 源码
 * @returns {{type:string, value:any, pos:number}[]} token 流（以 eof 结尾）
 */
function tokenize(src) {
  const tokens = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]

    if (/\s/.test(ch)) {
      i++
      continue
    }

    if (isDigit(ch)) {
      let j = i
      while (j < src.length && (isDigit(src[j]) || src[j] === '.')) j++
      tokens.push({ type: 'num', value: Number(src.slice(i, j)), pos: i })
      i = j
      continue
    }

    if (isAlpha(ch)) {
      let j = i
      while (j < src.length && isAlphaNum(src[j])) j++
      tokens.push({ type: 'ident', value: src.slice(i, j), pos: i })
      i = j
      continue
    }

    if (ch === '(' || ch === ')') {
      tokens.push({ type: ch, value: ch, pos: i })
      i++
      continue
    }

    if ('+-*/%'.includes(ch)) {
      tokens.push({ type: 'op', value: ch, pos: i })
      i++
      continue
    }

    // [TODO] 这里缺少对 '=' 与 ';' 的处理，因此多语句/赋值表达式会在词法阶段就失败
    throw new Error(`非法字符 '${ch}'（位置 ${i}）`)
  }

  tokens.push({ type: 'eof', value: '', pos: i })
  return tokens
}

module.exports = { tokenize }
