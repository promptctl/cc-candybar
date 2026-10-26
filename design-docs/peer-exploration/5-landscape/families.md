# Feature families

Codes used in `projects.tsv`; counts are in [README.md](README.md).

- F01 quota fetched outside stdin: calling Anthropic's OAuth usage endpoint or claude.ai, reading the token from keychain or credentials file, or rate-limit headers from an API call
- F02 burn rate, pace, forecast or run-out projection (when a limit or the context runs out, tokens per minute, pace versus elapsed window)
- F03 spend or usage history across sessions: daily/weekly/monthly totals, ledgers, per-project or per-model breakdowns, reports
- F04 cost computed by pricing tokens (pricing table, LiteLLM prices, transcript token sums)
- F05 live activity parsed from the transcript or hooks: running tools, subagents, todos, tasks, last action
- F06 prompt-cache: TTL countdown, warm/cold, hit rate, cache-miss cause
- F07 compaction: autocompact threshold, context re-based on the compaction point, compaction detection
- F08 PR, CI, issues or deploy status from GitHub/GitLab/Forgejo/Vercel etc.
- F09 several sessions, agents, panes or worktrees shown at once (fleet views, cross-session state)
- F10 other AI coding CLIs supported (Codex, Gemini, Copilot, opencode, Cursor, etc.) or multiple model providers
- F11 multiple Claude accounts or config profiles
- F12 mascot, pet, character, sprite, animation or mood art
- F13 background refresh: detached processes, daemons, caches refreshed off the render path, file watchers
- F14 width-adaptive layout: wrapping, dropping or shortening segments to fit the terminal
- F15 clickable OSC 8 links
- F16 Anthropic service health or incident status
- F17 machine metrics: CPU, memory, battery, disk, network, IP, VPN
- F18 ambient information unrelated to coding: weather, clocks, markets, currency, news, quotes, calendar
- F19 alerts: sounds, desktop notifications, toasts, bells
- F20 shown outside the terminal: menu bar, desktop widget, panel, tray, hardware device, phone, web dashboard
- F21 interactive configuration: TUI editor, setup wizard, web configurator, live preview
- F22 extension points: user-defined segments, custom commands, plugin or widget systems, template languages
- F23 self-update or update-available checks
- F24 tmux integration (tmux status line, pane titles)
- F25 localisation into other languages
- F26 telemetry: OpenTelemetry, metrics export, logs shipped elsewhere
- F27 session controls or reflections of Claude Code state: effort/thinking level, permission or sandbox mode, model switching, plan mode, vim mode
- F28 tips, coaching, nudges, rotating messages, advertising
- F29 git beyond branch/dirty/ahead-behind: worktrees, stash, remotes, commit age, diff against main, tags
- F30 project or environment detection: language versions, venvs, containers, cloud accounts, dev servers, ports
- F31 time tracking: session timers, idle detection, response latency, streaks
- F32 theming or visual styling beyond plain colours: gradients, palettes derived from Claude's theme, light/dark detection, contrast handling
- F33 installation, migration or packaging conveniences (installers, settings.json patching, uninstall/rollback, doctor commands)
- F34 wraps or composes another statusline's output
