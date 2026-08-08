import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  makeClient,
  makePlugin,
  userMessage,
  idleEvent,
  setConfigFixture,
  resetConfig,
  pokes,
  notifications,
} from "./helpers"

function complete(sessionID: string, text: string) {
  return {
    input: { sessionID, messageID: "m", partID: "p" },
    output: { text },
  }
}

describe("marker protocol", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setConfigFixture({ logging: { enabled: false } })
  })

  afterEach(() => {
    vi.useRealTimers()
    resetConfig()
  })

  it("[Poke Off] disables pokes for the session", async () => {
    const { client, calls } = makeClient()
    const p = await makePlugin(client)
    let msg = userMessage("s1")
    await p["chat.message"](msg.input, msg.output)
    await p["experimental.text.complete"](complete("s1", "[Poke Off]\nunderstood").input, complete("s1", "[Poke Off]\nunderstood").output)
    await p.event(idleEvent("s1"))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(pokes(calls)).toHaveLength(0)
    msg = userMessage("s1")
    await p["chat.message"](msg.input, msg.output)
    await p.event(idleEvent("s1"))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(pokes(calls)).toHaveLength(0)
    await p.dispose()
  })

  it("[Poke On] re-enables pokes", async () => {
    const { client, calls } = makeClient()
    const p = await makePlugin(client)
    let msg = userMessage("s1")
    await p["chat.message"](msg.input, msg.output)
    const off = complete("s1", "[Poke Off]")
    await p["experimental.text.complete"](off.input, off.output)
    const on = complete("s1", "[Poke On]")
    await p["experimental.text.complete"](on.input, on.output)
    await p.event(idleEvent("s1"))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(pokes(calls)).toHaveLength(1)
    await p.dispose()
  })

  it("[Remind: 5 minutes] sets a 300000ms delay", async () => {
    setConfigFixture({ idleMs: 60_000, logging: { enabled: false } })
    const { client, calls } = makeClient()
    const p = await makePlugin(client)
    let msg = userMessage("s1")
    await p["chat.message"](msg.input, msg.output)
    const c = complete("s1", "Let me set this.\n[Remind: 5 minutes]")
    await p["experimental.text.complete"](c.input, c.output)
    await p.event(idleEvent("s1"))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(pokes(calls)).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(240_000)
    const poke = pokes(calls)[0]
    expect(poke).toBeTruthy()
    expect(poke.body.parts[0].text).toContain("about 300 seconds")
    await p.dispose()
  })

  it("[Remind: 15s] below the 20s floor is ignored", async () => {
    setConfigFixture({ idleMs: 60_000, logging: { enabled: false } })
    const { client, calls } = makeClient()
    const p = await makePlugin(client)
    let msg = userMessage("s1")
    await p["chat.message"](msg.input, msg.output)
    const c = complete("s1", "[Remind: 15s]")
    await p["experimental.text.complete"](c.input, c.output)
    await p.event(idleEvent("s1"))
    await vi.advanceTimersByTimeAsync(60_000)
    const poke = pokes(calls)[0]
    expect(poke).toBeTruthy()
    expect(poke.body.parts[0].text).toContain("about 60 seconds")
    await p.dispose()
  })

  it("chinese marker 〔提醒间隔=5分钟〕 is recognized", async () => {
    const { client, calls } = makeClient()
    const p = await makePlugin(client)
    let msg = userMessage("s1")
    await p["chat.message"](msg.input, msg.output)
    const c = complete("s1", "〔提醒间隔=5分钟〕")
    await p["experimental.text.complete"](c.input, c.output)
    await p.event(idleEvent("s1"))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(pokes(calls)).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(240_000)
    expect(pokes(calls)).toHaveLength(1)
    await p.dispose()
  })

  it("[Predictor Off] disables predictor; [Predictor On] re-enables it", async () => {
    setConfigFixture({
      idleMs: 60_000,
      predictor: { enabled: true, maxMessages: 6, agent: "", model: "", timeoutMs: 15_000, prompt: "assess", denyTools: [] },
      logging: { enabled: false },
    })
    const { client, calls } = makeClient()
    client.setMessages([
      { info: { role: "user" }, parts: [{ type: "text", text: "question?", synthetic: false }] },
    ])
    client.setPromptHandler(async (arg) => {
      if (arg.path.id.startsWith("sub-")) {
        return { data: { parts: [{ type: "text", text: "[Remind: 2 minutes]", synthetic: false }] } }
      }
      return { data: { parts: [] } }
    })
    const p = await makePlugin(client)
    const msg = userMessage("s1", { model: { providerID: "p", modelID: "m" } })
    await p["chat.message"](msg.input, msg.output)
    const off = complete("s1", "[Predictor Off]")
    await p["experimental.text.complete"](off.input, off.output)
    const before = calls.create.length
    await p.event(idleEvent("s1"))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls.create.length).toBe(before)
    expect(pokes(calls)).toHaveLength(1)
    const on = complete("s1", "[Predictor On]")
    await p["experimental.text.complete"](on.input, on.output)
    let msg2 = userMessage("s1", { model: { providerID: "p", modelID: "m" } })
    await p["chat.message"](msg2.input, msg2.output)
    await p.event(idleEvent("s1"))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls.create.length).toBe(before + 1)
    await p.dispose()
  })

  it("markers set dirty so restart notification is skipped", async () => {
    const { client, calls } = makeClient()
    const p = await makePlugin(client)
    await p["experimental.chat.system.transform"]({ sessionID: "s1", model: {} }, { system: [] })
    const c = complete("s1", "[Poke Off]")
    await p["experimental.text.complete"](c.input, c.output)
    const msg = userMessage("s1")
    await p["chat.message"](msg.input, msg.output)
    expect(notifications(calls)).toHaveLength(0)
    await p.dispose()
  })

  it("only scans the first 5 lines", async () => {
    const { client, calls } = makeClient()
    const p = await makePlugin(client)
    let msg = userMessage("s1")
    await p["chat.message"](msg.input, msg.output)
    const c = complete("s1", "line1\nline2\nline3\nline4\nline5\n[Poke Off]")
    await p["experimental.text.complete"](c.input, c.output)
    await p.event(idleEvent("s1"))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(pokes(calls)).toHaveLength(1)
    await p.dispose()
  })
})
