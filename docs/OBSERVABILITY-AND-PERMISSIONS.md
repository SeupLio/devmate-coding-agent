# P0：可观测性 与 权限模型

> 这两件事对应 `docs/RESUME-READINESS.md` 里「决定能不能拿 offer」的前两条：
> **能运营一个 Agent** 和 **敢让 Agent 自主执行写操作**。
>
> 结论先行：**可观测性已经能把「为什么这次没修好」定位到具体 span；
> 权限模型已经能做到「写操作必须人工确认、敏感文件硬拦截」**。
> 但两者都还**不是隔离** —— 真正的隔离仍然要靠容器。

---

## 一、可观测性：从「跑完了」到「跑得怎么样」

### 1.1 数据模型

一次任务 = 一个 **trace**；每次 LLM 往返 / 工具调用 = 一个 **span**。

```
trace (sessionId, task, model, 起止时间, 成本)
 ├─ span [plan]     规划（一次完整 LLM 往返）
 ├─ span [llm]      llm.step1 … llm.stepN
 ├─ span [tool]     read_file / edit_file / run_tests …
 └─ usage           prompt / completion / cached / reasoning tokens
```

`src/lib/agent/trace.ts` 是核心，`trace-store.ts` 负责落盘（`traces/<traceId>.json`）。

### 1.2 成本账本：**区分「免费」和「不知道」**

这是最容易做错的地方。`costCny = 0` 有两种完全不同的含义：

| 情况 | 表现 | 处理 |
|---|---|---|
| 模型确实免费（如 glm-4-flash） | `priceKnown=true, costCny=0` | 显示 ¥0.0000 |
| **模型不在价格表里** | `priceKnown=false` | 显示「未配置单价」，**绝不显示 ¥0** |

报告里会明说：

```
总成本        未配置单价（2/2 次运行的模型不在价格表里）
              设置 MODEL_PRICES='{"模型名":{"in":1.0,"out":2.0}}'（每百万 token 人民币）后可用
```

> 显示一个编造的成本数字比不显示更糟 —— 会让人基于假数据做成本决策。

### 1.3 token 用量的来源要标注

优先用 API 返回的**真实 usage**（`stream_options.include_usage`），拿不到才退回
`length/2` 估算，并在记录里标 `usage.source = 'api' | 'estimated' | 'mixed'`。

实测：当前网关**返回真实 usage**，还带 `prompt_tokens_details.cached_tokens`
—— 于是能算出 **prompt cache 命中率**（生产环境最大的成本杠杆之一）。

### 1.4 实测：报告立刻指出了两个真问题

跑完 P0 冒烟后 `bun run trace:report`：

```
—— 时间花在哪（瓶颈定位）——
  llm         32.6s   98%  █████████████████████████████
  tool        769ms    2%  █

—— prompt cache ——
  命中率 90%（57088/62809）

—— 工具失败率 ——
  multi_edit           2 次  失败 2  (100%) ⚠
```

两个**之前完全看不到**的结论：

1. **时间 98% 花在 LLM 往返，工具只占 2%**。
   所以「优化 Agent 速度」的正确方向是**减少 LLM 往返次数 / 提高 prompt cache 命中**，
   而不是去优化工具实现 —— 这个结论直接改变了优化优先级。
2. **`multi_edit` 失败率 100%**。进一步查 trace 里的 `error` 属性拿到原因：

   ```
   [tool] multi_edit: 错误：第 1 处未找到 old_string（未做任何修改）
   [tool] edit_file:  错误：未找到 old_string。请先用 read_file 确认精确内容（注意缩进/换行/全角半角）。
   ```

   → 不是工具坏了，是**模型给的 `old_string` 与文件内容不匹配**（缩进/空白差异）。
   这是提示词或工具反馈设计要改的地方。

> 这就是可观测性的价值：**它不会让 Agent 变强，但它让「该改哪里」不再靠猜。**

### 1.5 接口

| 接口 / 命令 | 用途 |
|---|---|
| `GET /api/traces` | 最近运行的索引（耗时/成本/瓶颈/是否完成） |
| `GET /api/traces?summary=1` | 聚合：P50/P95、成本、cache 命中率、工具失败率、最慢 span |
| `GET /api/traces?id=<traceId>` | 单次运行**完整 trace**（可回放） |
| `bun run trace:report` | 终端报告 |

---

## 二、权限模型：Agent 会自主写文件，必须有闸门

### 2.1 三层判定

`src/lib/agent/permissions.ts` 是一个**纯函数**（便于测试与回放）：

```
1. 敏感文件？      → 硬 deny（任何模式、任何规则都覆盖不了）
2. 显式 deny 规则？ → deny
3. 破坏性操作？     → ask（bypassPermissions 除外）
4. 显式 allow/ask？ → 按规则（越具体优先级越高）
5. 按权限模式默认策略
```

### 2.2 风险分级

| 级别 | 工具 | 说明 |
|---|---|---|
| `read` | `read_file` `list_files` `glob` `grep` `search_ast` `search_semantic` `todo_write` | 无副作用 |
| `write` | `edit_file` `multi_edit` `write_file` `generate_docx` `generate_pptx` | 改文件 |
| `execute` | `run_command` `run_tests` `git_operation` | 起子进程 |
| `destructive` | 由**命令内容**判定，不是工具名 | `rm -rf` / `git reset --hard` / `git push --force` / `DROP TABLE` … |

> **未知工具（含 MCP）一律按 `execute` 处理** —— 外部行为不可知，保守优先。

### 2.3 权限模式

| 模式 | 读 | 写 | 执行 | 场景 |
|---|---|---|---|---|
| `default` | 放行 | **问** | **问** | 默认，最安全 |
| `acceptEdits` | 放行 | 放行 | **问** | 信任编辑、但仍管命令 |
| `plan` | 放行 | **拒** | **拒** | 只出方案，不动任何东西 |
| `bypassPermissions` | 放行 | 放行 | 放行 | 可信环境 / 自动化评测（**敏感文件仍然拒**） |

### 2.4 敏感文件硬拦截

内置清单：`.env*`、`*.pem/key/p12/pfx/keystore/jks`、`id_rsa/ed25519`、
`.npmrc`、`.git-credentials`、`.aws/`、`.ssh/`、`secrets.*`、`credentials.*`。

命中即 **deny，且不可被规则或模式覆盖** —— 因为一次提示注入就能让 Agent
把密钥写进产物（`public/leak.txt`），这是真实的数据泄露面。

### 2.5 人在环审批（HITL）

判定为 `ask` 时 Agent **暂停**，不是弹个提示继续跑：

```
Agent 循环 ──ask──▶ requestApproval() 挂起
                        │
                        ├─ SSE 推 approval_required（带 requestId）
                        │
                  前端弹卡片 ──用户点允许/拒绝──▶ POST /api/approvals
                        │
                        └─▶ resolveApproval() → 挂起的 Promise 继续
```

**关键设计：超时按「拒绝」处理**（默认 120s）。
没人看着的时候，Agent 不能自己往下走 —— 这是 fail-safe 而不是 fail-open。

### 2.6 审计日志

每次权限判定都记 `{时间, 会话, 工具, 风险, 判定, 最终结果, 理由, 被作用对象}`，
通过 `GET /api/approvals?audit=200` 读取。

### 2.7 实测（`bun run p0:smoke`）

```
▶ 场景 1：plan 模式（只出方案，不动文件）
   权限拒绝：run_tests(execute)
  ✓ 写操作被权限拒绝
  ✓ 没有出现审批请求（plan 直接拒，不该问）

▶ 场景 2：default 模式（写操作需人工审批，自动放行）
   审批请求：run_tests / multi_edit ×2 / run_command / write_file
  ✓ 写操作触发了审批请求
  ✓ 放行后工具确实执行了  — 8 次工具调用
  ✓ 产出了 trace 事件

▶ 场景 3：可观测性（trace 落盘 + 聚合）
  ✓ trace 已落盘  — 2 条
  ✓ 聚合能算出延迟分位  — P50=16277ms P95=24142ms
  ✓ 聚合能算出成本与 token  — 64430 token
  ✓ 时间能按类别归因  — llm, tool

✓ P0 冒烟全部通过（10 通过 / 0 失败）
```

> 顺带一提：**这个冒烟测试当场抓到了一个真 bug** ——
> Agent「正常完成」的那条路径（无工具调用直接给答案）`return` 时漏了收尾 trace，
> 导致最常见的成功路径反而没有可观测性。修掉之后才有上面的数据。

---

## 三、诚实的边界（别把这两层当成隔离）

1. **权限层不是沙箱**。`run_command` 白名单里有 `node`，而 node 是图灵完备的：
   `node -e "require('fs').writeFileSync(...)"` 依然能绕过路径校验。
   权限是**纵深防御的一环**，真正的隔离要靠容器（见 `PRODUCTION-READINESS.md` 第 1 节）。
2. **审批不做持久化**。进程重启后挂起请求自然失效（避免「幽灵授权」），
   但这也意味着长时间挂起的任务会丢。
3. **trace 是本地文件**，没有采样、没有上报、没有 OTel 兼容。
   生产环境应换成 OTLP exporter。
4. **成本单价需要自己配**。价格表里的数字会过时，只求量级正确。
5. **审计日志在内存里**（环形缓冲 2000 条），重启即丢，未落盘。

---

## 四、复现

```bash
bun run p0:smoke        # 权限闸门 + HITL 审批 + 可观测性 端到端冒烟
bun run trace:report    # 可观测性报告（延迟分位 / 成本 / 瓶颈 / 工具失败率）
bun test tests/agent.test.ts   # 104 条单测（含权限/审批/可观测性）
```
