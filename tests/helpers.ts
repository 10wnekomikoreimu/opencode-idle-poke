import { OpencodeIdlePokePlugin } from "../src/index"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const testConfigDir = mkdtempSync(join(tmpdir(), "idle-poke-config-"))

let configOptions: Record<string, unknown> | undefined

export function setConfigFixture(data: unknown, _exists = true) {
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

export type PromptArg = {
  path: { id: string }
  body: Record<string, any>
}
export type PromptHandler = (arg: PromptArg) => Promise<{ data: { parts: unknown[] } }>

export type ClientCalls = {
  messages: Array<{ path: { id: string } }>
  get: Array<{ path: { id: string } }>
  create: Array<{ query: { directory: string }; id: string }>
  prompt: PromptArg[]
  delete: Array<{ path: { id: string } }>
}

export function makeClient() {
  const calls: ClientCalls = { messages: [], get: [], create: [], prompt: [], delete: [] }
  let messagesData: unknown[] = []
  let promptHandler: PromptHandler | undefined
  const titles = new Map<string, string>()

  const client = {
    session: {
      messages: async (arg: { path: { id: string } }) => {
        calls.messages.push(arg)
        return { data: messagesData }
      },
      get: async (arg: { path: { id: string } }) => {
        calls.get.push(arg)
        const title = titles.get(arg.path.id)
        if (title === undefined) throw new Error("session not found")
        return { data: { id: arg.path.id, title } }
      },
      create: async (arg: { query: { directory: string } }) => {
        const id = `sub-${calls.create.length + 1}`
        calls.create.push({ ...arg, id })
        return { data: { id } }
      },
      prompt: async (arg: PromptArg) => {
        calls.prompt.push(arg)
        return promptHandler ? promptHandler(arg) : Promise.resolve({ data: { parts: [] } })
      },
      delete: async (arg: { path: { id: string } }) => {
        calls.delete.push(arg)
        return {}
      },
    },
    setMessages(data: unknown[]) {
      messagesData = data
    },
    setPromptHandler(fn: PromptHandler | undefined) {
      promptHandler = fn
    },
    setTitle(sessionID: string, title: string | undefined) {
      if (title === undefined) titles.delete(sessionID)
      else titles.set(sessionID, title)
    },
  }

  return {
    client,
    calls,
    setMessages(data: unknown[]) {
      messagesData = data
    },
    setPromptHandler(fn: PromptHandler | undefined) {
      promptHandler = fn
    },
    setTitle(sessionID: string, title: string | undefined) {
      if (title === undefined) titles.delete(sessionID)
      else titles.set(sessionID, title)
    },
  }
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

export async function makePlugin(
  client: unknown,
  directory = "C:\\Users\\test\\proj",
  options?: Record<string, unknown>
) {
  const input = { client, directory } as unknown as Parameters<typeof OpencodeIdlePokePlugin>[0]
  return (await OpencodeIdlePokePlugin(input, options ?? configOptions)) as any
}

export const textPart = (text: string, synthetic = false) => ({ type: "text", text, synthetic })

export function userMessage(
  sessionID: string,
  opts: {
    text?: string
    agent?: string
    model?: { providerID: string; modelID: string }
    synthetic?: boolean
  } = {}
) {
  const input = { sessionID, agent: opts.agent, model: opts.model } as any
  const output = { parts: [textPart(opts.text ?? "hello", opts.synthetic ?? false)] }
  return { input, output }
}

export function idleEvent(sessionID: string) {
  return {
    event: { type: "session.status", properties: { sessionID, status: { type: "idle" } } },
  } as any
}

export function busyEvent(sessionID: string) {
  return {
    event: { type: "session.status", properties: { sessionID, status: { type: "busy" } } },
  } as any
}

export function deletedEvent(id: string) {
  return { event: { type: "session.deleted", properties: { info: { id } } } } as any
}

export function createdEvent(id: string, title?: string) {
  return { event: { type: "session.created", properties: { info: { id, title } } } } as any
}

export function updatedEvent(id: string, title: string) {
  return { event: { type: "session.updated", properties: { info: { id, title } } } } as any
}

export function pokes(calls: ClientCalls): PromptArg[] {
  return calls.prompt.filter((c) => {
    if (c.path.id.startsWith("sub-")) return false
    const t = (c.body.parts as any[])?.[0]?.text ?? ""
    return typeof t === "string" && !t.startsWith("[System notification]")
  })
}

export function notifications(calls: ClientCalls, prefix = "[System notification]"): PromptArg[] {
  return calls.prompt.filter((c) => {
    const t = (c.body.parts as any[])?.[0]?.text ?? ""
    return typeof t === "string" && t.startsWith(prefix)
  })
}
