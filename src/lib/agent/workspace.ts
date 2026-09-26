/**
 * 会话工作区管理：每个会话对应一个沙箱目录，
 * 目录内是一个真实的 Node 小项目（含预埋 bug 与测试），
 * Agent 的所有文件/命令/Git 操作都被限制在该目录内。
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'

export const WORKSPACE_ROOT = path.join(process.cwd(), 'workspace')

export function ensureWorkspaceRoot() {
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true })
}

/** 模板项目：内容会被复制到新会话沙箱 */
const TEMPLATE_DIR = path.join(process.cwd(), 'assets', 'template-project')
/** 备用模板：用于 held-out 评测（与主模板不同的问题域，避免过拟合） */
export const HOLDOUT_TEMPLATE_DIR = path.join(process.cwd(), 'assets', 'holdout-project')

export function sessionDir(sessionId: string) {
  return path.join(WORKSPACE_ROOT, sessionId)
}

/**
 * 在沙箱内初始化一个独立的 Git 仓库。
 *
 * 为什么必须做：workspace/ 位于宿主项目目录内，若不 git init，
 * 任何 git 命令都会沿目录向上找到**宿主的 .git**（而宿主 .gitignore
 * 又忽略了 workspace/），于是 git status 永远"无改动"、commit 永远失败。
 * 给每个沙箱建自己的 .git，Git 操作才真正作用于沙箱。
 */
function initGitRepo(dir: string) {
  if (fs.existsSync(path.join(dir, '.git'))) return
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'DevMate',
    GIT_AUTHOR_EMAIL: 'devmate@local',
    GIT_COMMITTER_NAME: 'DevMate',
    GIT_COMMITTER_EMAIL: 'devmate@local',
  }
  const run = (args: string[]) => spawnSync('git', args, { cwd: dir, env, stdio: 'ignore' })
  run(['init', '-q', '-b', 'main'])
  run(['add', '-A'])
  run(['commit', '-q', '-m', 'chore: init workspace'])
}

export function createWorkspace(sessionId: string, templateDir: string = TEMPLATE_DIR) {
  ensureWorkspaceRoot()
  const dir = sessionDir(sessionId)
  fs.mkdirSync(dir, { recursive: true })
  copyDir(templateDir, dir)
  initGitRepo(dir)
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
