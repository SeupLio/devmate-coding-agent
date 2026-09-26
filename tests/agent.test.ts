/**
 * DevMate 单元测试：沙箱安全、工具执行、上下文压缩。
 * 运行：bun test tests/agent.test.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test, beforeAll } from 'bun:test'
import { createWorkspace, safeResolve, sessionDir, workspaceExists } from '@/lib/agent/workspace'
import { executeTool } from '@/lib/agent/tools'
import { compressContext, totalTokens, CONTEXT_TOKEN_BUDGET } from '@/lib/agent/context'
import { estimateTokens } from '@/lib/agent/llm'

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

  test('search_code 关键词与正则检索', async () => {
    const out = await executeTool({ sessionId: SID }, 'search_code', { query: 'fibonacci', isRegex: false })
    expect(out).toMatch(/mathutils(\.test)?\.js:\d+/)
    const re = await executeTool({ sessionId: SID }, 'search_code', { query: 'average\\(', isRegex: true })
    expect(re).toContain('mathutils.js')
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
  test('filterTools：不传返回全部 7 个工具', async () => {
    const { filterTools } = await import('@/lib/agent/tools')
    expect(filterTools().length).toBe(7)
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
      'list_files', 'read_file', 'write_file', 'search_code', 'run_command', 'git_operation',
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
  test('内置 5 个 ablation 组 + 1 个裸模型组', async () => {
    const { ABLATION_CONFIGS, BARE_CONFIG } = await import('@/lib/eval/ablation')
    expect(ABLATION_CONFIGS.length).toBe(5)
    expect(ABLATION_CONFIGS.map((c) => c.id)).toEqual([
      'full', 'no-plan', 'no-verify', 'no-search', 'no-compress',
    ])
    expect(BARE_CONFIG.id).toBe('bare')
  })

  test('「无自我验证」组确实移除了 run_tests', async () => {
    const { ABLATION_CONFIGS } = await import('@/lib/eval/ablation')
    const noVerify = ABLATION_CONFIGS.find((c) => c.id === 'no-verify')!
    expect(noVerify.toolFilter).toBeDefined()
    expect(noVerify.toolFilter).not.toContain('run_tests')
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
