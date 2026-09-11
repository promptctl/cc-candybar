# Peer exploration

A staged survey of projects adjacent to cc-candybar, run to mine them for ideas on
performance, widgets, UX, and unique features.

Staged deliberately: each stage narrows the field and deepens the reading, and each
stage's output is a document in this directory that the next stage consumes.

## Stages

| Stage | Directory | Output |
|-------|-----------|--------|
| 1. Candidates | `1-candidates/` | One file per survey territory, listing projects with a name, URL, verified stats, a description, and what makes each interesting. |

Later stages are added here as they are run.

## Stage 1 method

Nine subagents surveyed nine territories in parallel, each writing one file. The
territories partition the space by what kind of thing renders the bar, not by
alphabet, so that the same project is rarely found twice:

| File | Territory |
|------|-----------|
| `claude-code-statuslines.md` | cc-candybar's own niche |
| `ai-agent-huds.md` | Status bars for Codex, Gemini CLI, opencode, aider and the rest |
| `shell-prompts.md` | Starship, Powerlevel10k, oh-my-posh and their lineage |
| `multiplexer-bars.md` | tmux, zellij, WezTerm and Kitty status surfaces |
| `desktop-bars.md` | Waybar, Polybar, eww, SketchyBar, xbar and the plugin protocols |
| `editor-statuslines.md` | Heirline, lualine, doom-modeline and editor component models |
| `perf-daemons.md` | gitstatusd, watchman, mise: the repeated-computation substrate |
| `terminal-interaction.md` | OSC-8, terminal graphics, capability detection, cell width |
| `config-and-theming.md` | Config languages, schema UX, format-preserving edits, colour science |

Every star count, commit count and last-push date in stage 1 was read from the GitHub
API rather than from a page or from memory. Commit counts come from the `rel="last"`
page number of a one-per-page commits request. Anything that could not be verified is
marked `unverified` rather than estimated.

Overlap between territories was allowed and deduped afterwards, on the reasoning that
a duplicate is cheap to remove and a gap is invisible.
