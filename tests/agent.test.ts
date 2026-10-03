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
    expect(filterTools().length).toBeGreaterThanOrEqual(13)
    // 关键工具必须存在
    const names = filterTools().map((t) => t.function.name)
    for (const n of ['edit_file', 'multi_edit', 'glob', 'grep', 'todo_write', 'search_ast']) {
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
