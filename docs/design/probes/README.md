# Probes

Throwaway scripts behind the evidence in the design docs. None of them ships. Results are recorded in the docs, so rerun one only to change a question.

To rerun, copy `src`, `scripts`, `test/helpers`, `test/fixtures`, `package.json` and `tsconfig.json` to `/tmp/ccb-probe/wt`, symlink `node_modules`, apply `instrumentation.patch` there, and copy this folder's scripts to `/tmp/ccb-probe`. Paths are hard-coded to that layout and to this worktree. Set `XDG_STATE_HOME=/tmp/ccb-probe/state`. Nothing touches the repo or the real daemon, except where noted.

| Script | Question |
|---|---|
| `p5.mts` | Frame runs back to exact ANSI; every built-in source on; `shell`, `file` and `env` carried in the payload. Set `PROBE_CONFIG`, `PROBE_TAG`, and `PROBE_ALL`, `PROBE_VARS`, `PROBE_NO_TODAY`, `PROBE_NO_PR` as needed |
| `p6.mts` | Which files each click verb writes, through an isolated bar |
| `p7.mts` | A click routed through one isolated daemon to another |
| `p8.mts` | A lone Draw's memory and cost, and any disk or process calls during draws. Records `frames.json` |
| `p9.mjs` | What a control client on one session hears about another. Run with plain `node`; it uses its own `-L` tmux socket, and writes to `/tmp/ccb-osc`, which must exist |
| `p10.mjs` | A global hook carrying facts onto a control client's stream. Run with plain `node`; it uses its own `-L` tmux socket |
| `sse.mjs`, `ws.mjs` | Recorded frames to a real page over SSE and over a hand-written WebSocket |
| `api.json5`, `empty.json5`, `sparkle.json5` | Configs: every source kind, the bundled default, sparkle |
| `float.swift` | The floating WebKit panel |

`p7.mts` must start its daemons from the patched copy. `test/helpers` defaults to the current directory, so it passes its own entry.

`instrumentation.patch` adds hooks to the copy: segments and strip items captured in `draw`, every built-in source forced on, sources carried in the payload, and the `to` route with an `attach` frame.

The handler test ran `open 'cc-candybar://to/probe-renderer/set-state/x'` against the real handler and live daemon. It changes nothing, and the daemon logs one refused click.
