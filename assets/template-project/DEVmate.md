# 项目说明（DEVmate.md）

这份文件会在每次会话开始时自动注入系统提示，用来交代本项目的约定。

## 这是什么

`mathutils` —— 一个数学工具库（当前包含若干已知 bug）。

## 约定

- 保持 CommonJS（`module.exports`），不要改成 ESM。
- **不要删减或改写 `mathutils.test.js` 里的既有用例**（可以新增）。
- 改完代码必须跑 `node --test` 验证；完成后用 git 提交。

## 常用命令

```bash
node --test
```
