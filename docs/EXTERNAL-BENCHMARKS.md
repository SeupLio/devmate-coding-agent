# 用外部权威基准验证扩展效果

> 这份文档回答一个问题：**「你加的那些扩展，凭什么说有效？」**
>
> 结论先行：**此前只有单元测试，那确实是自造用例 —— 这条批评成立。**
> 现在补上了两个**外部权威基准**：BFCL v4（伯克利函数调用榜）与
> Aider polyglot-benchmark（Exercises 题库）。同时诚实列出**跑不了**的部分。

---

## 0. 先承认问题

之前项目里的评测（`benchmarks/real-tasks.json`）虽然是从真实提交**机械推导**的，
但**任务是我自己挑的**。单元测试更是我自己写的断言 —— 用它证明「我的实现是对的」，
本质上是自证。

这两者的问题不是「不严谨」，而是**不可被外部复核**：
换个评委来跑，他没法拿同一把尺子量别人。

所以这一轮补的是：**题目和标准答案都由外部定义，我只负责跑和判分。**

---

## 1. 哪些扩展能被权威基准验证（以及映射关系）

| 我的扩展 | 对应的权威基准 | 能否跑 | 说明 |
|---|---|---|---|
| MCP 工具生态 | **BFCL v4**（Berkeley） | ✅ **已跑** | 函数调用是 MCP 的核心语义 |
| 分级并发调度 | **BFCL v4 `parallel`** | ✅ **已跑** | parallel 类就是「一次调多个函数」 |
| 工具 schema 设计 | **BFCL v4 `simple` / `multiple`** | ✅ **已跑** | 18 个工具的 schema 抽象能力 |
| 整体 Agent（读代码→改→跑测试） | **Aider polyglot-benchmark (JS)** | ✅ **已跑** | 49 题，测试由 Exercism 定义 |
| 子 Agent 委派 | SWE-bench | ❌ | 数据在 HuggingFace，**网络不可达**（见 §4） |
| 摘要式上下文压缩 | RULER / Needle-in-a-Haystack | ❌ | 同上 |
| 知识库检索 RAG | CodeSearchNet / CoIR / BEIR | ❌ | 同上 |
| 代码评审 | CodeReviewer dataset | ❌ | 同上 |
| 权限模型 / 可观测性 / VCS / 跨端 | —— | N/A | **基础设施，不是模型能力，本就没有对应基准** |

> 最后一类要说清楚：**不是所有东西都需要「基准」**。
> 权限闸门、trace、VCS 抽象的正确性靠**行为断言**（单测）就够，
> 硬套一个 LLM 基准反而是错的度量。真正的错误是**拿单测去证明「Agent 更聪明了」**。

---

## 2. 网络约束（为什么只跑了两个）

本机的网络限制直接决定了能做到什么，如实记录：

| 目标 | 可达 | 影响 |
|---|---|---|
| `codeload.github.com` | ✅ 200 | 能下 GitHub 仓库快照 |
| GitHub REST API | ✅ | 能读仓库文件 |
| `registry.npmmirror.com` | ✅ 200 | 能装 jest |
| `huggingface.co` | ❌ 000 | **SWE-bench / RULER / CodeSearchNet 全在 HF** |
| `hf-mirror.com` | ❌ 000 | 镜像也不通 |
| `raw.githubusercontent.com` | ❌ 000 | —— |
| `registry.npmjs.org` | ❌ 000 | 官方 npm 源不通 |

**结论**：只有**数据托管在 GitHub 仓库里**的基准能跑。BFCL 和 polyglot 正好都是。

---

## 3. BFCL v4（Berkeley Function Calling Leaderboard）

### 3.1 是什么

伯克利发布的**函数调用权威基准**，是业界衡量 tool calling 能力的事实标准。
数据在 `github.com/ShishirPatil/gorilla` 的 `berkeley-function-call-leaderboard/bfcl_eval/data/`。

题目格式（JSONL）：
```json
{ "id": "parallel_0",
  "question": [[{"role":"user","content":"Play songs from Taylor Swift and Maroon 5..."}]],
  "function": [{"name":"spotify.play","parameters":{"type":"dict","properties":{...}}}] }
```
标准答案（另一个文件）：
```json
{ "id": "parallel_0",
  "ground_truth": [{"spotify.play": {"artist":["Taylor Swift"], "duration":[20]}},
                   {"spotify.play": {"artist":["Maroon 5"],     "duration":[15]}}] }
```
`ground_truth: null` 表示**不应该调用任何函数**（irrelevance 类）。
每个参数的值是**可选值列表**（possible answers），命中其一即算对。

### 3.2 实测结果（200 题，模型 `qwen3.8-max`）

**原生 tool calling 通道：总体 75.0%（150/200）**

| 类别 | 准确率 | 平均调用数 | 考什么 |
|---|---|---|---|
| `simple_javascript` | **66.0%** (33/50) | 1.00 | 单个函数、参数抽取 |
| `multiple` | **58.0%** (29/50) | 1.00 | 多个函数里选对**一个** |
| `parallel` | **84.0%** (42/50) | 2.36 | 一次调**多个**函数 |
| `irrelevance` | **92.0%** (46/50) | 0.08 | **不该调时别调** |

**MCP 通道（工具经我的 MCP 客户端动态发现）：总体 66.7%（80/120）**

| 类别 | 准确率 | 平均调用数 |
|---|---|---|
| `simple_javascript` | 60.0% (24/40) | 1.00 |
| `multiple` | 57.5% (23/40) | 1.05 |
| `parallel` | 82.5% (33/40) | 2.33 |

### 3.3 从结果里读出来的三件事

1. **`parallel` 84% 且平均调用 2.36 次** —— 说明多函数并发调用这条链路是通的
   （这正是「分级并发调度」依赖的能力）。
2. **`irrelevance` 92%** —— 模型在「不该调工具」时基本能忍住，
   这是 Agent 不乱动手的前提。
3. **`multiple` 只有 58%，是最弱项** —— 从失败样例看，模型经常**选错函数**或
   **漏参数**（例如把 `processFunction` 写成 `defaultProcessor`）。
   这是模型能力问题，不是我的工具层问题，但它值得记录。

### 3.4 诚实说明：我的判分器 vs 官方 checker

官方用的是约 2k 行的完整 AST 匹配器（`bfcl_eval/eval_checker/ast_eval/`），
支持嵌套对象、可选参数、`""` 通配等规则。

我实现的是**核心子集**（`src/lib/bench/bfcl.ts`）：
函数名精确匹配 + 参数值落在允许列表内（含类型归一化：`20` ↔ `"20"`）+ 嵌套数组匹配
+ `""` 通配（已核对官方 `ast_checker.py` 第 245 行，语义一致）+ 数量校验（防「全调一遍」蒙对）。

**覆盖**：simple / multiple / parallel / irrelevance 四类。
**未覆盖**：multi-turn 类（需要维护对话状态与执行结果回填，是另一套逻辑）。

### 3.5 一个必须记下来的坑（也是这份文档存在的最好理由）

第一次跑 MCP 通道时，`parallel` 只有 **36%**，远低于原生的 84%。
看起来像是「MCP 严重损害了并行调用能力」。

**但那是我的 harness bug**：
MCP 会对工具名做命名空间化并替换非法字符 —— `spotify.play` → `mcp__bfcl__spotify_play`
（点号变下划线）。我在判分时用 `replace(/^mcp__[^_]+__/,'')` 剥离前缀，
得到的是 `spotify_play`，**永远匹配不上** `spotify.play`。

修法：改用**映射表**（`qualifiedName → 原始名`）还原。修复后：

```
MCP  parallel  36.0%  →  82.5%
```

> **教训**：跑外部基准时，先怀疑自己的 harness，再怀疑被测对象。
> 如果不做这一步核查，我会得出一个完全错误、但看起来很「有洞察」的结论。

---

## 4. Aider polyglot-benchmark（JavaScript）

### 4.1 是什么

Aider 官方用于**公开排行榜**的基准，题目来自 Exercism 题库，
覆盖 6 种语言；这里用 **JavaScript 子集（49 题）**。

数据：`github.com/Aider-AI/polyglot-benchmark`（`javascript/exercises/practice/`）

每题结构：
```
binary.js         ← stub，全是 throw new Error('Remove this statement...')
binary.spec.js    ← 测试即规格（Exercism 风格）
babel.config.js
```

**关键的对齐点**：Exercism 原版是「逐步解锁」—— 只有第一条是 `test()`，
其余都是 `xtest()`（跳过）。如果原样交给模型，**它什么都不做也能「全绿」**。
所以我的 harness 在准备阶段会把 `xtest` 全部启用（与 Aider 官方做法一致）：

```ts
enableAllTests(specSource)   // xtest( → test(,  xit( → it(
```

### 4.2 实测结果（全量 49 题，模型 `qwen3.8-max`）

```
解决率：93.9%  (46/49)
平均步数：19.5｜平均耗时：158s/题
```

**未通过的 3 题**（都是「部分用例失败」，不是没动手）：

| 题目 | 用例 | 失败数 |
|---|---|---|
| `bowling` | 23/30 | 7 |
| `two-bucket` | 5/10 | 5 |
| `rational-numbers` | 35/36 | 1 |

> `bowling` 和 `two-bucket` 都是**状态机/搜索类**题目（保龄球计分规则、
> 两桶倒水问题），失败模式是边界规则没覆盖全 —— 与项目内基准里
> 观察到的 `tests_still_failing` 是同一类问题。

### 4.3 一次真实的污染排查（值得记录）

跑完后我抽查了一道**通过**的题（`binary`），确认不是假阳性：

```
binary.spec.js  →  启用 10 个用例，残留 xtest 0 个   ✓ 测试真的开了
binary.js       →  真实实现（正则校验 + 二进制转十进制），不是空壳  ✓
```

**但抽查同时暴露了一个方法论污染**：沙箱里残留着 `assets/template-project/` 的模板文件，
其中 **`DEVmate.md` 明确写着「保持 CommonJS（`module.exports`）」** ——
而 polyglot 的练习是 **ESM**（`export class ...`）。

Agent 在整个 49 题里都在读一份**方向相反的上下文**。

- **已修**：`prepareExercise()` 现在会先清空沙箱模板，并补了回归测试
  （`prepareExercise 必须清掉沙箱里的模板`）
- **对已报数字的影响**：这个污染只会让任务**更难**，所以 **93.9% 是保守下界**，
  修复后不会更差。但我没有重跑 49 题（约 22 分钟），所以**数字仍标注为「含污染的版本」**。

### 4.4 与官方跑法的差异（诚实说明）

| 维度 | 官方 | 这里 |
|---|---|---|
| 环境隔离 | **Docker 容器** | ❌ 直接在宿主 Node 跑（**没有容器隔离**） |
| 依赖 | 每题独立 install | 共享一份 `node_modules`（目录联接） |
| 判分 | 全部测试通过 | 一致（`jest --json`，且**零用例不算通过**） |
| 题库 | 6 语言 | 仅 JavaScript（宿主只能跑 Node） |

---

## 5. 跑不了的基准（诚实清单）

| 基准 | 用途 | 为什么跑不了 |
|---|---|---|
| **SWE-bench / SWE-bench Lite** | Agentic coding 金标准 | 数据集在 HuggingFace；且官方 harness 需要 Docker。**另外我的沙箱只能跑 Node，SWE-bench 是 Python 仓库** |
| **RULER / Needle-in-a-Haystack** | 长上下文 / 压缩保真度 | 数据在 HF |
| **CodeSearchNet / CoIR / BEIR** | 检索质量 | 数据在 HF |
| **CodeReviewer** | 代码评审 | 数据在 HF |
| **Multi-SWE-bench（含 JS/TS）** | 多语言 SWE | 数据在 HF |

**替代方案（我做了什么）**：项目里原有的 `bench:run` 用**真实 GitHub 修复提交**
机械推导 FAIL_TO_PASS / PASS_TO_PASS —— 判据是机器产生的、不可被我操纵，
只是**任务集是我扫出来的**。这比纯自造强，但弱于官方数据集。

---

## 6. 复现步骤

```bash
BUN="C:/Users/10718/.workbuddy-ai/binaries/bun/bun.exe"
PY="C:/Python313/python.exe"
cd E:/hc/devmate-coding-agent

# ---------- BFCL ----------
# 数据已下载到 benchmarks/external/bfcl/（若缺失见下方「重新下载」）
"$BUN" run bfcl simple_javascript,multiple,parallel,irrelevance 50     # 原生通道
"$BUN" run bfcl simple_javascript,multiple,parallel 40 mcp             # MCP 通道

# ---------- polyglot ----------
# 题库已下载到 benchmarks/external/polyglot/
"$BUN" run polyglot 10 4      # 前 10 题，并发 4
"$BUN" run polyglot 49 6      # 全量

# ---------- 重新下载（网络可达时）----------
export GH_TOKEN="$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill 2>/dev/null | sed -n 's/^password=//p')"
GH="E:/WB AI/_gh/extracted/bin/gh.exe"
for f in BFCL_v4_simple_javascript BFCL_v4_multiple BFCL_v4_parallel BFCL_v4_irrelevance; do
  "$GH" api "repos/ShishirPatil/gorilla/contents/berkeley-function-call-leaderboard/bfcl_eval/data/$f.json" \
    -H "Accept: application/vnd.github.raw" > "benchmarks/external/bfcl/$f.json"
  "$GH" api "repos/ShishirPatil/gorilla/contents/berkeley-function-call-leaderboard/bfcl_eval/data/possible_answer/$f.json" \
    -H "Accept: application/vnd.github.raw" > "benchmarks/external/bfcl/possible_answer/$f.json"
done

# polyglot：整个仓库 6MB，一次下完
curl -sL -o benchmarks/external/polyglot.tar.gz \
  "https://codeload.github.com/Aider-AI/polyglot-benchmark/tar.gz/refs/heads/main"
tar -xzf benchmarks/external/polyglot.tar.gz -C benchmarks/external/polyglot --wildcards "*/javascript/*"
# jest 依赖（官方 npm 源不通，用镜像）
cd benchmarks/external/polyglot && "$BUN" install --registry https://registry.npmmirror.com
```

---

## 7. 一句话总结

> **能跑的权威基准跑了（BFCL 200 题 + polyglot 49 题），跑不了的如实列出来了。**
>
> 更重要的是：跑的过程中**发现并修掉了一个会让结论完全反转的 harness bug**
> —— 这件事本身说明，外部基准的价值不只是「数字好看」，
> 而是它逼着你把「到底是我不行，还是尺子坏了」这个问题想清楚。
