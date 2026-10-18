import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { makePlugin, runPrompt, setConfigFixture, resetConfig, testConfigDir } from "./helpers"

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
    const h = await makePlugin()
    await runPrompt(h, "s1")
    await h.cleanup()
    const defaultLog = join(testConfigDir, "logs", "opencode-idle-poke.log")
    expect(await readFile(defaultLog, "utf8").catch(() => "")).toBe("")
  })

  it("respects the configured log level", async () => {
    const logFile = join(dir, "info.log")
    setConfigFixture({ logging: { enabled: true, level: "info", file: logFile } })
    const h = await makePlugin()
    await runPrompt(h, "s1")
    await h.turnEnd("s1", "[Poke Off]")
    await h.cleanup()
    const content = await readFile(logFile, "utf8")
    expect(content).toContain("[INFO] plugin initialized")
    expect(content).toContain("[INFO] marker: disabled")
    expect(content).not.toContain("[DEBUG]")
  })

  it("writes debug lines when level is debug", async () => {
    const logFile = join(dir, "debug.log")
    setConfigFixture({ logging: { enabled: true, level: "debug", file: logFile } })
    const h = await makePlugin()
    await runPrompt(h, "s1")
    await h.cleanup()
    const content = await readFile(logFile, "utf8")
    expect(content).toContain("[DEBUG] session tracked")
    expect(content).toContain("[DEBUG] user message")
  })

  it("resolves a relative log path against the opencode global config dir", async () => {
    const relative = "logs/test-relative.log"
    const expected = join(testConfigDir, relative)
    setConfigFixture({ logging: { enabled: true, level: "info", file: relative } })
    const h = await makePlugin()
    await h.cleanup()
    const content = await readFile(expected, "utf8")
    expect(content).toContain("[INFO] plugin initialized")
  })
})
