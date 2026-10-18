import { OpencodeIdlePokePlugin } from "../src/index"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { vi } from "vitest"

// ---------------------------------------------------------------------------
// 配置夹具（与 V1 相同的双通道：ctx.options 优先，空对象 → JSON 文件兜底）
// ---------------------------------------------------------------------------

export const testConfigDir = mkdtempSync(join(tmpdir(), "idle-poke-config-"))

let configOptions: Record<string, unknown> | undefined

export function setConfigFixture(data: unknown) {
  configOptions = (data ?? undefined) as Record<string, unknown> | undefined
}

export function setJsonFixture(data: unknown, exists = true) {
  const file = join(testConfigDir, "opencode-idle-poke.json")
  if (!exists) {
    rmSync(file, { force: true })
    return
  }
  mkdirSync(testConfigDir, { recursive: true })
  writeFileSync(file, JSON.stringify(data ?? {}))
}

export function resetConfig() {
  configOptions = undefined
  rmSync(join(testConfigDir, "opencode-idle-poke.json"), { force: true })
}

// ---------------------------------------------------------------------------
// 计时工具：fake timers 下的推进 + 微任务冲刷
//
// realSetTimeout 在模块加载时捕获（此时必然还是真实定时器），
// flush 用它越过 fake timers，把事件消费循环 / poke 异步链的微任务全部跑完。
// ---------------------------------------------------------------------------

const realSetTimeout = globalThis.setTimeout.bind(globalThis)

/** 冲刷微任务与 I/O 回调（事件注入、异步链在此结算） */
export const flush = (): Promise<void> => new Promise((r) => realSetTimeout(r, 0))

/** 推进 fake 时钟并冲刷异步链——测试里代替 vi.advanceTimersByTimeAsync */
export async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await flush()
}

// ---------------------------------------------------------------------------
// 假 ctx：模拟 V2 Plugin.setup(ctx) 的最小可用面
//   - session.hook 注册捕获（prompt / context）
//   - session.* 调用记录（get/create/generate/synthetic/context/remove）
//   - event.subscribe 异步迭代器（队列 + abort 唤醒）
// ---------------------------------------------------------------------------

export type SystemPart = { type: string; text: string }
export type HookFn = (input: any) => void | Promise<void>

export type Calls = {
  get: Array<{ sessionID: string }>
  create: Array<{
    title?: string
    model?: { providerID: string; id: string }
    location?: { directory?: string }
    id: string
  }>
  generate: Array<{ sessionID: string; prompt: string }>
  synthetic: Array<{ sessionID: string; text: string }>
  context: Array<{ sessionID: string }>
  remove: Array<{ sessionID: string }>
  wait: Array<{ sessionID: string }>
}

export type Harness = {
  ctx: any
  directory: string
  calls: Calls
  hooks: Record<string, HookFn | undefined>
  emit: (type: string, data: Record<string, unknown>, directory?: string) => void
  /** 注入一次 assistant 回合结束事件（V2 的"回合结束 = 启动空闲计时"入口） */
  turnEnd: (sessionID: string, text?: string) => Promise<void>
  /** 注入一次生成活动事件（重置空闲时钟） */
  activity: (sessionID: string, type?: string) => Promise<void>
  /** 注入 session.execution.started（无 location —— 验证绕过 location 过滤） */
  execStart: (sessionID: string) => Promise<void>
  /** 注入 session.execution 终态（无 location；extra 可带 reason/error 等） */
  execEnd: (sessionID: string, kind?: "succeeded" | "failed" | "interrupted", extra?: Record<string, unknown>) => Promise<void>
  deleted: (sessionID: string) => Promise<void>
  status: (sessionID: string, status: string) => Promise<void>
  setTitle: (sessionID: string, title: string | undefined) => void
  setContextData: (data: unknown) => void
  setGenerateHandler: (fn: ((arg: any) => Promise<{ text: string }>) | undefined) => void
  setSyntheticHandler: (fn: ((arg: any) => Promise<unknown>) | undefined) => void
  setWaitHandler: (fn: ((arg: { sessionID: string }) => Promise<unknown>) | undefined) => void
  cleanup: () => Promise<void>
}

export function makeHarness(
  directory = "C:\\Users\\test\\proj",
  options?: Record<string, unknown>
): Harness {
  const calls: Calls = { get: [], create: [], generate: [], synthetic: [], context: [], remove: [], wait: [] }
  const hooks: Record<string, HookFn | undefined> = {}
  const titles = new Map<string, string>()
  let contextData: unknown = []
  let generateHandler: ((arg: any) => Promise<{ text: string }>) | undefined
  let syntheticHandler: ((arg: any) => Promise<unknown>) | undefined
  let waitHandler: ((arg: { sessionID: string }) => Promise<unknown>) | undefined
  let createCount = 0

  // 事件队列：单消费者（插件的事件循环）
  const queue: unknown[] = []
  const waiters: Array<() => void> = []
  const wake = () => {
    const ws = waiters.splice(0)
    for (const w of ws) w()
  }

  const ctx = {
    location: { directory },
    options: options ?? {},
    session: {
      hook: async (name: string, cb: HookFn) => {
        hooks[name] = cb
        return {
          dispose: async () => {
            hooks[name] = undefined
          },
        }
      },
      get: async (arg: { sessionID: string }) => {
        calls.get.push(arg)
        const title = titles.get(arg.sessionID)
        if (title === undefined) throw new Error("session not found")
        return { id: arg.sessionID, title }
      },
      context: async (arg: { sessionID: string }) => {
        calls.context.push(arg)
        return contextData
      },
      create: async (arg: any) => {
        const id = `sub-${++createCount}`
        calls.create.push({ ...arg, id })
        return { id, title: arg?.title }
      },
      generate: async (arg: { sessionID: string; prompt: string }) => {
        calls.generate.push(arg)
        if (generateHandler) return generateHandler(arg)
        return { text: "" }
      },
      synthetic: async (arg: { sessionID: string; text: string }) => {
        calls.synthetic.push(arg)
        if (syntheticHandler) return syntheticHandler(arg)
        return undefined
      },
      remove: async (arg: { sessionID: string }) => {
        calls.remove.push(arg)
        return undefined
      },
      wait: async (arg: { sessionID: string }) => {
        calls.wait.push(arg)
        if (waitHandler) return waitHandler(arg)
        return undefined
      },
    },
    event: {
      subscribe: ({ signal }: { signal?: AbortSignal }) => {
        const onAbort = () => wake()
        signal?.addEventListener("abort", onAbort, { once: true })
        return {
          async *[Symbol.asyncIterator]() {
            for (;;) {
              if (queue.length) {
                yield queue.shift()
                continue
              }
              if (signal?.aborted) return
              await new Promise<void>((r) => waiters.push(r))
            }
          },
        }
      },
    },
  }

  const h: Harness = {
    ctx,
    directory,
    calls,
    hooks,
    emit(type, data, dir) {
      queue.push({ type, location: { directory: dir ?? directory }, data })
      wake()
    },
    async turnEnd(sessionID, text = "ok") {
      h.emit("session.text.ended", { sessionID, text })
      await flush()
    },
    async activity(sessionID, type = "session.text.started") {
      h.emit(type, { sessionID })
      await flush()
    },
    async execStart(sessionID) {
      // 真实事件不带 location —— 顺带验证插件绕过 location 过滤
      queue.push({ type: "session.execution.started", data: { sessionID } })
      wake()
      await flush()
    },
    async execEnd(sessionID, kind = "succeeded", extra) {
      queue.push({ type: `session.execution.${kind}`, data: { sessionID, ...extra } })
      wake()
      await flush()
    },
    async deleted(sessionID) {
      h.emit("session.deleted", { sessionID })
      await flush()
    },
    async status(sessionID, status) {
      h.emit("session.status", { sessionID, status: { type: status } })
      await flush()
    },
    setTitle(sessionID, title) {
      if (title === undefined) titles.delete(sessionID)
      else titles.set(sessionID, title)
    },
    setContextData(data) {
      contextData = data
    },
    setGenerateHandler(fn) {
      generateHandler = fn
    },
    setSyntheticHandler(fn) {
      syntheticHandler = fn
    },
    setWaitHandler(fn) {
      waitHandler = fn
    },
    cleanup: async () => {},
  }
  return h
}

/** 建 ctx → 跑 setup → 返回带 cleanup 的 harness（options 缺省用 setConfigFixture 的值） */
export async function makePlugin(
  directory = "C:\\Users\\test\\proj",
  options?: Record<string, unknown>
): Promise<Harness> {
  const opts = options !== undefined ? options : (configOptions ?? {})
  const h = makeHarness(directory, opts)
  const cleanup = await OpencodeIdlePokePlugin.setup(h.ctx as any)
  h.cleanup = async () => {
    if (cleanup) await cleanup()
  }
  return h
}

// ---------------------------------------------------------------------------
// 钩子驱动与断言器
// ---------------------------------------------------------------------------

/** 模拟一次真实用户 prompt（V2 HTTP prompt {text} 的钩子入参形状） */
export async function runPrompt(h: Harness, sessionID: string, text = "hello"): Promise<void> {
  const fn = h.hooks.prompt
  if (!fn) throw new Error("prompt hook not registered")
  await fn({ sessionID, messageID: "m1", prompt: { text }, delivery: {} })
}

/** 触发 context 钩子，返回注入后的 system 数组（protocol + 可能的重启通知） */
export async function runContext(h: Harness, sessionID: string): Promise<SystemPart[]> {
  const fn = h.hooks.context
  if (!fn) throw new Error("context hook not registered")
  const input = { sessionID, model: {}, system: [] as SystemPart[], messages: [], options: {} }
  await fn(input)
  return input.system
}

export function notifications(system: SystemPart[], prefix = "[System notification]"): SystemPart[] {
  return system.filter((p) => typeof p.text === "string" && p.text.startsWith(prefix))
}

/** 从 context 钩子输出里取重启通知（V2 注入 system，不再发合成消息） */
export async function notificationsFor(
  h: Harness,
  sessionID: string,
  prefix = "[System notification]"
): Promise<SystemPart[]> {
  return notifications(await runContext(h, sessionID), prefix)
}

/** V2 里 session.synthetic 只被 poke 使用 → synthetic 调用记录即 poke 记录 */
export function pokes(calls: Calls): Calls["synthetic"] {
  return calls.synthetic
}

export function deferred<T>() {
  let resolve!: (v: T | PromiseLike<T>) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
