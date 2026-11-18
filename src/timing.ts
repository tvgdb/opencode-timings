/**
 * Pure timing computation, formatting, and config parsing for the
 * opencode-timings panel — deliberately free of JSX and any OpenCode SDK or
 * opentui/solid import so it loads under `bun test` without a Solid preload and
 * passes the `scripts/build.ts` SDK-isolation check. Rendering lives in `tui.tsx`.
 *
 * Metrics (per session):
 *   - llm        pure assistant inference/streaming time: sum of
 *                (time.streamed - time.created), falling back to step duration
 *                minus tool/subagent/wait spans when `streamed` is absent.
 *   - wall       span from earliest to latest message timestamp (includes user
 *                reading/typing idle gaps between turns).
 *   - llmPct     llm's share of wall-clock, clamped to 0–100 for the gauge.
 *   - tool       wall-clock tool execution time (merged parallel intervals,
 *                excluding human `question` prompts and `subagent` child runs).
 *   - toolCalls / toolErr / slowTool  count, error count, and single slowest tool.
 *   - wait       human stall time inside steps (permission prompts + `question`).
 *   - turns / steps  completed user prompts vs completed assistant steps.
 *   - avg / p50 / p95 / slowest  per-step `llm` latency distribution.
 *   - ttftAvg / ttftLast  time-to-first-token across steps with live or
 *                part-level start timestamps.
 *   - tokensIn / tokensOut  input (+ cache read/write) vs output (+ reasoning).
 *   - cacheHitPct / thinkPct / thinkMs  prompt-cache read share and reasoning share/time.
 *   - avgTps / lastTps / tpsPerTurn  decode speed (`tokensOut / llm`), unaffected by slow tools.
 *   - ctxPct     current post-compaction context window fill percentage (when model limit is known).
 *   - costUsd / costPerTurnUsd  total session spend and spend per user turn.
 *   - compactions / retries / maxlens  context compactions, provider retries, max-token cuts.
 *   - subCount / subMs / subTokens  spawned subagent count, merged runtime, and child tokens.
 *
 * Determinism: nothing here reads the wall clock (`Date.now()`). Every metric
 * derives from recorded message/event timestamps, so idling between turns moves
 * only `wall` and `llmPct` once the next message lands.
 */

export type TimingToolPart = {
  type: "tool"
  name?: string
  state?: { status?: string }
  time?: {
    created?: number
    ran?: number
    completed?: number
  }
}

export type TimingReasoningPart = {
  type: "reasoning"
  time?: {
    created?: number
    completed?: number
  }
}

export type TimingPart = TimingToolPart | TimingReasoningPart | { type?: string }

export type TimingTokens = {
  input?: number
  output?: number
  reasoning?: number
  cache?: {
    read?: number
    write?: number
  }
}

export type TimingMessage = {
  id?: string
  type?: string
  role?: string
  status?: string
  finish?: string
  cost?: number
  retry?: { attempt?: number }
  model?: { id?: string; providerID?: string }
  time?: {
    created?: number
    streamed?: number
    completed?: number
  }
  tokens?: TimingTokens
  content?: ReadonlyArray<TimingPart>
}

export type TimingExtra = {
  /** Live-captured TTFT (ms) keyed by assistant message ID. */
  ttftByMessage?: ReadonlyMap<string, number>
  /** Retry count accumulated from `session.retry.scheduled` events. */
  retries?: number
  /** Staged Undo boundary (`SessionInfo.revert?.messageID`); messages from here on are excluded. */
  revertMessageID?: string
  /** Server-accumulated totals from `SessionInfo` so reopened >20-message sessions aren't undercounted. */
  sessionTotals?: { cost?: number; tokens?: TimingTokens }
  /** Context window limit (tokens) strictly matching `lastUsageModel`'s model. */
  contextLimit?: number
  /** Total tokens across descendant subagent sessions from `SessionInfo`. */
  subagentTokens?: number
}

// Narrower than simple-mode rows so "llm/wall ██████░░ 100%" fits one sidebar line.
export const BAR_WIDTH = 8
export const SPARK_POINTS = 12
export const SPARK_LEVELS = "▁▂▃▄▅▆▇█"

// Post-stream gaps shorter than 250ms are event-loop/IPC dispatch jitter between
// stream close and tool execution, not a human sitting on a permission dialog.
export const WAIT_THRESHOLD_MS = 250

export type Mode = "fancy" | "simple"

// Each field gates one displayed value; order matches top-to-bottom render order.
export type Fields = {
  ratio: boolean
  llm: boolean
  wall: boolean
  tool: boolean
  toolCalls: boolean
  toolErr: boolean
  turns: boolean
  steps: boolean
  avg: boolean
  p50: boolean
  p95: boolean
  slow: boolean
  slowTool: boolean
  ttft: boolean
  lastTtft: boolean
  tps: boolean
  lastTps: boolean
  tokIn: boolean
  tokOut: boolean
  cache: boolean
  think: boolean
  ctx: boolean
  cost: boolean
  wait: boolean
  compact: boolean
  retry: boolean
  maxlen: boolean
  subagents: boolean
  sparkline: boolean
  speedline: boolean
}

export const DEFAULT_FIELDS: Fields = {
  ratio: true,
  llm: true,
  wall: true,
  tool: true,
  toolCalls: true,
  toolErr: true,
  turns: true,
  steps: true,
  avg: true,
  p50: true,
  p95: true,
  slow: true,
  slowTool: true,
  ttft: true,
  lastTtft: true,
  tps: true,
  lastTps: true,
  tokIn: true,
  tokOut: true,
  cache: true,
  think: true,
  ctx: true,
  cost: true,
  wait: true,
  compact: true,
  retry: true,
  maxlen: true,
  subagents: true,
  sparkline: true,
  speedline: true,
}

export type Timing = {
  llmMs: number
  wallMs: number
  toolMs: number
  waitMs: number
  turns: number
  steps: number
  avgMs: number
  p50Ms: number
  p95Ms: number
  slowestMs: number
  llmPct: number
  durations: number[]
  toolCalls: number
  toolErr: number
  slowToolName: string
  slowToolMs: number
  ttftSamples: number
  ttftAvgMs: number
  ttftLastMs: number
  tokensIn: number
  tokensOut: number
  cacheHitPct: number
  thinkPct: number
  thinkMs: number
  avgTps: number
  lastTps: number
  tpsPerTurn: number[]
  ctxPct: number | null
  costUsd: number
  costPerTurnUsd: number
  compactions: number
  retries: number
  maxlens: number
  subCount: number
  subMs: number
  subTokens: number
}

export const EMPTY: Timing = {
  llmMs: 0,
  wallMs: 0,
  toolMs: 0,
  waitMs: 0,
  turns: 0,
  steps: 0,
  avgMs: 0,
  p50Ms: 0,
  p95Ms: 0,
  slowestMs: 0,
  llmPct: 0,
  durations: [],
  toolCalls: 0,
  toolErr: 0,
  slowToolName: "",
  slowToolMs: 0,
  ttftSamples: 0,
  ttftAvgMs: 0,
  ttftLastMs: 0,
  tokensIn: 0,
  tokensOut: 0,
  cacheHitPct: 0,
  thinkPct: 0,
  thinkMs: 0,
  avgTps: 0,
  lastTps: 0,
  tpsPerTurn: [],
  ctxPct: null,
  costUsd: 0,
  costPerTurnUsd: 0,
  compactions: 0,
  retries: 0,
  maxlens: 0,
  subCount: 0,
  subMs: 0,
  subTokens: 0,
}

// Numeric fields can be missing or negative on partial/skewed records despite SDK schemas.
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0)
const isFiniteTs = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
const isAssistant = (m: TimingMessage): boolean => m.type === "assistant" || m.role === "assistant"
const isUser = (m: TimingMessage): boolean => m.type === "user" || m.role === "user"

/**
 * Coalesce overlapping `[start, end]` spans so concurrent tool calls, parallel
 * subagents, or multi-part reasoning blocks report real wall time rather than
 * summing parallel work past 100% of the step span.
 */
export function mergeIntervals(intervals: ReadonlyArray<readonly [number, number]>): number {
  const valid = intervals.filter(([s, e]) => e > s)
  if (valid.length === 0) return 0
  if (valid.length === 1) return valid[0][1] - valid[0][0]
  const sorted = [...valid].sort((a, b) => a[0] - b[0])
  let total = 0
  let [curStart, curEnd] = sorted[0]
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i]
    if (s <= curEnd) {
      if (e > curEnd) curEnd = e
    } else {
      total += curEnd - curStart
      curStart = s
      curEnd = e
    }
  }
  return total + (curEnd - curStart)
}

function sliceBeforeRevert(
  messages: ReadonlyArray<TimingMessage>,
  revertMessageID: string | undefined,
): ReadonlyArray<TimingMessage> | null {
  if (!revertMessageID) return messages
  const idx = messages.findIndex((m) => m.id === revertMessageID)
  // OpenCode paginates messages newest-first (20/page): if a staged Undo targets
  // a message older than the loaded page, every loaded message is undone.
  return idx === -1 ? null : messages.slice(0, idx)
}

function findLastUsageAssistant(messages: ReadonlyArray<TimingMessage>): TimingMessage | undefined {
  let compactionIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type === "compaction" && messages[i].status === "completed") {
      compactionIdx = i
      break
    }
  }
  for (let i = messages.length - 1; i > compactionIdx; i--) {
    if (isAssistant(messages[i]) && messages[i].tokens !== undefined) return messages[i]
  }
  return undefined
}

/**
 * Model reference for the assistant step currently occupying the context window
 * (latest token-bearing step after the last completed compaction and before any
 * staged Undo). `tui.tsx` resolves `contextLimit` strictly against this model so
 * switching the prompt picker before the next turn never divides old tokens by a
 * different model's window size.
 */
export function lastUsageModel(
  messages: ReadonlyArray<TimingMessage>,
  revertMessageID?: string,
): { id: string; providerID: string } | undefined {
  const active = sliceBeforeRevert(messages, revertMessageID)
  if (!active) return undefined
  const step = findLastUsageAssistant(active)
  const id = step?.model?.id
  const providerID = step?.model?.providerID
  return id && providerID ? { id, providerID } : undefined
}

/** Compute all session timing and token counters from message history and optional live state. */
export function computeTiming(messages: ReadonlyArray<TimingMessage>, extra?: TimingExtra): Timing {
  const active = sliceBeforeRevert(messages, extra?.revertMessageID)
  if (!active || active.length === 0) return EMPTY

  let llmMs = 0
  let toolMs = 0
  let waitMs = 0
  let subMs = 0
  let thinkMs = 0
  let slowestMs = 0
  let minTs = Number.POSITIVE_INFINITY
  let maxTs = 0
  let toolCalls = 0
  let toolErr = 0
  let slowToolName = ""
  let slowToolMs = 0
  let ttftSamples = 0
  let ttftSumMs = 0
  let ttftLastMs = 0
  let msgTokensIn = 0
  let msgCacheRead = 0
  let msgTokensOut = 0
  let msgReasoning = 0
  let msgCostUsd = 0
  let compactions = 0
  let inFlightRetries = 0
  let maxlens = 0
  let subCount = 0
  let lastCompletedAssistantIdx = -1
  const durations: number[] = []
  const tpsPerTurn: number[] = []

  for (let idx = 0; idx < active.length; idx++) {
    const msg = active[idx]
    const created = msg.time?.created
    if (isFiniteTs(created)) {
      if (created < minTs) minTs = created
      if (created > maxTs) maxTs = created
    }

    if (msg.type === "compaction" && msg.status === "completed") {
      compactions++
      msgCostUsd += num(msg.cost)
      continue
    }

    if (!isAssistant(msg)) continue

    // OpenCode clears `assistant.retry` once a step resumes or settles, so live
    // retry totals come from `extra.retries`, while `msg.retry.attempt` catches
    // a backoff already in flight when the TUI attaches.
    if (typeof msg.retry?.attempt === "number" && msg.retry.attempt > 0) {
      inFlightRetries += msg.retry.attempt
    }

    const completed = msg.time?.completed
    if (!isFiniteTs(completed)) continue
    if (completed > maxTs) maxTs = completed

    const startTs = isFiniteTs(created) ? created : completed
    const stepDur = completed - startTs
    if (stepDur <= 0) continue

    lastCompletedAssistantIdx = idx

    const streamed = isFiniteTs(msg.time?.streamed) ? msg.time!.streamed : undefined
    const stepToolIntervals: [number, number][] = []
    const stepSubIntervals: [number, number][] = []
    const stepQuestionIntervals: [number, number][] = []
    const postStreamBusy: [number, number][] = []
    const stepReasonIntervals: [number, number][] = []

    if (msg.content) {
      for (const part of msg.content) {
        if (part.type === "reasoning" && "time" in part) {
          const rc = part.time?.created
          const re = part.time?.completed
          if (isFiniteTs(rc) && isFiniteTs(re) && re > rc) stepReasonIntervals.push([rc, re])
        } else if (part.type === "tool" && "time" in part) {
          const toolPart = part as TimingToolPart
          const ran = toolPart.time?.ran
          const te = toolPart.time?.completed
          const validSpan = isFiniteTs(ran) && isFiniteTs(te) && te > ran

          if (toolPart.name === "subagent") {
            // Child sessions run their own LLM + tool loops; keep them out of
            // local `toolMs` and `slowTool` so subagent delegation never masks
            // slow local shell/MCP tools.
            subCount++
            if (validSpan) {
              stepSubIntervals.push([ran, te])
              if (streamed !== undefined && te > streamed) postStreamBusy.push([Math.max(ran, streamed), te])
            }
          } else if (toolPart.name === "question") {
            // `question` blocks waiting on the human to read and answer, not on I/O.
            if (validSpan) stepQuestionIntervals.push([ran, te])
          } else {
            toolCalls++
            if (toolPart.state?.status === "error") toolErr++
            if (validSpan) {
              const callDur = te - ran
              stepToolIntervals.push([ran, te])
              if (streamed !== undefined && te > streamed) postStreamBusy.push([Math.max(ran, streamed), te])
              if (callDur > slowToolMs) {
                slowToolMs = callDur
                slowToolName = toolPart.name || "tool"
              }
            }
          }
        }
      }
    }

    const stepToolMs = mergeIntervals(stepToolIntervals)
    const stepSubMs = mergeIntervals(stepSubIntervals)
    const stepThinkMs = mergeIntervals(stepReasonIntervals)
    let stepLlmMs: number
    let stepWaitMs: number

    if (streamed !== undefined) {
      stepLlmMs = Math.max(0, Math.min(stepDur, streamed - startTs))
      // Subtracting active non-question tool/subagent spans from the post-stream
      // settlement window captures 1st-tool prompts, 2nd-tool prompts after fast
      // reads, denied prompts (where `ran` stays undefined), and `question` waits
      // in a single pass.
      const postStreamSpan = Math.max(0, completed - Math.max(startTs, streamed))
      const rawWait = Math.max(0, postStreamSpan - mergeIntervals(postStreamBusy))
      stepWaitMs = rawWait >= WAIT_THRESHOLD_MS ? rawWait : 0
    } else {
      stepWaitMs = mergeIntervals(stepQuestionIntervals)
      stepLlmMs = Math.max(0, stepDur - stepToolMs - stepSubMs - stepWaitMs)
    }

    llmMs += stepLlmMs
    toolMs += stepToolMs
    subMs += stepSubMs
    waitMs += stepWaitMs
    thinkMs += stepThinkMs
    durations.push(stepLlmMs)
    if (stepLlmMs > slowestMs) slowestMs = stepLlmMs

    let stepTtft = msg.id !== undefined ? extra?.ttftByMessage?.get(msg.id) : undefined
    if (stepTtft === undefined) {
      const first = msg.content?.[0]
      // Only `reasoning` and `tool` parts persist `time.created` on disk. Never
      // fall back when `content[0]` is `text`, because a later tool's `created`
      // timestamp would include the preceding text stream duration.
      if ((first?.type === "reasoning" || first?.type === "tool") && "time" in first) {
        const fc = first.time?.created
        if (isFiniteTs(fc) && fc >= startTs) stepTtft = fc - startTs
      }
    }
    if (isFiniteTs(stepTtft) && stepTtft >= 0) {
      ttftSumMs += stepTtft
      ttftLastMs = stepTtft
      ttftSamples++
    }

    const tok = msg.tokens
    const cacheRead = num(tok?.cache?.read)
    const inTok = num(tok?.input) + cacheRead + num(tok?.cache?.write)
    const reasoning = num(tok?.reasoning)
    const outTok = num(tok?.output) + reasoning

    msgTokensIn += inTok
    msgCacheRead += cacheRead
    msgTokensOut += outTok
    msgReasoning += reasoning
    // Guard `stepLlmMs === 0` (same-ms cached/mocked stream) so `tpsPerTurn` stays finite.
    tpsPerTurn.push(stepLlmMs > 0 ? (outTok * 1000) / stepLlmMs : 0)
    msgCostUsd += num(msg.cost)
    if (msg.finish === "length") maxlens++
  }

  const steps = durations.length
  if (steps === 0) return EMPTY

  // Only count user prompts that have at least one completed assistant reply so
  // typing or idling on an unfinished prompt moves `wall` without shifting `turns`.
  let turns = 0
  for (let i = 0; i < lastCompletedAssistantIdx; i++) {
    if (isUser(active[i])) turns++
  }

  const wallMs = minTs === Number.POSITIVE_INFINITY ? 0 : Math.max(0, maxTs - minTs)
  const sorted = [...durations].sort((a, b) => a - b)
  const mid = Math.floor(steps / 2)
  const p50Ms = steps % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  const p95Ms = sorted[Math.min(steps - 1, Math.ceil(0.95 * steps) - 1)]

  // Reopened >20-message sessions only load the latest page initially; lift
  // cumulative session totals from `SessionInfo` when no Undo is staged, while
  // keeping `avgTps` tied to `msgTokensOut / llmMs` for the loaded steps.
  let tokensIn = msgTokensIn
  let cacheReadTotal = msgCacheRead
  let tokensOut = msgTokensOut
  let reasoningTotal = msgReasoning
  let costUsd = msgCostUsd
  if (!extra?.revertMessageID && extra?.sessionTotals) {
    const st = extra.sessionTotals
    const totCacheRead = num(st.tokens?.cache?.read)
    const totIn = num(st.tokens?.input) + totCacheRead + num(st.tokens?.cache?.write)
    const totReason = num(st.tokens?.reasoning)
    const totOut = num(st.tokens?.output) + totReason
    if (totIn > tokensIn) {
      tokensIn = totIn
      cacheReadTotal = Math.max(cacheReadTotal, totCacheRead)
    }
    if (totOut > tokensOut) {
      tokensOut = totOut
      reasoningTotal = Math.max(reasoningTotal, totReason)
    }
    costUsd = Math.max(costUsd, num(st.cost))
  }

  let ctxPct: number | null = null
  const ctxLimit = num(extra?.contextLimit)
  if (ctxLimit > 0) {
    const usageStep = findLastUsageAssistant(active)
    if (usageStep?.tokens) {
      const u = usageStep.tokens
      const ctxTokens =
        num(u.input) + num(u.output) + num(u.reasoning) + num(u.cache?.read) + num(u.cache?.write)
      ctxPct = Math.min(100, Math.round((ctxTokens / ctxLimit) * 100))
    }
  }

  const denomTurns = turns || steps
  return {
    llmMs,
    wallMs,
    toolMs,
    waitMs,
    turns,
    steps,
    avgMs: llmMs / steps,
    p50Ms,
    p95Ms,
    slowestMs,
    // Summed per-step inference can exceed a single wall span on overlapping or
    // clock-skewed records; clamp so the gauge and percent stay 0–100.
    llmPct: wallMs > 0 ? Math.min(100, Math.round((llmMs / wallMs) * 100)) : 0,
    durations,
    toolCalls,
    toolErr,
    slowToolName,
    slowToolMs,
    ttftSamples,
    ttftAvgMs: ttftSamples > 0 ? ttftSumMs / ttftSamples : 0,
    ttftLastMs,
    tokensIn,
    tokensOut,
    cacheHitPct: tokensIn > 0 ? Math.min(100, Math.round((cacheReadTotal / tokensIn) * 100)) : 0,
    thinkPct: tokensOut > 0 ? Math.min(100, Math.round((reasoningTotal / tokensOut) * 100)) : 0,
    thinkMs,
    avgTps: llmMs > 0 ? (msgTokensOut * 1000) / llmMs : 0,
    lastTps: tpsPerTurn[tpsPerTurn.length - 1] ?? 0,
    tpsPerTurn,
    ctxPct,
    costUsd,
    costPerTurnUsd: costUsd > 0 ? costUsd / denomTurns : 0,
    compactions,
    retries: Math.max(num(extra?.retries), inFlightRetries),
    maxlens,
    subCount,
    subMs,
    subTokens: num(extra?.subagentTokens),
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

/** Sub-second-aware latency for TTFT: "420ms", "1.4s", "12s". */
export function fmtLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0ms"
  if (ms < 999.5) return `${Math.round(ms)}ms`
  if (ms < 9950) return `${(ms / 1000).toFixed(1)}s`
  return fmtDuration(ms)
}

/** Compact USD spend: "<1¢", "$0.48", "$12". */
export function fmtCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00"
  if (usd < 0.01) return "<1¢"
  if (usd < 9.995) return `$${usd.toFixed(2)}`
  return `$${Math.round(usd)}`
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

/** Render an ASCII block gauge of `width` characters for `pct` (0–100). */
export function bar(pct: number, width: number): string {
  const p = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0))
  const filled = Math.round((p / 100) * width)
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled))
}

/** Render up to the most recent `SPARK_POINTS` values as an 8-level sparkline. */
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

function packRow(...segments: string[]): string {
  return segments.filter(Boolean).join(" · ")
}

/**
 * Format enabled timing rows for the sidebar. Core rows always render (showing
 * zero before the first completed step); situational/anomaly segments (`toolErr`,
 * `slowTool`, `ttft`, `ctx`, `cost`, `wait`, `compact`, `retry`, `maxlen`,
 * `subagents`) stay hidden while zero/unknown so normal sessions stay compact.
 * When a leading segment on a shared line is disabled, the remaining segment
 * adopts the domain prefix so no row ever prints an unlabeled number.
 */
export function buildRows(t: Timing, mode: Mode, fields: Fields): string[] {
  const rows: string[] = []

  if (fields.ratio) {
    rows.push(mode === "fancy" ? `llm/wall ${bar(t.llmPct, BAR_WIDTH)} ${t.llmPct}%` : `llm/wall ${t.llmPct}%`)
  }

  const timesRow = packRow(
    fields.llm ? `llm ${fmtDuration(t.llmMs)}` : "",
    fields.wall ? `wall ${fmtDuration(t.wallMs)}` : "",
  )
  if (timesRow) rows.push(timesRow)

  const hasToolPrefix = fields.tool || fields.toolCalls
  const toolRow = packRow(
    fields.tool ? `tool ${fmtDuration(t.toolMs)}` : "",
    fields.toolCalls ? `${fields.tool ? "calls" : "tool calls"} ${t.toolCalls}` : "",
    fields.toolErr && t.toolErr > 0 ? `${hasToolPrefix ? "err" : "tool err"} ${t.toolErr}` : "",
  )
  if (toolRow) rows.push(toolRow)

  const countsRow = packRow(
    fields.turns ? `turns ${t.turns}` : "",
    fields.steps ? `steps ${t.steps}` : "",
    fields.avg ? `avg ${fmtDuration(t.avgMs)}` : "",
  )
  if (countsRow) rows.push(countsRow)

  const pctRow = packRow(
    fields.p50 ? `p50 ${fmtDuration(t.p50Ms)}` : "",
    fields.p95 ? `p95 ${fmtDuration(t.p95Ms)}` : "",
  )
  if (pctRow) rows.push(pctRow)

  const slowRow = packRow(
    fields.slow ? `slowest ${fmtDuration(t.slowestMs)}` : "",
    fields.slowTool && t.slowToolMs > 0
      ? `${fields.slow ? "tool" : "slow tool"} ${t.slowToolName} ${fmtDuration(t.slowToolMs)}`
      : "",
  )
  if (slowRow) rows.push(slowRow)

  if (t.ttftSamples > 0) {
    const ttftRow = packRow(
      fields.ttft ? `ttft avg ${fmtLatency(t.ttftAvgMs)}` : "",
      fields.lastTtft ? `${fields.ttft ? "last" : "ttft last"} ${fmtLatency(t.ttftLastMs)}` : "",
    )
    if (ttftRow) rows.push(ttftRow)
  }

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

  const thinkSuffix = t.thinkMs >= 500 ? ` (${fmtDuration(t.thinkMs)})` : ""
  const cacheThinkRow = packRow(
    fields.cache ? `cache ${t.cacheHitPct}%` : "",
    fields.think ? `think ${t.thinkPct}%${thinkSuffix}` : "",
  )
  if (cacheThinkRow) rows.push(cacheThinkRow)

  const ctxCostRow = packRow(
    fields.ctx && t.ctxPct !== null ? `ctx ${t.ctxPct}%` : "",
    fields.cost && t.costUsd > 0 ? `cost ${fmtCost(t.costUsd)} (${fmtCost(t.costPerTurnUsd)}/t)` : "",
  )
  if (ctxCostRow) rows.push(ctxCostRow)

  const waitCompactRow = packRow(
    fields.wait && t.waitMs > 0 ? `wait ${fmtDuration(t.waitMs)}` : "",
    fields.compact && t.compactions > 0 ? `compact ${t.compactions}` : "",
  )
  if (waitCompactRow) rows.push(waitCompactRow)

  const frictionRow = packRow(
    fields.retry && t.retries > 0 ? `retry ${t.retries}` : "",
    fields.maxlen && t.maxlens > 0 ? `maxlen ${t.maxlens}` : "",
  )
  if (frictionRow) rows.push(frictionRow)

  if (fields.subagents && t.subCount > 0) {
    const subTok = t.subTokens > 0 ? ` · ${fmtTokens(t.subTokens)} tok` : ""
    rows.push(`sub ${t.subCount} · ${fmtDuration(t.subMs)}${subTok}`)
  }

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

/** Parse plugin `options` from `cli.json`, falling back safely on unknown/malformed keys. */
export function parseConfig(options: Record<string, unknown> | undefined): { mode: Mode; fields: Fields } {
  const opts = options ?? {}
  const mode: Mode = opts.mode === "simple" ? "simple" : "fancy"
  const fields: Fields = { ...DEFAULT_FIELDS }
  const raw = opts.fields
  if (raw && typeof raw === "object") {
    const rawObj = raw as Record<string, unknown>
    for (const key of Object.keys(DEFAULT_FIELDS) as (keyof Fields)[]) {
      const value = rawObj[key]
      if (typeof value === "boolean") fields[key] = value
    }
    // Preserve 0.4.x `cli.json` configs that toggled `"api"` before `llm` was split from `tool`.
    if (typeof rawObj.llm !== "boolean" && typeof rawObj.api === "boolean") {
      fields.llm = rawObj.api
    }
  }
  return { mode, fields }
}
