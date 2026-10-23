import { memo as _$memo } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
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
import { Plugin } from "@opencode/plugin/tui";
import { createEffect, createSignal, Index, onCleanup } from "solid-js";
import { buildRows, computeTiming, EMPTY, parseConfig } from "./timing.js";
const id = "opencode-timings";
const REFRESH_INTERVAL_MS = 15_000;
function SidebarTimingView(props) {
  const read = () => {
    try {
      const messages = props.context.data.session.message.list(props.sessionID) ?? [];
      return computeTiming(messages);
    } catch {
      return EMPTY;
    }
  };
  const [timing, setTiming] = createSignal(read());
  const refresh = () => setTiming(read());

  // Re-sync and re-read whenever the active session changes or reactive message store updates.
  createEffect(() => {
    const sessionID = props.sessionID;
    refresh();
    void Promise.resolve(props.context.data.session.message.sync(sessionID)).then(() => refresh()).catch(() => {});
    const recovery = [setTimeout(refresh, 400), setTimeout(refresh, 1500), setTimeout(refresh, 4000)];
    onCleanup(() => {
      for (const timer of recovery) clearTimeout(timer);
    });
  });
  const interval = setInterval(refresh, REFRESH_INTERVAL_MS);

  // Refresh whenever server events arrive for this session.
  const stopListen = props.context.data.listen(event => {
    const details = event?.details;
    const eventSessionID = details?.sessionID ?? details?.info?.sessionID ?? details?.info?.id;
    if (!eventSessionID || eventSessionID === props.sessionID) {
      refresh();
    }
  });
  onCleanup(() => {
    clearInterval(interval);
    stopListen();
  });
  const rows = () => buildRows(timing(), props.mode, props.fields);
  return (() => {
    var _el$ = _$createElement("box"),
      _el$2 = _$createElement("text"),
      _el$3 = _$createElement("b"),
      _el$5 = _$createElement("box");
    _$insertNode(_el$, _el$2);
    _$insertNode(_el$, _el$5);
    _$setProp(_el$, "gap", 0);
    _$insertNode(_el$2, _el$3);
    _$insertNode(_el$3, _$createTextNode(`Timing`));
    _$setProp(_el$5, "gap", 0);
    _$insert(_el$5, _$createComponent(Index, {
      get each() {
        return rows();
      },
      children: row => (() => {
        var _el$6 = _$createElement("text");
        _$setProp(_el$6, "wrapMode", "none");
        _$insert(_el$6, () => row() || " ");
        _$effect(_$p => _$setProp(_el$6, "fg", props.context.theme.text.muted, _$p));
        return _el$6;
      })()
    }));
    _$effect(_$p => _$setProp(_el$2, "fg", props.context.theme.text.base, _$p));
    return _el$;
  })();
}
export default Plugin.define({
  id,
  setup(context) {
    const {
      mode,
      fields
    } = parseConfig(context.options);
    return context.ui.slot({
      append: "sidebar.content",
      render: ({
        sessionID
      }) => _$createComponent(SidebarTimingView, {
        context: context,
        sessionID: sessionID,
        mode: mode,
        fields: fields
      })
    });
  }
});