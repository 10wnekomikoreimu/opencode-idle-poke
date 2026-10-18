import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { makePlugin, runPrompt, pokes, setConfigFixture, resetConfig, advance, flush, deferred } from "./helpers"

// ---------------------------------------------------------------------------
// 阶段 3.5 集成语义（A1–A5 实测 2026-10-17，步骤 15.6）：
//   execution.started（无 location）→ 挂表 + wait 看门狗
//   execution.*.terminal（无 location）→ 武装空闲计时器
//   execActive 守卫下的活动/text.ended 仅作"执行状态未知"时的兜底
// ---------------------------------------------------------------------------

describe("execution.* signals + wait watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setConfigFixture({ idleMs: 60_000, logging: { enabled: false } })
  })

  afterEach(() => {
    vi.useRealTimers()
    resetConfig()
  })

  it("mid-turn activity and mid-turn text.ended never arm the timer; only the terminal does (A2 edge eliminated)", async () => {
    const h = await makePlugin()
    const w = deferred<unknown>()
    h.setWaitHandler(() => w.promise) // 看门狗保持挂起 = 回合仍在进行
    await runPrompt(h, "s1")
    await h.execStart("s1") // 回合开始（事件无 location，必须被处理 → 挂表）
    await h.turnEnd("s1") // 多步回合中间的 text.ended → 不武装（execActive 守卫）
    await h.activity("s1") // 长静默工具期间的活动 → 不武装
    await advance(180_000)
    expect(pokes(h.calls)).toHaveLength(0)
    await h.execEnd("s1") // 真正的回合结束 → 武装
    await advance(60_000)
    expect(pokes(h.calls)).toHaveLength(1)
    // 看门狗迟到返回：epoch 已被终态翻新 → 不重复武装
    w.resolve(undefined)
    await flush()
    await advance(120_000)
    expect(pokes(h.calls)).toHaveLength(1)
    await h.cleanup()
  })

  it("terminal kinds other than succeeded also arm the timer (A3), including terminal-without-started fallback", async () => {
    const h = await makePlugin()
    await runPrompt(h, "s1")
    await h.execEnd("s1", "interrupted", { reason: "user" }) // A3：中断终态；未见 started 也要能兜底武装
    await advance(60_000)
    expect(pokes(h.calls)).toHaveLength(1)
    await h.cleanup()
  })

  it("watchdog arms the timer when the terminal event never arrives (missed-terminal recovery)", async () => {
    const h = await makePlugin()
    const w = deferred<unknown>()
    h.setWaitHandler(() => w.promise)
    await runPrompt(h, "s1")
    await h.execStart("s1")
    expect(h.calls.wait).toHaveLength(1) // 看门狗：started 后挂 session.wait
    expect(h.calls.wait[0].sessionID).toBe("s1")
    await advance(600_000)
    expect(pokes(h.calls)).toHaveLength(0) // 终态事件一直没来 → 靠看门狗
    w.resolve(undefined) // wait 返回 = 回合确已结束（A4/A5 语义）→ 兜底武装
    await flush()
    await advance(60_000)
    expect(pokes(h.calls)).toHaveLength(1)
    await h.cleanup()
  })

  it("a watchdog resolution is superseded by a newer turn (never arms during the new turn)", async () => {
    const h = await makePlugin()
    const w1 = deferred<unknown>()
    const w2 = deferred<unknown>()
    const waits = [w1, w2]
    h.setWaitHandler(() => waits.shift()!.promise)
    await runPrompt(h, "s1")
    await h.execStart("s1") // 回合 1 → 看门狗 1
    await h.execEnd("s1") // 回合 1 结束 → 武装 60s
    await h.execStart("s1") // 回合 2 立即开始 → 挂表（清掉旧计时器）
    w1.resolve(undefined) // 看门狗 1 迟到返回：epoch 已翻新 → 忽略
    await flush()
    await advance(60_000)
    expect(pokes(h.calls)).toHaveLength(0) // 回合 2 进行中绝无中途搭话
    w2.resolve(undefined) // 回合 2 的看门狗返回 → 武装
    await flush()
    await advance(60_000)
    expect(pokes(h.calls)).toHaveLength(1)
    await h.cleanup()
  })

  it("execution events of other sessions never touch this instance's timer or watchdog", async () => {
    const h = await makePlugin()
    await runPrompt(h, "s1")
    await h.execStart("other") // 无 location 的外来会话事件：只记状态
    await h.execEnd("other")
    await advance(180_000)
    expect(pokes(h.calls)).toHaveLength(0)
    expect(h.calls.wait).toHaveLength(0) // 也没给非活跃会话挂看门狗
    // 本会话信号照常工作
    await h.execStart("s1")
    await h.execEnd("s1")
    await advance(60_000)
    expect(pokes(h.calls)).toHaveLength(1)
    await h.cleanup()
  })
})
