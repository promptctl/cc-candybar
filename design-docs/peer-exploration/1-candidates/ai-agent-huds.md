# Candidates — Status bars, HUDs and usage dashboards for AI coding agents other than Claude Code

Provenance: stage-one survey, 2026-09-10. Candidates found via WebSearch (statusline/footer terms, then mechanism terms like "htop for agents", "plugin status bar widgets", "session log token_count"), READMEs read with WebFetch, and sibling-mining of `bradAGI/awesome-cli-coding-agents` plus the feature-request threads on `anomalyco/opencode`. All stars/commits/push dates from `gh api` (commit counts from the `rel="last"` page number of `commits?per_page=1`). Claude Code-specific tools, shell prompts, tmux/zellij bars and editor statuslines are excluded by assignment. Ordered most interesting first, not most popular.

## ocstatusline
- **URL:** https://github.com/amirlehmam/ocstatusline
- **Stats:** TypeScript · 0 stars · 34 commits · last push 2026-06-01 — *low stars, single author; listed for the mechanism*
- **What it is:** A configurable live status line for opencode, explicitly positioned as "the opencode counterpart of ccstatusline", with ~13 widget types (model, provider, mode, cost, tokens, context-length/percentage/bar/window, five git widgets, cwd, custom text/symbol).
- **Interesting because:** It inverts the per-refresh pull model — it subscribes to opencode's SDK event stream (`client.event.subscribe()`) and folds events through a pure reducer into in-memory state, repainting only on a real event plus a 1 s tick for time-dependent widgets, and de-duplicating streaming deltas so cost/tokens are not double-counted. Configuration is an interactive TUI editor with live preview (widget reorder, per-widget colour as palette name or `#rrggbb`, powerline separators, colour depth `ansi16`/`ansi256`/`truecolor`) writing a JSON file that is merged over defaults so a partial file still loads.

## Antigravity CLI status line
- **URL:** https://antigravity.google/docs/cli/statusline/
- **Stats:** Google product docs, not a public GitHub repo · stars/commits `unverified` · docs live as of 2026-09-10
- **What it is:** Google Antigravity's CLI adopts the external-command statusline contract (`statusLine: {type:"command", command:"…"}` in `~/.gemini/antigravity-cli/settings.json`), executing the script on agent state change and rendering its stdout with full ANSI support.
- **Interesting because:** The stdin payload is far richer than the Claude Code one it imitates — `agent_state` (idle/thinking/working/tool_use/initializing), `execution_mode`, `task_count`, pending-input count, artifact count, sandbox enable + network flags, `plan_tier`, quota, and `terminal_width` — which is a ready-made vocabulary for segments cc-candybar has no input for. It also ships `stack_with_default`, so a custom line renders *alongside* the built-in one instead of replacing it, plus a `padding` key for blank-line spacing.

## OpenAI Codex CLI (native TUI status line)
- **URL:** https://github.com/openai/codex
- **Stats:** Rust · 123,105 stars · 10,613 commits · last push 2026-09-10
- **What it is:** The Codex CLI renders its own footer status line, configured declaratively rather than by an external command — there is no statusline-command hook at all.
- **Interesting because:** `[tui] status_line = ["model-with-reasoning","current-dir","context-usage","used-tokens","five-hour-limit","weekly-limit"]` is an ordered array of named fields, and the *same* field vocabulary drives a second sink, `terminal_title = ["project","git-branch","status","thread","task-progress"]` — one named-segment list projected into two different renderers. The `five-hour-limit`/`weekly-limit` fields are rate-limit budget segments sourced from the provider rather than computed locally.

## codex-hud
- **URL:** https://github.com/fwyc0573/codex-hud
- **Stats:** JavaScript · 79 stars · 83 commits · last push 2026-09-06
- **What it is:** A multi-line HUD for Codex CLI that auto-creates a tmux session, runs stock `codex` in one pane and paints a 5-line HUD in an adjacent pane, showing model/context%/branch/elapsed, MCP + skill + hook counts, permission state, service tier, token input/cache/output breakdown, and a live tool/subagent activity log.
- **Interesting because:** It sources state by watching Codex's **SQLite session database** rather than tailing JSONL, with an opt-in `CODEX_HUD_SQLITE_ISOLATION=1` per-session database to dodge I/O contention, and a 5 s in-process cache for slow-moving facts (skill/hook counts) so the fast path stays cheap. The subagent widget renders a hierarchy — `◐ agent_name 2m14s ↳2` (elapsed plus descendant count), children disappearing on completion unless a live descendant holds the row open — and `Ctrl+T` flips to a multi-session overview aggregating context metrics across every running Codex.

## Hermes Agent (TUI status bar)
- **URL:** https://github.com/NousResearch/hermes-agent
- **Stats:** Python · 244,209 stars · 33,459 commits · last push 2026-09-10
- **What it is:** A terminal coding agent whose `--tui` mode ships a first-class, user-configurable status bar rendering a context-window bar (`5.2K/128K [████░░░░░░░] 4%`) among other fields.
- **Interesting because:** The layout has an explicit **overflow policy**: `fields_left` is flexible and truncatable while `fields_right` is pinned and always visible, from a field set of `status, model, context, context_bar, duration, voice, bg, cost, cwd` — a different answer to narrow terminals than cc-candybar's auto-wrap. The busy indicator is pluggable via `display: tui_status_indicator` (`kaomoji` / `emoji` / `unicode` / `ascii`, the default rotating a face palette every 2.5 s), and `/statusbar config` is an in-session interactive field picker with `/statusbar separator` for the joiner string.

## abtop
- **URL:** https://github.com/graykode/abtop
- **Stats:** Rust · 3,506 stars · 475 commits · last push 2026-09-10
- **What it is:** "htop, but for AI coding agents" — a Rust TUI listing every live Claude Code and Codex CLI session with tokens, context window, rate limits and open ports in real time.
- **Interesting because:** It treats an agent session as a *process* and inherits htop's whole interaction model (sortable columns, per-row drill-down, live refresh) rather than inventing a dashboard, and it surfaces **open ports** per session — an attribute no statusline in this survey tracks, useful when several agents each start a dev server.

## Crush (sidebar + status bar)
- **URL:** https://github.com/charmbracelet/crush
- **Stats:** Go · 28,001 stars · 4,135 commits · last push 2026-09-10
- **What it is:** Charm's agentic coding TUI, whose status UI is not one line but a persistent **sidebar** column alongside a bottom status bar carrying cumulative token usage and model name.
- **Interesting because:** The sidebar is a stack of independent widgets — per-server LSP status with diagnostic counts, per-server MCP connection state, and modified files with +/- line counts — i.e. the same "many small data providers, one frame" problem cc-candybar solves horizontally, solved vertically. `compact_mode` in the crushrc collapses it, and `ctrl+d` re-summons the sidebar as an *overlay* rather than reflowing the layout.

## Sidekick Agent Hub
- **URL:** https://github.com/cesarandreslopez/sidekick-agent-hub
- **Stats:** TypeScript · 83 stars · 394 commits · last push 2026-09-10
- **What it is:** A session monitor with both a VS Code surface and a full TUI dashboard, tracking tokens, cost and context across Claude Code, opencode and Codex simultaneously.
- **Interesting because:** It normalises three different agents' session formats into one token/cost/context model and shows them in one pane, and it adds **multi-account switching** — swapping between several Claude Code and Codex accounts from the HUD, which makes the quota widget an actionable control rather than a readout.

## AgentSight
- **URL:** https://github.com/eunomia-bpf/AgentSight
- **Stats:** C · 684 stars · 761 commits · last push 2026-09-07
- **What it is:** System-level observability for AI agents built on eBPF, capturing syscall- and TLS-level traces of any coding agent with zero instrumentation of the agent itself.
- **Interesting because:** It gets the agent's real behaviour — process spawns, file writes, outbound LLM calls — by attaching to the kernel instead of parsing session logs or asking the agent to emit hooks, so the observed process pays nothing per event and no format change can break the collector. That is the extreme end of the "don't pay full cost per repaint" axis, and it works identically for every agent in this list.

## parallel-harness-pets
- **URL:** https://github.com/TevvvB/parallel-harness-pets
- **Stats:** Go · 15 stars · 120 commits · last push 2026-09-09 — *low stars; listed for the unique feature*
- **What it is:** A statusline companion that gives every git worktree a creature, rendered inside the coding agent's status line, plus one aggregate view across all live sessions.
- **Interesting because:** Species and rarity band are **derived deterministically from the worktree identity**, so the same checkout always shows the same creature and a glance at the bar tells you *which* of six parallel sessions you are looking at — identity-as-decoration, the same job cc-candybar's per-address decorative colour vocabulary does, solved with a hashed glyph instead of a hue. It also tracks per-agent context in the same line for each worktree.

## TokenTracker
- **URL:** https://github.com/xiufengsun/TokenTracker
- **Stats:** JavaScript · 1,573 stars · 1,366 commits · last push 2026-09-10
- **What it is:** A local-first token and cost tracker covering 31+ coding tools (Codex CLI, Cursor, Gemini CLI, opencode, Kiro, Copilot, DeepSeek Harness and more) with a web dashboard, a native macOS menu-bar app, and desktop widgets.
- **Interesting because:** Onboarding is zero-config because it **auto-installs each agent's hooks on first run**, so adding an agent is an install step rather than a configuration chore, and it deliberately records only token counts, timestamps and model names so no prompt text is ever read. The "4 desktop widgets" surface is a rare example of the same usage model projected into three different renderers (dashboard, menu bar, widget) from one local store.

## CodexBar
- **URL:** https://github.com/steipete/CodexBar
- **Stats:** Swift · 21,214 stars · 5,787 commits · last push 2026-09-10
- **What it is:** A macOS menu-bar app showing Codex (and Claude) usage stats — rate-limit windows, spend, context — permanently in the system menu bar.
- **Interesting because:** Its headline constraint is "without having to login": it derives the quota picture from **local session state and on-disk credentials already present on the machine**, never asking for an API key or a dashboard session, which is exactly the problem a statusline has when it wants to show a provider-side number. At 5,787 commits it is the most heavily developed menu-bar HUD in this territory.

## lazyagent (illegalstudio)
- **URL:** https://github.com/illegalstudio/lazyagent
- **Stats:** Go · 186 stars · 577 commits · last push 2026-09-08
- **What it is:** A single-terminal monitor for sessions across Claude Code, Cursor, Codex, Grok CLI, Kilo, Kimi Code CLI, Amp, pi and opencode, in the lazygit house style.
- **Interesting because:** It is explicitly **purely observational — no server, no daemon, no lock-in**: it discovers sessions by reading each agent's own on-disk session directory, so it never has to be launched before the agent and cannot wedge one. That is the opposite architectural bet from cc-candybar's persistent daemon and worth reading for what it gives up (no incremental state) to get it.

## agenttrace
- **URL:** https://github.com/luoyuctl/agenttrace
- **Stats:** Rust · 131 stars · 488 commits · last push 2026-09-07
- **What it is:** A local-first Rust TUI/CLI that audits AI coding-agent session logs after the fact — cost, tokens, latency, failures and a per-session "health" score across several agents.
- **Interesting because:** It scores **cache usage and anomalies** rather than just summing tokens, so the output is a judgement ("this session's cache hit rate collapsed here") instead of a number, and it surfaces latency and failure counts as first-class columns — three metrics a statusline could carry as a single quality glyph.

## Agent of Empires
- **URL:** https://github.com/agent-of-empires/agent-of-empires
- **Stats:** Rust · 3,214 stars · 2,395 commits · last push 2026-09-10
- **What it is:** A manager for many concurrent agents (Claude Code, opencode, Mistral Vibe, Codex CLI, Gemini CLI, Pi.dev, Copilot CLI, Factory Droid) exposing the same session set through both a TUI and a web UI aimed at phones.
- **Interesting because:** One state model drives **two renderers with different width budgets** — a terminal pane and a mobile browser — which is the generalisation of cc-candybar's `termCols` client hint, and the mobile surface makes "which agent needs my attention" a push-style notification rather than something you must be looking at the bar to see.

## Codeman
- **URL:** https://github.com/Ark0N/Codeman
- **Stats:** TypeScript · 749 stars · 2,111 commits · last push 2026-09-10
- **What it is:** Self-hosted "mission control" that spawns Claude Code, opencode, Pi, Codex, Antigravity, Gemini CLI and others inside persistent tmux sessions and keeps them running 24/7, reachable from any device.
- **Interesting because:** Rather than reconstructing a HUD from logs it **streams the real terminal** out to a browser and overlays status on top, so the fidelity problem disappears entirely, and it renders **every subagent live** as its own watchable stream — a tree-of-sessions view that no statusline in this list attempts.

## cursor-stats
- **URL:** https://github.com/Dwtexe/cursor-stats
- **Stats:** TypeScript · 264 stars · 120 commits · last push 2025-09-25 — *dormant ~1 year; the most-copied design in its niche (at least five forks/reimplementations found)*
- **What it is:** A Cursor/VS Code extension that puts subscription usage — fast-request count, usage-based spend, billing-cycle reset — permanently in the editor status bar.
- **Interesting because:** It is the reference implementation for a whole genre of status-bar quota widgets (numanaral/cursor-usage-stats, YossiSaadi, Tendo33, darzhang's explicit "lite" fork all trace to it), and the feature everyone copies is **configurable threshold alerts** — the widget changes colour and notifies when spend crosses a user-set line, i.e. the threshold is user data, not a hardcoded ramp.

## AgentAPI
- **URL:** https://github.com/coder/agentapi
- **Stats:** Go · 1,499 stars · 276 commits · last push 2026-05-27
- **What it is:** An HTTP API that wraps Claude Code, Goose, Aider, Gemini, Amp and Codex, exposing each one's conversation and lifecycle over a uniform REST + SSE interface.
- **Interesting because:** It normalises a coding agent to a tiny state machine — notably a `running` vs `stable` status plus a message event stream — which is the single most reusable abstraction in this territory: a HUD built on it works for six agents without parsing six log formats. It exists precisely because everything else here re-implements per-agent scraping.

## Gemini CLI (native footer)
- **URL:** https://github.com/google-gemini/gemini-cli
- **Stats:** TypeScript · 106,901 stars · 6,409 commits · last push 2026-09-10
- **What it is:** Google's terminal agent, whose footer is the status UI: model info, context percentage, token count, lines-of-code changed, sandbox state.
- **Interesting because:** As of v0.34.0 the footer is configured **from inside the session** via `/footer` (aliased `/statusline`) — an interactive picker that toggles which items render, persisted into `~/.gemini/settings.json` under `ui.footer.*` (`hideContextPercentage`, `hideModelInfo`, …) — i.e. discovery lives in the running program, not in documentation. Custom author-defined items are still unbuilt (issues #8191, #21208), which is the gap every third-party entry in this file exists to fill.

## codex-usage-bar
- **URL:** https://github.com/bhutano/codex-usage-bar
- **Stats:** Python · 0 stars · 3 commits · last push 2026-07-13 — *near-zero development; listed purely for the refresh mechanism*
- **What it is:** A persistent bottom pane beside Codex CLI showing rate limits, context window and a reset countdown.
- **Interesting because:** Its update model is **response-driven, not clock-driven**: it quietly polls the local Codex session log but only redraws when a *new `token_count` usage event* appears after Codex records a response, so idle time costs nothing and the repaint is causally tied to the fact that changed. That is a cheap, log-shaped approximation of the event subscription ocstatusline gets from an SDK, usable against any agent that writes a session log.
