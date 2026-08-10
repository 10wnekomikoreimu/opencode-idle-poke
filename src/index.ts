import type { Plugin, PluginOptions } from "@opencode-ai/plugin"
import type { Part } from "@opencode-ai/sdk"
import { appendFile, mkdir, readFile, rm, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, resolve } from "node:path"

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const
type LogLevel = keyof typeof LOG_LEVELS

const DEFAULTS = {
  idleMs: 60_000,
  requireEngagement: true,
  enabled: true,
  messageTemplate:
    "[Idle reminder] You have been silent for about {seconds} seconds in session {project} ({sessionID}) - the current active idle-poke interval. " +
    "If there is unfinished work, pending questions, or anything worth discussing, proactively ask the user; otherwise just briefly say you are waiting and do not spam. " +
    "For this reply, do NOT read or modify any files, and do NOT run any commands or tools; respond based on the existing conversation only. " +
    "Reply in the same language the user has been using. After this, follow the user's instructions normally.",
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
    "Reply in the same language the user is using, then answer normally.",
  restartNotification:
    "[System notification] opencode-idle-poke plugin restarted; poke settings have been reset to defaults " +
    "(poke {enabled}, interval {interval}s, model-predicted interval {predictor}).",
  predictor: {
    enabled: false,
    maxMessages: 6,
    agent: "",
    model: "",
    timeoutMs: 15_000,
    prompt:
      "Assess the complexity of the conversation excerpt below and output the reminder-interval marker. " +
      "Output exactly one line: [Remind: N unit], where N is a number and unit can be seconds/minutes/hours (or s/m/h). " +
      "Suggested tiers: simple (Q&A / chit-chat) -> 3 minutes; medium (typical dev questions) -> 10 minutes; complex (architecture / refactor / large change) -> 30 minutes. " +
      "For this assessment, do NOT read or modify any files, and do NOT run any commands or tools; judge based on the excerpt only.",
    denyTools: [
      "read",
      "edit",
      "bash",
      "glob",
      "grep",
      "webfetch",
      "websearch",
      "task",
      "todowrite",
      "skill",
      "mcp__*",
    ],
  },
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

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`predictor timed out after ${ms}ms`)), ms)
    promise.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
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
  agent?: string
  model?: { providerID: string; modelID: string }
  dirty?: boolean
  notificationInjected?: boolean
}

function toConfig(raw: unknown): Config {
  const config = {
    ...DEFAULTS,
    logging: { ...DEFAULTS.logging },
    predictor: { ...DEFAULTS.predictor, denyTools: [...DEFAULTS.predictor.denyTools] },
  }
  if (typeof raw !== "object" || raw === null) return config
  const r = raw as Record<string, unknown>
  if (typeof r.idleMs === "number" && Number.isFinite(r.idleMs) && r.idleMs > 0) config.idleMs = r.idleMs
  if (typeof r.requireEngagement === "boolean") config.requireEngagement = r.requireEngagement
  if (typeof r.enabled === "boolean") config.enabled = r.enabled
  if (typeof r.messageTemplate === "string" && r.messageTemplate.trim()) config.messageTemplate = r.messageTemplate
  if (typeof r.enableMarker === "string" && r.enableMarker.trim()) config.enableMarker = r.enableMarker
  if (typeof r.disableMarker === "string" && r.disableMarker.trim()) config.disableMarker = r.disableMarker
  if (typeof r.enablePredictorMarker === "string" && r.enablePredictorMarker.trim()) config.enablePredictorMarker = r.enablePredictorMarker
  if (typeof r.disablePredictorMarker === "string" && r.disablePredictorMarker.trim()) config.disablePredictorMarker = r.disablePredictorMarker
  if (typeof r.protocol === "string" && r.protocol.trim()) config.protocol = r.protocol
  if (typeof r.restartNotification === "string" && r.restartNotification.trim()) config.restartNotification = r.restartNotification
  const p = (r.predictor ?? {}) as Record<string, unknown>
  if (typeof p.enabled === "boolean") config.predictor.enabled = p.enabled
  if (typeof p.maxMessages === "number" && Number.isFinite(p.maxMessages) && p.maxMessages > 0) config.predictor.maxMessages = Math.floor(p.maxMessages)
  if (typeof p.agent === "string") config.predictor.agent = p.agent
  if (typeof p.model === "string") config.predictor.model = p.model
  if (typeof p.timeoutMs === "number" && Number.isFinite(p.timeoutMs) && p.timeoutMs > 0) config.predictor.timeoutMs = p.timeoutMs
  if (typeof p.prompt === "string" && p.prompt.trim()) config.predictor.prompt = p.prompt
  if (Array.isArray(p.denyTools)) {
    config.predictor.denyTools = p.denyTools.filter((id): id is string => typeof id === "string")
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

async function loadConfig(options?: PluginOptions): Promise<{ config: Config; error?: string }> {
  if (options && typeof options === "object") {
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

export const OpencodeIdlePokePlugin: Plugin = async (input, options) => {
  const { client } = input
  const project = input.directory
  const configDir = opencodeConfigDir()
  const loaded = await loadConfig(options)
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
      } catch {}
    })
  }

  if (loaded.error) log("warn", "config load failed, using defaults", { error: loaded.error })
  log("info", "plugin initialized", {
    project,
    idleMs: config.idleMs,
    requireEngagement: config.requireEngagement,
    enabled: config.enabled,
    loggingLevel: config.logging.level,
    logFile: config.logging.file,
  })

  const sessions = new Map<string, SessionState>()
  let lastActive = ""

  const ensure = (sessionID: string): SessionState => {
    let s = sessions.get(sessionID)
    if (!s) {
      s = { enabled: config.enabled, engaged: false, pendingPoke: false, predictorEnabled: config.predictor.enabled }
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

  const onIdle = (sessionID: string) => {
    if (sessionID !== lastActive) return
    const s = ensure(sessionID)
    if (config.requireEngagement && !s.engaged) return
    if (!s.enabled || s.pendingPoke) return
    clearTimer(sessionID)
    const delay = s.delayMs ?? config.idleMs
    s.timer = setTimeout(() => void poke(sessionID), delay)
    log("info", "idle timer set", { sessionID, delayMs: delay })
  }

  const predictorSessions = new Set<string>()

  const buildExcerpt = async (sessionID: string): Promise<string | undefined> => {
    try {
      const res = await client.session.messages({ path: { id: sessionID } })
      const msgs = res.data
      if (!Array.isArray(msgs)) return undefined
      const texts = msgs
        .filter((m) => m.info.role === "user")
        .flatMap((m) => m.parts)
        .filter(
          (p): p is Extract<Part, { type: "text" }> =>
            p.type === "text" && !(p as { synthetic?: boolean }).synthetic
        )
        .map((p) => p.text)
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
    if (!s.model && !pred.model) {
      log("debug", "predictor skipped (no model)", { sessionID })
      return
    }
    const excerpt = await buildExcerpt(sessionID)
    if (!excerpt) {
      log("debug", "predictor skipped (empty excerpt)", { sessionID })
      return
    }
    let subID = ""
    try {
      const created = await client.session.create({ query: { directory: project } })
      subID = created.data!.id
      predictorSessions.add(subID)
      let model: { providerID: string; modelID: string } | undefined = s.model
      if (pred.model) {
        const idx = pred.model.indexOf("/")
        if (idx > 0 && idx < pred.model.length - 1) {
          model = { providerID: pred.model.slice(0, idx), modelID: pred.model.slice(idx + 1) }
        } else {
          log("debug", "predictor: invalid model format", { sessionID, model: pred.model })
        }
      }
      const denyMap = pred.denyTools.length
        ? Object.fromEntries(pred.denyTools.map((id) => [id, false]))
        : undefined
      const res = await withTimeout(
        client.session.prompt({
          path: { id: subID },
          body: {
            parts: [{ type: "text", text: excerpt, synthetic: true }],
            ...(pred.agent ? { agent: pred.agent } : {}),
            ...(model ? { model } : {}),
            system: pred.prompt,
            ...(denyMap ? { tools: denyMap } : {}),
          },
        }),
        pred.timeoutMs
      )
      const reply = (res.data!.parts ?? [])
        .filter((p) => p.type === "text" && !(p as { synthetic?: boolean }).synthetic)
        .map((p) => (p as { text: string }).text)
        .join("\n")
        .trim()
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
        predictorSessions.delete(subID)
        sessions.delete(subID)
        client.session.delete({ path: { id: subID } }).catch(() => undefined)
      }
    }
  }

  const poke = async (sessionID: string) => {
    const s = sessions.get(sessionID)
    if (!s) return
    s.timer = undefined
    if (sessionID !== lastActive) {
      log("debug", "stale poke skipped", { sessionID, lastActive })
      return
    }
    if (!s.enabled || s.pendingPoke) return
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
      await client.session.prompt({
        path: { id: sessionID },
        body: {
          parts: [{ type: "text", text, synthetic: true }],
          ...(s.agent ? { agent: s.agent } : {}),
        },
      })
      log("info", "poke sent", { sessionID, delayMs: pokeMs })
    } catch (e) {
      s.pendingPoke = false
      log("error", "poke failed", { sessionID, error: e instanceof Error ? e.message : String(e) })
    }
  }

  return {
    event: async ({ event }) => {
      if (event.type === "session.status") {
        const { sessionID, status } = event.properties
        log("debug", "session.status", { sessionID, status: status.type })
        if (status.type === "busy" || status.type === "retry") clearTimer(sessionID)
        else if (status.type === "idle") onIdle(sessionID)
      } else if (event.type === "session.deleted") {
        const sessionID = event.properties.info.id
        clearTimer(sessionID)
        sessions.delete(sessionID)
        log("debug", "session deleted", { sessionID })
      }
    },
    "chat.message": async (msg, output) => {
      if (predictorSessions.has(msg.sessionID)) return
      if (output.parts?.some((p) => (p as { synthetic?: boolean }).synthetic)) return
      const sessionID = msg.sessionID
      const s = ensure(sessionID)
      if (msg.agent) s.agent = msg.agent
      if (msg.model) s.model = msg.model
      if (!s.dirty && !s.notificationInjected) {
        s.notificationInjected = true
        const text = config.restartNotification
          .replaceAll("{enabled}", config.enabled ? "on" : "off")
          .replaceAll("{interval}", String(config.idleMs / 1000))
          .replaceAll("{predictor}", config.predictor.enabled ? "on" : "off")
        client.session.prompt({
          path: { id: sessionID },
          body: {
            parts: [{ type: "text", text, synthetic: true }],
            ...(s.agent ? { agent: s.agent } : {}),
          },
        })
        log("info", "restart notification sent", { sessionID })
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
    },
    "experimental.chat.system.transform": async ({ sessionID }, output) => {
      if (!sessionID) return
      if (predictorSessions.has(sessionID)) return
      ensure(sessionID)
      output.system.push(
        config.protocol
          .replaceAll("{disableMarker}", config.disableMarker)
          .replaceAll("{enableMarker}", config.enableMarker)
          .replaceAll("{disablePredictorMarker}", config.disablePredictorMarker)
          .replaceAll("{enablePredictorMarker}", config.enablePredictorMarker)
      )
    },
    "experimental.text.complete": async ({ sessionID }, output) => {
      if (predictorSessions.has(sessionID)) return
      const s = sessions.get(sessionID)
      if (!s) return
      const lines = output.text.trim().split("\n").slice(0, 5).map((l) => l.trim())
      log("debug", "text complete", { sessionID, lines })
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
    },
    dispose: async () => {
      for (const s of sessions.values()) if (s.timer) clearTimeout(s.timer)
      log("debug", "plugin disposed", {})
      await logQueue
    },
  }
}

export default OpencodeIdlePokePlugin
