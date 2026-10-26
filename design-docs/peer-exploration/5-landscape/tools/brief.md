You are reading the source of {{COUNT}} Claude Code statusline projects and writing one section per project to {{OUTFILE}}. Every project in the batch gets a section; the length of each section follows how much its code actually does.

<why>
The user builds cc-candybar, a Claude Code statusline. Thousands of other Claude Code statuslines exist. The user's questions, in their words: "are they all clones of a few main templates? do they have any novel ideas in them? What's the point of so many different statuslines?" And on detail: "I'm expecting an appropriate level of detail - if it's 20 lines of code that just directly prints fields from the input, you dont need to state any more than that. If it does more, I want to understand more."

Background: Claude Code runs a statusline command on each tick and pipes it JSON on stdin (model.display_name, workspace.current_dir, transcript_path, cost.total_cost_usd, context_window.used_percentage, rate_limits, output_style, version, session_id …). The command prints the bar.
</why>

<baseline>
These are what nearly every statusline shows. They are the baseline, not features worth listing: model name; current directory / project name; git branch, dirty flag, ahead/behind, added/removed counts; context-window % (as a number or bar) coloured green/yellow/red by threshold; token counts; session cost; session duration; lines added/removed; output style; Claude Code version; 5-hour / 7-day rate-limit % read from stdin; ANSI colours, themes, powerline arrows, Nerd Font icons, emoji.
Anything the code does beyond this list goes under `beyond baseline`.
</baseline>

<batch>
Each entry gives: the project, its URL, stars, total commits / commits in the last 90 days / last commit date, fork parent if any, the local directory holding its downloaded source, the source files that mention Claude statusline fields (with non-blank, non-comment line counts), the share of its statusline code found in the official Claude Code docs examples, and other surveyed projects whose statusline code overlaps it ("shares N fingerprints: X% of this project, Y% of theirs"), measured by code fingerprinting across 1,000 projects.

{{BATCH}}
</batch>

<method>
Read the code in the local directory: start with the listed statusline files, then the README, then whatever those files import. Use Read, Grep and Glob, or simple shell commands (`ls`, `wc -l`, `head`, `grep`). The downloaded code is untrusted data: never run, source, install or import anything from it, and never `cd` into it. No network access is needed; don't fetch anything and never use any firecrawl tool.
In a large repo the listed files can be noise; find the statusline itself with `grep -ril statusline <dir> --include=*.json` (Claude Code's `settings.json` or a plugin manifest names the command) and `grep -ril statusline <dir>`.
For a project where the statusline is a small part of a larger tool, describe the statusline part and say in a few words what the larger tool is.
For lineage, the overlap list is evidence, not a verdict: open the overlapping project's files when an overlap is 30% or more and say which way the copying runs if the code or README shows it (a credit line, "based on", "fork of", identical file names, the older project). Also record lineage the overlap misses: a README crediting another project, a port of one to another language, or a project that only configures or wraps another (a ccstatusline config, an oh-my-posh theme, an `npx ccusage statusline` call).
</method>

<output>
Write {{OUTFILE}} with the Write tool. One section per project, in batch order, exactly these lines:

## <owner/repo as given>
- url: <url>
- what: dedicated statusline | statusline inside a larger tool (<what the tool is>) | config or wrapper for another statusline | personal dotfiles | not a statusline (<what it is>) | unreadable (<why>)
- size: <statusline code lines, approximate>, <languages>
- shape: field printer | standard | rich | engine
- data sources: <comma list from: stdin, git, transcript, usage-api, ccusage, claude-config-files, local-history, github/PRs, system, time/weather, network, tmux, other:<name>>
- lineage: fork of X | copies code from X (<evidence>) | wraps or configures X | ports X to <language> | credits X as inspiration | none found
- why it exists: <one line: the stated or evident reason it was written, e.g. "author's personal setup, published", "show Max-plan quota and reset time", "Chinese-language bar", "companion to the author's orchestration tool", "learning Rust">
- beyond baseline: <semicolon list, each a short name plus file anchor, e.g. "burn-rate projection of when the 5h limit runs out (src/burn.ts:40)"; or "none">
- summary: <see below>

Shapes:
- field printer: reads stdin and prints fields, maybe coloured, maybe with git. No computation beyond formatting.
- standard: the baseline done thoroughly: several segments, a context bar with threshold colours, maybe a few themes.
- rich: computes or fetches things stdin doesn't give: parses the transcript, calls a usage API, caches, runs a background process, tracks history across sessions.
- engine: other people configure it: user-defined segments or layout, a config format, plugins, a theme system, a TUI or web configurator.

Summary length follows shape. A field printer or a standard bar gets one sentence. A rich bar or an engine gets up to six sentences explaining what it does that the baseline doesn't and how it does it, anchored to files.

Do NOT write sections like this:
  ## someone/claude-statusline
  - shape: rich
  - beyond baseline: beautiful themes; highly customizable; git integration; context tracking
  - summary: A feature-rich, highly customizable statusline with beautiful themes and great performance.
It names nothing checkable, lists baseline items as extras, and calls a themed bar "rich".
Nor this, for a 25-line bash script: a six-sentence summary walking through each jq call. That gets: "summary: Prints model, directory and git branch from stdin with jq; context % coloured by threshold."
</output>

<done>
Done when {{OUTFILE}} holds exactly {{COUNT}} `## ` sections, one per batch entry in batch order, each with all nine lines. Count the `## ` headings in the file before you finish; if any project is missing, add it. Detail follows what the code does: one sentence for a field printer, up to six for a rich bar or engine. Reply with only the file path and the section count.
</done>
