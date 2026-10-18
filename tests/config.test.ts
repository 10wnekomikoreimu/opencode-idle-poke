import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import {
  makePlugin,
  runPrompt,
  runContext,
  notifications,
  pokes,
  setConfigFixture,
  setJsonFixture,
  resetConfig,
  testConfigDir,
  advance,
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
    const h = await makePlugin()
    await runPrompt(h, "s1")
    await h.turnEnd("s1")
    await advance(60_000)
    const poke = pokes(h.calls)[0]
    expect(poke).toBeTruthy()
    expect(poke.sessionID).toBe("s1")
    expect(poke.text).toContain("have been silent for about 60 seconds")
    await h.cleanup()
  })

  it("prefers plugin options over the global JSON file", async () => {
    setConfigFixture({ idleMs: 30_000, logging: { enabled: false } })
    setJsonFixture({ idleMs: 120_000, logging: { enabled: false } })
    const h = await makePlugin()
    await runPrompt(h, "s1")
    await h.turnEnd("s1")
    await advance(30_000)
    const poke = pokes(h.calls)[0]
    expect(poke).toBeTruthy()
    expect(poke.text).toContain("about 30 seconds")
    await h.cleanup()
  })

  it("falls back to the global JSON file when options are empty", async () => {
    setConfigFixture(undefined)
    setJsonFixture({
      idleMs: 30_000,
      enabled: true,
      messageTemplate: "[custom] {seconds}s in {sessionID} at {project}",
      logging: { enabled: false },
    })
    const h = await makePlugin()
    await runPrompt(h, "s1")
    await h.turnEnd("s1")
    await advance(30_000)
    const poke = pokes(h.calls)[0]
    expect(poke.text).toContain("[custom] 30s in s1")
    expect(poke.text).toContain("C:\\Users\\test\\proj")
    await h.cleanup()
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
    const h = await makePlugin()
    await runPrompt(h, "s1")
    await h.turnEnd("s1")
    await advance(60_000)
    const poke = pokes(h.calls)[0]
    expect(poke.text).toContain("have been silent for about 60 seconds")
    await h.cleanup()
  })

  it("ignores legacy predictor fields (agent/denyTools) and uses the default model", async () => {
    setConfigFixture({
      predictor: {
        enabled: true,
        agent: "legacy-agent",
        denyTools: ["read", "bash"],
        model: true, // 非字符串 → 用内置默认
        prompt: "assess",
      },
      logging: { enabled: false },
    })
    const h = await makePlugin()
    h.setContextData([{ type: "user", text: "explain something" }])
    h.setGenerateHandler(async () => ({ text: "[Remind: 2 minutes]" }))
    await runPrompt(h, "s1")
    await h.turnEnd("s1")
    await advance(60_000)
    expect(h.calls.create).toHaveLength(1)
    expect(h.calls.create[0].model).toEqual({ providerID: "opencode", id: "big-pickle" })
    expect(h.calls.generate).toHaveLength(1)
    expect(h.calls.generate[0].prompt.startsWith("assess")).toBe(true)
    expect(h.calls.generate[0].prompt).toContain("explain something")
    await h.cleanup()
  })

  it("writes default plugin-init log line to the global config dir when logging enabled", async () => {
    const logPath = join(testConfigDir, "logs", "opencode-idle-poke.log")
    setConfigFixture(undefined)
    setJsonFixture(undefined, false)
    const h = await makePlugin()
    await h.cleanup()
    const content = await readFile(logPath, "utf8")
    expect(content).toContain("[INFO] plugin initialized")
  })

  it("enabled:false keeps pokes off at startup until [Poke On]", async () => {
    setConfigFixture({ enabled: false, logging: { enabled: false } })
    const h = await makePlugin()
    await runPrompt(h, "s1")
    await h.turnEnd("s1")
    await advance(60_000)
    expect(pokes(h.calls)).toHaveLength(0)
    await h.turnEnd("s1", "[Poke On]")
    await advance(60_000)
    expect(pokes(h.calls)).toHaveLength(1)
    await h.cleanup()
  })

  it("requireEngagement:false pokes even when the session was recreated", async () => {
    setConfigFixture({ requireEngagement: false, logging: { enabled: false } })
    const h = await makePlugin()
    await runPrompt(h, "s1")
    await h.deleted("s1")
    await h.activity("s1")
    await advance(60_000)
    expect(pokes(h.calls)).toHaveLength(1)
    await h.cleanup()
  })

  it("empty logging.file writes no log file", async () => {
    const logPath = join(testConfigDir, "logs", "opencode-idle-poke.log")
    setConfigFixture({ logging: { enabled: true, file: "" } })
    const h = await makePlugin()
    await h.cleanup()
    await expect(readFile(logPath, "utf8")).rejects.toThrow()
  })

  it("empty options fall back to the JSON file and then to defaults", async () => {
    setJsonFixture(undefined, false)
    const h = await makePlugin("C:\\Users\\test\\proj", [] as unknown as Record<string, unknown>)
    await runPrompt(h, "s1")
    await h.turnEnd("s1")
    await advance(60_000)
    const poke = pokes(h.calls)[0]
    expect(poke).toBeTruthy()
    expect(poke.text).toContain("about 60 seconds")
    await h.cleanup()
  })

  it("rejects NaN/Infinity/zero idleMs and falls back to 60000", async () => {
    for (const bad of [NaN, Infinity, 0]) {
      setConfigFixture({ idleMs: bad, logging: { enabled: false } })
      const h = await makePlugin()
      await runPrompt(h, "s1")
      await h.turnEnd("s1")
      await advance(60_000)
      const poke = pokes(h.calls)[0]
      expect(poke).toBeTruthy()
      expect(poke.text).toContain("about 60 seconds")
      await h.cleanup()
    }
  })

  it("accepts a very large idleMs (3e9) without clamping the config", async () => {
    setConfigFixture({ idleMs: 3_000_000_000, logging: { enabled: false } })
    const h = await makePlugin()
    await runPrompt(h, "s1")
    const notifs = await notifications(await runContext(h, "s1"))
    expect(notifs[0]).toBeTruthy()
    expect(notifs[0].text).toContain("interval 3000000s")
    await h.cleanup()
  })

  it("blank enableMarker/disableMarker fall back to defaults", async () => {
    setConfigFixture({ enableMarker: "", disableMarker: "   ", logging: { enabled: false } })
    const h = await makePlugin()
    await runPrompt(h, "s1")
    await h.turnEnd("s1", "[Poke Off]")
    await advance(60_000)
    expect(pokes(h.calls)).toHaveLength(0)
    await h.cleanup()
  })

  it("blank protocol/restartNotification fall back to defaults", async () => {
    setConfigFixture({ protocol: "", restartNotification: "   ", logging: { enabled: false } })
    const h = await makePlugin()
    const system = await runContext(h, "s1")
    expect(system[0].text).toContain("[Poke Off]")
    await runPrompt(h, "s1")
    const notifs = await notifications(await runContext(h, "s1"))
    expect(notifs[0]).toBeTruthy()
    expect(notifs[0].text).toContain("poke on")
    await h.cleanup()
  })

  it("fractional maxMessages is floored when building the excerpt", async () => {
    setConfigFixture({
      idleMs: 60_000,
      predictor: { enabled: true, maxMessages: 2.5, prompt: "assess" },
      logging: { enabled: false },
    })
    const h = await makePlugin()
    h.setContextData([
      { type: "user", text: "first" },
      { type: "user", text: "second" },
      { type: "user", text: "third" },
    ])
    h.setGenerateHandler(async () => ({ text: "[Remind: 2 minutes]" }))
    await runPrompt(h, "s1")
    await h.turnEnd("s1")
    await advance(60_000)
    const prompt = h.calls.generate[0].prompt
    expect(prompt).toContain("second")
    expect(prompt).toContain("third")
    expect(prompt).not.toContain("first")
    await h.cleanup()
  })

  it("non-array ignoreSessionTitles falls back to the empty default (session not ignored)", async () => {
    setConfigFixture({ ignoreSessionTitles: "opencode-mem capture", logging: { enabled: false } })
    const h = await makePlugin()
    h.setTitle("sub-cap", "opencode-mem capture")
    await runPrompt(h, "s1")
    await h.turnEnd("s1")
    await runPrompt(h, "sub-cap") // 黑名单未生效 → sub-cap 成为 lastActive
    await h.turnEnd("sub-cap")
    await advance(60_000)
    const poke = pokes(h.calls)[0]
    expect(poke).toBeTruthy()
    expect(poke.sessionID).toBe("sub-cap")
    await h.cleanup()
  })

  it("ignoreSessionTitles filters out non-string entries and ignores the rest", async () => {
    setConfigFixture({
      ignoreSessionTitles: [42, "opencode-mem capture", null],
      logging: { enabled: false },
    })
    const h = await makePlugin()
    h.setTitle("sub-cap", "opencode-mem capture")
    await runPrompt(h, "s1")
    await h.turnEnd("s1")
    await runPrompt(h, "sub-cap") // 被忽略 → lastActive 不变，s1 计时器不被掐
    await advance(60_000)
    const poke = pokes(h.calls)[0]
    expect(poke).toBeTruthy()
    expect(poke.sessionID).toBe("s1")
    await h.cleanup()
  })
})
