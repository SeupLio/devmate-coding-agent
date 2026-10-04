# 基准设计：从「自造指标」到「真实任务」

> 这篇文档回答一个问题：**完全用自建指标评测一个 Agent，够不够严谨？**
>
> 答案：**不够** —— 但问题不在「自建」，而在**自造任务**。
> 自造任务只能证明「在你的玩具问题上能跑通」，无法支撑任何对外结论。
> 本文记录这次重构：把评测从「自造题目」换成**真实仓库的真实修复提交**，
> 并把「真实性 / 可验证性 / 防泄露 / 多维度 / 抗游戏性」五条原则落到代码里。

---

## 0. 先承认旧评测的问题

重构前的评测（`docs/EVALUATION.md` 描述的五层体系）在**工程完备度**上其实不差：
有单元测试、有 held-out、有变异测试自检、有失败模式分类。
但它有一个致命短板：

| 问题 | 具体表现 | 后果 |
|---|---|---|
| **任务是人造的** | `mathutils` / `stringutils` / `hard-project` 都是本项目自己写的小项目 | 无法回答「在真实代码库上表现如何」 |
| **期望值是我写的** | 通过与否取决于我预设的断言 | 容易不自觉地把任务设计成「我的 Agent 刚好能做」 |
| **样本量太小** | 4 + 4 + 3 = 11 个任务 | 单轮通过率没有统计意义 |
| **无污染控制** | 没有记录任务出处与时间 | 无法判断成绩是不是「背过题」 |
| **只报通过率** | 过程维度（工具使用、效率、安全）没进结论 | 通过率相同但质量可能差很多 |

**一句话**：旧评测是「内部效度」尚可、「外部效度」为零。

---

## 1. 五条原则怎么落地

### 1.1 真实性 —— 用真实仓库的真实修复提交

**做法**：任务不再手写，而是从真实开源仓库的**真实修复提交**自动构建。

构建流水线（`src/lib/bench/builder.ts`）：

```
真实修复提交 fix
   │
   ├─ base = fix 的父提交        ← 任务开始时仓库的真实状态
   ├─ 拉取 base 的仓库快照        ← codeload.github.com（tar.gz）
   ├─ 把 fix 里的**测试文件**覆盖到 base
   │     （等价于「issue 附带了回归测试」，但 Agent 看不到）
   ├─ 阶段1：跑测试 → 失败集合 = FAIL_TO_PASS 候选
   └─ 阶段2：套用 fix 的**源码**改动 → 再跑 → 必须全通过
                 │
                 └─ 两段都成立 → VALID 任务（参考解 = fix 的源码改动）
```

**关键点**：`FAIL_TO_PASS` 是**机器跑出来的**，不是我写的。
我无法「迁就断言」，因为断言来自上游仓库自己。

当前收录 6 个任务，全部来自真实仓库：

| 任务 | 仓库 | 出处 | FAIL_TO_PASS | PASS_TO_PASS |
|---|---|---|---|---|
| `pfe-whatwg-url` | Rob--W/proxy-from-env | issue #32 | 5 | 120 |
| `pfe-drop-npm-config` | Rob--W/proxy-from-env | issue #13 | 5 | 121 |
| `pfe-esm-migration` | Rob--W/proxy-from-env | issue #18 | 1 | 0 |
| `celjs-source-ranges` | marcbachmann/cel-js | issue #90 | 5 | 7 |
| `celjs-error-compat` | marcbachmann/cel-js | 提交推导 | 4 | 106 |
| `celjs-diagnostics` | marcbachmann/cel-js | 提交推导 | 7 | 0 |

> 任务描述优先用 **issue 原文**（issue 写在修复之前，天然不泄露解法）。
> 没有对应 issue 的提交，`provenance.kind` 标为 `real-commit`，
> 描述由改动范围**中性改写**，并在 `note` 里写明来源 —— **不允许冒充 real-issue**。

### 1.2 可验证性 —— 断言优先，开放任务才用 Judge

- **断言型（`verification.mode = 'tests'`）**：FAIL_TO_PASS / PASS_TO_PASS，
  由 `node --test --test-reporter=tap` 的结构化输出判定，完全自动、无主观。
- **开放型（`'llm-judge'`）**：如「产出一份汇报 PPT」，没有唯一答案，才交给 LLM 裁判。
  但裁判被四道约束锁住（`src/lib/bench/judge.ts`）：
  1. 必须提供 rubric，否则拒绝判定
  2. 强制 JSON 输出
  3. **判 met=true 必须引用产物原文**，引用不出来就不算
  4. 温度 0

  并且 judge 的结果单独标记 `judged: true`，**不与断言型混在一起报通过率**。

### 1.3 防泄露 —— 三层

| 层 | 机制 | 代码位置 |
|---|---|---|
| 测试不进沙箱 | 隐藏测试只在**评测时**从远端覆盖进去，Agent 全程看不到 | `runner.ts` 的 `hiddenTests` |
| 出处可审计 | 每个任务记录 `repo / baseCommit / fixCommit / collectedAt / modelCutoff` | `types.ts` 的 `TaskProvenance` |
| 时间切分 | 任务提交时间早于 `modelCutoff` → 标 `contaminationRisk`，成绩**不得**当作泛化证据 | `report.ts` 的 `contamination` |

报告里会单独统计「存疑 / 未污染」条数，而不是把它们混成一个通过率。

### 1.4 多维度 —— 不只看「过没过」

结果模型（`types.ts`）有五个维度：

| 维度 | 含义 | 怎么算 |
|---|---|---|
| `taskSuccess` | 任务是否达成 | FAIL_TO_PASS 全过 且 PASS_TO_PASS 无回归 |
| `toolUse` | 工具使用是否正确 | 必用工具是否用到、工具报错次数、是否大量绕路 |
| `efficiency` | 效率 | 步数 / 工具调用数 / token / 耗时 / 是否超预算 |
| `safety` | 安全性 | 越界路径、白名单外命令、破坏性删除的尝试次数 |
| `reasoning` | 推理质量 | 仅开放任务，由 LLM judge 给分 |

报告按 **难度 / 类别 / 出处** 三向分组（`report.ts`），
因为「总体通过率 67%」远不如「hard 类 33%、medium 类 100%」有信息量。

### 1.5 抗游戏性

- **测试不在沙箱里** → 没法针对断言写死（最有效的一条）
- **参考解不暴露** → `goldPatchFiles` 只在评测侧统计
- **测试文件受保护** → 任务描述明确要求「不要修改测试文件」，
  且评测时用**上游的测试文件**覆盖，改了也白改
- **变异测试自检** → 沿用 `src/lib/eval/sensitivity.ts`，攻击评测器本身
- **任务池可扩展** → `registry.ts` 加一行种子就能纳入新任务

---

## 2. 怎么跑

```bash
# 1) 构建并验证真实任务（需要 GITHUB_TOKEN；会拉真实仓库快照）
export GITHUB_TOKEN=xxx
export BENCH_NODE_BIN=/path/to/node        # 跑 TAP 测试用
bun scripts/bench-build.ts                 # → benchmarks/real-tasks.json

# 2) 在真实任务上跑 Agent，产出多维报告
bun scripts/bench-run.ts                   # → benchmarks/bench-report.txt / .json
bun scripts/bench-run.ts pfe-whatwg-url    # 只跑一个
```

构建阶段会**如实报告被拒的种子**（`no_fail_at_base` / `gold_incomplete` / …）——
这本身就是一种诚实性检查：如果一个提交在 base 上测试就全过，它根本不是任务。

---

## 3. 实测结果：基准立刻暴露了真问题

首轮跑完 6 个真实任务，结果是 **0% 通过率**。
这个数字本身没意义 —— 有意义的是**为什么**。逐条追下来发现了两个真问题：

### 发现 1：Agent 把步数预算全花在「反复读同一段代码」

抓了一次完整轨迹（`celjs-source-ranges`，30 步上限）：

```
[3]  read_file lib/parser.js offset=400 limit=428
[10] read_file lib/parser.js offset=1   limit=200
[11] read_file lib/parser.js offset=200 limit=200
[12] read_file lib/parser.js offset=400 limit=250   ← 又读了一遍
[13] read_file lib/parser.js offset=650 limit=178
[21] read_file lib/parser.js offset=1   limit=100   ← 再读
[23] read_file lib/parser.js offset=500 limit=150
[24] read_file lib/parser.js offset=650 limit=178   ← 再读
[26] multi_edit lib/parser.js  ← 第 26 步才第一次改代码
[27]~[30] read_file lib/parser.js ...  ← 改完继续读
=== final ===
"Let me look at the test file to understand exactly what's expected, then implement everything properly."
```

**30 步用完了，最后一次改动只有 1 次，收尾时还在「准备动手」。**
`lib/parser.js` 被读了 8 遍以上。

**针对性优化**（已实现，`tools.ts`）：
记录「会话 + 文件 + 行区间 → 内容摘要 + 读取序号」，
若同一区间在**最近 6 次工具调用内**读到完全相同的内容，返回提示而不是全文；
内容变了（比如刚编辑过）则照常返回全文。

> 只压制「近期重复」是刻意的：如果早先结果已被上下文压缩掉，
> 再读时必须正常返回全文，否则 Agent 会永久丢失那段内容。

同时在系统提示里明确「不要重复读取已读区间，需要定位就用 grep / search_ast」。

### 发现 2：失败分类器还停留在「只有 write_file 才算改代码」的时代

加入 `edit_file` / `multi_edit` 之后，`failure-modes.ts` 的
`collectSignals` 仍然只把 `write_file` 计入「改动文件」，
于是 Agent 明明用 `edit_file` 改了 4 次，却被诊断成 `no_edit`（「全程未改动任何文件」）。
同理只认 `run_tests`，不认 `run_command ["node","--test"]`。

已修（并补 2 条回归测试）。**这是典型的「工具集升级后忘了同步下游假设」** ——
如果没有真实任务基准，这个 bug 会一直藏在「自造任务恰好都用 write_file」的舒适区里。

### 优化前后对比（同一批 6 个任务，各跑一轮）

| 指标 | 优化前 | 优化后 |
|---|---|---|
| 完全通过率 | 0% (0/6) | 0% (0/6) |
| 工具使用得分 | 0.87 | **0.92** |
| 平均步数 | 23.7 | 22.8 |
| `pfe-drop-npm-config` F2P | 0/5 | **2/5** |
| `celjs-diagnostics` F2P | 0/7 | **3/7** |
| `pfe-whatwg-url` P2P | 120/120 | 120/120 |

**诚实结论：修复有效但远远不够。** 两个任务的 FAIL_TO_PASS 从 0 变成 2/5 和 3/7
（说明 Agent 确实开始「改对一部分」而不是空转），工具使用得分也上升；
但**没有一个任务被完整解决**，因为瓶颈不在「重复读取」这一处，
而在「面对大仓库时缺乏收敛策略」——它会一直探索到步数耗尽。

这也说明基准的另一层价值：**它能区分「看起来在干活」和「真的做完了」**。
只看工具调用日志，Agent 每轮都很忙；只有 FAIL_TO_PASS 才能戳穿它。

### 结论

> 基准的价值不在于给出一个分数，而在于**它能把 Agent 的真实短板逼出来**。
> 自造任务里 Agent 表现良好，是因为那些任务的文件都小到「读一遍就能改」；
> 一旦换成真实仓库，重复读取 + 步数耗尽的问题立刻暴露。
>
> 当前 DevMate 在这 6 个真实任务上的通过率是 **0%**。
> 这个数字不好看，但它是**可信的**——因为任务来自真实仓库、判据来自上游测试、
> 测试不在沙箱里、参考解已验证可过。**一个可信的 0% 比一个不可信的 90% 有价值得多。**

---

## 4. 已知局限（重要，别把结论说过头）

这份基准比旧的好，但**仍然不等于 SWE-bench**。诚实清单：

1. **PASS_TO_PASS 只覆盖改动到的测试文件**，不是全量测试套件。
   所以「无回归」的保证比 SWE-bench 弱。
   （`pfe-esm-migration` 的 PASS_TO_PASS = 0 就是这个原因：测试文件被整体重写。）
2. **样本量仍然小**：6 个任务，来自 2 个仓库。**没有统计显著性**，
   单轮通过率只能当「定性信号」，不能当「能力分数」。
3. **任务难度偏同质**：都是「改一个库的 bug/特性」，没有跨服务、没有性能任务、
   没有需要读文档/查 API 的任务。
4. **没有 Docker 隔离**：测试跑在宿主 Node 上，
   恶意/跑飞的任务理论上能影响宿主（见 `PRODUCTION-READINESS.md` 第 1 节）。
5. **无 LLM Judge 的实证校验**：judge 有四道约束，但没有做「judge 与人工判定一致率」的校准。
6. **时间切分是保守假设**：`modelCutoff` 取的是保守日期，
   真实训练集边界不可知，所以「未污染」只是**降低**而非**排除**污染。

**结论**：这份基准能支撑的说法是
「DevMate 在 2 个真实开源库的 6 个真实修复任务上表现如何」，
**不能**支撑「DevMate 的编码能力是 X 分」。
要往 SWE-bench 靠，下一步是接 Docker 环境 + 全量测试套件 + 上百个任务。

---

## 5. 与旧评测的关系

新基准**不替代**旧评测，两者互补：

| | 旧评测（`eval/`） | 新基准（`bench/`） |
|---|---|---|
| 任务来源 | 本项目自造模板 | 真实开源仓库 |
| 期望值 | 手写断言 | 机器推导（上游测试） |
| 隔离 | 会话沙箱 | 会话沙箱（同样） |
| 强项 | 快、可控、能跑消融实验 | 真实、可对外 |
| 用途 | 回归门禁 / 机制消融 | 外部效度 / 对外结论 |

单元测试（`tests/agent.test.ts`）继续作为最内层保障。
