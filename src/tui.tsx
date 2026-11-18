/** @jsxImportSource @opentui/solid */
/**
 * opencode-timings — a TUI sidebar panel showing per-session timing and telemetry.
 *
 * Renders into OpenCode's `sidebar.content` slot (alongside Quota / MCP / LSP /
 * Todo / Files), reading session messages and metadata from the reactive TUI
 * state. Nothing is injected into the message stream, preserving zero
 * context-window pollution.
 *
 * Fancy layout — every value names itself, situational/anomaly segments hide while 0:
 *
 *   Timing
 *   llm/wall █████░░░ 62%        gauge: share of wall-clock spent in model inference
 *   llm 25s · wall 40s           model stream time vs full session span
 *   tool 11s · calls 14 · err 1  merged tool I/O time, call count, and tool errors
 *   turns 3 · steps 9 · avg 4s   user prompts, assistant steps, and mean step llm time
 *   p50 2s · p95 8s              median and tail per-step llm latency
 *   slowest 19s · tool shell 7s  slowest llm step and single slowest tool call
 *   ttft avg 1.1s · last 820ms   time to first token (live events + persisted fallback)
 *   tok/s avg 58 · last 64       true decode speed (`tokensOut / llm`)
 *   tok in 1.2M · out 45k        input (+ cache) vs output (+ reasoning) tokens
 *   cache 94% · think 61% (11s)  prompt-cache read hit rate and reasoning share/time
 *   ctx 74% · cost $0.48 ($0.16/t) post-compaction context fill and session spend
 *   wait 8s · compact 1          human permission/question stalls and compactions
 *   retry 2 · maxlen 1           provider retry backoffs and max-token truncations
 *   sub 3 · 28s · 180k tok       spawned subagent count, merged runtime, and tokens
 *   per-turn ▄█▂▂                sparkline of each recent step's llm duration
 *   speed ▂▄█▆                   sparkline of each recent step's tok/s
 *
 * Pure timing math, formatting, and config parsing live in `./timing.ts`.
 */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, Index, onCleanup } from "solid-js"
import {
  buildRows,
  computeTiming,
  EMPTY,
  lastUsageModel,
  parseConfig,
  type Fields,
  type Mode,
  type Timing,
  type TimingMessage,
} from "./timing.ts"

const id = "opencode-timings"
const REFRESH_INTERVAL_MS = 15_000
const MAX_MESSAGE_ENTRIES = 500
const MAX_SESSION_ENTRIES = 100

type PluginContext = ReturnType<typeof usePlugin>

// Class instance so `solid-js/store` inside `context.storage.memory` leaves the
// maps unproxied (no reactive overhead per streaming delta) while preserving
// recorded TTFTs and retries across plugin hot-reloads and sidebar toggles.
class LiveTelemetry {
  readonly stepStart = new Map<string, number>()
  readonly ttft = new Map<string, number>()
  readonly seenRetries = new Set<string>()
  readonly retries = new Map<string, number>()
}

function setBounded<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
  if (map.has(key)) map.delete(key)
  else if (map.size >= limit) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
  map.set(key, value)
}

function addBounded<T>(set: Set<T>, value: T, limit: number): boolean {
  if (set.has(value)) return false
  if (set.size >= limit) {
    const oldest = set.values().next().value
    if (oldest !== undefined) set.delete(oldest)
  }
  set.add(value)
  return true
}

function extractEventSessionID(details: Record<string, unknown> | undefined): string | undefined {
  const data = details?.data as { sessionID?: string } | undefined
  if (typeof data?.sessionID === "string") return data.sessionID
  if (typeof details?.sessionID === "string") return details.sessionID
  const info = details?.info as { sessionID?: string; id?: string } | undefined
  return info?.sessionID ?? info?.id
}

function sumDescendantTokens(data: PluginContext["data"], sessionID: string): number {
  const family = data.session.family(sessionID) ?? []
  if (family.length <= 1) return 0
  const isRoot = data.session.root(sessionID) === sessionID
  let total = 0
  for (const candidateID of family) {
    if (candidateID === sessionID) continue
    if (!isRoot) {
      // Walk `parentID` links when inspecting a child session so its parent and
      // sibling subagents are excluded.
      let cur = data.session.get(candidateID)?.parentID
      let hops = 0
      while (cur && cur !== sessionID && hops++ < 16) {
        cur = data.session.get(cur)?.parentID
      }
      if (cur !== sessionID) continue
    }
    const tok = data.session.get(candidateID)?.tokens
    if (tok) {
      total +=
        (tok.input || 0) +
        (tok.output || 0) +
        (tok.reasoning || 0) +
        (tok.cache?.read || 0) +
        (tok.cache?.write || 0)
    }
  }
  return total
}

function SidebarTimingView(props: {
  context: PluginContext
  sessionID: string
  mode: Mode
  fields: Fields
  live: LiveTelemetry
}) {
  const read = (): Timing => {
    try {
      const { data } = props.context
      const messages = (data.session.message.list(props.sessionID) ?? []) as ReadonlyArray<TimingMessage>
      const info = data.session.get(props.sessionID)
      const revertMessageID = info?.revert?.messageID

      let contextLimit: number | undefined
      const usageModel = lastUsageModel(messages, revertMessageID)
      if (usageModel) {
        const loc = info?.location ?? props.context.location
        const models = data.location.model.list(loc)
        const match = models?.find(
          (m) => m.providerID === usageModel.providerID && (m.id === usageModel.id || m.modelID === usageModel.id),
        )
        contextLimit = match?.limit?.context
      }

      return computeTiming(messages, {
        ttftByMessage: props.live.ttft,
        retries: props.live.retries.get(props.sessionID),
        revertMessageID,
        sessionTotals: info ? { cost: info.cost, tokens: info.tokens } : undefined,
        contextLimit,
        subagentTokens: sumDescendantTokens(data, props.sessionID),
      })
    } catch {
      return EMPTY
    }
  }

  const [timing, setTiming] = createSignal<Timing>(read())
  const refresh = () => setTiming(read())

  // Re-sync and re-read whenever the active session changes or reactive stores update.
  createEffect(() => {
    const sessionID = props.sessionID
    const { data } = props.context
    refresh()
    void Promise.resolve(data.session.message.sync(sessionID))
      .then(() => refresh())
      .catch(() => {})
    void Promise.resolve(data.session.sync(sessionID))
      .then(() => {
        const loc = data.session.get(sessionID)?.location ?? props.context.location
        // Avoid re-fetching the model catalog on every tab switch once hydrated.
        if (data.location.model.list(loc) === undefined) {
          return data.location.model.sync(loc)
        }
      })
      .then(() => refresh())
      .catch(() => {})
    const recovery = [setTimeout(refresh, 400), setTimeout(refresh, 1500), setTimeout(refresh, 4000)]
    onCleanup(() => {
      for (const timer of recovery) clearTimeout(timer)
    })
  })

  const interval = setInterval(refresh, REFRESH_INTERVAL_MS)

  const stopListen = props.context.data.listen((event: unknown) => {
    const details = (event as { details?: Record<string, unknown> })?.details
    const eventType = details?.type as string | undefined
    if (eventType === "model.updated") {
      refresh()
      return
    }
    const eventSessionID = extractEventSessionID(details)
    if (!eventSessionID || eventSessionID === props.sessionID) {
      refresh()
      return
    }
    const family = props.context.data.session.family(props.sessionID)
    if (family?.includes(eventSessionID)) refresh()
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
    const [mem] = context.storage.memory("timings-live", { initial: { ref: new LiveTelemetry() } })
    const live = mem.ref

    // Subscribed at plugin setup rather than view mount so TTFT and retry events
    // are captured even while the user has the sidebar collapsed.
    const stopLive = context.data.listen((event: unknown) => {
      const details = (event as { details?: Record<string, unknown> })?.details
      const type = details?.type as string | undefined
      const data = details?.data as
        | { sessionID?: string; assistantMessageID?: string; started?: number; attempt?: number }
        | undefined
      const msgID = data?.assistantMessageID
      if (!type || !msgID) return

      if (type === "session.step.started") {
        if (typeof data.started === "number") {
          setBounded(live.stepStart, msgID, data.started, MAX_MESSAGE_ENTRIES)
          // OpenCode reuses `assistantMessageID` when a failed step retries; clear
          // any stale TTFT recorded during the failed attempt.
          live.ttft.delete(msgID)
        }
      } else if (
        type === "session.reasoning.started" ||
        type === "session.text.started" ||
        type === "session.tool.input.started"
      ) {
        const started = live.stepStart.get(msgID)
        const created = details?.created
        if (started !== undefined && !live.ttft.has(msgID) && typeof created === "number") {
          setBounded(live.ttft, msgID, Math.max(0, created - started), MAX_MESSAGE_ENTRIES)
          live.stepStart.delete(msgID)
        }
      } else if (type === "session.step.ended" || type === "session.step.failed") {
        live.stepStart.delete(msgID)
      } else if (type === "session.retry.scheduled") {
        const sessionID = data.sessionID
        if (sessionID && typeof data.attempt === "number") {
          const key = `${msgID}:${data.attempt}`
          if (addBounded(live.seenRetries, key, MAX_MESSAGE_ENTRIES)) {
            setBounded(live.retries, sessionID, (live.retries.get(sessionID) ?? 0) + 1, MAX_SESSION_ENTRIES)
          }
        }
      }
    })

    const stopSlot = context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => (
        <SidebarTimingView context={context} sessionID={sessionID} mode={mode} fields={fields} live={live} />
      ),
    })

    return () => {
      stopLive()
      stopSlot()
    }
  },
})
