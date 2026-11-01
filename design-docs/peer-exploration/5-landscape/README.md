# 4,002 Claude Code statuslines: clones, new ideas, and why there are so many

Haiku agents read 4,002 statusline projects: the 1,000 with the most commits and 3,002 from below them. Code fingerprinting covered 7,046, every project whose source could be downloaded.

**Clones?** No. About one project in ten has half or more of its statusline code copied from one other project, and that share barely moves down the activity scale. It is 12% in the top 1,000, 7% to 10% in the middle and 15% among projects with 0 or 1 commits. The copying runs through a few dozen parents:
- daniel3303/ClaudeCodeStatusLine, with 57 copies
- claude-hud, with 74 re-uploads over two generations of its code
- ccstatusline, with 27
- CCometixLine, with 26

Only 14 of the 7,046 are mostly the example scripts from Claude Code's statusline docs. What the field shares is a design, not code. Nearly every project draws the same facts from the same stdin JSON: model, directory, git branch, a context bar that turns green, yellow then red, cost, and the 5-hour and 7-day limits. Most of them write their own code to do it.

**New ideas?** Some, and they cluster. 211 of the 4,002 (5%) do something a statusline reader would not expect. The share falls from 7% in the top 1,000 to about 4% below it. The largest cluster, in 90 projects, feeds the bar's numbers back into Claude: hooks that deny tool calls at a quota, block the end of a turn until a handoff is written, or resume the session when a limit resets. Next come an LLM writing about the session (56 projects) and the bar turned into a game (18, most of them in the tail). The tail adds ideas the top 1,000 lacks:
- finish-time estimates trained on the machine's own run history
- spaced-repetition flashcards and language drills
- a whole card game played through the prompt
- a cluster of tools that patch the installed Claude Code to remove its "Context low" warning

**Why so many?** The statusline command is the one place Claude Code hands a program its live session data, rate limits included. So any tool that wants that data has to own the statusline slot. That reason dominates the top. There, 43% of the statuslines sit inside a larger tool such as an orchestrator, a usage tracker or a plugin. Below the top 1,000 that share drops to 12% to 30%. The tail is mostly people publishing their own bar (14% to 19% of each band), rewriting one in another language (6% to 8%) or retargeting one for another language or a regional provider (5% to 9%). Seeing plan limits is the itch in every band, at about 11%. A statusline is small, Claude will write one on request, and plugin marketplaces make publishing it one step more.

## How the projects were chosen

The input was the 9,558 projects in [../4-styling/all-projects.md](../4-styling/all-projects.md). A script fetched commit counts and dates for every one with a git history: GitHub repos and gists, GitLab, Codeberg. It dropped:
- the 1,876 the styling survey's scanner had marked as not statuslines
- 463 with no history (npm pages, blog posts)
- 109 that were gone
- 39 URLs that led to a repo already counted

A fork counts only the commits it added over its parent. cc-candybar itself was left out.

That left 7,069 projects ranked by commits, and 7,046 of them downloaded. The first pass read the 1,000 with the most commits, which have at least 45 each. The second pass read 3,002 of the rest:
- all 1,920 with 10 to 44 commits, counting six tied at 45 that fell just outside the top 1,000
- 1,023 of the 3,021 with 2 to 9 commits: those with at least 200 lines of statusline code that are not 70% or more a copy of a project already read
- 59 of the 1,128 with 0 or 1 commits: those with at least 400 such lines

So the 10-44 bands are complete, and the 2-9 and 0-1 bands are their larger, original projects. Shares in those bands describe that subset, not the band.

Fingerprinting is MOSS-style winnowing over the files that mention Claude's statusline fields. It measured code overlap between every pair of projects and against the docs examples. Each agent read one project's code and wrote a section on it: what it is, its size, its shape, its data sources, its lineage, why it exists, and what it does beyond the baseline ([projects.md](projects.md), [projects-tail.md](projects-tail.md)). Further haiku passes did three things:
- sorted the 16,695 beyond-baseline features into 34 families
- sorted each project's stated reason into one of 16 motives
- screened the features that fit no family for genuinely new ideas

Every count below comes from those labels or from the fingerprints.

## Down the tail

Commit bands, left to right from the most active. Rows marked "all downloaded" cover every fingerprinted project in the band; the rest cover the projects read.

| | 45+ | 20-44 | 10-19 | 5-9 | 2-4 | 0-1 |
|---|---|---|---|---|---|---|
| projects read | 1000 | 863 | 1057 | 524 | 499 | 59 |
| statuslines among them | 894 | 789 | 977 | 511 | 495 | 58 |
| median lines of statusline code (all downloaded) | 720 | 408 | 275 | 196 | 138 | 123 |
| half or more copied from one other project (all downloaded) | 12% | 8% | 7% | 9% | 10% | 15% |
| statusline inside a larger tool | 43% | 30% | 23% | 13% | 12% | 14% |
| shape: rich | 62% | 70% | 62% | 70% | 68% | 72% |
| shape: engine | 22% | 12% | 9% | 9% | 6% | 10% |
| shape: standard | 10% | 12% | 18% | 17% | 19% | 17% |
| shape: field printer | 6% | 7% | 11% | 4% | 7% | 0% |
| at least one genuinely new idea | 7% | 6% | 4% | 4% | 4% | 5% |

The shapes, as the agents applied them:
- **Rich:** computes or fetches what stdin doesn't give, such as transcript parsing, the usage API, caches, background processes or history.
- **Engine:** other people configure it, with segments, layouts, themes or a configurator.
- **Standard:** the baseline done thoroughly.
- **Field printer:** reads stdin and prints fields.

Four things change down the tail and three don't.
- **Projects get smaller.** The median statusline shrinks from 720 lines to 123.
- **Statuslines leave larger products.** The share inside a larger tool falls from 43% to about 13%.
- **Frameworks thin out.** Engines fall from 22% to about 10% or less, and so do the features that make a bar a product: extension points, configurators, update checks, wrapping other bars.
- **New ideas get rarer.** The share falls from 7% to about 4%.

What doesn't change:
- **The copy rate** stays at about one in ten.
- **Rich bars stay the majority** in every band.
- **Field printers stay rare.** Even in the two complete bands, 20-44 and 10-19 commits, only 7% and 11% of the statuslines just print stdin fields.

The long tail is not a pile of 20-line scripts either. Of the 5,323 projects below the top 1,000 with any statusline code, 464 have under 50 lines of it. Even at 0 or 1 commits, only 14% are that small.

## Clones and lineage

**Code overlap.** Across all 7,046 projects, 703 fall into 203 families in which one member's statusline code is at least half contained in another's. A family needs at least a fifth of each member's code in common. Without that floor, monorepos that vendor several bars chain unrelated families into one. The families are listed in `tools/families-all.json` with their members' commit counts. The largest:
- **daniel3303/ClaudeCodeStatusLine, 57 projects,** only 4 of them in the top 1,000. Most of its copies sit in the tail.
- **claude-hud, 74 projects in two families of 44 and 30.** They are re-uploads, not GitHub forks: claude-hud-cn, claude-hud-glm, claude-hud-zhipu, claude-hud-bedrock, claude-hud-cubence and many plain `claude-hud` copies. The variants mostly retarget it at Chinese users or at the GLM, Zhipu, Kimi or Bedrock providers. The current jarrodwatts/claude-hud has drifted from both and fingerprints into a family of six.
- **ccstatusline, 27 projects,** including ccstatusline-zh, ccstatusline-zh-tw and ccstatusline-gradient.
- **CCometixLine, 26 projects,** Rust copies, most still named CCometixLine, along with rebrands such as CCstatus, hazline and EFlowCodeLine.
- **Three families that never reached the top 1,000:** nilbuild/claude-statusline (25), kunaltulsidasani/claude-reimagined (19) and danielmackay/claude-code-statusline (14).

The rest are pairs and triples: a project and its mirror on another forge, a fork with a few patches, or one author's two repos.

**What the agents found.** Of the 3,724 statuslines read, 71% show no lineage at all. The rest:
- 338 credit another project as inspiration without sharing code.
- 211 wrap or configure another statusline.
- 205 copy code from a named project.
- 165 are forks.
- 156 port one to another language.

Starship and Powerlevel10k turn up only as credited inspiration.

So the sameness is convergence. Everyone reads the same stdin JSON and draws the same handful of facts from it, and most arrive at the same layout on their own.

## What is common beyond the baseline

These families are the field's second layer, not new ideas. Shares are of the statuslines in each band; the first column counts projects across all 4,002.

| family | projects | 45+ | 20-44 | 10-19 | 5-9 | 2-4 | 0-1 |
|---|---|---|---|---|---|---|---|
| plan quota fetched outside stdin: the OAuth usage endpoint, with the token read from the keychain or credentials file | 796 | 24% | 24% | 18% | 20% | 21% | 22% |
| burn rate, pace against the window, or a forecast of when a limit or the context runs out | 721 | 23% | 20% | 17% | 21% | 15% | 22% |
| live activity from the transcript or hooks: running tools, subagents, todos | 590 | 20% | 16% | 13% | 14% | 14% | 19% |
| prompt-cache TTL countdown, warm or cold, hit rate | 532 | 17% | 16% | 12% | 13% | 14% | 17% |
| spend or usage history across sessions | 529 | 18% | 15% | 12% | 12% | 14% | 10% |
| Claude Code state: effort, permission or sandbox mode, plan mode | 478 | 9% | 16% | 12% | 15% | 15% | 10% |
| theming beyond plain colours: gradients, light/dark detection, palettes taken from Claude's theme | 437 | 10% | 9% | 13% | 15% | 12% | 17% |
| other AI CLIs supported (Codex, Gemini, Copilot, opencode) | 427 | 13% | 13% | 10% | 11% | 9% | 7% |
| width-adaptive layout | 366 | 8% | 11% | 7% | 12% | 12% | 17% |
| git beyond branch and dirty: worktrees, stash, diff against main | 360 | 11% | 11% | 8% | 9% | 9% | 12% |
| cost priced from transcript tokens | 358 | 11% | 11% | 7% | 9% | 11% | 7% |
| installers, settings.json patching, rollback, doctor commands | 344 | 10% | 10% | 8% | 9% | 8% | 16% |
| compaction: context measured against the autocompact point | 279 | 8% | 8% | 7% | 7% | 5% | 5% |
| PR, CI or deploy status | 275 | 9% | 8% | 6% | 8% | 7% | 5% |
| timers, idle detection, response latency | 261 | 6% | 8% | 5% | 9% | 8% | 10% |
| several sessions or agents at once | 254 | 8% | 8% | 5% | 7% | 5% | 9% |
| mascots, pets and animation | 248 | 6% | 7% | 7% | 7% | 5% | 10% |
| background refresh: detached fetches, daemons, caches off the render path | 223 | 6% | 7% | 5% | 4% | 7% | 7% |
| extension points: custom commands, plugins, template languages | 222 | 10% | 7% | 5% | 4% | 3% | 2% |
| update checks | 201 | 8% | 8% | 3% | 3% | 4% | 3% |
| several Claude accounts | 180 | 6% | 6% | 4% | 4% | 3% | 7% |
| an interactive configurator (TUI, wizard, web) | 178 | 8% | 6% | 4% | 3% | 2% | 9% |
| wraps or composes another statusline | 172 | 7% | 6% | 3% | 3% | 2% | 2% |
| machine metrics (CPU, memory, battery) | 160 | 5% | 5% | 3% | 5% | 3% | 7% |
| weather, clocks, markets, news | 141 | 4% | 4% | 4% | 3% | 3% | 7% |
| tips, coaching, rotating messages | 137 | 4% | 4% | 4% | 3% | 3% | 3% |
| language and environment detection | 126 | 2% | 5% | 2% | 4% | 5% | 3% |
| sounds and desktop notifications | 121 | 4% | 4% | 3% | 2% | 2% | 3% |
| shown outside the terminal (menu bar, widgets, hardware) | 114 | 3% | 3% | 3% | 2% | 2% | 5% |
| OSC 8 links | 77 | 2% | 2% | 2% | 2% | 2% | 3% |
| localisation | 65 | 1% | 2% | 2% | 1% | 2% | 0% |
| Anthropic service status | 49 | 2% | 1% | 1% | 1% | 0% | 2% |
| tmux | 47 | 1% | 2% | 1% | 1% | 0% | 2% |
| telemetry export (OpenTelemetry) | 40 | 2% | 2% | 1% | 1% | 0% | 0% |

The weight sits on one question in every band: will I run out? Quota, pace, cache timers and spend lead throughout, each in roughly a fifth of the bars, a little less in the 10-19 band. The 0-1 column holds only 58 statuslines, so its shares swing.

## The new ideas

Haiku screened the 4,797 features that fit no family and marked 285 of them, from 211 projects, as ideas a statusline reader would not expect. A script then sorted those into groups by keyword, so the group counts are approximate. I checked every example quoted here against its source.

| idea | projects | 45+ | 20-44 | 10-19 | 5-9 | 2-4 | 0-1 |
|---|---|---|---|---|---|---|---|
| feeds the bar's numbers back to Claude or gates it | 90 | 26 | 30 | 15 | 8 | 11 | 0 |
| an LLM writes about the session | 56 | 27 | 12 | 8 | 5 | 2 | 2 |
| the bar becomes a game or a reader | 18 | 3 | 2 | 8 | 1 | 4 | 0 |
| grades the prompt or the reply | 15 | 6 | 2 | 2 | 2 | 2 | 1 |
| detects a failure mode in the session | 12 | 5 | 6 | 0 | 0 | 1 | 0 |
| patches Claude Code itself or its traffic | 9 | 3 | 1 | 3 | 1 | 1 | 0 |
| reads mood or fatigue | 7 | 4 | 1 | 0 | 1 | 1 | 0 |
| predicts how long the work will take | 5 | 0 | 2 | 2 | 1 | 0 | 0 |
| shows friends or other users | 3 | 1 | 0 | 2 | 0 | 0 | 0 |
| practice or study in the bar | 2 | 0 | 1 | 0 | 0 | 1 | 0 |
| single ideas that fit no group | 19 | 6 | 4 | 4 | 5 | 0 | 0 |

**Feeding the bar back into Claude (90 projects).** These use the bar's numbers to steer the agent, not just to inform the person. Unlike LLM commentary, it does not thin out below the top 1,000: the 20-44 band has 30 such projects to the top's 26. They exist because only the statusline sees the rate limits. alexanderleitch/claude-usage-guard's README says so: hook payloads do not carry the rate limits, and no hook fires on an approaching limit, so its status line command writes the numbers to a per-session cache file for its hook to read. Examples from the top 1,000:
- funhunter7/claude-limit-guard blocks the end of a turn once per reset window after a limit breach, so Claude writes a handoff.
- moiri-gamboni/session and noambrand/launchpad-cli resume the session when the limit resets.
- team-maro/cc-statusline exposes the bar's state to Claude as an MCP server.

Examples from the tail:
- alexanderleitch/claude-usage-guard's Stop hook blocks the turn at 98% with a reason asking Claude to commit and write a handoff note.
- aaronl725/cc-quota-guard denies tool calls once the 5-hour window reaches 95%.
- sunnywlad/claude-tokens_in_sessions locks every tool and prompt at a context size until the user types `unlock:`.
- eales/claude-code-cockpit sleeps until the reset, then exits with code 2 to wake the same session.
- caridina-ai/continue-claude re-prompts idle Windows sessions by writing keystrokes into the console with `WriteConsoleInputW`.
- jkubo/context-gauge injects the context band into the model's context on every prompt.

**An LLM writing about the session (56 projects).** The usual form is a session title or topic written by a background `claude -p --model haiku` call from a hook: dreamiurg/claude-session-topics, dkstm95/claude-recall, mjquinlan2000/claude-statusline. Others go further:
- bllshttng/fno revives Claude Code's removed buddy and has Haiku write its speech each turn.
- kam-l/claude-coach runs Sonnet over the transcript for reflections and injects the advice.
- richardvt/ccmud is a text adventure in which a background Haiku call recasts each work prompt as an in-story activity: debugging becomes study, writing code becomes calligraphy.
- meyer-coder/claude-code-eta asks Haiku how long each task will take and counts down.

**Finish-time estimates (5 projects, all in the tail).**
- ben564885/claude-eta logs every run. Once 50 runs are logged, it fits quantile-regression models to them, and mid-run it revises the estimate with survival analysis conditioned on the run still going.
- akkijp/baro corrects its step estimates with ratios learned from the machine's own history.
- siller/supermod takes the median of completed tasks.

**Practice in the bar (2 projects).**
- adriendesola/flashcards shows spaced-repetition flashcards, scheduled by SM-2 and answered with one character at the prompt.
- alantouchard/statusline-polyglotte drills French vocabulary in Leitner boxes, answered with Hammerspoon hotkeys.

**Grading the user or the work, or reading their mood (about 20 projects).**
- james-m-swyftx/claude-prompt-rater grades the last prompt on five dimensions, including specificity and success criteria, and shows a letter grade with a trend arrow.
- philparkinson1204/nice-to-claude counts the pleases and thank-yous in the prompt history.
- tanerincode/jedi-statusline runs a judge after every turn. It awards XP for clean, tested work, and its alignment score drifts toward the dark side for skipped tests, reckless commands and claims that tests ran when they didn't.
- annaluizando/claude-tamagotchi scores frustration from swearing, capitals and screams in Portuguese, English and Spanish.

**Failure detectors (12 projects).**
- link-start/my-claude-hud plants a canary ID in a file the session reads and reports when Claude has lost it from context.
- huaxueye/claude-code-statusline flags a tool call repeated three times in the last five.
- From the top 1,000: pnjegan/burnctl flags retry loops, and vladimir-ks/ai-agile-claude-code-statusline scans the transcript for secrets.

**Friends in the bar (3 projects).**
- trevorstenson/campfire-cli holds a WebSocket to a hosted server and shows friends' presence on a second line.
- mishoku/cc-presence shows a cohort count, a streak and a night flag from a daemon that pings a presence server.
- limone-eth/terminally.social, which the screen did not flag, runs a token-burn leaderboard among friends.

**The bar as another medium (18 projects).** This is commoner below the top 1,000 than in it: 15 of the 18 are in the tail, mostly games driven by Claude's activity.
- ezequielmm/claude-doom, from the top 1,000, runs doomgeneric in a daemon and draws its frames in the statusline.
- jackpas23/claude-euchre plays a full game of Euchre against computer seats, with moves typed as `!euc` commands.
- jystervinou/claude-code-arcade runs Ms. Pac-Man, R-Type and Frogger, driven by Claude's activity, with function keys as a joystick.
- lukelandis3-sketch/claude-and-prejudice streams a book one line per tick.

**Patching Claude Code (9 projects).** In the tail this is a small genre of its own: hollegjx/uucode, leo919cc/cclinebar, dengshuit/cclinepro and mengfanlu1/opendoor-statusline all rewrite the installed Claude Code bundle to remove its "Context low" warning. dengshuit/cclinepro does it with tree-sitter. In the top 1,000, zigizhujian/cc-companion rewrites a salt constant in the Claude Code binary and re-signs it, and supadll/deepseek-hud patches Node's `https.request` to read the API traffic.

## Why there are so many

The motive labels, one per project read, as shares of each band:

| motive | projects | 45+ | 20-44 | 10-19 | 5-9 | 2-4 | 0-1 |
|---|---|---|---|---|---|---|---|
| the author's own setup, published | 647 | 14% | 18% | 16% | 16% | 19% | 14% |
| see plan quota and limits | 455 | 10% | 12% | 11% | 13% | 12% | 12% |
| a component of a larger product, showing that product's own state | 332 | 15% | 8% | 7% | 4% | 3% | 5% |
| a faster or smaller rewrite, or a port | 256 | 4% | 7% | 6% | 8% | 8% | 8% |
| localisation or a regional provider | 231 | 4% | 5% | 6% | 6% | 9% | 5% |
| a particular look | 218 | 6% | 3% | 5% | 7% | 6% | 14% |
| track money | 199 | 5% | 5% | 5% | 5% | 6% | 0% |
| fun: a mascot, pet or game | 179 | 4% | 5% | 5% | 3% | 4% | 7% |
| a framework for others to configure | 169 | 4% | 4% | 4% | 4% | 3% | 8% |
| one bar for several AI CLIs | 164 | 5% | 4% | 4% | 4% | 4% | 0% |
| a customised fork of an existing bar | 128 | 4% | 3% | 3% | 2% | 3% | 3% |
| show Claude Code's state outside the terminal | 128 | 5% | 4% | 2% | 2% | 2% | 5% |
| watch the context window | 118 | 2% | 2% | 5% | 3% | 2% | 5% |
| several sessions or agents at once | 109 | 4% | 3% | 2% | 3% | 2% | 0% |
| learning or a demo | 28 | 1% | 1% | 1% | 1% | 1% | 0% |
| not a statusline, or unreadable | 161 | 2% | 7% | 6% | 2% | 1% | 0% |
| other, mostly "a general info bar" | 480 | 11% | 9% | 11% | 15% | 16% | 14% |

The top and the tail exist for different reasons. At the top, the largest group is products that need the statusline slot. The statusline command receives live session JSON, rate limits included, on every tick, and hooks do not. rogvid/agent-sidebar's tap exists "because Claude Code passes rate limits only to the statusline command". So orchestrators, routers, memory plugins and usage trackers each carry a statusline. A genre of composition follows: taps that save the feed and then run your real statusline, and installers that rewrite `settings.json` and keep your old line for rollback.

Below the top 1,000 those products thin out, and personal bars take their place. A personal bar is a few hundred lines that Claude writes on request, so publishing one costs almost nothing. Next come the ordinary reasons any tool gets rewritten: another language or a faster binary, a Chinese-language or GLM, Kimi or Bedrock fork, or a look. Plan limits hold steady at about one project in nine in every band.

## Files

- the explorer, published with the Pages site under `landscape/`, to explore all 4,002 as a graph of what they do. Each project hangs off its functional characteristics (not a statusline, feeds data back into Claude, games, themes, quota and so on), and each new idea is shown with the screen's reason for calling it unusual. Its source is [explorer/](explorer/), a Svelte app: run `pnpm data` there, then `pnpm build`. Projects drawn in teal have a bar: open one and the bar it printed in a sandbox plays along the bottom of the graph, drawn by xterm.js, through a two-minute mock conversation that loops (a feature branch, edits, a commit, a push), at a speed you can set. Those captures come from [tools/capture/](tools/capture/): `triage.py` stamps every project with a risk tier from a read of its statusline files (skip, unlocated, safe, review, risky), `fixture.py` builds the mock conversation as sixty ticks of hook JSON, transcript and working tree, `resolve.py` turns each safe project into a run command, and `run.py` runs it at every tick under macOS `sandbox-exec` with no network, no reads outside the run directory, and the hook JSON on stdin, at 80, 120 and 160 columns so the page can show the width that fits; `deps.py` fetches what an entry imports without running any package code, and `scrub.py` rewrites the machine's user, host and run path to the fake developer's. The safe and review tiers have been run, 2,091 bars in all; the risky tier, mostly Rust and Go that would need a build, waits.
- [projects.md](projects.md): one section per project for the top 1,000, in rank order.
- [projects-tail.md](projects-tail.md): one section for each of the 3,002 read from below them, grouped by commit band. In both files, detail follows what the code does: one sentence for a field printer, up to six for a rich bar or an engine, anchored to files.
- [projects.tsv](projects.tsv): all 4,002 as a table. Ranks run over all 7,069 projects by commits, so gaps in the tail are projects not read. Columns: commit band, commits, dates, stars, language, kind, shape, motive, feature-family codes ([families.md](families.md)), statusline code size, and the closest code overlaps among all 7,046.
- [tools/](tools/): the scripts and agent briefs that produced all of this, including `families-all.json`. They read from and write to `/tmp/ccland`. The downloaded sources (about 5 GB) are not kept.
