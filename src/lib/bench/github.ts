/**
 * 真实任务源：从 GitHub 拉取 issue / 提交 / 仓库快照。
 *
 * 只用两个域名：`api.github.com`（元数据）与 `codeload.github.com`（tar 快照）。
 * 二者在企业出口白名单里通常可达（而 `github.com` 的 git-over-HTTPS 往往不通）。
 *
 * 代理会偶发 502，所以所有请求都带指数退避重试。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const API = 'https://api.github.com'

export function ghToken(): string {
  const t = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (!t) {
    throw new Error('需要 GITHUB_TOKEN（或 GH_TOKEN）环境变量才能拉取真实任务源')
  }
  return t
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 带重试的 GitHub API 调用 */
export async function ghApi<T>(endpoint: string, tries = 6): Promise<T> {
  const url = endpoint.startsWith('http') ? endpoint : `${API}${endpoint}`
  let last = ''
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${ghToken()}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'devmate-bench',
        },
      })
      if (res.ok) return (await res.json()) as T
      last = `HTTP ${res.status}`
      // 404 不该重试
      if (res.status === 404) throw new Error(`${endpoint} → 404 Not Found`)
    } catch (e) {
      last = e instanceof Error ? e.message : String(e)
      if (/404/.test(last)) throw e
    }
    if (i < tries) await sleep(1500 * i)
  }
  throw new Error(`${endpoint} 重试 ${tries} 次仍失败：${last}`)
}

export interface GhCommit {
  sha: string
  commit: { message: string; author: { date: string; name: string } }
  parents: { sha: string }[]
}

export interface GhCommitDetail extends GhCommit {
  files: { filename: string; status: string; additions: number; deletions: number }[]
}

export interface GhIssue {
  number: number
  title: string
  body: string | null
  state: string
  created_at: string
  closed_at: string | null
  html_url: string
}

/** 下载仓库在某个 ref 的快照并解压，返回解压后的仓库根目录 */
export async function downloadTarball(repo: string, ref: string, destDir: string): Promise<string> {
  fs.mkdirSync(destDir, { recursive: true })
  const tgzName = 'snapshot.tgz'
  const tgz = path.join(destDir, tgzName)

  // 缓存：同一个 ref 不重复下载
  const cached = fs.existsSync(tgz) && fs.statSync(tgz).size > 0
  if (!cached) {
    const url = `https://codeload.github.com/${repo}/tar.gz/${ref}`
    let last = ''
    for (let i = 1; i <= 6; i++) {
      try {
        const res = await fetch(url, { redirect: 'follow' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()))
        break
      } catch (e) {
        last = e instanceof Error ? e.message : String(e)
        if (i === 6) throw new Error(`下载 ${url} 失败：${last}`)
        await sleep(1500 * i)
      }
    }
  }

  // ⚠️ Windows 的 GNU tar 会把 "E:\path" 当成远端主机（E: 被当作 host），
  // 所以必须用**相对路径 + cwd**，不能传绝对路径。
  execFileSync('tar', ['-xzf', tgzName], { cwd: destDir, stdio: 'pipe' })

  const roots = fs
    .readdirSync(destDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== '__MACOSX')
    .map((d) => d.name)
  if (!roots.length) throw new Error(`解压后未找到仓库目录：${destDir}`)
  return path.join(destDir, roots[0])
}

/** 取某个 ref 下的文件文本（base64 解码） */
export async function fetchFileText(repo: string, filePath: string, ref: string): Promise<string> {
  const d = await ghApi<{ content: string; encoding: string }>(
    `/repos/${repo}/contents/${filePath}?ref=${ref}`,
  )
  return Buffer.from(d.content, 'base64').toString('utf-8')
}

/** 把某个 ref 下的文件写入工作区 */
export async function materializeFile(
  repo: string,
  filePath: string,
  ref: string,
  root: string,
): Promise<void> {
  const text = await fetchFileText(repo, filePath, ref)
  const dest = path.join(root, filePath.replace(/\//g, path.sep))
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, text)
}

/** 判断路径是否像测试文件 */
export function isTestPath(p: string): boolean {
  return (
    /(^|\/)(test|tests|__tests__)\//i.test(p) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/i.test(p) ||
    /^test\.[cm]?[jt]sx?$/i.test(p)
  )
}
