# opencode-timings

Guidance for AI coding agents working with code in this repository.

## What this is

An [OpenCode](https://opencode.ai) **CLI/TUI plugin** that renders a `Timing` panel into the session sidebar, showing per-session API/wall-clock timing derived purely from message timestamps. Published to npm as `@foae/opencode-timings`. Two source files: `src/timing.ts` (pure logic) and `src/tui.tsx` (the Solid component + slot registration).

## Commands

- `bun run typecheck` — `tsc --noEmit` over `src` and `test`.
- `bun test` — runs the unit tests in `test/` (Bun's built-in runner). A single file: `bun test test/timing.test.ts`; a single case: `bun test -t "<name substring>"`.
- `bun run compile` — `scripts/build.ts`: compiles `src/` to `dist/` with babel-preset-solid (see Packaging).
- `bun run prepublishOnly` — typecheck + test + compile; the publish gate. Runs automatically on `npm/bun publish`.

The package ships **compiled** `dist/tui.js`/`dist/timing.js` (see `files` + `exports` in `package.json`); `exports["./tui"]` points at `dist/tui.js`. Runtime is Bun, not Node. Typecheck + tests are the local gates. End-to-end verification IS possible on this machine: drive `opencode` inside `tmux` (`tmux new-session -d -s x 'cd <scratch-dir> && opencode'`, `tmux send-keys`, `tmux capture-pane -p`) after copying a freshly built `dist/` into the installed cache under `~/.cache/opencode/npm/`.

## Architecture

Two files, deliberately split so the math is testable without the rendering runtime:

- **`src/timing.ts` — pure, JSX-free, unit-tested.** All metric computation (`computeTiming`), formatting (`fmtDuration`, `bar`, `sparkline`), row assembly (`buildRows`), and config parsing (`parseConfig`). It defines a minimal structural `TimingMessage` type with zero external runtime or SDK version coupling, so it loads under plain `bun test` with no opentui/Solid preload. Put new logic here, not in `tui.tsx`, and cover it in `test/timing.test.ts`.
- **`src/tui.tsx` — the Solid component + plugin registration.** Imports everything pure from `./timing.ts` and adds only the `SidebarTimingView` component, the event/timer/sync wiring, and `Plugin.define` with `context.ui.slot({ append: "sidebar.content" })`.

Key facts that aren't obvious from a single read:

- **SolidJS, not React.** `jsxImportSource` is `@opentui/solid` (set in both `tsconfig.json` and the `@jsxImportSource` pragma). Reactive values are *accessor functions* (`timing()`, `rows()`); elements are lowercase opentui intrinsics (`<box>`, `<text>`), not DOM. Lists use `<Index>`/`<For>`, not `.map()` (which recreates rather than reconciles). Plugin API types live in `node_modules/@opencode/plugin/dist/tui/index.d.ts` and `context.d.ts` — consult `Plugin.define`, `Context`, `Data`, and `SlotMap` there. Theme colors use `context.theme.text.base` and `context.theme.text.muted`.

- **Entry shape.** Default export uses `Plugin.define({ id, setup(context) { ... } })` from `@opencode/plugin/tui`. `setup(context)` reads `context.options` and returns `context.ui.slot({ append: "sidebar.content", render: ({ sessionID }) => ... })`.

- **Zero context-window pollution** is the core design constraint. The panel only *reads* session messages via `context.data.session.message.list(sessionID)` (and synchronizes via `context.data.session.message.sync(sessionID)`) and computes client-side. It must **never** inject into the message stream — preserve this when changing data sources.

- **Metrics (`computeTiming`).** Derived from `msg.time.created` / `msg.time.completed`:
  - Identifies assistant messages via `msg.type === "assistant" || msg.role === "assistant"` (supporting both OpenCode v2 `SessionMessageInfo` and v1 test fixtures).
  - `api` = sum of `completed − created` over completed **assistant** messages (inference time). Only counted when `dur > 0`, which also discards negative (clock-skew) and missing-`created` rows.
  - `wall` = span from earliest to latest timestamp across all messages (includes user read/think time).
  - `apiPct` is **clamped to 0–100**: summed per-turn inference over a single wall span can exceed 100% with overlapping/retried records or clock skew, so the percent and the gauge bar both clamp.
  - Also `turns`, `avg`, `slowest`, token counters/rates, and per-turn `durations` / `tpsPerTurn` arrays for the sparklines.

- **Refresh model.** Event-driven via `context.data.listen` alongside reactive store reads in `createEffect`. A `createEffect` on `props.sessionID` re-reads on session switch, triggers `context.data.session.message.sync(sessionID)`, and re-arms the async-hydration recovery `setTimeout`s (400/1500/4000ms) per session; a 15s `setInterval` is a low-frequency backstop. `read()` is wrapped in try/catch (returns `EMPTY`) because session data reads can throw mid-read if a session is torn down. All timers/listeners are torn down via `onCleanup`.

- **Config.** Configured in `~/.config/opencode/cli.json` under `"plugins"` (`{ "package": "@foae/opencode-timings@latest", "options": { mode, fields } }`). `parseConfig` reads `context.options`: `mode` is `"fancy"` (default) or `"simple"`; `fields` toggles individual values (`ratio`, `api`, `wall`, `turns`, `avg`, `slow`, `tps`, `lastTps`, `tokIn`, `tokOut`, `sparkline`, `speedline`), all defaulting `true`. **Each field gates exactly one value** — `buildRows` packs related values (`api`/`wall`, `turns`/`avg`, `tps`/`lastTps`, `tokIn`/`tokOut`) onto shared lines with `packRow`, dropping each independently, so the field-to-value mapping stays clean. `ratio` is the `api/wall` gauge (bar + percent in fancy, percent only in simple); `sparkline` and `speedline` are fancy-only. `parseConfig` iterates `DEFAULT_FIELDS`, so adding a field there is enough to make it parseable. Unknown/malformed options fall back to defaults rather than throwing.

## Packaging

- **Ship compiled `dist/`, never raw `.tsx`.** OpenCode installs npm and git plugins under `~/.cache/opencode/npm/<id>/<rev>/node_modules/...`, and since `@opentui/solid` 0.4.x the host's Solid JSX transform has a filter that **excludes `node_modules`** — raw `.tsx` falls back to Bun's plain automatic JSX runtime, which evaluates `{expr}` children eagerly exactly once: the panel renders its mount-time snapshot (all zeros) and never updates, with no error anywhere. `scripts/build.ts` therefore pre-compiles with `babel-preset-solid` (`generate: "universal"`, `moduleName: "@opentui/solid"` — the same preset+options the host's own transform uses) and asserts the output is JSX-free and imports the `@opentui/solid` runtime. This matches how other working TUI plugins (e.g. `@slkiser/opencode-quota`) ship.
- **Name the compile script `compile` in `package.json` (keep `build`, `prepare`, `prepack`, `preinstall`, `install`, and `postinstall` out of `scripts`).** OpenCode v2's `@opencode/Npm` service runs `pacote` inside the compiled single-file `opencode` binary (`process.execPath`), where `pacote`'s `GitFetcher` triggers `/$bunfs/bin/npm-cli.js install` whenever any of those six script keys exist, failing git installs (`github:...`) with `NpmInstallFailedError: git dep preparation failed`.
- **Bare `@opentui/solid` / `solid-js` / `@opencode/plugin/tui` imports in `dist` are mapped to the host's instances at load time** by OpenCode's runtime resolver, so the compiled code shares the host's reactive runtime.
- **`@opencode/plugin`, `@opentui/core`, `@opentui/solid`, `solid-js` are `peerDependencies` marked `optional: true` in `peerDependenciesMeta`** (with `devDependencies` mirrors for typecheck/test/compile). Keep the peer ranges aligned with the host (`@opentui/* >= 0.6.6`, `solid-js >= 1.9.0`) and keep them in `peerDependencies` rather than `dependencies` so the Solid/opentui runtime stays unified and `Arborist` skips downloading a redundant host tree during plugin install.
- `src/timing.ts` has zero external imports (`scripts/build.ts` asserts `dist/timing.js` contains no `@opencode` references).

## Conventions

- Keep rendering robust to empty/partial state — every path must produce a valid panel (reading zeros) before the first turn. `EMPTY` is the canonical zero state.
- Every sidebar row is self-labeling (no bare numbers/glyphs). The header comment in `src/tui.tsx`, the metric doc in `src/timing.ts`, and the README's Metrics table must stay in sync with rendered output — update all when changing rows.
