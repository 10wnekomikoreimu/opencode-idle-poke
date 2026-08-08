import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { makeClient, makePlugin, userMessage, setConfigFixture, resetConfig, testConfigDir } from "./helpers"

describe("logging", () => {
  let dir: string

  beforeEach(async () => {
    vi.useFakeTimers()
    dir = await mkdtemp(join(tmpdir(), "idle-poke-log-"))
  })

  afterEach(async () => {
    vi.useRealTimers()
    resetConfig()
    await rm(dir, { recursive: true, force: true })
    await rm(join(testConfigDir, "logs"), { recursive: true, force: true })
  })

  it("writes nothing when logging is disabled", async () => {
    setConfigFixture({ logging: { enabled: false, level: "debug" } })
    const { client } = makeClient()
    const p = await makePlugin(client)
    const msg = userMessage("s1")
    await p["chat.message"](msg.input, msg.output)
    await p.dispose()
    expect(await readFile(join(dir, "idle-poke.log"), "utf8").catch(() => "")).toBe("")
  })

  it("respects the configured log level", async () => {
    const logFile = join(dir, "info.log")
    setConfigFixture({ logging: { enabled: true, level: "info", file: logFile } })
    const { client } = makeClient()
    const p = await makePlugin(client)
    const msg = userMessage("s1")
    await p["chat.message"](msg.input, msg.output)
    await p["experimental.text.complete"]({ sessionID: "s1", messageID: "m", partID: "p" }, { text: "[Poke Off]" })
    await p.dispose()
    const content = await readFile(logFile, "utf8")
    expect(content).toContain("[INFO] plugin initialized")
    expect(content).toContain("[INFO] marker: disabled")
    expect(content).not.toContain("[DEBUG]")
  })

  it("writes debug lines when level is debug", async () => {
    const logFile = join(dir, "debug.log")
    setConfigFixture({ logging: { enabled: true, level: "debug", file: logFile } })
    const { client } = makeClient()
    const p = await makePlugin(client)
    const msg = userMessage("s1")
    await p["chat.message"](msg.input, msg.output)
    await p.dispose()
    const content = await readFile(logFile, "utf8")
    expect(content).toContain("[DEBUG] session tracked")
    expect(content).toContain("[DEBUG] user message")
  })

  it("resolves a relative log path against the opencode global config dir", async () => {
    const relative = "logs/test-relative.log"
    const expected = join(testConfigDir, relative)
    setConfigFixture({ logging: { enabled: true, level: "info", file: relative } })
    const { client } = makeClient()
    const p = await makePlugin(client)
    await p.dispose()
    const content = await readFile(expected, "utf8")
    expect(content).toContain("[INFO] plugin initialized")
  })
})
