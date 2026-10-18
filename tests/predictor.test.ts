import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  makePlugin,
  runPrompt,
  pokes,
  setConfigFixture,
  resetConfig,
  advance,
  deferred,
} from "./helpers"

describe("predictor", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setConfigFixture({ predictor: { enabled: true }, idleMs: 60_000, logging: { enabled: false } })
  })

  afterEach(() => {
    vi.useRealTimers()
    resetConfig()
  })

  it("skips prediction when disabled", async () => {
    setConfigFixture({ predictor: { enabled: false }, idleMs: 60_000, logging: { enabled: false } })
    const h = await makePlugin()
    h.setContextData([{ type: "user", text: "q" }])
    h.setGenerateHandler(async () => ({ text: "[Remind: 2 minutes]" }))
    await runPrompt(h, "s1")
    await h.turnEnd("s1")
    await advance(60_000)
    expect(h.calls.context).toHaveLength(0)
    expect(h.calls.create).toHaveLength(0)
    expect(pokes(h.calls)).toHaveLength(1)
    await h.cleanup()
  })

  it("skips prediction when there is no user-message excerpt", async () => {
    const h = await makePlugin()
    h.setContextData([
      { type: "assistant", text: "answer" },
      { type: "synthetic", text: "poke noise" },
    ])
    h.setGenerateHandler(async () => ({ text: "[Remind: 2 minutes]" }))
    await runPrompt(h, "s1")
    await h.turnEnd("s1")
    await advance(60_000)
    expect(h.calls.create).toHaveLength(0)
    expect(pokes(h.calls)).toHaveLength(1)
    await h.cleanup()
  })

  it("skips prediction when session.context returns a non-array", async () => {
    const h = await makePlugin()
    h.setContextData(null as unknown as unknown[])
    h.setGenerateHandler(async () => ({ text: "[Remind: 2 minutes]" }))
    await runPrompt(h, "s1")
    await h.turnEnd("s1")
    await advance(60_000)
    expect(h.calls.create).toHaveLength(0)
    const poke = pokes(h.calls)[0]
    expect(poke).toBeTruthy()
    expect(poke.text).toContain("about 60 seconds")
    await h.cleanup()
  })

  it("runs prediction, parses the marker, and updates the interval", async () => {
    const h = await makePlugin()
    h.setContextData([{ type: "user", text: "explain X" }])
    h.setGenerateHandler(async () => ({ text: "[Remind: 2 minutes]" }))
    await runPrompt(h, "s1")
    await h.turnEnd("s1")
    await advance(60_000)

    expect(h.calls.create).toHaveLength(1)
    expect(h.calls.create[0].model).toEqual({ providerID: "opencode", id: "big-pickle" })
    expect(h.calls.create[0].location?.directory).toBe("C:\\Users\\test\\proj")
    expect(h.calls.generate).toHaveLength(1)
    expect(h.calls.generate[0].sessionID).toBe(h.calls.create[0].id)
    expect(h.calls.generate[0].prompt).toContain("explain X")
    expect(h.calls.remove).toHaveLength(1)
    expect(h.calls.remove[0].sessionID).toBe(h.calls.create[0].id)
    const first = pokes(h.calls)[0]
    expect(first.text).toContain("about 60 seconds")

    // 第二回合：interval 已被预测为 120s
    await runPrompt(h, "s1")
    await h.turnEnd("s1")
    await advance(60_000)
    expect(pokes(h.calls)).toHaveLength(1)
    await advance(60_000)
    expect(pokes(h.calls)).toHaveLength(2)
    expect(pokes(h.calls)[1].text).toContain("about 120 seconds")
    await h.cleanup()
  })

  it("predictor.model override wins over the default model", async () => {
    setConfigFixture({
      predictor: { enabled: true, model: "openai/gpt-4o" },
      idleMs: 60_000,
      logging: { enabled: false },
    })
    const h = await makePlugin()
    h.setContextData([{ type: "user", text: "q" }])
    h.setGenerateHandler(async () => ({ text: "[Remind: 1 minutes]" }))
    await runPrompt(h, "s1")
    await h.turnEnd("s1")
    await advance(60_000)
    expect(h.calls.create).toHaveLength(1)
    expect(h.calls.create[0].model).toEqual({ providerID: "openai", id: "gpt-4o" })
    await h.cleanup()
  })

  it("invalid predictor.model format falls back to the default model", async () => {
    setConfigFixture({
      predictor: { enabled: true, model: "no-slash" },
      idleMs: 60_000,
      logging: { enabled: false },
    })
    const h = await makePlugin()
    h.setContextData([{ type: "user", text: "q" }])
    h.setGenerateHandler(async () => ({ text: "[Remind: 1 minutes]" }))
    await runPrompt(h, "s1")
    await h.turnEnd("s1")
    await advance(60_000)
    expect(h.calls.create).toHaveLength(1)
    expect(h.calls.create[0].model).toEqual({ providerID: "opencode", id: "big-pickle" })
    await h.cleanup()
  })

  it("generate receives only {sessionID, prompt} (no agent/tools/system fields)", async () => {
    const h = await makePlugin()
    h.setContextData([{ type: "user", text: "q" }])
    h.setGenerateHandler(async () => ({ text: "[Remind: 1 minutes]" }))
    await runPrompt(h, "s1")
    await h.turnEnd("s1")
    await advance(60_000)
    expect(h.calls.generate).toHaveLength(1)
    expect(Object.keys(h.calls.generate[0]).sort()).toEqual(["prompt", "sessionID"])
    await h.cleanup()
  })

  it("excludes synthetic context entries from the excerpt", async () => {
    const h = await makePlugin()
    h.setContextData([
      { type: "user", text: "real question" },
      { type: "synthetic", text: "synthetic noise" },
    ])
    h.setGenerateHandler(async () => ({ text: "[Remind: 2 minutes]" }))
    await runPrompt(h, "s1")
    await h.turnEnd("s1")
    await advance(60_000)
    const prompt = h.calls.generate[0].prompt
    expect(prompt).toContain("real question")
    expect(prompt).not.toContain("synthetic noise")
    await h.cleanup()
  })

  it("timeouts after timeoutMs and falls back to the fixed interval", async () => {
    const gate = deferred<{ text: string }>()
    const h = await makePlugin()
    h.setContextData([{ type: "user", text: "q" }])
    h.setGenerateHandler(() => gate.promise)
    await runPrompt(h, "s1")
    await h.turnEnd("s1")
    await advance(60_000)
    expect(h.calls.create).toHaveLength(1)
    await advance(15_000)
    expect(h.calls.remove).toHaveLength(1)
    const poke = pokes(h.calls)[0]
    expect(poke).toBeTruthy()
    expect(poke.text).toContain("about 60 seconds")
    await h.cleanup()
  })

  it("recovers when the predictor generate rejects", async () => {
    const h = await makePlugin()
    h.setContextData([{ type: "user", text: "q" }])
    h.setGenerateHandler(async () => {
      throw new Error("sub boom")
    })
    await runPrompt(h, "s1")
    await h.turnEnd("s1")
    await advance(60_000)
    expect(h.calls.create).toHaveLength(1)
    expect(h.calls.remove).toHaveLength(1)
    const poke = pokes(h.calls)[0]
    expect(poke).toBeTruthy()
    expect(poke.text).toContain("about 60 seconds")
    await h.cleanup()
  })

  it("resets pendingPoke after a failed poke so it can retry", async () => {
    setConfigFixture({ predictor: { enabled: false }, idleMs: 60_000, logging: { enabled: false } })
    const h = await makePlugin()
    let attempts = 0
    h.setSyntheticHandler(async () => {
      attempts++
      if (attempts === 1) throw new Error("main boom")
      return undefined
    })
    await runPrompt(h, "s1")
    await h.turnEnd("s1")
    await advance(60_000)
    expect(pokes(h.calls)).toHaveLength(1)
    await runPrompt(h, "s1")
    await h.turnEnd("s1")
    await advance(60_000)
    expect(pokes(h.calls)).toHaveLength(2)
    expect(attempts).toBe(2)
    await h.cleanup()
  })

  it("prompt hook ignores the predictor temp session while it is in flight", async () => {
    const h = await makePlugin()
    h.setContextData([{ type: "user", text: "q" }])
    const gate = deferred<{ text: string }>()
    let release: (() => void) | undefined
    h.setGenerateHandler(async () => {
      await new Promise<void>((res) => {
        release = res
      })
      return gate.promise
    })
    await runPrompt(h, "s1")
    await h.turnEnd("s1")
    await advance(60_000)
    expect(h.calls.create).toHaveLength(1)
    expect(release).toBeDefined()
    const subID = h.calls.create[0].id

    // 闸①：对临时会话的 prompt 不做任何处理（不查标题、不产生新的 generate）
    await runPrompt(h, subID)
    expect(h.calls.get.map((c) => c.sessionID)).not.toContain(subID)
    expect(h.calls.generate).toHaveLength(1)

    release!()
    await advance(0)
    await h.cleanup()
  })
})
