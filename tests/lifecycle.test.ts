import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  makePlugin,
  runPrompt,
  runContext,
  notifications,
  notificationsFor,
  pokes,
  setConfigFixture,
  resetConfig,
  advance,
} from "./helpers"

describe("plugin lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setConfigFixture({ logging: { enabled: false } })
  })

  afterEach(() => {
    vi.useRealTimers()
    resetConfig()
  })

  it("registers prompt/context hooks and returns a cleanup", async () => {
    const h = await makePlugin()
    expect(typeof h.hooks.prompt).toBe("function")
    expect(typeof h.hooks.context).toBe("function")
    expect(typeof h.cleanup).toBe("function")
    await h.cleanup()
  })

  it("does not poke when a turn ends before any user message", async () => {
    const h = await makePlugin()
    await h.turnEnd("s1")
    await h.activity("s1")
    await advance(120_000)
    expect(pokes(h.calls)).toHaveLength(0)
    await h.cleanup()
  })

  it("sends one poke after user message + turn end", async () => {
    const h = await makePlugin()
    await runPrompt(h, "s1")
    await h.turnEnd("s1")
    await advance(60_000)
    const poke = pokes(h.calls)[0]
    expect(poke).toBeTruthy()
    expect(poke.sessionID).toBe("s1")
    expect(poke.text).toContain("have been silent for about 60 seconds")
    expect(poke.text).toContain("s1")
    await h.cleanup()
  })

  it("renders messageTemplate placeholders for seconds/sessionID/project", async () => {
    setConfigFixture({
      idleMs: 90_000,
      messageTemplate: "[T] {seconds}s {sessionID} {project}",
      logging: { enabled: false },
    })
    const h = await makePlugin("C:\\users\\demo\\proj")
    await runPrompt(h, "abc")
    await h.turnEnd("abc")
    await advance(90_000)
    const poke = pokes(h.calls)[0]
    expect(poke.text).toBe("[T] 90s abc C:\\users\\demo\\proj")
    await h.cleanup()
  })

  it("does not re-poke while pendingPoke is set", async () => {
    const h = await makePlugin()
    await runPrompt(h, "s1")
    await h.turnEnd("s1")
    await advance(60_000)
    expect(pokes(h.calls)).toHaveLength(1)
    await h.turnEnd("s1")
    await advance(120_000)
    expect(pokes(h.calls)).toHaveLength(1)
    await h.cleanup()
  })

  it("resets pendingPoke on the next real user message", async () => {
    const h = await makePlugin()
    await runPrompt(h, "s1")
    await h.turnEnd("s1")
    await advance(60_000)
    expect(pokes(h.calls)).toHaveLength(1)
    await runPrompt(h, "s1")
    await h.turnEnd("s1")
    await advance(60_000)
    expect(pokes(h.calls)).toHaveLength(2)
    await h.cleanup()
  })

  it("generation activity resets the idle clock instead of canceling it", async () => {
    const h = await makePlugin()
    await runPrompt(h, "s1")
    await h.turnEnd("s1")
    await advance(50_000)
    await h.activity("s1")
    await advance(50_000)
    expect(pokes(h.calls)).toHaveLength(0)
    await advance(10_000)
    expect(pokes(h.calls)).toHaveLength(1)
    await h.cleanup()
  })

  it("clears the idle timer on session.status busy", async () => {
    const h = await makePlugin()
    await runPrompt(h, "s1")
    await h.turnEnd("s1")
    await h.status("s1", "busy")
    await advance(120_000)
    expect(pokes(h.calls)).toHaveLength(0)
    await h.cleanup()
  })

  it("clears the idle timer on session.status retry", async () => {
    const h = await makePlugin()
    await runPrompt(h, "s1")
    await h.turnEnd("s1")
    await h.status("s1", "retry")
    await advance(120_000)
    expect(pokes(h.calls)).toHaveLength(0)
    await h.cleanup()
  })

  it("cleanup clears pending timers", async () => {
    const h = await makePlugin()
    await runPrompt(h, "s1")
    await h.turnEnd("s1")
    await h.cleanup()
    await advance(120_000)
    expect(pokes(h.calls)).toHaveLength(0)
  })

  it("context-only flow (synthetic-message equivalent) neither pokes nor injects notifications", async () => {
    const h = await makePlugin()
    const system = await runContext(h, "s1")
    // protocol 照常注入，但 prompt 钩子没跑过 → 无重启通知、未 engage
    expect(system.length).toBeGreaterThan(0)
    expect(notifications(system)).toHaveLength(0)
    await h.turnEnd("s1")
    await advance(120_000)
    expect(pokes(h.calls)).toHaveLength(0)
    await h.cleanup()
  })

  it("prompt and context hooks ignore predictor temp sessions (gate 1)", async () => {
    setConfigFixture({
      idleMs: 60_000,
      predictor: { enabled: true },
      logging: { enabled: false },
    })
    const h = await makePlugin()
    h.setContextData([{ type: "user", text: "question?" }])
    const gate = { promise: Promise.resolve({ text: "[Remind: 2 minutes]" }) }
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

    // 闸①：临时会话的 prompt 不做标题查询、不更新 lastActive
    const getBefore = h.calls.get.length
    await runPrompt(h, subID)
    expect(h.calls.get.length).toBe(getBefore)

    // 闸①：临时会话的 context 连 protocol 都不注入
    const subSystem = await runContext(h, subID)
    expect(subSystem).toHaveLength(0)

    release!()
    await advance(0)
    await h.cleanup()
  })

  it("ignored-title sessions do not clear timers, inject notifications, or become lastActive", async () => {
    setConfigFixture({ ignoreSessionTitles: ["opencode-mem capture"], logging: { enabled: false } })
    const h = await makePlugin()
    h.setTitle("sub-cap", "opencode-mem capture")
    await runPrompt(h, "s1")
    await h.turnEnd("s1")
    await runPrompt(h, "sub-cap")
    // V2 与 V1 不同：标题一律经 session.get 懒加载（不再有 session.updated 标题事件）
    expect(h.calls.get.map((c) => c.sessionID)).toContain("sub-cap")
    // 被忽略的会话不会挂上重启通知
    const subNotifs = await notificationsFor(h, "sub-cap")
    expect(subNotifs).toHaveLength(0)
    // lastActive 仍是 s1，s1 的计时器未被掐断
    await advance(60_000)
    const poke = pokes(h.calls)[0]
    expect(poke).toBeTruthy()
    expect(poke.sessionID).toBe("s1")
    await h.cleanup()
  })

  it("resolves titles via session.get on the first prompt and caches them", async () => {
    setConfigFixture({ ignoreSessionTitles: ["opencode-mem capture"], logging: { enabled: false } })
    const h = await makePlugin()
    h.setTitle("s2", "regular conversation")
    await runPrompt(h, "s2")
    expect(h.calls.get.map((c) => c.sessionID)).toContain("s2")
    const getCount = h.calls.get.length
    await runPrompt(h, "s2")
    expect(h.calls.get.length).toBe(getCount)
    await h.cleanup()
  })

  it("re-checks the cached title at onIdle so a renamed session is ignored", async () => {
    setConfigFixture({ ignoreSessionTitles: ["opencode-mem capture"], logging: { enabled: false } })
    const h = await makePlugin()
    await runPrompt(h, "s1") // 首次 get 查不到标题（会话刚建），不入缓存
    h.setTitle("s1", "opencode-mem capture") // 重命名
    await runPrompt(h, "s1") // 缓存未命中 → 再次 get → 命中黑名单
    await h.turnEnd("s1")
    await advance(120_000)
    expect(pokes(h.calls)).toHaveLength(0)
    await h.cleanup()
  })

  it("a non-matching title still behaves as a normal focus switch", async () => {
    setConfigFixture({ ignoreSessionTitles: ["opencode-mem capture"], logging: { enabled: false } })
    const h = await makePlugin()
    await runPrompt(h, "s1")
    await h.turnEnd("s1")
    h.setTitle("s2", "regular conversation")
    await runPrompt(h, "s2")
    await advance(120_000)
    expect(pokes(h.calls)).toHaveLength(0)
    await h.cleanup()
  })

  it("events from other directories are ignored", async () => {
    const h = await makePlugin()
    await runPrompt(h, "s1")
    h.emit("session.text.ended", { sessionID: "s1", text: "ok" }, "C:\\other\\dir")
    await advance(60_000)
    expect(pokes(h.calls)).toHaveLength(0)
    await h.turnEnd("s1")
    await advance(60_000)
    expect(pokes(h.calls)).toHaveLength(1)
    await h.cleanup()
  })
})
