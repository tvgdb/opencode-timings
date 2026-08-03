import { describe, expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2"
import {
  bar,
  buildRows,
  computeTiming,
  DEFAULT_FIELDS,
  EMPTY,
  type Fields,
  fmtDuration,
  fmtTokens,
  fmtTps,
  parseConfig,
  sparkline,
  SPARK_POINTS,
  type Timing,
} from "../src/timing.ts"

// computeTiming only reads role, time.{created,completed}, and tokens; build
// minimal message-shaped objects rather than full SDK Message instances.
type Tok = { input?: number; output?: number; reasoning?: number; cacheRead?: number; cacheWrite?: number }
const asst = (created: number | undefined, completed: number | undefined, tok?: Tok): Message =>
  ({
    role: "assistant",
    time: { created, completed },
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
  }) as unknown as Message
const user = (created: number | undefined): Message =>
  ({ role: "user", time: { created } }) as unknown as Message

// All fields on, with optional per-test overrides — robust to future fields.
const fields = (overrides: Partial<Fields> = {}): Fields => ({ ...DEFAULT_FIELDS, ...overrides })
const NO_FIELDS = Object.fromEntries(Object.keys(DEFAULT_FIELDS).map((key) => [key, false])) as Fields
// Everything off except the named fields — for pinning down a single row.
const only = (overrides: Partial<Fields>): Fields => ({ ...NO_FIELDS, ...overrides })

describe("computeTiming", () => {
  test("empty input yields the empty timing", () => {
    expect(computeTiming([])).toEqual(EMPTY)
  })

  test("a session with no completed assistant turns yields empty", () => {
    expect(computeTiming([user(1000), asst(2000, undefined)])).toEqual(EMPTY)
  })

  test("a single turn computes api, wall, avg, slowest, and percent", () => {
    const t = computeTiming([user(1000), asst(2000, 5000)])
    expect(t.turns).toBe(1)
    expect(t.apiMs).toBe(3000)
    expect(t.wallMs).toBe(4000) // 5000 - 1000
    expect(t.avgMs).toBe(3000)
    expect(t.slowestMs).toBe(3000)
    expect(t.apiPct).toBe(75) // 3000/4000
    expect(t.durations).toEqual([3000])
  })

  test("multiple turns sum api, average, and track the slowest", () => {
    const t = computeTiming([asst(1000, 3000), asst(4000, 4500), asst(5000, 11000)])
    expect(t.turns).toBe(3)
    expect(t.apiMs).toBe(2000 + 500 + 6000)
    expect(t.slowestMs).toBe(6000)
    expect(t.avgMs).toBeCloseTo(8500 / 3)
    expect(t.durations).toEqual([2000, 500, 6000])
  })

  test("user messages extend wall-clock but are not counted as turns", () => {
    const t = computeTiming([asst(1000, 2000), user(10_000)])
    expect(t.turns).toBe(1)
    expect(t.apiMs).toBe(1000)
    expect(t.wallMs).toBe(9000) // 10000 - 1000
  })

  test("apiPct is clamped to 100 when summed turns overlap the wall span", () => {
    // Two overlapping 4s turns over a 5s wall span => 160% before clamping.
    const t = computeTiming([asst(1000, 5000), asst(2000, 6000)])
    expect(t.apiMs).toBe(8000)
    expect(t.wallMs).toBe(5000)
    expect(t.apiPct).toBe(100)
  })

  test("negative durations (completed before created) are ignored", () => {
    expect(computeTiming([asst(5000, 3000)])).toEqual(EMPTY)
  })

  test("an assistant turn with only a completed timestamp is not counted", () => {
    // created undefined => dur = completed - completed = 0, excluded; and with no
    // `created` anywhere, wall has no lower bound.
    expect(computeTiming([asst(undefined, 5000)])).toEqual(EMPTY)
  })

  test("tokens sum over completed turns and yield generation speeds", () => {
    const t = computeTiming([
      // 2s turn generating 400 tokens (output + reasoning) => 200 tok/s
      asst(1000, 3000, { input: 100, output: 300, reasoning: 100, cacheRead: 1000, cacheWrite: 50 }),
      // 4s turn generating 100 tokens => 25 tok/s
      asst(4000, 8000, { input: 200, output: 100, cacheRead: 2000 }),
    ])
    expect(t.tokensOut).toBe(500)
    expect(t.tokensIn).toBe(100 + 1000 + 50 + 200 + 2000)
    expect(t.tpsPerTurn).toEqual([200, 25])
    expect(t.avgTps).toBeCloseTo(500 / 6) // 500 tokens over 6s of api time
    expect(t.lastTps).toBe(25)
  })

  test("turns without token records still count for timing, at zero tokens", () => {
    const t = computeTiming([asst(1000, 2000), asst(3000, 4000, { output: 500 })])
    expect(t.turns).toBe(2)
    expect(t.tokensOut).toBe(500)
    expect(t.tpsPerTurn).toEqual([0, 500])
    expect(t.lastTps).toBe(500)
  })

  test("idle time between turns moves only wall and apiPct, nothing else", () => {
    const turns = [asst(1000, 3000, { output: 400, cacheRead: 1000 }), asst(10_000, 12_000, { output: 100 })]
    const base = computeTiming(turns)
    // Same turns, but the user walked away for an hour before their next message.
    const idle = computeTiming([...turns, user(3_600_000)])
    expect(idle.wallMs).toBeGreaterThan(base.wallMs)
    expect(idle.apiPct).toBeLessThan(base.apiPct)
    const exceptWall = ({ wallMs, apiPct, ...rest }: Timing) => rest
    expect(exceptWall(idle)).toEqual(exceptWall(base))
  })

  test("no metric reads the clock: an in-progress turn only extends wall via its start timestamp", () => {
    const turns = [asst(1000, 3000, { output: 400 })]
    const base = computeTiming(turns)
    // A turn that is still streaming (no completed) counts nowhere except the
    // session span — recomputing later without new messages changes nothing.
    const streaming = computeTiming([...turns, asst(50_000, undefined, { output: 900 })])
    expect(streaming.wallMs).toBe(49_000)
    const exceptWall = ({ wallMs, apiPct, ...rest }: Timing) => rest
    expect(exceptWall(streaming)).toEqual(exceptWall(base))
  })

  test("tokens on uncounted turns (incomplete or negative duration) are excluded", () => {
    const t = computeTiming([
      asst(1000, 2000, { output: 100 }),
      asst(5000, 3000, { output: 900 }), // negative duration
      asst(6000, undefined, { output: 900 }), // still streaming
    ])
    expect(t.tokensOut).toBe(100)
    expect(t.tpsPerTurn).toEqual([100])
  })
})

describe("fmtDuration", () => {
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
  ])("%d ms -> %s", (ms, expected) => {
    expect(fmtDuration(ms)).toBe(expected)
  })
})

describe("fmtTokens", () => {
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
  ])("%d -> %s", (n, expected) => {
    expect(fmtTokens(n)).toBe(expected)
  })
})

describe("fmtTps", () => {
  test.each([
    [0, "0"],
    [7.54, "7.5"],
    [9.96, "10"],
    [43.4, "43"],
    [199.9, "200"],
    [-3, "0"],
    [Number.NaN, "0"],
  ])("%d -> %s", (tps, expected) => {
    expect(fmtTps(tps)).toBe(expected)
  })
})

describe("bar", () => {
  test("renders filled/empty blocks proportional to percent", () => {
    expect(bar(0, 8)).toBe("░░░░░░░░")
    expect(bar(100, 8)).toBe("████████")
    expect(bar(78, 8)).toBe("██████░░") // round(6.24) = 6 filled
    expect(bar(50, 8)).toBe("████░░░░")
  })

  test("clamps out-of-range and non-finite percents", () => {
    expect(bar(150, 8)).toBe("████████")
    expect(bar(-10, 8)).toBe("░░░░░░░░")
    expect(bar(Number.NaN, 8)).toBe("░░░░░░░░")
  })
})

describe("sparkline", () => {
  test("empty input renders nothing", () => {
    expect(sparkline([])).toBe("")
  })

  test("a max value renders the tallest level, zero the shortest", () => {
    expect(sparkline([5])).toBe("█")
    expect(sparkline([0])).toBe("▁")
  })

  test("keeps only the most recent SPARK_POINTS values", () => {
    const many = Array.from({ length: SPARK_POINTS + 5 }, (_, i) => i + 1)
    expect([...sparkline(many)]).toHaveLength(SPARK_POINTS)
  })
})

describe("buildRows", () => {
  const t = computeTiming([
    asst(1000, 3000, { output: 400, cacheRead: 10_000 }),
    asst(4000, 4500, { output: 100, cacheRead: 12_000 }),
  ])

  test("fancy mode renders all enabled rows, each self-labeled", () => {
    const rows = buildRows(t, "fancy", fields())
    expect(rows[0]).toMatch(/^api\/wall [█░]+ \d+%$/) // gauge with bar
    expect(rows.some((r) => r.startsWith("api ") && r.includes("· wall "))).toBe(true)
    expect(rows.some((r) => r.startsWith("turns ") && r.includes("· avg "))).toBe(true)
    expect(rows.some((r) => r.startsWith("slowest "))).toBe(true)
    expect(rows.some((r) => r.startsWith("tok/s ") && r.includes("· last "))).toBe(true)
    expect(rows.some((r) => r.startsWith("tok in ") && r.includes("· out "))).toBe(true)
    expect(rows.some((r) => r.startsWith("per-turn "))).toBe(true)
    expect(rows.some((r) => r.startsWith("speed "))).toBe(true)
  })

  test("disabled fields drop their rows", () => {
    expect(buildRows(t, "fancy", NO_FIELDS)).toEqual([])
  })

  test("each field toggles exactly one value, dropping it from its shared line", () => {
    // api off, wall on: the times line carries wall only, no api, and no gauge.
    expect(buildRows(t, "fancy", only({ wall: true }))).toEqual([`wall ${fmtDuration(t.wallMs)}`])

    // wall off, api on: the times line carries api only — the gauge no longer
    // smuggles api in via a different field.
    expect(buildRows(t, "fancy", only({ api: true }))).toEqual([`api ${fmtDuration(t.apiMs)}`])

    // ratio on, everything else off: just the gauge.
    const ratioOnly = buildRows(t, "fancy", only({ ratio: true }))
    expect(ratioOnly).toHaveLength(1)
    expect(ratioOnly[0]).toMatch(/^api\/wall [█░]+ \d+%$/)
  })

  test("tps and lastTps drop individually from their shared line", () => {
    expect(buildRows(t, "fancy", only({ tps: true, lastTps: true }))).toEqual([
      `tok/s avg ${fmtTps(t.avgTps)} · last ${fmtTps(t.lastTps)}`,
    ])
    expect(buildRows(t, "fancy", only({ tps: true }))).toEqual([`tok/s avg ${fmtTps(t.avgTps)}`])
    expect(buildRows(t, "fancy", only({ lastTps: true }))).toEqual([`tok/s last ${fmtTps(t.lastTps)}`])
  })

  test("the tok out segment self-labels when tok in is disabled", () => {
    expect(buildRows(t, "fancy", only({ tokIn: true, tokOut: true }))).toEqual([
      `tok in ${fmtTokens(t.tokensIn)} · out ${fmtTokens(t.tokensOut)}`,
    ])
    expect(buildRows(t, "fancy", only({ tokOut: true }))).toEqual([`tok out ${fmtTokens(t.tokensOut)}`])
    expect(buildRows(t, "fancy", only({ tokIn: true }))).toEqual([`tok in ${fmtTokens(t.tokensIn)}`])
  })

  test("both sparkline rows are omitted when there are no turns", () => {
    expect(buildRows(EMPTY, "fancy", only({ sparkline: true, speedline: true }))).toEqual([])
  })

  test("simple mode mirrors fancy but drops the bar and the sparklines", () => {
    const rows = buildRows(t, "simple", fields())
    expect(rows[0]).toMatch(/^api\/wall \d+%$/) // ratio, no bar
    expect(rows.some((r) => /[█░]/.test(r))).toBe(false) // no gauge blocks anywhere
    expect(rows.some((r) => r.startsWith("api ") && r.includes("· wall "))).toBe(true)
    expect(rows.some((r) => r.startsWith("tok/s "))).toBe(true) // speeds render in simple too
    expect(rows.some((r) => r.startsWith("per-turn "))).toBe(false) // sparklines are fancy-only
    expect(rows.some((r) => r.startsWith("speed "))).toBe(false)
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

  test("individual boolean fields override, others keep their default", () => {
    expect(parseConfig({ fields: { api: false } }).fields).toEqual(fields({ api: false }))
    expect(parseConfig({ fields: { ratio: false } }).fields).toEqual(fields({ ratio: false }))
    expect(parseConfig({ fields: { tokOut: false, speedline: false } }).fields).toEqual(
      fields({ tokOut: false, speedline: false }),
    )
  })

  test("non-boolean field values and non-object fields are ignored", () => {
    expect(parseConfig({ fields: { api: "no" } }).fields.api).toBe(true)
    expect(parseConfig({ fields: "x" }).fields).toEqual(parseConfig(undefined).fields)
  })
})
