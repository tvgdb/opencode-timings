/** @jsxImportSource @opentui/solid */
/**
 * opencode-timings — a TUI sidebar panel showing per-session timing.
 *
 * Renders into OpenCode's `sidebar.content` slot (alongside Quota / MCP / LSP /
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
 * Config — pass options via the object form in `cli.json`:
 *
 *   "plugins": [
 *     {
 *       "package": "@foae/opencode-timings@latest",
 *       "options": {
 *         "mode": "fancy",            // "fancy" (default) | "simple"
 *         "fields": {                  // each toggles one value, all default true
 *           "ratio": true, "api": true, "wall": true, "turns": true,
 *           "avg": true, "slow": true, "tps": true, "lastTps": true,
 *           "tokIn": true, "tokOut": true, "sparkline": true, "speedline": true
 *         }
 *       }
 *     }
 *   ]
 *
 * "fancy" draws the gauge bar on the ratio row and adds the two sparklines
 * (turn durations and per-turn tok/s); "simple" is the same rows without the
 * bar or sparklines. The panel is always shown (values read zero before the
 * first turn).
 */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, Index, onCleanup } from "solid-js"
import {
  buildRows,
  computeTiming,
  EMPTY,
  parseConfig,
  type Fields,
  type Mode,
  type Timing,
  type TimingMessage,
} from "./timing.ts"

const id = "opencode-timings"
const REFRESH_INTERVAL_MS = 15_000

type PluginContext = ReturnType<typeof usePlugin>

function SidebarTimingView(props: {
  context: PluginContext
  sessionID: string
  mode: Mode
  fields: Fields
}) {
  const read = (): Timing => {
    try {
      const messages = props.context.data.session.message.list(props.sessionID) ?? []
      return computeTiming(messages as ReadonlyArray<TimingMessage>)
    } catch {
      return EMPTY
    }
  }
  const [timing, setTiming] = createSignal<Timing>(read())
  const refresh = () => setTiming(read())

  // Re-sync and re-read whenever the active session changes or reactive message store updates.
  createEffect(() => {
    const sessionID = props.sessionID
    refresh()
    void Promise.resolve(props.context.data.session.message.sync(sessionID))
      .then(() => refresh())
      .catch(() => {})
    const recovery = [setTimeout(refresh, 400), setTimeout(refresh, 1500), setTimeout(refresh, 4000)]
    onCleanup(() => {
      for (const timer of recovery) clearTimeout(timer)
    })
  })

  const interval = setInterval(refresh, REFRESH_INTERVAL_MS)

  // Refresh whenever server events arrive for this session.
  const stopListen = props.context.data.listen((event: unknown) => {
    const details = (event as { details?: Record<string, unknown> })?.details
    const eventSessionID =
      (details?.sessionID as string | undefined) ??
      ((details?.info as { sessionID?: string; id?: string } | undefined)?.sessionID ??
        (details?.info as { id?: string } | undefined)?.id)
    if (!eventSessionID || eventSessionID === props.sessionID) {
      refresh()
    }
  })

  onCleanup(() => {
    clearInterval(interval)
    stopListen()
  })

  const rows = (): string[] => buildRows(timing(), props.mode, props.fields)

  return (
    <box gap={0}>
      <text fg={props.context.theme.text.base}>
        <b>Timing</b>
      </text>
      <box gap={0}>
        <Index each={rows()}>
          {(row) => (
            <text fg={props.context.theme.text.muted} wrapMode="none">
              {row() || " "}
            </text>
          )}
        </Index>
      </box>
    </box>
  )
}

export default Plugin.define({
  id,
  setup(context) {
    const { mode, fields } = parseConfig(context.options as Record<string, unknown> | undefined)
    return context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => (
        <SidebarTimingView context={context} sessionID={sessionID} mode={mode} fields={fields} />
      ),
    })
  },
})
