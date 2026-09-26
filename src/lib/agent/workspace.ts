/**
 * 会话工作区管理：每个会话对应一个沙箱目录，
 * 目录内是一个真实的 Node 小项目（含预埋 bug 与测试），
 * Agent 的所有文件/命令/Git 操作都被限制在该目录内。
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const WORKSPACE_ROOT = path.join(process.cwd(), 'workspace')

export function ensureWorkspaceRoot() {
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true })
}

/** 模板项目：src/ 下的内容会被复制到新会话沙箱 */
const TEMPLATE_DIR = path.join(process.cwd(), 'assets', 'template-project')

export function sessionDir(sessionId: string) {
  return path.join(WORKSPACE_ROOT, sessionId)
}

export function createWorkspace(sessionId: string) {
  ensureWorkspaceRoot()
  const dir = sessionDir(sessionId)
  fs.mkdirSync(dir, { recursive: true })
  copyDir(TEMPLATE_DIR, dir)
  return dir
}

export function workspaceExists(sessionId: string) {
  return fs.existsSync(sessionDir(sessionId))
}

function copyDir(src: string, dest: string) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      fs.mkdirSync(d, { recursive: true })
      copyDir(s, d)
    } else {
      fs.copyFileSync(s, d)
    }
  }
}

/**
 * 路径安全：将 Agent 给出的相对路径规范化，
 * 禁止任何形式的目录逃逸（..、绝对路径、符号链接）。
 */
export function safeResolve(sessionId: string, relPath: string): string {
  const root = sessionDir(sessionId)
  const resolved = path.resolve(root, relPath.replace(/^[/\\]+/, ''))
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`路径越界（禁止访问沙箱外）: ${relPath}`)
  }
  return resolved
}

export function newRunId() {
  return randomUUID().slice(0, 8)
}
