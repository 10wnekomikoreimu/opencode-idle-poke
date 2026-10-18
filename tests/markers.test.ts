import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  makePlugin,
  runPrompt,
  runContext,
  notifications,
  pokes,
  setConfigFixture,
  resetConfig,
  advance,
} from "./helpers"

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
    const h = await makePlugin()
    await runPrompt(h, "s1")
    await h.turnEnd("s1", "[Poke Off]\nunderstood")
    await advance(120_000)
    expect(pokes(h.calls)).toHaveLength(0)
    await runPrompt(h, "s1")
    await h.turnEnd("s1")
    await advance(60_000)
    expect(pokes(h.calls)).toHaveLength(0)
    await h.cleanup()
  })

  it("[Poke On] re-enables pokes", async () => {
    const h = await makePlugin()
    await runPrompt(h, "s1")
    await h.turnEnd("s1", "[Poke Off]")
    await h.turnEnd("s1", "[Poke On]")
    await advance(60_000)
    expect(pokes(h.calls)).toHaveLength(1)
    await h.cleanup()
  })

  it("[Remind: 5 minutes] sets a 300000ms delay", async () => {
    setConfigFixture({ idleMs: 60_000, logging: { enabled: false } })
    const h = await makePlugin()
    await runPrompt(h, "s1")
    await h.turnEnd("s1", "Let me set this.\n[Remind: 5 minutes]")
    await advance(60_000)
    expect(pokes(h.calls)).toHaveLength(0)
    await advance(240_000)
    const poke = pokes(h.calls)[0]
    expect(poke).toBeTruthy()
    expect(poke.text).toContain("about 300 seconds")
    await h.cleanup()
  })

  it("[Remind: 15s] below the 20s floor is ignored", async () => {
    setConfigFixture({ idleMs: 60_000, logging: { enabled: false } })
    const h = await makePlugin()
    await runPrompt(h, "s1")
    await h.turnEnd("s1", "[Remind: 15s]")
    await advance(60_000)
    const poke = pokes(h.calls)[0]
    expect(poke).toBeTruthy()
    expect(poke.text).toContain("about 60 seconds")
    await h.cleanup()
  })

  it("chinese marker 〔提醒间隔=5分钟〕 is recognized", async () => {
    const h = await makePlugin()
    await runPrompt(h, "s1")
    await h.turnEnd("s1", "〔提醒间隔=5分钟〕")
    await advance(60_000)
    expect(pokes(h.calls)).toHaveLength(0)
    await advance(240_000)
    expect(pokes(h.calls)).toHaveLength(1)
    await h.cleanup()
  })

  it("[Predictor Off] disables predictor; [Predictor On] re-enables it", async () => {
    setConfigFixture({
      idleMs: 60_000,
      predictor: { enabled: true },
      logging: { enabled: false },
    })
    const h = await makePlugin()
    h.setContextData([{ type: "user", text: "question?" }])
    h.setGenerateHandler(async () => ({ text: "[Remind: 2 minutes]" }))
    await runPrompt(h, "s1")
    await h.turnEnd("s1", "[Predictor Off]")
    await advance(60_000)
    expect(h.calls.create).toHaveLength(0)
    expect(pokes(h.calls)).toHaveLength(1)
    await runPrompt(h, "s1")
    await h.turnEnd("s1", "[Predictor On]")
    await advance(60_000)
    expect(h.calls.create).toHaveLength(1)
    expect(pokes(h.calls)).toHaveLength(2)
    await h.cleanup()
  })

  it("markers set dirty so restart notification is skipped", async () => {
    const h = await makePlugin()
    await runContext(h, "s1") // 先建状态（V2 text.ended 要求状态已存在）
    await h.turnEnd("s1", "[Poke Off]")
    await runPrompt(h, "s1")
    const notifs = await notifications(await runContext(h, "s1"))
    expect(notifs).toHaveLength(0)
    await h.cleanup()
  })

  it("only scans the first 5 lines", async () => {
    const h = await makePlugin()
    await runPrompt(h, "s1")
    await h.turnEnd("s1", "line1\nline2\nline3\nline4\nline5\n[Poke Off]")
    await advance(60_000)
    expect(pokes(h.calls)).toHaveLength(1)
    await h.cleanup()
  })

  it("[Remind: 19s] below the 20s floor is ignored", async () => {
    setConfigFixture({ idleMs: 60_000, logging: { enabled: false } })
    const h = await makePlugin()
    await runPrompt(h, "s1")
    await h.turnEnd("s1", "[Remind: 19s]")
    await advance(60_000)
    const poke = pokes(h.calls)[0]
    expect(poke).toBeTruthy()
    expect(poke.text).toContain("about 60 seconds")
    await h.cleanup()
  })

  it("[Remind: 25 hours] above the 24h ceiling is ignored", async () => {
    setConfigFixture({ idleMs: 60_000, logging: { enabled: false } })
    const h = await makePlugin()
    await runPrompt(h, "s1")
    await h.turnEnd("s1", "[Remind: 25 hours]")
    await advance(60_000)
    const poke = pokes(h.calls)[0]
    expect(poke).toBeTruthy()
    expect(poke.text).toContain("about 60 seconds")
    await h.cleanup()
  })

  it("[Remind: 30] with no unit defaults to seconds", async () => {
    setConfigFixture({ idleMs: 60_000, logging: { enabled: false } })
    const h = await makePlugin()
    await runPrompt(h, "s1")
    await h.turnEnd("s1", "[Remind: 30]")
    await advance(30_000)
    const poke = pokes(h.calls)[0]
    expect(poke).toBeTruthy()
    expect(poke.text).toContain("about 30 seconds")
    await h.cleanup()
  })

  it("chinese marker 〔提醒间隔=1小时〕 is recognized", async () => {
    setConfigFixture({ idleMs: 60_000, logging: { enabled: false } })
    const h = await makePlugin()
    await runPrompt(h, "s1")
    await h.turnEnd("s1", "〔提醒间隔=1小时〕")
    await advance(60_000)
    expect(pokes(h.calls)).toHaveLength(0)
    await advance(3_540_000)
    const poke = pokes(h.calls)[0]
    expect(poke).toBeTruthy()
    expect(poke.text).toContain("about 3600 seconds")
    await h.cleanup()
  })

  it("custom marker names are honored", async () => {
    setConfigFixture({
      idleMs: 60_000,
      enableMarker: "[继续]",
      disableMarker: "[停止]",
      logging: { enabled: false },
    })
    const h = await makePlugin()
    await runPrompt(h, "s1")
    await h.turnEnd("s1", "[停止]")
    await advance(60_000)
    expect(pokes(h.calls)).toHaveLength(0)
    await h.turnEnd("s1", "[继续]")
    await advance(60_000)
    expect(pokes(h.calls)).toHaveLength(1)
    await h.cleanup()
  })

  it("[Poke Off] and [Remind] in the same reply both apply", async () => {
    setConfigFixture({ idleMs: 60_000, logging: { enabled: false } })
    const h = await makePlugin()
    await runPrompt(h, "s1")
    await h.turnEnd("s1", "[Poke Off]\n[Remind: 2 minutes]")
    await advance(60_000)
    expect(pokes(h.calls)).toHaveLength(0)
    await h.turnEnd("s1", "[Poke On]")
    await advance(60_000)
    expect(pokes(h.calls)).toHaveLength(0)
    await advance(60_000)
    const poke = pokes(h.calls)[0]
    expect(poke).toBeTruthy()
    expect(poke.text).toContain("about 120 seconds")
    await h.cleanup()
  })
})
