# opencode-timings

Guidance for AI coding agents working with code in this repository.

## What this is

An [OpenCode](https://opencode.ai) **TUI plugin** that renders a `Timing` panel into the session sidebar, showing per-session API/wall-clock timing derived purely from message timestamps. Published to npm as `@foae/opencode-timings`. Two source files: `src/timing.ts` (pure logic) and `src/tui.tsx` (the Solid component + slot registration).

## Commands

- `bun run typecheck` — `tsc --noEmit` over `src` and `test`.
- `bun test` — runs the unit tests in `test/` (Bun's built-in runner). A single file: `bun test test/timing.test.ts`; a single case: `bun test -t "<name substring>"`.
- `bun run build` — `scripts/build.ts`: compiles `src/` to `dist/` with babel-preset-solid (see Packaging).
- `bun run prepublishOnly` — typecheck + test + build; the publish gate. Runs automatically on `npm/bun publish`.

The package ships **compiled** `dist/tui.js`/`dist/timing.js` (see `files` + `exports` in `package.json`); `exports["./tui"]` points at `dist/tui.js`. Runtime is Bun, not Node. Typecheck + tests are the local gates. End-to-end verification IS possible on this machine: drive `opencode` inside `tmux` (`tmux new-session -d -s x 'cd <scratch-dir> && opencode'`, `tmux send-keys`, `tmux capture-pane -p`) after copying a freshly built `dist/` into the installed cache at `~/.cache/opencode/packages/@foae/opencode-timings@latest/node_modules/@foae/opencode-timings/`.

## Architecture

Two files, deliberately split so the math is testable without the rendering runtime:

- **`src/timing.ts` — pure, JSX-free, unit-tested.** All metric computation (`computeTiming`), formatting (`fmtDuration`, `bar`, `sparkline`), row assembly (`buildRows`), and config parsing (`parseConfig`). It imports only a *type* from the SDK, so it loads under plain `bun test` with no opentui/Solid preload. Put new logic here, not in `tui.tsx`, and cover it in `test/timing.test.ts`.
- **`src/tui.tsx` — the Solid component + plugin registration.** Imports everything pure from `./timing.ts` and adds only the `SidebarTimingView` component, the event/timer wiring, and `api.slots.register`.

Key facts that aren't obvious from a single read:

- **SolidJS, not React.** `jsxImportSource` is `@opentui/solid` (set in both `tsconfig.json` and the `@jsxImportSource` pragma). Reactive values are *accessor functions* (`timing()`, `rows()`); elements are lowercase opentui intrinsics (`<box>`, `<text>`), not DOM. Lists use `<Index>`/`<For>`, not `.map()` (which recreates rather than reconciles). Plugin API types live in `node_modules/@opencode-ai/plugin/dist/tui.d.ts` — consult `TuiPluginApi` / `TuiState` / `TuiHostSlotMap` there.

- **Entry shape.** Default export is a `TuiPluginModule` (`{ id, tui }`). `tui(api, options)` calls `api.slots.register({ order, slots: { sidebar_content(...) } })`. `SIDEBAR_ORDER = 155` places it just below the built-in Quota panel (order 150) and above the variable-height MCP/LSP/Todo/Files sections.

- **Zero context-window pollution** is the core design constraint. The panel only *reads* session messages via `api.state.session.messages(sessionID)` and computes client-side. It must **never** inject into the message stream — preserve this when changing data sources.

- **Metrics (`computeTiming`).** Derived from `msg.time.created` / `msg.time.completed`:
  - `api` = sum of `completed − created` over completed **assistant** messages (inference time). Only counted when `dur > 0`, which also discards negative (clock-skew) and missing-`created` rows.
  - `wall` = span from earliest to latest timestamp across all messages (includes user read/think time).
  - `apiPct` is **clamped to 0–100**: summed per-turn inference over a single wall span can exceed 100% with overlapping/retried records or clock skew, so the percent and the gauge bar both clamp.
  - Also `turns`, `avg`, `slowest`, and a per-turn `durations` array for the sparkline.

- **Refresh model.** Event-driven via `api.event.on` for `message.updated`, `message.removed`, `session.updated`, `session.idle`. **The per-event property paths intentionally differ** — `message.updated`/`session.updated` carry a nested `info` object (`info.sessionID` / `info.id`, no top-level `sessionID`), while `message.removed`/`session.idle` carry `sessionID` directly. This matches the SDK event types; do **not** "standardize" them to `properties.sessionID` (it's `undefined` for two of the four and silently breaks refresh). A `createEffect` on `props.sessionID` re-reads on session switch and re-arms the async-hydration recovery `setTimeout`s (400/1500/4000ms) per session; a 15s `setInterval` is a low-frequency backstop. `read()` is wrapped in try/catch (returns `EMPTY`) because `api.state` can throw mid-read if a session is torn down. All timers/listeners are torn down via `onCleanup`.

- **Config.** `parseConfig` reads the tuple-form options (`["@foae/opencode-timings", { mode, fields }]`): `mode` is `"fancy"` (default) or `"simple"`; `fields` toggles individual values (`ratio`, `api`, `wall`, `turns`, `avg`, `slow`, `sparkline`), all defaulting `true`. **Each field gates exactly one value** — `buildRows` packs related values (`api`/`wall`, `turns`/`avg`) onto shared lines with `packRow`, dropping each independently, so the field-to-value mapping stays clean. `ratio` is the `api/wall` gauge (bar + percent in fancy, percent only in simple); `sparkline` is fancy-only. `parseConfig` iterates `DEFAULT_FIELDS`, so adding a field there is enough to make it parseable. Unknown/malformed options fall back to defaults rather than throwing.

## Packaging

- **Ship compiled `dist/`, never raw `.tsx`.** OpenCode installs npm plugins under `~/.cache/opencode/packages/<spec>/node_modules/...`, and since `@opentui/solid` 0.4.x (OpenCode 1.18.x) the host's Solid JSX transform has a filter that **excludes `node_modules`** — raw `.tsx` falls back to Bun's plain automatic JSX runtime, which evaluates `{expr}` children eagerly exactly once: the panel renders its mount-time snapshot (all zeros) and never updates, with no error anywhere. `scripts/build.ts` therefore pre-compiles with `babel-preset-solid` (`generate: "universal"`, `moduleName: "@opentui/solid"` — the same preset+options the host's own transform uses) and asserts the output is JSX-free and imports the `@opentui/solid` runtime. This matches how other working TUI plugins (e.g. `@slkiser/opencode-quota`) ship.
- **Bare `@opentui/solid` / `solid-js` imports in `dist` are mapped to the host's instances at load time** by OpenCode's Bun runtime plugin (`ensureRuntimePluginSupport` registers exact-specifier resolvers), so the compiled code shares the host's reactive runtime even though npm also installs local copies of the peers into the plugin's `node_modules`.
- **`@opentui/core`, `@opentui/solid`, `solid-js` are `peerDependencies`** (with `devDependencies` mirrors for typecheck/test/build). Keep the peer ranges aligned with the host. Do not move these to `dependencies` (forks the Solid/opentui runtime).
- `@opencode-ai/plugin` and `@opencode-ai/sdk` are **type-only** imports (erased at runtime) — they stay in dev/peer deps, never `dependencies`.

## Conventions

- Keep rendering robust to empty/partial state — every path must produce a valid panel (reading zeros) before the first turn. `EMPTY` is the canonical zero state.
- Every sidebar row is self-labeling (no bare numbers/glyphs). The header comment in `src/tui.tsx`, the metric doc in `src/timing.ts`, and the README's Metrics table must stay in sync with rendered output — update all when changing rows.
