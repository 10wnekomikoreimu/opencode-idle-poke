import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  makePlugin,
  runPrompt,
  runContext,
  notifications,
  setConfigFixture,
  resetConfig,
  advance,
  deferred,
} from "./helpers"

describe("context hook (protocol injection)", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setConfigFixture({ logging: { enabled: false } })
  })

  afterEach(() => {
    vi.useRealTimers()
    resetConfig()
  })

  it("pushes the protocol with placeholder markers replaced", async () => {
    const h = await makePlugin()
    const system = await runContext(h, "s1")
    expect(system).toHaveLength(1)
    const text = system[0].text
    expect(text).toContain("[Poke Off]")
    expect(text).toContain("[Poke On]")
    expect(text).toContain("[Predictor Off]")
    expect(text).toContain("[Predictor On]")
    expect(text).toContain("[Remind: N unit]")
    await h.cleanup()
  })

  it("uses configured marker values", async () => {
    setConfigFixture({
      enableMarker: "[Resume]",
      disableMarker: "[Halt]",
      enablePredictorMarker: "[PredOn]",
      disablePredictorMarker: "[PredOff]",
      logging: { enabled: false },
    })
    const h = await makePlugin()
    const system = await runContext(h, "s1")
    expect(system[0].text).toContain("[Halt]")
    expect(system[0].text).toContain("[Resume]")
    expect(system[0].text).toContain("[PredOff]")
    expect(system[0].text).toContain("[PredOn]")
    await h.cleanup()
  })

  it("does not push protocol for predictor temp sessions", async () => {
    setConfigFixture({
      predictor: { enabled: true },
      idleMs: 60_000,
      logging: { enabled: false },
    })
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
    const subID = h.calls.create[0].id
    expect(release).toBeDefined()

    const subSystem = await runContext(h, subID)
    expect(subSystem).toHaveLength(0)

    release!()
    await advance(0)
    await h.cleanup()
  })

  it("ensures session state on context so markers apply without a prior message", async () => {
    const h = await makePlugin()
    await runContext(h, "s1") // 仅 context → 状态已建
    await h.turnEnd("s1", "[Poke Off]") // text.ended 找得到状态
    await runPrompt(h, "s1")
    const notifs = notifications(await runContext(h, "s1"))
    expect(notifs).toHaveLength(0)
    await h.cleanup()
  })
})
