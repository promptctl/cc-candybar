<div align="center">

# CCCandybar

**Powerline statusline for Claude Code — daemon-backed, config-driven, zero-config-file required.**

![License:MIT](https://img.shields.io/static/v1?label=License&message=MIT&color=blue&style=flat-square)
[![npm version](https://img.shields.io/npm/v/@promptctl/cc-candybar?style=flat-square)](https://www.npmjs.com/package/@promptctl/cc-candybar)
[![Dependencies](https://img.shields.io/badge/dependencies-zero-brightgreen)](https://www.npmjs.com/package/@promptctl/cc-candybar)

<img src="images/demo-tui.gif" alt="CCCandybar TUI Mode Demo" width="600"/>

</div>

## What it is

CCCandybar is a statusline renderer for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). It shows session cost, context usage, git status, model info, rate-limit utilization, and more, configured through a JSON5 DSL with hot-reloading.

A background daemon caches git state, usage data, and per-session values across concurrent Claude Code sessions. The renderer connects to the daemon over a Unix socket, so every invocation is fast (~50ms budget) and stateful.

## Quick start

```bash
pnpm dlx @promptctl/cc-candybar@latest install
```

npm is the only install channel: the GitHub releases are tags plus a changelog with no downloadable assets, and installing from a GitHub tag does not work (the built `dist/` is not committed).

pnpm 11 delays freshly published packages (`minimumReleaseAge`), so on or near a release day `@latest` can silently resolve to an older version. `install` compares what it staged against the registry and warns when it is behind; to get a specific release immediately, name it: `pnpm dlx @promptctl/cc-candybar@<version> install`.

That single command (re-run it any time to update to the latest release):

1. Stages the runtime at a stable path independent of any package-manager cache — `~/Library/Application Support/CCCandybar/` on macOS, `$XDG_DATA_HOME/cc-candybar/` on Linux — as `bin/cc-candybar` (the prebuilt native render binary for your platform, or a node entry where none exists) beside `dist/index.mjs` (the daemon + CLI bundle).
2. On macOS, builds `~/Applications/CCCandybarURLHandler.app` and registers the `cc-candybar://` URL scheme with Launch Services.
3. Writes the staged `bin/cc-candybar` path as the statusline command into `~/.claude/settings.json` (skipped with a notice if you've customized the command; `--force` overwrites).

Restart Claude Code. The statusline appears with the bundled default layout — an identity row (directory, gitaculous, toolbar) over a status row (model, context, cacheTimer, block, weekly, activity). On macOS, Cmd-clicking clickable cells fires `cc-candybar://` URL verbs that the daemon dispatches (via the URL handler registered in step 2).

## Customization

Drop a `.cc-candybar.json5` (or `.cc-candybar.json` — both extensions are accepted) at any of these locations (highest precedence first):

1. `$CC_CANDYBAR_CONFIG` in the statusline command's environment (literal path, supports `~` expansion). It is read by the client on every render and carried to the daemon, so it can differ per session. A path that names no file renders the bundled default under a `Config file not found` warning, and one the daemon cannot stat (behind an unsearchable directory, say) under `Config file could not be read` with the error — either way the bar stays live and loads the file once it can.
2. `<project>/.cc-candybar.json5` (then `.json` at the same location)
3. `<cwd>/.cc-candybar.json5` (then `.json`)
4. `$XDG_CONFIG_HOME/cc-candybar/config.json5` (then `.json`; defaults to `~/.config/cc-candybar/config.json5`)

JSON is a strict subset of JSON5, so the same parser handles both — `.json5` is the documented format (supports inline comments, trailing commas, unquoted keys), `.json` is the legacy/compat extension. When both exist at the same location, `.json5` wins and the bar shows a persistent warning so you can remove the shadowed duplicate.

The file **merges onto the bundled default**, so it declares only what differs. `globals` merge per field; the named sections (`variables`, `segments`, `actions`, `helpers`, …) merge by name, your entry winning; `root` merges per named row (`identity` and `status` in the bundled default; a whole tree at `root` replaces every row). The bundled default is `src/config/default-dsl-config.ts`, and fuller starting points live under `examples/`. Run `cc-candybar check <path>` to load a file exactly as the daemon will: exit 0 means it renders, exit 1 prints the error with the path and line to fix. Add `--render` and it prints the bar it rendered, so you can read a config's result without installing it.

<!-- The check:pass fence below is loaded by test/doc-snippets.test.ts through
     `cc-candybar check` — edit it and run that test, so the README example
     cannot drift from the loader. -->

```json5 check:pass
// A theme, one new segment, and the row it joins. Everything else — the
// identity row, every other segment and variable — is inherited.
{
  globals: { palette: 'catppuccin-mocha' },
  variables: {
    clock: { kind: 'time', layout: '15:04' }, // Go reference-time layout, re-read every second
  },
  segments: {
    clock: { template: '{{ .clock }}' },
  },
  root: { rows: { status: { h: ['model', 'context', 'clock'] } } },
}
```

Saving the file triggers a hot-reload of every active session.

## Architecture

```
┌─────────────┐   Unix socket   ┌──────────────────┐
│ Claude Code │ ──────────────► │ cc-candybar daemon│
│  (hook)     │   render req    │                  │
│             │ ◄────────────── │  git cache       │
└─────────────┘   ANSI output   │  usage cache     │
                                │  session state   │
                                │  render cache    │
                                └──────────────────┘
```

- **Daemon** (`src/daemon/`) — long-lived background process. One per user. Caches git state via filesystem watchers, usage data, and per-session key/value state. Runs until it exits on an RSS backstop (default 512 MB via `CC_CANDYBAR_RSS_LIMIT_MB`; the V8 heap cap the spawner passes is twice that, a margin wide enough that the graceful backstop fires first under any growth its 60 s poll can see) or the host restarts; there is no idle or age timeout.
- **Client** (`rust-client/src/main.rs`) — the Rust binary installed as `bin/cc-candybar`, and the only thing on the per-render path: it connects to the daemon, sends the hook JSON, and prints the ANSI response. On a daemon miss it spawns one detached and prints an empty line, so the next refresh finds a warm daemon. Every subcommand (`install`, `daemon`, `check`, `doctor`, …) execs the Node bundle at `dist/index.mjs`, which carries a socket relay of its own (`src/daemon/client.ts`) as the fallback when no native binary is staged.
- **Renderer** (`src/dsl/render.ts`) — `renderDsl` is the single render path; the daemon, the demo and the tests all call it. It walks the config's layout tree, evaluates each segment's templates against the daemon's payload, and hands the styled cells to `src/render/` (strip and joiner selection, pickers and menus, the diagnostic strip). The payload's data comes from the providers in `src/segments/` — git, session, context, metrics, tmux, pricing.
- **Themes** (`src/themes/`) — palette construction plus name policy (which theme, style, charset and colour depth names resolve to what). The colour arithmetic itself — blending, contrast, OKLCH transposition — lives in the separate `rich-js` package; this repo does none of it.

## Segments

These are the segment names `DEFAULT_DSL_CONFIG` declares, each available to a user's `root` whether or not the default bar places it.

| Segment | Shows | Visible |
|---------|-------|---------|
| `directory` | the cwd, abbreviated fish-style (`~/c/cc-candybar`) | always |
| `model` | `✱` and the model's display name | always |
| `sessionId` | `⌗` and the first 8 characters of the session id | always |
| `version` | `◈ v` and the Claude Code version | always |
| `tmux` | `tmux:` and the tmux session name | inside tmux |
| `host` | `⇄ user@host` | over SSH |
| `git` | repo, `⎇` branch, sha, ahead/behind, worktree, upstream, stash, working-tree status | in a repo |
| `gitaculous` | the same facts in gitaculous's spelling — `(git)`, repo, operation, sha, `S`/`U`/`?`/`!` counts, upstream, stashes, time since the last commit | in a repo |
| `gitPr` | `⇆ #N` linked to the pull request, or `⚠ PR` when the forge lookup failed | when a PR or a lookup error is known |
| `toolbar` | click affordances — copy the session id, open the project dir, the transcript and the repo page, toggle edit mode | always |
| `session` | `§` this session's cost and tokens, plus budget status | always |
| `today` | `☉` today's cost and tokens across sessions, plus budget status | always |
| `block` | `◱` the 5-hour rate-limit window's utilization | while that window is active |
| `weekly` | `◑` the 7-day rolling rate limit's utilization | while that window is active |
| `burnrate` | `⚡` cost per hour, then ETA to the 5-hour and weekly limits | while either window is active |
| `speed` | `⇅` output, input and total tokens per second | once the session has tokens |
| `tokenSparkline` | `⚡` a sparkline over the last 24 speed samples | once speed samples exist |
| `cacheTimer` | `◴` minutes until the prompt cache expires, or `cold` | while a cache expiry is known |
| `context` | `◔` context tokens used and the percentage left | when context tokens are known |
| `metrics` | `Δ` last response time, `⧖` response time, `⧗` session duration, `◆` message count, lines changed | when any of those exist |
| `activity` | `⌘` the slash command that opened the turn, `☐` the in-progress todo with its position, `⟳` tools in flight and `✓` tools finished this turn | while the session is doing something |

Three more declarations are controls for the settings drawer rather than things the bar reports. Each pairs a picker with a `↺` reset:

| Control | Sets |
|---------|------|
| `charsetControl` | the joiner glyph vocabulary (`unicode` or `ascii`) |
| `colorCompatControl` | the output colour depth (truecolor, 256, ansi, none) |
| `directoryPaletteControl` | `🎨 directory` — the palette pinned to the `directory` segment alone |

Each segment is a DSL declaration with a `template` (text + interpolation + style functions), a `bg`/`fg` palette spec, and optional `when` predicate. Templates compose freely — every formatter in the bundled function library (`formatCost`, `formatTokens`, `formatLongTimeRemaining`, `budgetStatus`, `link`, `urlEncode`, the sprig string/list/dict library, …) is available in every segment.

## Themes

The DSL config picks a base palette via `globals.palette` (e.g. `textual-dark`, `gruvbox`). Each segment may override with its own `palette:` field, and `bg`/`fg` take a palette colour name (`primary`, `surface`, `panel`, `accent`, `foreground`, `warning`, `error`, …) or a computed colour such as `{{ darken (color "primary") 2 }}`; a segment that authors no `bg` wears the theme's decorative tint for its position. Color math runs through OKLCH for perceptual uniformity.

## Installation

Requires Node.js 20.19+ (within the 20.x line) or 22.12+, Claude Code, and Git 2.0+. For best display, install a [Nerd Font](https://www.nerdfonts.com/) so the powerline glyphs render correctly.

### Manual setup

Run the install once to stage the runtime, then point `~/.claude/settings.json` at the staged entry (this is also exactly what `install` writes):

```json
{
  "statusLine": {
    "type": "command",
    "command": "'/Users/you/Library/Application Support/CCCandybar/bin/cc-candybar'"
  }
}
```

### Developing against a checkout

`just deploy` builds `dist/index.mjs` and stages the native binary at `bin/cc-candybar-native` — point your statusline command at that path. On a machine without cargo, `pnpm install && pnpm build` builds only the bundle — point your statusline at the committed `bin/cc-candybar` node entry instead. Either way the bar renders HEAD; the daemon watches the built bundle and respawns itself on rebuild.

### Config file

Customization lives in `.cc-candybar.json5`. See the [Customization](#customization) section above for the resolution order. Saved edits hot-reload — no restart needed.

## Contributing

Contributions welcome. See [CONTRIBUTORS.md](CONTRIBUTORS.md) for people who have contributed outside of GitHub PRs.

## License

[MIT](LICENSE)
