import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  makeClient,
  makePlugin,
  userMessage,
  setConfigFixture,
  resetConfig,
  notifications,
} from "./helpers"

describe("restart notification", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setConfigFixture({ logging: { enabled: false } })
  })

  afterEach(() => {
    vi.useRealTimers()
    resetConfig()
  })

  it("injects a synthetic restart notification on the first real user message", async () => {
    setConfigFixture({ predictor: { enabled: true }, logging: { enabled: false } })
    const { client, calls } = makeClient()
    const p = await makePlugin(client)
    const msg = userMessage("s1")
    await p["chat.message"](msg.input, msg.output)
    const notif = notifications(calls)
    expect(notif).toHaveLength(1)
    expect(notif[0].body.parts[0].synthetic).toBe(true)
    const text = notif[0].body.parts[0].text
    expect(text).toContain("poke on")
    expect(text).toContain("interval 60s")
    expect(text).toContain("model-predicted interval on")
    expect(notif[0].body.agent).toBeUndefined()
    await p.dispose()
  })

  it("carries the triggering message's agent on the injected notification", async () => {
    setConfigFixture({ logging: { enabled: false } })
    const { client, calls } = makeClient()
    const p = await makePlugin(client)
    const msg = userMessage("s1", { agent: "plan" })
    await p["chat.message"](msg.input, msg.output)
    const notif = notifications(calls)
    expect(notif).toHaveLength(1)
    expect(notif[0].body.agent).toBe("plan")
    await p.dispose()
  })

  it("uses enabled/interval/predictor values from the config", async () => {
    setConfigFixture({
      enabled: false,
      idleMs: 120_000,
      predictor: { enabled: true },
      restartNotification: "N: poke {enabled}, interval {interval}s, predicted {predictor}",
      logging: { enabled: false },
    })
    const { client, calls } = makeClient()
    const p = await makePlugin(client)
    const msg = userMessage("s1")
    await p["chat.message"](msg.input, msg.output)
    const notif = notifications(calls, "N: poke")
    expect(notif).toHaveLength(1)
    expect(notif[0].body.parts[0].text).toBe("N: poke off, interval 120s, predicted on")
    await p.dispose()
  })

  it("does not inject twice for subsequent real messages", async () => {
    const { client, calls } = makeClient()
    const p = await makePlugin(client)
    let msg = userMessage("s1")
    await p["chat.message"](msg.input, msg.output)
    msg = userMessage("s1")
    await p["chat.message"](msg.input, msg.output)
    expect(notifications(calls)).toHaveLength(1)
    await p.dispose()
  })

  it("does not inject when the user already used markers (dirty)", async () => {
    const { client, calls } = makeClient()
    const p = await makePlugin(client)
    await p["experimental.chat.system.transform"](
      { sessionID: "s1" },
      { system: [] }
    )
    await p["experimental.text.complete"](
      { sessionID: "s1", messageID: "m", partID: "p" },
      { text: "[Poke Off]" }
    )
    const msg = userMessage("s1")
    await p["chat.message"](msg.input, msg.output)
    expect(notifications(calls)).toHaveLength(0)
    await p.dispose()
  })

  it("tracks notification state per session", async () => {
    const { client, calls } = makeClient()
    const p = await makePlugin(client)
    const a = userMessage("A")
    await p["chat.message"](a.input, a.output)
    const b = userMessage("B")
    await p["chat.message"](b.input, b.output)
    const c = userMessage("B")
    await p["chat.message"](c.input, c.output)
    expect(notifications(calls)).toHaveLength(2)
    await p.dispose()
  })
})
