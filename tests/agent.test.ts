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
