# Candidates — Desktop and window-manager status bars

Territory: Wayland/X11 bars, macOS menu-bar replacements and widget hosts, GNOME/KDE panel widget systems, and the "run a script, render its output" plugin family. Stats collected 2026-09-10 from `gh api repos/<owner>/<repo>` and the commit-count Link header (`repos/.../commits?per_page=1`); non-GitHub projects carry the figures their host shows, noted as such. Ordered most interesting first for cc-candybar's axes (performance, widgets, UX/interaction, unique features, real config language), not by popularity. One name from the brief, `ashish0kumar/stormbar`, does not exist under that name — searched GitHub's repo index, the author's profile and the web; that author's bar work is a YASB setup inside their `windots` dotfiles, so no later stage needs to go hunting for it again.

## SketchyBar
- **URL:** https://github.com/FelixKratz/SketchyBar
- **Stats:** C · 12,352 stars · 1,099 commits · last push 2026-06-04
- **What it is:** A macOS status-bar replacement that draws its own bar window and is configured entirely by shelling out to its own `sketchybar` CLI, which mutates a live item/property tree in the running daemon.
- **Interesting because:** It is fully event-driven rather than polled — an item `--subscribe`s to system events (`front_app_switched`, `space_change`, `wifi_change`, `power_source_change`) or to user-defined events created with `--add event <name>` and fired with `--trigger`, so a script runs only when something actually changed; on top of that it has `--animate <curve> <ticks>` property animations, `popup.*` dropdown items attached to any bar item, and `FelixKratz/SbarLua` (C, 339 stars, 38 commits, last push 2026-03-06) which replaces the fork-per-property CLI with an in-process Lua API.

## eww (ElKowar's Wacky Widgets)
- **URL:** https://github.com/elkowar/eww
- **Stats:** Rust · 12,665 stars · 718 commits · last push 2026-07-17
- **What it is:** A standalone GTK widget/bar system for X11 and Wayland, independent of any window manager, configured in its own Lisp-shaped language (`yuck`) plus SCSS.
- **Interesting because:** `yuck` is a genuine config language — `defwidget` takes parameters and composes other widgets, `defvar`/`defpoll`/`deflisten` declare a reactive variable graph (poll on an interval vs. tail a long-running process's stdout), and `${…}` "simplexpr" embeds real expressions with ternaries, arithmetic, JSON field access and built-ins including `jq`, `matches`, `replace`, `formattime`; widgets re-render from the dependency graph rather than on a global repaint tick.

## SFWBar
- **URL:** https://github.com/LBCrion/sfwbar
- **Stats:** C · 431 stars · 2,365 commits · last push 2026-09-10 (low stars, very high commit count and actively developed — weigh by the language, not the popularity)
- **What it is:** A GTK floating-window taskbar for Wayland layer-shell compositors that ships a full user-defined-widget control language, with presets that reproduce tint2, Waybar and a Windows-10-style panel from the same engine.
- **Interesting because:** It has the most complete config language in the territory — scanner variables that parse command/file output with RegEx/Json/Grab parsers and aggregators (`.val`, `.str`, `.pval`, `.age`, `.count`, `First`/`Last`/`Sum`/`Product`), expressions with arithmetic, comparison and `If(cond, a, b)`, user-defined `Function`s with `Var`, `While` and early return, and a trigger system binding `LeftClick`/`ScrollUp`/`Drag` (with Shift/Ctrl/Super modifiers), `SIGRTMIN+X` and custom `EmitTrigger` events to actions, over a `grid`/`popup`/`menu` layout of `label`/`button`/`scale`/`chart`/`taskbar` widgets.

## Waybar
- **URL:** https://github.com/Alexays/Waybar
- **Stats:** C++ · 11,940 stars · 5,315 commits · last push 2026-08-27
- **What it is:** The default customizable bar for wlroots compositors (Sway, Hyprland, river), with ~50 built-in modules and a JSON config plus a GTK CSS stylesheet.
- **Interesting because:** Its `custom/*` module protocol is a clean external-widget contract — a script prints JSON `{text, alt, tooltip, class, percentage}` and the `class` field selects CSS state rules while `alt` selects a `format-<alt>` template, so state, style and text stay separate; refresh is either an `interval`, a `signal` (SIGRTMIN+N sent by the script's own producer, so zero polling), or `"interval": "once"`, and `group` modules with `"drawer"` give hover-to-expand collapsed module stacks.

## SwiftBar
- **URL:** https://github.com/swiftbar/SwiftBar
- **Stats:** Swift · 4,507 stars · 607 commits · last push 2026-08-15
- **What it is:** A macOS menu-bar plugin host, protocol-compatible with xbar/BitBar but native Swift, where every plugin is an executable whose stdout becomes a menu-bar item and dropdown.
- **Interesting because:** Two mechanisms are directly transferable — a `swiftbar://` URL scheme whose endpoints (`refreshplugin`, `enableplugin`, `disableplugin`, `toggleplugin`, `notify`, `setephemeralplugin`) let any click or any external process drive the bar, exactly the shape of cc-candybar's `cc-candybar://` verbs; and `<swiftbar.type>streamable</swiftbar.type>` plugins, which run forever and push a new render whenever they emit a `~~~` separator, replacing the poll loop with a stream. Also adds `sfimage=`/`sfconfig=` SF Symbol rendering and per-line `shortcut=` global keyboard bindings.

## xbar (formerly BitBar)
- **URL:** https://github.com/matryer/xbar
- **Stats:** Go · 18,067 stars · 1,098 commits · last push 2024-09-10 (dormant, but the protocol is the thing and it outlived the app)
- **What it is:** The original "put any script's output in the macOS menu bar" host, with a browsable online plugin repository built into the app.
- **Interesting because:** The plugin protocol packs an entire widget spec into text — the refresh interval is in the *filename* (`date.1m.sh`), a bare `---` line splits bar text from dropdown, `--` prefixes nest submenus one level per pair, and each line carries `|`-delimited params (`color=`, `font=`, `size=`, `href=`, `shell=`+`param1..N=`, `terminal=`, `refresh=true`, `templateImage=` base64, `ansi=`, `alternate=true` for the Option-key variant, `length=` truncation with tooltip). Best idea of all: `<xbar.var>string(VAR_NAME="default"): Description</xbar.var>` / `number(…)` / `boolean(…)` / `select(…) [a, b, c]` metadata comments, from which the app **generates a settings UI** and feeds the values back as environment variables — a declarative settings-menu derivation with no UI code.

## py3status
- **URL:** https://github.com/ultrabug/py3status
- **Stats:** Python · 909 stars · 4,790 commits · last push 2026-08-16
- **What it is:** An i3status wrapper and extensible bar engine for i3/sway with a very large module library, where each module is a Python class whose methods return a block.
- **Interesting because:** Per-method `cached_until` is a first-class TTL on each individual block's output (with `self.py3.CACHE_FOREVER` for static ones), so the loop only recomputes the widgets whose cache expired — the same shape as cc-candybar's per-cache TTLs, but authored by the widget. Its format strings are a real mini-language: `{placeholder}`, `[…]` blocks that vanish when their placeholders are empty, `|` alternatives, and "composites" that let one module return several independently coloured parts; clicks route to `on_click` handlers, and `py3-cmd` drives a running bar from outside (refresh a module, send a click event).

## i3status-rust
- **URL:** https://github.com/greshake/i3status-rust
- **Stats:** Rust · 3,146 stars · 3,684 commits · last push 2026-09-07
- **What it is:** An async Rust replacement for i3status speaking the i3bar JSON protocol, with ~60 blocks and a TOML config.
- **Interesting because:** Its format strings are typed — `$icon $percentage.eng(w:3,u:B)` applies a formatter with width, unit and engineering-notation to the *value*, `$var|fallback` supplies a default, and `{ … }` wraps a section that disappears when its variable is missing, so threshold/unit presentation is data rather than a branch. Blocks declare `[[block.click]]` handlers with a `button` and an `action`, and the theme (colour ramp per state) and the icon set are two separate overridable files layered under the block config.

## polybar
- **URL:** https://github.com/polybar/polybar
- **Stats:** C++ · 15,340 stars · 2,329 commits · last push 2025-09-24 (maintenance mode; X11-only, still the largest X11 module catalogue)
- **What it is:** A fast X11 status bar with a large set of internal modules (i3/bspwm/xworkspaces, mpd, pulseaudio, network, xbacklight, …) plus `custom/script` and `custom/ipc`, configured in INI.
- **Interesting because:** Each module renders through composable format tokens — `format-<state>` strings assemble `<label>`, `<bar-…>` and `<ramp-…>` tags, and `ramp-0`/`ramp-1`/… map a numeric value onto a sequence of glyphs and colours, which is precisely cc-candybar's `ramp` idea expressed as INI keys. It also inherits lemonbar's inline `%{A1:cmd:}…%{A}` click areas (up to 5 buttons plus scroll), and `polybar-msg action` / `custom/ipc` hooks let an external process swap a module's content without a restart.

## ironbar
- **URL:** https://github.com/JakeStanger/ironbar
- **Stats:** Rust · 1,453 stars · 2,330 commits · last push 2026-09-07
- **What it is:** A GTK4 Wayland bar for Sway/Hyprland/niri, sitting deliberately between a fixed-module bar and a full custom shell, configurable in JSON, TOML, YAML, Corn or Ron.
- **Interesting because:** "Dynamic strings" put a variable store and a subprocess in the middle of any text field — `{{cat file}}` runs a script, `{{500:cmd}}` polls it on an interval, `{{!cmd}}` tails it, and `#name` interpolates an **ironvar**, a named global variable settable at runtime over its IPC socket; "dynamic booleans" reuse the same syntax for visibility, where a script's exit code is the truth value. That is a store-plus-template seam very close to cc-candybar's, plus per-module rich popups and a custom-module widget tree for hand-built layouts.

## lemonbar
- **URL:** https://github.com/LemonBoy/bar
- **Stats:** C · 1,688 stars · 252 commits · last push 2024-09-02 (dormant single-author project; included because its wire format is the ancestor of half this list)
- **What it is:** A ~2000-line X11 bar with no modules at all: it reads lines on stdin, renders them, and writes click commands to stdout.
- **Interesting because:** It invented the inline clickable-region markup that polybar, i3bar-adjacent tools and terminal bars all re-derive — `%{A:cmd:}text%{A}` pushes a click handler onto a stack around a text span (`%{A3:…:}` for button 3, nesting allowed), alongside `%{F#rrggbb}`/`%{B}`/`%{U}` colour, `%{l}%{c}%{r}` alignment and `%{O10}` pixel offsets; the whole interaction model is "stdin is the render, stdout is the event", which is exactly the OSC-8 span problem with different bytes.

## Quickshell
- **URL:** https://github.com/quickshell-mirror/quickshell
- **Stats:** C++ · 3,002 stars · 856 commits · last push 2026-08-29 (GitHub mirror; upstream is self-hosted git at quickshell.org)
- **What it is:** A toolkit for building bars, widgets, lock screens and full desktop shells in QML on Wayland and X11, rather than a bar with a config file.
- **Interesting because:** Config *is* the program — QML property bindings give automatic dependency-tracked re-render (the same invalidation model as cc-candybar's MobX store), and the whole shell hot-reloads the instant a file is saved, with live objects for `Process`, `FileView`, `SocketServer`, `SystemClock` and layer-shell windows; `qs ipc call` exposes named handlers in the running shell so external scripts can drive it.

## Übersicht
- **URL:** https://github.com/felixhageloh/uebersicht
- **Stats:** Objective-C · 4,989 stars · 537 commits · last push 2025-06-28
- **What it is:** A macOS desktop widget host that renders arbitrary HTML/CSS/JS into a transparent full-screen WebKit layer behind your windows; widgets are single `.jsx` files hot-reloaded on save.
- **Interesting because:** The widget contract is four exported values — `command` (shell string or a function receiving `dispatch`), `refreshFrequency` (number, or `false` for event-driven only), `updateState(event, prevState)` and `render({output})` — which is a tiny Elm-ish reducer per widget with its own refresh budget, plus `className` styles compiled by emotion; a widget can also skip polling entirely and push via `dispatch` from a long-running process.

## simple-bar
- **URL:** https://github.com/Jean-Tinland/simple-bar
- **Stats:** JavaScript · 1,616 stars · 1,288 commits · last push 2026-08-11
- **What it is:** A full status bar built as an Übersicht widget suite for yabai/AeroSpace users, with ~25 data widgets and per-display bars.
- **Interesting because:** It ships an in-bar graphical settings panel — a gear opens a form that writes the whole configuration (which widgets, their order, theme, per-widget options) back to disk and live-reloads, so the bar configures itself instead of sending you to a JSON file; it also drives refresh from yabai's event signals rather than intervals, and has a "flavors"/theme layer plus a notification/data-widget click model worth reading for a settings-menu design.

## bumblebee-status
- **URL:** https://github.com/tobi-wan-kenobi/bumblebee-status
- **Stats:** Python · 1,284 stars · 2,917 commits · last push 2026-03-21
- **What it is:** A modular status-line generator with 100+ modules, originally for i3bar but not tied to it.
- **Interesting because:** It separates the widget tree from the serializer — the same module output is rendered by pluggable *output engines* (i3, sway, lemonbar, dzen2), which is the "one render, N wire formats" split cc-candybar keeps between `renderDsl` and its joiners; on top of that, themes are JSON files that layer a colour scheme, a separator/powerline style and an **icon pack** independently, every module registers left/right/middle/scroll callbacks in Python, and `bumblebee-ctl` sends synthetic events into a running bar.

## Astal / AGS
- **URL:** https://github.com/Aylur/astal (AGS scaffolding CLI: https://github.com/Aylur/ags)
- **Stats:** Astal: Vala · 981 stars · 972 commits · last push 2026-09-09 · AGS: TypeScript · 3,092 stars · 757 commits · last push 2026-04-08
- **What it is:** Astal is a set of GObject libraries (battery, network, mpris, tray, notifd, hyprland, wireplumber, layer-shell) for building desktop shells; AGS is the CLI that scaffolds and bundles a TypeScript/JSX shell against them on GJS.
- **Interesting because:** It is the plugin *substrate* under most modern Wayland bars (HyprPanel, 2,192 stars / 630 commits / last push 2026-04-23, is built on it) — each data source is a GObject with notifiable properties, and `bind(obj, "prop")` produces a reactive subscription consumed directly as a JSX attribute, with Vala, TypeScript, Python and Lua bindings generated from one GIR; the lesson is a typed data-provider registry that any front end can bind, rather than a bar with modules welded in.

## yambar
- **URL:** https://codeberg.org/dnkl/yambar
- **Stats:** C · 295 stars · 1,628 commits · last activity May 2025 (Codeberg figures; the author has announced it is no longer developed and will be archived — mechanism still worth mining)
- **What it is:** A modular X11 and Wayland panel configured in YAML, explicitly built around CPU and battery efficiency.
- **Interesting because:** Its stated rule is "polling is only done when absolutely necessary" — modules block on inotify/udev/D-Bus/compositor events instead of a tick — and its data model is a clean three-layer split: **modules** expose *tags* (typed values: int, float, bool, string, range), **particles** decide how a tag is drawn, and **decorations** (background, underline, stack) style them. The `map` particle switches on a tag's value like a case expression, `ramp` selects a particle from a list by a range tag's position, and `progress-bar`/`string`/`list` compose recursively — conditional rendering expressed entirely as data.

## xmobar
- **URL:** https://codeberg.org/xmobar/xmobar
- **Stats:** Haskell · 98 stars · 1,986 commits · last commit 2026-07-21 (Codeberg figures after the move off GitHub; stars there understate a ~20-year-old project)
- **What it is:** A minimalist *text*-based status bar for X11, originally for xmonad, driven by a single template string interleaving plugin outputs.
- **Interesting because:** Of everything here it is closest to cc-candybar's medium — the whole bar is `template = "%cpu% | %memory% }{ %date%"` with inline markup for everything else: `<fc=#ff0000,#000000:0>` foreground/background with alpha, `<box type=Bottom width=2 color=…>` cell decoration, `<icon=path/>`, and `` <action=`command` button=1>text</action> `` clickable regions that nest. Extension is a Haskell typeclass (`Exec`/`Runnable`) with `alias`/`start`/`rate`, so a plugin is a value in the config file and you can compile your own bar by importing xmobar as a library.

## Zebar
- **URL:** https://github.com/glzr-io/zebar
- **Stats:** Rust · 3,054 stars · 504 commits · last push 2026-03-31
- **What it is:** A cross-platform (Windows, macOS, Linux) widget and bar host where each widget is an HTML/CSS/JS document rendered in a Tauri webview window, from the GlazeWM authors.
- **Interesting because:** Data comes from named **providers** (`cpu`, `memory`, `battery`, `network`, `weather`, `media`, `glazewm`, `komorebi`, `date`, `host`, `disk`, `audio`, `keyboard`) declared per widget with their own `refreshInterval`, delivered to the page as a reactive object — a provider registry with per-source refresh budgets that any markup can bind, rather than modules the bar owns; widget placement (monitor, anchor, z-order, transparency) is itself config, and `zebar start`/`zebar-cli` manage widget "presets" as first-class named layouts.

## Argos
- **URL:** https://github.com/p-e-w/argos
- **Stats:** JavaScript · 1,796 stars · 113 commits · last push 2026-05-04 (small commit count; included for the protocol port)
- **What it is:** A GNOME Shell extension that turns any executable dropped in `~/.config/argos` into a top-panel button with a dropdown menu, deliberately BitBar/xbar-compatible.
- **Interesting because:** It pushes the filename-as-config idea further than xbar did — `plugin.10s.sh` sets the interval, `plugin.1c.sh` positions the button one slot right of the clock, `plugin.l.1m.sh` puts it left of Activities, so placement and cadence are both encoded in the name with no config file at all; it also renders ANSI escape sequences from plugin output as real panel styling, and supports `refresh=true` lines that re-run the plugin from a menu click.

## Stats (exelban)
- **URL:** https://github.com/exelban/stats
- **Stats:** Swift · 41,705 stars · 2,445 commits · last push 2026-09-10
- **What it is:** A macOS menu-bar system monitor covering CPU, GPU, RAM, disk, network, battery, fans, sensors, Bluetooth and clock, each module independently enabled and configured.
- **Interesting because:** It separates a module's *data* from the widget *shape* that draws it — `Kit/Widgets/` holds Mini, Label, Text, LineChart, BarChart, PieChart, NetworkChart, Speed, Tachometer, Dot, Battery, Memory and Stack as reusable renderers, and a user picks several at once per module, so the same metric appears as a mini readout plus a line chart plus a pie without the module knowing; clicking any of them opens a popover with detail charts and a per-process breakdown, and update intervals are per module (the README even names Sensors and Bluetooth as the expensive ones and recommends disabling them, i.e. cost is attributed per data source).

## YASB Reborn
- **URL:** https://github.com/amnweb/yasb
- **Stats:** Python · 5,461 stars · 2,229 commits · last push 2026-09-08
- **What it is:** A highly configurable status bar for Windows (with Komorebi and GlazeWM integration), configured in YAML plus a CSS stylesheet, shipping 50+ widgets.
- **Interesting because:** Every widget's options are a pydantic model under `src/core/validation/widgets/`, exported by `export_schema.py` into a checked-in `schema.json` that a CI workflow keeps current — so config validation, editor autocomplete and the docs all derive from one declaration, with a `deprecation.py` pass for renamed keys. The interaction model is two fields plus named callbacks: `label` and `label_alt` are Python format strings over the widget's data (`"{info[percent][total]}% | freq: {info[freq][current]:.2f} Mhz"`), and `callbacks: {on_left: toggle_label, on_right: do_nothing, on_middle: exec …}` binds mouse buttons to *named* actions rather than inline shell — the same name-as-seam decoupling cc-candybar uses, with `toggle_label` as the built-in that swaps the two label templates.

## Taffybar
- **URL:** https://github.com/taffybar/taffybar
- **Stats:** Haskell · 711 stars · 2,436 commits · last push 2026-09-09
- **What it is:** A GTK3 desktop bar in the xmonad tradition — the config *is* a `taffybar.hs` program compiled against the library, with self-recompilation, running on X11/EWMH or Wayland via `gtk-layer-shell`.
- **Interesting because:** All widgets run in `type TaffyIO v = ReaderT Context IO v` over one shared `Context` that owns the X11 connection and a `listeners :: MVar SubscriptionList`, so a widget calls `subscribeToPropertyEvents [ewmhActiveWindow, ewmhCurrentDesktop]` (or `subscribeToAll`) and `unsubscribe` instead of opening its own connection — one event stream fanned out to N widgets, the shape cc-candybar's git-cache subscriptions take. Underneath, `Widget/Generic/` is a small set of *shapes* every concrete widget is built from — `PollingLabel`, `PollingBar`, `PollingGraph`, `ChannelWidget`, `ChannelGraph`, `DynamicMenu`, `AutoSizeImage` — which is the polled-vs-pushed distinction made into types.

## HyprPanel
- **URL:** https://github.com/Jas-SinghFSU/HyprPanel
- **Stats:** TypeScript · 2,192 stars · 630 commits · last push 2026-04-23
- **What it is:** An opinionated, batteries-included Hyprland bar and shell built on AGS/Astal, with dropdown menus for audio, Bluetooth, network, notifications, calendar and media, plus dashboard tiles.
- **Interesting because:** It ships a **graphical settings dialog** for a programmable shell — every option is edited in a GUI that writes `~/.config/hyprpanel/config.json` and hot-applies it, and the same options are scriptable through `hyprpanel setOption <path> <value>` / `toggleWindow <name>` / `getOption`, so the GUI and the CLI are two front ends over one keyed option store; theming goes further with wallpaper-derived Matugen colour generation and dozens of importable theme presets, i.e. palette as a shareable artifact rather than a config block.

## nwg-panel
- **URL:** https://github.com/nwg-piotr/nwg-panel
- **Stats:** Python · 784 stars · 1,693 commits · last push 2026-08-24
- **What it is:** A GTK3 panel for sway and Hyprland, part of the nwg-shell suite, with taskbar, pager, tray, controls, scratchpad, menu-start and per-output panel instances.
- **Interesting because:** It is the one bar here whose primary configuration surface is a **GUI editor** — `nwg-panel-config` is a shipped application that edits every panel, module and style field and restarts the panel live, so discovery does not require reading a schema. Its `executor` module is the script-into-bar pattern with a twist: the script's output lines become an icon plus multiple label lines on an interval, with `on-left-click` / `on-middle-click` / `on-right-click` / `on-scroll-up` / `on-scroll-down` commands per module; its `controls` module is a click-to-open dropdown panel of brightness/volume sliders plus user-defined rows, which is a popup panel model rather than a menu.

## i3blocks
- **URL:** https://github.com/vivien/i3blocks
- **Stats:** C · 2,472 stars · 364 commits · last push 2023-11-22 (dormant, but the block protocol is still what a lot of scripts target)
- **What it is:** A minimal scheduler that runs a list of commands defined in an INI file and feeds their output to i3bar (or lemonbar/dzen2) as blocks.
- **Interesting because:** The click contract is environment variables rather than stdin — a clicked block's script is re-run with `BLOCK_BUTTON`, `BLOCK_X`, `BLOCK_Y`, `BLOCK_NAME` and `BLOCK_INSTANCE` set, so the *pixel coordinates* of the click reach the script and a block can implement its own hit regions (a volume bar that sets level by where you clicked). Its `interval` key is a small vocabulary rather than a number — `N` seconds, `once`, `repeat`, `persist` (a long-running process whose every emitted line is a new render) — plus `signal=N` for SIGRTMIN+N push refresh, which is exactly the poll/stream/push taxonomy worth copying.
