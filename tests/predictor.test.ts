import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  makeClient,
  makePlugin,
  userMessage,
  idleEvent,
  setConfigFixture,
  resetConfig,
  pokes,
  deferred,
} from "./helpers"

const PRED = { enabled: true, maxMessages: 6, agent: "", model: "", timeoutMs: 15_000, prompt: "assess", denyTools: ["read", "bash"] }

function markerHandler(reply = "[Remind: 2 minutes]") {
  return async (arg: any) => {
    if (arg.path.id.startsWith("sub-")) {
      return { data: { parts: [{ type: "text", text: reply, synthetic: false }] } }
    }
    return { data: { parts: [] } }
  }
}

describe("predictor", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setConfigFixture({ predictor: PRED, idleMs: 60_000, logging: { enabled: false } })
  })

  afterEach(() => {
    vi.useRealTimers()
    resetConfig()
  })

  it("skips prediction when disabled", async () => {
    setConfigFixture({ predictor: { ...PRED, enabled: false }, logging: { enabled: false } })
    const { client, calls } = makeClient()
    client.setMessages([{ info: { role: "user" }, parts: [{ type: "text", text: "q", synthetic: false }] }])
    const p = await makePlugin(client)
    const msg = userMessage("s1", { model: { providerID: "p", modelID: "m" } })
    await p["chat.message"](msg.input, msg.output)
    await p.event(idleEvent("s1"))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls.create).toHaveLength(0)
    expect(pokes(calls)).toHaveLength(1)
    await p.dispose()
  })

  it("skips prediction when no model is known", async () => {
    const { client, calls } = makeClient()
    client.setMessages([{ info: { role: "user" }, parts: [{ type: "text", text: "q", synthetic: false }] }])
    const p = await makePlugin(client)
    const msg = userMessage("s1")
    await p["chat.message"](msg.input, msg.output)
    await p.event(idleEvent("s1"))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls.create).toHaveLength(0)
    await p.dispose()
  })

  it("skips prediction when there is no user-message excerpt", async () => {
    const { client, calls } = makeClient()
    client.setMessages([{ info: { role: "assistant" }, parts: [{ type: "text", text: "q", synthetic: false }] }])
    const p = await makePlugin(client)
    const msg = userMessage("s1", { model: { providerID: "p", modelID: "m" } })
    await p["chat.message"](msg.input, msg.output)
    await p.event(idleEvent("s1"))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls.create).toHaveLength(0)
    expect(pokes(calls)).toHaveLength(1)
    await p.dispose()
  })

  it("runs prediction, parses the marker, and updates the interval", async () => {
    const { client, calls } = makeClient()
    client.setMessages([{ info: { role: "user" }, parts: [{ type: "text", text: "explain X", synthetic: false }] }])
    client.setPromptHandler(markerHandler("[Remind: 2 minutes]"))
    const p = await makePlugin(client)
    const msg = userMessage("s1", { model: { providerID: "p", modelID: "m" }, agent: "build" })
    await p["chat.message"](msg.input, msg.output)
    await p.event(idleEvent("s1"))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls.create).toHaveLength(1)
    expect(calls.create[0].query.directory).toBe("C:\\Users\\test\\proj")
    const subPrompt = calls.prompt.find((c) => c.path.id.startsWith("sub-"))!
    expect(subPrompt).toBeTruthy()
    expect(subPrompt.body.parts[0].synthetic).toBe(true)
    expect(subPrompt.body.parts[0].text).toContain("explain X")
    expect(subPrompt.body.system).toBe("assess")
    expect(subPrompt.body.model).toEqual({ providerID: "p", modelID: "m" })
    expect(subPrompt.body.tools.read).toBe(false)
    expect(calls.delete).toHaveLength(1)
    expect(calls.delete[0].path.id).toBe(subPrompt.path.id)
    const first = pokes(calls)[0]
    expect(first.body.parts[0].text).toContain("about 60 seconds")
    expect(first.body.agent).toBe("build")
    const msg2 = userMessage("s1", { model: { providerID: "p", modelID: "m" } })
    await p["chat.message"](msg2.input, msg2.output)
    await p.event(idleEvent("s1"))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(pokes(calls)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(pokes(calls)).toHaveLength(2)
    expect(pokes(calls)[1].body.parts[0].text).toContain("about 120 seconds")
    await p.dispose()
  })

  it("pred.model override wins over the session model", async () => {
    setConfigFixture({ predictor: { ...PRED, model: "openai/gpt-4o" }, logging: { enabled: false } })
    const { client, calls } = makeClient()
    client.setMessages([{ info: { role: "user" }, parts: [{ type: "text", text: "q", synthetic: false }] }])
    client.setPromptHandler(markerHandler("[Remind: 1 minutes]"))
    const p = await makePlugin(client)
    const msg = userMessage("s1", { model: { providerID: "session", modelID: "model-x" } })
    await p["chat.message"](msg.input, msg.output)
    await p.event(idleEvent("s1"))
    await vi.advanceTimersByTimeAsync(60_000)
    const subPrompt = calls.prompt.find((c) => c.path.id.startsWith("sub-"))!
    expect(subPrompt.body.model).toEqual({ providerID: "openai", modelID: "gpt-4o" })
    await p.dispose()
  })

  it("invalid pred.model format falls back to the session model", async () => {
    setConfigFixture({ predictor: { ...PRED, model: "no-slash" }, logging: { enabled: false } })
    const { client, calls } = makeClient()
    client.setMessages([{ info: { role: "user" }, parts: [{ type: "text", text: "q", synthetic: false }] }])
    client.setPromptHandler(markerHandler("[Remind: 1 minutes]"))
    const p = await makePlugin(client)
    const msg = userMessage("s1", { model: { providerID: "session", modelID: "model-x" } })
    await p["chat.message"](msg.input, msg.output)
    await p.event(idleEvent("s1"))
    await vi.advanceTimersByTimeAsync(60_000)
    const subPrompt = calls.prompt.find((c) => c.path.id.startsWith("sub-"))!
    expect(subPrompt.body.model).toEqual({ providerID: "session", modelID: "model-x" })
    await p.dispose()
  })

  it("empty denyTools omits the tools field", async () => {
    setConfigFixture({ predictor: { ...PRED, denyTools: [] }, logging: { enabled: false } })
    const { client, calls } = makeClient()
    client.setMessages([{ info: { role: "user" }, parts: [{ type: "text", text: "q", synthetic: false }] }])
    client.setPromptHandler(markerHandler("[Remind: 1 minutes]"))
    const p = await makePlugin(client)
    const msg = userMessage("s1", { model: { providerID: "p", modelID: "m" } })
    await p["chat.message"](msg.input, msg.output)
    await p.event(idleEvent("s1"))
    await vi.advanceTimersByTimeAsync(60_000)
    const subPrompt = calls.prompt.find((c) => c.path.id.startsWith("sub-"))!
    expect(subPrompt.body.tools).toBeUndefined()
    await p.dispose()
  })

  it("timeouts after timeoutMs and falls back to the fixed interval", async () => {
    const gate = deferred<{ data: { parts: unknown[] } }>()
    const { client, calls } = makeClient()
    client.setMessages([{ info: { role: "user" }, parts: [{ type: "text", text: "q", synthetic: false }] }])
    client.setPromptHandler(async (arg) => {
      if (arg.path.id.startsWith("sub-")) return gate.promise
      return { data: { parts: [] } }
    })
    const p = await makePlugin(client)
    const msg = userMessage("s1", { model: { providerID: "p", modelID: "m" } })
    await p["chat.message"](msg.input, msg.output)
    await p.event(idleEvent("s1"))
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(calls.delete).toHaveLength(1)
    const poke = pokes(calls)[0]
    expect(poke.body.parts[0].text).toContain("about 60 seconds")
    await p.dispose()
  })

  it("ignores prediction for predictor sub-session prompts", async () => {
    const { client, calls } = makeClient()
    client.setMessages([{ info: { role: "user" }, parts: [{ type: "text", text: "q", synthetic: false }] }])
    client.setPromptHandler(markerHandler("[Remind: 2 minutes]"))
    const p = await makePlugin(client)
    const msg = userMessage("s1", { model: { providerID: "p", modelID: "m" } })
    await p["chat.message"](msg.input, msg.output)
    await p.event(idleEvent("s1"))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls.create).toHaveLength(1)
    const subID = calls.create[0].id
    expect(calls.prompt.some((c) => c.path.id === subID && c.body.system === "assess")).toBe(true)
    await p.dispose()
  })
})
