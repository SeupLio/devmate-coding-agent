# stringutils

一个字符串工具库。测试套件（`stringutils.test.js`）已写好，当前无法全部通过。

## 运行测试

```bash
node --test
```

只跑某一组：

```bash
node --test --test-name-pattern="slugify"
```

## 期望的 API

| 函数 | 说明 |
|---|---|
| `slugify(text)` | 转 URL 友好 slug：小写、非字母数字折叠为 `-`、去首尾 `-` |
| `camelCase(text)` | 转小驼峰：`-`/`_`/空格 为分隔，首词小写、后续词首字母大写且其余小写 |
| `truncate(text, max)` | 超过 `max` 时截断为前 `max` 个字符并追加 `...`，否则原样返回 |
| `initials(text)` | 取各词首字母并大写 |
