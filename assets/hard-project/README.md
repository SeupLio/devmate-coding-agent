# hard-project —— 多文件 / 长链路 / 依赖环境反馈的评测模板

这是一个**刻意做难**的小型表达式计算器项目，用于 DevMate 的高难度评测集。

与 `template-project`（单文件 mathutils）不同，这里的缺陷**跨多个文件**、
修复需要**长链路追踪**，并且关键信息**只能通过运行脚本获得**。

## 目录结构

```
src/lexer.js       词法分析（当前不支持 '=' 与 ';'）
src/parser.js      语法分析（当前优先级错误、无一元负号、无多语句）
src/evaluator.js   求值（当前 % 为 JS 余数、无赋值）
src/index.js       对外 API：evaluate(expr, env?)
test/calc.test.js  预置测试（FAIL_TO_PASS），分三组
tools/reference.js 参考实现（环境反馈 oracle）
tools/trace.js     诊断：打印 token 流与 AST
data/cases.json    表达式用例（期望值需自行生成）
```

## 三组测试

| 分组 | 说明 |
|---|---|
| `precedence` | 运算符优先级、同级左结合、一元负号 |
| `variables` | `;` 分隔的多语句、`x = expr` 赋值 |
| `golden` | 与参考实现 `tools/reference.js` 的输出逐条一致 |

## 运行

```bash
node --test                                   # 全部
node --test --test-name-pattern="precedence"  # 只跑某一组
node tools/reference.js                       # 查看期望值对照表
node tools/reference.js --emit                # 输出期望值 JSON
node tools/trace.js "2 + 3 * 4"               # 诊断：看 token 与 AST
```

## 关键约定

- **取模 `%` 是数学取模**（结果符号跟随除数，与 Python 一致），
  而不是 JavaScript 的余数。具体期望值以 `tools/reference.js` 的输出为准。
- `data/expected.json` 需要自行生成（`golden` 组依赖它）。
- 不要修改 `test/calc.test.js`。
