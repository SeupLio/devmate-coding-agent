/**
 * 跨端宿主适配层 —— JD 第 5 条：浏览器 / PC 客户端 / UE / Maya 等 WebView 环境。
 *
 * ## 这些环境的真实差异
 *
 * 1. **可用能力不同**：浏览器有 `navigator.clipboard`；UE/Maya 的内嵌 WebView 里
 *    常常没有（缺权限或没有安全上下文），但宿主通过原生桥暴露了等价能力。
 * 2. **注入的全局对象不同**：
 *    - Electron：`window.electronAPI`（preload 注入）
 *    - UE：`window.ue` / `window.ue4`（C++ 侧 `BindUObject` 注入）
 *    - Maya：`window.maya` 或 Qt WebChannel（`window.qt.webChannelTransport`）
 * 3. **窗口形态不同**：内嵌面板常常没有滚动条、没有地址栏、DPI 与宿主不一致。
 * 4. **主题来源不同**：宿主有自己的明暗设置，页面应当**跟随**而不是硬编码。
 *
 * ## 这一层的设计原则
 *
 * - **探测要可测**：`detectHost(globals)` 是**纯函数**，把全局对象当参数传进来。
 *   这样单测可以用假 global 覆盖 Electron / UE / Maya 四种分支，
 *   不需要真的起一个 UE 编辑器。
 * - **降级要显式**：能力缺失时返回值里带 `degraded: true` 和原因，
 *   **不静默失败**。调用方据此决定是提示用户还是走备用路径。
 */

export type HostKind = 'browser' | 'electron' | 'ue' | 'maya'

export interface HostCapabilities {
  clipboard: boolean
  /** 在宿主里打开文件（UE/Maya 里是打开资产/场景对象） */
  openFile: boolean
  /** 系统级通知 */
  notify: boolean
  /** 能读取并跟随宿主主题 */
  themeSync: boolean
  filePicker: boolean
  download: boolean
}

export interface HostInfo {
  kind: HostKind
  label: string
  version?: string
  capabilities: HostCapabilities
}

export interface BridgeResult {
  ok: boolean
  /** true = 走了降级路径（能力不可用，用替代方案完成了） */
  degraded?: boolean
  /** 降级原因，用于提示用户 */
  reason?: string
}

/** 宿主可能挂上来的全局对象（用宽松类型，因为这些都是外部注入的、不可信） */
export interface HostGlobals {
  electronAPI?: Record<string, unknown>
  electron?: Record<string, unknown>
  ue?: Record<string, unknown>
  ue4?: Record<string, unknown>
  __UE__?: Record<string, unknown>
  maya?: Record<string, unknown>
  __MAYA__?: Record<string, unknown>
  qt?: { webChannelTransport?: unknown }
  navigator?: { clipboard?: unknown; userAgent?: string }
  matchMedia?: (q: string) => { matches: boolean }
  document?: { documentElement?: { dataset?: Record<string, string> } }
  [k: string]: unknown
}

function ua(g: HostGlobals): string {
  return String(g.navigator?.userAgent ?? '').toLowerCase()
}

function hasFn(o: unknown, name: string): boolean {
  return Boolean(o && typeof (o as Record<string, unknown>)[name] === 'function')
}

/**
 * 各宿主对同一能力的**方法名不统一**，这里集中声明。
 *
 * ⚠️ 这张表是**能力探测与能力执行共用的唯一来源**。
 * 之前踩过的坑：探测时查 `copyText`，执行时只找 `copyToClipboard`，
 * 结果能力矩阵显示「✓ 剪贴板」但真调用却降级了 —— 两边必须查同一张表。
 */
const BRIDGE_METHODS = {
  clipboard: ['copyText', 'copyToClipboard', 'setClipboard'],
  openFile: ['openFile', 'openPath', 'openAsset', 'selectNode'],
  notify: ['notify', 'showNotification', 'toast'],
  theme: ['getTheme', 'getEditorTheme', 'getHostTheme'],
} as const

/** 从宿主桥对象里找出第一个存在的方法 */
function findMethod(o: unknown, names: readonly string[]): ((...a: unknown[]) => unknown) | null {
  if (!o) return null
  for (const n of names) {
    const fn = (o as Record<string, unknown>)[n]
    if (typeof fn === 'function') return fn as (...a: unknown[]) => unknown
  }
  return null
}

/** 该宿主桥是否具备某项能力（与执行路径共用 BRIDGE_METHODS） */
function bridgeHas(o: unknown, key: keyof typeof BRIDGE_METHODS): boolean {
  return findMethod(o, BRIDGE_METHODS[key]) !== null
}

/**
 * 探测宿主类型。**纯函数** —— 全局对象从参数传入，便于单测覆盖各分支。
 * 判定顺序：Electron → UE → Maya → 浏览器（越具体的越先判）。
 */
export function detectHost(g: HostGlobals): HostInfo {
  const agent = ua(g)

  // Electron：preload 通常注入 electronAPI，UA 里也常带 Electron
  if (g.electronAPI || g.electron || agent.includes('electron')) {
    const api = (g.electronAPI ?? g.electron) as Record<string, unknown> | undefined
    return {
      kind: 'electron',
      label: 'PC 客户端（Electron）',
      version: typeof api?.version === 'string' ? api.version : undefined,
      capabilities: {
        clipboard: bridgeHas(api, 'clipboard') || Boolean(g.navigator?.clipboard),
        openFile: bridgeHas(api, 'openFile'),
        notify: bridgeHas(api, 'notify') || typeof (g as { Notification?: unknown }).Notification !== 'undefined',
        themeSync: bridgeHas(api, 'theme') || Boolean(g.matchMedia),
        filePicker: hasFn(api, 'showOpenDialog'),
        download: hasFn(api, 'saveFile'),
      },
    }
  }

  // UE：C++ 侧常用 BindUObject("ue", ...) 注入
  const ueObj = (g.ue ?? g.ue4 ?? g.__UE__) as Record<string, unknown> | undefined
  if (ueObj || agent.includes('unreal')) {
    return {
      kind: 'ue',
      label: 'Unreal Engine 内嵌面板',
      version: typeof ueObj?.version === 'string' ? ueObj.version : undefined,
      capabilities: {
        // UE WebView 里 clipboard API 常不可用，走宿主桥
        clipboard: bridgeHas(ueObj, 'clipboard'),
        openFile: bridgeHas(ueObj, 'openFile'),
        notify: bridgeHas(ueObj, 'notify'),
        themeSync: bridgeHas(ueObj, 'theme'),
        filePicker: hasFn(ueObj, 'pickFile'),
        // 内嵌面板一般没有下载能力
        download: hasFn(ueObj, 'saveFile'),
      },
    }
  }

  // Maya：脚本侧注入 window.maya，或 Qt WebChannel
  const mayaObj = (g.maya ?? g.__MAYA__) as Record<string, unknown> | undefined
  if (mayaObj || g.qt?.webChannelTransport) {
    return {
      kind: 'maya',
      label: 'Maya 内嵌面板',
      version: typeof mayaObj?.version === 'string' ? mayaObj.version : undefined,
      capabilities: {
        clipboard: bridgeHas(mayaObj, 'clipboard'),
        openFile: bridgeHas(mayaObj, 'openFile'),
        notify: bridgeHas(mayaObj, 'notify'),
        themeSync: bridgeHas(mayaObj, 'theme'),
        filePicker: hasFn(mayaObj, 'pickFile'),
        download: false,
      },
    }
  }

  // 浏览器：按标准 Web API 能力探测
  return {
    kind: 'browser',
    label: '浏览器',
    capabilities: {
      clipboard: Boolean(g.navigator?.clipboard),
      // 浏览器不能直接打开本地路径（安全限制）→ 降级为「提示用户」
      openFile: false,
      notify: typeof (g as { Notification?: unknown }).Notification !== 'undefined',
      themeSync: Boolean(g.matchMedia),
      filePicker: true,
      download: true,
    },
  }
}

/** 读取宿主主题；读不到返回 null（调用方自己决定默认值） */
export function readHostTheme(g: HostGlobals, info: HostInfo): 'dark' | 'light' | null {
  // 1) 宿主显式提供
  const fn = findMethod(g.electronAPI ?? g.ue ?? g.maya, BRIDGE_METHODS.theme)
  if (fn) {
    try {
      const t = fn()
      if (t === 'dark' || t === 'light') return t
    } catch {
      /* 宿主桥抛错 → 继续往下探测 */
    }
  }
  // 2) HTML 上的标记（很多宿主会写 data-theme）
  const attr = g.document?.documentElement?.dataset?.theme
  if (attr === 'dark' || attr === 'light') return attr
  // 3) 媒体查询
  if (g.matchMedia) {
    try {
      return g.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    } catch {
      /* ignore */
    }
  }
  return null
}

/**
 * 跨端桥接实现。
 *
 * 每个方法都遵循「优先宿主原生 → 否则降级 → 明确告知」的流程。
 */
export class HostBridge {
  readonly info: HostInfo
  private g: HostGlobals

  constructor(globals: HostGlobals) {
    this.g = globals
    this.info = detectHost(globals)
  }

  get kind(): HostKind {
    return this.info.kind
  }

  /** 当前宿主的桥对象（Electron / UE / Maya 三选一） */
  private bridgeApi(): unknown {
    return this.g.electronAPI ?? this.g.ue ?? this.g.ue4 ?? this.g.__UE__ ?? this.g.maya ?? this.g.__MAYA__
  }

  /** 复制文本：宿主桥 → navigator.clipboard → 降级失败 */
  async copyText(text: string): Promise<BridgeResult> {
    const fn = findMethod(this.bridgeApi(), BRIDGE_METHODS.clipboard)
    if (fn) {
      try {
        fn(text)
        return { ok: true }
      } catch {
        /* 落到下一级 */
      }
    }
    const clip = this.g.navigator?.clipboard as { writeText?: (t: string) => Promise<void> } | undefined
    if (clip?.writeText) {
      try {
        await clip.writeText(text)
        return { ok: true }
      } catch {
        /* 落到下一级 */
      }
    }
    return {
      ok: false,
      degraded: true,
      reason: `当前宿主（${this.info.label}）没有可用的剪贴板能力，请手动复制。`,
    }
  }

  /** 在宿主里打开文件。浏览器无法打开本地路径 → 显式降级 */
  async openFile(path: string): Promise<BridgeResult> {
    const fn = findMethod(this.bridgeApi(), BRIDGE_METHODS.openFile)
    if (fn) {
      try {
        fn(path)
        return { ok: true }
      } catch {
        /* 落到降级 */
      }
    }
    return {
      ok: false,
      degraded: true,
      reason:
        this.info.kind === 'browser'
          ? '浏览器出于安全限制无法直接打开本地文件，请在下方工作区面板中查看内容。'
          : `宿主（${this.info.label}）未暴露打开文件的桥接方法。`,
    }
  }

  /** 通知：宿主原生通知 → Web Notification → 降级为页内提示 */
  async notify(title: string, body: string): Promise<BridgeResult> {
    const fn = findMethod(this.bridgeApi(), BRIDGE_METHODS.notify)
    if (fn) {
      try {
        fn(title, body)
        return { ok: true }
      } catch {
        /* 落到下一级 */
      }
    }
    const N = (this.g as { Notification?: new (t: string, o?: { body?: string }) => unknown }).Notification
    if (N) {
      try {
        new N(title, { body })
        return { ok: true }
      } catch {
        /* 落到下一级 */
      }
    }
    return { ok: false, degraded: true, reason: '当前宿主不支持系统通知，已改为页内提示。' }
  }

  getTheme(): 'dark' | 'light' | null {
    return readHostTheme(this.g, this.info)
  }

  /** 订阅宿主主题变化；返回取消订阅函数 */
  onThemeChange(cb: (t: 'dark' | 'light') => void): () => void {
    const mq = this.g.matchMedia?.('(prefers-color-scheme: dark)') as unknown as
      | {
          matches: boolean
          addEventListener?: (e: string, f: () => void) => void
          removeEventListener?: (e: string, f: () => void) => void
        }
      | undefined
    if (!mq?.addEventListener) return () => {}
    const handler = () => cb(mq.matches ? 'dark' : 'light')
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener?.('change', handler)
  }
}

/** 浏览器/客户端里获取单例桥 */
let singleton: HostBridge | null = null

export function getHostBridge(): HostBridge {
  if (!singleton) {
    const g = (typeof window !== 'undefined' ? window : {}) as HostGlobals
    singleton = new HostBridge(g)
  }
  return singleton
}

/** 给 UI 展示的能力矩阵（缺失的能力要显式列出来，而不是假装都有） */
export function describeCapabilities(info: HostInfo): { name: string; ok: boolean }[] {
  const c = info.capabilities
  return [
    { name: '剪贴板', ok: c.clipboard },
    { name: '打开文件', ok: c.openFile },
    { name: '系统通知', ok: c.notify },
    { name: '跟随主题', ok: c.themeSync },
    { name: '文件选择', ok: c.filePicker },
    { name: '下载产物', ok: c.download },
  ]
}
