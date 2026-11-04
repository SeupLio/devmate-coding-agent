'use client'

import { useCallback, useEffect, useState } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { Download, File, Folder, FolderOpen, RefreshCw } from 'lucide-react'
import { PrismAsyncLight as SyntaxHighlighter } from 'react-syntax-highlighter/dist/esm/prism-async-light'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash'
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css'
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript'
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json'
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx'
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown'
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup'
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python'
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx'
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript'
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml'

// 注册常用语言（其余扩展名回退为纯文本）
SyntaxHighlighter.registerLanguage('javascript', javascript)
SyntaxHighlighter.registerLanguage('typescript', typescript)
SyntaxHighlighter.registerLanguage('jsx', jsx)
SyntaxHighlighter.registerLanguage('tsx', tsx)
SyntaxHighlighter.registerLanguage('json', json)
SyntaxHighlighter.registerLanguage('markup', markup)
SyntaxHighlighter.registerLanguage('css', css)
SyntaxHighlighter.registerLanguage('bash', bash)
SyntaxHighlighter.registerLanguage('python', python)
SyntaxHighlighter.registerLanguage('markdown', markdown)
SyntaxHighlighter.registerLanguage('yaml', yaml)

interface FileNode {
  name: string
  path: string
  type: 'dir' | 'file'
  size?: number
  children?: FileNode[]
}

/** 这些扩展名不做文本预览，改为提供下载（生成的 docx/pptx 等） */
const BINARY_RE = /\.(docx?|pptx?|xlsx?|pdf|zip|gz|png|jpe?g|gif|webp|ico|woff2?|ttf|mp4)$/i

/** 扩展名 → Prism 语言（含 markdown 文件显示元信息） */
const EXT_LANG: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', mts: 'typescript',
  jsx: 'jsx', tsx: 'tsx',
  json: 'json', jsonc: 'json',
  html: 'markup', xml: 'markup', svg: 'markup',
  css: 'css', scss: 'css',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  py: 'python',
  md: 'markdown', mdx: 'markdown',
  yml: 'yaml', yaml: 'yaml',
}

function langOf(path: string): string | undefined {
  const ext = path.split('.').pop()?.toLowerCase()
  return ext ? EXT_LANG[ext] : undefined
}

export function WorkspacePanel({ sessionId, refreshKey }: { sessionId: string | null; refreshKey: number }) {
  const [tree, setTree] = useState<FileNode[]>([])
  const [file, setFile] = useState<{ path: string; content: string; binary?: boolean } | null>(null)
  const [loading, setLoading] = useState(false)

  const loadTree = useCallback(async () => {
    if (!sessionId) return
    setLoading(true)
    try {
      const res = await fetch(`/api/workspace/${sessionId}`)
      const data = await res.json()
      setTree(data.tree ?? [])
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    // 存量模式：会话/刷新切换时清空选中文件。改为 render 期重置需要更大重构，先精确豁免
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFile(null)
    loadTree()
  }, [loadTree, refreshKey])

  const openFile = async (path: string) => {
    if (!sessionId) return
    if (BINARY_RE.test(path)) {
      setFile({ path, content: '', binary: true })
      return
    }
    const res = await fetch(`/api/workspace/${sessionId}?file=${encodeURIComponent(path)}`)
    const data = await res.json().catch(() => ({}))
    setFile({ path, content: data.content ?? `（无法预览：${data.error ?? res.status}）` })
  }

  const downloadUrl = (path: string) =>
    `/api/workspace/${sessionId}?file=${encodeURIComponent(path)}&download=1`

  const lineCount = file?.content ? file.content.split('\n').length : 0

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-semibold text-muted-foreground">工作区文件</span>
        <button
          onClick={loadTree}
          className="rounded p-1 hover:bg-muted"
          aria-label="刷新文件树"
          title="刷新"
        >
          <RefreshCw className={`h-3.5 w-3.5 text-muted-foreground ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>
      <ScrollArea className="max-h-52 shrink-0 border-y px-2 py-1">
        {tree.length === 0 && !loading && <p className="px-2 py-3 text-xs text-muted-foreground">（空）</p>}
        <FileTreeNode nodes={tree} onOpen={openFile} activePath={file?.path ?? null} />
      </ScrollArea>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {file ? (
          <>
            <div className="mb-1 flex items-center gap-2">
              <Badge variant="outline" className="font-mono text-[10px]">
                {file.path}
              </Badge>
              {!file.binary && lineCount > 0 && (
                <span className="text-[10px] text-muted-foreground">{lineCount} 行</span>
              )}
              <a
                href={downloadUrl(file.path)}
                className="flex items-center gap-1 text-[10px] text-emerald-700 hover:underline dark:text-emerald-400"
                download
              >
                <Download className="h-3 w-3" /> 下载
              </a>
            </div>
            {file.binary ? (
              <p className="rounded-md bg-muted p-3 text-[11px] text-muted-foreground">
                二进制文件（如 .docx / .pptx），无法文本预览 —— 点上方「下载」用本机 Office / WPS 打开。
              </p>
            ) : langOf(file.path) ? (
              <SyntaxHighlighter
                language={langOf(file.path)}
                style={oneDark}
                showLineNumbers
                customStyle={{
                  margin: 0,
                  borderRadius: 6,
                  fontSize: '11px',
                  maxHeight: '100%',
                }}
                codeTagProps={{ style: { fontFamily: 'var(--font-geist-mono), monospace' } }}
              >
                {file.content}
              </SyntaxHighlighter>
            ) : (
              <pre className="overflow-auto rounded-md bg-muted p-3 font-mono text-[11px] leading-relaxed">
                {file.content}
              </pre>
            )}
          </>
        ) : (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">点击左侧文件查看内容</p>
        )}
      </div>
    </div>
  )
}

function FileTreeNode({
  nodes,
  onOpen,
  activePath,
  depth = 0,
}: {
  nodes: FileNode[]
  onOpen: (path: string) => void
  activePath: string | null
  depth?: number
}) {
  return (
    <ul className="space-y-0.5">
      {nodes.map((n) =>
        n.type === 'dir' ? (
          <DirNode key={n.path} node={n} onOpen={onOpen} activePath={activePath} depth={depth} />
        ) : (
          <li key={n.path} style={{ paddingLeft: depth * 12 }}>
            <button
              onClick={() => onOpen(n.path)}
              className={`flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-xs hover:bg-muted ${
                activePath === n.path ? 'bg-muted font-medium' : 'text-muted-foreground'
              }`}
            >
              <File className="h-3 w-3 shrink-0" />
              <span className="truncate font-mono text-[11px]">{n.name}</span>
            </button>
          </li>
        ),
      )}
    </ul>
  )
}

function DirNode({
  node,
  onOpen,
  activePath,
  depth,
}: {
  node: FileNode
  onOpen: (path: string) => void
  activePath: string | null
  depth: number
}) {
  const [open, setOpen] = useState(true)
  return (
    <li>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-xs hover:bg-muted"
        style={{ paddingLeft: depth * 12 }}
        aria-expanded={open}
      >
        {open ? (
          <FolderOpen className="h-3 w-3 shrink-0 text-amber-500" />
        ) : (
          <Folder className="h-3 w-3 shrink-0 text-amber-500" />
        )}
        <span className="truncate font-mono text-[11px]">{node.name}</span>
      </button>
      {open && node.children && (
        <FileTreeNode nodes={node.children} onOpen={onOpen} activePath={activePath} depth={depth + 1} />
      )}
    </li>
  )
}
