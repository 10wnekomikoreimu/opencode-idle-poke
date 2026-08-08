import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import {
  makeClient,
  makePlugin,
  userMessage,
  idleEvent,
  setConfigFixture,
  setJsonFixture,
  resetConfig,
  testConfigDir,
  pokes,
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
})
