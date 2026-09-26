'use client'

import { useCallback, useEffect, useState } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { File, Folder, FolderOpen, RefreshCw } from 'lucide-react'

interface FileNode {
  name: string
  path: string
  type: 'dir' | 'file'
  children?: FileNode[]
}

export function WorkspacePanel({ sessionId, refreshKey }: { sessionId: string | null; refreshKey: number }) {
  const [tree, setTree] = useState<FileNode[]>([])
  const [file, setFile] = useState<{ path: string; content: string } | null>(null)
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
    setFile(null)
    loadTree()
  }, [loadTree, refreshKey])

  const openFile = async (path: string) => {
    if (!sessionId) return
    const res = await fetch(`/api/workspace/${sessionId}?file=${encodeURIComponent(path)}`)
    const data = await res.json()
    if (data.content !== undefined) setFile({ path, content: data.content })
  }

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
            <Badge variant="outline" className="mb-1 font-mono text-[10px]">
              {file.path}
            </Badge>
            <pre className="overflow-auto rounded-md bg-muted p-3 font-mono text-[11px] leading-relaxed">
              {file.content}
            </pre>
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
