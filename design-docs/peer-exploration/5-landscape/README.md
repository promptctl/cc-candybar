# The 1,000 most-committed Claude Code statuslines: clones, new ideas, and why there are so many

**Clones?** Mostly not, at least not at this level of activity. Code fingerprinting finds 101 of the 1,000 sharing most of their statusline code with another project in the set. Agents reading each project found about 15% to be forks, copies or ports. The copying runs almost entirely from two parents, claude-hud and ccstatusline. What the field does share is a design, not code: model, directory, git branch, a context bar that turns green, yellow then red, cost, and the 5-hour and 7-day limits. Nearly every project draws that baseline and writes its own code to do it. None of the 1,000 is built on the example scripts in Claude Code's statusline docs.

**New ideas?** A few dozen, and they cluster. The common extras are already a second baseline: quota fetched from the OAuth usage endpoint (228 projects), burn-rate and run-out forecasts (214), live tool and agent activity read from the transcript (189), spend history (170) and prompt-cache timers (158). The genuinely new work, in 73 projects, does one of these:
- feeds the bar's numbers back into Claude: blocking tools at a quota, resuming the session when a limit resets
- runs an LLM to write about the session
- reads the session's mood or failures
- turns the bar into something else entirely, such as Doom, a golf game, or a book read one line per tick

**Why so many?** Four reasons, in order of weight:
1. The statusline command is the one place Claude Code hands a program its live session data, rate limits included. So orchestrators, usage trackers, companions and menu-bar apps all ship a statusline to get that feed. 388 of the 894 real statuslines here sit inside a larger tool, and 62 wrap or chain someone else's bar because there is only one slot.
2. A statusline is small and Claude will write one for you, so people publish their own setup (136 projects).
3. Plan limits are the itch most of them scratch.
4. The rest are rewrites into another language, forks for Chinese users and regional providers, and toys.

## How the 1,000 were chosen

The input was the 9,558 projects in [../4-styling/all-projects.md](../4-styling/all-projects.md). A script fetched commit counts and dates for every one with a git history: GitHub repos and gists, GitLab, Codeberg. It then dropped four groups:
- 1,876 projects the styling survey's scanner had marked as not statuslines
- 463 with no history (npm pages, blog posts)
- 109 that were gone
- 1,896 with fewer than 5 commits and none in the last 90 days

A fork counts only the commits it added over its parent, since its history otherwise includes the parent's. That left 5,173 projects. The top 1,000 by commit count have at least 45 commits each. cc-candybar itself was left out.

Each project's source was downloaded. Fingerprinting (MOSS-style winnowing over the files that mention Claude's statusline fields) measured code overlap between every pair, and against the docs examples. Fifty haiku agents then read the code and wrote one section per project ([projects.md](projects.md)): what it is, its size, its shape, its data sources, its lineage, why it exists, and what it does beyond the baseline. Further haiku passes sorted the 4,368 beyond-baseline features into 34 families and the 1,000 stated reasons into 16 motives. A last pass screened the features that fit no family for genuinely new ideas. Every count below comes from those labels.

The ranking shapes the picture, so read the shares with that in mind. Projects with 45 or more commits are the substantial ones: only 54 of the 894 statuslines are plain field printers that read stdin and print it. The thousands of 20-line scripts live in the long tail this list leaves out.

| what the project is | count |
|---|---|
| a dedicated statusline | 477 |
| a statusline inside a larger tool (orchestrator, plugin, router, usage tracker) | 388 |
| a config for, or wrapper around, another statusline | 22 |
| a personal dotfiles repo | 7 |
| not a statusline after all (tmux bars, KDE widgets, menu-bar apps that never use the statusLine setting) | 99 |
| unreadable | 7 |

| shape, of the 894 statuslines | count |
|---|---|
| rich: computes or fetches what stdin doesn't give (transcript parsing, usage API, caches, background processes, history) | 558 |
| engine: other people configure it (segments, layouts, themes, configurators) | 193 |
| standard: the baseline done thoroughly | 88 |
| field printer | 54 |

Most were written recently and fast. Of the 1,000, 164 were created in the last 60 days. The median project gains 0.8 commits a day, and a quarter gain more than 2, a rate that suggests Claude is writing much of the code. Primary languages are TypeScript 225, Python 191, Shell 162, JavaScript 151, Rust 107, Go 83 and Swift 27; the Swift projects are mostly menu-bar apps.

## Clones and lineage

Two measures agree that the active end of the field is mostly independent code.

**Code overlap.** 101 projects fall into 24 families in which one member's statusline code is at least half contained in another's (`families.json` in tools, members listed in [projects.tsv](projects.tsv) under `clones_of`). Three families account for more than half:
- **claude-hud, 33 projects.** They are re-uploads, not GitHub forks: claude-hud-cn, claude-hub-glm, claude-hud-bedrock, cometix-hud, claude-hud-plus and many plain `claude-hud` copies. The variants mostly retarget it at Chinese users, the GLM, Kimi or Bedrock providers, or a local proxy. The current jarrodwatts/claude-hud has drifted from the code they copied, so it fingerprints into a separate family of three.
- **ccstatusline, 15 projects,** among them ccstatusline-zh, ccstatusline-zh-tw, ccstatusline-gradient, ccstatusline-usage and ccstatusline-desktop.
- **daniel3303/ClaudeCodeStatusLine, 8 projects,** including statuslin.es.

The rest are pairs: a project and its mirror on another forge, a fork with a few patches, or one author's two repos.

**What the agents found.** Of the 894 statuslines, 658 show no lineage at all. The rest:
- 67 are forks.
- 38 copy code from a named project.
- 26 port one to another language.
- 31 wrap or configure another statusline.
- 111 credit another project as inspiration without sharing code.

Across those relations claude-hud is named about 45 times and ccstatusline about 38, then ccusage 9, claude-powerline 7 and CCometixLine 5. Starship and Powerlevel10k turn up only as credited inspiration.

**The docs template.** No project in the 1,000 shares more than 6% of its fingerprints with the docs examples. Whatever copies the docs scripts has fewer than 45 commits.

So the sameness is convergence. Everyone reads the same stdin JSON and draws the same handful of facts from it, and most arrive at the same layout independently. The baseline every agent was told to treat as unremarkable held for nearly every project it read.

## What is common beyond the baseline

These feature families each appear in dozens to hundreds of projects. They are the field's second layer, not new ideas. Counts are projects, out of 918 with at least one feature beyond the baseline.

| family | projects |
|---|---|
| plan quota fetched outside stdin: the OAuth usage endpoint, with the token read from the keychain or credentials file | 228 |
| burn rate, pace against the window, or a forecast of when a limit or the context runs out | 214 |
| live activity from the transcript or hooks: running tools, subagents, todos | 189 |
| spend or usage history across sessions: daily, weekly or monthly totals, per-project or per-model | 170 |
| prompt-cache TTL countdown, warm or cold, hit rate | 158 |
| other AI CLIs supported (Codex, Gemini, Copilot, opencode) | 124 |
| git beyond branch and dirty: worktrees, stash, diff against main | 106 |
| cost priced from transcript tokens | 102 |
| theming beyond plain colours: gradients, light/dark detection, palettes taken from Claude's theme | 96 |
| installers, settings.json patching, rollback, doctor commands | 95 |
| Claude Code state: effort, permission or sandbox mode, plan mode | 88 |
| several sessions or agents at once | 86 |
| extension points: custom commands, plugins, template languages | 86 |
| PR, CI or deploy status | 81 |
| compaction: context measured against the autocompact point | 78 |
| width-adaptive layout | 74 |
| update checks | 71 |
| an interactive configurator (TUI, wizard, web) | 70 |
| wraps or composes another statusline | 62 |
| background refresh: detached fetches, daemons, caches off the render path | 59 |
| mascots, pets and animation | 58 |
| several Claude accounts | 55 |
| timers, idle detection, response latency | 53 |
| machine metrics (CPU, memory, battery) | 50 |
| sounds and desktop notifications | 48 |
| shown outside the terminal (menu bar, widgets, hardware) | 38 |
| tips, coaching, rotating messages | 37 |
| weather, clocks, markets, news | 34 |
| Anthropic service status | 23 |
| OSC 8 links | 19 |
| language and environment detection | 19 |
| telemetry export (OpenTelemetry) | 17 |
| tmux | 15 |
| localisation | 12 |

The weight sits on one question: will I run out? Quota, pace, cost and cache timers are the top five.

## The new ideas

Haiku screened the 1,250 features that fit no family and marked 101 of them, from 73 projects, as ideas a statusline reader would not expect. I checked several against the source; the ones quoted here hold up.

**Feeding the bar back into Claude (about 26 projects).** These stop treating the statusline as a display for the person and use its numbers to steer the agent:
- funhunter7/claude-limit-guard blocks Claude from ending its turn once per reset window after a limit breach, so it writes a handoff.
- bellwether-ai/btc-claude-plugins, pepsi133/skill-bazaar and victorrentea/victor-statusline deny tool calls or park prompts past a quota percentage.
- jonyfs/astrolabe holds new subagents back.
- moiri-gamboni/session, noambrand/launchpad-cli, jordanallenlewis/ccrig and mturley/agent-handler resume the session or type "continue" when the limit resets.
- team-maro/cc-statusline exposes the bar's state to Claude as an MCP server, and tyejcoleman/tokenroom writes a state file that hooks and an MCP tool read, "so the agent sees the same numbers the human sees".
- marcel-bich's marketplace and makingaipractical/brain-drain tell the agent its own context fill.

**An LLM writing about the session (about 29 projects).** The usual form is a session title or topic written by a background `claude -p --model haiku` call from a Stop hook: dreamiurg/claude-session-topics, dkstm95/claude-recall, maxtomachine/claude-monitor, mquinnv/claudemux, omriariav/claude-pulse. Others go further:
- nadav-fux/claude-2x-statusline has a narrator.
- bllshttng/fno revives Claude Code's removed buddy and has Haiku write its speech each turn.
- bestes206/claude-whereami scores drift between the session's goal and what it is doing now.
- kam-l/claude-coach runs Sonnet over the transcript for reflections, capped at $0.05, and injects the advice.
- ahmadbilal227/pair-polymath runs a planner and critic per "lens" with gpt-5-mini and injects the surviving observations into the next prompt.
- tlogben/common-dev-plugin predicts three follow-up prompts as buttons.
- asyrafhussin/claude-code-statusline has Haiku write a commit message from a button.

**Reading the session's mood or health (about 12 projects).**
- v4l3r10/emobar parses an emotion self-report the assistant writes into each reply, scores behavioural signals in the text, and reports where the two diverge.
- jcsoftlabs/civora-backend and Div0011/Frontend-Pipeline share code that has Haiku classify each turn's behaviour, warning "DESPERATE" with a macOS sound.
- thousandflowers/canary computes a fatigue score from minutes worked, failed tool calls and repeated commands, adjusted for the hour of day.
- li-xingxiao/sbti-buddy-skill types the user into one of 27 personalities from their prompt history.

Failure detectors are the practical cousin:
- pnjegan/burnctl flags retry loops: five or more sessions in ten minutes, a minute or less apart.
- dancemonk/token-damage names waste patterns such as re-reads.
- baeseokjae/claude-code-cockpit flags rule violations in tool results.
- vladimir-ks/ai-agile-claude-code-statusline scans the transcript for secrets.

**The bar as another medium (4 projects).**
- ezequielmm/claude-doom runs doomgeneric as WebAssembly in a detached daemon and draws its latest frame in the statusline, in half-blocks or kitty graphics.
- alrightlad/custom-claude-code-terminal generates a golf course from the session id, with subagents as rival golfers.
- alanmarcero/claude-statusline-arcade-roulette picks a game per session and scores it by lines changed.
- lukelandis3-sketch/claude-and-prejudice streams a book one line per tick at a chosen words-per-minute.

**Reaching into Claude Code itself (3 projects).** zigizhujian/cc-companion rewrites a salt constant in the Claude Code binary and re-signs it. zleo-ai/line patches the installed Claude Code with tree-sitter. supadll/deepseek-hud patches `https.request` in Node to read the API traffic directly.

## Why there are so many

The motive labels, one per project:

| motive | projects |
|---|---|
| a component of a larger product, showing that product's own state | 149 |
| the author's own setup, published | 136 |
| see plan quota and limits | 104 |
| a particular look | 58 |
| track money | 51 |
| one bar for several AI CLIs | 49 |
| show Claude Code's state outside the terminal | 47 |
| a framework for others to configure | 44 |
| a faster or smaller rewrite, or a port | 43 |
| several sessions or agents at once | 41 |
| a customised fork of an existing bar | 40 |
| fun: a mascot, pet or game | 38 |
| localisation or a regional provider | 36 |
| watch the context window | 20 |
| learning or a demo | 6 |
| other (mostly "a general info bar") or not a statusline | 88 |

The largest group explains the shape of the field. The statusline command receives live session JSON, rate limits included, on every tick. rogvid/agent-sidebar's tap exists "because Claude Code passes rate limits only to the statusline command". Any tool that wants that feed has to own the statusline slot. That is why so many orchestrators, routers, memory plugins and usage trackers carry one, and why there is a whole genre of composition: taps that save the feed and then run your real statusline (agent-sidebar, tokenops `--wrap`, fno's buddy), and installers that rewrite `settings.json` and keep a copy of your old line for rollback. Many statuslines exist because the slot is the only door to the data, not because their authors wanted a statusline.

The second group is the cheapest kind of software to publish. A personal bar is a few hundred lines that Claude writes on request, and plugin marketplaces make publishing it one more step. The third is a shared anxiety: plan limits. It drives the usage-endpoint fetching, the burn-rate forecasts and the guards that stop work at 95%. After that come the ordinary reasons any tool gets rewritten: a different language or a faster binary, a Chinese-language or GLM/Kimi/Bedrock fork, a look, or a joke.

## Files

- [projects.md](projects.md): one section per project in rank order. Detail follows what the code does: one sentence for a field printer, up to six for a rich bar or an engine, anchored to files.
- [projects.tsv](projects.tsv): the same 1,000 as a table, with commits, dates, stars, language, kind, shape, motive, feature-family codes ([families.md](families.md)), statusline code size and the closest code overlaps.
- [tools/](tools/): the scripts and agent briefs that produced all of this. They read from and write to `/tmp/ccland`. The downloaded sources (about 3 GB) are not kept.
