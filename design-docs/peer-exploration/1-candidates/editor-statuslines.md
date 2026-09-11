# Candidates — Editor statuslines (Vim/Neovim, Emacs, Helix, VS Code)

Stage-one candidate list. Star/commit/push numbers come from `gh api repos/<owner>/<repo>` and the `rel="last"` page number of `repos/<owner>/<repo>/commits?per_page=1`, read 2026-09-10; anything not obtainable that way is marked `unverified`. Ordered most interesting first for cc-candybar's four axes (performance, widgets, UX, unique features) plus the fifth (does it have a real config language, or only string placeholders).

## heirline.nvim
- **URL:** https://github.com/rebelot/heirline.nvim
- **Stats:** Lua · 1,291 stars · 387 commits · last push 2025-05-23
- **What it is:** A Neovim statusline/winbar *API* rather than a statusline — it ships no default bar, only the component algebra you build one out of. The closest structural sibling to cc-candybar's layout tree in this territory.
- **Interesting because:** A component is a plain table with `provider` / `condition` / `hl` / `init` / `update` / `on_click` and a `{...}` child list, and colour resolves by **recursive inheritance** down the tree — a parent's `hl` becomes the child's default, so `surround()` can recolour a whole subtree at once, exactly the problem cc-candybar's decor/band walk solves. Its `flexible = <priority>` components declare an ordered list of fallback renderings and heirline drops to the next one when the window narrows, so truncation priority is declared per component rather than computed centrally; `update = { "BufEnter", ... }` (or a predicate function) is the per-component invalidation gate that keeps it off the every-keystroke path.

## witch-line
- **URL:** https://github.com/sontungexpt/witch-line
- **Stats:** Lua · 66 stars · 386 commits · last push 2026-07-15 — low stars, one author, but the most unusual evaluation model in the territory
- **What it is:** A Neovim statusline built as a **flat component registry addressed by id**, explicitly rejecting heirline's nesting: components reference each other by `ref` and `inherit` instead of being children of each other.
- **Interesting because:** `ref` inherits *named fields* (`events`, `style`, `static`, `context`, `hidden`, `min_screen_width`) from another component by id while `inherit` takes the whole thing — a dependency graph rather than a tree, so one component's state can feed several without walk order deciding it. It caches the *compiled component functions* to disk keyed by an **xxh32 checksum of the user config** (`cache.enabled`, `cache.func_strip` strips debug info), and each component carries `events`, `lazy`, `timing`, `pre_update`/`post_update` — i.e. per-component refresh policy as data.

## Powerline
- **URL:** https://github.com/powerline/powerline
- **Stats:** Python · 14,813 stars · 2,867 commits · last push 2026-03-11
- **What it is:** The original cross-application statusline engine — one Python core rendering bars for vim, zsh/bash, tmux, IPython, Awesome and Qtile through per-application renderers.
- **Interesting because:** It is the two-process model cc-candybar independently arrived at: `powerline-daemon` holds one warm Python interpreter and a tiny C client (`powerline-render`) talks to it over a socket, precisely because per-prompt process startup was the whole cost. Its truncation is a declared integer **`priority`** per segment (lower = kept longer, `null` = never dropped) with `"width": "auto"` filler segments absorbing slack, and its JSON config separates *themes* (which segments, in what order) from *colorschemes* (what colour each segment's named highlight group is) — the same split cc-candybar makes between layout and palette. Segments subclass `ThreadedSegment` with `startup`/`shutdown`/`update`/`interval`, so a slow segment runs on its own clock instead of blocking the render.

## nougat.nvim
- **URL:** https://github.com/MunifTanjim/nougat.nvim
- **Stats:** Lua · 200 stars · 288 commits · last push 2026-08-16
- **What it is:** A "hyperextensible" Neovim statusline/tabline/winbar library with an explicit `NougatBar` / `NougatItem` object model and a `nougat.nut.*` standard library of prebuilt items.
- **Interesting because:** It ships **responsive breakpoints** — an item's content and highlight can be declared per width band, so narrowing is a lookup rather than a truncation pass — and a first-class `nougat.cache` module where an item declares which events invalidate its cached value, plus `nougat.store` for cross-item shared state. The bar itself is chosen per render by a `nougat_bar_selector(ctx)` function reading `ctx.is_focused`, which is the "one renderer, many bar shapes" seam cc-candybar spells as presets.

## dropbar.nvim
- **URL:** https://github.com/Bekaboo/dropbar.nvim
- **Stats:** Lua · 1,596 stars · 598 commits · last push 2026-05-31
- **What it is:** A Neovim winbar of IDE-style breadcrumbs where every crumb is clickable and opens a real interactive dropdown menu — the most developed click-and-disclosure UX in this territory.
- **Interesting because:** `dropbar_symbol_t:on_click()` opens a `dropbar_menu_t` populated from the symbol's `siblings`, and those expensive `siblings`/`children` fields are **metatable `__index` handlers** so the sub-menu's contents are never computed until someone actually opens it — lazy disclosure at the field level, which is exactly the cost model cc-candybar's dropped menu bodies want. Updates are debounced at `opts.bar.update_debounce` (32 ms) and split into three event classes (`update_events.win` / `.buf` / `.global`); a `sources` interface is one `get_symbols()` function with `utils.source.fallback()` chaining LSP → treesitter → path; the menu supports hover highlighting, fuzzy-find (`menu:fuzzy_find_open()`), keyboard operation, and can replace `vim.ui.select`.

## feline.nvim
- **URL:** https://github.com/famiu/feline.nvim
- **Stats:** Lua · 1,049 stars · 364 commits · last push 2023-09-20 · **archived** — dead, but its truncation model is the best-specified in the territory
- **What it is:** A Neovim statusline where each component is a table of `provider` / `hl` / `enabled` / `icon` / `left_sep` / `right_sep`, grouped into left/mid/right sections with separate active and inactive variants.
- **Interesting because:** Its "smart truncation" is three declared knobs rather than an algorithm: **`short_provider`** is an entirely independent alternate provider (or the same provider with different `opts`) that renders when the bar doesn't fit, **`truncate_hide`** allows a component to be dropped outright, and **`priority`** (integer, negative allowed, default 0) sets the ascending order in which components give up space. It also exposes `require('feline').is_component_truncated(winid, name)` / `is_component_hidden(...)`, so a component can *read back* whether the layout engine shortened it — a feedback edge almost nothing else here has.

## doom-modeline
- **URL:** https://github.com/seagle0128/doom-modeline
- **Stats:** Emacs Lisp · 1,526 stars · 1,965 commits · last push 2026-09-02
- **What it is:** The most-developed Emacs mode-line package — a fancy, icon-heavy mode line with roughly forty segments (vcs, lsp, checker, debug, workspace, grip, irc, battery, word count, minor modes, …) assembled into named modelines.
- **Interesting because:** `doom-modeline-def-segment` is a macro that **compiles a segment body into a byte-compiled function once**, and `doom-modeline-def-modeline` compiles a whole named bar (a list of left segments and right segments) into a single constructed form — so the per-redisplay cost is calling compiled code, not re-interpreting a format spec, which matters because Emacs re-evaluates the mode line on every redisplay. Segments carry separate **active and inactive** renderings (`doom-modeline-set-modeline`, per-buffer caching of the expensive `buffer-info`), and the package documents which segments are expensive enough to be opt-in (`doom-modeline-enable-word-count`, `doom-modeline-continuous-word-count-modes`) — an explicit cost budget exposed as config.

## lualine.nvim
- **URL:** https://github.com/nvim-lualine/lualine.nvim
- **Stats:** Lua · 8,123 stars · 774 commits · last push 2026-05-31
- **What it is:** The default-choice Neovim statusline: six named sections (`lualine_a` … `lualine_z`) across left and right halves, a large built-in component set, and the same section model reused for winbar and tabline.
- **Interesting because:** Every component takes the same option vocabulary — `cond` (a predicate gating the component), `fmt` (a post-render string transform), `color` (a highlight group, an RGB table, *or* a function of current state), `separator`, and **`on_click(clicks, button, modifiers)`** wired to Neovim's `%@` statusline click item — so click, condition and colour are per-component data rather than code. Its refresh model is two-layered: `refresh.refresh_time` (~16 ms, a 60 fps processing tick), `refresh.statusline/tabline/winbar` (a 1000 ms floor between full refreshes), and `refresh.events` (`WinEnter`, `ModeChanged`, `CursorMoved`, …) that force one early; `extensions` swap the whole section set per filetype.

## express_line.nvim
- **URL:** https://github.com/tjdevries/express_line.nvim
- **Stats:** Lua · 317 stars · 55 commits · last push 2024-05-17 — small and quiet, included for the async model
- **What it is:** An experimental Neovim statusline by TJ DeVries where the bar is produced by a `generator` function returning a list of items, each of which may be a literal, a function, a `(window, buffer)` function — or a **coroutine**.
- **Interesting because:** Coroutine items can `coroutine.yield()` mid-render and be resumed when a libuv job finishes (`co_wait` over luvjob), so a git-status segment does real async I/O without the statusline ever blocking — the only project here that makes asynchrony a property of the *component type* rather than a background timer. `subscribe.buf_autocmd()` wraps a function so it recomputes only on named autocmds, and `helper.async_buf_setter()` parks slowly-changing values in buffer/window variables that the render just reads.

## statuscol.nvim
- **URL:** https://github.com/luukvbaal/statuscol.nvim
- **Stats:** Lua · 613 stars · 163 commits · last push 2026-07-09
- **What it is:** A configurable Neovim *status column* (the gutter: number, fold, signs) built from a declared list of segments — the same bar problem turned ninety degrees, and the richest click-dispatch model in the territory.
- **Interesting because:** A segment is `{ text = {...}, condition = {...}, click = "handler", hl = ..., sign = { name = {patterns}, namespace = {...}, maxwidth, colwidth, auto, wrap, fillchar, align } }`, where `text` and `condition` are *parallel tables* of strings-or-functions and booleans-or-functions — gating is data at the element level, not a branch. Its click handlers receive `{ minwid, clicks, button, mods, mousepos }` and dispatch on a **three-way match of sign-name pattern × mouse button (`l`/`m`/`r`) × modifier string**, with a shipped handler set (`Lnum`, `FoldClose`/`FoldOpen`/`FoldOther`, diagnostics, gitsigns hunk preview/stage/reset) that a user disables individually by setting one to `false`.

## telephone-line
- **URL:** https://github.com/dbordak/telephone-line
- **Stats:** Emacs Lisp · 590 stars · 214 commits · last push 2024-03-29
- **What it is:** A from-scratch Powerline reimplementation for Emacs with left/right segment lists, evil-state awareness, and a deliberately small configuration language for writing your own themes.
- **Interesting because:** Its separators are **procedurally generated images, not glyphs** — `abs`, `cubed`, `sin`, `halfsin`, `cos`, `halfcos`, `tan`, `gradient` and `flat` are drawn per separator instance as antialiased XPM bitmaps whose two colours are read from the faces of the segments on either side, so shape and colour are computed from the boundary rather than picked from a font. Segments are declared with the `telephone-line-defsegment` macro (with an explicitly non-async `telephone-line-defsegment*` variant for cheap ones), and separator faces are derived automatically, which is the same "the joiner's colour is a function of its two neighbours" problem cc-candybar's `Joiner` has.

## vim-airline
- **URL:** https://github.com/vim-airline/vim-airline
- **Stats:** Vim Script · 17,965 stars · 2,810 commits · last push 2026-09-09
- **What it is:** The long-running Vim/Neovim statusline with the largest third-party extension ecosystem — roughly forty bundled integrations (fugitive, ale, coc, tagbar, tabline, whitespace, …) over a fixed A–F section layout.
- **Interesting because:** **Extensions auto-load only if the plugin they integrate with is actually installed** (runtimepath detection, overridable with `g:airline_extensions` for an explicit opt-in list and `g:airline#extensions#disable_rtp_load` to skip the scan) — a discovery-driven widget catalogue rather than a config the user must enumerate. Truncation is declared as a dictionary of **per-section width thresholds**, `g:airline#extensions#default#section_truncate_width` (e.g. `{'b': 79, 'x': 60, 'y': 88, 'z': 45}`), so each section states the window width below which it disappears; parts are registered by name via `airline#parts#define` and assembled by `airline#section#create`, and "accents" recolour individual parts within a section's background.

## mode-line-idle
- **URL:** https://github.com/emacsmirror/mode-line-idle (GitHub mirror; upstream is on Codeberg at ideasman42/emacs-mode-line-idle, also on MELPA)
- **Stats:** Emacs Lisp · 0 stars on the mirror · 48 commits · last push 2026-08-14 · upstream star/commit counts `unverified` — tiny, but the perf idea is the point
- **What it is:** A single-function Emacs library that defers evaluation of any mode-line fragment until Emacs is idle, with no minor mode and no global configuration.
- **Interesting because:** `(mode-line-idle DELAY CONTENT DEFAULT-TEXT &rest KEYWORDS)` wraps an arbitrary mode-line subtree in a **per-fragment idle delay with a placeholder** — an expensive word-count segment declares `3.0` seconds and shows `"?"` until then, a clock declares `1.0` — so staleness is a knob each widget sets for itself rather than one global refresh rate. `:interrupt t` aborts an in-flight evaluation on keypress (via `with-no-input`) so a slow segment can never wedge the editor, and `:literal t` handles `%` escaping at the seam; the whole thing composes into an existing `mode-line-format` with no framework buy-in.

## windline.nvim
- **URL:** https://github.com/windwp/windline.nvim
- **Stats:** Lua · 532 stars · 224 commits · last push 2025-10-22
- **What it is:** A Neovim statusline whose distinguishing feature is a built-in **animation engine** — the bar's colours move over time (rainbow sweeps, blends, breathing effects) rather than being static per state.
- **Interesting because:** `animation.animation({ data, timeout, delay, interval })` drives timed colour transitions and effects are composable HSL functions — `effects.rainbow()`, `effects.blackwhite()`, `effects.list_color()`, or a custom `function(color) return HSL.new(color.H + 1, color.S, color.L) end` — i.e. **colour math as first-class user-authored data**, the closest thing in this territory to cc-candybar's OKLCH algebra. Components are `{text, {fgcolor, bgcolor}}` pairs where `text` is a function of `(bufnr, winid, width)` (so width-awareness is a plain argument) and may return a nested child group; palette entries come from the live colorscheme via `require('windline.themes').get_hl_color()` and re-resolve on `ColorScheme`.

## lightline.vim
- **URL:** https://github.com/itchyny/lightline.vim
- **Stats:** Vim Script · 6,870 stars · 694 commits · last push 2026-07-01
- **What it is:** A deliberately dependency-free Vim statusline — no bundled integrations, no autoload of other plugins; you register components and lightline handles layout, highlight-group generation and mode colouring.
- **Interesting because:** It has three *kinds* of component and the distinction is load-bearing: `component` (a literal statusline string), `component_function` (a function returning one string, re-called every redraw), and **`component_expand`** (a function returning a *nested list of lists* that expands into multiple independently-highlighted cells — how the tabline and syntax-error counts are built), with `component_type` assigning each expanded group a highlight role (`error`, `warning`, `raw`, `tabsel`) and `component_raw` opting a component out of escaping. `component_visible_condition` is a Vim expression string evaluated to decide whether a component's separator should even be drawn, and `lightline#link()` re-points the generated highlight groups on mode change so the whole bar recolours without regenerating the string — an early answer to "recolour everything without re-rendering".

## mini.statusline (part of mini.nvim)
- **URL:** https://github.com/nvim-mini/mini.statusline
- **Stats:** Lua · 104 stars · 69 commits · last push 2026-07-07 (split-out read-only mirror of the module) · parent `nvim-mini/mini.nvim`: Lua · 9,506 stars · 2,221 commits · last push 2026-09-10
- **What it is:** The statusline module of the mini.nvim library — a minimal, fast bar whose whole public surface is two content functions (`content.active`, `content.inactive`) that you can replace wholesale.
- **Interesting because:** Width handling is a single shared predicate, **`MiniStatusline.is_truncated(trunc_width)`**, and *every* section function takes a `trunc_width` argument and decides for itself what to show below it — so "what gives up space first" is distributed to the widgets and needs no priority list, no layout pass, and no engine. `MiniStatusline.combine_groups()` takes a list of `{hl = ..., strings = {...}}` groups and drops empty ones while collapsing their separators, which is a much smaller answer to the same problem cc-candybar's `FlexStrip`/`Joiner` solves.

## vim-flagship
- **URL:** https://github.com/tpope/vim-flagship
- **Stats:** Vim Script · 230 stars · 37 commits · last push 2025-05-10 — 37 commits total, but a genuinely different idea about who owns the bar
- **What it is:** Tim Pope's statusline/tabline plugin whose premise is that the statusline should be a **protocol other plugins cooperate over**, not a monolith one plugin owns.
- **Interesting because:** It defines a `User Flags` autocommand that any plugin hooks to call `Hoist("buffer"|"window"|"global", [priority,] expression)` — so third-party plugins *contribute* flags into a shared bar with a declared scope and priority, and flagship arbitrates ordering and drops what doesn't fit, instead of each plugin string-concatenating into `&statusline` and fighting. Flags are Vim expressions or funcrefs evaluated in the right buffer/window context, and the per-scope split means a buffer flag naturally disappears when you switch buffers with no invalidation bookkeeping.

## VS Code — Commands (usernamehw/vscode-commands)
- **URL:** https://github.com/usernamehw/vscode-commands
- **Stats:** TypeScript · 100 stars · 455 commits · last push 2026-03-06
- **What it is:** A VS Code extension that turns `settings.json` into a declarative status-bar and command-palette authoring surface — you write JSON, it materialises `StatusBarItem`s bound to commands, with no extension code.
- **Interesting because:** A command object's `statusBar` key takes `text`, `tooltip`/`markdownTooltip`, `priority`, `alignment`, `color`, `backgroundColor` (limited by VS Code itself to `error`/`warning`), `name` and `hidden`, plus **visibility conditions** (`activeEditorGlob`, `activeEditorLanguage`) and — the interesting part — **`updateEvents`**, a per-item list of refresh triggers drawn from `onDidConfigurationChange` / `onDidChangeActiveTextEditor` / `onDidChangeTextEditorSelection` / `interval`. That is per-widget event subscription declared in user config, in a host (VS Code) whose own status-bar API has no `when`-clause support (microsoft/vscode issue #145468) and orders items only by a signed integer priority.

## minions
- **URL:** https://github.com/tarsius/minions
- **Stats:** Emacs Lisp · 322 stars · 103 commits · last push 2026-06-01
- **What it is:** An Emacs package that replaces the mode line's sprawling list of enabled minor-mode lighters with a single clickable glyph that opens a nested menu.
- **Interesting because:** It is progressive disclosure applied to a status bar as the *whole* feature — the menu is built from `minor-mode-list` rather than from what is currently displayed, so it lists **modes that are not enabled and can be turned on**, plus each mode's own mode-specific submenu and its documentation, making the bar an input surface rather than a readout. That "the collapsed control does more than the expanded list it replaced" framing is directly the question cc-candybar's disclosure bands and settings menu answer; upstream Emacs 31 later shipped a weaker built-in version (enabled-only, lighter-only) that the README explicitly contrasts itself against.

## Helix (built-in statusline)
- **URL:** https://github.com/helix-editor/helix
- **Stats:** Rust · 46,172 stars · 7,689 commits · last push 2026-09-08
- **What it is:** A modal editor with no plugin system yet, whose statusline is configured entirely from `config.toml` — included here as the strongest data point for what a statusline looks like with *no* config language at all.
- **Interesting because:** `[editor.statusline]` is three ordered lists of **element names** — `left`, `center`, `right` — drawn from a closed vocabulary (`mode`, `spinner`, `file-name`, `file-base-name`, `file-modification-indicator`, `read-only-indicator`, `version-control`, `diagnostics`, `workspace-diagnostics`, `selections`, `primary-selection-length`, `position`, `position-percentage`, `total-line-numbers`, `file-encoding`, `file-line-ending`, `file-type`, `register`, `spacer`), plus a `separator` string and `mode.normal`/`mode.insert`/`mode.select` labels. There are no conditionals, no functions, no user-defined elements and no colour expressions — every extension request becomes a Rust PR adding an enum variant (see issue #5868, discussion #12924), which is precisely the ceiling cc-candybar's template engine exists to avoid, and the `spacer` element is the whole layout algebra.
