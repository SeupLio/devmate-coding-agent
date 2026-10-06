# 与米哈游「AI 产品全栈开发实习生」JD 的对齐说明

> 目标岗位：米哈游 · AI 产品全栈开发实习生（上海 · 程序&技术类）
>
> 这份文档**逐条**对照 JD，说明项目里有什么、缺什么。
> 缺口不回避 —— 面试时被追问到才知道哪里没准备，比写在简历上被拆穿要好。

---

## 一、工作职责逐条对照

### 1. 参与 Coding Agent 产品的全栈开发（前端、后端、AI 能力接入）

| 层 | 项目里的实现 |
|---|---|
| **前端** | Next.js 16 App Router + React + TypeScript。SSE 流式对话、工具调用卡片、任务清单面板、工作区文件浏览、**代码评审面板**、评测面板、**宿主环境徽标** |
| **后端** | Next.js Route Handlers：`/api/agent`（SSE 流式 Agent）、`/api/review`、`/api/knowledge`、`/api/traces`、`/api/approvals`、`/api/sessions`、`/api/workspace`、`/api/eval`。Prisma + SQLite 持久化会话与消息 |
| **AI 能力接入** | 统一 LLM 抽象（`llm.ts` 路由 + `llm.openai.ts` / `llm.zai.ts` 两个实现），换厂商只改环境变量；工具调用循环、按需规划、思考流式、MCP 外部工具接入 |

✅ **对齐**。三层都有真实实现，不是只有前端页面。

### 2. 代码理解 / 代码生成 / 任务规划 / 自动修改 / 调试辅助 / 代码评审

| 场景 | 实现 |
|---|---|
| 代码理解 | `read_file(offset,limit)` / `glob` / `grep` / **`search_ast`**（AST 符号检索）/ **`search_semantic`**（TF-IDF 语义检索）/ **`search_knowledge`**（文档知识库） |
| 代码生成 | `write_file` / `edit_file`（精确替换）/ `multi_edit`（原子多改）/ `generate_docx` / `generate_pptx` |
| 任务规划 | 独立的规划阶段（结构化输出），支持 `auto`（短任务跳过，省一次 LLM 往返） |
| 自动修改 | 完整工具循环 + 沙箱执行 + git 提交 |
| 调试辅助 | `run_tests` / `run_command`（白名单）/ **可观测性 trace**（失败 span 带首行原因） |
| **代码评审** | **`review_diff` 工具 + `/api/review` + 评审面板**。两层设计：确定性静态检查（密钥/调试残留/缺测试/删断言）+ LLM 语义评审 |

✅ **对齐**。其中「代码评审」是本轮**新增补齐**的（此前完全没有）。

### 3. 大模型应用工程化：上下文管理、工具调用、代码检索、流式交互、任务执行链路、效果评估

| 要求 | 实现 |
|---|---|
| 上下文管理 | **摘要式压缩**（LLM 提炼，失败降级占位符）+ 重复读取抑制 + token 预算 |
| 工具调用 | 16 个内置工具 + MCP 运行时动态发现 + **按副作用分级并发调度** |
| 代码检索 | AST 符号检索 + TF-IDF 语义检索 + glob/grep + 文档知识库检索 |
| 流式交互 | SSE token 级流式 + 思考内容流式 + 工具事件交织 |
| 任务执行链路 | 规划 → 循环(LLM→工具→回填) → 自评审 → 提交 |
| 效果评估 | **五层评测体系** + **真实任务基准**（SWE-bench 式，从真实提交机器推导 FAIL_TO_PASS）+ 失败模式分类 + 评测器灵敏度自检 |

✅ **对齐**，且「效果评估」是这个项目**最强的部分**（见 `docs/BENCHMARK.md`）。

### 4. 面向真实开发环境的工具能力：Git 操作、终端执行、文件编辑、代码索引、知识库检索、**P4 管理**

| 要求 | 实现 | 状态 |
|---|---|---|
| Git 操作 | `git_operation`（status/diff/log/commit） | ✅ 完整 |
| 终端执行 | `run_command`（白名单 + 超时强杀） | ✅ 完整 |
| 文件编辑 | `edit_file` / `multi_edit` / `write_file` | ✅ 完整 |
| 代码索引 | AST 符号索引 + TF-IDF chunk 索引 | ✅ 完整 |
| 知识库检索 | `search_knowledge` + `/api/knowledge` | ✅ **本轮新增** |
| **P4 管理** | **VCS 抽象层**：`VcsProvider` 接口 + `GitProvider`（完整）+ `PerforceProvider`（命令映射已写，**未在真实 P4 服务器验证**） | ⚠️ **部分** |

⚠️ **P4 是最大的诚实缺口**。说明：
- 抽象层是真的（接口隔离、`VCS_PROVIDER` 切换、能力说明）；
- P4 的命令映射（`p4 opened` / `p4 reconcile` / `p4 submit -d`）按官方语义写了；
- 但**没有 P4 服务器可测**，所以我在代码和文档里都明确标注「未验证」，
  并且实现是「探测不到 p4 CLI 就抛出可操作的错误」而不是假装成功；
- 接入真实环境时需要重点核对：**depot ↔ workspace 路径映射**、
  **changelist 管理**、以及「P4 同步下来的文件默认只读，改前必须 `p4 edit`」
  这个 Git 世界里没有对应物的坑。

### 5. 浏览器 / PC 客户端 / UE / Maya 跨端 WebView 体验与性能

实现：`src/lib/host/bridge.ts` + `HostBadge` 组件。

- **宿主探测**：Electron（`electronAPI`）/ UE（`ue`/`ue4`/`__UE__`）/ Maya（`maya`/Qt WebChannel）/ 浏览器
- **统一桥接**：`copyText` / `openFile` / `notify` / `getTheme` / `onThemeChange`
- **能力降级**：能力不可用时返回 `degraded: true` + 原因，**不静默失败**
- **可测性设计**：`detectHost(globals)` 是**纯函数**，全局对象当参数传入 ——
  单测用假 global 覆盖四种宿主，不需要真起一个 UE 编辑器

✅ **对齐**（探测与降级逻辑完整且可测）。⚠️ 但**没有在真实 UE/Maya 里跑过** ——
这是环境限制，不是设计缺陷；单测覆盖的是分支逻辑，不是宿主真实行为。

### 6. 沉淀通用组件、Agent 工程能力和开发工具

- **通用组件**：`components/ui/*`（shadcn）+ `components/agent/*`（ToolCallCard / WorkspacePanel / ReviewPanel / HostBadge / EvalPanel）
- **Agent 工程能力**：`permissions` / `approvals` / `trace` / `mcp` / `subagent` / `vcs` / `review` / `knowledge` —— 都是可独立复用的模块
- **开发工具**：`demo` / `review` / `trace:report` / `mcp:smoke` / `p0:smoke` / `bench:*` 等 CLI

✅ **对齐**。

---

## 二、任职要求逐条对照

| 要求 | 项目证据 |
|---|---|
| AI 应用开发经验（LLM / Agent / RAG / Tool Calling / Prompt Engineering） | LLM 抽象层、Agent 循环、**RAG（知识库检索）**、16 个工具、系统提示词工程（含工具使用纪律） |
| 实际 AI 产品/工具开发经验 | 完整可运行产品：浏览器 UI + 8 个 API + 沙箱 + 一键 demo |
| JS/TS + React/Vue | 全栈 TypeScript；React（Next.js App Router） |
| 产品意识、工程判断力 | 见下 |

**关于「工程判断力」**，项目里有几个刻意的取舍，面试时可以直接讲：

1. **能确定性判断的事不问 LLM** —— 代码评审分两层，`console.log`/硬编码密钥交给静态检查，
   正确性/边界交给 LLM。让模型查 `console.log` 既费 token 又会幻觉。
2. **成本账本区分「免费」和「不知道」** —— 模型不在价格表时显示「未配置单价」而不是 ¥0，
   因为编造的成本数字会让人基于假数据做决策。
3. **权限超时按拒绝**（fail-safe，不是 fail-open）—— 没人看着时 Agent 不能自己往下走。
4. **能力探测与执行必须查同一张表** —— 这个 bug 真的发生过（探测说「✓ 剪贴板」但执行降级了），
   修法是把方法名收敛成一份 `BRIDGE_METHODS`，并补了一条专门的回归测试。
5. **子 Agent 防递归靠工具集而不是深度计数** —— 拿不到 `task` 就天然不能递归。

---

## 三、加分项对照

| 加分项 | 状态 |
|---|---|
| 了解/深度使用 CodeBuddy、Qoder、Codex、Claude Code | ✅ 项目多处**明确对标** Claude Code：`edit_file`/`multi_edit`/`glob`/`grep`/`todo_write`/`DEVmate.md`（对标 `CLAUDE.md`）/权限模式（default/acceptEdits/plan/bypass）/`task` 子 Agent 委派。`docs/PRODUCTION-READINESS.md` 有一张逐项对比表 |
| Coding Agent、AI 编程助手、代码检索、代码生成、自动化开发工作流经验 | ✅ 全部覆盖 |
| 开源项目、技术博客、个人 AI 产品 Demo、**真实用户使用经验** | ⚠️ **Demo 有、开源有（已推 GitHub）；但「真实用户使用经验」没有** |

⚠️ **最大的诚实缺口：没有人用过**。项目已推到 GitHub，但零外部使用者、
没有部署链接、没有用户反馈。这是简历上最容易被追问的地方。

---

## 四、优先级建议（如果继续做）

| 优先级 | 事项 | 为什么 |
|---|---|---|
| **P0** | **部署上线 + 收集真实使用** | 唯一能补「真实用户经验」的路径，也是简历最大缺口 |
| **P1** | 真实 P4 环境验证 VCS 层 | JD 点名 P4；目前只有命令映射，没有实证 |
| **P1** | 真容器沙箱 | 现在的「沙箱」是进程内 + 白名单，`node -e` 可绕过（已在文档里承认） |
| **P2** | 多模型矩阵评测 | 有成本账本了，做这个边际成本很低 |
| **P2** | Hooks（工具调用前后钩子） | 对标 Claude Code 的最后一块 |

---

## 五、一句话总结

> 这份 JD 的六条职责里，**五条有真实实现**（全栈、代码场景、工程化、真实工具、跨端），
> **一条部分实现**（P4 —— 抽象层真实，但没在真实 P4 环境验证）。
>
> 三个明确的诚实缺口：**真实用户使用**、**P4 实证**、**容器级隔离**。
