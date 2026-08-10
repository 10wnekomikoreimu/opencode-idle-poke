<a id="en"></a>

# opencode-idle-poke — Configuration

> Chinese version (中文版) below: [opencode-idle-poke — 配置参考](#zh)

Configuration reference for the opencode-idle-poke plugin. Installation and getting started are covered in the README.

## Complete Configuration Example

Enable the plugin by adding it to the `plugin` array in `opencode.json` (or `opencode.jsonc`). To customize it, follow the example below:

```jsonc
{
  "plugin": [
    ["opencode-idle-poke", {
      "idleMs": 120000,
      "requireEngagement": true,
      "enabled": true,
      "enableMarker": "[Poke On]",
      "disableMarker": "[Poke Off]",
      "enablePredictorMarker": "[Predictor On]",
      "disablePredictorMarker": "[Predictor Off]",
      "predictor": {
        "enabled": false,
        "maxMessages": 6,
        "agent": "",
        "model": "",
        "timeoutMs": 15000,
        "denyTools": [
          "read", "edit", "bash", "glob", "grep",
          "webfetch", "websearch", "task", "todowrite", "skill", "mcp__*"
        ]
      },
      "logging": {
        "enabled": true,
        "level": "info",
        "file": "logs/opencode-idle-poke.log"
      }
    }]
  ]
}
```

The long text fields (`messageTemplate`, `restartNotification`, `protocol`, `predictor.prompt`) have sensible defaults shown below; only set them if you want to customize.

Instead of passing options, you can put the settings object directly at the top level of `~/.config/opencode/opencode-idle-poke.json` (plain JSON, no comments). It is read when no options are given:

```json
{
  "idleMs": 120000,
  "requireEngagement": true,
  "enabled": true,
  ...
}
```

## Configuration Priority

When configured in several places, the first match wins:

1. Plugin options (in opencode.json or opencode.jsonc).
2. `~/.config/opencode/opencode-idle-poke.json` — create it manually; the plugin will not create it for you.
3. Built-in defaults (see the field table below).

## Field Reference

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `idleMs` | number | `60000` | How long (ms) to stay silent before poking. |
| `requireEngagement` | boolean | `true` | Only poke after you have sent at least one real message in the session. |
| `enabled` | boolean | `true` | Whether pokes are on at startup. You can toggle pokes per session at runtime with markers. |
| `messageTemplate` | string | see Default Templates | The poke message. Placeholders: `{seconds}` (current interval in seconds), `{sessionID}`, `{project}`. |
| `enableMarker` | string | `[Poke On]` | Marker to turn pokes back on. |
| `disableMarker` | string | `[Poke Off]` | Marker to turn pokes off. |
| `enablePredictorMarker` | string | `[Predictor On]` | Marker to enable the adaptive interval per session. |
| `disablePredictorMarker` | string | `[Predictor Off]` | Marker to disable the adaptive interval per session. |
| `protocol` | string | see Default Templates | Instructions injected into the session so the model knows how to control pokes. Placeholders: `{disableMarker}`, `{enableMarker}`, `{disablePredictorMarker}`, `{enablePredictorMarker}`. |
| `restartNotification` | string | see Default Templates | A short message inserted after a restart, telling the model that pokes are back to defaults. Placeholders: `{enabled}` (on/off), `{interval}` (seconds), `{predictor}` (on/off). |
| `predictor.enabled` | boolean | `false` | Enable the adaptive interval: the plugin estimates conversation complexity before poking and adjusts the interval. |
| `predictor.maxMessages` | number | `6` | How many recent user messages are considered in the estimate. |
| `predictor.agent` | string | `""` | Agent used for the estimate. Empty = default agent. |
| `predictor.model` | string | `""` | Model used for the estimate, `"provider/model"`. Empty = the model of your latest message in the session. |
| `predictor.timeoutMs` | number | `15000` | Timeout for the estimate. On timeout, the current interval is kept and the poke happens as usual. |
| `predictor.prompt` | string | see Default Templates | The instructions given to the model for the estimate. |
| `predictor.denyTools` | string[] | see Default Templates | Tools banned during the estimate. `edit` also covers write/apply_patch; `mcp__*` matches every MCP tool. Empty list = no restriction. |
| `logging.enabled` | boolean | `true` | Master switch for the log file. |
| `logging.level` | string | `"info"` | `debug` (most verbose), `info`, `warn`, or `error`. |
| `logging.file` | string | `"logs/opencode-idle-poke.log"` | Log file path. Relative paths resolve against the opencode config directory (default `~/.config/opencode`), so the log lands in `~/.config/opencode/logs/`. Absolute paths work too. Empty string = no log file. Files over 10 MB are deleted and recreated automatically. |

## Default Templates

**messageTemplate** — the poke message:

```
[Idle reminder] You have been silent for about {seconds} seconds in session {project} ({sessionID}) - the current active idle-poke interval. If there is unfinished work, pending questions, or anything worth discussing, proactively ask the user; otherwise just briefly say you are waiting and do not spam. For this reply, do NOT read or modify any files, and do NOT run any commands or tools; respond based on the existing conversation only. Reply in the same language the user has been using. After this, follow the user's instructions normally.
```

The "do NOT read or modify any files" sentence is a safety hint baked into the default; feel free to edit or remove it.

**restartNotification**:

```
[System notification] opencode-idle-poke plugin restarted; poke settings have been reset to defaults (poke {enabled}, interval {interval}s, model-predicted interval {predictor}).
```

**protocol**:

```
If the user asks to stop the proactive idle-poke, write exactly '{disableMarker}' as the first line of your reply; if they ask to resume it, write '{enableMarker}' as the first line. If the user asks to adjust the reminder interval (e.g. 'remind me again in 5 minutes'), write exactly '[Remind: N unit]' as the first line, where N is a number and unit can be seconds/minutes/hours (or s/m/h; omitted means seconds). If the user asks to disable or enable the model-predicted interval, write '{disablePredictorMarker}'/'{enablePredictorMarker}' as the first line. Reply in the same language the user is using, then answer normally.
```

**predictor.prompt**:

```
Assess the complexity of the conversation excerpt below and output the reminder-interval marker. Output exactly one line: [Remind: N unit], where N is a number and unit can be seconds/minutes/hours (or s/m/h). Suggested tiers: simple (Q&A / chit-chat) -> 3 minutes; medium (typical dev questions) -> 10 minutes; complex (architecture / refactor / large change) -> 30 minutes. For this assessment, do NOT read or modify any files, and do NOT run any commands or tools; judge based on the excerpt only.
```

Notes:

- In the protocol, `{...}` placeholders are replaced with the marker values you configured. If you change the markers, detection follows them automatically.
- The `[Remind: N unit]` phrase is recognized by the plugin itself (the Chinese form `〔提醒间隔=5分钟〕` works too). Keep this format when editing the protocol.
- Pokes and the restart notification follow the agent of your latest message in the session, so replies match the mode you are working in.

## Runtime Markers

Control pokes directly in the conversation: ask the model, and it will put the marker on the first line of its reply.

| Ask the model to… | Marker |
| --- | --- |
| Stop poking | `[Poke Off]` |
| Resume poking | `[Poke On]` |
| Change the interval | `[Remind: 5 minutes]` — number + unit (s/m/h or seconds/minutes/hours; default seconds). Valid range: 20 seconds to 24 hours; out-of-range values are ignored. Chinese form: `〔提醒间隔=5分钟〕` |
| Turn the adaptive interval off (this session) | `[Predictor Off]` |
| Turn the adaptive interval on (this session) | `[Predictor On]` |

## Adaptive Interval (Predictor)

When enabled, the plugin estimates how complex your recent conversation is before each poke and adjusts the interval for the next one (simple ≈ 3 minutes, medium ≈ 10 minutes, complex ≈ 30 minutes).

- **Globally**: set `predictor.enabled: true` — applies to new sessions after a restart.
- **Per session**: ask the model to reply with `[Predictor On]`; the setting resets on restart.
- The estimate uses the model of your latest message in the session; override with `predictor.model`.
- The estimate never touches your files — tools are disabled during it. If anything fails or times out (default 15 s), the current interval is kept and the poke happens as usual.

## Logging

- Format: `[UTC time] [LEVEL] message {details}`.
- Default location (relative path): `~/.config/opencode/logs/opencode-idle-poke.log`.
- Levels: `debug` (most verbose), `info`, `warn`, `error`.
- Files over 10 MB are deleted and recreated automatically.

Example:

```
[2026-08-04T08:00:00.000Z] [INFO] plugin initialized {"project":"/path/to/project","idleMs":60000,...}
[2026-08-04T08:01:00.000Z] [INFO] restart notification sent {"sessionID":"ses_xxx"}
[2026-08-04T08:02:00.000Z] [INFO] poke sent {"sessionID":"ses_xxx","delayMs":60000}
```

---

<a id="zh"></a>

# opencode-idle-poke — 配置参考

> English version (英文版) above: [opencode-idle-poke — Configuration](#en)

本文件是 opencode-idle-poke 插件的配置参考；安装与快速开始见 README。

## 完整配置示例

在 `opencode.json`（或 `opencode.jsonc`）的 `plugin` 数组中启用插件；如需定制，请参考下面的示例：

```jsonc
{
  "plugin": [
    ["opencode-idle-poke", {
      "idleMs": 120000,
      "requireEngagement": true,
      "enabled": true,
      "enableMarker": "[Poke On]",
      "disableMarker": "[Poke Off]",
      "enablePredictorMarker": "[Predictor On]",
      "disablePredictorMarker": "[Predictor Off]",
      "predictor": {
        "enabled": false,
        "maxMessages": 6,
        "agent": "",
        "model": "",
        "timeoutMs": 15000,
        "denyTools": [
          "read", "edit", "bash", "glob", "grep",
          "webfetch", "websearch", "task", "todowrite", "skill", "mcp__*"
        ]
      },
      "logging": {
        "enabled": true,
        "level": "info",
        "file": "logs/opencode-idle-poke.log"
      }
    }]
  ]
}
```

`messageTemplate`、`restartNotification`、`protocol`、`predictor.prompt` 四个长文本字段有合理的默认值（见下文），仅在需要定制时才设置。

也可以不传 options，把设置对象直接作为文件顶层内容写入 `~/.config/opencode/opencode-idle-poke.json`（严格 JSON，不支持注释），未传 options 时读取该文件：

```json
{
  "idleMs": 120000,
  "requireEngagement": true,
  "enabled": true,
  ...
}
```

## 配置优先级

多处配置时按以下顺序取第一个可用的来源：

1. 插件选项（在 opencode.json 或 opencode.jsonc 中指定）。
2. `~/.config/opencode/opencode-idle-poke.json`——需手动创建，插件不会自动生成。
3. 内置默认值（见下方字段表）。

## 字段参考

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `idleMs` | number | `60000` | 静默多久（毫秒）后主动搭话。 |
| `requireEngagement` | boolean | `true` | 是否要求该会话至少有一条你的真实消息后才开始检测。 |
| `enabled` | boolean | `true` | 启动时搭话是否开启；运行中可用标记逐会话切换。 |
| `messageTemplate` | string | 见默认模板 | 搭话消息。占位符：`{seconds}`（当前间隔，秒）、`{sessionID}`、`{project}`。 |
| `enableMarker` | string | `[Poke On]` | 恢复搭话的标记。 |
| `disableMarker` | string | `[Poke Off]` | 停止搭话的标记。 |
| `enablePredictorMarker` | string | `[Predictor On]` | 逐会话开启自适应间隔的标记。 |
| `disablePredictorMarker` | string | `[Predictor Off]` | 逐会话关闭自适应间隔的标记。 |
| `protocol` | string | 见默认模板 | 注入到会话中，告知模型如何控制搭话的说明。占位符：`{disableMarker}`/`{enableMarker}`/`{disablePredictorMarker}`/`{enablePredictorMarker}`。 |
| `restartNotification` | string | 见默认模板 | 插件重启后插入对话、告知模型搭话已恢复默认的短消息。占位符：`{enabled}`（on/off）、`{interval}`（秒）、`{predictor}`（on/off）。 |
| `predictor.enabled` | boolean | `false` | 启用自适应间隔：搭话前评估最近对话复杂度并调整间隔。 |
| `predictor.maxMessages` | number | `6` | 评估时参考的最近用户消息条数。 |
| `predictor.agent` | string | `""` | 评估所用代理；留空 = 默认代理。 |
| `predictor.model` | string | `""` | 评估所用模型，格式 `"provider/model"`；留空 = 该会话最近一条消息所用模型。 |
| `predictor.timeoutMs` | number | `15000` | 评估超时（毫秒）；超时则保留当前间隔照常搭话。 |
| `predictor.prompt` | string | 见默认模板 | 评估时给模型的提示。 |
| `predictor.denyTools` | string[] | 见默认模板 | 评估时禁止使用的工具。`edit` 同时涵盖 write/apply_patch；`mcp__*` 匹配全部 MCP 工具；置空数组 = 不做限制。 |
| `logging.enabled` | boolean | `true` | 日志总开关。 |
| `logging.level` | string | `"info"` | `debug`（最详细）/`info`/`warn`/`error`。 |
| `logging.file` | string | `"logs/opencode-idle-poke.log"` | 日志路径。相对路径按 opencode 配置目录解析（默认 `~/.config/opencode`），落在 `~/.config/opencode/logs/`；也支持绝对路径；空字符串 = 不写日志。超过 10MB 自动删除重建。 |

## 默认模板

**messageTemplate**（搭话消息）：

```
[Idle reminder] You have been silent for about {seconds} seconds in session {project} ({sessionID}) - the current active idle-poke interval. If there is unfinished work, pending questions, or anything worth discussing, proactively ask the user; otherwise just briefly say you are waiting and do not spam. For this reply, do NOT read or modify any files, and do NOT run any commands or tools; respond based on the existing conversation only. Reply in the same language the user has been using. After this, follow the user's instructions normally.
```

其中 "do NOT read or modify any files" 是内置的安全提示，可按需修改或删除。

**restartNotification**：

```
[System notification] opencode-idle-poke plugin restarted; poke settings have been reset to defaults (poke {enabled}, interval {interval}s, model-predicted interval {predictor}).
```

**protocol**：

```
If the user asks to stop the proactive idle-poke, write exactly '{disableMarker}' as the first line of your reply; if they ask to resume it, write '{enableMarker}' as the first line. If the user asks to adjust the reminder interval (e.g. 'remind me again in 5 minutes'), write exactly '[Remind: N unit]' as the first line, where N is a number and unit can be seconds/minutes/hours (or s/m/h; omitted means seconds). If the user asks to disable or enable the model-predicted interval, write '{disablePredictorMarker}'/'{enablePredictorMarker}' as the first line. Reply in the same language the user is using, then answer normally.
```

**predictor.prompt**：

```
Assess the complexity of the conversation excerpt below and output the reminder-interval marker. Output exactly one line: [Remind: N unit], where N is a number and unit can be seconds/minutes/hours (or s/m/h). Suggested tiers: simple (Q&A / chit-chat) -> 3 minutes; medium (typical dev questions) -> 10 minutes; complex (architecture / refactor / large change) -> 30 minutes. For this assessment, do NOT read or modify any files, and do NOT run any commands or tools; judge based on the excerpt only.
```

说明：

- `protocol` 中的 `{...}` 占位符会被替换成你配置的标记值；改了标记，检测也会相应更新。
- `[Remind: N unit]` 由插件本身识别（中文形式 `〔提醒间隔=5分钟〕` 同样有效）；自定义 protocol 时请保持该格式。
- 搭话与重启通知跟随该会话最近一条消息所用的代理，回复风格与你当前工作模式一致。

## 运行时标记

在对话中直接说即可控制搭话，模型会把标记写在回复第一行：

| 你想让模型… | 标记 |
| --- | --- |
| 停止搭话 | `[Poke Off]` |
| 恢复搭话 | `[Poke On]` |
| 调整间隔 | `[Remind: 5 minutes]` —— 数字 + 单位（s/m/h 或 秒/分钟/小时，缺省秒）；有效范围 20 秒 ~ 24 小时，范围外忽略。中文形式：`〔提醒间隔=5分钟〕` |
| 关闭自适应间隔（本会话） | `[Predictor Off]` |
| 开启自适应间隔（本会话） | `[Predictor On]` |

## 自适应间隔（Predictor）

开启后，插件会在每次搭话前评估最近对话的复杂程度，并据此调整下一次搭话的间隔（简单 ≈ 3 分钟 / 中等 ≈ 10 分钟 / 复杂 ≈ 30 分钟）。

- **全局开启**：`predictor.enabled: true`（重启后对新会话生效）。
- **单会话开启**：让模型回复 `[Predictor On]`（重启后恢复默认）。
- 评估使用该会话最近一条消息所用的模型；可用 `predictor.model` 覆盖。
- 评估不会碰你的文件——该过程禁用工具。超时（默认 15 秒）或任何异常都会静默保留当前间隔，搭话照常进行。

## 日志

- 格式：`[UTC时间] [级别] 消息 {详情}`。
- 默认位置（相对路径）：`~/.config/opencode/logs/opencode-idle-poke.log`。
- 级别：`debug`（最详细）/`info`/`warn`/`error`。
- 超过 10MB 自动删除重建。

示例：

```
[2026-08-04T08:00:00.000Z] [INFO] plugin initialized {"project":"/path/to/project","idleMs":60000,...}
[2026-08-04T08:01:00.000Z] [INFO] restart notification sent {"sessionID":"ses_xxx"}
[2026-08-04T08:02:00.000Z] [INFO] poke sent {"sessionID":"ses_xxx","delayMs":60000}
```
