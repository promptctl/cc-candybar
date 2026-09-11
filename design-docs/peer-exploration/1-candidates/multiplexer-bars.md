# Candidates — Status bars inside terminal multiplexers and terminal emulators

Stage-one candidate list for the cc-candybar peer exploration. Territory: tmux status-line engines and plugins, zellij status-bar plugins, screen hardstatus tooling, WezTerm status/tab-bar projects, Kitty tab-bar surfaces, iTerm2 status-bar components. All star/commit/push numbers come from `gh api` on 2026-09-10; commit counts are the `rel="last"` page number of a `per_page=1` commit listing. Ordered most interesting first, not most popular first.

## tmux
- **URL:** https://github.com/tmux/tmux
- **Stats:** C · 49,172 stars · 12,127 commits · last push 2026-09-10
- **What it is:** The multiplexer itself, and the reference implementation of a status line whose entire content is one format string re-expanded on a timer (`status-interval`), with up to five stacked status lines addressed as the `status-format[N]` array.
- **Interesting because:** Its format language is the closest existing rival to cc-candybar's Go templates — `#{?cond,a,b}` ternaries, `#{e|*|:x,y}` arithmetic, `#{s/re/rep/:var}` substitution, `#{T:var}` recursive expansion, `#{==:a,b}` comparisons — and since 3.3 `#[range=user|<tag>]…#[norange]` marks a span of the status line as a named clickable region that a `bind -n MouseDown1Status` recovers through `#{mouse_status_range}`, which is exactly cc-candybar's OSC-8 action name seam implemented inside the multiplexer.

## tmux-powerkit
- **URL:** https://github.com/fabioluciano/tmux-powerkit
- **Stats:** Shell · 606 stars · 464 commits · last push 2026-09-08
- **What it is:** A tmux status-bar framework with ~51 shipped plugins (system, dev tooling, media, finance) and 48 themes, built on an explicit plugin contract rather than a pile of shell snippets.
- **Interesting because:** Two mechanisms worth stealing outright — stale-while-revalidate caching with a per-plugin TTL and a stale multiplier (`@powerkit_plugin_battery_cache_ttl`, data up to TTL×N old returned instantly while a background refresh runs), and a colour system where a theme declares only base colours and the renderer derives six variants (light/lighter/lightest/dark/darker/darkest) plus an automatic readable foreground, with plugin `plugin_get_health()` (ok/info/warning/error) mapping to those roles so plugins never choose a colour.

## zjstatus
- **URL:** https://github.com/dj95/zjstatus
- **Stats:** Rust · 1,045 stars · 446 commits · last push 2026-09-07
- **What it is:** The dominant zellij status-bar replacement, compiled to WASM and loaded as a zellij plugin, configured in KDL inside the layout file with per-module format strings (tabs, mode, session, datetime, notifications, swap-layout, command, pipe).
- **Interesting because:** The `command` widget is a first-class scheduled data source — `command_<name>_command`, `_interval`, `_cwd` (interpolating `{focused_pane_cwd}`), and `_rendermode` (static/raw/dynamic) — so an expensive shell-out declares its own refresh budget as data, and the `pipe` widget lets a separate process push content in over `zellij pipe` instead of being polled at all. The author's write-up "Learnings from developing a zellij plugin" (blog.nerd.rocks/posts/profiling-zellij-plugins) is a rare published profile of a status-bar render loop.

## Powerline
- **URL:** https://github.com/powerline/powerline
- **Stats:** Python · 14,813 stars · 2,867 commits · last push 2026-03-11
- **What it is:** The original cross-application statusline engine — one segment library rendered into vim, zsh/bash prompts, tmux, IPython, Awesome and Qtile from a single JSON configuration tree.
- **Interesting because:** `powerline-daemon` is the same two-process architecture cc-candybar uses — a long-lived process holding the parsed config and segment state, with a thin per-render client (`powerline-render`) talking to it over a unix socket, precisely to avoid paying Python startup on every repaint. Its config is a layered JSON tree (`config.json` + per-colorscheme + per-theme files) where each segment declares `priority` for truncation-under-width and `interval` for its own refresh cadence.

## iTerm2
- **URL:** https://github.com/gnachman/iTerm2
- **Stats:** Objective-C · 18,037 stars · 17,374 commits · last push 2026-09-10
- **What it is:** The macOS terminal, whose per-session status bar is a drag-and-drop rack of typed components (battery, CPU, memory, network throughput, git state, clock, job name, search/filter/composer affordances, spacers/springs) plus custom components written against its Python API.
- **Interesting because:** It solves the overflow problem cc-candybar's FlexStrip solves, but declaratively: every component carries `priority` (removal order when space runs out), compression resistance, size multiple, and min/max width knobs, and layout negotiates from those. Custom Python components declare an `update_cadence` and expose typed "knobs" that iTerm2 renders as a real settings UI, and several built-ins are clickable (the git component offers commit/stash/log/branch actions; job name and working directory open popovers) — component-level interactivity without any escape-sequence plumbing.

## tmux-powerline
- **URL:** https://github.com/erikw/tmux-powerline
- **Stats:** Shell · 3,837 stars · 1,193 commits · last push 2026-07-27
- **What it is:** The long-running bash status-bar framework for tmux: segments are individual shell scripts under `segments/`, themes are bash files selecting and colouring them, with single- and double-line status support.
- **Interesting because:** The weather segment is a worked stale-while-revalidate design in pure shell — it always returns the cached file immediately, even when stale, and forks the network fetch into the background so tmux rendering never blocks, with `..._UPDATE_PERIOD` and a separate 24 h `..._LOCATION_UPDATE_PERIOD`. Its `lib/` also carries mechanisms most bars lack: `text_roll.sh` (marquee-scroll a too-long segment across successive repaints), `muting.sh` (temporarily silence a segment), and a `doctor.sh` self-diagnostic.

## WezTerm
- **URL:** https://github.com/wez/wezterm
- **Stats:** Rust · 28,845 stars · 8,703 commits · last push 2026-09-09
- **What it is:** A GPU-accelerated terminal and multiplexer whose status bar is not configuration at all but an `update-status` Lua event handler that calls `window:set_left_status()` / `set_right_status()` with attributed text built by `wezterm.format`.
- **Interesting because:** Its scheduler enforces single-outstanding-callback throttling — if your handler takes longer than `status_update_interval`, WezTerm will not schedule another call until that interval has elapsed *since the last call completed*, so a slow status handler degrades cadence instead of queueing up. `wezterm.format` takes a list of attribute records (`{Foreground={Color=…}}`, `{Attribute={Intensity="Bold"}}`, `{Text=…}`) rather than an escape-sequence string, which is the same "styled fragments, serialize once" shape as cc-candybar's RichText.

## tmux-nova
- **URL:** https://github.com/o0th/tmux-nova
- **Stats:** Shell · 213 stars · 63 commits · last push 2026-09-01
- **What it is:** A tmux status-line theme engine where the whole bar is declared as tmux user options rather than as a `status-right` string, then compiled into format strings by `scripts/nova.sh`.
- **Interesting because:** It turns the segment registry into data inside tmux's own option store — `@nova-segment-<name>` holds the content, `@nova-segment-<name>-colors` its fg/bg pair, and `@nova-segments-0-left` / `-right` is an ordered list of segment names placed in row 0 — which is a one-for-one analogue of cc-candybar's named `segments:` block plus a `root` row that only references names, implemented with nothing but tmux options and a render pass.

## tmux-packet-loss
- **URL:** https://github.com/jaclu/tmux-packet-loss
- **Stats:** Shell · 14 stars · 733 commits · last push 2026-08-19 — *low stars, single author, but 733 commits and an unusually deliberate architecture; weigh on mechanism, not popularity*
- **What it is:** A tmux plugin that shows packet loss in the status line, backed by a continuously running background ping monitor rather than a per-repaint probe.
- **Interesting because:** It is the most explicitly engineered data-freshness design in the tmux plugin ecosystem — a SQLite database in WAL mode with three tables (current losses, last-minute samples, retained one-minute averages), a monitor that stops when no tmux client is attached and restarts on reattach, a "reactive" mode that computes several rolling averages and reports the highest so spikes stay visible while decaying, a 45-second warm-up where losses display but are not recorded (so resume-from-sleep noise never enters history), and a documented conversion of every script from bash to POSIX sh purely to cut 3–4× off per-render startup time.

## Byobu
- **URL:** https://github.com/dustinkirkland/byobu (primary home is Launchpad: https://launchpad.net/byobu)
- **Stats:** Python · 1,709 stars · 3,482 commits · last push 2026-09-04
- **What it is:** The status-line and window-management layer that wraps *either* GNU screen (hardstatus) or tmux with one shared set of "status notifications" — the only project in this territory that targets both backends from one status engine.
- **Interesting because:** The refresh interval is encoded in the filename: a custom status script lives at `$BYOBU_CONFIG_DIR/bin/NN_name` where `NN` is the number of seconds between refreshes, and byobu caches each item's output and re-runs only the scripts whose interval has elapsed — a whole scheduling policy expressed as data with no config file at all. Individual notifications are toggled from a curses configuration utility (`byobu-config`), and `byobu-status-detail` gives a status item a drill-down view.

## catppuccin/tmux
- **URL:** https://github.com/catppuccin/tmux
- **Stats:** Shell · 3,168 stars · 324 commits · last push 2026-06-18
- **What it is:** Nominally a theme pack, but the v2 rewrite turned it into a status-module system: the user composes `status-right` from named modules (`#{E:@catppuccin_status_session}`, `_cpu`, `_battery`, `_uptime`, `_application`) and can drop in their own.
- **Interesting because:** It leans on tmux's `#{E:…}` *deferred* expansion so a module's definition is stored once as an option and re-expanded per repaint, which is how a theme pack acquired a genuine module loader without a build step or a plugin runtime — worth including precisely as the "theme grew machinery" case. Custom modules are files dropped into `status/` that follow a `show_<name>` naming contract, and there are per-module text/icon override options so a module's glyph and its data are separately overridable.

## Kitty
- **URL:** https://github.com/kovidgoyal/kitty
- **Stats:** Python · 34,850 stars · 19,212 commits · last push 2026-09-10
- **What it is:** A GPU-based terminal whose tab bar doubles as its status surface; setting `tab_bar_style custom` hands rendering to a user `tab_bar.py` exposing `draw_tab(draw_data, screen, tab, before, max_tab_length, index, is_last, extra_data)`.
- **Interesting because:** The callback paints directly into a `Screen` object cell-by-cell — you get the cursor position before and after, so a custom bar can reserve the right-hand cells for a clock or CPU readout and clip the tab list to what remains, and `extra_data` carries the previous/next tab so a powerline separator can pick its colour from its neighbour. Crucially it is event-driven rather than interval-driven: the bar redraws on tab/activity changes, and anything time-based has to arm its own `add_timer`, which is the inverse of every tmux bar's polling model.

## Zellij
- **URL:** https://github.com/zellij-org/zellij
- **Stats:** Rust · 35,369 stars · 3,357 commits · last push 2026-09-09
- **What it is:** A Rust terminal workspace whose status bar and compact bar are not built-in chrome but ordinary WASM plugins loaded from the layout file, on the same footing as any third-party plugin.
- **Interesting because:** The plugin API is an event-subscription model (`subscribe([Event::ModeUpdate, Event::TabUpdate, …])`) with a capability/permission prompt per plugin, plus `zellij pipe` for pushing data into a running plugin from outside — so a status bar recomputes only on the events it asked for, and external producers push rather than the bar polling. The whole zjstatus/zellij-cb/vertical-tabs ecosystem exists because that surface is replaceable, which is itself the UX lesson.

## gitmux
- **URL:** https://github.com/arl/gitmux
- **Stats:** Go · 795 stars · 88 commits · last push 2026-02-17
- **What it is:** A single Go binary that prints a git status string formatted for the tmux status bar, invoked from `status-right` via `#()`.
- **Interesting because:** Its YAML config splits into `symbols` / `styles` / `layout` / `options`, where `layout` is an ordered array mixing keywords (`branch`, `remote-branch`, `divergence`, `flags`, `stats`) with literal strings — a tiny declarative row grammar with no template engine — and `styles` are raw tmux format strings, so the tool never owns colour semantics. It also ships a `-timeout` flag that aborts the whole invocation past a deadline, the per-segment time budget cc-candybar's git provider would want.

## tabline.wez
- **URL:** https://github.com/michaelbrusegard/tabline.wez
- **Stats:** Lua · 309 stars · 158 commits · last push 2026-07-23
- **What it is:** A WezTerm tab-bar/status plugin that deliberately copies lualine.nvim's configuration format, installed through WezTerm's own `wezterm.plugin.require("https://github.com/…")` git-based plugin manager.
- **Interesting because:** It imports lualine's six-slot section model (`tabline_a` … `tabline_z`, plus tab and window section sets) so position in the bar is a named slot rather than an index, and components are either a builtin name, a string, or a function, each with `icon`/`padding`/`fmt`/`cond` options — `cond` being a per-component predicate evaluated per render, the direct analogue of a segment `when:`. The plugin-manager story (require a git URL, WezTerm clones and caches it) is the most frictionless install UX in this territory.

## zjstatus-hints
- **URL:** https://github.com/b0o/zjstatus-hints
- **Stats:** Rust · 86 stars · 49 commits · last push 2026-05-07
- **What it is:** A separate zellij WASM plugin that computes mode-aware keybinding hints and feeds them into zjstatus, rather than rendering anything itself.
- **Interesting because:** It composes two plugins over zellij's named-pipe channel — zjstatus exposes a `pipe` widget, zjstatus-hints writes into that pipe on mode change, and the bar renders content it never computed. That is a clean answer to "how does a third party add a widget to someone else's bar without being a fork", and it is push-driven, so the hint costs nothing on repaints where the mode did not change. A downstream fork (myah-mitchell/zjstatus-hints) adds width-aware fitting of the hint text.

## Tabby
- **URL:** https://github.com/brendandebeasi/tabby
- **Stats:** Go · 79 stars · 736 commits · last push 2026-09-10 — *low stars for 736 commits and daily activity; included for the daemon + mouse mechanism*
- **What it is:** A vertical tab manager for tmux — a persistent sidebar pane listing sessions/windows with grouping and themes, driven by a background Go daemon rather than by `status-interval` shell-outs.
- **Interesting because:** It is the clearest tmux-native example of the architecture cc-candybar uses — a daemon collects state on its own tick and the visible pane is a thin renderer — and it wires full mouse support onto that surface, so clicking a row switches window, which is the "clickable status region backed by a long-lived process" combination almost nothing else in the tmux ecosystem attempts.

## tmux-transient-status
- **URL:** https://github.com/TheSast/tmux-transient-status
- **Stats:** Shell · 24 stars · 15 commits · last push 2026-07-25 — *small and low-star; listed for the UX mechanism only*
- **What it is:** A tmux plugin that hides the status bar entirely and reveals it only while the prefix key is held (or on other configured triggers), restoring it afterwards.
- **Interesting because:** It reframes the refresh-cost question as a visibility question — the bar costs nothing when it is not on screen — and implements it through tmux's `client-session-changed`/key-table hooks plus `status off`/`status on`, with configurable per-trigger content so the transient bar can show *different* information than the persistent one would. The "transient prompt" idea is common in shell prompts and almost unheard of in multiplexer bars.

## tmux-mem-cpu-load
- **URL:** https://github.com/thewtex/tmux-mem-cpu-load
- **Stats:** C++ · 1,129 stars · 401 commits · last push 2026-08-04
- **What it is:** A small compiled C++ binary printing memory, CPU percentage and load averages into the tmux status line, with per-platform native sampling (Linux, macOS, FreeBSD, OpenBSD, NetBSD, Windows).
- **Interesting because:** Beyond being compiled precisely so it can be exec'd every second, it draws inline graphics from data — a textual bar graph whose bar count is configurable (`--graph-lines`, e.g. set to your core count) and an optional `--vertical-graph` block-character chart — and it solves the cross-process seam problem with `--segments-left <color>` / `--segments-right <color>`: the caller passes the neighbouring segment's colour so the binary paints its own powerline end-caps to blend with segments it knows nothing about. That is the joiner contract cc-candybar owns internally, exposed as CLI arguments.

## muxbar
- **URL:** https://github.com/dlurak/muxbar
- **Stats:** Rust · 46 stars · 29 commits · last push 2025-05-01 — *small, single author, quiet since mid-2025; included because the configuration model has no peer in this list*
- **What it is:** A tmux status bar whose configuration *is* a Rust program: you edit a `main.rs` that assembles typed modules into a bar and compile it, and the resulting binary is what `status-right` calls.
- **Interesting because:** It is the opposite extreme from a format-string DSL — the config language is the host language, so conditionals, colour math and custom modules are just Rust, with the type checker as the config validator and zero runtime parse cost. Worth reading as the argument cc-candybar is answering when it chooses a template DSL over config-as-code, and for its module set (which includes per-module styling structs rather than colour strings).
