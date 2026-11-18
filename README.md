# opencode-timings

A tiny [OpenCode](https://opencode.ai) **TUI sidebar** plugin that shows
per-session timing and engineering telemetry — separating pure model inference,
tool I/O, human approval waits, cache/reasoning efficiency, latency percentiles,
TTFT, context pressure, and subagent work.

It renders into the same right-hand sidebar as the Quota / MCP / LSP / Todo /
Files panels, reading the session's messages and metadata directly from the
TUI's reactive state. Nothing is ever injected into the message stream, so there
is **zero context-window pollution**.

![The Timing panel in OpenCode's sidebar — api/wall 34%, api 19s · wall 56s, turns 5 · avg 4s, slowest 6s — sitting between the built-in Quota and LSP sections](https://raw.githubusercontent.com/foae/opencode-timings/main/opencode-timings-screenshot.png)

```
Timing
llm/wall █████░░░ 62%
llm 25s · wall 40s
tool 11s · calls 14 · err 1
turns 3 · steps 9 · avg 4s
p50 2s · p95 8s
slowest 19s · tool shell 7s
ttft avg 1.1s · last 820ms
tok/s avg 58 · last 64
tok in 1.2M · out 45k
cache 94% · think 61% (11s)
ctx 74% · cost $0.48 ($0.16/t)
wait 8s · compact 1
retry 2 · maxlen 1
sub 3 · 28s · 180k tok
per-turn ▄█▂▂
speed ▂▄█▆
```

Every row names itself, so there are no unlabeled numbers or glyphs to decode.
Core rows always render (reading zero before the first step); situational and
anomaly counters (`err`, `tool <name>`, `ttft`, `ctx`, `cost`, `wait`,
`compact`, `retry`, `maxlen`, `sub`) stay hidden while zero so normal sessions
stay compact.

## Metrics

| Row | Meaning |
|-----|---------|
| `llm/wall` | Share of session wall-clock spent in pure model inference, as a bar gauge and percent. |
| `llm` · `wall` | Pure assistant stream time (`time.streamed − time.created`, excluding tool settlement and prompts) vs. full session wall-clock span. |
| `tool` · `calls` · `err` | Merged wall-clock tool execution time (parallel calls coalesced), total tool calls, and tool error count (`err` hidden at 0). |
| `turns` · `steps` · `avg` | Completed user prompts, completed assistant steps (tool round-trips), and mean per-step `llm` duration. |
| `p50` · `p95` | Median and 95th-percentile per-step `llm` latency. |
| `slowest` · `tool <name>` | Slowest `llm` step and the single slowest local tool call (excluding `question` prompts and `subagent` delegation). |
| `ttft` | Time to first token (`avg` across sampled steps and `last` step), captured from live streaming events with a persisted fallback for reasoning/tool-first steps. |
| `tok/s` | True decode speed: generated tokens (output + reasoning) divided by `llm` time — unaffected by slow test suites or permission prompts. |
| `tok in` / `out` | Total tokens read (input + cache read/write) vs. generated (output + reasoning), lifted from `SessionInfo` on paginated >20-message sessions. |
| `cache` · `think` | Prompt-cache read hit rate (`cache.read / tok in`) and reasoning token share (`reasoning / tok out`, plus merged thinking duration when `>= 0.5s`). |
| `ctx` · `cost` | Post-compaction context window fill % (when model limit is known) and total USD spend with average spend per user turn (hidden on unpriced models). |
| `wait` · `compact` | Human stall time inside steps (permission dialogs + `question` prompts) and completed context compactions (both hidden at 0). |
| `retry` · `maxlen` | Provider retry backoffs and `finish === "length"` output truncations (both hidden at 0). |
| `sub` | Spawned subagent count, merged runtime, and descendant token total (hidden at 0). |
| `per-turn` | Sparkline of each recent step's `llm` duration (fancy mode). |
| `speed` | Sparkline of each recent step's `tok/s` (fancy mode). |

No metric reads `Date.now()` — everything derives from recorded message and
event timestamps, so idling between turns (or leaving a session open overnight)
moves only `wall` and `llm/wall` once the next message lands, and undoing turns
immediately updates every counter.

## Install

Add it to the `plugins` array of the **CLI** config that OpenCode loads
(`~/.config/opencode/cli.json`) — this is a CLI/TUI plugin, so it belongs in
`cli.json`, not `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["@foae/opencode-timings@latest"]
}
```

Or install it via the OpenCode CLI:

```sh
opencode plugin add github:foae/opencode-timings
```

OpenCode installs the plugin and its dependencies with Bun at startup. Restart
OpenCode and open the session sidebar to see the `Timing` panel.

You can also pin a version, e.g. `@foae/opencode-timings@0.4.0`.

## Configuration

Pass options using the `{ "package": ..., "options": ... }` object form in `cli.json`:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    {
      "package": "@foae/opencode-timings@latest",
      "options": {
        "mode": "fancy",
        "fields": {
          "ratio": true, "llm": true, "wall": true,
          "tool": true, "toolCalls": true, "toolErr": true,
          "turns": true, "steps": true, "avg": true, "p50": true, "p95": true,
          "slow": true, "slowTool": true, "ttft": true, "lastTtft": true,
          "tps": true, "lastTps": true, "tokIn": true, "tokOut": true,
          "cache": true, "think": true, "ctx": true, "cost": true,
          "wait": true, "compact": true, "retry": true, "maxlen": true,
          "subagents": true, "sparkline": true, "speedline": true
        }
      }
    }
  ]
}
```

| Option   | Values | Default | Meaning |
|----------|--------|---------|---------|
| `mode`   | `"fancy"` \| `"simple"` | `"fancy"` | `fancy` draws the gauge bar on the `llm/wall` row and adds the two sparklines; `simple` is the same rows without the bar or sparklines. |
| `fields` | object of booleans | all `true` | Each toggles one value (`ratio`, `llm` [legacy alias: `api`], `wall`, `tool`, `toolCalls`, `toolErr`, `turns`, `steps`, `avg`, `p50`, `p95`, `slow`, `slowTool`, `ttft`, `lastTtft`, `tps`, `lastTps`, `tokIn`, `tokOut`, `cache`, `think`, `ctx`, `cost`, `wait`, `compact`, `retry`, `maxlen`, `subagents`, `sparkline`, `speedline` — the last two are fancy-only). Values sharing a line drop out individually. |

With no options (a plain `"@foae/opencode-timings@latest"` string), it defaults to `fancy` mode with all fields shown.

## Requirements

- OpenCode `2.x` (uses the OpenCode v2 CLI plugin API `@opencode/plugin/tui`).

## Development

Built and run with [Bun](https://bun.sh).

- `src/timing.ts` — pure timing math, formatting, and config parsing (no JSX), unit-tested.
- `src/tui.tsx` — the SolidJS sidebar component and the slot registration.

```sh
bun install
bun run typecheck   # tsc --noEmit
bun test            # unit tests for the pure logic in src/timing.ts
bun run compile     # compile src/ to dist/ with babel-preset-solid
```

The package ships `dist/tui.js`, pre-compiled with `babel-preset-solid`
(universal renderer, `moduleName: "@opentui/solid"`). Shipping raw `.tsx` no
longer works: OpenCode installs plugins under a `node_modules` path, and since
`@opentui/solid` 0.4.x the host's Solid JSX transform skips `node_modules`, so
raw JSX gets compiled by Bun's plain (non-reactive) JSX runtime and the panel
renders once and never updates. The compiled output imports bare
`@opentui/solid` / `solid-js` specifiers, which the host maps onto its own
shared runtime instances.

`opentui`, `solid-js`, and the OpenCode plugin/SDK are **peer dependencies** — at runtime they come from the OpenCode host so the plugin shares its renderer; the `devDependencies` mirror them for local typecheck and tests.

## License

MIT — see [LICENSE](./LICENSE).
