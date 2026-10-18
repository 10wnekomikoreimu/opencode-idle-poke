import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { makePlugin, runPrompt, pokes, setConfigFixture, resetConfig, advance, deferred } from "./helpers"

describe("cross-session behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setConfigFixture({ logging: { enabled: false } })
  })

  afterEach(() => {
    vi.useRealTimers()
    resetConfig()
  })

  it("switching to another session clears the first session's timer", async () => {
    const h = await makePlugin()
    await runPrompt(h, "A")
    await h.turnEnd("A")
    await runPrompt(h, "B")
    await advance(120_000)
    expect(pokes(h.calls)).toHaveLength(0)
    await h.cleanup()
  })

  it("only the last-active session receives a poke", async () => {
    const h = await makePlugin()
    await runPrompt(h, "A")
    await h.turnEnd("A")
    await advance(60_000)
    expect(pokes(h.calls)).toHaveLength(1)
    expect(pokes(h.calls)[0].sessionID).toBe("A")
    await runPrompt(h, "B")
    await h.turnEnd("B")
    await advance(60_000)
    const all = pokes(h.calls)
    expect(all).toHaveLength(2)
    expect(all[1].sessionID).toBe("B")
    await h.cleanup()
  })

  it("a poke scheduled for a stale session is skipped if a predictor ran in between", async () => {
    setConfigFixture({
      idleMs: 60_000,
      predictor: { enabled: true },
      logging: { enabled: false },
    })
    const h = await makePlugin()
    h.setContextData([{ type: "user", text: "question?" }])
    const gate = deferred<{ text: string }>()
    let release: (() => void) | undefined
    h.setGenerateHandler(async () => {
      await new Promise<void>((res) => {
        release = res
      })
      return gate.promise
    })
    await runPrompt(h, "A")
    await h.turnEnd("A")
    await advance(60_000)
    expect(release).toBeDefined()

    // 预测器还挂在 generate 上时，用户切到了会话 B
    await runPrompt(h, "B")
    release!()
    await advance(0)
    await advance(120_000)
    expect(pokes(h.calls)).toHaveLength(0)
    await h.cleanup()
  })

  it("session.deleted clears the timer and removes the session state", async () => {
    const h = await makePlugin()
    await runPrompt(h, "A")
    await h.turnEnd("A")
    await h.deleted("A")
    await advance(120_000)
    expect(pokes(h.calls)).toHaveLength(0)
    // 状态已被删除：再次回合结束也不会重新武装计时器
    await h.turnEnd("A")
    await advance(120_000)
    expect(pokes(h.calls)).toHaveLength(0)
    await h.cleanup()
  })
})
