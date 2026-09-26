/**
 * stringutils — 一个字符串工具库。
 *
 * 这是 DevMate 的 held-out 评测模板：测试文件 stringutils.test.js 已预先写好，
 * 当前无法全部通过。任务是「让指定分组的测试通过」——
 * 断言直接取测试退出码，不依赖任何针对实现细节的正则匹配。
 */

/** 将字符串转为 URL 友好的 slug */
function slugify(text) {
  // [BUG] 未转小写，也未去掉首尾分隔符
  return text.replace(/[^a-zA-Z0-9]+/g, '-')
}

/** 将字符串转为 camelCase */
function camelCase(text) {
  const parts = text.split(/[-_\s]+/).filter(Boolean)
  // [BUG] 后续单词未统一转小写，导致 'foo-BAR' → 'fooBAR' 而非 'fooBar'
  return parts
    .map((p, i) => (i === 0 ? p.toLowerCase() : p[0].toUpperCase() + p.slice(1)))
    .join('')
}

// [TODO] truncate(text, max) 尚未实现
// [TODO] initials(text) 尚未实现

module.exports = { slugify, camelCase }
