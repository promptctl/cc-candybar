# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

<!-- BEGIN LIT INTEGRATION -->
## lit Agent-Native Workflow

This repository uses `lit` for agent-native issue tracking.

Start by running `lit quickstart` to load the workflow instructions. It prints how tickets are found, created, updated, and closed here, so running it first means the rest of your work follows the conventions this repo expects. It's a quick, read-only command — no need to check in before running it.

As you work a ticket, record its phase at each move: `lit phase <id> --to impl` when you start writing code, `lit phase <id> --to review` when its PR opens, `lit phase <id> --to merge` when review is done and the merge is under way. `lit start` puts it in `plan`, and `lit done <id>` ends it.

<!-- END LIT INTEGRATION -->

## What this is

cc-candybar renders Claude Code's statusline. A small client runs on every statusline tick. It relays the hook JSON over a unix socket to one long-lived daemon per user, which owns every cache and is the only renderer. The bar is defined by a JSON5 config (variables, segments, actions and a layout tree) merged over a bundled default.

## Rules for every task

- pnpm is the package manager. Don't add an npm or yarn lockfile.
- Publishing runs lint, typecheck, the TS↔Rust protocol check, the schema drift check and the build, in that order. Any failure blocks the publish. Fix the cause and never bypass a step.
- **The project publishes 1.x only.** Four things enforce the pin: a major-version guard in the release scripts, a release config that ships breaking commits as minors, a GitHub tag ruleset, and a project hook that refuses agent edits to those three. Don't work around any of them. If a task seems to need a 2.0, stop and ask.
- The Rust crate's version stays 0.0.0. The npm version is the source of truth, and CI writes it into the crate at build time.
- The wire contract is spelled in both runtimes. Change a mirrored constant in both in the same commit, or publish fails.
- The daemon is detached, so its environment belongs to whichever shell happened to spawn it. Every fact about a session comes from the client as a hint: Claude Code's directory, the config path, the tmux pane, the terminal. Reading `CLAUDE_CONFIG_DIR` from the daemon's own env works on your machine and is wrong for every other session.

## Architectural laws

The code cites laws inline, such as `[LAW:one-source-of-truth]`, `[LAW:dataflow-not-control-flow]`, `[LAW:single-enforcer]`, `[LAW:no-defensive-null-guards]`, `[LAW:no-silent-failure]`, `[LAW:locality-or-seam]` and `[LAW:one-type-per-behavior]`. They mark invariants the code depends on, and reviews use them as vocabulary. When you change code a law governs, cite the law you're acting under (`// [LAW:<token>] reason`) or the exception you're taking (`// [LAW:<token>] exception: reason`). Don't silently delete a law marker.

How they show up here:

- **One render path.** The daemon, the check command, the demo and the tests all draw through the same functions. There is no parallel renderer and no fallback computation.
- **One store.** The variable store (MobX) is the single source of truth for derived values. Don't add a cache beside it.
- **Variability lives in data.** The payload carries every value a template reads. Segments show and hide by `when` over values, not by branches in code.
- **Errors are loud.** Every error and warning shows as a `⚠ N` indicator beside the settings door, red or amber, whose click opens a viewer with the message in full. Nothing a config authors can make a render throw. Don't add a silent default that hides a broken state.

## Memory

`.claude/memory/` holds what the code can't tell you: why things are built the way they are, and the traps. Before you change an area, read its file.

- `.claude/memory/architecture.md`: the client and daemon, the wire, hints, logs and stats, packaging and install. Read before you touch the client, the protocol, a hint, daemon lifetime, or install.
- `.claude/memory/daemon-memory.md`: the memory limit, the render cache's budget, and how state is retired and disposed. Read before you touch caches, eviction, reload, or anything holding MobX subscriptions.
- `.claude/memory/data-sources.md`: how git, PRs, transcripts, usage, plugin sources, auto-compact and tmux are read, held and refreshed, and what pending means. Read before you add or change a source or a payload field.
- `.claude/memory/rendering.md`: the render walk, the instant and projections, template traps, layout, effects and transitions. Read before you change how a frame is drawn or add a template function.
- `.claude/memory/colour.md`: decoration by address, open triggers and bands, contrast floors, styles and theme selection, colour functions. Read before you change anything that picks a colour.
- `.claude/memory/config.md`: resolution and merge, the config file as the durable store, settings rows, drafts, save, reset, undo, edit mode and placements. Read before you touch the loader, a setting, or a click that writes the config.
- `.claude/memory/interaction.md`: actions and gates, pickers, disclosures, the settings menu, slash commands. Read before you add an action, a menu or a control.
- `.claude/memory/frames-and-lanes.md`: pushed frames, the animation lanes, relaunching Claude Code, the tmux status line. Read before you touch feeds, lanes or tmux.
- `.claude/memory/doctor.md`: the doctor's checks and the traps behind its probes. Read before you change a check.
- `.claude/memory/testing.md`: test isolation and the traps in reading a draw. Read before you write a test.

If you're authoring a config or a custom segment, read `docs/interaction-authoring.md` and `docs/segment-authoring.md`. Their snippets are tested against the live loader, so they stay current.

## Writing to this file and to memory

Every session loads this file, and every agent working in an area reads that area's memory file, so each line costs something on every read. A line earns that cost by holding something the code can't show: the reason behind a design, a trap the code hides, a convention nothing enforces. Write it in present tense, by concept, as a reason. When you change a design that a memory line explains, fix or delete that line in the same commit.

This goes wrong at the end of a ticket. The design is fresh, and writing it up feels like diligence: *"I'll describe how the new cache works so the next agent knows."* Don't. A paragraph that restates the code is a second clock. It's right until someone changes the code, and after that it's wrong with full confidence, while every session still pays to read it. The next agent will read the code anyway. Write down the one reason or trap the code hides, and leave the rest to the code.

Leave out:

- Code identifiers: function, type, constant, file and test names. Name the concept and the reader will find the code. Identifiers are the first thing to go stale.
- Ticket ids, PR numbers, and who decided what.
- History: what something used to be, what replaced it, what got removed. If a rejected approach matters, say in present tense why it fails.
- Measurements, when the reason they support can stand on its own.

Example:

- WRONG: "The render cache (`src/daemon/cache/render.ts`) is bounded by bytes: `renderCacheBudget()` evicts LRU entries while `entries × ENTRY_BYTES` exceeds it (abc.123: each entry used to hold its own 9.3 MB compile)."
- RIGHT: "Entries share one compile, because a new entry appears for every directory a session renders from, and one compile per entry exhausts the memory limit. So a compile captures nothing that differs per directory."

Keep the index to one line per file. A new area gets a new file and a line here.
