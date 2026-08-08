import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  makeClient,
  makePlugin,
  userMessage,
  idleEvent,
  deletedEvent,
  setConfigFixture,
  resetConfig,
  pokes,
} from "./helpers"

describe("cross-session behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setConfigFixture({ logging: { enabled: false } })
  })

  afterEach(() => {
    vi.useRealTimers()
    resetConfig()
  })

  it("switching to another session clears the first session's timer", async () => {
    const { client, calls } = makeClient()
    const p = await makePlugin(client)
    const a = userMessage("A")
    await p["chat.message"](a.input, a.output)
    await p.event(idleEvent("A"))
    const b = userMessage("B")
    await p["chat.message"](b.input, b.output)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(pokes(calls)).toHaveLength(0)
    await p.dispose()
  })

  it("only the last-active session receives a poke", async () => {
    const { client, calls } = makeClient()
    const p = await makePlugin(client)
    const a = userMessage("A")
    await p["chat.message"](a.input, a.output)
    await p.event(idleEvent("A"))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(pokes(calls)).toHaveLength(1)
    expect(pokes(calls)[0].path.id).toBe("A")
    const b = userMessage("B")
    await p["chat.message"](b.input, b.output)
    await p.event(idleEvent("B"))
    await vi.advanceTimersByTimeAsync(60_000)
    const all = pokes(calls)
    expect(all).toHaveLength(2)
    expect(all[1].path.id).toBe("B")
    await p.dispose()
  })

  it("a poke scheduled for a stale session is skipped if a predictor ran in between", async () => {
    setConfigFixture({
      idleMs: 60_000,
      predictor: { enabled: true, maxMessages: 6, agent: "", model: "", timeoutMs: 15_000, prompt: "assess", denyTools: [] },
      logging: { enabled: false },
    })
    const { client, calls } = makeClient()
    client.setMessages([
      { info: { role: "user" }, parts: [{ type: "text", text: "question?", synthetic: false }] },
    ])
    const gate = { open: false }
    let release: (() => void) | undefined
    client.setPromptHandler(async (arg) => {
      if (arg.path.id.startsWith("sub-")) {
        if (!gate.open) {
          await new Promise<void>((res) => {
            release = res
          })
        }
        return { data: { parts: [{ type: "text", text: "[Remind: 2 minutes]", synthetic: false }] } }
      }
      return { data: { parts: [] } }
    })
    const p = await makePlugin(client)
    const a = userMessage("A", { model: { providerID: "p", modelID: "m" } })
    await p["chat.message"](a.input, a.output)
    await p.event(idleEvent("A"))
    await vi.advanceTimersByTimeAsync(60_000)
    const b = userMessage("B")
    await p["chat.message"](b.input, b.output)
    expect(release).toBeDefined()
    gate.open = true
    release!()
    await vi.advanceTimersByTimeAsync(0)
    expect(pokes(calls)).toHaveLength(0)
    await p.dispose()
  })

  it("session.deleted clears the timer and removes the session state", async () => {
    const { client, calls } = makeClient()
    const p = await makePlugin(client)
    const a = userMessage("A")
    await p["chat.message"](a.input, a.output)
    await p.event(idleEvent("A"))
    await p.event(deletedEvent("A"))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(pokes(calls)).toHaveLength(0)
    await p.dispose()
  })
})
