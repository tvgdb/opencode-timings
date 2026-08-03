/**
 * Pure timing computation, formatting, and config parsing for the
 * opencode-timings panel — deliberately free of JSX and any opentui/solid
 * import so it loads under a plain TypeScript runtime (e.g. `bun test`) without
 * OpenCode's Solid JSX preload. The rendering lives in `tui.tsx`.
 *
 * Metrics (per session):
 *   - api      total assistant inference time = sum of (time.completed - time.created)
 *              over every completed assistant message.
 *   - wall     span from the first to the last message timestamp (includes the time
 *              you spend reading/typing between turns), so api is a fraction of it.
 *   - apiPct   api's share of wall-clock, clamped to 0–100 for the gauge/percent.
 *   - turns    number of completed assistant messages, plus the average duration.
 *   - slowest  the single slowest assistant message.
 *   - durations per-turn durations, fed to the sparkline.
 *   - tokensIn / tokensOut  totals over the same completed turns: what the model
 *              read (input + cache read/write) vs generated (output + reasoning).
 *   - avgTps   session-average generation speed: tokensOut over api time.
 *   - lastTps  the most recent turn's tokens/s.
 *   - tpsPerTurn per-turn tokens/s, fed to the speed sparkline.
 *
 * Idle time: nothing here reads the clock — every value derives from message
 * timestamps, so idling between turns or leaving a session open moves only
 * wall (and therefore apiPct), which exist precisely to show that contrast.
 * The one leak is *inside* a turn: (completed - created) includes tool
 * execution and any wait on the user (permission prompts, questions), which
 * inflates api/avg/slowest and deflates tok/s for that turn. Message-level
 * timestamps cannot separate it; part-level timing is not in the TUI state.
 */
import type { Message } from "@opencode-ai/sdk/v2"

// Narrower than the simple-mode rows so the "api/wall" label + gauge + percent
// fit one sidebar line without wrapping.
export const BAR_WIDTH = 8
export const SPARK_POINTS = 12
export const SPARK_LEVELS = "▁▂▃▄▅▆▇█"

export type Mode = "fancy" | "simple"
// Each field toggles exactly one displayed value. `ratio` is the api/wall gauge
// (the panel's headline metric); `sparkline` (per-turn durations) and
// `speedline` (per-turn tok/s) are fancy-only. Order matches the top-to-bottom
// render order.
export type Fields = {
  ratio: boolean
  api: boolean
  wall: boolean
  turns: boolean
  avg: boolean
  slow: boolean
  tps: boolean
  lastTps: boolean
  tokIn: boolean
  tokOut: boolean
  sparkline: boolean
  speedline: boolean
}
export const DEFAULT_FIELDS: Fields = {
  ratio: true,
  api: true,
  wall: true,
  turns: true,
  avg: true,
  slow: true,
  tps: true,
  lastTps: true,
  tokIn: true,
  tokOut: true,
  sparkline: true,
  speedline: true,
}

export type Timing = {
  apiMs: number
  wallMs: number
  turns: number
  avgMs: number
  slowestMs: number
  apiPct: number
  durations: number[]
  tokensIn: number
  tokensOut: number
  avgTps: number
  lastTps: number
  tpsPerTurn: number[]
}
export const EMPTY: Timing = {
  apiMs: 0,
  wallMs: 0,
  turns: 0,
  avgMs: 0,
  slowestMs: 0,
  apiPct: 0,
  durations: [],
  tokensIn: 0,
  tokensOut: 0,
  avgTps: 0,
  lastTps: 0,
  tpsPerTurn: [],
}

// Token counts can be absent on old/partial records despite the SDK type.
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0)

export function computeTiming(messages: ReadonlyArray<Message>): Timing {
  let apiMs = 0
  let slowestMs = 0
  let minTs = Number.POSITIVE_INFINITY
  let maxTs = 0
  let tokensIn = 0
  let tokensOut = 0
  const durations: number[] = []
  const tpsPerTurn: number[] = []

  for (const msg of messages) {
    const created = msg.time?.created
    if (typeof created === "number") {
      if (created < minTs) minTs = created
      if (created > maxTs) maxTs = created
    }
    if (msg.role === "assistant") {
      const completed = msg.time?.completed
      if (typeof completed === "number") {
        if (completed > maxTs) maxTs = completed
        const dur = completed - (typeof created === "number" ? created : completed)
        if (dur > 0) {
          apiMs += dur
          durations.push(dur)
          if (dur > slowestMs) slowestMs = dur
          const tok = msg.tokens
          const outTok = num(tok?.output) + num(tok?.reasoning)
          tokensIn += num(tok?.input) + num(tok?.cache?.read) + num(tok?.cache?.write)
          tokensOut += outTok
          tpsPerTurn.push((outTok * 1000) / dur)
        }
      }
    }
  }

  const turns = durations.length
  if (turns === 0) return EMPTY
  const wallMs = minTs === Number.POSITIVE_INFINITY ? 0 : Math.max(0, maxTs - minTs)
  return {
    apiMs,
    wallMs,
    turns,
    avgMs: apiMs / turns,
    slowestMs,
    // Summed per-turn inference vs a single wall span: overlapping/retried
    // assistant records or clock skew can push the ratio past 100%, so clamp it
    // (the gauge bar clamps too) to keep the percent honest.
    apiPct: wallMs > 0 ? Math.min(100, Math.round((apiMs / wallMs) * 100)) : 0,
    durations,
    tokensIn,
    tokensOut,
    avgTps: (tokensOut * 1000) / apiMs,
    lastTps: tpsPerTurn[tpsPerTurn.length - 1] ?? 0,
    tpsPerTurn,
  }
}

/** Compact, sidebar-friendly duration: "42s", "6m31s", "1h02m". */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const totalMin = Math.floor(totalSec / 60)
  if (totalMin < 60) return `${totalMin}m${String(totalSec % 60).padStart(2, "0")}s`
  const hours = Math.floor(totalMin / 60)
  return `${hours}h${String(totalMin % 60).padStart(2, "0")}m`
}

/** Compact token count: "950", "1.2k", "45k", "1.2M". */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) n = 0
  for (const [div, unit] of [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "k"],
  ] as const) {
    if (n >= div) {
      const v = n / div
      // >= 9.95 so toFixed(1) never prints a four-char "10.0".
      return v >= 9.95 ? `${Math.round(v)}${unit}` : `${v.toFixed(1)}${unit}`
    }
  }
  return String(Math.round(n))
}

/** Tokens-per-second: one decimal below 10 ("7.5"), whole numbers above ("43"). */
export function fmtTps(tps: number): string {
  if (!Number.isFinite(tps) || tps <= 0) return "0"
  return tps >= 9.95 ? String(Math.round(tps)) : tps.toFixed(1)
}

export function bar(pct: number, width: number): string {
  const p = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0))
  const filled = Math.round((p / 100) * width)
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled))
}

export function sparkline(values: number[]): string {
  if (values.length === 0) return ""
  const points = values.slice(-SPARK_POINTS)
  const max = Math.max(...points, 1)
  return points
    .map((v) => {
      const idx = Math.round((v / max) * (SPARK_LEVELS.length - 1))
      return SPARK_LEVELS[Math.min(SPARK_LEVELS.length - 1, Math.max(0, idx))]
    })
    .join("")
}

/** Join the enabled segments of a packed row with " · ", dropping the empties. */
function packRow(...segments: string[]): string {
  return segments.filter(Boolean).join(" · ")
}

// Every row is a labeled string in the muted tone — no value relies on the
// reader inferring what an unlabeled number or glyph means. Each field toggles
// exactly one value; values that share a line drop out individually when their
// field is off. Fancy and simple render identically except that fancy draws the
// gauge bar on the ratio row and adds the per-turn sparkline.
export function buildRows(t: Timing, mode: Mode, fields: Fields): string[] {
  const rows: string[] = []

  if (fields.ratio) {
    rows.push(mode === "fancy" ? `api/wall ${bar(t.apiPct, BAR_WIDTH)} ${t.apiPct}%` : `api/wall ${t.apiPct}%`)
  }

  const timesRow = packRow(
    fields.api ? `api ${fmtDuration(t.apiMs)}` : "",
    fields.wall ? `wall ${fmtDuration(t.wallMs)}` : "",
  )
  if (timesRow) rows.push(timesRow)

  const turnsRow = packRow(
    fields.turns ? `turns ${t.turns}` : "",
    fields.avg ? `avg ${fmtDuration(t.avgMs)}` : "",
  )
  if (turnsRow) rows.push(turnsRow)

  if (fields.slow) rows.push(`slowest ${fmtDuration(t.slowestMs)}`)

  // In both packed rows below, the leading label ("tok/s" / "tok") moves onto
  // the second segment when it stands alone, so the row stays self-labeling
  // whichever value is enabled.
  const tpsRow = packRow(
    fields.tps ? `tok/s avg ${fmtTps(t.avgTps)}` : "",
    fields.lastTps ? `${fields.tps ? "last" : "tok/s last"} ${fmtTps(t.lastTps)}` : "",
  )
  if (tpsRow) rows.push(tpsRow)

  const tokensRow = packRow(
    fields.tokIn ? `tok in ${fmtTokens(t.tokensIn)}` : "",
    fields.tokOut ? `${fields.tokIn ? "out" : "tok out"} ${fmtTokens(t.tokensOut)}` : "",
  )
  if (tokensRow) rows.push(tokensRow)

  if (mode === "fancy" && fields.sparkline) {
    const spark = sparkline(t.durations)
    if (spark) rows.push(`per-turn ${spark}`)
  }

  if (mode === "fancy" && fields.speedline) {
    const spark = sparkline(t.tpsPerTurn)
    if (spark) rows.push(`speed ${spark}`)
  }

  return rows
}

export function parseConfig(options: Record<string, unknown> | undefined): { mode: Mode; fields: Fields } {
  const opts = options ?? {}
  const mode: Mode = opts.mode === "simple" ? "simple" : "fancy"
  const fields: Fields = { ...DEFAULT_FIELDS }
  const raw = opts.fields
  if (raw && typeof raw === "object") {
    for (const key of Object.keys(DEFAULT_FIELDS) as (keyof Fields)[]) {
      const value = (raw as Record<string, unknown>)[key]
      if (typeof value === "boolean") fields[key] = value
    }
  }
  return { mode, fields }
}
