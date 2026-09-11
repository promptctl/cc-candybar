# Peer exploration — territory: shell prompts

Candidate list for stage one. Every star/commit/push figure below came from `gh api repos/OWNER/REPO` and the `Link: … rel="last"` page count on `repos/OWNER/REPO/commits?per_page=1`, fetched 2026-09-10. Ordered most interesting first for cc-candybar's four axes (performance, widgets, UX, unique features), not by popularity. A fifth axis — whether the project has a real config *language* rather than string placeholders — is called out per entry where it applies.

## Oh My Posh
- **URL:** https://github.com/JanDeDobbeleer/oh-my-posh
- **Stats:** Go · 23,439 stars · 5,480 commits · last push 2026-09-09
- **What it is:** A cross-shell, cross-platform prompt *renderer*: a Go binary that reads a JSON/YAML/TOML theme file and prints the prompt, driven from bash, zsh, fish, nu, pwsh, cmd and more.
- **Interesting because:** It is the closest existing thing to cc-candybar's config model — every segment's `template` is a **Go template with the Sprig function library**, so conditionals and computed text live in the config rather than in code, and each segment carries a `cache` object (duration plus a session/folder scope strategy) so an expensive probe like `winget upgrade` or `git status` is not re-run per repaint. Its **tooltips** feature is the standout UX idea: typing a keyword (e.g. `git`) causes an extra right-aligned segment to appear for that command only, which is a disclosure triggered by input rather than by a click.

## Powerlevel10k
- **URL:** https://github.com/romkatv/powerlevel10k
- **Stats:** Shell · 55,081 stars · 4,330 commits · last push 2026-09-06
- **What it is:** A zsh theme, written in highly-optimised zsh, that is effectively a prompt engine with ~50 built-in segments and a wizard-generated config file.
- **Interesting because:** **Instant prompt** caches the previous prompt's rendered bytes to disk and dumps them to the terminal *before* `.zshrc` has finished sourcing, then seamlessly overwrites with the real prompt — the exact "warm cache, render immediately, correct later" trade cc-candybar makes with its daemon. Pair that with **transient prompt** (every accepted command line is rewritten to a one-glyph prompt so scrollback stays dense) and the `p10k configure` wizard, which writes a heavily-commented config file rather than an opaque blob, so the wizard output is itself the documentation.

## Starship
- **URL:** https://github.com/starship/starship
- **Stats:** Rust · 59,851 stars · 4,396 commits · last push 2026-09-10
- **What it is:** A single Rust binary invoked once per prompt that renders a configurable module list for any shell, configured by one `starship.toml`.
- **Interesting because:** Modules are resolved **concurrently with a per-module timeout budget** (`command_timeout`, `scan_timeout`), so a hung `git` call degrades that one module instead of the whole prompt; and its `format` strings use **optional groups** — `($branch )` disappears entirely when `branch` is empty — which is a real conditional in the format language, not a placeholder. Ship `starship timings` and `starship explain`, which profile each module's wall-clock cost and state *why* it rendered, a debugging surface cc-candybar currently has no equivalent of.

## angel-PS1
- **URL:** https://github.com/dolmen/angel-PS1
- **Stats:** Perl · 64 stars · 636 commits · last push 2021-04-21 — low stars, effectively dormant, but 636 commits and the only true daemon prompt found in this territory
- **What it is:** A prompt for bash/zsh implemented as a **persistent background daemon** that services the shell each time it needs a prompt, rather than forking helpers per render.
- **Interesting because:** It is cc-candybar's architectural twin from 2011 — the shell talks to a long-lived process that already holds the expensive state, so prompt cost is IPC plus a lookup instead of process spawn plus computation. Worth reading for how it handles daemon lifetime, per-shell attachment and the fallback when the daemon is absent, which are exactly cc-candybar's socket/miss/spawn concerns in a different language.

## Powerline
- **URL:** https://github.com/powerline/powerline
- **Stats:** Python · 14,813 stars · 2,867 commits · last push 2026-03-11
- **What it is:** The original segment-bar project: one Python engine driving prompts for zsh/bash/tcsh plus statuslines for vim, tmux, i3 and IPython, all from shared JSON theme files.
- **Interesting because:** It solved the Python-startup problem the same way cc-candybar solves Node startup — `scripts/powerline-daemon` plus a tiny **C client** (`client/powerline.c`) and a pure-shell client (`client/powerline.sh`) as fallback, which is the Rust-client/Node-fallback split verbatim. Its themes give each segment a numeric **`priority`** and support `width: auto` spacer segments, so when the line is too narrow the engine drops the highest-priority-number segments first and redistributes the slack — a declarative overflow policy that is strictly more expressive than cc-candybar's `FlexStrip` auto-wrap. It also ships `powerline-lint`, a config validator as a first-class command.

## Liquidprompt
- **URL:** https://github.com/nojhan/liquidprompt
- **Stats:** Shell · 4,674 stars · 1,565 commits · last push 2026-09-10
- **What it is:** An "adaptive" prompt for bash and zsh in portable shell, whose design premise is that a segment should appear only when its value is worth acting on.
- **Interesting because:** Every widget is **threshold-gated** rather than always-on — battery shows only when nearly empty, memory only when short, load only when high, temperature only when hot, disk only when low, shell level only when deeply nested — which is a far more disciplined version of cc-candybar's `when` predicates and worth mining as a design rule. Its widget breadth is the largest in this territory: five VCS backends (git, hg, svn, fossil, bzr), wifi signal strength, dir-stack depth, sudo-credential state, multiplexer detection across tmux/screen/zellij/shpool, proxy presence, X-forwarding, an errno-to-meaning decoder for the last exit code, and an `LP_ENABLE_HYPERLINKS` option that makes prompt elements OSC-8 clickable.

## starship-ftl
- **URL:** https://github.com/mattmc3/starship-ftl
- **Stats:** Shell · 21 stars · 31 commits · last push 2026-08-12 — tiny and young, included purely for the mechanism
- **What it is:** A zsh wrapper that removes the startup latency of a Starship prompt by drawing a prompt before the shell has finished initialising.
- **Interesting because:** It **precomputes and caches** Starship's answers under `$XDG_CACHE_HOME/starship-ftl`, **keyed on the size and mtime of the starship binary plus the config file** — a cheap, exact staleness key that is directly transferable to cc-candybar's bundle-identity/`sourceDigest` problem. Its `-P` mode reads a separate lightweight `ftl-prompt` profile out of the same `starship.toml` so the first paint avoids anything that shells out, i.e. a declared low-cost approximation of the real bar.

## apollo-zsh-theme
- **URL:** https://github.com/mjrafferty/apollo-zsh-theme
- **Stats:** Shell · 75 stars · 335 commits · last push 2026-03-03
- **What it is:** A zsh "theme framework" rather than a theme: modules are composed into left/right prompt lists and every knob is set through zsh's native `zstyle`.
- **Interesting because:** Using **`zstyle` as the config language** gets context-awareness and wildcard matching for free — a setting can be scoped to a module, a host or a pattern without inventing a merge algorithm — which is a genuinely different answer to cc-candybar's `mergeWithDefault`. Two more ideas worth stealing: per-module caching with a **manual invalidation gesture** (press Enter N times to force a refresh when you know the world changed, e.g. after switching networks with a `public_ip` module), and a separate **scrollback theme** applied to the line before it is committed to the buffer, so a multi-row prompt collapses to one row in history.

## Tide
- **URL:** https://github.com/IlanCosman/tide
- **Stats:** Shell · 4,261 stars · 1,196 commits · last push 2025-12-15
- **What it is:** A pure-fish prompt built around a `_tide_item_*` function per segment and two ordered `items` lists (left and right).
- **Interesting because:** `tide configure` is the best **interactive configuration wizard** in the territory — it renders live candidate prompts in the terminal and walks style/icon/colour/layout questions, writing the result to universal variables, so discovery happens by seeing rather than by reading docs. Its async rendering is explicitly justified as a *feature budget*: because git work runs off the prompt path, Tide can afford to show untracked/modified/deleted **counts** where synchronous prompts show only a dirty flag.

## bkt
- **URL:** https://github.com/dimo414/bkt
- **Stats:** Rust · 358 stars · 135 commits · last push 2025-06-06
- **What it is:** A standalone subprocess-caching binary (and Rust library) — `bkt --ttl=10m -- expensive-command` — extracted from the author's bash prompt work (`dimo414/bash-cache`, Shell · 88 stars · 84 commits · last push 2023-01-05).
- **Interesting because:** It implements **stale-while-revalidate for shell commands**: each cached result carries both a TTL deadline and a shorter *refresh* deadline, so a call past the refresh point returns the stale value immediately and kicks off a background re-run, meaning the prompt never blocks and never shows data older than the TTL. That is precisely the policy cc-candybar's PR-lookup cache approximates with two TTLs, expressed as a reusable primitive with a cache key derived from the command and its arguments.

## agkozak-zsh-prompt
- **URL:** https://github.com/agkozak/agkozak-zsh-prompt
- **Stats:** Shell · 354 stars · 968 commits · last push 2026-05-31
- **What it is:** A small, framework-agnostic async zsh prompt showing git, exit status, SSH, virtualenv and vi-mode as ASCII indicators.
- **Interesting because:** It carries **three named async strategies and picks one at runtime** — `usr1` (disowned child computes git status then raises `SIGUSR1`, whose trap repaints), `subst-async` (process substitution plus a `zle -F` file-descriptor callback), and `zsh-async` (zpty pseudo-terminal workers) — falling back automatically when `SIGUSR1` is taken or the platform misbehaves, with `AGKOZAK_FORCE_ASYNC_METHOD` as the override. A rare, explicit catalogue of every way a shell can do non-blocking work, with the portability trade-offs of each documented.

## geometry
- **URL:** https://github.com/geometry-zsh/geometry
- **Stats:** Shell · 996 stars · 384 commits · last push 2025-01-13
- **What it is:** A minimal, composable zsh prompt where a segment is just a shell function appended to one of four location arrays.
- **Interesting because:** `GEOMETRY_INFO` is a **secondary prompt revealed by pressing Enter on an empty line** — a disclosure affordance with no click, no menu and no state machine, which is a strikingly cheap answer to the problem cc-candybar solves with disclosure bands. The plugin API is the whole config language: `GEOMETRY_PROMPT+=(my_fn)`, with `GEOMETRY_RPROMPT` rendering asynchronously and `GEOMETRY_TITLE`/`GEOMETRY_CMDTITLE` targeting the terminal title, so placement is data and behaviour is a function.

## rainbarf
- **URL:** https://github.com/creaktive/rainbarf
- **Stats:** Perl · 1,206 stars · 173 commits · last push 2026-08-15
- **What it is:** A CLI widget that renders CPU, memory, swap and battery **history** as a compact chart for embedding in a prompt or tmux status line — "like Rainmeter, but for CLI".
- **Interesting because:** It is the only project in this territory whose widget is a **time series rather than a scalar** — it keeps a persistent history file between invocations and draws it as a coloured block/braille sparkline sized to a given column count, with a rainbow/ANSI colour mode. Directly relevant to cc-candybar's `tokenSparkline` and the "series crosses the var seam as a string" problem: rainbarf shows what sustained history, fixed-width binning and a colour ramp over a series look like when the renderer gets N columns and no more.

## promptline.vim
- **URL:** https://github.com/edkolev/promptline.vim
- **Stats:** Vim script · 627 stars · 84 commits · last push 2024-07-26
- **What it is:** A vim plugin that does not run at prompt time at all: it **generates a plain `.sh` file** containing a finished prompt, from a declarative section/theme description, which the shell then sources on login.
- **Interesting because:** This is the extreme end of the latency axis — **ahead-of-time compilation of the prompt**, spawning no external binaries at render (explicitly "no python, not even grep or sed"), because every branch that can be decided at generation time already was. It also derives its colours from vim-airline themes, so one theme definition drives both the editor statusline and the shell prompt — a single palette source across two renderers, which is the cross-surface version of cc-candybar's palette resolvers.

## powerline-go
- **URL:** https://github.com/justjanne/powerline-go
- **Stats:** Go · 2,892 stars · 473 commits · last push 2026-08-11
- **What it is:** A single low-latency Go binary that prints a powerline-style prompt, driven by command-line flags from bash/zsh/fish.
- **Interesting because:** Its entire configuration surface is **`-modules` — an ordered, comma-separated module list passed as an argv flag**, with `-modules-right` for the right prompt and `-priority` controlling which modules are dropped when the terminal is too narrow; there is no config file to parse, which makes startup cost essentially argv parsing. Worth reading for its module set (git and hg working-tree summaries, nix-shell, kubernetes context, AWS profile, terraform workspace, exit code, jobs, load, ssh, docker, per-language runtimes) and for how cheaply each decides it is irrelevant to the current directory.

## Spaceship Prompt
- **URL:** https://github.com/spaceship-prompt/spaceship-prompt
- **Stats:** Shell · 20,572 stars · 2,005 commits · last push 2026-09-02
- **What it is:** A zsh prompt with ~50 sections (language runtimes, package managers, cloud contexts, VCS) ordered by a single `SPACESHIP_PROMPT_ORDER` array.
- **Interesting because:** It defines an explicit, documented **section contract** — a `spaceship_<name>` function plus a `SPACESHIP_<NAME>_SHOW` guard, rendered through a shared `spaceship::section` helper that owns prefix/suffix/colour/symbol — so third-party sections are first-class and there is a separate `spaceship-section` template repo for authoring them. That is the closest analogue to cc-candybar's `docs/segment-authoring.md` problem: how to make a user-authored segment indistinguishable from a built-in one, solved by giving the section one function signature and letting the framework own all chrome.

## shell.async-goprompt
- **URL:** https://github.com/NonLogicalDev/shell.async-goprompt
- **Stats:** Go · 11 stars · 38 commits · last push 2025-07-18 — near-zero stars, single author; included for the redraw mechanism alone
- **What it is:** A zsh prompt whose data is produced by a Go binary and delivered back into the shell through ZLE file-descriptor handlers.
- **Interesting because:** It builds the prompt on **`zle -F` co-routines over a pipe** — the shell registers a file descriptor with the line editor and the editor calls back when bytes arrive, so the prompt repaints mid-keystroke without polling, without signals and without blocking the input loop. This is the cleanest demonstration of the "push a render when data lands" pattern that cc-candybar can only approximate through Claude Code's refresh tick, and the small codebase makes the protocol easy to read end to end.

## silver
- **URL:** https://github.com/reujab/silver
- **Stats:** Rust · 504 stars · 163 commits · last push 2024-02-21 — maintenance appears stopped, but the config model is worth the read
- **What it is:** A cross-shell powerline-style prompt in Rust with icon support, configured by a single TOML file.
- **Interesting because:** Its TOML declares the prompt as **two ordered arrays of `[[left]]`/`[[right]]` segment tables**, each carrying its own `fg`/`bg` and per-segment options, with the powerline separator glyphs themselves configurable (`separator`, `thin_separator`, and their right-hand mirrors) — so the joiner vocabulary is data rather than a hard-coded style enum, which is the same separation cc-candybar draws between `StripStyle` and `globals.charset`. Good small reference for a segment schema that stays honest without a template language.

## Bash Prompt Generator
- **URL:** https://github.com/Scriptim/bash-prompt-generator
- **Stats:** TypeScript · 869 stars · 238 commits · last push 2025-06-15
- **What it is:** A browser app that builds a bash `PS1` string interactively — you assemble elements, style them, and it emits the escape-laden one-liner to paste into `.bashrc`.
- **Interesting because:** It is the clearest **UX answer to an unreadable config format**: rather than teaching `\[\e[38;5;208m\]`, it renders a **live preview** of the prompt as you click, and the generated string is the whole output — no runtime, no dependency, nothing to install. The same idea appears as `jamesmontemagno/ohmyposh-configurator` (TypeScript · 132 stars · 163 commits · last push 2026-08-03) for Oh My Posh themes; both are worth studying for how a visual builder and a text config can coexist without the builder becoming the only supported path.

## Pure
- **URL:** https://github.com/sindresorhus/pure
- **Stats:** Shell · 14,417 stars · 429 commits · last push 2026-07-16
- **What it is:** The canonical minimal zsh prompt — path, git branch, dirty marker, command duration, and a prompt character that turns red on non-zero exit.
- **Interesting because:** It popularised **async prompts in zsh** by building on `mafredri/zsh-async` (Shell · 820 stars · 219 commits · last push 2023-11-15), which runs worker jobs inside a `zsh/zpty` pseudo-terminal and delivers results via a callback — the library most of this territory's async prompts either use or were written to replace. Its other transferable idea is a **periodic background `git fetch`** on a `PURE_GIT_PULL_INTERVAL` timer, so the `⇣⇡` ahead/behind arrows reflect the remote without any command ever blocking on the network — a scheduled refresh of a network fact, distinct from caching one.
