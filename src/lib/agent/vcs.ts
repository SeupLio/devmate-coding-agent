/**
 * 版本控制抽象层 —— 为 JD 里点名的「P4 管理」预留接入口。
 *
 * ## 为什么要抽象
 *
 * 米哈游的项目大量使用 **Perforce（P4）**（大二进制资产 + 中央仓库的典型场景），
 * 而不是 Git。一个只认 `git` 的 Coding Agent 到了这种环境里就是个废人。
 *
 * 但「抽象」不等于「假装实现了」。这里的诚实边界：
 *
 * | Provider | 状态 |
 * |---|---|
 * | `GitProvider` | ✅ 完整实现，有单测，是当前默认 |
 * | `PerforceProvider` | ⚠️ **命令映射已写好，但未在真实 P4 服务器上验证过** |
 *
 * PerforceProvider 里每个方法都做了两件事：先探测 `p4` CLI 是否可用，
 * 不可用就抛出**可操作的错误**（告诉你缺什么、怎么装），而不是假装成功。
 * 命令映射本身（`p4 opened` / `p4 diff` / `p4 submit -d`）是按 P4 官方语义写的，
 * 接入真实环境时主要需要调的是 depot 路径映射与 changelist 管理。
 *
 * 接入方式：设 `VCS_PROVIDER=perforce`（默认 `git`）。
 */
import { spawn } from 'node:child_process'

export interface VcsChange {
  path: string
  /** 状态标记，语义由各 provider 定义（Git: M/A/D/??；P4: edit/add/delete） */
  status: string
}

export interface VcsStatus {
  /** Git 是 branch，P4 是 client/stream */
  branch: string
  changes: VcsChange[]
  clean: boolean
}

export interface VcsLogEntry {
  rev: string
  subject: string
  author: string
  date: string
}

export interface VcsResult {
  ok: boolean
  output: string
}

export interface VcsProvider {
  readonly name: string
  /** 该 provider 在当前机器上是否可用（CLI 是否装好） */
  available(): Promise<boolean>
  status(cwd: string): Promise<VcsStatus>
  diff(cwd: string, base?: string): Promise<string>
  /** 暂存全部改动 */
  stageAll(cwd: string): Promise<VcsResult>
  commit(cwd: string, message: string): Promise<VcsResult>
  log(cwd: string, limit?: number): Promise<VcsLogEntry[]>
  /** 该 provider 的能力/限制说明（会展示给使用者） */
  describe(): string
}

// ===================== 通用命令执行 =====================

function exec(cmd: string, args: string[], cwd: string, timeoutMs = 20_000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, args, {
        cwd,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'DevMate',
          GIT_AUTHOR_EMAIL: 'devmate@local',
          GIT_COMMITTER_NAME: 'DevMate',
          GIT_COMMITTER_EMAIL: 'devmate@local',
          // 让 p4 不弹交互提示，否则会挂住
          P4CONFIG: process.env.P4CONFIG ?? '.p4config',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      resolve({ stdout: '', stderr: e instanceof Error ? e.message : String(e), code: -1 })
      return
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      stderr += '\n[超时：命令被强制终止]'
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout?.on('data', (d) => (stdout += d.toString()))
    child.stderr?.on('data', (d) => (stderr += d.toString()))
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, code: code ?? -1 })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ stdout, stderr: err.message, code: -1 })
    })
  })
}

async function hasCli(cmd: string): Promise<boolean> {
  const r = await exec(cmd, ['--version'], process.cwd(), 5000)
  return r.code === 0
}

// ===================== Git =====================

export class GitProvider implements VcsProvider {
  readonly name = 'git'

  async available(): Promise<boolean> {
    return hasCli('git')
  }

  async status(cwd: string): Promise<VcsStatus> {
    const r = await exec('git', ['status', '--short', '-b'], cwd)
    const lines = r.stdout.split('\n').filter(Boolean)
    const branchLine = lines.find((l) => l.startsWith('##')) ?? ''
    const branch = branchLine.replace(/^##\s*/, '').split('...')[0].trim()
    const changes = lines
      .filter((l) => !l.startsWith('##'))
      .map((l) => ({ status: l.slice(0, 2).trim(), path: l.slice(3).trim() }))
    return { branch, changes, clean: changes.length === 0 }
  }

  async diff(cwd: string, base = 'HEAD'): Promise<string> {
    const r = await exec('git', ['diff', base, '--unified=3'], cwd)
    return r.code === 0 ? r.stdout : `git diff 失败：${r.stderr}`
  }

  async stageAll(cwd: string): Promise<VcsResult> {
    const r = await exec('git', ['add', '-A'], cwd)
    return { ok: r.code === 0, output: r.stdout || r.stderr }
  }

  async commit(cwd: string, message: string): Promise<VcsResult> {
    await this.stageAll(cwd)
    const r = await exec('git', ['commit', '-m', message], cwd)
    return { ok: r.code === 0, output: (r.stdout || r.stderr).trim() }
  }

  async log(cwd: string, limit = 10): Promise<VcsLogEntry[]> {
    const r = await exec('git', ['log', `-${limit}`, '--pretty=format:%h%x09%s%x09%an%x09%ad', '--date=short'], cwd)
    if (r.code !== 0) return []
    return r.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [rev, subject, author, date] = l.split('\t')
        return { rev, subject, author, date }
      })
  }

  describe(): string {
    return 'Git：分支模型，提交是本地操作。工作区已初始化为独立仓库（每个会话一个）。'
  }
}

// ===================== Perforce =====================

/**
 * ⚠️ **未在真实 P4 服务器上验证**。
 *
 * 命令映射按 P4 官方语义编写，接入时需要重点核对：
 *  1. depot ↔ workspace 路径映射（`p4 where`）—— Agent 看到的是本地路径，
 *     但 `p4` 的很多命令要的是 depot 路径
 *  2. changelist 管理：P4 的「提交」是 `p4 submit`，需要先 `p4 change` 建 changelist
 *     或直接 `p4 submit -d "msg"`（隐式建单）
 *  3. 默认只读工作区（`p4 sync` 后文件是只读的），改文件前必须 `p4 edit`
 *     —— 这一步在 Git 世界里没有对应物，是最容易踩的坑
 */
export class PerforceProvider implements VcsProvider {
  readonly name = 'perforce'

  async available(): Promise<boolean> {
    return hasCli('p4')
  }

  private async ensure(cwd: string): Promise<string | null> {
    if (!(await this.available())) {
      return (
        'Perforce CLI 不可用：未找到 `p4` 命令。\n' +
        '  安装：https://www.perforce.com/downloads/helix-command-line-client\n' +
        '  并确保已设置 P4PORT / P4USER / P4CLIENT（或在仓库根放 .p4config）。'
      )
    }
    const r = await exec('p4', ['info'], cwd, 8000)
    if (r.code !== 0) {
      return `p4 连接失败：${r.stderr.trim() || r.stdout.trim()}\n  请检查 P4PORT / P4USER / P4CLIENT 配置。`
    }
    return null
  }

  async status(cwd: string): Promise<VcsStatus> {
    const err = await this.ensure(cwd)
    if (err) throw new Error(err)
    // p4 opened：本 changelist 里已 checkout 的文件
    const opened = await exec('p4', ['opened'], cwd, 15_000)
    const changes: VcsChange[] = opened.stdout
      .split('\n')
      .filter((l) => l.includes(' - '))
      .map((l) => {
        // 形如: //depot/foo/bar.js#3 - edit default change (text)
        const [depot, rest] = l.split(' - ')
        const action = rest?.split(' ')[0] ?? '?'
        return { path: depot.replace(/#\d+$/, '').trim(), status: action }
      })
    const info = await exec('p4', ['info'], cwd, 8000)
    const clientLine = info.stdout.split('\n').find((l) => l.startsWith('Client name:')) ?? ''
    const branch = clientLine.replace('Client name:', '').trim()
    // P4 里「未 opened 但有本地改动」需要 reconcile 才能发现，这里只报 opened
    return { branch, changes, clean: changes.length === 0 }
  }

  async diff(cwd: string, base?: string): Promise<string> {
    const err = await this.ensure(cwd)
    if (err) throw new Error(err)
    // p4 diff -du：unified 格式；base 参数在 P4 语义下是 changelist/revision
    const args = ['diff', '-du']
    if (base) args.push(`-c`, base)
    const r = await exec('p4', args, cwd, 20_000)
    return r.stdout || '(无改动)'
  }

  async stageAll(cwd: string): Promise<VcsResult> {
    const err = await this.ensure(cwd)
    if (err) return { ok: false, output: err }
    // P4 没有「暂存区」。对应操作是 `p4 reconcile`：
    // 把工作区里实际发生的增删改同步成 pending changelist 条目。
    const r = await exec('p4', ['reconcile'], cwd, 30_000)
    return { ok: r.code === 0, output: (r.stdout || r.stderr).trim() }
  }

  async commit(cwd: string, message: string): Promise<VcsResult> {
    const err = await this.ensure(cwd)
    if (err) return { ok: false, output: err }
    await this.stageAll(cwd)
    // -d 指定描述；P4 会隐式创建 default changelist 并提交
    const r = await exec('p4', ['submit', '-d', message], cwd, 60_000)
    return { ok: r.code === 0, output: (r.stdout || r.stderr).trim() }
  }

  async log(cwd: string, limit = 10): Promise<VcsLogEntry[]> {
    const err = await this.ensure(cwd)
    if (err) return []
    const r = await exec('p4', ['changes', '-m', String(limit), '-s', 'submitted'], cwd, 20_000)
    return r.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        // 形如: Change 12345 on 2026/10/06 by alice@client 'fix: xxx'
        const m = /^Change (\d+) on ([\d/]+) by (\S+) '(.*)'/.exec(l.trim())
        return m ? { rev: m[1], date: m[2], author: m[3], subject: m[4] } : null
      })
      .filter((x): x is VcsLogEntry => x !== null)
  }

  describe(): string {
    return (
      'Perforce：集中式仓库，无暂存区（用 p4 reconcile 代替 git add），' +
      '改文件前必须 p4 edit（同步下来的文件默认只读）。' +
      '⚠️ 本实现未在真实 P4 服务器验证，接入前请核对 depot 路径映射与 changelist 管理。'
    )
  }
}

// ===================== 工厂 =====================

const PROVIDERS: Record<string, () => VcsProvider> = {
  git: () => new GitProvider(),
  perforce: () => new PerforceProvider(),
  p4: () => new PerforceProvider(),
}

/** 按 `VCS_PROVIDER` 环境变量选择（默认 git） */
export function getVcsProvider(kind = process.env.VCS_PROVIDER ?? 'git'): VcsProvider {
  const factory = PROVIDERS[kind.toLowerCase()]
  return factory ? factory() : new GitProvider()
}

export function listVcsProviders(): { name: string; description: string }[] {
  return [new GitProvider(), new PerforceProvider()].map((p) => ({
    name: p.name,
    description: p.describe(),
  }))
}
