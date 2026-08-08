import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  makeClient,
  makePlugin,
  userMessage,
  idleEvent,
  busyEvent,
  setConfigFixture,
  resetConfig,
  pokes,
  notifications,
} from "./helpers"

describe("plugin lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setConfigFixture({ logging: { enabled: false } })
  })

  afterEach(() => {
    vi.useRealTimers()
    resetConfig()
  })

  it("initializes and returns a hooks object", async () => {
    const { client } = makeClient()
    const p = await makePlugin(client)
    expect(typeof p.event).toBe("function")
    expect(typeof p["chat.message"]).toBe("function")
    expect(typeof p["experimental.chat.system.transform"]).toBe("function")
    expect(typeof p["experimental.text.complete"]).toBe("function")
    expect(typeof p.dispose).toBe("function")
    await p.dispose()
  })

  it("does not poke when idle fires before any user message", async () => {
    const { client, calls } = makeClient()
    const p = await makePlugin(client)
    await p.event(idleEvent("s1"))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(pokes(calls)).toHaveLength(0)
    await p.dispose()
  })

  it("sends one poke after user message + idle, preserving the agent", async () => {
    const { client, calls } = makeClient()
    const p = await makePlugin(client)
    const { input, output } = userMessage("s1", { agent: "plan" })
    await p["chat.message"](input, output)
    await p.event(idleEvent("s1"))
    await vi.advanceTimersByTimeAsync(60_000)
    const poke = pokes(calls)[0]
    expect(poke).toBeTruthy()
    expect(poke.path.id).toBe("s1")
    expect(poke.body.agent).toBe("plan")
    expect(poke.body.parts[0].synthetic).toBe(true)
    expect(poke.body.parts[0].text).toContain("You have been silent for about 60 seconds")
    expect(poke.body.parts[0].text).toContain("s1")
    await p.dispose()
  })

  it("renders messageTemplate placeholders for seconds/sessionID/project", async () => {
    setConfigFixture({
      idleMs: 90_000,
      messageTemplate: "[T] {seconds}s {sessionID} {project}",
      logging: { enabled: false },
    })
    const { client, calls } = makeClient()
    const p = await makePlugin(client, "C:\\users\\demo\\proj")
    const { input, output } = userMessage("abc")
    await p["chat.message"](input, output)
    await p.event(idleEvent("abc"))
    await vi.advanceTimersByTimeAsync(90_000)
    const poke = pokes(calls)[0]
    expect(poke.body.parts[0].text).toBe("[T] 90s abc C:\\users\\demo\\proj")
    await p.dispose()
  })

  it("does not re-poke while pendingPoke is set", async () => {
    const { client, calls } = makeClient()
    const p = await makePlugin(client)
    const { input, output } = userMessage("s1")
    await p["chat.message"](input, output)
    await p.event(idleEvent("s1"))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(pokes(calls)).toHaveLength(1)
    await p.event(idleEvent("s1"))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(pokes(calls)).toHaveLength(1)
    await p.dispose()
  })

  it("resets pendingPoke on the next real user message", async () => {
    const { client, calls } = makeClient()
    const p = await makePlugin(client)
    let msg = userMessage("s1")
    await p["chat.message"](msg.input, msg.output)
    await p.event(idleEvent("s1"))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(pokes(calls)).toHaveLength(1)
    msg = userMessage("s1")
    await p["chat.message"](msg.input, msg.output)
    await p.event(idleEvent("s1"))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(pokes(calls)).toHaveLength(2)
    await p.dispose()
  })

  it("clears the idle timer on busy status", async () => {
    const { client, calls } = makeClient()
    const p = await makePlugin(client)
    const { input, output } = userMessage("s1")
    await p["chat.message"](input, output)
    await p.event(idleEvent("s1"))
    await p.event(busyEvent("s1"))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(pokes(calls)).toHaveLength(0)
    await p.dispose()
  })

  it("dispose clears pending timers", async () => {
    const { client, calls } = makeClient()
    const p = await makePlugin(client)
    const { input, output } = userMessage("s1")
    await p["chat.message"](input, output)
    await p.event(idleEvent("s1"))
    await p.dispose()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(pokes(calls)).toHaveLength(0)
  })

  it("synthetic user messages are ignored", async () => {
    const { client, calls } = makeClient()
    const p = await makePlugin(client)
    const msg = userMessage("s1", { synthetic: true })
    await p["chat.message"](msg.input, msg.output)
    await p.event(idleEvent("s1"))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(pokes(calls)).toHaveLength(0)
    expect(notifications(calls)).toHaveLength(0)
    await p.dispose()
  })
})
