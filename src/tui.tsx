/** @jsxImportSource @opentui/solid */
/**
 * opencode-timings — a TUI sidebar panel showing per-session timing.
 *
 * Renders into OpenCode's `sidebar_content` slot (alongside Quota / MCP / LSP /
 * Todo / Files), reading the session's messages straight from the reactive TUI
 * state. Nothing is injected into the message stream, so there is zero
 * context-window pollution.
 *
 * Fancy layout — every value names itself, all rows in the muted tone:
 *
 *   Timing
 *   api/wall ██████░░ 78%      gauge: how much of wall-clock was model inference
 *   api 31s · wall 40s          the two raw times behind that ratio
 *   turns 4 · avg 8s            completed assistant turns and their average
 *   slowest 19s                 the single slowest turn
 *   tok/s avg 43 · last 51      generation speed: session average and latest turn
 *   tok in 1.2M · out 45k       tokens the model read vs generated
 *   per-turn ▄█▂▂               sparkline of each recent turn's duration
 *   speed ▂▄█▆                  sparkline of each recent turn's tok/s
 *
 * The timing math, formatting, and config parsing live in `./timing.ts` (pure,
 * JSX-free, unit-tested); this file is just the Solid component and the slot
 * registration. See `timing.ts` for the per-session metric definitions.
 *
 * Config — pass options via the tuple form in `tui.json`:
 *
 *   "plugin": [
 *     ["@foae/opencode-timings@latest", {
 *       "mode": "fancy",            // "fancy" (default) | "simple"
 *       "fields": {                  // each toggles one value, all default true
 *         "ratio": true, "api": true, "wall": true, "turns": true,
 *         "avg": true, "slow": true, "tps": true, "lastTps": true,
 *         "tokIn": true, "tokOut": true, "sparkline": true, "speedline": true
 *       }
 *     }]
 *   ]
 *
 * "fancy" draws the gauge bar on the ratio row and adds the two sparklines
 * (turn durations and per-turn tok/s); "simple" is the same rows without the
 * bar or sparklines. The panel is always shown (values read zero before the
 * first turn).
 */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createEffect, createSignal, Index, onCleanup } from "solid-js"
import { buildRows, computeTiming, EMPTY, parseConfig, type Fields, type Mode, type Timing } from "./timing.ts"

const id = "opencode-timings"

// Render just below Quota (order 150) and above the variable-height built-in
// sections (MCP/LSP/Todo/Files) so the panel stays near the top of the fold.
const SIDEBAR_ORDER = 155

// Wall-clock and API time are derived purely from message timestamps, so events
// drive updates; this interval is just a low-frequency backstop.
const REFRESH_INTERVAL_MS = 15_000

function SidebarTimingView(props: {
  api: TuiPluginApi
  sessionID: string
  mode: Mode
  fields: Fields
}) {
  // Read defensively: api.state can throw if the session is torn down mid-read
  // (e.g. deleted from another pane), and this runs inside event/timer callbacks
  // where an escaping exception would be unhandled — fall back to empty instead.
  const read = (): Timing => {
    try {
      return computeTiming(props.api.state.session.messages(props.sessionID))
    } catch {
      return EMPTY
    }
  }
  const [timing, setTiming] = createSignal<Timing>(read())
  const refresh = () => setTiming(read())

  // Re-read whenever the active session changes. OpenCode may keep this slot
  // component mounted and merely swap `session_id`, in which case a mount-time
  // read alone would keep showing the previous session until the next event or
  // the interval backstop. Tracking props.sessionID here also re-arms the
  // async-hydration recovery reads (TUI/session state can land a beat after a
  // switch), and onCleanup tears the pending timers down on the next switch.
  createEffect(() => {
    void props.sessionID // track session switches
    refresh()
    const recovery = [setTimeout(refresh, 400), setTimeout(refresh, 1500), setTimeout(refresh, 4000)]
    onCleanup(() => {
      for (const timer of recovery) clearTimeout(timer)
    })
  })

  // Low-frequency backstop; events drive the timely updates.
  const interval = setInterval(refresh, REFRESH_INTERVAL_MS)

  // Access paths differ by event on purpose: message.updated/session.updated
  // carry a nested `info` (Message/Session, no top-level sessionID), while
  // message.removed/session.idle carry sessionID directly — each matches its
  // SDK event type.
  const unsubscribers = [
    props.api.event.on("message.updated", (event) => {
      if (event.properties?.info?.sessionID === props.sessionID) refresh()
    }),
    props.api.event.on("message.removed", (event) => {
      if (event.properties?.sessionID === props.sessionID) refresh()
    }),
    props.api.event.on("session.updated", (event) => {
      if (event.properties?.info?.id === props.sessionID) refresh()
    }),
    props.api.event.on("session.idle", (event) => {
      if (event.properties?.sessionID === props.sessionID) refresh()
    }),
  ]

  onCleanup(() => {
    clearInterval(interval)
    for (const unsubscribe of unsubscribers) unsubscribe()
  })

  const rows = (): string[] => buildRows(timing(), props.mode, props.fields)

  return (
    <box gap={0}>
      <text fg={props.api.theme.current.text}>
        <b>Timing</b>
      </text>
      <box gap={0}>
        <Index each={rows()}>
          {(row) => (
            <text fg={props.api.theme.current.textMuted} wrapMode="none">
              {row() || " "}
            </text>
          )}
        </Index>
      </box>
    </box>
  )
}

const tui: TuiPlugin = async (api, options) => {
  const { mode, fields } = parseConfig(options)
  api.slots.register({
    order: SIDEBAR_ORDER,
    slots: {
      sidebar_content(_ctx, props: { session_id: string }) {
        return <SidebarTimingView api={api} sessionID={props.session_id} mode={mode} fields={fields} />
      },
    },
  })
}

const pluginModule: TuiPluginModule & { id: string } = { id, tui }

export default pluginModule
