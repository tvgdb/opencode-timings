import { describe, expect, test } from "bun:test"
import {
  bar,
  buildRows,
  computeTiming,
  DEFAULT_FIELDS,
  EMPTY,
  type Fields,
  fmtCost,
  fmtDuration,
  fmtLatency,
  fmtTokens,
  fmtTps,
  lastUsageModel,
  mergeIntervals,
  parseConfig,
  sparkline,
  SPARK_POINTS,
  type Timing,
  type TimingMessage,
  type TimingPart,
} from "../src/timing.ts"

type Tok = { input?: number; output?: number; reasoning?: number; cacheRead?: number; cacheWrite?: number }
type AsstOpts = {
  id?: string
  streamed?: number
  tok?: Tok
  content?: TimingPart[]
  cost?: number
  finish?: string
  retryAttempt?: number
  model?: { id?: string; providerID?: string }
}

const asst = (
  created: number | undefined,
  completed: number | undefined,
  tokOrOpts?: Tok | AsstOpts,
): TimingMessage => {
  const isOpts =
    tokOrOpts !== undefined &&
    ("streamed" in tokOrOpts ||
      "tok" in tokOrOpts ||
      "content" in tokOrOpts ||
      "cost" in tokOrOpts ||
      "finish" in tokOrOpts ||
      "retryAttempt" in tokOrOpts ||
      "model" in tokOrOpts ||
      "id" in tokOrOpts)
  const opts: AsstOpts = isOpts ? (tokOrOpts as AsstOpts) : { tok: tokOrOpts as Tok | undefined }
  const tok = opts.tok
  return {
    id: opts.id,
    type: "assistant",
    model: opts.model,
    finish: opts.finish,
    cost: opts.cost,
    ...(opts.retryAttempt !== undefined ? { retry: { attempt: opts.retryAttempt } } : {}),
    time: { created, streamed: opts.streamed, completed },
    content: opts.content,
    ...(tok
      ? {
          tokens: {
            input: tok.input ?? 0,
            output: tok.output ?? 0,
            reasoning: tok.reasoning ?? 0,
            cache: { read: tok.cacheRead ?? 0, write: tok.cacheWrite ?? 0 },
          },
        }
      : {}),
  }
}

const user = (created: number | undefined, id?: string): TimingMessage => ({
  id,
  type: "user",
  time: { created },
})

const fields = (overrides: Partial<Fields> = {}): Fields => ({ ...DEFAULT_FIELDS, ...overrides })
const NO_FIELDS = Object.fromEntries(Object.keys(DEFAULT_FIELDS).map((key) => [key, false])) as Fields
const only = (overrides: Partial<Fields>): Fields => ({ ...NO_FIELDS, ...overrides })

describe("mergeIntervals", () => {
  test("merges overlapping and nested intervals while ignoring invalid spans", () => {
    expect(mergeIntervals([])).toBe(0)
    expect(mergeIntervals([[500, 300]])).toBe(0)
    expect(
      mergeIntervals([
        [1000, 1400],
        [1100, 1300], // nested
        [1350, 1800], // overlapping -> [1000, 1800] = 800
        [2000, 2500], // disjoint -> +500
      ]),
    ).toBe(1300)
  })
})

describe("computeTiming", () => {
  test("empty input or no completed assistant steps yields EMPTY", () => {
    expect(computeTiming([])).toEqual(EMPTY)
    expect(computeTiming([user(1000), asst(2000, undefined)])).toEqual(EMPTY)
  })

  test("a single turn computes llm, wall, turns, steps, avg, p50, p95, slowest, and percent", () => {
    const t = computeTiming([user(1000), asst(2000, 5000)])
    expect(t.turns).toBe(1)
    expect(t.steps).toBe(1)
    expect(t.llmMs).toBe(3000)
    expect(t.wallMs).toBe(4000) // 5000 - 1000
    expect(t.avgMs).toBe(3000)
    expect(t.p50Ms).toBe(3000)
    expect(t.p95Ms).toBe(3000)
    expect(t.slowestMs).toBe(3000)
    expect(t.llmPct).toBe(75)
    expect(t.durations).toEqual([3000])
  })

  test("multiple steps compute exact p50 (odd & even) and p95", () => {
    const odd = computeTiming([asst(1000, 3000), asst(4000, 4500), asst(5000, 11000)])
    expect(odd.steps).toBe(3)
    expect(odd.llmMs).toBe(8500)
    expect(odd.p50Ms).toBe(2000) // sorted: [500, 2000, 6000]
    expect(odd.p95Ms).toBe(6000)
    expect(odd.slowestMs).toBe(6000)

    const even = computeTiming([
      asst(0, 1000),
      asst(2000, 4000),
      asst(5000, 9000),
      asst(10_000, 30_000),
    ])
    // sorted: [1000, 2000, 4000, 20000] -> median = (2000 + 4000) / 2 = 3000
    expect(even.p50Ms).toBe(3000)
    expect(even.p95Ms).toBe(20_000)
  })

  test("splits streamed llm time from parallel tools, subagents, question waits, and 2nd-tool/denied permission waits", () => {
    const t = computeTiming([
      user(0),
      // Step 1: 2s stream generating 200 tok (100 tok/s), then 2 overlapping tools (3.5s merged) + 1 failed tool
      asst(1000, 6515, {
        streamed: 3000,
        tok: { output: 200 },
        content: [
          { type: "tool", name: "read", state: { status: "completed" }, time: { created: 2500, ran: 3005, completed: 5005 } },
          { type: "tool", name: "shell", state: { status: "error" }, time: { created: 2600, ran: 4005, completed: 6505 } },
        ],
      }),
      // Step 2: fast auto-allowed read (15ms), THEN 10s permission prompt before shell runs (500ms)
      asst(7000, 18_520, {
        streamed: 8000,
        tok: { output: 50 },
        content: [
          { type: "tool", name: "read", state: { status: "completed" }, time: { created: 7800, ran: 8005, completed: 8020 } },
          { type: "tool", name: "shell", state: { status: "completed" }, time: { created: 7900, ran: 18_020, completed: 18_520 } },
        ],
      }),
      // Step 3: user takes 12s to click Deny on a permission prompt (`ran` stays undefined)
      asst(20_000, 33_000, {
        streamed: 21_000,
        content: [
          { type: "tool", name: "shell", state: { status: "error" }, time: { created: 20_900, completed: 33_000 } },
        ],
      }),
      // Step 4: `question` tool (15s human wait) + `subagent` tool (20s child run) do NOT inflate `toolMs` or `slowTool`
      asst(35_000, 71_010, {
        streamed: 36_000,
        content: [
          { type: "tool", name: "question", state: { status: "completed" }, time: { created: 35_900, ran: 36_005, completed: 51_005 } },
          { type: "tool", name: "subagent", state: { status: "completed" }, time: { created: 51_005, ran: 51_005, completed: 71_005 } },
        ],
      }),
    ])

    expect(t.llmMs).toBe(2000 + 1000 + 1000 + 1000)
    expect(t.toolMs).toBe(3500 + 515) // Step 1 merged [3005,6505]=3500 + Step 2 (15 + 500)=515
    expect(t.toolCalls).toBe(5) // excludes question & subagent
    expect(t.toolErr).toBe(2) // Step 1 shell + Step 3 denied shell
    expect(t.slowToolName).toBe("shell")
    expect(t.slowToolMs).toBe(2500) // subagent (20s) and question (15s) excluded
    expect(t.subCount).toBe(1)
    expect(t.subMs).toBe(20_000)
    // Step 1 jitter = 10ms (<250ms -> 0); Step 2 wait = 10520 - 515 = 10005ms; Step 3 denied = 12000ms; Step 4 question = 15010ms
    expect(t.waitMs).toBe(10_005 + 12_000 + 15_010)
    // True decode speed: 250 tok over 5s of llm time = 50 tok/s (unaffected by 55s of tools/waits/subagents)
    expect(t.avgTps).toBe(50)
  })

  test("same-millisecond stream completion (created === streamed < completed) stays finite", () => {
    const t = computeTiming([
      asst(1000, 2500, {
        streamed: 1000,
        tok: { output: 120 },
        content: [{ type: "tool", name: "read", state: { status: "completed" }, time: { created: 1000, ran: 1005, completed: 2495 } }],
      }),
    ])
    expect(t.steps).toBe(1)
    expect(t.llmMs).toBe(0)
    expect(t.avgTps).toBe(0)
    expect(t.lastTps).toBe(0)
    expect(Number.isFinite(t.avgTps)).toBe(true)
  })

  test("llmPct is clamped to 100 when summed steps overlap the wall span", () => {
    const t = computeTiming([asst(1000, 5000), asst(2000, 6000)])
    expect(t.llmMs).toBe(8000)
    expect(t.wallMs).toBe(5000)
    expect(t.llmPct).toBe(100)
  })

  test("negative durations and missing start timestamps are ignored", () => {
    expect(computeTiming([asst(5000, 3000)])).toEqual(EMPTY)
    expect(computeTiming([asst(undefined, 5000)])).toEqual(EMPTY)
  })

  test("cache hit rate and reasoning overhead derive from tokens and reasoning spans", () => {
    const t = computeTiming([
      user(0),
      asst(1000, 5000, {
        tok: { input: 500, cacheRead: 9000, cacheWrite: 500, output: 200, reasoning: 800 },
        content: [
          { type: "reasoning", time: { created: 1200, completed: 3700 } },
          { type: "text" },
        ],
      }),
    ])
    expect(t.tokensIn).toBe(10_000)
    expect(t.cacheHitPct).toBe(90) // 9000 / 10000
    expect(t.tokensOut).toBe(1000)
    expect(t.thinkPct).toBe(80) // 800 / 1000
    expect(t.thinkMs).toBe(2500)
  })

  test("TTFT uses live map first, falls back to reasoning/tool at content[0], and skips text at content[0]", () => {
    const live = new Map<string, number>([["m1", 320]])
    const t = computeTiming(
      [
        // Live map wins over persisted content[0]
        asst(1000, 3000, { id: "m1", content: [{ type: "reasoning", time: { created: 1900, completed: 2500 } }] }),
        // Cold fallback from content[0] tool
        asst(4000, 6000, { id: "m2", content: [{ type: "tool", name: "read", time: { created: 4680 } }] }),
        // content[0] is text -> must NOT fall back to content[1] tool's created timestamp
        asst(7000, 10_000, {
          id: "m3",
          content: [{ type: "text" }, { type: "tool", name: "read", time: { created: 9500 } }],
        }),
      ],
      { ttftByMessage: live },
    )
    expect(t.ttftSamples).toBe(2)
    expect(t.ttftAvgMs).toBe(500) // (320 + 680) / 2
    expect(t.ttftLastMs).toBe(680)
  })

  test("idle time and trailing unfinished user prompts move only wall and llmPct", () => {
    const baseMsgs = [
      user(500),
      asst(1000, 3000, { cost: 0.2, tok: { output: 400, cacheRead: 1000 } }),
      asst(10_000, 12_000, { cost: 0.1, tok: { output: 100 } }),
    ]
    const base = computeTiming(baseMsgs)
    const idle = computeTiming([...baseMsgs, user(3_600_000), asst(3_600_500, undefined, { tok: { output: 900 } })])
    expect(idle.wallMs).toBeGreaterThan(base.wallMs)
    expect(idle.llmPct).toBeLessThan(base.llmPct)
    const exceptWall = ({ wallMs, llmPct, ...rest }: Timing) => rest
    expect(exceptWall(idle)).toEqual(exceptWall(base))
  })

  test("revertMessageID slices all metrics and returns EMPTY if boundary precedes loaded page", () => {
    const msgs: TimingMessage[] = [
      user(0, "u1"),
      asst(1000, 3000, { id: "a1", cost: 0.1, tok: { input: 1000, output: 200 }, model: { providerID: "p", id: "m1" } }),
      user(4000, "u2"),
      asst(5000, 9000, { id: "a2", cost: 0.5, tok: { input: 50_000, output: 800 }, model: { providerID: "p", id: "m2" } }),
    ]
    const reverted = computeTiming(msgs, {
      revertMessageID: "u2",
      contextLimit: 100_000,
      // sessionTotals must NOT override while Undo is staged
      sessionTotals: { cost: 0.6, tokens: { input: 51_000, output: 1000 } },
    })
    expect(reverted.turns).toBe(1)
    expect(reverted.steps).toBe(1)
    expect(reverted.costUsd).toBeCloseTo(0.1)
    expect(reverted.ctxPct).toBe(1) // 1200 / 100_000 = 1.2% -> 1%
    expect(lastUsageModel(msgs, "u2")).toEqual({ providerID: "p", id: "m1" })
    expect(computeTiming(msgs, { revertMessageID: "older-than-page" })).toEqual(EMPTY)
  })

  test("sessionTotals lifts >20-message token and cost totals without distorting avgTps", () => {
    const msgs = [user(0), asst(1000, 3000, { cost: 0.05, tok: { input: 500, output: 200, cacheRead: 1500 } })]
    const t = computeTiming(msgs, {
      sessionTotals: {
        cost: 1.2,
        tokens: { input: 10_000, output: 8000, reasoning: 2000, cache: { read: 90_000, write: 0 } },
      },
    })
    expect(t.tokensIn).toBe(100_000)
    expect(t.cacheHitPct).toBe(90)
    expect(t.tokensOut).toBe(10_000)
    expect(t.thinkPct).toBe(20)
    expect(t.costUsd).toBe(1.2)
    // avgTps stays tied to the loaded step (200 tok / 2s = 100 tok/s), NOT 10_000 / 2s
    expect(t.avgTps).toBe(100)
  })

  test("context fill resets at completed compaction and tracks retries, maxlens, cost/turn, and subagent tokens", () => {
    const msgs: TimingMessage[] = [
      user(0),
      asst(1000, 3000, { cost: 0.4, tok: { input: 180_000, output: 2000 }, model: { providerID: "anthropic", id: "claude" } }),
      { type: "compaction", status: "completed", cost: 0.08, time: { created: 3500 } },
      user(4000),
      asst(5000, 7000, {
        cost: 0.12,
        finish: "length",
        tok: { input: 20_000, output: 4000, cacheRead: 26_000 },
        model: { providerID: "anthropic", id: "claude" },
        content: [{ type: "tool", name: "subagent", state: { status: "completed" }, time: { created: 6000, ran: 6000, completed: 6900 } }],
      }),
      // In-flight step with an active retry backoff
      asst(8000, undefined, { retryAttempt: 2 }),
    ]
    const t = computeTiming(msgs, { contextLimit: 200_000, retries: 3, subagentTokens: 42_000 })
    expect(t.compactions).toBe(1)
    expect(t.ctxPct).toBe(25) // post-compaction: (20k + 4k + 26k) / 200k = 25%
    expect(t.costUsd).toBeCloseTo(0.6) // 0.4 + 0.08 + 0.12
    expect(t.costPerTurnUsd).toBeCloseTo(0.3) // 0.6 / 2 user turns
    expect(t.retries).toBe(3)
    expect(t.maxlens).toBe(1)
    expect(t.subCount).toBe(1)
    expect(t.subTokens).toBe(42_000)
  })

  test("v2 type: 'assistant' and legacy role: 'assistant' messages compute identical timings", () => {
    const v2Messages: TimingMessage[] = [
      user(1000),
      asst(2000, 5000, { input: 100, output: 300, reasoning: 50, cacheRead: 500, cacheWrite: 25 }),
    ]
    const v1Messages: TimingMessage[] = [
      { role: "user", time: { created: 1000 } },
      {
        role: "assistant",
        time: { created: 2000, completed: 5000 },
        tokens: {
          input: 100,
          output: 300,
          reasoning: 50,
          cache: { read: 500, write: 25 },
        },
      },
    ]
    expect(computeTiming(v2Messages)).toEqual(computeTiming(v1Messages))
  })
})

describe("formatters", () => {
  test.each([
    [0, "0s"],
    [42_000, "42s"],
    [59_499, "59s"],
    [60_000, "1m00s"],
    [91_000, "1m31s"],
    [3_600_000, "1h00m"],
    [3_661_000, "1h01m"],
    [-5, "0s"],
    [Number.NaN, "0s"],
  ])("fmtDuration(%d) -> %s", (ms, expected) => {
    expect(fmtDuration(ms)).toBe(expected)
  })

  test.each([
    [0, "0ms"],
    [420, "420ms"],
    [1420, "1.4s"],
    [9960, "10s"],
    [-5, "0ms"],
  ])("fmtLatency(%d) -> %s", (ms, expected) => {
    expect(fmtLatency(ms)).toBe(expected)
  })

  test.each([
    [0, "$0.00"],
    [0.004, "<1¢"],
    [0.48, "$0.48"],
    [12.4, "$12"],
  ])("fmtCost(%d) -> %s", (usd, expected) => {
    expect(fmtCost(usd)).toBe(expected)
  })

  test.each([
    [0, "0"],
    [999, "999"],
    [1200, "1.2k"],
    [9949, "9.9k"],
    [9951, "10k"],
    [45_000, "45k"],
    [1_200_000, "1.2M"],
    [45_600_000, "46M"],
    [1_500_000_000, "1.5B"],
    [-5, "0"],
    [Number.NaN, "0"],
  ])("fmtTokens(%d) -> %s", (n, expected) => {
    expect(fmtTokens(n)).toBe(expected)
  })

  test.each([
    [0, "0"],
    [7.54, "7.5"],
    [9.96, "10"],
    [43.4, "43"],
    [199.9, "200"],
    [-3, "0"],
    [Number.NaN, "0"],
  ])("fmtTps(%d) -> %s", (tps, expected) => {
    expect(fmtTps(tps)).toBe(expected)
  })
})

describe("bar and sparkline", () => {
  test("bar renders proportional blocks and clamps out-of-range percents", () => {
    expect(bar(0, 8)).toBe("░░░░░░░░")
    expect(bar(100, 8)).toBe("████████")
    expect(bar(78, 8)).toBe("██████░░")
    expect(bar(150, 8)).toBe("████████")
    expect(bar(-10, 8)).toBe("░░░░░░░░")
    expect(bar(Number.NaN, 8)).toBe("░░░░░░░░")
  })

  test("sparkline handles empty input and caps at SPARK_POINTS", () => {
    expect(sparkline([])).toBe("")
    expect(sparkline([5])).toBe("█")
    expect(sparkline([0])).toBe("▁")
    const many = Array.from({ length: SPARK_POINTS + 5 }, (_, i) => i + 1)
    expect([...sparkline(many)]).toHaveLength(SPARK_POINTS)
  })
})

describe("buildRows", () => {
  const cleanSession = computeTiming([
    user(500),
    asst(1000, 3000, { output: 400, cacheRead: 10_000 }),
    asst(4000, 4500, { output: 100, cacheRead: 12_000 }),
  ])

  test("normal session renders core rows and suppresses zero anomaly rows", () => {
    const rows = buildRows(cleanSession, "fancy", fields())
    expect(rows[0]).toMatch(/^llm\/wall [█░]+ \d+%$/)
    expect(rows.some((r) => r.startsWith("llm ") && r.includes("· wall "))).toBe(true)
    expect(rows.some((r) => r === "tool 0s · calls 0")).toBe(true) // err 0 suppressed
    expect(rows.some((r) => r.startsWith("turns 1 · steps 2 · avg "))).toBe(true)
    expect(rows.some((r) => r.startsWith("p50 ") && r.includes("· p95 "))).toBe(true)
    expect(rows.some((r) => r.startsWith("cache ") && r.includes("· think "))).toBe(true)
    expect(rows.some((r) => r.includes("wait ") || r.includes("compact ") || r.includes("retry ") || r.includes("sub "))).toBe(false)
  })

  test("situational rows appear when non-zero and every standalone segment self-labels", () => {
    const rich = computeTiming(
      [
        { type: "compaction", status: "completed", time: { created: 0 } },
        user(500),
        asst(1000, 15_000, {
          id: "a1",
          streamed: 3000,
          cost: 0.48,
          finish: "length",
          tok: { input: 20_000, cacheRead: 80_000, output: 400, reasoning: 600 },
          content: [
            { type: "reasoning", time: { created: 1400, completed: 2600 } },
            { type: "tool", name: "shell", state: { status: "error" }, time: { created: 2900, ran: 8000, completed: 11_000 } },
            { type: "tool", name: "subagent", state: { status: "completed" }, time: { created: 11_000, ran: 11_000, completed: 15_000 } },
          ],
        }),
      ],
      { contextLimit: 200_000, retries: 2, subagentTokens: 50_000 },
    )

    expect(buildRows(rich, "fancy", only({ toolCalls: true }))).toEqual(["tool calls 1"])
    expect(buildRows(rich, "fancy", only({ toolErr: true }))).toEqual(["tool err 1"])
    expect(buildRows(rich, "fancy", only({ slowTool: true }))).toEqual(["slow tool shell 3s"])
    expect(buildRows(rich, "fancy", only({ lastTtft: true }))).toEqual(["ttft last 400ms"])
    expect(buildRows(rich, "fancy", only({ lastTps: true }))).toEqual([`tok/s last ${fmtTps(rich.lastTps)}`])
    expect(buildRows(rich, "fancy", only({ tokOut: true }))).toEqual([`tok out ${fmtTokens(rich.tokensOut)}`])
    expect(buildRows(rich, "fancy", only({ think: true }))).toEqual(["think 60% (1s)"])
    expect(buildRows(rich, "fancy", only({ ctx: true, cost: true }))).toEqual(["ctx 51% · cost $0.48 ($0.48/t)"])
    expect(buildRows(rich, "fancy", only({ wait: true, compact: true }))).toEqual(["wait 5s · compact 1"])
    expect(buildRows(rich, "fancy", only({ retry: true, maxlen: true }))).toEqual(["retry 2 · maxlen 1"])
    expect(buildRows(rich, "fancy", only({ subagents: true }))).toEqual(["sub 1 · 4s · 50k tok"])
    expect(buildRows(rich, "fancy", NO_FIELDS)).toEqual([])
  })

  test("simple mode mirrors fancy but drops the gauge bar and sparklines", () => {
    const rows = buildRows(cleanSession, "simple", fields())
    expect(rows[0]).toMatch(/^llm\/wall \d+%$/)
    expect(rows.some((r) => /[█░]/.test(r))).toBe(false)
    expect(rows.some((r) => r.startsWith("per-turn "))).toBe(false)
    expect(rows.some((r) => r.startsWith("speed "))).toBe(false)
  })

  test("EMPTY state renders zeroed core rows without sparklines or anomalies", () => {
    const rows = buildRows(EMPTY, "fancy", fields())
    expect(rows[0]).toBe("llm/wall ░░░░░░░░ 0%")
    expect(rows.some((r) => r.startsWith("per-turn "))).toBe(false)
  })
})

describe("parseConfig", () => {
  test("no options defaults to fancy with every field enabled", () => {
    expect(parseConfig(undefined)).toEqual({ mode: "fancy", fields: fields() })
  })

  test("mode 'simple' is honored; anything else falls back to fancy", () => {
    expect(parseConfig({ mode: "simple" }).mode).toBe("simple")
    expect(parseConfig({ mode: "facy" }).mode).toBe("fancy")
  })

  test("accepts legacy 'api' field key as an alias for 'llm' unless 'llm' is explicitly set", () => {
    expect(parseConfig({ fields: { api: false } }).fields.llm).toBe(false)
    expect(parseConfig({ fields: { api: false, llm: true } }).fields.llm).toBe(true)
    expect(parseConfig({ fields: { llm: false } }).fields.llm).toBe(false)
  })

  test("non-boolean field values and non-object fields are ignored", () => {
    expect(parseConfig({ fields: { llm: "no" } }).fields.llm).toBe(true)
    expect(parseConfig({ fields: "x" }).fields).toEqual(parseConfig(undefined).fields)
  })
})
