# 项目说明（DEVmate.md）

这份文件会在每次会话开始时自动注入系统提示，用来交代本项目的约定。

## 这是什么

一个小型**表达式计算器**，按模块拆分：

```
src/lexer.js      词法分析
src/parser.js     语法分析（递归下降）
src/evaluator.js  求值
src/index.js      对外 API：evaluate(expr, env?)
```

## 约定

- `%` 是**数学取模**（结果符号跟随除数，与 Python 一致），不是 JavaScript 的余数。
  例：`-7 % 3` 应为 `2`，`7 % -3` 应为 `-2`。
- **期望值以参考实现为准**：`node tools/reference.js --emit`。
- **不要修改 `test/` 下的测试文件**（可以新增，但不能删改既有用例）。
- 保持 CommonJS（`require` / `module.exports`）。

## 常用命令

```bash
node --test                                    # 全部测试
node --test --test-name-pattern="precedence"   # 只跑某一组
node tools/reference.js                        # 查看期望值对照表
node tools/trace.js "2 + 3 * 4"                # 打印 token 流与 AST
```
