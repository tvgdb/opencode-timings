/**
 * Publish-time build: compile `src/` to `dist/` with babel-preset-solid.
 *
 * OpenCode installs npm TUI plugins under a `node_modules` path, and since
 * @opentui/solid 0.4.x the host's Solid JSX transform explicitly skips
 * node_modules — raw `.tsx` shipped to the host is compiled by Bun's plain
 * automatic JSX runtime instead, which evaluates every `{expr}` once and
 * produces a completely non-reactive (frozen) panel. So the package must ship
 * pre-compiled JS whose reactivity was baked in by babel-preset-solid, with
 * bare `@opentui/solid` / `solid-js` imports that the host's runtime plugin
 * maps onto its own shared instances (same preset + options as the host's own
 * transform, and the same layout working plugins like @slkiser/opencode-quota
 * ship).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { transformAsync } from "@babel/core"
// @ts-expect-error - Types not important.
import ts from "@babel/preset-typescript"
// @ts-expect-error - Types not important.
import solid from "babel-preset-solid"

const root = new URL("..", import.meta.url).pathname

async function compile(file: string, withSolid: boolean): Promise<string> {
  const source = await Bun.file(`${root}src/${file}`).text()
  const out = await transformAsync(source, {
    filename: `${root}src/${file}`,
    configFile: false,
    babelrc: false,
    presets: [...(withSolid ? [[solid, { moduleName: "@opentui/solid", generate: "universal" }]] : []), [ts]],
  })
  if (!out?.code) throw new Error(`babel produced no output for src/${file}`)
  // Babel does not rewrite import specifiers; dist ships .js next to .js.
  return out.code.replaceAll(`"./timing.ts"`, `"./timing.js"`)
}

const tui = await compile("tui.tsx", true)
const timing = await compile("timing.ts", false)

// The whole point of this build is reactive output that borrows the host's
// runtime — fail the publish if either property is missing.
if (/<(box|text|Index)\b/.test(tui)) throw new Error("dist/tui.js still contains raw JSX")
if (!tui.includes(`from "@opentui/solid"`)) throw new Error("dist/tui.js does not import the @opentui/solid runtime")
if (timing.includes("@opencode")) throw new Error("dist/timing.js retained a type-only SDK import")

rmSync(`${root}dist`, { recursive: true, force: true })
mkdirSync(`${root}dist`)
writeFileSync(`${root}dist/tui.js`, tui)
writeFileSync(`${root}dist/timing.js`, timing)
console.log("built dist/tui.js and dist/timing.js")
