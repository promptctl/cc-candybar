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

## Quick start (macOS)

```bash
pnpm dlx @promptctl/cc-candybar@latest install
```

That single command:

1. Builds `~/Applications/CCCandybarURLHandler.app` and registers the `cc-candybar://` URL scheme with macOS Launch Services.
2. Copies the runtime into `~/Library/Application Support/CCCandybar/url-handler.mjs` (stable path independent of pnpm cache).
3. Writes the statusline renderer command into `~/.claude/settings.json`.

Restart Claude Code. The statusline appears with the bundled default layout (directory, git, model, session, today, context). Cmd-clicking clickable cells fires `cc-candybar://` URL verbs that the daemon dispatches.

## Customization

Drop a `.cc-candybar.json5` (or `.cc-candybar.json` — both extensions are accepted) at any of these locations (highest precedence first):

1. `$CC_CANDYBAR_CONFIG` (literal path, supports `~` expansion)
2. `<project>/.cc-candybar.json5` (then `.json` at the same location)
3. `<cwd>/.cc-candybar.json5` (then `.json`)
4. `$XDG_CONFIG_HOME/cc-candybar/config.json5` (then `.json`; defaults to `~/.config/cc-candybar/config.json5`)

JSON is a strict subset of JSON5, so the same parser handles both — `.json5` is the documented format (supports inline comments, trailing commas, unquoted keys), `.json` is the legacy/compat extension. When both exist at the same location, `.json5` wins and the bar shows a persistent warning so you can remove the shadowed duplicate.

The file is a **complete** replacement for the bundled default — no merge layer. Start by copying `src/demo/statusline.json5` from the repo as a minimal example, or `src/config/default-dsl-config.ts` for the full standard library.

```json5
// minimal example — user, directory, branch, model, session, clock
{
  globals: { palette: 'textual-dark', hueStep: 14 },
  variables: {
    user:    { kind: 'env', name: 'USER', default: 'anon' },
    cwd:     { kind: 'input', path: 'workspace.current_dir', default: '?' },
    branch:  { kind: 'shell', command: 'git branch --show-current',
               cache: { ttl: '5s' }, default: '' },
    clock:   { kind: 'time', layout: '15:04:05', cache: { ttl: '1s' } },
  },
  segments: {
    user:      { template: ' {{ .user }} ',   bg: 'primary', fg: 'auto' },
    directory: { template: ' {{ basename .cwd }} ', bg: 'surface', fg: 'foreground' },
    branch:    { template: ' {{ .branch }} ', bg: 'accent',  fg: 'auto',
                 when: '{{ ne .branch "" }}' },
    clock:     { template: ' {{ .clock }} ',  bg: 'primary', fg: 'auto' },
  },
  layout: ['user', 'directory', 'branch', 'clock'],
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

- **Daemon** (`src/daemon/`) — long-lived background process. One per user. Caches git state via filesystem watchers, usage data, and per-session key/value state. Idles out after 30 minutes of inactivity.
- **Client** (`src/daemon/client.ts`) — each Claude Code hook invocation connects to the daemon, sends a render request, and prints the ANSI response. On failure, spawns a fresh daemon and emits empty output.
- **Renderer** (`src/render/`, `src/segments/`) — segments produce styled output from cached data. Themes cascade from defaults through palette resolution using OKLCH color math.
- **TUI grid** (`src/tui/`) — CSS Grid-inspired layout engine with breakpoints, column sizing (`auto`, `1fr`, fixed), spanning, and automatic culling of empty segments.

## Segments

| Segment | Shows | Symbol |
|---------|-------|--------|
| directory | CWD name (`full`, `fish`, `basename`) | — |
| git | Branch, SHA, working tree, upstream, stash, tags | `⎇` |
| model | Current Claude model | `✱` |
| session | Per-session cost/tokens/breakdown | `§` |
| today | Daily usage with budget monitoring | `☉` |
| context | Context window usage with auto-compact threshold | `◔` |
| block | 5-hour rate-limit utilization | `◱` |
| weekly | 7-day rolling rate-limit utilization | `◑` |
| metrics | Response time, duration, lines changed | `⧖` |
| version | Claude Code version | `◈` |
| tmux | tmux session name | — |
| sessionId | Session identifier (cmd-click to copy) | `⌗` |
| env | Arbitrary environment variable | `⚙` |

Each segment is a DSL declaration with a `template` (text + interpolation + style functions), a `bg`/`fg` palette spec, and optional `when` predicate. Templates compose freely — every formatter in the bundled function library (`formatCost`, `formatTokens`, `formatLongTimeRemaining`, `budgetStatus`, `link`, `urlEncode`, the sprig string/list/dict library, …) is available in every segment.

## Themes

The DSL config picks a base palette via `globals.palette` (e.g. `textual-dark`, `gruvbox`). Each segment may override with its own `palette:` field, and `bg`/`fg` evaluate as palette spec names (`primary`, `surface`, `panel`, `accent`, `foreground`, `auto`, `warning`, `error`, …). Color math runs through OKLCH for perceptual uniformity; `hueStep` rotates adjacent segments to keep them visually distinct without authoring per-segment colors.

## Installation

Requires Node.js 18+, Claude Code, and Git 2.0+. For best display, install a [Nerd Font](https://www.nerdfonts.com/) so the powerline glyphs render correctly.

### Manual setup

Edit `~/.claude/settings.json` directly. Pin the version — don't use `@latest` (pnpm caches aggressively and won't pick up new releases).

```json
{
  "statusLine": {
    "type": "command",
    "command": "pnpm dlx @promptctl/cc-candybar@0.2.3"
  }
}
```

### Config file

Customization lives in `.cc-candybar.json5`. See the [Customization](#customization) section above for the resolution order. Saved edits hot-reload — no restart needed.

## Contributing

Contributions welcome. See [CONTRIBUTORS.md](CONTRIBUTORS.md) for people who have contributed outside of GitHub PRs.

## License

[MIT](LICENSE)
