/// <reference types="bun-types" />
/**
 * DevMate 单元测试：沙箱安全、工具执行、上下文压缩、AST/语义检索、失败分类。
 * 运行：bun test tests/agent.test.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test, beforeAll } from 'bun:test'
import { createWorkspace, safeResolve, sessionDir, workspaceExists } from '@/lib/agent/workspace'
import { executeTool } from '@/lib/agent/tools'
import { compressContext, totalTokens, CONTEXT_TOKEN_BUDGET } from '@/lib/agent/context'
import { estimateTokens } from '@/lib/agent/llm'
import type { AgentEvent } from '@/lib/agent/loop'

const SID = 'test-session-unit'

beforeAll(() => {
  if (workspaceExists(SID)) {
    fs.rmSync(sessionDir(SID), { recursive: true, force: true })
  }
  createWorkspace(SID)
})

describe('沙箱安全（safeResolve）', () => {
  test('正常相对路径解析到沙箱内', () => {
    const p = safeResolve(SID, 'src/app.js')
    expect(p.startsWith(sessionDir(SID))).toBe(true)
  })

  test('拒绝 .. 目录逃逸', () => {
    expect(() => safeResolve(SID, '../escape.txt')).toThrow()
    expect(() => safeResolve(SID, 'a/../../b.txt')).toThrow()
  })

  test('绝对路径被限制在沙箱内（剥离前导斜杠后落到工作区）', () => {
    const p = safeResolve(SID, '/etc/passwd')
    expect(p.startsWith(sessionDir(SID))).toBe(true)
    expect(p).not.toBe('/etc/passwd')
  })
})

describe('工具执行', () => {
  test('list_files 列出模板文件', async () => {
    const out = await executeTool({ sessionId: SID }, 'list_files', {})
    expect(out).toContain('mathutils.js')
    expect(out).toContain('mathutils.test.js')
  })

  test('write_file + read_file 读写闭环', async () => {
    const content = 'export const x = 42\n'
    await executeTool({ sessionId: SID }, 'write_file', { path: 'tmp/note.js', content })
    const read = await executeTool({ sessionId: SID }, 'read_file', { path: 'tmp/note.js' })
    expect(read).toContain('export const x = 42')
  })

  test('read_file 不存在的文件返回错误信息', async () => {
    const out = await executeTool({ sessionId: SID }, 'read_file', { path: 'nope.js' })
    expect(out).toContain('不存在')
  })

  test('grep 文本检索（files_with_matches / content / count 三种输出）', async () => {
    const files = await executeTool({ sessionId: SID }, 'grep', { pattern: 'fibonacci' })
    expect(files).toContain('mathutils.js')
    const content = await executeTool({ sessionId: SID }, 'grep', {
      pattern: 'function average',
      output_mode: 'content',
    })
    expect(content).toMatch(/mathutils\.js:\d+:/)
    const count = await executeTool({ sessionId: SID }, 'grep', { pattern: 'assert', output_mode: 'count' })
    expect(count).toMatch(/共 \d+ 处命中/)
  })

  test('grep 支持 glob 过滤与非法正则报错', async () => {
    const scoped = await executeTool({ sessionId: SID }, 'grep', { pattern: 'average', glob: '**/*.test.js' })
    expect(scoped).toContain('mathutils.test.js')
    const bad = await executeTool({ sessionId: SID }, 'grep', { pattern: '(' })
    expect(bad).toContain('错误')
  })

  test('glob 按文件名模式定位文件', async () => {
    const out = await executeTool({ sessionId: SID }, 'glob', { pattern: '**/*.test.js' })
    expect(out).toContain('mathutils.test.js')
    const none = await executeTool({ sessionId: SID }, 'glob', { pattern: '**/*.nope' })
    expect(none).toContain('无匹配')
  })

  test('read_file 支持 offset / limit 读片段', async () => {
    const out = await executeTool({ sessionId: SID }, 'read_file', { path: 'mathutils.js', offset: 6, limit: 3 })
    const lines = out.split('\n').filter((l) => l.includes('|'))
    expect(lines.length).toBe(3)
    expect(lines[0]).toContain('    6|')
    expect(lines[2]).toContain('    8|')
  })

  test('read_file 重复读同一区间返回提示而非全文（抑制无效循环），内容变化后恢复', async () => {
    await executeTool({ sessionId: SID }, 'write_file', { path: 'dedup-demo.js', content: 'a\nb\nc\nd\ne\n' })
    const first = await executeTool({ sessionId: SID }, 'read_file', { path: 'dedup-demo.js', offset: 1, limit: 3 })
    expect(first).toContain('1| a')
    const second = await executeTool({ sessionId: SID }, 'read_file', { path: 'dedup-demo.js', offset: 1, limit: 3 })
    expect(second).toContain('重复读取')
    // 文件内容变了 → 必须重新返回全文，不能因为「读过」就把新内容吞掉
    await executeTool({ sessionId: SID }, 'edit_file', { path: 'dedup-demo.js', old_string: 'a', new_string: 'A' })
    const third = await executeTool({ sessionId: SID }, 'read_file', { path: 'dedup-demo.js', offset: 1, limit: 3 })
    expect(third).toContain('1| A')
  })

  test('edit_file 精确替换（唯一命中才允许）', async () => {
    await executeTool({ sessionId: SID }, 'write_file', { path: 'edit-demo.js', content: 'const a = 1\nconst b = 2\n' })
    const ok = await executeTool({ sessionId: SID }, 'edit_file', {
      path: 'edit-demo.js',
      old_string: 'const a = 1',
      new_string: 'const a = 100',
    })
    expect(ok).toContain('已编辑')
    const after = await executeTool({ sessionId: SID }, 'read_file', { path: 'edit-demo.js' })
    expect(after).toContain('const a = 100')
  })

  test('edit_file 找不到 old_string 或命中不唯一时报错', async () => {
    await executeTool({ sessionId: SID }, 'write_file', { path: 'edit-demo2.js', content: 'x = 1\nx = 1\n' })
    const missing = await executeTool({ sessionId: SID }, 'edit_file', {
      path: 'edit-demo2.js',
      old_string: '不存在的内容',
      new_string: 'y',
    })
    expect(missing).toContain('未找到')
    const ambiguous = await executeTool({ sessionId: SID }, 'edit_file', {
      path: 'edit-demo2.js',
      old_string: 'x = 1',
      new_string: 'y',
    })
    expect(ambiguous).toContain('不唯一')
  })

  test('multi_edit 原子性：任一处失败则整体不写入', async () => {
    const original = 'one\ntwo\nthree\n'
    await executeTool({ sessionId: SID }, 'write_file', { path: 'multi.js', content: original })
    const fail = await executeTool({ sessionId: SID }, 'multi_edit', {
      path: 'multi.js',
      edits: [
        { old_string: 'one', new_string: 'ONE' },
        { old_string: 'NOPE', new_string: 'X' },
      ],
    })
    expect(fail).toContain('未做任何修改')
    const after = await executeTool({ sessionId: SID }, 'read_file', { path: 'multi.js' })
    expect(after).toContain('one') // 未被改
    const ok = await executeTool({ sessionId: SID }, 'multi_edit', {
      path: 'multi.js',
      edits: [
        { old_string: 'one', new_string: 'ONE' },
        { old_string: 'three', new_string: 'THREE' },
      ],
    })
    expect(ok).toContain('应用 2 处替换')
  })

  test('todo_write 校验状态并输出清单', async () => {
    const ok = await executeTool({ sessionId: SID }, 'todo_write', {
      todos: [
        { content: '读代码', status: 'completed' },
        { content: '修 bug', status: 'in_progress' },
      ],
    })
    expect(ok).toContain('1/2 已完成')
    expect(ok).toContain('[x]')
    const bad = await executeTool({ sessionId: SID }, 'todo_write', {
      todos: [{ content: 'x', status: 'doing' }],
    })
    expect(bad).toContain('status 非法')
  })

  test('run_command 白名单拦截危险命令', async () => {
    const out = await executeTool({ sessionId: SID }, 'run_command', { command: ['rm', '-rf', '/'] })
    expect(out).toContain('不在白名单')
  })

  test('run_command 白名单内命令正常执行', async () => {
    const out = await executeTool({ sessionId: SID }, 'run_command', { command: ['echo', 'hello-devmate'] })
    expect(out).toContain('hello-devmate')
  })

  test('git_operation status/diff/commit 全链路', async () => {
    // 初始化 git 仓库
    const { runInSandbox } = await import('@/lib/agent/tools')
    await runInSandbox(SID, ['git', 'init'])
    const status = await executeTool({ sessionId: SID }, 'git_operation', { action: 'status' })
    expect(status).toBeDefined()
    await executeTool({ sessionId: SID }, 'write_file', { path: 'git-note.txt', content: 'v1' })
    const commit = await executeTool({ sessionId: SID }, 'git_operation', { action: 'commit', message: 'test: add note' })
    expect(commit).toContain('提交成功')
    const diff = await executeTool({ sessionId: SID }, 'git_operation', { action: 'diff' })
    expect(diff).toBeDefined()
  })

  test('未知工具返回错误', async () => {
    const out = await executeTool({ sessionId: SID }, 'hack_everything', {})
    expect(out).toContain('未知工具')
  })
})

describe('模板项目（预置 bug 场景）', () => {
  test('初始状态测试应失败（存在预埋 bug）', async () => {
    const { runInSandbox } = await import('@/lib/agent/tools')
    const { code } = await runInSandbox(SID, ['node', '--test'])
    expect(code).not.toBe(0)
  })
})

describe('上下文压缩', () => {
  test('预算内不压缩', () => {
    const msgs = [
      { role: 'user' as const, content: 'hi' },
      { role: 'assistant' as const, content: 'hello' },
    ]
    const r = compressContext(msgs)
    expect(r.compressedCount).toBe(0)
  })

  test('超预算时压缩早期工具结果', () => {
    const bigResult = 'x'.repeat(6000)
    const msgs = Array.from({ length: 12 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'tool') as 'user' | 'tool',
      content: i % 2 === 0 ? `任务 ${i}` : bigResult,
    }))
    const before = totalTokens(msgs)
    const r = compressContext(msgs)
    expect(before).toBeGreaterThan(CONTEXT_TOKEN_BUDGET)
    expect(r.compressedCount).toBeGreaterThan(0)
    expect(r.tokensAfter).toBeLessThan(r.tokensBefore)
    const compressed = r.messages.find((m) => m.content?.includes('上下文压缩'))
    expect(compressed).toBeDefined()
  })

  test('token 估算函数', () => {
    expect(estimateTokens('abcd')).toBe(2)
    expect(estimateTokens('')).toBe(0)
  })
})

describe('对照实验支持（ablation）', () => {
  test('filterTools：不传返回全部工具', async () => {
    const { filterTools, TOOLS } = await import('@/lib/agent/tools')
    expect(filterTools().length).toBe(TOOLS.length)
    expect(filterTools().length).toBeGreaterThanOrEqual(15)
    // 关键工具必须存在
    const names = filterTools().map((t) => t.function.name)
    for (const n of [
      'edit_file', 'multi_edit', 'glob', 'grep', 'todo_write',
      'search_ast', 'search_semantic', 'generate_docx', 'generate_pptx',
    ]) {
      expect(names).toContain(n)
    }
  })

  test('filterTools：传空数组返回 0 个（裸模型对照）', async () => {
    const { filterTools } = await import('@/lib/agent/tools')
    expect(filterTools([]).length).toBe(0)
  })

  test('filterTools：子集过滤保留指定工具', async () => {
    const { filterTools } = await import('@/lib/agent/tools')
    const picked = filterTools(['read_file', 'write_file'])
    expect(picked.map((t) => t.function.name).sort()).toEqual(['read_file', 'write_file'])
  })

  test('filterTools：去掉 run_tests 可用于「无自我验证」组', async () => {
    const { filterTools } = await import('@/lib/agent/tools')
    const names = filterTools([
      'list_files', 'read_file', 'write_file', 'grep', 'run_command', 'git_operation',
    ]).map((t) => t.function.name)
    expect(names).not.toContain('run_tests')
    expect(names.length).toBe(6)
  })
})

describe('held-out 任务集（SWE-bench 式 FAIL_TO_PASS）', () => {
  const HO = 'test-session-holdout'

  beforeAll(async () => {
    const { HOLDOUT_TEMPLATE_DIR } = await import('@/lib/agent/workspace')
    if (workspaceExists(HO)) fs.rmSync(sessionDir(HO), { recursive: true, force: true })
    createWorkspace(HO, HOLDOUT_TEMPLATE_DIR)
  })

  test('held-out 模板包含 stringutils 项目', async () => {
    const out = await executeTool({ sessionId: HO }, 'list_files', {})
    expect(out).toContain('stringutils.js')
    expect(out).toContain('stringutils.test.js')
  })

  test('初始状态下全量测试应失败（存在待修复项）', async () => {
    const { runInSandbox } = await import('@/lib/agent/tools')
    const { code } = await runInSandbox(HO, ['node', '--test'])
    expect(code).not.toBe(0)
  })

  test('初始状态下四个分组测试均失败（FAIL_TO_PASS 前置条件）', async () => {
    const { runInSandbox } = await import('@/lib/agent/tools')
    for (const pattern of ['slugify', 'camelCase', 'truncate', 'initials']) {
      const { code } = await runInSandbox(HO, ['node', '--test', `--test-name-pattern=${pattern}`])
      expect(code).not.toBe(0)
    }
  })

  test('held-out 任务集共 4 个，且全部标记为 holdout', async () => {
    const { HOLDOUT_TASKS } = await import('@/lib/eval/tasks')
    expect(HOLDOUT_TASKS.length).toBe(4)
    expect(HOLDOUT_TASKS.every((t) => t.holdout)).toBe(true)
    expect(HOLDOUT_TASKS.every((t) => t.template === 'holdout')).toBe(true)
  })

  test('held-out 断言只依赖预置测试退出码，不含实现细节正则', async () => {
    const { HOLDOUT_TASKS } = await import('@/lib/eval/tasks')
    for (const t of HOLDOUT_TASKS) {
      expect(t.assertions.length).toBe(1)
      expect(t.assertions[0].name).toContain('分组测试通过')
    }
  })
})

describe('对照实验配置', () => {
  test('内置 7 个 ablation 组 + 1 个裸模型组', async () => {
    const { ABLATION_CONFIGS, BARE_CONFIG } = await import('@/lib/eval/ablation')
    expect(ABLATION_CONFIGS.length).toBe(7)
    expect(ABLATION_CONFIGS.map((c) => c.id)).toEqual([
      'full', 'no-plan', 'no-verify', 'no-grep', 'no-ast', 'no-search', 'no-compress',
    ])
    expect(BARE_CONFIG.id).toBe('bare')
  })

  test('「无自我验证」组确实移除了 run_tests', async () => {
    const { ABLATION_CONFIGS } = await import('@/lib/eval/ablation')
    const noVerify = ABLATION_CONFIGS.find((c) => c.id === 'no-verify')!
    expect(noVerify.toolFilter).toBeDefined()
    expect(noVerify.toolFilter).not.toContain('run_tests')
    // 其余工具应当保留（派生自完整工具集）
    expect(noVerify.toolFilter).toContain('search_ast')
    expect(noVerify.toolFilter).toContain('search_semantic')
  })

  test('检索类消融组按预期增删检索工具', async () => {
    const { ABLATION_CONFIGS } = await import('@/lib/eval/ablation')
    const byId = (id: string) => ABLATION_CONFIGS.find((c) => c.id === id)!.toolFilter!
    expect(byId('no-grep')).not.toContain('grep')
    expect(byId('no-grep')).toContain('search_ast')
    expect(byId('no-ast')).not.toContain('search_ast')
    expect(byId('no-ast')).toContain('grep')
    expect(byId('no-search')).not.toContain('grep')
    expect(byId('no-search')).not.toContain('search_ast')
    expect(byId('no-search')).not.toContain('search_semantic')
  })

  test('「无规划」组关闭 plan，「无压缩」组关闭 useCompression', async () => {
    const { ABLATION_CONFIGS } = await import('@/lib/eval/ablation')
    expect(ABLATION_CONFIGS.find((c) => c.id === 'no-plan')!.plan).toBe(false)
    expect(ABLATION_CONFIGS.find((c) => c.id === 'no-compress')!.useCompression).toBe(false)
  })
})

describe('评测防作弊（原有测试用例不可删减）', () => {
  const SID_CHEAT = 'test-session-cheat'
  const SID_LEGIT = 'test-session-legit'

  beforeAll(async () => {
    const refDir = path.join(process.cwd(), 'assets', 'reference-solution')
    for (const sid of [SID_CHEAT, SID_LEGIT]) {
      if (workspaceExists(sid)) fs.rmSync(sessionDir(sid), { recursive: true, force: true })
      createWorkspace(sid)
      for (const f of ['mathutils.js', 'mathutils.test.js', 'README.md']) {
        fs.copyFileSync(path.join(refDir, f), safeResolve(sid, f))
      }
    }
  })

  const fixBugAssertions = async () => {
    const { EVAL_TASKS } = await import('@/lib/eval/tasks')
    return EVAL_TASKS.find((t) => t.id === 'fix-bug')!.assertions
  }

  test('参考解（合法实现）应通过全部断言', async () => {
    for (const a of await fixBugAssertions()) {
      expect(await a.check(SID_LEGIT)).toBe(true)
    }
  })

  test('删空测试文件会被防作弊断言拦住', async () => {
    fs.writeFileSync(safeResolve(SID_CHEAT, 'mathutils.test.js'), `const test = require('node:test')\ntest('ok', () => {})\n`)
    const asserts = await fixBugAssertions()
    const results = await Promise.all(asserts.map((a) => a.check(SID_CHEAT)))
    const cheatIdx = asserts.findIndex((a) => a.name.includes('防作弊'))
    expect(cheatIdx).toBeGreaterThanOrEqual(0)
    expect(results[cheatIdx]).toBe(false)
  })

  test('保留测试名但删掉 assert 同样会被拦住', async () => {
    const refTest = fs.readFileSync(path.join(process.cwd(), 'assets', 'reference-solution', 'mathutils.test.js'), 'utf-8')
    fs.writeFileSync(safeResolve(SID_CHEAT, 'mathutils.test.js'), refTest.replace(/assert\.[A-Za-z]+\(/g, 'void ('))
    const asserts = await fixBugAssertions()
    const cheatIdx = asserts.findIndex((a) => a.name.includes('防作弊'))
    expect(await asserts[cheatIdx].check(SID_CHEAT)).toBe(false)
  })

  test('新增用例（合法行为）不会被误判为作弊', async () => {
    const refTest = fs.readFileSync(path.join(process.cwd(), 'assets', 'reference-solution', 'mathutils.test.js'), 'utf-8')
    fs.writeFileSync(safeResolve(SID_LEGIT, 'mathutils.test.js'), refTest + `\ntest('clamp 补充用例', () => {\n  assert.strictEqual(clamp(1, 1, 5), 1)\n})\n`)
    const asserts = await fixBugAssertions()
    const cheatIdx = asserts.findIndex((a) => a.name.includes('防作弊'))
    expect(await asserts[cheatIdx].check(SID_LEGIT)).toBe(true)
  })
})

describe('评测灵敏度实验配置', () => {
  test('变异体覆盖作弊类与逻辑退化类', async () => {
    const { MUTANTS } = await import('@/lib/eval/sensitivity')
    const kinds = new Set(MUTANTS.map((m) => m.kind))
    expect(kinds.has('cheat')).toBe(true)
    expect(kinds.has('regression')).toBe(true)
    expect(MUTANTS.length).toBeGreaterThanOrEqual(6)
  })

  test('每个变异体都指定了期望检出的目标任务', async () => {
    const { MUTANTS } = await import('@/lib/eval/sensitivity')
    const { ALL_TASKS } = await import('@/lib/eval/tasks')
    const ids = ALL_TASKS.map((t) => t.id)
    for (const m of MUTANTS) {
      expect(ids).toContain(m.targetTaskId)
    }
  })

  test('灵敏度检查：基线通过且变异体全部被检出', async () => {
    const { checkSensitivity } = await import('@/lib/eval/sensitivity')
    const r = await checkSensitivity()
    expect(r.baselinePassed).toBe(true)
    expect(r.detectionRate).toBe(100)
  }, 60000)
})

// ===================== 新增：AST / 语义检索 =====================

describe('AST 结构化检索', () => {
  const SID_AST = 'test-session-ast'

  beforeAll(() => {
    if (workspaceExists(SID_AST)) fs.rmSync(sessionDir(SID_AST), { recursive: true, force: true })
    createWorkspace(SID_AST)
  })

  test('search_ast 能按符号名定位函数定义', async () => {
    const out = await executeTool({ sessionId: SID_AST }, 'search_ast', { query: 'fibonacci', kind: 'function' })
    expect(out).toContain('[function]')
    expect(out).toContain('mathutils.js')
  })

  test('search_ast 能按 kind=call 找出调用点', async () => {
    const out = await executeTool({ sessionId: SID_AST }, 'search_ast', { query: 'sum', kind: 'call' })
    expect(out).toContain('[call]')
  })

  test('AST 检索比 grep 更精确（不受注释/字符串干扰）', async () => {
    const astOut = await executeTool({ sessionId: SID_AST }, 'search_ast', { query: 'fibonacci', kind: 'function' })
    const grepOut = await executeTool({ sessionId: SID_AST }, 'grep', { pattern: 'fibonacci', output_mode: 'count' })
    const astHits = Number(astOut.match(/AST 命中 (\d+)/)?.[1] ?? 0)
    const grepHits = Number(grepOut.match(/共 (\d+) 处/)?.[1] ?? 0)
    expect(astHits).toBe(1)
    expect(astHits).toBeLessThan(grepHits)
  })

  test('索引能识别函数定义与调用关系', async () => {
    const { buildAstIndex } = await import('@/lib/agent/search')
    const idx = buildAstIndex(sessionDir(SID_AST))
    expect(idx.some((s) => s.kind === 'function' && s.name === 'average')).toBe(true)
    expect(idx.some((s) => s.kind === 'call' && s.name === 'sum')).toBe(true)
  })
})

describe('向量语义检索', () => {
  const SID_SEM = 'test-session-sem'

  beforeAll(() => {
    if (workspaceExists(SID_SEM)) fs.rmSync(sessionDir(SID_SEM), { recursive: true, force: true })
    createWorkspace(SID_SEM)
  })

  test('中文自然语言查询可召回相关代码块', async () => {
    const out = await executeTool({ sessionId: SID_SEM }, 'search_semantic', { query: '计算平均值', topK: 3 })
    expect(out).toContain('语义检索 top-')
    expect(out).toContain('相似度')
  })

  test('tokenizeCode 拆分 camelCase 并保留中文 bigram', async () => {
    const { tokenizeCode } = await import('@/lib/agent/search')
    const toks = tokenizeCode('function parseExpression(src) { /* 平均值 */ }')
    expect(toks).toContain('parse')
    expect(toks).toContain('expression')
    expect(toks).toContain('平均')
    // 停用词（如 of / the / function）应被过滤
    expect(toks).not.toContain('function')
  })

  test('语义检索结果按相似度降序', async () => {
    const { searchSemantic } = await import('@/lib/agent/search')
    const hits = searchSemantic(sessionDir(SID_SEM), 'fibonacci 性能 迭代', 5)
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score)
    }
  })
})

// ===================== 新增：难任务集 =====================

describe('难任务集（多文件 / 长链路 / 环境反馈）', () => {
  const SID_HARD = 'test-session-hard'

  beforeAll(async () => {
    const { HARD_TEMPLATE_DIR } = await import('@/lib/agent/workspace')
    if (workspaceExists(SID_HARD)) fs.rmSync(sessionDir(SID_HARD), { recursive: true, force: true })
    createWorkspace(SID_HARD, HARD_TEMPLATE_DIR)
  })

  test('难任务集共 3 个，均使用 hard 模板', async () => {
    const { HARD_TASKS } = await import('@/lib/eval/tasks')
    expect(HARD_TASKS.length).toBe(3)
    expect(HARD_TASKS.every((t) => t.template === 'hard')).toBe(true)
    expect(HARD_TASKS.map((t) => t.id)).toEqual(['hard-precedence', 'hard-variables', 'hard-golden'])
  })

  test('hard 模板是多文件项目', async () => {
    const out = await executeTool({ sessionId: SID_HARD }, 'list_files', {})
    for (const f of ['src/lexer.js', 'src/parser.js', 'src/evaluator.js', 'test/calc.test.js', 'tools/reference.js']) {
      expect(out).toContain(f)
    }
  })

  test('初始状态下三组测试均失败（FAIL_TO_PASS 前置条件）', async () => {
    const { runInSandbox } = await import('@/lib/agent/tools')
    for (const pattern of ['precedence', 'variables', 'golden']) {
      const { code } = await runInSandbox(SID_HARD, ['node', '--test', `--test-name-pattern=${pattern}`])
      expect(code).not.toBe(0)
    }
  }, 30000)

  test('参考实现（oracle）给出的期望值正确', async () => {
    const { runInSandbox } = await import('@/lib/agent/tools')
    const { stdout } = await runInSandbox(SID_HARD, ['node', 'tools/reference.js', '--emit'])
    const expected = JSON.parse(stdout)
    expect(expected['2 + 3 * 4']).toBe(14)
    expect(expected['-7 % 3']).toBe(2)
    expect(expected['7 % -3']).toBe(-2)
  })

  test('golden 防作弊断言：伪造 expected.json 会被拦住', async () => {
    const { HARD_TASKS } = await import('@/lib/eval/tasks')
    const antiCheat = HARD_TASKS.find((t) => t.id === 'hard-golden')!.assertions.find((a) => a.name.includes('真值'))!
    fs.writeFileSync(safeResolve(SID_HARD, 'data/expected.json'), JSON.stringify({ '2 + 3 * 4': 20 }))
    expect(await antiCheat.check(SID_HARD)).toBe(false)
    fs.writeFileSync(
      safeResolve(SID_HARD, 'data/expected.json'),
      JSON.stringify({
        '2 + 3 * 4': 14, '(2 + 3) * 4': 20, '10 - 2 - 3': 5, '-3 + 5': 2,
        '7 % 3': 1, '-7 % 3': 2, '7 % -3': -2, '-7 % -3': -1,
      }),
    )
    expect(await antiCheat.check(SID_HARD)).toBe(true)
  })
})

// ===================== 新增：失败模式分类 =====================

describe('失败模式分类', () => {
  const finalEv = (steps: number, toolCalls: number): AgentEvent => ({
    type: 'final',
    summary: 'done',
    stats: { steps, toolCalls, tokensUsed: 0, durationMs: 1, finished: true },
  })

  test('未改动文件 → no_edit', async () => {
    const { classifyFailure, collectSignals } = await import('@/lib/eval/failure-modes')
    const d = classifyFailure(collectSignals([finalEv(1, 0)], 12), [{ name: '全部测试通过', passed: false }], false)
    expect(d.mode).toBe('no_edit')
  })

  test('改了但没跑测试 → not_verified', async () => {
    const { classifyFailure, collectSignals } = await import('@/lib/eval/failure-modes')
    const events: AgentEvent[] = [
      { type: 'tool_call', id: '1', name: 'write_file', args: { path: 'a.js', content: 'x' } },
      { type: 'tool_result', id: '1', name: 'write_file', result: 'ok', ok: true },
      finalEv(2, 1),
    ]
    const d = classifyFailure(collectSignals(events, 12), [{ name: '全部测试通过', passed: false }], false)
    expect(d.mode).toBe('not_verified')
  })

  test('edit_file / multi_edit 也算「改动文件」（旧实现只认 write_file）', async () => {
    const { collectSignals } = await import('@/lib/eval/failure-modes')
    const events: AgentEvent[] = [
      { type: 'tool_call', id: '1', name: 'edit_file', args: { path: 'a.js' } },
      { type: 'tool_result', id: '1', name: 'edit_file', result: '已编辑 a.js', ok: true },
      { type: 'tool_call', id: '2', name: 'multi_edit', args: { path: 'b.js' } },
      { type: 'tool_result', id: '2', name: 'multi_edit', result: '已应用 2 处替换', ok: true },
      finalEv(3, 2),
    ]
    const sig = collectSignals(events, 12)
    expect(sig.editedFiles).toContain('a.js')
    expect(sig.editedFiles).toContain('b.js')
  })

  test('run_command 跑测试也算「验证过」（旧实现只认 run_tests）', async () => {
    const { collectSignals } = await import('@/lib/eval/failure-modes')
    const events: AgentEvent[] = [
      { type: 'tool_call', id: '1', name: 'run_command', args: { command: ['node', '--test'] } },
      { type: 'tool_result', id: '1', name: 'run_command', result: 'exit code: 1', ok: true },
      finalEv(2, 1),
    ]
    expect(collectSignals(events, 12).ranTests).toBe(true)
  })

  test('跑测试且失败 → tests_still_failing', async () => {
    const { classifyFailure, collectSignals } = await import('@/lib/eval/failure-modes')
    const events: AgentEvent[] = [
      { type: 'tool_call', id: '1', name: 'write_file', args: { path: 'a.js', content: 'x' } },
      { type: 'tool_result', id: '1', name: 'write_file', result: 'ok', ok: true },
      { type: 'tool_call', id: '2', name: 'run_tests', args: {} },
      { type: 'tool_result', id: '2', name: 'run_tests', result: '测试执行完成（exit 1）：通过 2 项，失败 3 项。', ok: true },
      finalEv(3, 2),
    ]
    const d = classifyFailure(collectSignals(events, 12), [{ name: '全部测试通过', passed: false }], false)
    expect(d.mode).toBe('tests_still_failing')
  })

  test('防作弊断言失败 → cheated', async () => {
    const { classifyFailure, collectSignals } = await import('@/lib/eval/failure-modes')
    const events: AgentEvent[] = [
      { type: 'tool_call', id: '1', name: 'write_file', args: { path: 't.test.js', content: '' } },
      { type: 'tool_result', id: '1', name: 'write_file', result: 'ok', ok: true },
      finalEv(2, 1),
    ]
    const d = classifyFailure(collectSignals(events, 12), [{ name: '原有测试用例未被删减（防作弊）', passed: false }], false)
    expect(d.mode).toBe('cheated')
  })

  test('超出步数 → max_steps', async () => {
    const { classifyFailure, collectSignals } = await import('@/lib/eval/failure-modes')
    const signals = collectSignals([], 12, { steps: 12, toolCalls: 9, tokensUsed: 0, durationMs: 1, finished: false })
    const d = classifyFailure(signals, [{ name: '全部测试通过', passed: false }], false)
    expect(d.mode).toBe('max_steps')
  })

  test('通过 → passed', async () => {
    const { classifyFailure, collectSignals } = await import('@/lib/eval/failure-modes')
    expect(classifyFailure(collectSignals([], 12), [], true).mode).toBe('passed')
  })
})

// ===================== 新增：项目记忆（DEVmate.md） =====================

describe('项目记忆（DEVmate.md，对标 CLAUDE.md）', () => {
  const SID_MEM = 'test-session-memory'

  test('模板自带 DEVmate.md，且能被读取', async () => {
    if (workspaceExists(SID_MEM)) fs.rmSync(sessionDir(SID_MEM), { recursive: true, force: true })
    createWorkspace(SID_MEM)
    const { readProjectMemory, PROJECT_MEMORY_FILE } = await import('@/lib/agent/workspace')
    expect(fs.existsSync(safeResolve(SID_MEM, PROJECT_MEMORY_FILE))).toBe(true)
    const mem = readProjectMemory(SID_MEM)
    expect(mem).toBeTruthy()
    expect(mem).toContain('约定')
  })

  test('无 DEVmate.md 时返回 null（不报错）', async () => {
    const sid = 'test-session-memory-none'
    if (workspaceExists(sid)) fs.rmSync(sessionDir(sid), { recursive: true, force: true })
    createWorkspace(sid)
    fs.rmSync(safeResolve(sid, 'DEVmate.md'), { force: true })
    const { readProjectMemory } = await import('@/lib/agent/workspace')
    expect(readProjectMemory(sid)).toBeNull()
  })

  test('内容超长会被截断（避免撑爆系统提示）', async () => {
    const sid = 'test-session-memory-long'
    if (workspaceExists(sid)) fs.rmSync(sessionDir(sid), { recursive: true, force: true })
    createWorkspace(sid)
    fs.writeFileSync(safeResolve(sid, 'DEVmate.md'), 'x'.repeat(9000))
    const { readProjectMemory } = await import('@/lib/agent/workspace')
    const mem = readProjectMemory(sid)!
    expect(mem.length).toBeLessThan(4200)
    expect(mem).toContain('已截断')
  })
})

// ===================== 新增：文档生成（docx / pptx） =====================

describe('文档生成（Word / PPT）', () => {
  const SID_DOC = 'test-session-doc'

  beforeAll(() => {
    if (workspaceExists(SID_DOC)) fs.rmSync(sessionDir(SID_DOC), { recursive: true, force: true })
    createWorkspace(SID_DOC)
  })

  test('generate_docx 产出合法 .docx（PK 头 + 非空）', async () => {
    const out = await executeTool({ sessionId: SID_DOC }, 'generate_docx', {
      path: 'out/报告.docx',
      spec: {
        title: '测试报告',
        subtitle: '自动生成',
        sections: [
          { heading: '背景', paragraphs: ['正文段落'] },
          { heading: '要点', bullets: ['要点一', '要点二'] },
        ],
      },
    })
    expect(out).toContain('已生成 Word 文档')
    const buf = fs.readFileSync(safeResolve(SID_DOC, 'out/报告.docx'))
    expect(buf.length).toBeGreaterThan(2000)
    expect(buf.subarray(0, 2).toString('ascii')).toBe('PK') // ZIP/OOXML 魔数
  })

  test('generate_pptx 产出合法 .pptx（PK 头 + 非空）', async () => {
    const out = await executeTool({ sessionId: SID_DOC }, 'generate_pptx', {
      path: 'out/汇报.pptx',
      spec: {
        title: '汇报标题',
        slides: [{ title: '第一页', bullets: ['x'] }, { title: '第二页' }],
      },
    })
    expect(out).toContain('已生成 PPT')
    const buf = fs.readFileSync(safeResolve(SID_DOC, 'out/汇报.pptx'))
    expect(buf.length).toBeGreaterThan(5000)
    expect(buf.subarray(0, 2).toString('ascii')).toBe('PK')
  })

  test('spec 非法 / 扩展名不符时给出可读错误', async () => {
    const a = await executeTool({ sessionId: SID_DOC }, 'generate_docx', { path: 'x.docx', spec: {} })
    expect(a).toContain('错误')
    const b = await executeTool({ sessionId: SID_DOC }, 'generate_pptx', { path: 'x.pptx', spec: { slides: [] } })
    expect(b).toContain('错误')
    const c = await executeTool({ sessionId: SID_DOC }, 'generate_docx', {
      path: 'x.txt',
      spec: { title: 't', sections: [] },
    })
    expect(c).toContain('.docx')
    const d = await executeTool({ sessionId: SID_DOC }, 'generate_pptx', {
      path: 'y.pptx',
      spec: { slides: [{ bullets: ['没有标题'] }] },
    })
    expect(d).toContain('title')
  })
})

// ===================== 新增：规划启发式（提速） =====================

describe('规划启发式（needsPlan：短任务跳过规划以提速）', () => {
  test('短任务跳过，多要求/长任务保留规划', async () => {
    const { needsPlan } = await import('@/lib/agent/loop')
    // 用户举的例子：应当跳过规划（更快）
    expect(needsPlan('重构斐波那契数列为迭代实现')).toBe(false)
    expect(needsPlan('修 mathutils.js 的 bug 使 node --test 全通过，然后提交。')).toBe(false)
    // 多要求 / 长描述：值得先规划
    expect(needsPlan('修复 bug 并且补充测试，同时更新 README')).toBe(true)
    expect(needsPlan('请分别处理以下三件事，依次完成并提交')).toBe(true)
    expect(needsPlan('把项目里的所有函数都加上类型注解并统一格式化，确保测试通过后提交到 git')).toBe(true)
  })
})

// ===================== 新增：真实任务基准（bench） =====================

describe('真实任务基准（bench）', () => {
  test('isTestPath 正确区分测试文件与源码（构建器靠它挑出隐藏测试）', async () => {
    const { isTestPath } = await import('@/lib/bench/github')
    for (const p of ['test.js', 'test/foo.test.js', 'src/a.spec.ts', 'tests/x.mjs', '__tests__/y.js']) {
      expect(isTestPath(p)).toBe(true)
    }
    for (const p of ['src/index.js', 'lib/evaluator.js', 'package.json', 'README.md']) {
      expect(isTestPath(p)).toBe(false)
    }
  })

  test('toBenchTask 保留可审计的真实出处，并把测试放进隐藏集', async () => {
    const { toBenchTask } = await import('@/lib/bench/builder')
    const t = toBenchTask(
      {
        verdict: 'VALID',
        repo: 'owner/repo',
        fixCommit: 'fixsha',
        baseCommit: 'basesha',
        testFiles: ['test/a.test.js'],
        srcFiles: ['src/a.js'],
        failToPass: ['t1', 't2'],
        passToPass: ['t3'],
      },
      {
        id: 'x',
        prompt: 'p',
        category: 'bug-fix',
        difficulty: 'medium',
        issueNumber: 7,
        testCommand: ['node', '--test'],
        modelCutoff: '2025-06-01',
      },
    )
    expect(t.provenance.kind).toBe('real-issue')
    expect(t.provenance.baseCommit).toBe('basesha')
    expect(t.provenance.issueNumber).toBe(7)
    expect(t.verification.failToPass).toEqual(['t1', 't2'])
    expect(t.verification.passToPass).toEqual(['t3'])
    // 测试只在评测侧拉取 → 不进沙箱
    expect(t.hiddenTests).toEqual([{ path: 'test/a.test.js', ref: 'fixsha' }])
    // 参考解不暴露给 Agent
    expect(t.verification.goldPatchFiles).toEqual(['src/a.js'])
  })

  test('buildReport 按难度/类别/出处分组，并单列污染风险', async () => {
    const { buildReport, formatReport } = await import('@/lib/bench/report')
    const mk = (
      id: string,
      difficulty: 'easy' | 'medium' | 'hard',
      category: 'bug-fix' | 'feature',
      kind: 'real-issue' | 'real-commit',
      success: boolean,
      risk: boolean,
    ) => ({
      taskId: id,
      category,
      difficulty,
      provenanceKind: kind,
      success,
      dimensions: {
        taskSuccess: success,
        toolUse: { score: 1, used: [], missing: [], unexpected: [], erroredCalls: 0 },
        efficiency: { steps: 10, toolCalls: 10, tokens: 100, ms: 1000, overBudget: false },
        safety: { score: 1, violations: [] },
      },
      failureMode: success ? 'passed' : 'tests_still_failing',
      failureEvidence: [],
      assertions: [],
      contaminationRisk: risk,
    })
    const rep = buildReport([
      mk('a', 'easy', 'bug-fix', 'real-issue', true, false) as never,
      mk('b', 'easy', 'bug-fix', 'real-issue', false, false) as never,
      mk('c', 'hard', 'feature', 'real-commit', true, true) as never,
    ])
    expect(rep.taskCount).toBe(3)
    expect(rep.overall.successRate).toBeCloseTo(2 / 3)
    expect(rep.byDifficulty.easy.n).toBe(2)
    expect(rep.byDifficulty.hard.successRate).toBe(1)
    expect(rep.byProvenance['real-commit'].n).toBe(1)
    expect(rep.failureModes.tests_still_failing).toBe(1)
    expect(rep.contamination.atRisk).toBe(1)
    expect(formatReport(rep)).toContain('按出处（真实性）')
  })

  test('LLM judge 缺少 rubric 时拒绝判定（防止「随便给分」）', async () => {
    const { judgeWithLlm } = await import('@/lib/bench/judge')
    await expect(judgeWithLlm({ task: 't', rubric: [], artifact: 'a' })).rejects.toThrow(/rubric/)
  })
})

// ===================== MCP：运行时动态发现工具 =====================

describe('MCP 客户端（动态工具发现）', () => {
  const SERVER = path.join(process.cwd(), 'scripts', 'mcp-demo-server.ts')
  let client: import('@/lib/agent/mcp').McpClient

  beforeAll(async () => {
    const { McpClient } = await import('@/lib/agent/mcp')
    client = await McpClient.connect({
      name: 'demo',
      command: process.execPath, // 当前运行时（bun）可直接跑 .ts
      args: [SERVER],
      timeoutMs: 10_000,
    })
  })

  test('initialize 握手返回 serverInfo 与 capabilities', () => {
    expect(client.serverInfo.name).toBe('devmate-demo')
    expect(client.capabilities).toHaveProperty('tools')
  })

  test('tools/list 动态发现工具，并加上 mcp__<server>__<tool> 命名空间', async () => {
    const tools = await client.listTools()
    const names = tools.map((t) => t.qualifiedName)
    expect(names).toContain('mcp__demo__get_time')
    expect(names).toContain('mcp__demo__word_count')
    expect(names).toContain('mcp__demo__sha256')
    // 每个工具都必须带 inputSchema，否则无法转成 LLM 的 function 定义
    for (const t of tools) expect(t.inputSchema).toHaveProperty('type')
  })

  test('tools/call 正确执行并返回文本结果', async () => {
    const r = await client.callTool('word_count', { text: 'hello world\nfoo' })
    expect(r.isError).toBe(false)
    expect(r.text).toContain('字符')
    expect(r.text).toContain('词 3')
  })

  test('tools/call 调用未知工具 → isError=true（不抛异常，交给模型自行纠正）', async () => {
    const r = await client.callTool('not_a_tool', {})
    expect(r.isError).toBe(true)
    expect(r.text).toContain('未知工具')
  })

  test('连接不存在的服务器 → 抛出可读错误，不挂死', async () => {
    const { McpClient } = await import('@/lib/agent/mcp')
    await expect(
      McpClient.connect({ name: 'ghost', command: 'definitely-not-a-real-binary-xyz', timeoutMs: 5000 }),
    ).rejects.toThrow()
  })

  test('命名空间工具名可识别', async () => {
    const { isMcpToolName, qualifyToolName } = await import('@/lib/agent/mcp')
    expect(isMcpToolName('mcp__demo__get_time')).toBe(true)
    expect(isMcpToolName('read_file')).toBe(false)
    // 非法字符要被规范化，避免破坏 function name 规范
    expect(qualifyToolName('my server', 'do/thing')).toBe('mcp__my_server__do_thing')
  })
})

// ===================== 并发调度：并行工具执行的安全前提 =====================

describe('并发调度安全性（并行工具执行的前提）', () => {
  test('只读内置工具允许并发', async () => {
    const { isConcurrencySafeTool } = await import('@/lib/agent/loop')
    for (const n of ['read_file', 'list_files', 'glob', 'grep', 'search_ast', 'search_semantic']) {
      expect(isConcurrencySafeTool(n)).toBe(true)
    }
  })

  test('写操作 / 命令 / git / todo 必须串行（并发会互相踩）', async () => {
    const { isConcurrencySafeTool } = await import('@/lib/agent/loop')
    for (const n of [
      'edit_file', 'multi_edit', 'write_file',
      'run_command', 'run_tests', 'git_operation', 'todo_write',
      'generate_docx', 'generate_pptx',
    ]) {
      expect(isConcurrencySafeTool(n)).toBe(false)
    }
  })

  test('MCP 工具默认串行，只有服务器声明 readOnlyHint 才允许并发', async () => {
    const { isConcurrencySafeTool } = await import('@/lib/agent/loop')
    // 未在白名单里 → 保守当作有副作用
    expect(isConcurrencySafeTool('mcp__demo__get_time')).toBe(false)
    expect(isConcurrencySafeTool('mcp__demo__get_time', new Set(['mcp__demo__get_time']))).toBe(true)
  })
})

// ===================== MCP 配置加载 =====================

describe('MCP 配置加载', () => {
  test('无任何配置时返回空数组（不启用 MCP，零开销）', async () => {
    const { loadMcpConfigs } = await import('@/lib/agent/mcp-registry')
    const saved = process.env.MCP_SERVERS
    delete process.env.MCP_SERVERS
    expect(loadMcpConfigs('/definitely/not/a/real/dir')).toEqual([])
    if (saved) process.env.MCP_SERVERS = saved
  })

  test('从 MCP_SERVERS 环境变量解析服务器列表', async () => {
    const { loadMcpConfigs } = await import('@/lib/agent/mcp-registry')
    const saved = process.env.MCP_SERVERS
    process.env.MCP_SERVERS = JSON.stringify([{ name: 'x', command: 'node', args: ['a.js'] }])
    const cfgs = loadMcpConfigs()
    expect(cfgs.length).toBe(1)
    expect(cfgs[0].name).toBe('x')
    if (saved) process.env.MCP_SERVERS = saved
    else delete process.env.MCP_SERVERS
  })

  test('MCP_SERVERS 非法 JSON 时降级为空（不影响主流程）', async () => {
    const { loadMcpConfigs } = await import('@/lib/agent/mcp-registry')
    const saved = process.env.MCP_SERVERS
    process.env.MCP_SERVERS = '{not json'
    expect(loadMcpConfigs('/definitely/not/a/real/dir')).toEqual([])
    if (saved) process.env.MCP_SERVERS = saved
    else delete process.env.MCP_SERVERS
  })
})

// ===================== P0：权限模型 =====================

describe('权限模型（P0）', () => {
  const P = async () => await import('@/lib/agent/permissions')

  test('工具风险分级：读 / 写 / 执行', async () => {
    const { classifyRisk } = await P()
    expect(classifyRisk('read_file')).toBe('read')
    expect(classifyRisk('grep')).toBe('read')
    expect(classifyRisk('todo_write')).toBe('read')
    expect(classifyRisk('edit_file')).toBe('write')
    expect(classifyRisk('write_file')).toBe('write')
    expect(classifyRisk('run_command')).toBe('execute')
    expect(classifyRisk('git_operation')).toBe('execute')
    // 未知工具（含 MCP）保守当作 execute —— 外部行为不可知
    expect(classifyRisk('mcp__x__y')).toBe('execute')
  })

  test('敏感文件硬拦截：即使 bypassPermissions 也拒绝', async () => {
    const { evaluatePermission } = await P()
    for (const f of ['.env', 'config/.env.local', 'id_rsa', 'certs/server.pem', '.aws/credentials']) {
      const d = evaluatePermission('read_file', { path: f }, { mode: 'bypassPermissions' })
      expect(d.action).toBe('deny')
      expect(d.reason).toContain('敏感文件')
    }
    // 普通文件不受影响
    expect(evaluatePermission('read_file', { path: 'src/app.js' }, { mode: 'bypassPermissions' }).action).toBe('allow')
  })

  test('plan 模式：只读放行，写与执行一律拒绝', async () => {
    const { evaluatePermission } = await P()
    const ctx = { mode: 'plan' as const }
    expect(evaluatePermission('read_file', { path: 'a.js' }, ctx).action).toBe('allow')
    expect(evaluatePermission('edit_file', { path: 'a.js' }, ctx).action).toBe('deny')
    expect(evaluatePermission('run_command', { command: 'node a.js' }, ctx).action).toBe('deny')
  })

  test('acceptEdits：写放行，执行要问', async () => {
    const { evaluatePermission } = await P()
    const ctx = { mode: 'acceptEdits' as const }
    expect(evaluatePermission('edit_file', { path: 'a.js' }, ctx).action).toBe('allow')
    expect(evaluatePermission('run_tests', { path: 'a.js' }, ctx).action).toBe('ask')
  })

  test('default 模式：写与执行都要问，只读放行', async () => {
    const { evaluatePermission } = await P()
    const ctx = { mode: 'default' as const }
    expect(evaluatePermission('read_file', { path: 'a.js' }, ctx).action).toBe('allow')
    expect(evaluatePermission('edit_file', { path: 'a.js' }, ctx).action).toBe('ask')
    expect(evaluatePermission('run_command', { command: 'ls' }, ctx).action).toBe('ask')
  })

  test('破坏性命令必须 ask —— 即使 acceptEdits', async () => {
    const { evaluatePermission } = await P()
    const ctx = { mode: 'acceptEdits' as const }
    for (const cmd of ['rm -rf /tmp/x', 'git reset --hard HEAD~3', 'git push --force origin main']) {
      const d = evaluatePermission('run_command', { command: cmd }, ctx)
      expect(d.action).toBe('ask')
      expect(d.risk).toBe('destructive')
    }
  })

  test('**回归**：破坏性命令的数组形态也必须被拦（schema 声明的就是数组）', async () => {
    // 曾经的 bug：权限层只判 typeof args.command === 'string'，
    // 而 run_command 的 schema 声明 command 是数组 → 数组形态直接跳过检测，
    // 破坏性拦截对真实参数是死代码。commandToText() 修好了它。
    const { evaluatePermission, commandToText } = await P()
    const ctx = { mode: 'acceptEdits' as const }
    expect(commandToText(['rm', '-rf', '/tmp/x'])).toBe('rm -rf /tmp/x')
    expect(commandToText('rm -rf /tmp/x')).toBe('rm -rf /tmp/x')
    expect(commandToText(undefined)).toBeNull()

    for (const cmd of [['rm', '-rf', '/tmp/x'], ['git', 'reset', '--hard', 'HEAD~3'], ['git', 'push', '--force', 'origin', 'main']]) {
      const d = evaluatePermission('run_command', { command: cmd }, ctx)
      expect(d.action).toBe('ask')
      expect(d.risk).toBe('destructive')
    }
    // 数组形态的网络命令也要能检出
    expect(evaluatePermission('run_command', { command: ['curl', 'http://x'] }, { mode: 'default' }).action).toBe('ask')
  })

  test('显式 deny 规则优先于 allow 规则', async () => {
    const { evaluatePermission } = await P()
    const ctx = {
      mode: 'bypassPermissions' as const,
      rules: [
        { tool: 'run_command', action: 'allow' as const },
        { tool: 'run_command', pattern: 'git push', action: 'deny' as const },
      ],
    }
    expect(evaluatePermission('run_command', { command: 'git push origin main' }, ctx).action).toBe('deny')
    expect(evaluatePermission('run_command', { command: 'ls -la' }, ctx).action).toBe('allow')
  })

  test('通配规则可作用于 MCP 工具', async () => {
    const { evaluatePermission } = await P()
    const ctx = {
      mode: 'default' as const,
      rules: [{ tool: 'mcp__*', action: 'allow' as const }],
    }
    expect(evaluatePermission('mcp__demo__get_time', {}, ctx).action).toBe('allow')
  })

  test('extractSubject 能从各类参数里取出被作用对象', async () => {
    const { extractSubject } = await P()
    expect(extractSubject('run_command', { command: 'ls' })).toBe('ls')
    expect(extractSubject('read_file', { path: 'a/b.js' })).toBe('a/b.js')
    expect(extractSubject('multi_edit', { edits: [{ path: 'x.js' }] })).toBe('x.js')
  })
})

// ===================== P0：人在环审批 =====================

describe('人在环审批（P0）', () => {
  test('挂起后可由外部 resolve，返回用户决定', async () => {
    const { requestApproval, resolveApproval } = await import('@/lib/agent/approvals')
    const p = requestApproval(
      { sessionId: 's1', tool: 'run_command', args: {}, risk: 'destructive', reason: 'test' },
      5000,
    )
    // 等一拍让请求注册
    await new Promise((r) => setTimeout(r, 5))
    const { listPendingApprovals } = await import('@/lib/agent/approvals')
    const pending = listPendingApprovals('s1')
    expect(pending.length).toBeGreaterThan(0)
    expect(resolveApproval(pending[pending.length - 1].id, 'allow')).toBe(true)
    expect(await p).toBe('allow')
  })

  test('超时按**拒绝**处理（fail-safe：没人看着不能自己往下走）', async () => {
    const { requestApproval } = await import('@/lib/agent/approvals')
    const verdict = await requestApproval(
      { sessionId: 's2', tool: 'run_command', args: {}, risk: 'destructive', reason: 'timeout-test' },
      50,
    )
    expect(verdict).toBe('timeout')
  })

  test('resolve 未知 id 返回 false（不假装成功）', async () => {
    const { resolveApproval } = await import('@/lib/agent/approvals')
    expect(resolveApproval('not-a-real-id', 'allow')).toBe(false)
  })

  test('审计日志记录决策', async () => {
    const { recordAudit, getAuditLog } = await import('@/lib/agent/approvals')
    recordAudit({
      at: Date.now(), sessionId: 's3', tool: 'edit_file', risk: 'write',
      action: 'allow', reason: 'unit-test', subject: 'a.js',
    })
    const log = getAuditLog(10)
    expect(log.some((r) => r.reason === 'unit-test' && r.tool === 'edit_file')).toBe(true)
  })
})

// ===================== P0：可观测性 =====================

describe('可观测性与成本账本（P0）', () => {
  test('Tracer 记录 span 与耗时', async () => {
    const { Tracer } = await import('@/lib/agent/trace')
    const t = new Tracer('s', 'task', 'glm-4-flash')
    const s1 = t.startSpan('read_file', 'tool')
    s1.end({ ok: true })
    const s2 = t.startSpan('llm.step1', 'llm')
    s2.end()
    t.countStep()
    t.countToolCall()
    const rec = t.finish()
    expect(rec.spans.length).toBe(2)
    expect(rec.spans[0].durationMs).toBeGreaterThanOrEqual(0)
    expect(rec.outcome.steps).toBe(1)
    expect(rec.outcome.toolCalls).toBe(1)
    expect(rec.timeByKind).toHaveProperty('tool')
    expect(rec.timeByKind).toHaveProperty('llm')
  })

  test('成本账本：有 API usage 时标 api，缺失时标 estimated', async () => {
    const { Tracer } = await import('@/lib/agent/trace')
    const a = new Tracer('s', 't', 'gpt-4o-mini')
    a.recordLlmUsage({ prompt_tokens: 1_000_000, completion_tokens: 0 }, 0)
    const ra = a.finish()
    expect(ra.usage.source).toBe('api')
    expect(ra.usage.promptTokens).toBe(1_000_000)
    expect(ra.costCny).toBeGreaterThan(0) // 100 万输入 token 必然有成本

    const b = new Tracer('s', 't', 'gpt-4o-mini')
    b.recordLlmUsage(undefined, 500)
    const rb = b.finish()
    expect(rb.usage.source).toBe('estimated')
    expect(rb.usage.completionTokens).toBe(500)
  })

  test('未知模型成本为 0（不瞎猜价格）', async () => {
    const { costOf } = await import('@/lib/agent/trace')
    expect(costOf('some-unknown-model-xyz', 1_000_000, 1_000_000)).toBe(0)
  })

  test('百分位计算', async () => {
    const { percentile } = await import('@/lib/agent/trace')
    const xs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
    expect(percentile(xs, 50)).toBe(50)
    expect(percentile(xs, 95)).toBe(100)
    expect(percentile([], 50)).toBe(0)
  })

  test('summarize 聚合 P50/P95、成本与工具失败率', async () => {
    const { Tracer, summarize } = await import('@/lib/agent/trace')
    const mk = (fail: boolean, dur: number) => {
      const t = new Tracer('s', 'task', 'gpt-4o-mini')
      const s = t.startSpan('run_tests', 'tool')
      s.end(undefined, fail ? 'error' : 'ok')
      t.recordLlmUsage({ prompt_tokens: 100, completion_tokens: 50 }, 0)
      return t.finish()
    }
    const recs = [mk(false, 1), mk(true, 2), mk(false, 3)]
    const sum = summarize(recs)
    expect(sum.count).toBe(3)
    expect(sum.tokens.total).toBe(450)
    expect(sum.toolFailure['run_tests'].calls).toBe(3)
    expect(sum.toolFailure['run_tests'].errors).toBe(1)
    expect(sum.toolFailure['run_tests'].rate).toBeCloseTo(1 / 3, 5)
    expect(sum.latencyMs.max).toBeGreaterThanOrEqual(0)
  })

  test('未知单价要能被识别（区分「免费」和「不知道」）', async () => {
    const { hasPrice } = await import('@/lib/agent/trace')
    expect(hasPrice('gpt-4o-mini')).toBe(true)
    expect(hasPrice('some-model-nobody-knows')).toBe(false)
  })
})

// ===================== P1：子 Agent 委派 =====================

describe('子 Agent 委派（P1）', () => {
  test('子 Agent 工具集**不含 task** —— 天然防无限递归', async () => {
    const { SUBAGENT_READONLY_TOOLS } = await import('@/lib/agent/subagent')
    expect(SUBAGENT_READONLY_TOOLS).not.toContain('task')
  })

  test('子 Agent 工具集**全是只读** —— 它不该偷偷改主任务的文件', async () => {
    const { SUBAGENT_READONLY_TOOLS } = await import('@/lib/agent/subagent')
    const { classifyRisk } = await import('@/lib/agent/permissions')
    for (const t of SUBAGENT_READONLY_TOOLS) {
      expect(classifyRisk(t)).toBe('read')
    }
    expect(SUBAGENT_READONLY_TOOLS).toContain('read_file')
  })

  test('结论文本必须明确标注「原文没有进入你的上下文」', async () => {
    const { formatSubagentResult } = await import('@/lib/agent/subagent')
    const text = formatSubagentResult(
      {
        summary: 'X 在 a.js:12 定义',
        steps: 3,
        toolCalls: 4,
        tokensUsed: 1200,
        durationMs: 5000,
        toolsUsed: ['grep', 'read_file'],
      },
      '定位 X',
    )
    expect(text).toContain('定位 X')
    expect(text).toContain('X 在 a.js:12 定义')
    expect(text).toContain('没有')
    expect(text).toContain('4 次工具调用')
  })

  test('task 工具已注册；委派本身被归为只读（子 Agent 不改文件）', async () => {
    const { filterTools } = await import('@/lib/agent/tools')
    const { classifyRisk } = await import('@/lib/agent/permissions')
    const t = filterTools(['task'])
    expect(t.length).toBe(1)
    expect(t[0].function.name).toBe('task')
    expect(t[0].function.parameters).toHaveProperty('required')
    expect(classifyRisk('task')).toBe('read')
  })
})

// ===================== P1：摘要式上下文压缩 =====================

describe('摘要式上下文压缩（P1）', () => {
  test('未超预算时不动', async () => {
    const { compressContextSmart } = await import('@/lib/agent/context')
    const r = await compressContextSmart([{ role: 'user', content: 'hi' }])
    expect(r.compressedCount).toBe(0)
    expect(r.summarized).toBe(false)
  })

  test('没有「大工具结果」可压时不硬压（不拿用户消息开刀）', async () => {
    const { compressContextSmart } = await import('@/lib/agent/context')
    const r = await compressContextSmart([{ role: 'user', content: 'x'.repeat(50_000) }])
    expect(r.compressedCount).toBe(0)
    expect(r.summarized).toBe(false)
  })

  test('LLM 不可用时**退回占位符方案**，不抛异常、不挂主流程', async () => {
    const { compressContextSmart } = await import('@/lib/agent/context')
    const savedKey = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = '' // 让摘要调用直接失败
    try {
      const msgs: { role: string; name?: string; content: string }[] = [
        { role: 'system', content: 'sys' },
      ]
      for (let i = 0; i < 40; i++) {
        msgs.push({ role: 'tool', name: 'read_file', content: 'y'.repeat(3000) })
      }
      msgs.push({ role: 'user', content: 'go' })
      const r = await compressContextSmart(msgs as never)
      expect(r.summarized).toBe(false) // 摘要失败
      expect(r.compressedCount).toBeGreaterThan(0) // 但占位符方案生效了
      expect(r.tokensAfter).toBeLessThan(r.tokensBefore)
    } finally {
      process.env.OPENAI_API_KEY = savedKey
    }
  })

  test('压缩后消息条数不变（否则会破坏 tool_calls 与 tool 的配对）', async () => {
    const { compressContext } = await import('@/lib/agent/context')
    const msgs: { role: string; name?: string; content: string }[] = [
      { role: 'system', content: 'sys' },
    ]
    for (let i = 0; i < 40; i++) {
      msgs.push({ role: 'tool', name: 'read_file', content: 'z'.repeat(3000) })
    }
    msgs.push({ role: 'user', content: 'go' })
    const r = compressContext(msgs as never)
    expect(r.messages.length).toBe(msgs.length)
  })
})

// ===================== 代码评审（对齐 JD：代码评审场景）=====================

describe('代码评审（review.ts）', () => {
  const DIFF_WITH_SECRET = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,3 +1,6 @@',
    ' const x = 1',
    '+const API_KEY = "sk-abcdefghijklmnop1234"',
    '+console.log("debug here")',
    '+// TODO: 以后再说',
    '+function f() { return 2 }',
    ' ',
  ].join('\n')

  test('解析 diff 统计增删行与文件', async () => {
    const { parseDiffStats } = await import('@/lib/agent/review')
    const s = parseDiffStats(DIFF_WITH_SECRET)
    expect(s.files).toBe(1)
    expect(s.added).toBe(4)
    expect(s.touchesSource).toBe(true)
    expect(s.touchesTest).toBe(false)
  })

  test('能区分测试文件与源码文件', async () => {
    const { isTestFile } = await import('@/lib/agent/review')
    expect(isTestFile('src/a.test.ts')).toBe(true)
    expect(isTestFile('tests/foo.ts')).toBe(true)
    expect(isTestFile('__tests__/bar.js')).toBe(true)
    expect(isTestFile('src/mathutils.js')).toBe(false)
  })

  test('确定性检查能抓到硬编码密钥 / 调试残留 / TODO', async () => {
    const { staticChecks } = await import('@/lib/agent/review')
    const f = staticChecks(DIFF_WITH_SECRET)
    expect(f.some((x) => x.category === 'security' && x.severity === 'blocker')).toBe(true)
    expect(f.some((x) => x.title.includes('调试输出'))).toBe(true)
    expect(f.some((x) => x.title.includes('TODO'))).toBe(true)
    // 全部来自确定性检查，不依赖 LLM
    expect(f.every((x) => x.source === 'static')).toBe(true)
  })

  test('改了源码但没动测试 → 提示补测试', async () => {
    const { staticChecks } = await import('@/lib/agent/review')
    const diff = [
      '+++ b/src/a.ts',
      '@@ -1,1 +1,8 @@',
      '+a1', '+a2', '+a3', '+a4', '+a5', '+a6',
    ].join('\n')
    const f = staticChecks(diff)
    expect(f.some((x) => x.category === 'test')).toBe(true)
  })

  test('纯文档改动不误报「缺测试」', async () => {
    const { staticChecks } = await import('@/lib/agent/review')
    const diff = ['+++ b/README.md', '@@ -1,1 +1,8 @@', '+a', '+b', '+c', '+d', '+e', '+f'].join('\n')
    const f = staticChecks(diff)
    expect(f.some((x) => x.category === 'test')).toBe(false)
  })

  test('风险分：blocker 直接顶到 100', async () => {
    const { computeRiskScore } = await import('@/lib/agent/review')
    const mk = (s: 'blocker' | 'major' | 'minor' | 'nit') => ({
      severity: s, category: 'correctness' as const, file: 'a', title: 't', detail: '', source: 'static' as const,
    })
    expect(computeRiskScore([mk('blocker')])).toBe(100)
    expect(computeRiskScore([mk('nit')])).toBe(1)
    expect(computeRiskScore([])).toBe(0)
    expect(computeRiskScore([mk('major'), mk('major')])).toBe(30)
  })

  test('LLM 返回的非法枚举值会被规整，脏数据不会穿透', async () => {
    const { normalizeLlmFindings } = await import('@/lib/agent/review')
    const out = normalizeLlmFindings({
      findings: [
        { severity: 'CATASTROPHIC', category: 'vibes', file: 'a.ts', title: 'ok' },
        { severity: 'major', category: 'correctness', title: '' }, // 无标题 → 丢弃
      ],
    })
    expect(out.length).toBe(1)
    expect(out[0].severity).toBe('minor') // 非法值回落
    expect(out[0].category).toBe('correctness')
  })

  test('能从 markdown 包裹里抠出 JSON', async () => {
    const { extractJson } = await import('@/lib/agent/review')
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(extractJson('前言 {"a":2} 后语')).toEqual({ a: 2 })
    expect(extractJson('没有 json')).toBeNull()
  })
})

// ===================== 知识库检索（对齐 JD：知识库检索）=====================

describe('知识库检索（RAG）', () => {
  const TPL = path.join(process.cwd(), 'assets', 'template-project')

  test('按 Markdown 标题切块，并保留标题路径', async () => {
    const { chunkMarkdown } = await import('@/lib/agent/knowledge')
    // 用真实长度的段落（<40 字符的碎片本来就不该入库，这是刻意的过滤）
    const md = [
      '# 提交规范',
      '',
      '本项目遵循 Conventional Commits，提交信息必须用祈使句、结尾不加句号。',
      '',
      '## type 取值',
      '',
      'feat 表示新增功能，fix 表示修 bug，refactor 表示重构且不改变外部行为。',
    ].join('\n')
    const chunks = chunkMarkdown('t.md', md)
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.some((c) => c.heading.includes('提交规范'))).toBe(true)
    expect(chunks.some((c) => c.heading.includes('type 取值'))).toBe(true)
    // 标题路径应当是「父 / 子」的形式，便于展示与加权
    expect(chunks.some((c) => c.heading.includes(' / '))).toBe(true)
  })

  test('过短的碎片不入库（避免污染检索结果）', async () => {
    const { chunkMarkdown } = await import('@/lib/agent/knowledge')
    expect(chunkMarkdown('t.md', '# 标题\n\n太短').length).toBe(0)
  })

  test('模板项目里的知识库能被索引', async () => {
    const { buildKnowledgeIndex } = await import('@/lib/agent/knowledge')
    const idx = buildKnowledgeIndex(TPL)
    expect(idx.total).toBeGreaterThan(5)
    expect(idx.files.length).toBeGreaterThanOrEqual(3)
  })

  test('检索能命中正确的小节（4 组真实问题）', async () => {
    const { searchKnowledge } = await import('@/lib/agent/knowledge')
    const cases: [string, string][] = [
      ['提交规范是什么', '01-提交规范.md'],
      ['为什么不能改成 ESM', '03-常见问题.md'],
      ['fibonacci 性能要求', '02-架构说明.md'],
      ['测试失败了怎么办', '03-常见问题.md'],
    ]
    for (const [q, expectFile] of cases) {
      const hits = searchKnowledge(TPL, q, 3)
      expect(hits.length).toBeGreaterThan(0)
      expect(hits[0].chunk.file).toBe(expectFile)
    }
  })

  test('空查询返回空结果（不瞎给）', async () => {
    const { searchKnowledge } = await import('@/lib/agent/knowledge')
    expect(searchKnowledge(TPL, '   ', 3)).toEqual([])
  })

  test('知识库目录不存在时安全返回空', async () => {
    const { buildKnowledgeIndex } = await import('@/lib/agent/knowledge')
    const idx = buildKnowledgeIndex(process.cwd(), 'definitely-not-a-real-dir')
    expect(idx.total).toBe(0)
  })
})

// ===================== VCS 抽象层（对齐 JD：P4 管理）=====================

describe('VCS 抽象层', () => {
  const REPO = process.cwd()

  test('默认 provider 是 git', async () => {
    const { getVcsProvider } = await import('@/lib/agent/vcs')
    const saved = process.env.VCS_PROVIDER
    delete process.env.VCS_PROVIDER
    expect(getVcsProvider().name).toBe('git')
    process.env.VCS_PROVIDER = 'perforce'
    expect(getVcsProvider().name).toBe('perforce')
    if (saved) process.env.VCS_PROVIDER = saved
    else delete process.env.VCS_PROVIDER
  })

  test('GitProvider：status 与 log 可用', async () => {
    const { GitProvider } = await import('@/lib/agent/vcs')
    const g = new GitProvider()
    expect(await g.available()).toBe(true)
    const s = await g.status(REPO)
    expect(typeof s.branch).toBe('string')
    expect(Array.isArray(s.changes)).toBe(true)
    const log = await g.log(REPO, 3)
    expect(log.length).toBeGreaterThan(0)
    expect(log[0]).toHaveProperty('rev')
    expect(log[0]).toHaveProperty('subject')
  })

  test('PerforceProvider：p4 不可用时抛出**可操作**的错误（不假装成功）', async () => {
    const { PerforceProvider } = await import('@/lib/agent/vcs')
    const p = new PerforceProvider()
    if (await p.available()) return // 本机真装了 p4 就跳过
    await expect(p.status(REPO)).rejects.toThrow(/Perforce CLI 不可用/)
    // 错误信息要能指导用户下一步，而不是一句「失败」
    await expect(p.status(REPO)).rejects.toThrow(/P4PORT|安装/)
  })

  test('能力说明里明确标注 P4 实现未经真实环境验证', async () => {
    const { PerforceProvider } = await import('@/lib/agent/vcs')
    expect(new PerforceProvider().describe()).toContain('未在真实 P4 服务器验证')
  })
})

// ===================== 跨端 WebView 宿主适配（对齐 JD：跨端）=====================

describe('跨端宿主适配（bridge）', () => {
  const G = {
    browser: { navigator: { userAgent: 'Mozilla/5.0', clipboard: {} } },
    electron: {
      electronAPI: { copyText() {}, openFile() {}, notify() {}, getTheme: () => 'dark' },
      navigator: { userAgent: 'Mozilla/5.0 Electron/28' },
    },
    ue: {
      ue: { openAsset() {}, copyToClipboard() {}, getEditorTheme: () => 'dark' },
      navigator: { userAgent: 'Mozilla/5.0 UnrealEngine' },
    },
    maya: { maya: { openFile() {}, getTheme: () => 'light' }, navigator: { userAgent: 'Mozilla/5.0' } },
  }

  test('四种宿主都能正确识别', async () => {
    const { detectHost } = await import('@/lib/host/bridge')
    expect(detectHost(G.browser as never).kind).toBe('browser')
    expect(detectHost(G.electron as never).kind).toBe('electron')
    expect(detectHost(G.ue as never).kind).toBe('ue')
    expect(detectHost(G.maya as never).kind).toBe('maya')
  })

  test('浏览器：打开本地文件能力缺失 → 显式降级并给出原因', async () => {
    const { detectHost, HostBridge } = await import('@/lib/host/bridge')
    expect(detectHost(G.browser as never).capabilities.openFile).toBe(false)
    const r = await new HostBridge(G.browser as never).openFile('a.js')
    expect(r.ok).toBe(false)
    expect(r.degraded).toBe(true)
    expect(r.reason).toContain('浏览器')
  })

  test('**能力探测与能力执行必须一致**（曾经的 bug：探测 ✓ 但执行降级）', async () => {
    const { detectHost, HostBridge } = await import('@/lib/host/bridge')
    for (const key of ['electron', 'ue'] as const) {
      const info = detectHost(G[key] as never)
      if (!info.capabilities.clipboard) continue
      const r = await new HostBridge(G[key] as never).copyText('x')
      // 探测说有能力，执行就必须成功 —— 两边必须查同一张方法名表
      expect(r.ok).toBe(true)
    }
  })

  test('主题读取：宿主桥优先于媒体查询', async () => {
    const { detectHost, readHostTheme } = await import('@/lib/host/bridge')
    expect(readHostTheme(G.electron as never, detectHost(G.electron as never))).toBe('dark')
    expect(readHostTheme(G.maya as never, detectHost(G.maya as never))).toBe('light')
  })

  test('无任何宿主时回落浏览器，不抛异常', async () => {
    const { detectHost } = await import('@/lib/host/bridge')
    const info = detectHost({} as never)
    expect(info.kind).toBe('browser')
    expect(info.capabilities.download).toBe(true)
  })
})

// ===================== 外部权威基准：BFCL 判分器 =====================

describe('BFCL 判分器（权威基准适配）', () => {
  test('解析 JSONL（BFCL 的 .json 实际是每行一个对象）', async () => {
    const { parseJsonl } = await import('@/lib/bench/bfcl')
    const rows = parseJsonl('{"id":"a"}\n{"id":"b"}\n\n{bad json}\n')
    expect(rows.length).toBe(2)
    expect((rows[0] as { id: string }).id).toBe('a')
  })

  test('Python 风格类型名归一化成 JSON Schema', async () => {
    const { normalizeType } = await import('@/lib/bench/bfcl')
    expect(normalizeType('dict')).toBe('object')
    expect(normalizeType('String')).toBe('string')
    expect(normalizeType('float')).toBe('number')
    expect(normalizeType('array')).toBe('array')
    expect(normalizeType(undefined)).toBe('string')
  })

  test('irrelevance：不调用任何函数才算通过', async () => {
    const { gradeCase } = await import('@/lib/bench/bfcl')
    expect(gradeCase(null, []).pass).toBe(true)
    expect(gradeCase(null, [{ name: 'x', args: {} }]).pass).toBe(false)
  })

  test('参数值落在允许列表内即算命中（含类型归一化）', async () => {
    const { gradeCase } = await import('@/lib/bench/bfcl')
    const gt = [{ f: { a: ['x'], n: [20] } }] as never
    // 数字用字符串表示也应命中
    expect(gradeCase(gt, [{ name: 'f', args: { a: 'x', n: '20' } }]).pass).toBe(true)
    // 参数值不在允许列表 → 失败
    expect(gradeCase(gt, [{ name: 'f', args: { a: 'y', n: 20 } }]).pass).toBe(false)
  })

  test('嵌套数组参数（BFCL 常见形态）能正确匹配', async () => {
    const { gradeCase } = await import('@/lib/bench/bfcl')
    const gt = [{ f: { status: [['completed', 'failed']] } }] as never
    expect(gradeCase(gt, [{ name: 'f', args: { status: ['completed', 'failed'] } }]).pass).toBe(true)
  })

  test('多调用：少调、多调都算失败（防止「全调一遍」蒙对）', async () => {
    const { gradeCase } = await import('@/lib/bench/bfcl')
    const gt = [{ a: { p: [1] } }, { b: { q: [2] } }] as never
    expect(gradeCase(gt, [{ name: 'a', args: { p: 1 } }]).pass).toBe(false) // 少一个
    expect(
      gradeCase(gt, [
        { name: 'a', args: { p: 1 } },
        { name: 'b', args: { q: 2 } },
        { name: 'c', args: {} },
      ]).pass,
    ).toBe(false) // 多一个
    expect(
      gradeCase(gt, [
        { name: 'b', args: { q: 2 } },
        { name: 'a', args: { p: 1 } },
      ]).pass,
    ).toBe(true) // 顺序无关
  })

  test('空字符串是通配（与官方 checker 的 `""` 语义一致）', async () => {
    const { gradeCase } = await import('@/lib/bench/bfcl')
    expect(gradeCase([{ f: { a: [''] } }] as never, [{ name: 'f', args: { a: '任意值' } }]).pass).toBe(true)
  })

  test('函数名不对 → 失败', async () => {
    const { gradeCase } = await import('@/lib/bench/bfcl')
    expect(gradeCase([{ f: { a: [1] } }] as never, [{ name: 'g', args: { a: 1 } }]).pass).toBe(false)
  })

  test('BFCL 数据集已下载且可解析（若存在）', async () => {
    const { parseJsonl, buildCases } = await import('@/lib/bench/bfcl')
    const fs = await import('node:fs')
    const p = path.join(process.cwd(), 'benchmarks', 'external', 'bfcl', 'BFCL_v4_parallel.json')
    if (!fs.existsSync(p)) return // 未下载则跳过（不联网）
    const rows = parseJsonl(fs.readFileSync(p, 'utf-8'))
    expect(rows.length).toBeGreaterThan(0)
    const ans = path.join(process.cwd(), 'benchmarks', 'external', 'bfcl', 'possible_answer', 'BFCL_v4_parallel.json')
    const cases = buildCases(rows, parseJsonl(fs.readFileSync(ans, 'utf-8')), 'parallel')
    expect(cases.length).toBe(rows.length)
    expect(cases[0].groundTruth).not.toBeUndefined()
  })
})

// ===================== 外部权威基准：polyglot 适配 =====================

describe('polyglot-benchmark 适配', () => {
  const EX_ROOT = path.join(
    process.cwd(), 'benchmarks', 'external', 'polyglot',
    'polyglot-benchmark-main', 'javascript', 'exercises', 'practice',
  )

  test('启用被跳过的测试（xtest → test）—— 否则不写代码也能「全绿」', async () => {
    const { enableAllTests } = await import('@/lib/bench/polyglot')
    const src = "test('a', () => 1)\nxtest('b', () => 2)\nxit('c', () => 3)\n"
    const r = enableAllTests(src)
    expect(r.enabled).toBe(2)
    expect(r.code).toContain("test('b'")
    expect(r.code).toContain("it('c'")
    expect(r.code).not.toContain('xtest(')
  })

  test('prepareExercise 必须清掉沙箱里的模板（DEVmate.md 会误导 ESM 练习）', async () => {
    const { prepareExercise, listExercises, clearTemplate } = await import('@/lib/bench/polyglot')
    const fs2 = await import('node:fs')
    if (!fs2.existsSync(EX_ROOT)) return
    const ex = listExercises(EX_ROOT).find((e) => e.slug === 'binary')!
    const tmp = path.join(process.cwd(), 'workspace', '_test-polyglot-prep')
    fs2.mkdirSync(tmp, { recursive: true })
    // 模拟 createWorkspace 留下的模板
    fs2.writeFileSync(path.join(tmp, 'DEVmate.md'), '# 保持 CommonJS', 'utf-8')
    fs2.writeFileSync(path.join(tmp, 'mathutils.js'), 'module.exports = {}', 'utf-8')
    expect(clearTemplate(tmp)).toBeGreaterThan(0)
    const r = prepareExercise(ex, tmp)
    expect(r.clearedTemplate).toBe(0) // 已清空，第二次没有可清的
    expect(fs2.existsSync(path.join(tmp, 'DEVmate.md'))).toBe(false)
    expect(fs2.existsSync(path.join(tmp, 'binary.js'))).toBe(true)
    expect(r.enabledTests).toBeGreaterThan(0)
    // 测试必须全部启用，不能残留 xtest
    const spec = fs2.readFileSync(path.join(tmp, 'binary.spec.js'), 'utf-8')
    expect(spec).not.toContain('xtest(')
    fs2.rmSync(tmp, { recursive: true, force: true })
  })

  test('解析 jest --json 结果', async () => {
    const { parseJestJson } = await import('@/lib/bench/polyglot')
    const ok = parseJestJson(JSON.stringify({ numPassedTests: 5, numFailedTests: 0, numTotalTests: 5, success: true }))
    expect(ok?.ok).toBe(true)
    expect(ok?.passed).toBe(5)
    const bad = parseJestJson(JSON.stringify({ numPassedTests: 3, numFailedTests: 2, numTotalTests: 5, success: false }))
    expect(bad?.ok).toBe(false)
    // 零用例不算通过（防止「没跑测试」被当成成功）
    const empty = parseJestJson(JSON.stringify({ numPassedTests: 0, numFailedTests: 0, numTotalTests: 0, success: true }))
    expect(empty?.ok).toBe(false)
    expect(parseJestJson('不是 json')).toBeNull()
  })

  test('题库已下载且能列出练习（若存在）', async () => {
    const { listExercises } = await import('@/lib/bench/polyglot')
    const fs = await import('node:fs')
    if (!fs.existsSync(EX_ROOT)) return // 未下载则跳过
    const exs = listExercises(EX_ROOT)
    expect(exs.length).toBe(49)
    expect(exs.every((e) => e.sourceFile.endsWith('.js'))).toBe(true)
  })

  test('每题都有可用的 stub 与 spec（若已下载）', async () => {
    const { listExercises } = await import('@/lib/bench/polyglot')
    const fs = await import('node:fs')
    if (!fs.existsSync(EX_ROOT)) return
    for (const e of listExercises(EX_ROOT)) {
      expect(fs.existsSync(path.join(e.dir, e.sourceFile))).toBe(true)
      expect(fs.existsSync(path.join(e.dir, e.specFile))).toBe(true)
    }
  })
})

// ===================== 会话级「记住的规则」（审批记忆）=====================

describe('会话级审批记忆', () => {
  test('记住的规则可以被读回、去重、清空', async () => {
    const { addSessionRule, getSessionRules, clearSessionRules } = await import('@/lib/agent/permissions')
    const sid = `test-${Date.now()}`
    try {
      expect(getSessionRules(sid)).toEqual([])
      addSessionRule(sid, { tool: 'edit_file', action: 'allow' })
      addSessionRule(sid, { tool: 'edit_file', action: 'allow' }) // 重复 → 不加
      addSessionRule(sid, { tool: 'run_tests', action: 'allow' })
      const rules = getSessionRules(sid)
      expect(rules.length).toBe(2)
      clearSessionRules(sid)
      expect(getSessionRules(sid)).toEqual([])
    } finally {
      clearSessionRules(sid)
    }
  })

  test('**安全性质**：记住的 allow 不能绕过破坏性命令拦截', async () => {
    const { evaluatePermission, addSessionRule, clearSessionRules, getSessionRules } =
      await import('@/lib/agent/permissions')
    const sid = `test-sec-${Date.now()}`
    try {
      // 模拟用户勾选了「记住 run_command 的放行」
      addSessionRule(sid, { tool: 'run_command', action: 'allow' })
      const ctx = { mode: 'default' as const, rules: getSessionRules(sid) }
      // 常规命令 → 放行（记住生效）
      expect(evaluatePermission('run_command', { command: ['node', 'x.js'] }, ctx).action).toBe('allow')
      // 破坏性命令 → **仍然要问**（第 3 步拦截在第 4 步 allow 之前）
      expect(evaluatePermission('run_command', { command: ['rm', '-rf', '/'] }, ctx).action).toBe('ask')
      // 敏感文件 → 仍然硬拒
      expect(evaluatePermission('read_file', { path: '.env' }, ctx).action).toBe('deny')
    } finally {
      clearSessionRules(sid)
    }
  })

  test('清空一个会话不影响其他会话的规则', async () => {
    const { addSessionRule, getSessionRules, clearSessionRules } = await import('@/lib/agent/permissions')
    const a = `s-a-${Date.now()}`
    const b = `s-b-${Date.now()}`
    try {
      addSessionRule(a, { tool: 'edit_file', action: 'allow' })
      addSessionRule(b, { tool: 'write_file', action: 'allow' })
      clearSessionRules(a)
      expect(getSessionRules(a)).toEqual([])
      expect(getSessionRules(b).length).toBe(1)
    } finally {
      clearSessionRules(a)
      clearSessionRules(b)
    }
  })
})

// ===================== 对话节点导航 =====================

describe('对话节点导航（ConversationNav）', () => {
  test('只把 user/assistant 抽成节点；工具/思考/审批都是过程不是骨架', async () => {
    const { buildNavNodes } = await import('@/components/agent/ConversationNav')
    const msgs = [
      { id: 'u1', kind: 'user', text: '修个 bug' },
      { id: 'r1', kind: 'reasoning', text: '让我想想…' },
      { id: 't1', kind: 'tool', tool: { id: 'x', name: 'read_file', args: {}, status: 'done' } },
      { id: 'a1', kind: 'assistant', text: '修好了，原因是分母少减一' },
      { id: 'u2', kind: 'user', text: '再加个测试' },
      { id: 'ap1', kind: 'approval', approval: { id: 'p', tool: 'edit_file', args: {}, risk: 'write', reason: '', status: 'pending' } },
      { id: 'a2', kind: 'assistant', text: '测试加好了' },
    ] as never
    const nodes = buildNavNodes(msgs)
    expect(nodes.length).toBe(4)
    expect(nodes.map((n) => `${n.role}${n.index}`)).toEqual(['user1', 'assistant1', 'user2', 'assistant2'])
    expect(nodes.every((n) => !n.id.startsWith('t') && !n.id.startsWith('r') && !n.id.startsWith('ap'))).toBe(true)
  })

  test('标签截断到 28 字符并压掉换行（导航条不该被长文本撑爆）', async () => {
    const { buildNavNodes } = await import('@/components/agent/ConversationNav')
    const long = 'x'.repeat(200) + '\n\n多行\n内容'
    const nodes = buildNavNodes([{ id: 'u1', kind: 'user', text: long }] as never)
    expect(nodes[0].label.length).toBeLessThanOrEqual(28)
    expect(nodes[0].label).not.toContain('\n')
  })

  test('空文本有兜底标签', async () => {
    const { buildNavNodes } = await import('@/components/agent/ConversationNav')
    const nodes = buildNavNodes([
      { id: 'u1', kind: 'user', text: '   ' },
      { id: 'a1', kind: 'assistant', text: '' },
    ] as never)
    expect(nodes[0].label).toBe('(空提问)')
    expect(nodes[1].label).toBe('(回复)')
  })
})

// ===================== LLM 重试策略：终态错误必须快速失败 =====================

describe('LLM 终态错误判定（isTerminal）', () => {
  test('**回归**：配额耗尽 / 鉴权失败是终态错误，重试没有意义', async () => {
    // 曾经的 bug：isRetryable 对任何 429 都重试 → 配额耗尽时白等几分钟才失败。
    // 实测「Prompt 变体对比」在配额耗尽下 120s 都跑不完（每次调用都退避重试到上限）。
    const { isTerminal } = await import('@/lib/agent/llm.openai')
    // 终态：重试不可能成功
    expect(isTerminal(new Error('HTTP 429: {"error":{"type":"quota_error","code":"apikey_quota_exhausted"}}'))).toBe(true)
    expect(isTerminal(new Error('HTTP 429: {"error":{"code":"insufficient_quota"}}'))).toBe(true)
    expect(isTerminal(new Error('HTTP 401: invalid_api_key'))).toBe(true)
    expect(isTerminal(new Error('ApiKey已触发限额'))).toBe(true)
    expect(isTerminal(new Error('账户余额不足'))).toBe(true)
  })

  test('限流 / 网关抖动**不是**终态错误（等一会儿能好，应该重试）', async () => {
    const { isTerminal } = await import('@/lib/agent/llm.openai')
    expect(isTerminal(new Error('HTTP 429: Too many requests, please retry later'))).toBe(false)
    expect(isTerminal(new Error('HTTP 503 Service Unavailable'))).toBe(false)
    expect(isTerminal(new Error('fetch failed'))).toBe(false)
  })
})

// ===================== 电商垂直场景：标签体系 =====================

describe('电商标签体系（taxonomy）', () => {
  test('维度可查、取值可校验、中文名可查', async () => {
    const { getDimension, isValidTagValue, tagLabel, ALL_DIMENSIONS } = await import('@/lib/ecom/taxonomy')
    expect(getDimension('stage')?.label).toBe('线索阶段')
    expect(isValidTagValue('stage', 'interested')).toBe(true)
    expect(isValidTagValue('stage', '不存在的值')).toBe(false)
    expect(tagLabel('stage', 'interested')).toBe('意向中')
    // 查不到时原样返回，不抛错
    expect(tagLabel('stage', 'xxx')).toBe('xxx')
    expect(ALL_DIMENSIONS.length).toBeGreaterThanOrEqual(7)
  })

  test('每个取值都必须有 criteria（判定口径），否则运营无法对齐', async () => {
    const { ALL_DIMENSIONS } = await import('@/lib/ecom/taxonomy')
    for (const d of ALL_DIMENSIONS) {
      expect(d.values.length).toBeGreaterThan(0)
      for (const v of d.values) {
        expect(v.criteria.length).toBeGreaterThan(0)
        expect(v.label.length).toBeGreaterThan(0)
      }
    }
  })
})

// ===================== 电商垂直场景：打标引擎 =====================

describe('电商打标引擎（tagging）', () => {
  test('规模按 GMV 硬分档，置信度 1.0（数值判定无歧义）', async () => {
    const { tagScale } = await import('@/lib/ecom/tagging')
    expect(tagScale({ id: 'a', monthlyGmv: 600_000 })?.value).toBe('ka')
    expect(tagScale({ id: 'a', monthlyGmv: 200_000 })?.value).toBe('mid')
    expect(tagScale({ id: 'a', monthlyGmv: 50_000 })?.value).toBe('long_tail')
    expect(tagScale({ id: 'a', monthlyGmv: 600_000 })?.confidence).toBe(1)
    // 缺数据 → 不打标（不瞎猜）
    expect(tagScale({ id: 'a' })).toBeNull()
  })

  test('痛点：数值信号与文本信号交叉，都命中则置信度加成', async () => {
    const { tagPainPoints } = await import('@/lib/ecom/tagging')
    // 只有数值
    const onlyNum = tagPainPoints({ id: 'a', conversionRate: 0.01 })
    const convNum = onlyNum.find((t) => t.value === 'low_conversion')!
    expect(convNum).toBeDefined()
    expect(convNum.confidence).toBe(0.85)
    // 数值 + 文本 → 加成
    const both = tagPainPoints({ id: 'a', conversionRate: 0.01, note: '商家说转化率低' })
    const convBoth = both.find((t) => t.value === 'low_conversion')!
    expect(convBoth.confidence).toBeGreaterThan(convNum.confidence)
    expect(convBoth.evidence).toContain('；') // 两条依据
  })

  test('健康度按「预警项个数」分档；无任何指标则不打标', async () => {
    const { tagHealth } = await import('@/lib/ecom/tagging')
    expect(tagHealth({ id: 'a' })).toBeNull()
    // 4 项全达标
    expect(
      tagHealth({ id: 'a', conversionRate: 0.03, refundRate: 0.05, avgResponseSec: 20, traffic: 5000 })?.value,
    ).toBe('healthy')
    // 1 项预警
    expect(
      tagHealth({ id: 'a', conversionRate: 0.01, refundRate: 0.05, avgResponseSec: 20, traffic: 5000 })?.value,
    ).toBe('at_risk')
    // 2 项预警
    expect(
      tagHealth({ id: 'a', conversionRate: 0.01, refundRate: 0.15, avgResponseSec: 20, traffic: 5000 })?.value,
    ).toBe('unhealthy')
  })

  test('优先级：高价值+有风险 或 有意向 → P0', async () => {
    const { tagMerchant } = await import('@/lib/ecom/tagging')
    const p0 = tagMerchant({ id: 'a', monthlyGmv: 220_000, conversionRate: 0.012, refundRate: 0.15, avgResponseSec: 95, traffic: 4200, stage: 'interested' })
    expect(p0.tags.find((t) => t.dimension === 'priority')?.value).toBe('p0')
    // 健康 + KA → P1（KA 始终值得每周维护，不符合 P2 的「价值一般」）
    const kaHealthy = tagMerchant({ id: 'b', monthlyGmv: 620_000, conversionRate: 0.032, refundRate: 0.05, avgResponseSec: 25, traffic: 9200, stage: 'converted' })
    expect(kaHealthy.tags.find((t) => t.dimension === 'priority')?.value).toBe('p1')
    // 健康 + 长尾 → P2（这才是「价值一般、常规触达即可」）
    const tailHealthy = tagMerchant({ id: 'c', monthlyGmv: 40_000, conversionRate: 0.03, refundRate: 0.05, avgResponseSec: 20, traffic: 4000, stage: 'converted' })
    expect(tailHealthy.tags.find((t) => t.dimension === 'priority')?.value).toBe('p2')
  })

  test('类目：命中多类目时降置信并标记需复核', async () => {
    const { tagCategory } = await import('@/lib/ecom/tagging')
    const one = tagCategory({ id: 'a', note: '女装店铺' })!
    expect(one.value).toBe('apparel')
    expect(one.needReview).toBe(false)
    const many = tagCategory({ id: 'a', note: '女装和面膜都做' })!
    expect(many.needReview).toBe(true)
    expect(many.evidence).toContain('需复核')
  })

  test('批量打标输出覆盖率与需复核比例（沉淀高质量数据的度量）', async () => {
    const { tagBatch } = await import('@/lib/ecom/tagging')
    const { DEMO_MERCHANTS } = await import('@/lib/ecom/demo-data')
    const { results, summary } = tagBatch(DEMO_MERCHANTS)
    expect(results.length).toBe(DEMO_MERCHANTS.length)
    expect(summary.total).toBe(DEMO_MERCHANTS.length)
    expect(summary.coverage['scale']).toBeGreaterThan(0.5)
    // 缺数据的那条不应被打上健康度标
    const m1006 = results.find((r) => r.merchantId === 'M1006')!
    expect(m1006.coverage['health']).toBe(false)
  })
})

// ===================== 电商垂直场景：经营诊断 =====================

describe('电商经营诊断（diagnosis）', () => {
  test('优先级 = 影响/难度 → 客服响应慢（好改）排在退款率高（难改）前面', async () => {
    const { diagnose } = await import('@/lib/ecom/diagnosis')
    const r = diagnose({ id: 'a', conversionRate: 0.012, refundRate: 0.15, avgResponseSec: 95, traffic: 4200 })
    const problems = r.issues.filter((i) => i.severity !== 'ok')
    expect(problems[0].metric).toBe('客服响应时长')
    // 退款率影响大但难度高，优先级应低于客服
    const resp = problems.find((i) => i.metric === '客服响应时长')!
    const refund = problems.find((i) => i.metric === '退款率')!
    expect(resp.priority).toBeGreaterThan(refund.priority)
  })

  test('数据不足时如实说明，不硬下结论', async () => {
    const { diagnose } = await import('@/lib/ecom/diagnosis')
    const r = diagnose({ id: 'a', monthlyGmv: 12_000 }) // 没有任何经营指标
    expect(r.sufficient).toBe(false)
    expect(r.missingMetrics.length).toBeGreaterThan(0)
    expect(r.headline).toContain('数据不足')
  })

  test('健康分：critical 扣 25、warning 扣 10，最低 0', async () => {
    const { computeScore } = await import('@/lib/ecom/diagnosis')
    const mk = (s: 'critical' | 'warning' | 'ok') =>
      ({ severity: s }) as never
    expect(computeScore([])).toBe(100)
    expect(computeScore([mk('warning')])).toBe(90)
    expect(computeScore([mk('critical')])).toBe(75)
    expect(computeScore([mk('critical'), mk('critical'), mk('critical'), mk('critical'), mk('critical')])).toBe(0)
  })

  test('推荐任务最多 3 条（商家做不完反而失去信任）', async () => {
    const { diagnose } = await import('@/lib/ecom/diagnosis')
    const r = diagnose({ id: 'a', conversionRate: 0.005, refundRate: 0.2, avgResponseSec: 200, traffic: 100 })
    expect(r.tasks.length).toBeLessThanOrEqual(3)
    expect(r.tasks.every((t) => ['p0', 'p1', 'p2'].includes(t.priority))).toBe(true)
  })

  test('批量诊断汇总出「最集中的问题」', async () => {
    const { diagnoseBatch } = await import('@/lib/ecom/diagnosis')
    const { DEMO_MERCHANTS } = await import('@/lib/ecom/demo-data')
    const { summary } = diagnoseBatch(DEMO_MERCHANTS)
    expect(summary.total).toBe(DEMO_MERCHANTS.length)
    expect(summary.topIssues.length).toBeGreaterThan(0)
    expect(summary.avgScore).toBeGreaterThan(0)
  })
})

// ===================== 电商垂直场景：话术质检 =====================

describe('电商话术质检（script）', () => {
  test('好话术满分：有数据、有下一步、不空泛、长度合适', async () => {
    const { checkQuality } = await import('@/lib/ecom/script')
    const good =
      '看到您家近30天进店4200但转化只有1.2%，同行大概在2.5%左右。我们复盘过类似女装店，' +
      '多数是详情页缺尺码表、客服响应超60秒。要不我发您一份3分钟的对比清单？您看完觉得有用再聊。'
    const q = checkQuality(good)
    expect(q.score).toBe(1)
    expect(q.hasViolation).toBe(false)
  })

  test('差话术：检出空话套话、缺数据、缺下一步', async () => {
    const { checkQuality } = await import('@/lib/ecom/script')
    const q = checkQuality('您好，我们是XX平台服务商，可以帮您提升店铺销量。建议您优化一下店铺运营。')
    expect(q.score).toBeLessThan(0.6)
    expect(q.checks.find((c) => c.id === 'not_vague')?.pass).toBe(false)
    expect(q.checks.find((c) => c.id === 'has_numbers')?.pass).toBe(false)
    expect(q.checks.find((c) => c.id === 'has_next_step')?.pass).toBe(false)
  })

  test('**SOP 硬红线**：承诺无法保证的结果 / 索要账号密码 必须判违规', async () => {
    const { checkQuality } = await import('@/lib/ecom/script')
    for (const bad of [
      '保证让您月销翻倍，我们平台一定能帮您上首页。',
      '麻烦把账号密码发我，我帮您看下后台数据。',
    ]) {
      const q = checkQuality(bad)
      expect(q.hasViolation).toBe(true)
      expect(q.checks.find((c) => c.id === 'no_violation')?.pass).toBe(false)
    }
  })

  test('上下文拼装包含画像/诊断/知识库（话术要有据可依）', async () => {
    const { buildContext } = await import('@/lib/ecom/script')
    const ctx = buildContext({
      merchantId: 'M1',
      merchantName: '某女装店',
      intent: 'diagnose',
      tags: [{ dimension: 'scale', value: 'mid', label: '腰部', confidence: 1, evidence: '', needReview: false }],
      diagnosis: {
        merchantId: 'M1', headline: '转化率偏低', score: 60, sufficient: true, missingMetrics: [],
        issues: [{ code: 'c', metric: '支付转化率', severity: 'critical', current: '1.2%', target: '≥2.5%', impact: 5, effort: 3, priority: 1.67, conclusion: '', actions: [] }],
        tasks: [],
      },
      knowledge: ['转化率低先查承接而非急着投流'],
    })
    expect(ctx).toContain('腰部')
    expect(ctx).toContain('支付转化率')
    expect(ctx).toContain('转化率低先查承接')
    expect(ctx).toContain('本次沟通意图')
  })

  test('内置 Prompt 变体至少 3 个且各有设计说明（Prompt 方案对比的前提）', async () => {
    const { BUILTIN_VARIANTS } = await import('@/lib/ecom/script')
    expect(BUILTIN_VARIANTS.length).toBeGreaterThanOrEqual(3)
    for (const v of BUILTIN_VARIANTS) {
      expect(v.rationale.length).toBeGreaterThan(10)
      expect(v.system.length).toBeGreaterThan(50)
    }
    // V3 必须含反例（这是它的核心设计取向）
    expect(BUILTIN_VARIANTS.find((v) => v.id === 'v3_roleplay')?.system).toContain('差的话术长这样')
  })
})

// ===================== 电商场景：数据清洗 =====================

describe('电商数据清洗（cleaning）', () => {
  test('**回归**：带 % 的数值必须能解析（曾因没删掉 % 导致所有比率字段解析失败）', async () => {
    const { parseNumber, parseRate } = await import('@/lib/ecom/cleaning')
    // 这个 bug 让完整度直接从 86% 掉到 0%，是最典型的「脏数据静默变空」
    expect(parseNumber('6%')).toBeCloseTo(0.06, 6)
    expect(parseNumber('1.2%')).toBeCloseTo(0.012, 6)
    expect(parseRate('6%')).toBeCloseTo(0.06, 6)
    expect(parseRate('1.2%')).toBeCloseTo(0.012, 6)
    // 全角 ％ 也要能处理
    expect(parseRate('1.8％')).toBeCloseTo(0.018, 6)
    // 数字形态：>1 视为百分数写法
    expect(parseRate(1.2)).toBeCloseTo(0.012, 6)
    expect(parseRate(0.012)).toBeCloseTo(0.012, 6)
  })

  test('千分位 / 货币符号 / 中文数量单位都能解析', async () => {
    const { parseNumber } = await import('@/lib/ecom/cleaning')
    expect(parseNumber('¥1,234,567')).toBe(1234567)
    expect(parseNumber('123.4万')).toBe(1234000)
    expect(parseNumber('1.2亿')).toBe(120000000)
    expect(parseNumber('１２３')).toBe(123) // 全角数字
    expect(parseNumber('abc')).toBeNull() // 无法解析 → null，不猜
  })

  test('空值的各种写法都能识别（空串 / - / N/A / 暂无）', async () => {
    const { isNullish } = await import('@/lib/ecom/cleaning')
    for (const v of ['', '  ', '-', 'N/A', 'null', '暂无', '无', '未知', null, undefined]) {
      expect(isNullish(v)).toBe(true)
    }
    expect(isNullish('0')).toBe(false)
    expect(isNullish(0)).toBe(false)
  })

  test('中英文表头都能映射到标准字段（真实导出表列名千奇百怪）', async () => {
    const { mapColumns } = await import('@/lib/ecom/cleaning')
    const m = mapColumns({ 商家ID: 'M1', 退款率: '6%', 转化率: '1.2%', 月GMV: '8万', 跟进记录: 'x' })
    expect(m.id).toBe('M1')
    expect(m.refundRate).toBe('6%')
    expect(m.conversionRate).toBe('1.2%')
    expect(m.monthlyGmv).toBe('8万')
    expect(m.note).toBe('x')
  })

  test('异常值不静默采用：置空并记入报告（错误数据比没数据更糟）', async () => {
    const { cleanRecords } = await import('@/lib/ecom/cleaning')
    const r = cleanRecords([
      { 商家ID: 'A', 月GMV: '-5000', 退款率: '150%', 转化率: '2%' },
    ])
    expect(r.report.outliers.length).toBe(2)
    const rec = r.records[0]
    expect(rec.monthlyGmv).toBeUndefined() // 负数 → 置空
    expect(rec.refundRate).toBeUndefined() // >100% → 置空
    expect(rec.conversionRate).toBeCloseTo(0.02, 6) // 正常值保留
  })

  test('去重保留字段更完整的一条', async () => {
    const { cleanRecords } = await import('@/lib/ecom/cleaning')
    const r = cleanRecords([
      { 商家ID: 'A1', 商家名称: '某店', 转化率: '2%' },
      { 商家ID: 'A2', 商家名称: '某店', 转化率: '2%', 退款率: '5%', 进店量: '3000' },
    ])
    expect(r.records.length).toBe(1)
    expect(r.report.duplicates.length).toBe(1)
    // 保留了字段更多的那条
    expect(r.records[0].refundRate).toBeCloseTo(0.05, 6)
  })

  test('清洗动作留痕（运营能复核「你改了我什么」）', async () => {
    const { cleanRecords } = await import('@/lib/ecom/cleaning')
    const r = cleanRecords([{ 商家ID: 'A', 月GMV: '¥220,000' }])
    expect(r.fixes.length).toBeGreaterThan(0)
    const f = r.fixes[0]
    expect(f.merchantId).toBe('A')
    expect(f.field).toBe('monthlyGmv')
    expect(f.from).toBe('¥220,000')
    expect(f.reason.length).toBeGreaterThan(0)
  })
})

// ===================== 电商场景：CSV 与全链路 =====================

describe('CSV 导入导出 + 全链路 pipeline', () => {
  test('CSV 解析处理引号/逗号/换行/转义引号', async () => {
    const { parseCsv } = await import('@/lib/ecom/pipeline')
    const csv = 'id,name,note\nA,"公司, 分公司","第一行\n第二行"\nB,普通,"含""引号"""\n'
    const rows = parseCsv(csv)
    expect(rows.length).toBe(2)
    expect(rows[0].name).toBe('公司, 分公司')
    expect(rows[0].note).toContain('\n') // 字段内换行不被当行分隔
    expect(rows[1].note).toBe('含"引号"') // "" 转义成一个 "
  })

  test('BOM 头被去掉（否则 Excel 存的第一列列名匹配不上）', async () => {
    const { parseCsv } = await import('@/lib/ecom/pipeline')
    const rows = parseCsv('\ufeff商家ID,转化率\nA,2%\n')
    expect(Object.keys(rows[0])[0]).toBe('商家ID')
  })

  test('**结构性问题必须检出**：列数不匹配会静默错位，比解析失败更危险', async () => {
    const { parseCsvWithIssues } = await import('@/lib/ecom/pipeline')
    // 未加引号的 ¥99,000 会被拆成两列
    const csv = 'id,name,gmv\nA,正常,100\nB,坏行,¥99,000\n'
    const { rows, issues } = parseCsvWithIssues(csv)
    expect(rows.length).toBe(2)
    expect(issues.length).toBe(1)
    expect(issues[0].line).toBe(3)
    expect(issues[0].expected).toBe(3)
    expect(issues[0].actual).toBe(4)
  })

  test('CSV 导出：含逗号/引号/换行的字段正确转义，且带 BOM', async () => {
    const { escapeCsv, toCsv } = await import('@/lib/ecom/pipeline')
    expect(escapeCsv('普通')).toBe('普通')
    expect(escapeCsv('含,逗号')).toBe('"含,逗号"')
    expect(escapeCsv('含"引号')).toBe('"含""引号"')
    const out = toCsv(['a', 'b'], [['含,逗号', '普通']])
    expect(out.charCodeAt(0)).toBe(0xfeff) // BOM
    expect(out).toContain('"含,逗号"')
  })

  test('全链路：脏 CSV → 清洗 → 打标 → 诊断，端到端可跑', async () => {
    const { runPipelineFromCsv } = await import('@/lib/ecom/pipeline')
    const csv =
      '商家ID,商家名称,月GMV,转化率,退款率,响应时长,进店量,跟进记录,阶段\n' +
      'M1,女装店,"¥220,000",1.2%,15%,95,4200,转化率低退款多,有意向\n' +
      'M2,零食店,8万,1.8％,6%,40,2600,想做直播,已联系\n'
    const r = runPipelineFromCsv(csv)
    expect(r.summary.inputRows).toBe(2)
    expect(r.summary.validRows).toBe(2)
    expect(r.structuralIssues.length).toBe(0)
    // 数值清洗正确（含中文单位与百分号）
    expect(r.enriched[0].record.monthlyGmv).toBe(220000)
    expect(r.enriched[0].record.conversionRate).toBeCloseTo(0.012, 6)
    // 打标 + 诊断都产出了
    expect(r.enriched[0].tags.length).toBeGreaterThan(0)
    expect(r.enriched[0].diagnosis.headline.length).toBeGreaterThan(0)
    // 优先级分布有统计
    expect(Object.values(r.summary.priorityCount).reduce((a, b) => a + b, 0)).toBe(2)
  })

  test('导出表含关键列（运营可直接用）', async () => {
    const { runPipelineFromCsv, exportEnriched } = await import('@/lib/ecom/pipeline')
    const r = runPipelineFromCsv('商家ID,商家名称,转化率,退款率,响应时长,进店量\nA,某店,1.2%,15%,95,4200\n')
    const out = exportEnriched(r.enriched)
    for (const col of ['跟进优先级', '健康分', '诊断结论', '推荐任务1', '需复核标签数']) {
      expect(out).toContain(col)
    }
  })
})

// ===================== 电商场景：打标纠错回流 =====================

describe('打标纠错回流（tag-store）', () => {
  test('纠错类型分类：误标 / 漏标 / 改值', async () => {
    const { classifyCorrection } = await import('@/lib/ecom/tag-store')
    expect(classifyCorrection({ merchantId: 'M', dimension: 'scale', original: 'ka', corrected: '', at: 0 })).toBe('false_positive')
    expect(classifyCorrection({ merchantId: 'M', dimension: 'category', original: '', corrected: 'apparel', at: 0 })).toBe('false_negative')
    expect(classifyCorrection({ merchantId: 'M', dimension: 'health', original: 'healthy', corrected: 'at_risk', at: 0 })).toBe('value_change')
  })

  test('归因：统计各维度纠错分布，并给出**具体的迭代建议**', async () => {
    const { recordCorrection, analyzeCorrections, clearCorrections } = await import('@/lib/ecom/tag-store')
    clearCorrections()
    try {
      // 类目主要是漏标 → 建议补关键词/走 LLM 兜底
      recordCorrection({ merchantId: 'M1', dimension: 'category', original: '', corrected: 'apparel' })
      recordCorrection({ merchantId: 'M2', dimension: 'category', original: '', corrected: 'beauty' })
      // 规模主要是误标 → 建议收紧阈值
      recordCorrection({ merchantId: 'M3', dimension: 'scale', original: 'ka', corrected: '' })

      const r = analyzeCorrections()
      expect(r.total).toBe(3)
      const cat = r.byDimension.find((d) => d.dimension === 'category')!
      expect(cat.dominantKind).toBe('false_negative')
      expect(cat.advice).toContain('漏标')
      const scale = r.byDimension.find((d) => d.dimension === 'scale')!
      expect(scale.dominantKind).toBe('false_positive')
      expect(scale.advice).toContain('误标')
      expect(r.topPriority.length).toBeGreaterThan(0)
    } finally {
      clearCorrections()
    }
  })

  test('**口径诚实性**：报告必须声明这是纠错样本估计、偏高，不是全量准确率', async () => {
    const { recordCorrection, analyzeCorrections, clearCorrections } = await import('@/lib/ecom/tag-store')
    clearCorrections()
    try {
      recordCorrection({ merchantId: 'M1', dimension: 'category', original: '', corrected: 'apparel' })
      const r = analyzeCorrections()
      expect(r.caveat).toContain('偏高')
      expect(r.caveat).toContain('不是全量准确率')
    } finally {
      clearCorrections()
    }
  })

  test('纠错可应用到标签上：误标删除、漏标补上（置信度给 1）', async () => {
    const { recordCorrection, applyCorrections, clearCorrections } = await import('@/lib/ecom/tag-store')
    clearCorrections()
    try {
      recordCorrection({ merchantId: 'M1', dimension: 'scale', original: 'ka', corrected: '' })
      recordCorrection({ merchantId: 'M1', dimension: 'category', original: '', corrected: 'apparel', reason: '商家自述' })
      const tags = [
        { dimension: 'scale', value: 'ka', label: 'KA', confidence: 1, evidence: '', needReview: false },
        { dimension: 'health', value: 'healthy', label: '健康', confidence: 0.9, evidence: '', needReview: false },
      ]
      const out = applyCorrections(tags, 'M1')
      expect(out.find((t) => t.dimension === 'scale')).toBeUndefined() // 误标被删
      const cat = out.find((t) => t.dimension === 'category')!
      expect(cat.value).toBe('apparel') // 漏标被补
      expect(cat.confidence).toBe(1)
      expect(cat.evidence).toContain('人工补充')
      expect(out.find((t) => t.dimension === 'health')).toBeDefined() // 无关标签不动
    } finally {
      clearCorrections()
    }
  })
})

// ===================== 电商评测体系：指标库 =====================

describe('评价指标库（metrics）', () => {
  test('分类报告：全对 / 全错 / 空集都不产生 NaN', async () => {
    const { classificationReport } = await import('@/lib/ecom/metrics')

    const perfect = classificationReport(['a', 'b', 'a'], ['a', 'b', 'a'])
    expect(perfect.accuracy).toBe(1)
    expect(perfect.macro.f1).toBe(1)

    const allWrong = classificationReport(['a', 'b'], ['b', 'a'])
    expect(allWrong.accuracy).toBe(0)

    // 空集必须返回确定值而不是 NaN —— 否则报告里出现 NaN，运营会以为系统坏了
    const empty = classificationReport([], [])
    expect(empty.accuracy).toBe(0)
    expect(Number.isNaN(empty.macro.f1)).toBe(false)
    expect(empty.total).toBe(0)
  })

  test('**null 语义**：真实「不打标」+ 预测「不打标」算正确；误标/漏标分别拉低 P / R', async () => {
    const { classificationReport } = await import('@/lib/ecom/metrics')
    // 3 条：1 条正确不打标、1 条误标（真实 null 预测有值）、1 条正确
    const r = classificationReport(['a', null, 'a'], ['a', 'a', 'a'])
    expect(r.accuracy).toBeCloseTo(2 / 3, 5) // null/null 那条算对，null/a 那条算错
    const clsA = r.perClass.find((c) => c.label === 'a')!
    expect(clsA.fp).toBe(1) // 误标计入 FP
  })

  test('多标签报告：完全匹配率 与 逐标签 F1 是两件事', async () => {
    const { multiLabelReport } = await import('@/lib/ecom/metrics')
    // 第 1 条完全对；第 2 条多了一个标签（部分对）
    const r = multiLabelReport([['x'], ['y']], [['x'], ['y', 'z']])
    expect(r.subsetAccuracy).toBe(0.5) // 只有第 1 条完全匹配
    const y = r.perLabel.find((l) => l.label === 'y')!
    expect(y.tp).toBe(1) // y 本身命中了，所以逐标签 F1 不为 0
    expect(y.recall).toBe(1)
  })

  test('Cohen Kappa：完全一致=1；单类别且完全一致也必须返回 1（不是 NaN）', async () => {
    const { cohensKappa, interpretKappa } = await import('@/lib/ecom/metrics')
    expect(cohensKappa(['a', 'b', 'c'], ['a', 'b', 'c']).kappa).toBe(1)
    // pe = 1 的退化情形：双方都只用一个类别
    expect(cohensKappa(['a', 'a'], ['a', 'a']).kappa).toBe(1)
    expect(cohensKappa(['a', 'a'], ['b', 'b']).kappa).toBe(0)
    // 随机水平的一致性应接近 0
    const k = cohensKappa(['a', 'b', 'a', 'b'], ['b', 'a', 'b', 'a']).kappa
    expect(k).toBeLessThan(0)
    expect(interpretKappa(0.9)).toContain('极好')
    expect(interpretKappa(0.1)).toContain('差')
  })

  test('排序指标：完美排序 NDCG=1；顺序颠倒应明显更低', async () => {
    const { ndcgAtK, precisionAtK } = await import('@/lib/ecom/metrics')
    const ideal = [3, 2, 1]
    expect(ndcgAtK(ideal, 3)).toBeCloseTo(1, 5)
    const reversed = [1, 2, 3]
    expect(ndcgAtK(reversed, 3)).toBeLessThan(0.9)
    expect(precisionAtK(ideal, 3)).toBeCloseTo(1 / 3, 5) // 只有 1 个 relevance>=3
    expect(precisionAtK([3, 3, 3], 3)).toBe(1)
    // 空集不崩
    expect(ndcgAtK([], 3)).toBe(0)
    expect(precisionAtK([], 3)).toBe(0)
  })

  test('数据质量四维：四维都算得出来，且能定位最弱一维', async () => {
    const { dataQualityMetrics, weakestOf } = await import('@/lib/ecom/metrics')
    const m = dataQualityMetrics({
      rows: 10,
      validRows: 9,
      completeness: { a: 1, b: 0.5 },
      outliers: 0,
      structuralIssues: 0,
      duplicates: 1,
    })
    expect(m.completeness).toBeCloseTo(0.75, 5)
    expect(m.uniqueness).toBeCloseTo(0.9, 5)
    expect(m.overall).toBeGreaterThan(0)
    const w = weakestOf({ completeness: 0.75, accuracy: 1, consistency: 1, uniqueness: 0.9 })!
    expect(w.key).toBe('completeness')
  })
})

// ===================== 电商评测体系：口径与回归锁定 =====================

describe('打标口径与评测体系', () => {
  test('**口径单一来源**：打标与诊断对同一商家必须给出同源结论', async () => {
    const { gradeMetric, isCritical } = await import('@/lib/ecom/thresholds')
    const { tagHealth } = await import('@/lib/ecom/tagging')
    const { evaluateIssues } = await import('@/lib/ecom/diagnosis')

    // 转化率 2.2%：在达标线(2.5%)下、严重线(2.0%)上 → 诊断应为 warning，打标不应算「严重项」
    expect(gradeMetric('conversionRate', 0.022)).toBe('warning')
    expect(isCritical('conversionRate', 0.022)).toBe(false)
    const rec = { id: 'x', conversionRate: 0.022 }
    expect(tagHealth(rec)?.value).toBe('healthy')
    expect(evaluateIssues(rec).issues[0].severity).toBe('warning')

    // 转化率 1.2%：跌破严重线 → 打标「亚健康」+ 诊断 critical
    expect(tagHealth({ id: 'y', conversionRate: 0.012 })?.value).toBe('at_risk')
    expect(evaluateIssues({ id: 'y', conversionRate: 0.012 }).issues[0].severity).toBe('critical')
  })

  test('**口径缺陷已修**：四项指标全低于达标线 → 亚健康（不是健康）', async () => {
    const { tagHealth } = await import('@/lib/ecom/tagging')
    // 全部落在预警区（无严重项）：旧口径会判「健康」，这是被挑战集 C07 暴露的漏洞
    const allWarn = { id: 'w', conversionRate: 0.022, refundRate: 0.09, avgResponseSec: 45, traffic: 2000 }
    expect(tagHealth(allWarn)?.value).toBe('at_risk')
    // 但「三项预警 + 一项达标」仍是健康 —— 达标线是优秀线，不能一低于就判亚健康
    const threeWarn = { id: 'w2', conversionRate: 0.022, refundRate: 0.09, avgResponseSec: 45, traffic: 5000 }
    expect(tagHealth(threeWarn)?.value).toBe('healthy')
  })

  test('**优先级只看严重项**：全项平庸不该占用 P0（稀缺资源）', async () => {
    const { tagMerchant } = await import('@/lib/ecom/tagging')
    // 腰部 + 全项预警（0 严重项）→ 亚健康，但优先级应是 P1 而非 P0
    const r = tagMerchant({ id: 'p', monthlyGmv: 200_000, conversionRate: 0.022, refundRate: 0.09, avgResponseSec: 45, traffic: 2000 })
    expect(r.tags.find((t) => t.dimension === 'health')?.value).toBe('at_risk')
    expect(r.tags.find((t) => t.dimension === 'priority')?.value).toBe('p1')
  })

  test('**回归集必须全对**：任何不一致都说明改动破坏了已定口径', async () => {
    const { evaluateTagging } = await import('@/lib/ecom/evaluate')
    const { GOLDEN_SET } = await import('@/lib/ecom/golden')
    const r = evaluateTagging(undefined, GOLDEN_SET)
    if (r.mismatches.length) {
      console.log('回归集差异：', r.mismatches.map((m) => `${m.id}[${m.dimension}] ${m.expected}→${m.predicted}`).join(' | '))
    }
    expect(r.mismatches.length).toBe(0)
    expect(r.overallMacroF1).toBe(1)
    expect(r.overallKappa).toBe(1)
  })

  test('**挑战集：只允许 3 处已知能力边界失败**（数量变多 = 泛化能力退化）', async () => {
    const { evaluateTagging } = await import('@/lib/ecom/evaluate')
    const { CHALLENGE_SET } = await import('@/lib/ecom/golden')
    const r = evaluateTagging(undefined, CHALLENGE_SET)
    const knownBoundary = new Set(['C03', 'C04', 'C09'])
    const unexpected = r.mismatches.filter((m) => !knownBoundary.has(m.id))
    expect(unexpected.map((m) => m.id)).toEqual([])
    // 单标签维度应全部通过（同义词类失败已在词表修复中解决）
    const singleDims = r.dimensions.filter((d) => d.kind === 'single')
    for (const d of singleDims) expect(d.macroF1).toBe(1)
  })

  test('挑战集能覆盖三类真实泛化场景（同义词 / 否定 / 文本数字）', async () => {
    const { CHALLENGE_SET } = await import('@/lib/ecom/golden')
    const covers = CHALLENGE_SET.map((c) => c.covers).join('\n')
    expect(covers).toContain('词表覆盖')
    expect(covers).toContain('能力边界')
    expect(covers).toContain('对照组') // 挑战集不能「为了挑错而挑错」
  })

  test('阈值可配置：换类目预设会改变判定结果（证明阈值不是写死的）', async () => {
    const { PRESETS, DEFAULT_THRESHOLDS } = await import('@/lib/ecom/thresholds')
    const { tagHealth } = await import('@/lib/ecom/tagging')
    // 退款率 12%：通用口径下跌破严重线 → 亚健康
    const rec = { id: 'c', refundRate: 0.12, conversionRate: 0.03, avgResponseSec: 25, traffic: 5000 }
    expect(tagHealth(rec, DEFAULT_THRESHOLDS)?.value).toBe('at_risk')
    // 服饰类目预设把退款严重线放到 18% → 同一商家应判健康
    expect(tagHealth(rec, PRESETS.apparel)?.value).toBe('healthy')
  })

  test('金标准集覆盖检查：各维度都有多个取值（没有样本盲区）', async () => {
    const { goldenCoverage } = await import('@/lib/ecom/golden')
    const cov = goldenCoverage()
    expect(Object.keys(cov.health).length).toBeGreaterThanOrEqual(3)
    expect(Object.keys(cov.priority).length).toBeGreaterThanOrEqual(3)
    expect(Object.keys(cov.scale).length).toBeGreaterThanOrEqual(3)
  })

  test('校准在样本量不足时会**如实报告未达显著**（不吹嘘调参收益）', async () => {
    const { calibrate } = await import('@/lib/ecom/evaluate')
    const r = calibrate()
    expect(r.tried).toBeGreaterThan(100) // 确实搜索了
    // n=24 且 6 个参数 → 必须诚实提示过拟合风险，且不宣称显著提升
    expect(r.caveat).toContain('过拟合')
    if (r.gain < 0.05) expect(r.significant).toBe(false)
  })
})
