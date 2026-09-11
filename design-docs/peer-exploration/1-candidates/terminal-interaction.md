# Candidates — Terminal interaction and rendering mechanisms (outside the fullscreen TUI)

Stage-one candidate list. Territory: OSC-8 hyperlinks and click routing, custom URL-scheme input channels, terminal graphics and out-of-band protocols, capability detection and degradation, cell-width measurement, and rich rendering libraries used for non-fullscreen output. Every star/commit number comes from `gh api` on 2026-09-10 (commit counts from the `Link: rel="last"` page number of `commits?per_page=1`); anything not obtainable that way is marked `unverified`. Ordered most interesting first for cc-candybar's lens, not by popularity.

## kitty (open-actions.conf + remote control)
- **URL:** https://github.com/kovidgoyal/kitty
- **Stats:** Python · 34,850 stars · 19,212 commits · last push 2026-09-10
- **What it is:** A GPU terminal emulator that has originated more terminal protocols than anyone else, and exposes most of them as scriptable surfaces rather than internal features.
- **Interesting because:** `~/.config/kitty/open-actions.conf` is the closest existing thing to cc-candybar's click loop — a clicked OSC-8 hyperlink is matched by `protocol` / `mime` / `ext` / `url` regex / `fragment_matches` and dispatched to any kitty action including `launch`, with `${FILE_PATH}` and fragment captures substituted in, so the click never leaves the terminal to reach an OS URL handler. Beside it, `kitty @` drives a running instance over a UNIX socket with a JSON command protocol (`set-tab-title`, `send-text`, `get-text`), which is a daemon-with-verbs design directly comparable to cc-candybar's `cc-candybar://<verb>/<value>`.

## Kitty Desktop Notification Protocol (OSC 99)
- **URL:** https://sw.kovidgoyal.net/kitty/desktop-notifications/
- **Stats:** `unverified` — a protocol document inside the kovidgoyal/kitty repo (`docs/desktop-notifications.rst`); the repo itself is 34,850 stars / 19,212 commits
- **What it is:** A general escape-code protocol for raising desktop notifications from a program running in the terminal, with metadata as colon-separated `key=value` pairs, base64 or escape-safe payloads, icons, urgency, and multi-chunk transmission.
- **Interesting because:** With `a=report`, the terminal writes an escape code *back* to the program when the user activates the notification — and with `p=buttons` (button labels separated by U+2028) it reports `OSC 99 ; i=<id> ; <button_number> ST` naming which button was clicked. That is a full click-to-program input channel with no OS URL handler and no registered `.app` in the loop, which is the single largest fragility in cc-candybar's current design.

## WezTerm
- **URL:** https://github.com/wezterm/wezterm
- **Stats:** Rust · 28,845 stars · 8,703 commits · last push 2026-09-09
- **What it is:** A cross-platform GPU terminal whose entire configuration is a Lua program, not a settings file.
- **Interesting because:** The `open-uri` window event hands a clicked hyperlink's URI to user Lua, which can dispatch on a custom scheme (`file-line-column://`, `mailto:`) and call `window:perform_action` to spawn a pane or editor, returning `false` to suppress the default browser open — click routing as a first-class user extension point. Its config is also the reference example of the fifth axis: real functions, conditionals and closures rather than string placeholders, plus `hyperlink_rules` that turn plain regex-matched output into hyperlinks the terminal invented.

## iTerm2 proprietary escape codes (OSC 1337)
- **URL:** https://iterm2.com/documentation-escape-codes.html
- **Stats:** `unverified` — vendor documentation page; iTerm2 source is on GitLab at gitlab.com/gnachman/iterm2
- **What it is:** The reference catalogue of one terminal's private control-sequence surface: inline images, cell-size reporting, marks, colour setting, clipboard, and a variable dictionary.
- **Interesting because:** Three sequences together form a two-way program↔terminal bus that no other emulator matches — `OSC 1337 ; SetUserVar=<name>=<base64> ST` pushes values a shell computes into iTerm2's *status bar components* (a statusline fed by escape codes rather than by re-exec), `ReportVariable` reads one back, and `OSC 1337 ; Custom=id=<secret>:<pattern> ST` invokes a registered Python script with a shared secret so untrusted output cannot trigger it. The secret is the answer to the security question cc-candybar's URL handler raises.

## Alacritty (hints)
- **URL:** https://github.com/alacritty/alacritty
- **Stats:** Rust · 65,675 stars · 2,493 commits · last push 2026-08-31
- **What it is:** A minimal GPU terminal emulator with a deliberately small feature surface and a TOML config.
- **Interesting because:** The `[hints]` config turns arbitrary rendered text into an actionable region without the program emitting anything — each hint is `{ regex | hyperlinks = true, action | command, binding, mouse }`, so matched text becomes both mouse-clickable and keyboard-selectable via a hint-label overlay, and the action can pipe the capture to an external command. It is the inverse of OSC-8 (terminal-side pattern matching instead of program-side markup), and the keyboard-label overlay solves the "clicks need a mouse" problem cc-candybar's menus inherit.

## ripgrep (`--hyperlink-format`)
- **URL:** https://github.com/BurntSushi/ripgrep
- **Stats:** Rust · 68,164 stars · 2,287 commits · last push 2026-08-04
- **What it is:** A recursive line-oriented search tool, and one of the most carefully engineered CLI output pipelines in existence.
- **Interesting because:** `--hyperlink-format` is a small templating language for the *target* of every emitted OSC-8 link — `{path}`, `{line}`, `{column}`, `{host}`, `{wslprefix}` — with named aliases (`file`, `vscode`, `macvim`, `textmate`) so a user retargets every click in the output to a custom URL scheme with one flag. The accompanying `man` section documents exactly which placeholders are required per scheme and why percent-encoding differs, which is the spec cc-candybar's own URL construction lacks.

## fzf
- **URL:** https://github.com/junegunn/fzf
- **Stats:** Go · 82,896 stars · 3,740 commits · last push 2026-09-10
- **What it is:** A general-purpose fuzzy finder that runs either fullscreen or, with `--height`, inline below the prompt without touching the alternate screen.
- **Interesting because:** `--bind` is a genuine interaction DSL — an event name (`enter`, `focus`, `change`, `click-header`, `result`) bound to a chain of actions joined by `+`, where `execute()`, `reload()`, `transform()`, `become()` and `preview()` each take a shell command with `{}` placeholders, so behaviour is declared by name in config and never compiled in. That is the same "decouple the representation from the behaviour by name" seam cc-candybar's `actions:` block implements, done against a shell rather than an in-process runtime, plus a mouse/click event vocabulary worth copying verbatim.

## muesli/termenv
- **URL:** https://github.com/muesli/termenv
- **Stats:** Go · 2,024 stars · 228 commits · last push 2025-11-21
- **What it is:** The capability-detection and degradation layer under lipgloss and most of the Charm stack.
- **Interesting because:** It queries the terminal at runtime with OSC sequences for the actual foreground/background colours (so a palette can adapt to a light terminal without asking the user), classifies the terminal into a `Profile` ladder (`TrueColor` → `ANSI256` → `ANSI` → `Ascii`) and *converts* any colour down that ladder on write rather than branching at each call site — precisely the shape of cc-candybar's `globals.colorCompatibility`, including the part cc-candybar deliberately refuses (`"auto"`) because its renderer is a detached daemon. It also wraps OSC 8 hyperlinks, OSC 52 clipboard and notifications in the same capability-gated API.

## charmbracelet/lipgloss
- **URL:** https://github.com/charmbracelet/lipgloss
- **Stats:** Go · 11,809 stars · 679 commits · last push 2026-09-06
- **What it is:** A declarative style and layout library for terminal strings — borders, padding, alignment, joining — usable on any string, with no application framework required.
- **Interesting because:** Styles are a value algebra: `Copy()`/`Inherit()` compose, `JoinHorizontal`/`JoinVertical`/`Place` lay out already-styled blocks by measuring their real cell width, and `AdaptiveColor` / `CompleteColor` / `CompleteAdaptiveColor` let one declaration carry a distinct value per colour profile *and* per terminal background, resolved at render. That is a working answer to the same problem cc-candybar solves with palette transposition, arrived at from the opposite direction — enumerate the variants instead of computing them.

## Textualize/rich
- **URL:** https://github.com/Textualize/rich
- **Stats:** Python · 57,352 stars · 4,460 commits · last push 2026-06-23
- **What it is:** A rich-text library for terminal *output* — tables, markdown, syntax, progress — used overwhelmingly outside any fullscreen app.
- **Interesting because:** Its renderable protocol is the model worth studying: `__rich_console__` yields `Segment(text, style)` triples and `__rich_measure__` returns a `Measurement(minimum, maximum)` so the layout engine can size a widget *before* rendering it, which is how tables and columns fit without a second pass. `Console` detects colour system and hyperlink support, downgrades styles on write, and `Live` repaints a region in place by diffing against the previously emitted segment list rather than reprinting.

## vadimdemedes/ink
- **URL:** https://github.com/vadimdemedes/ink
- **Stats:** TypeScript · 39,848 stars · 803 commits · last push 2026-09-08
- **What it is:** A React renderer whose host is the terminal — a custom reconciler over the Yoga flexbox engine, used for CLI output, not fullscreen apps.
- **Interesting because:** Two mechanisms: full flexbox layout (Yoga, the same engine React Native uses) applied to terminal cells, and `<Static>` — a region whose already-printed output is permanently committed above the live frame and never re-rendered or re-measured again, which is how a long log stays O(1) per repaint. Ink also diffs the rendered frame string and skips the write entirely when identical, the cheapest version of the "don't pay full cost per tick" idea.

## python-prompt-toolkit
- **URL:** https://github.com/prompt-toolkit/python-prompt-toolkit
- **Stats:** Python · 10,565 stars · 2,822 commits · last push 2026-07-26
- **What it is:** The library behind IPython's prompt and ptpython — full-screen-capable, but its main mode draws a multi-line interactive UI *below the cursor* in the normal buffer.
- **Interesting because:** Its renderer keeps the previously drawn `Screen` and emits only the minimal cursor moves and writes needed to turn it into the new one, tracking its own position with CPR (cursor-position-report) queries so it can erase exactly what it drew without clearing the scrollback — the reference implementation of non-alt-screen incremental repaint. Its key bindings are filtered by composable `Condition` predicates (`&`/`|`/`~` over live state), a real conditional layer over interaction rather than a static keymap.

## ratatui-image
- **URL:** https://github.com/ratatui/ratatui-image
- **Stats:** Rust · 394 stars · 403 commits · last push 2026-09-06
- **What it is:** An image widget that renders through whichever graphics protocol the host terminal actually supports: Kitty, Sixel, iTerm2, or Unicode half-blocks.
- **Interesting because:** It contains the whole capability-detection ladder as reusable code — environment variables first, then a control-sequence query (Kitty graphics query, DA1 for Sixel) with a timeout, then a *font size in pixels* query (directly, or derived from window size ÷ rows/cols) so image pixels map onto cell areas, then a halfblock fallback that always works. It also separates a "protocol state" that holds the already-encoded payload from the per-frame draw, so a static image is encoded once and re-emitted, not re-encoded per repaint.

## notcurses
- **URL:** https://github.com/dankamongmen/notcurses
- **Stats:** C · 4,697 stars · 8,613 commits · last push 2026-05-18
- **What it is:** A character-graphics and TUI library positioned explicitly against ncurses, with an enormous commit history and unusually deep terminal-capability work.
- **Interesting because:** Its **direct mode** (`ncdirect`) is the whole library's styling, colour and bitmap machinery made available for ordinary non-fullscreen output that interleaves with `printf`, which is exactly the mode a statusline needs. Its blitter ladder degrades a bitmap through Kitty/Sixel → sextants → quadrants → half-blocks → ASCII based on measured terminal capability rather than a config flag, and it does per-cell colour quantisation against the detected palette.

## jquast/ucs-detect
- **URL:** https://github.com/jquast/ucs-detect
- **Stats:** Python · 70 stars · 198 commits · last push 2026-09-10 — small and single-author, included because the mechanism is unique
- **What it is:** A tool that determines a terminal emulator's *actual* Unicode version and width behaviour empirically, and publishes per-terminal reports (kitty, Ghostty, iTerm2, WezTerm, …).
- **Interesting because:** It does not read terminfo or trust a version string — it writes each candidate character, queries the cursor column back with a DSR/CPR report, and compares the observed advance to what the Unicode data tables predict, per Unicode release, for wide characters, emoji ZWJ sequences and variation selectors. That is a runnable answer to "does this terminal agree with my width function", which is the exact class of bug that misaligns a powerline statusline by one cell.

## rivo/uniseg
- **URL:** https://github.com/rivo/uniseg
- **Stats:** Go · 726 stars · 96 commits · last push 2024-05-31 — dormant, but it is the implementation the Go terminal ecosystem depends on
- **What it is:** Unicode text segmentation for Go: grapheme clusters, word and sentence boundaries, line breaking, and monospace string width.
- **Interesting because:** It implements UAX #29/#14 as explicit state machines and exposes them three ways — a `Graphemes` iterator, a zero-allocation `Step`/`StepString` function that returns the cluster, its width and the packed boundary state in one call, and a `StringWidth` built on top — so a renderer can measure and split in a single pass over the bytes. The `state int` parameter threaded between calls is the design that makes incremental measurement over an append-only buffer possible.

## theimpostor/osc
- **URL:** https://github.com/theimpostor/osc
- **Stats:** Go · 147 stars · 97 commits · last push 2025-05-04 — small, but it is the clearest worked example of multiplexer passthrough
- **What it is:** A CLI that copies to and pastes from the *local* clipboard using OSC 52, so it works over SSH, inside containers, and inside a multiplexer.
- **Interesting because:** It is a compact reference for the escape-sequence wrapping that every out-of-band protocol needs to survive tmux and screen — DCS passthrough (`ESC Ptmux; ESC …`) for tmux, the 768-byte chunked `ESC P … ESC \` split for screen, plus size-limit handling per terminal. cc-candybar's known OSC-8-inside-tmux breakage is the same problem, and this repo is the shortest description of the fix.

## Hyperlinks in Terminal Emulators (egmontkob's OSC 8 specification)
- **URL:** https://gist.github.com/egmontkob/eb114294efbcd5adb1944c9f3cb5feda
- **Stats:** `unverified` stars (gists expose no star count) · 30 revisions · last updated 2026-08-28 — the de-facto spec, a single gist, still being revised nine years on
- **What it is:** The document that defined `OSC 8 ; params ; URI ST`, written by the GNOME Terminal maintainer, and the reason every terminal implements the sequence the same way.
- **Interesting because:** It is the normative source for the details that bite in practice — the `id=` parameter that makes a wrapped or multi-line link highlight as one object, the length and character restrictions on the URI, the security reasoning for why `file://` URIs should carry a hostname, and explicit guidance that terminals must not auto-open arbitrary schemes. Anyone shipping a custom scheme through OSC 8 needs the "which schemes will a terminal actually hand to the OS" section.

## Alhadis/OSC8-Adoption
- **URL:** https://github.com/Alhadis/OSC8-Adoption
- **Stats:** Markdown · 186 stars · 177 commits · last push 2026-06-03
- **What it is:** A maintained tracking document of which terminal emulators, multiplexers, and *programs* support OSC 8 hyperlinks, with version numbers and links to the implementing commit or issue.
- **Interesting because:** It is the only place the emitter side is tracked alongside the consumer side — it lists which CLI tools emit OSC 8 (and how they gate it), which is both a ready-made candidate list for later stages and the evidence base for deciding what fraction of cc-candybar's users can actually click a link. The per-terminal rows record partial support (link shown but `id=` ignored, or ctrl-click required), which is the granularity a degradation policy needs.

## Semantic prompts / shell integration specification (OSC 133)
- **URL:** https://gitlab.freedesktop.org/Per_Bothner/specifications/-/blob/master/proposals/semantic-prompts.md
- **Stats:** `unverified` — a proposal document hosted on freedesktop GitLab, authored by Per Bothner (DomTerm); implemented by kitty, WezTerm, iTerm2, Ghostty, VS Code and others
- **What it is:** The cross-terminal specification for marking prompt start, command start, and output start/end with `OSC 133 ; A|B|C|D ST`, unifying FinalTerm's, iTerm2's and DomTerm's incompatible earlier schemes.
- **Interesting because:** It is the proof that a program can hand the terminal *structure*, not just pixels — once regions are marked, the terminal provides prompt jumping, one-click output selection, exit-status gutters and output folding that the program never implemented. VS Code's OSC 633 extension of it (adding `E` for the command line text and arbitrary key/value properties) is the live example of how such a protocol grows a private namespace, which is the design question behind cc-candybar's own `cc-candybar://` verb vocabulary.
