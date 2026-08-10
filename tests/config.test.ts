import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import {
  makeClient,
  makePlugin,
  userMessage,
  idleEvent,
  deletedEvent,
  setConfigFixture,
  setJsonFixture,
  resetConfig,
  testConfigDir,
  pokes,
  notifications,
} from "./helpers"

describe("config loading", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setConfigFixture({ logging: { enabled: false } })
  })

  afterEach(async () => {
    vi.useRealTimers()
    resetConfig()
    await rm(testConfigDir, { recursive: true, force: true })
  })

  it("falls back to defaults when neither options nor JSON file is present", async () => {
    setConfigFixture(undefined)
    setJsonFixture(undefined, false)
    const { client, calls } = makeClient()
    const p = await makePlugin(client)
    const { input, output } = userMessage("s1", { agent: "build", model: { providerID: "p", modelID: "m" } })
    await p["chat.message"](input, output)
    await p.event(idleEvent("s1"))
    await vi.advanceTimersByTimeAsync(60_000)
    const poke = pokes(calls)[0]
    expect(poke).toBeTruthy()
    expect(poke.path.id).toBe("s1")
    expect(poke.body.parts[0].synthetic).toBe(true)
    expect(poke.body.parts[0].text).toContain("You have been silent for about 60 seconds")
    await p.dispose()
  })

  it("prefers plugin options over the global JSON file", async () => {
    setConfigFixture({ idleMs: 30_000, logging: { enabled: false } })
    setJsonFixture({ idleMs: 120_000, logging: { enabled: false } })
    const { client, calls } = makeClient()
    const p = await makePlugin(client)
    const { input, output } = userMessage("s1")
    await p["chat.message"](input, output)
    await p.event(idleEvent("s1"))
    await vi.advanceTimersByTimeAsync(30_000)
    const poke = pokes(calls)[0]
    expect(poke).toBeTruthy()
    expect(poke.body.parts[0].text).toContain("about 30 seconds")
    await p.dispose()
  })

  it("falls back to the global JSON file when options are absent", async () => {
    setConfigFixture(undefined)
    setJsonFixture({
      idleMs: 30_000,
      enabled: true,
      messageTemplate: "[custom] {seconds}s in {sessionID} at {project}",
      logging: { enabled: false },
    })
    const { client, calls } = makeClient()
    const p = await makePlugin(client)
    const { input, output } = userMessage("s1")
    await p["chat.message"](input, output)
    await p.event(idleEvent("s1"))
    await vi.advanceTimersByTimeAsync(30_000)
    const poke = pokes(calls)[0]
    expect(poke.body.parts[0].text).toContain("[custom] 30s in s1")
    expect(poke.body.parts[0].text).toContain("C:\\Users\\test\\proj")
    await p.dispose()
  })

  it("rejects invalid field values and falls back to defaults", async () => {
    setConfigFixture({
      idleMs: -5,
      enabled: "yes",
      messageTemplate: 42,
      requireEngagement: 0,
      predictor: { enabled: "on", maxMessages: -2, timeoutMs: 0 },
      logging: { enabled: false, level: "verbose" },
    })
    const { client, calls } = makeClient()
    const p = await makePlugin(client)
    const { input, output } = userMessage("s1")
    await p["chat.message"](input, output)
    await p.event(idleEvent("s1"))
    await vi.advanceTimersByTimeAsync(60_000)
    const poke = pokes(calls)[0]
    expect(poke.body.parts[0].text).toContain("You have been silent for about 60 seconds")
    await p.dispose()
  })

  it("accepts predictor.denyTools as an array and a string logging.file", async () => {
    setConfigFixture({
      predictor: { enabled: true, denyTools: ["read", "bash"] },
      logging: { enabled: false, file: "custom.log" },
    })
    const { client, calls } = makeClient()
    client.setMessages([
      {
        info: { role: "user" },
        parts: [{ type: "text", text: "explain something", synthetic: false }],
      },
    ])
    const p = await makePlugin(client)
    const { input, output } = userMessage("s1", { model: { providerID: "p", modelID: "m" } })
    await p["chat.message"](input, output)
    await p.event(idleEvent("s1"))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls.create).toHaveLength(1)
    expect(calls.prompt.some((c) => c.path.id.startsWith("sub-"))).toBe(true)
    await p.dispose()
  })

  it("writes default plugin-init log line to the global config dir when logging enabled", async () => {
    const logPath = join(testConfigDir, "logs", "opencode-idle-poke.log")
    setConfigFixture(undefined)
    setJsonFixture(undefined, false)
    const { client } = makeClient()
    const p = await makePlugin(client)
    await p.dispose()
    const content = await readFile(logPath, "utf8")
    expect(content).toContain("[INFO] plugin initialized")
    await rm(logPath, { force: true })
  })

  it("enabled:false keeps pokes off at startup until [Poke On]", async () => {
    setConfigFixture({ enabled: false, logging: { enabled: false } })
    const { client, calls } = makeClient()
    const p = await makePlugin(client)
    const msg = userMessage("s1")
    await p["chat.message"](msg.input, msg.output)
    await p.event(idleEvent("s1"))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(pokes(calls)).toHaveLength(0)
    const on = { input: { sessionID: "s1", messageID: "m", partID: "p" }, output: { text: "[Poke On]" } }
    await p["experimental.text.complete"](on.input, on.output)
    await p.event(idleEvent("s1"))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(pokes(calls)).toHaveLength(1)
    await p.dispose()
  })

  it("requireEngagement:false pokes even when the session was recreated", async () => {
    setConfigFixture({ requireEngagement: false, logging: { enabled: false } })
    const { client, calls } = makeClient()
    const p = await makePlugin(client)
    const msg = userMessage("s1")
    await p["chat.message"](msg.input, msg.output)
    await p.event(deletedEvent("s1"))
    await p.event(idleEvent("s1"))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(pokes(calls)).toHaveLength(1)
    await p.dispose()
  })

  it("empty logging.file writes no log file", async () => {
    const logPath = join(testConfigDir, "logs", "opencode-idle-poke.log")
    setConfigFixture({ logging: { enabled: true, file: "" } })
    const { client } = makeClient()
    const p = await makePlugin(client)
    await p.dispose()
    await expect(readFile(logPath, "utf8")).rejects.toThrow()
  })

  it("accepts an array as plugin options and falls back to defaults", async () => {
    const { client, calls } = makeClient()
    const p = await makePlugin(client, "C:\\Users\\test\\proj", [] as unknown as Record<string, unknown>)
    const msg = userMessage("s1")
    await p["chat.message"](msg.input, msg.output)
    await p.event(idleEvent("s1"))
    await vi.advanceTimersByTimeAsync(60_000)
    const poke = pokes(calls)[0]
    expect(poke).toBeTruthy()
    expect(poke.body.parts[0].text).toContain("about 60 seconds")
    await p.dispose()
  })

  it("rejects NaN/Infinity/zero idleMs and falls back to 60000", async () => {
    for (const bad of [NaN, Infinity, 0]) {
      setConfigFixture({ idleMs: bad, logging: { enabled: false } })
      const { client, calls } = makeClient()
      const p = await makePlugin(client)
      const msg = userMessage("s1")
      await p["chat.message"](msg.input, msg.output)
      await p.event(idleEvent("s1"))
      await vi.advanceTimersByTimeAsync(60_000)
      const poke = pokes(calls)[0]
      expect(poke).toBeTruthy()
      expect(poke.body.parts[0].text).toContain("about 60 seconds")
      await p.dispose()
    }
  })

  it("accepts a very large idleMs (3e9) without clamping the config", async () => {
    setConfigFixture({ idleMs: 3_000_000_000, logging: { enabled: false } })
    const { client, calls } = makeClient()
    const p = await makePlugin(client)
    const msg = userMessage("s1")
    await p["chat.message"](msg.input, msg.output)
    const notif = notifications(calls)[0]
    expect(notif).toBeTruthy()
    expect(notif.body.parts[0].text).toContain("interval 3000000s")
    await p.dispose()
  })

  it("blank enableMarker/disableMarker fall back to defaults", async () => {
    setConfigFixture({ enableMarker: "", disableMarker: "   ", logging: { enabled: false } })
    const { client, calls } = makeClient()
    const p = await makePlugin(client)
    const msg = userMessage("s1")
    await p["chat.message"](msg.input, msg.output)
    const off = { input: { sessionID: "s1", messageID: "m", partID: "p" }, output: { text: "[Poke Off]" } }
    await p["experimental.text.complete"](off.input, off.output)
    await p.event(idleEvent("s1"))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(pokes(calls)).toHaveLength(0)
    await p.dispose()
  })

  it("blank protocol/restartNotification fall back to defaults", async () => {
    setConfigFixture({ protocol: "", restartNotification: "   ", logging: { enabled: false } })
    const { client, calls } = makeClient()
    const p = await makePlugin(client)
    const out = { system: [] as string[] }
    await p["experimental.chat.system.transform"]({ sessionID: "s1", model: {} }, out)
    expect(out.system[0]).toContain("[Poke Off]")
    const msg = userMessage("s1")
    await p["chat.message"](msg.input, msg.output)
    const notif = notifications(calls)[0]
    expect(notif).toBeTruthy()
    expect(notif.body.parts[0].text).toContain("poke on")
    await p.dispose()
  })

  it("non-array denyTools keeps the default deny list", async () => {
    setConfigFixture({
      predictor: { enabled: true, denyTools: "read", prompt: "assess" },
      logging: { enabled: false },
    })
    const { client, calls } = makeClient()
    client.setMessages([{ info: { role: "user" }, parts: [{ type: "text", text: "q", synthetic: false }] }])
    client.setPromptHandler(async (arg: any) => {
      if (arg.path.id.startsWith("sub-")) {
        return { data: { parts: [{ type: "text", text: "[Remind: 2 minutes]", synthetic: false }] } }
      }
      return { data: { parts: [] } }
    })
    const p = await makePlugin(client)
    const msg = userMessage("s1", { model: { providerID: "p", modelID: "m" } })
    await p["chat.message"](msg.input, msg.output)
    await p.event(idleEvent("s1"))
    await vi.advanceTimersByTimeAsync(60_000)
    const subPrompt = calls.prompt.find((c) => c.path.id.startsWith("sub-"))!
    expect(subPrompt.body.tools.read).toBe(false)
    expect(subPrompt.body.tools.bash).toBe(false)
    await p.dispose()
  })

  it("denyTools filters out non-string entries", async () => {
    setConfigFixture({
      predictor: { enabled: true, denyTools: [42, "bash", null], prompt: "assess" },
      logging: { enabled: false },
    })
    const { client, calls } = makeClient()
    client.setMessages([{ info: { role: "user" }, parts: [{ type: "text", text: "q", synthetic: false }] }])
    client.setPromptHandler(async (arg: any) => {
      if (arg.path.id.startsWith("sub-")) {
        return { data: { parts: [{ type: "text", text: "[Remind: 2 minutes]", synthetic: false }] } }
      }
      return { data: { parts: [] } }
    })
    const p = await makePlugin(client)
    const msg = userMessage("s1", { model: { providerID: "p", modelID: "m" } })
    await p["chat.message"](msg.input, msg.output)
    await p.event(idleEvent("s1"))
    await vi.advanceTimersByTimeAsync(60_000)
    const subPrompt = calls.prompt.find((c) => c.path.id.startsWith("sub-"))!
    expect(subPrompt.body.tools).toEqual({ bash: false })
    await p.dispose()
  })

  it("fractional maxMessages is floored when building the excerpt", async () => {
    setConfigFixture({
      idleMs: 60_000,
      predictor: { enabled: true, maxMessages: 2.5, prompt: "assess" },
      logging: { enabled: false },
    })
    const { client, calls } = makeClient()
    client.setMessages([
      { info: { role: "user" }, parts: [{ type: "text", text: "first", synthetic: false }] },
      { info: { role: "user" }, parts: [{ type: "text", text: "second", synthetic: false }] },
      { info: { role: "user" }, parts: [{ type: "text", text: "third", synthetic: false }] },
    ])
    client.setPromptHandler(async (arg: any) => {
      if (arg.path.id.startsWith("sub-")) {
        return { data: { parts: [{ type: "text", text: "[Remind: 2 minutes]", synthetic: false }] } }
      }
      return { data: { parts: [] } }
    })
    const p = await makePlugin(client)
    const msg = userMessage("s1", { model: { providerID: "p", modelID: "m" } })
    await p["chat.message"](msg.input, msg.output)
    await p.event(idleEvent("s1"))
    await vi.advanceTimersByTimeAsync(60_000)
    const subPrompt = calls.prompt.find((c) => c.path.id.startsWith("sub-"))!
    const text = subPrompt.body.parts[0].text
    expect(text).toContain("second")
    expect(text).toContain("third")
    expect(text).not.toContain("first")
    await p.dispose()
  })

  it("non-string predictor agent/model fall back to empty", async () => {
    setConfigFixture({
      predictor: { enabled: true, agent: 123, model: true, prompt: "assess" },
      logging: { enabled: false },
    })
    const { client, calls } = makeClient()
    client.setMessages([{ info: { role: "user" }, parts: [{ type: "text", text: "q", synthetic: false }] }])
    client.setPromptHandler(async (arg: any) => {
      if (arg.path.id.startsWith("sub-")) {
        return { data: { parts: [{ type: "text", text: "[Remind: 2 minutes]", synthetic: false }] } }
      }
      return { data: { parts: [] } }
    })
    const p = await makePlugin(client)
    const msg = userMessage("s1", { model: { providerID: "p", modelID: "m" } })
    await p["chat.message"](msg.input, msg.output)
    await p.event(idleEvent("s1"))
    await vi.advanceTimersByTimeAsync(60_000)
    const subPrompt = calls.prompt.find((c) => c.path.id.startsWith("sub-"))!
    expect(subPrompt.body.agent).toBeUndefined()
    expect(subPrompt.body.model).toEqual({ providerID: "p", modelID: "m" })
    await p.dispose()
  })
})
