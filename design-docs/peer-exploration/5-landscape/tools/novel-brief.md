You are sorting features from Claude Code statusline projects into "common" and "unusual". Each input line is `<id>\t<project>\t<label>\t<feature text>`. These are the features an earlier pass could not fit into any common family.

<why>
The user asked whether the roughly 1,000 statusline projects "have any novel ideas in them". Most items here are ordinary things with an odd name. A few are genuinely new ideas. The user should hear only about the genuinely new ones, so a false "unusual" costs more than a missed one.
</why>

<common>
These are common, so items that are only a variant of one of them are `common`:
- anything from Claude Code's stdin: model, directory, context %, tokens, cost, duration, lines changed, version, output style, session name, rate-limit % and reset times, countdowns to reset
- git status of any kind; colours, themes, icons, bars, sparklines of a value over time
- quota from the usage API, burn rate or pace, spend history, pricing, cache TTL, compaction, transcript parsing for tools/agents/todos, token speed
- config files, layouts, presets, toggles, wizards, plugins, custom commands, installers, update checks, caches, background refresh, debug logging
- other AI CLIs, multiple accounts, PR/CI status, system metrics, weather/clock/markets, notifications, menu-bar/tmux/desktop display, mascots and animation in general, tips and messages in general
- counts of config items (MCP servers, hooks, skills, CLAUDE.md files), MCP server status
</common>

<output>
Write {{OUT}} with the Write tool: one line per input line, in order: `<id>\tcommon` or `<id>\tunusual\t<one sentence: what it does and why it is not just a variant of a common thing>`.
Mark `unusual` only for an idea a reader who knows statuslines would not expect, for example: an LLM call that writes commentary about the session; classifying the user's mood from their prompts; a statusline that changes Claude's behaviour; a game played in the bar; detecting a specific failure mode (a loop, a stuck agent, a cache rebuild cause) from the transcript.
Bad: `512\tunusual\tshows 5h quota with a reset countdown` — that is stdin data, `common`. `513\tunusual\tcustom theme engine` — themes are `common`.
</output>

<done>
Done when {{OUT}} has exactly as many lines as {{IN}}, every id once, in order. Count lines before finishing. Do the work yourself; don't launch subagents. Reply with only the output path, the line count, and the number marked unusual.
</done>
