import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { writeFile, rm, readFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import {
  makeClient,
  makePlugin,
  userMessage,
  idleEvent,
  setConfigFixture,
  resetConfig,
  testConfigDir,
  pokes,
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
  })

  it("logs a warn line when the JSON file is malformed", async () => {
    await writeJson('{ "idleMs": ')
    const { client } = makeClient()
    const p = await makePlugin(client)
    await p.dispose()
    const logPath = join(testConfigDir, "logs", "opencode-idle-poke.log")
    const content = await readFile(logPath, "utf8").catch(() => "")
    expect(content).toContain("[WARN] config load failed")
  })

  it("falls back to defaults when the JSON top level is an array", async () => {
    await writeJson("[1, 2, 3]")
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
  })

  it("falls back to defaults when the JSON top level is a string", async () => {
    await writeJson('"hello"')
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
  })

  it("falls back to defaults when the JSON top level is null", async () => {
    await writeJson("null")
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
  })

  it("falls back to defaults when the JSON file is empty", async () => {
    await writeJson("")
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
  })

  it("ignores unknown JSON fields while honoring known ones", async () => {
    await writeJson('{ "idleMs": 30000, "bogus": 1, "noSuchKey": "x" }')
    const { client, calls } = makeClient()
    const p = await makePlugin(client)
    const msg = userMessage("s1")
    await p["chat.message"](msg.input, msg.output)
    await p.event(idleEvent("s1"))
    await vi.advanceTimersByTimeAsync(30_000)
    const poke = pokes(calls)[0]
    expect(poke).toBeTruthy()
    expect(poke.body.parts[0].text).toContain("about 30 seconds")
    await p.dispose()
  })

  it("chat.message tolerates a missing parts field", async () => {
    const { client, calls } = makeClient()
    const p = await makePlugin(client)
    await expect(p["chat.message"]({ sessionID: "s1" }, {})).resolves.toBeUndefined()
    await p.event(idleEvent("s1"))
    await vi.advanceTimersByTimeAsync(60_000)
    const poke = pokes(calls)[0]
    expect(poke).toBeTruthy()
    expect(poke.body.parts[0].text).toContain("about 60 seconds")
    await p.dispose()
  })

  it("text.complete tolerates an untracked session", async () => {
    const { client, calls } = makeClient()
    const p = await makePlugin(client)
    await expect(
      p["experimental.text.complete"]({ sessionID: "nope", messageID: "m", partID: "p" }, { text: "[Poke Off]" })
    ).resolves.toBeUndefined()
    await p.event(idleEvent("nope"))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(pokes(calls)).toHaveLength(0)
    await p.dispose()
  })
})
