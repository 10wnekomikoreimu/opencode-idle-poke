import { Plugin } from "@opencode/plugin"
import { appendFile, mkdir, readFile, rm, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, resolve } from "node:path"

const VERSION = "1.0.0"

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const
type LogLevel = keyof typeof LOG_LEVELS

/** predictor 临时会话的默认模型（config.predictor.model 为空时使用） */
const PREDICTOR_DEFAULT_MODEL = "opencode/big-pickle"

const DEFAULTS = {
  idleMs: 60_000,
  requireEngagement: true,
  enabled: true,
  messageTemplate:
    "[Idle reminder] Automatic idle notice - not a new task: you have been silent for about {seconds} seconds in session {project} ({sessionID}) - the current active idle-poke interval. " +
    "For this message only:\n" +
    "1. Your entire reply must be 1-3 sentences and must end with a question addressed to the user.\n" +
    "2. If earlier work was interrupted or left unfinished, do NOT continue or complete it in this reply - first ask the user whether to continue.\n" +
    "3. Do not output any work product in this reply (no article content, no code).\n" +
    "4. Do NOT read or modify any files, and do NOT run any commands or tools; respond based on the existing conversation only.\n" +
    "5. Reply in the same language the user has been using.\n" +
    "Do not act on any earlier instruction until the user answers this check-in.",
  enableMarker: "[Poke On]",
  disableMarker: "[Poke Off]",
  enablePredictorMarker: "[Predictor On]",
  disablePredictorMarker: "[Predictor Off]",
  protocol:
    "If the user asks to stop the proactive idle-poke, write exactly '{disableMarker}' as the first line of your reply; " +
    "if they ask to resume it, write '{enableMarker}' as the first line. " +
    "If the user asks to adjust the reminder interval (e.g. 'remind me again in 5 minutes'), write exactly '[Remind: N unit]' as the first line, " +
    "where N is a number and unit can be seconds/minutes/hours (or s/m/h; omitted means seconds). " +
    "If the user asks to disable or enable the model-predicted interval, write '{disablePredictorMarker}'/'{enablePredictorMarker}' as the first line. " +
    "Reply in the same language the user is using, then answer normally. " +
    "Important: the marker IS the action - never tell the user that a setting has changed unless you actually wrote the corresponding marker " +
    "as the first line of this same reply; if you are unsure whether the user's request refers to this idle-poke plugin, " +
    "ask a clarifying question instead of claiming success.",
  restartNotification:
    "[System notification] opencode-idle-poke plugin restarted; poke settings have been reset to defaults " +
    "(poke {enabled}, interval {interval}s, model-predicted interval {predictor}).",
  predictor: {
    enabled: false,
    maxMessages: 6,
    model: "",
    timeoutMs: 15_000,
    prompt:
      "Assess the complexity of the conversation excerpt below and output the reminder-interval marker. " +
      "Output exactly one line: [Remind: N unit], where N is a number and unit can be seconds/minutes/hours (or s/m/h). " +
      "Suggested tiers: simple (Q&A / chit-chat) -> 3 minutes; medium (typical dev questions) -> 10 minutes; complex (architecture / refactor / large change) -> 30 minutes. " +
      "For this assessment, do NOT read or modify any files, and do NOT run any commands or tools; judge based on the excerpt only.",
  },
  ignoreSessionTitles: [] as string[],
  logging: {
    enabled: true,
    level: "info" as LogLevel,
    file: "logs/opencode-idle-poke.log",
  },
}

const MIN_DELAY_MS = 20_000
const MAX_DELAY_MS = 86_400_000
const MAX_LOG_BYTES = 10 * 1024 * 1024
const DELAY_MARKER_RE =
  /^[〔\[](?:Remind(?:er)?|提醒间隔)\s*[=＝：:]\s*(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|秒|分钟|小时)?[〕\]]$/i

/** V2 生成活动信号（替代 V1 的 session.status busy）：任意匹配事件 → 重置空闲时钟（onIdle） */
const ACTIVITY_EVENT_RE = /^session\.(text\.(started|delta)|reasoning\.|step\.|tool\.)/

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise((resolvePromise, reject) => {
    const t = setTimeout(() => reject(new Error(`predictor timed out after ${ms}ms`)), ms)
    promise.then(
      (v) => {
        clearTimeout(t)
        resolvePromise(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      }
    )
  })

function delayMarkerMs(value: number, unit?: string): number | undefined {
  const u = (unit ?? "s").toLowerCase()
  let ms: number
  if (u === "秒" || u.startsWith("s")) ms = value * 1000
  else if (u === "分钟" || u.startsWith("m")) ms = value * 60_000
  else if (u === "小时" || u.startsWith("h")) ms = value * 3_600_000
  else return undefined
  return Number.isFinite(ms) && ms >= MIN_DELAY_MS && ms <= MAX_DELAY_MS ? ms : undefined
}

type Config = typeof DEFAULTS

type SessionState = {
  enabled: boolean
  engaged: boolean
  pendingPoke: boolean
  predictorEnabled: boolean
  timer?: ReturnType<typeof setTimeout>
  delayMs?: number
  dirty?: boolean
  notificationInjected?: boolean
  pendingRestartNotification?: boolean
}

function toConfig(raw: unknown): Config {
  const config = {
    ...DEFAULTS,
    logging: { ...DEFAULTS.logging },
    predictor: { ...DEFAULTS.predictor },
  }
  if (typeof raw !== "object" || raw === null) return config
  const r = raw as Record<string, unknown>
  if (typeof r.idleMs === "number" && Number.isFinite(r.idleMs) && r.idleMs > 0) config.idleMs = r.idleMs
  if (typeof r.requireEngagement === "boolean") config.requireEngagement = r.requireEngagement
  if (typeof r.enabled === "boolean") config.enabled = r.enabled
  if (typeof r.messageTemplate === "string" && r.messageTemplate.trim()) config.messageTemplate = r.messageTemplate
  if (typeof r.enableMarker === "string" && r.enableMarker.trim()) config.enableMarker = r.enableMarker
  if (typeof r.disableMarker === "string" && r.disableMarker.trim()) config.disableMarker = r.disableMarker
  if (typeof r.enablePredictorMarker === "string" && r.enablePredictorMarker.trim())
    config.enablePredictorMarker = r.enablePredictorMarker
  if (typeof r.disablePredictorMarker === "string" && r.disablePredictorMarker.trim())
    config.disablePredictorMarker = r.disablePredictorMarker
  if (typeof r.protocol === "string" && r.protocol.trim()) config.protocol = r.protocol
  if (typeof r.restartNotification === "string" && r.restartNotification.trim())
    config.restartNotification = r.restartNotification
  const p = (r.predictor ?? {}) as Record<string, unknown>
  if (typeof p.enabled === "boolean") config.predictor.enabled = p.enabled
  if (typeof p.maxMessages === "number" && Number.isFinite(p.maxMessages) && p.maxMessages > 0)
    config.predictor.maxMessages = Math.floor(p.maxMessages)
  if (typeof p.model === "string") config.predictor.model = p.model
  if (typeof p.timeoutMs === "number" && Number.isFinite(p.timeoutMs) && p.timeoutMs > 0)
    config.predictor.timeoutMs = p.timeoutMs
  if (typeof p.prompt === "string" && p.prompt.trim()) config.predictor.prompt = p.prompt
  // P5 已删除 predictor.agent / predictor.denyTools：存在也忽略
  if (Array.isArray(r.ignoreSessionTitles)) {
    config.ignoreSessionTitles = r.ignoreSessionTitles.filter(
      (s): s is string => typeof s === "string" && s.trim() !== ""
    )
  }
  const l = (r.logging ?? {}) as Record<string, unknown>
  if (typeof l.enabled === "boolean") config.logging.enabled = l.enabled
  if (typeof l.level === "string" && l.level in LOG_LEVELS) config.logging.level = l.level as LogLevel
  if (typeof l.file === "string") config.logging.file = l.file
  return config
}

function opencodeConfigDir(): string {
  const override = process.env.OPENCODE_CONFIG_DIR
  if (override) return override
  const base = process.env.XDG_CONFIG_HOME || resolve(homedir(), ".config")
  return resolve(base, "opencode")
}

async function loadConfig(options: unknown): Promise<{ config: Config; error?: string }> {
  // V2: ctx.options 恒为对象；非空才生效（目录自动发现的插件 options 为空 → 走文件）
  if (options && typeof options === "object" && Object.keys(options as object).length > 0) {
    return { config: toConfig(options) }
  }
  try {
    const file = resolve(opencodeConfigDir(), "opencode-idle-poke.json")
    const raw: unknown = JSON.parse(await readFile(file, "utf8"))
    return { config: toConfig(raw) }
  } catch (e) {
    return {
      config: toConfig(undefined),
      error: e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT"
        ? undefined
        : e instanceof Error
          ? e.message
          : String(e),
    }
  }
}

function splitModelRef(raw: string): { providerID: string; id: string } {
  const idx = raw.indexOf("/")
  if (idx > 0 && idx < raw.length - 1) {
    return { providerID: raw.slice(0, idx), id: raw.slice(idx + 1) }
  }
  const dIdx = PREDICTOR_DEFAULT_MODEL.indexOf("/")
  return { providerID: PREDICTOR_DEFAULT_MODEL.slice(0, dIdx), id: PREDICTOR_DEFAULT_MODEL.slice(dIdx + 1) }
}

export const OpencodeIdlePokePlugin = Plugin.define({
  id: "opencode-idle-poke",
  async setup(ctx) {
    const project = String(ctx.location?.directory ?? "")
    const configDir = opencodeConfigDir()
    const loaded = await loadConfig(ctx.options)
    const config = loaded.config

    let logQueue: Promise<void> = Promise.resolve()
    const log = (level: LogLevel, message: string, extra?: Record<string, unknown>) => {
      const lg = config.logging
      if (!lg.enabled) return
      if (LOG_LEVELS[level] < LOG_LEVELS[lg.level]) return
      const file = lg.file.trim()
      if (!file) return
      const target = isAbsolute(file) ? file : resolve(configDir, file)
      const line =
        `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}` +
        (extra ? " " + JSON.stringify(extra) : "") +
        "\n"
      logQueue = logQueue.then(async () => {
        try {
          await mkdir(dirname(target), { recursive: true })
          const st = await stat(target).catch(() => undefined)
          if (st && st.size > MAX_LOG_BYTES) await rm(target, { force: true })
          await appendFile(target, line, "utf8")
        } catch {
          /* 日志失败不能影响宿主 */
        }
      })
    }

    if (loaded.error) log("warn", "config load failed, using defaults", { error: loaded.error })
    log("info", "plugin initialized", {
      version: VERSION,
      project,
      idleMs: config.idleMs,
      requireEngagement: config.requireEngagement,
      enabled: config.enabled,
      predictorEnabled: config.predictor.enabled,
      loggingLevel: config.logging.level,
      logFile: config.logging.file,
    })

    const sessions = new Map<string, SessionState>()
    const sessionTitles = new Map<string, string>()
    /** predictor 临时会话（闸①白名单） */
    const tempSessions = new Set<string>()
    let lastActive = ""
    /**
     * 执行回合状态（步骤 15.6 集成，A1–A5 实测 2026-10-17）：
     * active = 该会话是否有回合在跑；epoch = 世代号，看门狗回调用它识别"自己盯的那回合"是否已被更新的事件取代。
     * 单独成表（不进 SessionState）：execution 事件无 location，可能先于任何懒加载到达。
     */
    const execStates = new Map<string, { active: boolean; epoch: number }>()
    let disposed = false

    const ensure = (sessionID: string): SessionState => {
      let s = sessions.get(sessionID)
      if (!s) {
        s = {
          enabled: config.enabled,
          engaged: false,
          pendingPoke: false,
          predictorEnabled: config.predictor.enabled,
        }
        sessions.set(sessionID, s)
        log("debug", "session tracked", { sessionID })
      }
      return s
    }

    const clearTimer = (sessionID: string) => {
      const s = sessions.get(sessionID)
      if (s?.timer) {
        clearTimeout(s.timer)
        s.timer = undefined
      }
    }

    const isIgnored = (sessionID: string): boolean => {
      const title = sessionTitles.get(sessionID)
      if (title === undefined) return false
      if (config.ignoreSessionTitles.includes(title)) {
        log("debug", "session ignored (title match)", { sessionID, title })
        return true
      }
      return false
    }

    // 空闲计时武装点（步骤 15.6 后的信号体系，A1–A5 实测）：
    //   主信号 = session.execution.* 终态（严格晚于所有尾部事件，A1 验证成对性/时序）；
    //   兜底   = 回合结束（text.ended）/生成活动——仅在"执行状态未知"时按安静逻辑武装（老服务器/事件丢失）；
    //   看门狗 = session.wait 返回（终态事件丢失时兜底武装，epoch 防误伤新回合）。
    // 语义仍是"重置空闲时钟"，但 execActive 守卫保证：已知回合进行中绝不武装——
    // 长静默工具中途搭话的隐患从根上消除（A2 实测工具期间无终态事件）。
    const onIdle = (sessionID: string, source: string) => {
      // source = 武装来源标签；成功打 "idle timer set {source}"，被闸挡下打 "arm skipped {source, reason}"
      // reason：pending-poke（防刷屏闸）/ disabled / no-engagement / ignored-session / not-last-active
      // "not-last-active" 是他人会话的常规分流，保持静默防止非活跃会话事件刷屏
      let reason: string | undefined
      if (sessionID !== lastActive) reason = "not-last-active"
      else if (isIgnored(sessionID)) reason = "ignored-session"
      else {
        const s = ensure(sessionID)
        if (config.requireEngagement && !s.engaged) reason = "no-engagement"
        else if (!s.enabled) reason = "disabled"
        else if (s.pendingPoke) reason = "pending-poke"
        else {
          clearTimer(sessionID)
          const delay = s.delayMs ?? config.idleMs
          s.timer = setTimeout(() => void poke(sessionID), delay)
          log("debug", "idle timer set", { sessionID, delayMs: delay, source })
        }
      }
      if (reason && reason !== "not-last-active") log("debug", "arm skipped", { sessionID, source, reason })
    }

    const bumpExec = (sessionID: string, active: boolean) => {
      let st = execStates.get(sessionID)
      if (!st) {
        st = { active: false, epoch: 0 }
        execStates.set(sessionID, st)
      }
      st.active = active
      st.epoch++
      return st
    }

    // wait 看门狗：exec.started 后挂 session.wait，正常在终态同刻返回（A5 实测）；
    // 若终态事件丢失，wait 返回时兜底武装。epoch 世代号保证：只有"仍是最新的那一回合"才生效。
    const armWatchdog = (sessionID: string, epoch: number) => {
      let p: Promise<void>
      try {
        p = ctx.session.wait({ sessionID })
      } catch (e) {
        log("debug", "watchdog wait failed", { sessionID, error: e instanceof Error ? e.message : String(e) })
        return
      }
      void p.then(
        () => {
          if (disposed) return
          const cur = execStates.get(sessionID)
          if (!cur || cur.epoch !== epoch) return // 终态已处理，或状态已翻新（新回合/已删除）
          cur.active = false
          log("debug", "watchdog: terminal event missed", { sessionID })
          onIdle(sessionID, "watchdog")
        },
        (e) => {
          if (!disposed) log("debug", "watchdog wait failed", { sessionID, error: e instanceof Error ? e.message : String(e) })
        }
      )
    }

    // session.execution.*：回合开始/结束的权威信号（无 location，按 sessionID + lastActive 收口）
    const handleExecution = (type: string, sessionID: string): void => {
      if (tempSessions.has(sessionID)) return // predictor 临时会话不参与
      const started = type === "session.execution.started"
      const st = bumpExec(sessionID, started)
      if (sessionID !== lastActive) return // 只跟踪状态，不动计时器
      if (started) {
        clearTimer(sessionID) // 回合进行中绝不武装（A2：工具静默期与回合内 text.ended 都被 execActive 挡下）
        log("debug", "execution started, timer held", { sessionID })
        armWatchdog(sessionID, st.epoch)
      } else {
        log("debug", "execution ended", {
          sessionID,
          kind: type.slice("session.execution.".length),
        })
        onIdle(sessionID, "execution-terminal")
      }
    }

    const buildExcerpt = async (sessionID: string): Promise<string | undefined> => {
      try {
        const msgs = await ctx.session.context({ sessionID })
        if (!Array.isArray(msgs)) return undefined
        const texts = (msgs as Array<{ type?: string; text?: unknown }>)
          .filter((m) => m.type === "user" && typeof m.text === "string")
          .map((m) => m.text as string)
        if (!texts.length) return undefined
        return texts.slice(-config.predictor.maxMessages).join("\n\n")
      } catch {
        return undefined
      }
    }

    const predictInterval = async (sessionID: string): Promise<void> => {
      const s = sessions.get(sessionID)
      if (!s || !s.predictorEnabled) return
      const pred = config.predictor
      const excerpt = await buildExcerpt(sessionID)
      if (!excerpt) {
        log("debug", "predictor skipped (empty excerpt)", { sessionID })
        return
      }
      let subID = ""
      try {
        // 方案③改良版：临时会话指定模型 → generate 取回复 → finally 删除
        const created = await ctx.session.create({
          title: "idle-poke predictor",
          model: splitModelRef(pred.model.trim() || PREDICTOR_DEFAULT_MODEL),
          location: { directory: project },
        })
        subID = created.id
        tempSessions.add(subID)
        const input = pred.prompt + "\n\n--- Conversation excerpt ---\n" + excerpt
        const res = await withTimeout(
          ctx.session.generate({ sessionID: subID, prompt: input }),
          pred.timeoutMs
        )
        const reply = (res?.text ?? "").trim()
        const line = reply
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l.match(DELAY_MARKER_RE))
        const m = line ? line.match(DELAY_MARKER_RE) : null
        if (m) {
          const ms = delayMarkerMs(Number(m[1]), m[2])
          if (ms !== undefined) {
            s.delayMs = ms
            log("info", "predictor: interval updated", { sessionID, delayMs: ms })
          } else {
            log("debug", "predictor: out of range", { sessionID, ms })
          }
        } else {
          log("debug", "predictor: no valid marker", { sessionID, reply: reply.slice(0, 200) })
        }
      } catch (e) {
        log("warn", "predictor failed", { sessionID, error: e instanceof Error ? e.message : String(e) })
      } finally {
        if (subID) {
          tempSessions.delete(subID)
          sessions.delete(subID)
          void ctx.session.remove({ sessionID: subID }).catch(() => undefined)
        }
      }
    }

    const poke = async (sessionID: string) => {
      const s = sessions.get(sessionID)
      log("debug", "poke callback entered", {
        sessionID,
        lastActive,
        hasState: !!s,
        enabled: s?.enabled,
        pendingPoke: s?.pendingPoke,
        engaged: s?.engaged,
      })
      if (!s) return
      s.timer = undefined
      if (sessionID !== lastActive) {
        log("debug", "stale poke skipped", { sessionID, lastActive })
        return
      }
      if (!s.enabled || s.pendingPoke) {
        log("debug", "poke skipped (gates)", { sessionID, enabled: s.enabled, pendingPoke: s.pendingPoke })
        return
      }
      s.pendingPoke = true
      const pokeMs = s.delayMs ?? config.idleMs
      try {
        if (s.predictorEnabled) {
          await predictInterval(sessionID)
          if (sessionID !== lastActive || !s.pendingPoke || !s.enabled) {
            if (sessionID !== lastActive) s.pendingPoke = false
            return
          }
        }
        const text = config.messageTemplate
          .replaceAll("{seconds}", String(Math.round(pokeMs / 1000)))
          .replaceAll("{sessionID}", sessionID)
          .replaceAll("{project}", project)
        await ctx.session.synthetic({ sessionID, text })
        log("info", "poke sent", { sessionID, delayMs: pokeMs })
      } catch (e) {
        s.pendingPoke = false
        log("error", "poke failed", { sessionID, error: e instanceof Error ? e.message : String(e) })
      }
    }

    const buildProtocol = () =>
      config.protocol
        .replaceAll("{disableMarker}", config.disableMarker)
        .replaceAll("{enableMarker}", config.enableMarker)
        .replaceAll("{disablePredictorMarker}", config.disablePredictorMarker)
        .replaceAll("{enablePredictorMarker}", config.enablePredictorMarker)

    const buildRestartNotification = () =>
      config.restartNotification
        .replaceAll("{enabled}", config.enabled ? "on" : "off")
        .replaceAll("{interval}", String(config.idleMs / 1000))
        .replaceAll("{predictor}", config.predictor.enabled ? "on" : "off")

    const handleEvent = (raw: unknown): void => {
      const ev = raw as {
        type?: string
        location?: { directory?: string } | null
        data?: unknown
      }
      const type = ev.type ?? ""
      // session.execution.* 不带 location（§3.8 / A1–A5 实测）→ 提到 location 过滤之前处理
      if (type.startsWith("session.execution.")) {
        const d = ev.data as { sessionID?: string } | undefined
        if (d?.sessionID) handleExecution(type, d.sessionID)
        return
      }
      if (ev.location?.directory !== project) return
      const data = ev.data as { sessionID?: string; status?: { type?: string }; text?: string } | undefined
      const sid = data?.sessionID
      if (type === "session.status") {
        if (!sid || !data?.status?.type) return
        log("debug", "session.status", { sessionID: sid, status: data.status.type })
        if (data.status.type === "busy" || data.status.type === "retry") clearTimer(sid)
        else if (data.status.type === "idle") onIdle(sid, "status-idle")
      } else if (type === "session.idle") {
        // V2 备用空闲信号（实测中未见发出，防御性保留）
        if (sid) onIdle(sid, "idle-event")
      } else if (ACTIVITY_EVENT_RE.test(type)) {
        // 已知回合进行中 → 不武装（计时器已由 execution.started 清空）；
        // 执行状态未知（老服务器/事件丢失）→ 兜底重置空闲时钟（V2 移植时的安静逻辑）。
        if (sid && execStates.get(sid)?.active) return
        if (sid) onIdle(sid, "activity-fallback")
      } else if (type === "session.deleted") {
        const d = ev.data as { sessionID?: string } | undefined
        if (!d?.sessionID) return
        clearTimer(d.sessionID)
        sessions.delete(d.sessionID)
        sessionTitles.delete(d.sessionID)
        tempSessions.delete(d.sessionID)
        execStates.delete(d.sessionID)
        log("debug", "session deleted", { sessionID: d.sessionID })
      } else if (type === "session.text.ended") {
        const d = ev.data as { sessionID?: string; text?: string } | undefined
        if (!d?.sessionID || typeof d.text !== "string") return
        if (tempSessions.has(d.sessionID)) return
        const s = sessions.get(d.sessionID)
        if (!s) return
        const sessionID = d.sessionID
        const lines = d.text
          .trim()
          .split("\n")
          .slice(0, 5)
          .map((l) => l.trim())
        log("debug", "text ended", { sessionID, lines })
        const hasDisable = lines.includes(config.disableMarker)
        const hasEnable = lines.includes(config.enableMarker)
        const hasDisablePredictor = lines.includes(config.disablePredictorMarker)
        const hasEnablePredictor = lines.includes(config.enablePredictorMarker)
        let anyMarker = false
        if (hasDisable) {
          s.enabled = false
          log("info", "marker: disabled", { sessionID })
          anyMarker = true
        } else if (hasEnable) {
          s.enabled = true
          log("info", "marker: enabled", { sessionID })
          anyMarker = true
        }
        if (hasDisablePredictor) {
          s.predictorEnabled = false
          log("info", "marker: predictor disabled", { sessionID })
          anyMarker = true
        } else if (hasEnablePredictor) {
          s.predictorEnabled = true
          log("info", "marker: predictor enabled", { sessionID })
          anyMarker = true
        }
        for (const line of lines) {
          if (line === config.disableMarker || line === config.enableMarker) continue
          const m = line.match(DELAY_MARKER_RE)
          if (m) {
            const ms = delayMarkerMs(Number(m[1]), m[2])
            if (ms !== undefined) {
              s.delayMs = ms
              log("info", "marker: delay", { sessionID, ms })
              anyMarker = true
            }
          }
        }
        if (anyMarker) s.dirty = true
        // 武装空闲计时器：已知回合进行中（多步回合的中间 text.ended）→ 交给 execution 终态统一武装；
        // 执行状态未知 → 兜底武装（保持 V1 移植时的安静逻辑）
        if (execStates.get(sessionID)?.active) {
          log("debug", "text ended mid-execution, arming deferred to terminal", { sessionID })
        } else {
          onIdle(sessionID, "text-ended")
        }
      }
    }

    // 事件流（全局订阅 → 按 location 归属过滤）
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            handleEvent(event)
          } catch (e) {
            log("error", "event handler failed", {
              error: e instanceof Error ? e.message : String(e),
            })
          }
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          log("warn", "event stream closed", { error: e instanceof Error ? e.message : String(e) })
        }
      }
    })()

    // prompt 钩子（三道闸，§5.5）
    const regs: Array<{ dispose: () => Promise<void> }> = []
    regs.push(
      await ctx.session.hook("prompt", async (input) => {
        const sessionID = String(input.sessionID)
        if (tempSessions.has(sessionID)) return // 闸①：predictor 临时会话
        if (sessionTitles.get(sessionID) === undefined) {
          // 闸②：标题黑名单（懒加载 + 缓存；在更新 lastActive/清计时器之前）
          try {
            const info = await ctx.session.get({ sessionID: input.sessionID })
            if (info?.title) sessionTitles.set(sessionID, info.title)
          } catch {
            /* 查不到标题不拦路，保持 V1 语义 */
          }
        }
        if (isIgnored(sessionID)) return
        const s = ensure(sessionID)
        if (!s.dirty && !s.notificationInjected) {
          s.notificationInjected = true
          s.pendingRestartNotification = true
        }
        s.engaged = true
        s.pendingPoke = false
        lastActive = sessionID
        clearTimer(sessionID)
        for (const [id, st] of sessions) {
          if (id !== sessionID && st.timer) {
            clearTimeout(st.timer)
            st.timer = undefined
            log("debug", "timer cleared (session switched)", { sessionID: id })
          }
        }
        log("debug", "user message", { sessionID })
      })
    )

    // context 钩子：注入 protocol（每回合）+ 重启通知（一次性，方案 B）
    regs.push(
      await ctx.session.hook("context", async (input) => {
        const sessionID = String(input.sessionID ?? "")
        if (!sessionID) return
        if (tempSessions.has(sessionID)) return
        const s = ensure(sessionID)
        input.system.push({ type: "text", text: buildProtocol() })
        if (s.pendingRestartNotification) {
          s.pendingRestartNotification = false
          input.system.push({ type: "text", text: buildRestartNotification() })
          log("info", "restart notification injected", { sessionID })
        }
      })
    )

    return async () => {
      disposed = true
      controller.abort()
      for (const s of sessions.values()) {
        if (s.timer) {
          clearTimeout(s.timer)
          s.timer = undefined
        }
      }
      for (const r of regs) {
        try {
          await r.dispose()
        } catch {
          /* 清理失败不阻塞卸载 */
        }
      }
      log("debug", "plugin disposed", {})
      await logQueue
    }
  },
})

export default OpencodeIdlePokePlugin
