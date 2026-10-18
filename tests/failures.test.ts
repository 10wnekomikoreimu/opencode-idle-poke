import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { writeFile, rm, readFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import {
  makePlugin,
  runPrompt,
  pokes,
  setConfigFixture,
  resetConfig,
  testConfigDir,
  advance,
} from "./helpers"

const jsonFile = () => join(testConfigDir, "opencode-idle-poke.json")

async function writeJson(raw: string) {
  await mkdir(testConfigDir, { recursive: true })
  await writeFile(jsonFile(), raw, "utf8")
}

describe("config load failures and defensive paths", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setConfigFixture(undefined)
  })

  afterEach(async () => {
    vi.useRealTimers()
    resetConfig()
    await rm(testConfigDir, { recursive: true, force: true })
  })

  it("falls back to defaults when the JSON file is malformed", async () => {
    await writeJson('{ "idleMs": ')
    const h = await makePlugin()
    await runPrompt(h, "s1")
    await h.turnEnd("s1")
    await advance(60_000)
    const poke = pokes(h.calls)[0]
    expect(poke).toBeTruthy()
    expect(poke.text).toContain("about 60 seconds")
    await h.cleanup()
  })

  it("logs a warn line when the JSON file is malformed", async () => {
    await writeJson('{ "idleMs": ')
    const h = await makePlugin()
    await h.cleanup()
    const logPath = join(testConfigDir, "logs", "opencode-idle-poke.log")
    const content = await readFile(logPath, "utf8").catch(() => "")
    expect(content).toContain("[WARN] config load failed")
  })

  it("falls back to defaults when the JSON top level is an array", async () => {
    await writeJson("[1, 2, 3]")
    const h = await makePlugin()
    await runPrompt(h, "s1")
    await h.turnEnd("s1")
    await advance(60_000)
    const poke = pokes(h.calls)[0]
    expect(poke).toBeTruthy()
    expect(poke.text).toContain("about 60 seconds")
    await h.cleanup()
  })

  it("falls back to defaults when the JSON top level is a string", async () => {
    await writeJson('"hello"')
    const h = await makePlugin()
    await runPrompt(h, "s1")
    await h.turnEnd("s1")
    await advance(60_000)
    const poke = pokes(h.calls)[0]
    expect(poke).toBeTruthy()
    expect(poke.text).toContain("about 60 seconds")
    await h.cleanup()
  })

  it("falls back to defaults when the JSON top level is null", async () => {
    await writeJson("null")
    const h = await makePlugin()
    await runPrompt(h, "s1")
    await h.turnEnd("s1")
    await advance(60_000)
    const poke = pokes(h.calls)[0]
    expect(poke).toBeTruthy()
    expect(poke.text).toContain("about 60 seconds")
    await h.cleanup()
  })

  it("falls back to defaults when the JSON file is empty", async () => {
    await writeJson("")
    const h = await makePlugin()
    await runPrompt(h, "s1")
    await h.turnEnd("s1")
    await advance(60_000)
    const poke = pokes(h.calls)[0]
    expect(poke).toBeTruthy()
    expect(poke.text).toContain("about 60 seconds")
    await h.cleanup()
  })

  it("ignores unknown JSON fields while honoring known ones", async () => {
    await writeJson('{ "idleMs": 30000, "bogus": 1, "noSuchKey": "x" }')
    const h = await makePlugin()
    await runPrompt(h, "s1")
    await h.turnEnd("s1")
    await advance(30_000)
    const poke = pokes(h.calls)[0]
    expect(poke).toBeTruthy()
    expect(poke.text).toContain("about 30 seconds")
    await h.cleanup()
  })

  it("prompt hook tolerates a missing prompt field", async () => {
    const h = await makePlugin()
    await expect(h.hooks.prompt!({ sessionID: "s1" })).resolves.toBeUndefined()
    await h.turnEnd("s1")
    await advance(60_000)
    const poke = pokes(h.calls)[0]
    expect(poke).toBeTruthy()
    expect(poke.text).toContain("about 60 seconds")
    await h.cleanup()
  })

  it("text.ended for an untracked session is tolerated and the plugin survives", async () => {
    const h = await makePlugin()
    await h.turnEnd("nope")
    await advance(60_000)
    expect(pokes(h.calls)).toHaveLength(0)
    // 事件处理器仍正常工作
    await runPrompt(h, "s1")
    await h.turnEnd("s1")
    await advance(60_000)
    expect(pokes(h.calls)).toHaveLength(1)
    await h.cleanup()
  })

  it("malformed event payloads are ignored without crashing", async () => {
    const h = await makePlugin()
    h.emit("session.text.ended", {})
    h.emit("session.text.ended", { sessionID: "s1" })
    h.emit("session.status", { sessionID: "s1" })
    h.emit("session.status", { sessionID: "s1", status: {} })
    h.emit("session.deleted", {})
    h.emit("some.unknown.event", null as unknown as Record<string, unknown>)
    await advance(60_000)
    expect(pokes(h.calls)).toHaveLength(0)
    await runPrompt(h, "s1")
    await h.turnEnd("s1")
    await advance(60_000)
    expect(pokes(h.calls)).toHaveLength(1)
    await h.cleanup()
  })
})
