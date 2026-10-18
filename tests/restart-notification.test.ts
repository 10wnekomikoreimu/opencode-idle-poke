import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  makePlugin,
  runPrompt,
  runContext,
  notifications,
  setConfigFixture,
  resetConfig,
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

  it("injects a restart notification into system on the first real user prompt", async () => {
    setConfigFixture({ predictor: { enabled: true }, logging: { enabled: false } })
    const h = await makePlugin()
    await runPrompt(h, "s1")
    const system = await runContext(h, "s1")
    const notifs = notifications(system)
    expect(notifs).toHaveLength(1)
    expect(notifs[0].type).toBe("text")
    expect(notifs[0].text).toContain("poke on")
    expect(notifs[0].text).toContain("interval 60s")
    expect(notifs[0].text).toContain("model-predicted interval on")
    await h.cleanup()
  })

  it("pushes the protocol on every context build but the notification only once", async () => {
    const h = await makePlugin()
    await runPrompt(h, "s1")
    const first = await runContext(h, "s1")
    const second = await runContext(h, "s1")
    expect(first[0].text).toContain("[Poke Off]")
    expect(second[0].text).toContain("[Poke Off]")
    expect(notifications(first)).toHaveLength(1)
    expect(notifications(second)).toHaveLength(0)
    await h.cleanup()
  })

  it("uses enabled/interval/predictor values from the config", async () => {
    setConfigFixture({
      enabled: false,
      idleMs: 120_000,
      predictor: { enabled: true },
      restartNotification: "N: poke {enabled}, interval {interval}s, predicted {predictor}",
      logging: { enabled: false },
    })
    const h = await makePlugin()
    await runPrompt(h, "s1")
    const notifs = notifications(await runContext(h, "s1"), "N: poke")
    expect(notifs).toHaveLength(1)
    expect(notifs[0].text).toBe("N: poke off, interval 120s, predicted on")
    await h.cleanup()
  })

  it("does not inject twice for subsequent real messages", async () => {
    const h = await makePlugin()
    await runPrompt(h, "s1")
    await runContext(h, "s1")
    await runPrompt(h, "s1")
    const second = await runContext(h, "s1")
    expect(notifications(second)).toHaveLength(0)
    await h.cleanup()
  })

  it("does not inject when the user already used markers (dirty)", async () => {
    const h = await makePlugin()
    await runContext(h, "s1") // 建状态
    await h.turnEnd("s1", "[Poke Off]")
    await runPrompt(h, "s1")
    const notifs = notifications(await runContext(h, "s1"))
    expect(notifs).toHaveLength(0)
    await h.cleanup()
  })

  it("tracks notification state per session", async () => {
    const h = await makePlugin()
    await runPrompt(h, "A")
    await runPrompt(h, "B")
    await runPrompt(h, "B")
    const fromA = notifications(await runContext(h, "A"))
    const fromB = notifications(await runContext(h, "B"))
    const fromBAgain = notifications(await runContext(h, "B"))
    expect(fromA).toHaveLength(1)
    expect(fromB).toHaveLength(1)
    expect(fromBAgain).toHaveLength(0)
    await h.cleanup()
  })
})
