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
