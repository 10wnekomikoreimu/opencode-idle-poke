import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  makeClient,
  makePlugin,
  userMessage,
  setConfigFixture,
  resetConfig,
  notifications,
} from "./helpers"

describe("system transform (protocol injection)", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setConfigFixture({ logging: { enabled: false } })
  })

  afterEach(() => {
    vi.useRealTimers()
    resetConfig()
  })

  it("pushes the protocol with placeholder markers replaced", async () => {
    const { client } = makeClient()
    const p = await makePlugin(client)
    const output = { system: [] as string[] }
    await p["experimental.chat.system.transform"]({ sessionID: "s1", model: {} }, output)
    expect(output.system).toHaveLength(1)
    const text = output.system[0]
    expect(text).toContain("[Poke Off]")
    expect(text).toContain("[Poke On]")
    expect(text).toContain("[Predictor Off]")
    expect(text).toContain("[Predictor On]")
    expect(text).toContain("[Remind: N unit]")
    await p.dispose()
  })

  it("uses configured marker values", async () => {
    setConfigFixture({
      enableMarker: "[Resume]",
      disableMarker: "[Halt]",
      enablePredictorMarker: "[PredOn]",
      disablePredictorMarker: "[PredOff]",
      logging: { enabled: false },
    })
    const { client } = makeClient()
    const p = await makePlugin(client)
    const output = { system: [] as string[] }
    await p["experimental.chat.system.transform"]({ sessionID: "s1", model: {} }, output)
    expect(output.system[0]).toContain("[Halt]")
    expect(output.system[0]).toContain("[Resume]")
    expect(output.system[0]).toContain("[PredOff]")
    expect(output.system[0]).toContain("[PredOn]")
    await p.dispose()
  })

  it("does not push protocol for predictor sub-sessions", async () => {
    setConfigFixture({
      predictor: { enabled: true, maxMessages: 6, agent: "", model: "", timeoutMs: 15_000, prompt: "assess", denyTools: [] },
      logging: { enabled: false },
    })
    const { client, calls } = makeClient()
    client.setMessages([{ info: { role: "user" }, parts: [{ type: "text", text: "q", synthetic: false }] }])
    let resolveSub: (() => void) | undefined
    client.setPromptHandler(async (arg) => {
      if (arg.path.id.startsWith("sub-")) {
        await new Promise<void>((res) => {
          resolveSub = res
        })
        return { data: { parts: [{ type: "text", text: "[Remind: 1 minutes]", synthetic: false }] } }
      }
      return { data: { parts: [] } }
    })
    const p = await makePlugin(client)
    const msg = userMessage("s1", { model: { providerID: "p", modelID: "m" } })
    await p["chat.message"](msg.input, msg.output)
    await p.event({ event: { type: "session.status", properties: { sessionID: "s1", status: { type: "idle" } } } })
    await vi.advanceTimersByTimeAsync(60_000)
    const subID = calls.create[0].id
    expect(resolveSub).toBeDefined()
    const output = { system: [] as string[] }
    await p["experimental.chat.system.transform"]({ sessionID: subID, model: {} }, output)
    expect(output.system).toHaveLength(0)
    resolveSub!()
    await vi.advanceTimersByTimeAsync(0)
    await p.dispose()
  })

  it("ensures a session on transform so markers can be applied without prior message", async () => {
    const { client, calls } = makeClient()
    const p = await makePlugin(client)
    await p["experimental.chat.system.transform"]({ sessionID: "s1", model: {} }, { system: [] })
    await p["experimental.text.complete"]({ sessionID: "s1", messageID: "m", partID: "p" }, { text: "[Poke Off]" })
    const msg = userMessage("s1")
    await p["chat.message"](msg.input, msg.output)
    expect(notifications(calls)).toHaveLength(0)
    await p.dispose()
  })
})
