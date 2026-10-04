# UI elements

Every element the bar can draw today: how it looks in each state, what each click does, where it is used, and how it is authored. It is meant to be read beside the pickers proposal (`design-docs/PROPOSAL-ui-pickers.md`, PR #287), so a new picker can reuse what exists instead of rebuilding it. Gaps and overlaps found while writing it are listed at the end, for Brandon to decide. Nothing here changes an element.

Every drawing is a live render from `pnpm bar` (`scripts/drive-bar.ts`). The script drives an isolated real daemon through the same clicks a user makes, with the bundled default config. The drawings are plain text, so colour is described in words. Each drawing was taken at 80 and 200 columns; where the two differ, both are shown. To reproduce one, pass the clicks that reach it:

```
pnpm bar --ssh --width 80 🍫 "🎨 look" "▸#2"    # open the menu, the look tab, then the theme ring
pnpm bar --links 🍫                             # …and list what every link on the last render does
```

`--ssh` makes the host segment show. The drawings were taken on 2026-10-03, from this branch on top of `main` at `dff9dbb`, which is why the git cell reads `docs/ui-elements-inventory`.

## At a glance

| Element | What it is for | Where it is used | Authored as |
|---|---|---|---|
| [Action region](#action-region) | One clickable span that does one thing | Everywhere | `{{ action "name" … }}` |
| [Toggle](#toggle) | Flip a value between two or more states | Settings, edit mode, git detail | `{ set, cycle }` action |
| [Stepper](#stepper) | Nudge a number up or down | Padding, configure-mode thresholds | `{ set, min, max, by }` action |
| [Disclosure](#disclosure-and-the--close) | Show or hide a body under (or above) a trigger | Menu door, tabs, rings, groups, help | `disclosureNode`, group sugar |
| [Group](#group) | A collapsible chunk of layout | Author configs | `{ kind: "group" }` in `root` |
| [Menu](#menu) | A trigger that drops a picker below the row | Edit mode's `✚` | `{{ menu "apply" "▸" "▾" }}` |
| [Picker grid](#picker-grid) | Choose one option from a list | Inside every menu | `{{ picker }}` (never authored directly) |
| [Library pages](#library-pages) | A picker over a catalogue: one group per page, one row per item | Edit mode's `✚` | A domain that declares groups |
| [Carousel](#carousel) | Step through options, current one centred | Settings rings, configure mode, `themeSwitcher` | `{{ carousel "apply" [cap] }}` |
| [Theme and layout previews](#theme-and-layout-previews) | Show what a pick will look like | Under the theme, style, preset, variation rings | `{{ themePreview }}`, `{{ layoutPreview }}` |
| [Confirm step](#confirm-step) | Two clicks for a destructive act | `⟲ reset all`, `/clear` | `confirmStep` |
| [Setting control](#setting-control) | The control a setting gets, chosen by its domain | Settings menu, configure mode | `settingControl` |
| [Settings menu](#the-settings-menu) | The door to every session and config setting | Every bar | Synthesized |
| [Edit mode](#edit-mode) | Add, remove and configure placements | Every bar, from `✎ arrange` | Synthesized |
| [Configure mode](#configure-mode) | Change one placement's settings | Edit mode's `⚙️` | Synthesized |
| [Bundled segments with clicks](#bundled-segments-with-clicks) | Git detail, ceiling, autocompact, trays, theme switcher, PR link | Default rows and opt-in | `segments:` in the default config |
| [State-showing segments](#state-showing-segments) | Colour or glyph that tracks a value | Default rows and opt-in | `bg:` ramps, `cascade`, `gauge`, `sparkline` |
| [Diagnostic strip](#diagnostic-strip) | Errors, warnings, update notice, above the bar | Any bar with something to say | Composed by the daemon |

## Beside the pickers proposal

These are the existing pieces each part of the proposal touches. They are facts about today, not recommendations.

- **General picker, state 1 (`[Preset]`, the field's name).** Nothing names its field today. A ring row shows a glyph and the current value (`▦ default ▸`, `🎨 tokyo-night ▸`), and the tabs are glyph-labelled. Configure mode is the one place controls carry words (`warning at %`, `theme`).
- **State 2 (`< CurrentPresetName >`).** This is a [carousel](#carousel) capped at zero neighbours, which already exists: `{{ carousel "apply" 0 }}`, drawn by the opt-in `themeSwitcher` segment as `◀ tokyo-night ▶`. Each arrow applies the previous or next value. Clicking the centre name applies the current value again; it does not open anything.
- **State 3 (the list below, with `X`).** This is a [menu](#menu) body: a picker grid dropped below the row, led by `✕`, with `←`/`→` paging when it does not fit. Picking applies the value; whether the list stays open is the `closeOnPick` option (default: stays open).
- **"The colour changes to show a menu is attached."** That is already the rule for every trigger: an open trigger wears its band's state colour, and the body below sits on a plane of the same hue ([disclosure](#disclosure-and-the--close)).
- **Theme swatches.** `{{ themePreview }}` draws swatches of the current theme as one row of sample cells. It is the only swatch-like element today. There is no per-theme swatch next to a name.
- **"Each theme name has the same colour and background as the rest of the UI, unlike today."** Today an option in the theme picker is painted in that theme's own background and primary colour, and an option in the style picker is painted in the base theme with that style applied. Every other picker's options wear the band's colours.
- **The gear (`[⚙️]`) opening a separate menu.** This is how configure mode works today: `⚙️` on a placement opens a body of that placement's settings.
- **`[Done]`.** Edit mode's `✓ done` / `✓ save` is the nearest element. Every other open body closes with `✕`.
- **`(random)`.** No element today picks a random value.
- **Moving style and variation into the theme picker.** Today theme, style, endcaps and variation are four sibling rings in the `🎨 look` tab.

## How a click works

Every clickable span is an OSC-8 link, `cc-candybar://dispatch/…`, carrying an ordered list of effects (`src/click/wire.ts`, `effectsUrl`). Clicking it runs the URL handler app, which sends the effects to the daemon. The daemon runs each effect through its verb table (`src/daemon/verbs/index.ts`, `VERBS`), and the next render shows the result.

An effect writes in one of two places: the **session** (state that lasts as long as this Claude Code session), or the **config file** (durable; the daemon reloads it). Settings changed in the menu are session drafts until `💾 save` writes them to the file. One click is one step of the session's undo history. A click the daemon refuses shows its reason once, in the red strip above the bar:

```
⚠ slash: /compact was not typed: this session's statusline client reports no tmux facts (it predates this daemon) —
rebuild or reinstall cc-candybar
```

Links to web pages (a repository, a pull request) and `file://` links go to the terminal or the OS; the daemon never sees them. In the click tables below, "session `k` ← `v`" means the click writes `v` to session key `k`.

## Building blocks

### Action region

One span of a segment's text bound to a named action. The template names the action and supplies the text; the action declares what the click does. This is the unit every other element is made of.

- **Authored as:** `{{ action "name" "text" }}` in a template, plus `actions: { name: … }` in the config. `src/render/action.ts` (`actionFuncs`, `realize`), declarations in `src/config/action.ts`.
- **Looks:** whatever text the template passes. A region whose value is already current is drawn bold.

What a click does depends on the action's kind:

| Kind | Config spelling | The click |
|---|---|---|
| Set a literal | `{ set: k, to: v }` | session `k` ← `v` |
| Set an option | `{ set: k, from: domain }` | session `k` ← the option the template bound (pickers, menus, carousels) |
| Step | `{ set: k, min, max, by }` | session `k` ← current ± `by`, wrapping (see [Stepper](#stepper)) |
| Set an integer | `{ set: k, int: true }` | session `k` ← the bound integer (a picker's page cursor) |
| Cycle | `{ set: k, cycle: [a, b, …] }` | session `k` ← the next member (see [Toggle](#toggle)) |
| Persist | `{ persist: k, to \| from \| cycle \| min, max, by }` | the same four writes as `set`, into the config file instead of the session |
| Save | `{ save: true }` | writes every session draft to the config file |
| Reset | `{ reset: field }` | removes the setting from the session and from every config-file layer |
| Undo / redo / back / rewind | `{ undo: true }` … | step the settings history; `back` steps the navigation history; `rewind` puts back everything edit mode changed |
| Preset | `{ preset: "save" }` / `{ preset: "delete", name }` | writes or removes a preset in the config file |
| Layout op | `{ persist: root, removeSegment }` / `insertSegment` / `insertSegmentFrom` | rewrites a preset's `root` in the config file |
| Copy | `{ copy: template }` | copies the evaluated text |
| Open | `{ open: template }` | opens a path in VS Code |
| Slash | `{ slash: "/compact" }` | types the command into this session's Claude Code pane (refused unless the pane shows a bare prompt) |
| Doctor | `{ doctor: "run" }` / `{ doctor: "fix", check }` | runs the checks; fixes one |
| Ceiling | `{ ceiling: "set", to }` / `{ ceiling: "clear" }` | moves memento's context ceiling for this session |
| Do | `{ do: [a, b, …] }` | fires each listed action in one click, one undo step |

### Toggle

A [cycle action](#action-region) with one display per member. A click writes the next member, wrapping, so a two-member cycle is an on/off switch. The settings menu's layout tab, with `☑ wrap`, and edit mode's top row, with `☐ live`:

```
 ✕  + preset  ✎ arrange  ☑ wrap ↺  ◀ padding 1 ▶ ↺
```

```
 ✓ done  |  ☐ live
```

| Region | Click |
|---|---|
| The glyph and label | session key ← the next member |

- **Use cases:** boolean settings (`wrap`, `update notice`), edit mode's `☐ live`, the git segment's `▸`/`◂`, every disclosure trigger (a disclosure is a two-member cycle, `closed` and open).
- **Authored as:** `{ set: k, cycle: [a, b] }` and `{{ action "name" "☐ x" "☑ x" }}`. `src/render/action.ts`; the per-state displays are chosen by `pickCycleDisplay` in `src/config/disclosure.ts`.

### Stepper

Two [action regions](#action-region) on either side of a value. In the settings menu's layout tab, then in configure mode for `block`:

```
 ✕  + preset  ✎ arrange  ☑ wrap ↺  ◀ padding 1 ▶ ↺
```

```
 ✕  |  ◀ warning at % 50 ▶
    |  ◀ error at % 80 ▶
```

| Region | Click |
|---|---|
| `◀` | session key ← value − step, wrapping at the minimum |
| `▶` | session key ← value + step, wrapping at the maximum |

The step is applied when the click lands, not when the bar was drawn, so several quick clicks add up.

- **Use cases:** `padding`; the warning and error thresholds of `block`, `weekly`, `session`, `today` and `burnrate`, in configure mode.
- **Authored as:** two `{ set, min, max, by }` actions; [setting control](#setting-control) generates them for a `{ min, max }` setting.

### Disclosure and the ✕ close

A trigger that shows or hides a body. It is one primitive behind the settings door, every tab and ring, groups, edit-mode help and configure mode (`src/config/disclosure.ts`, `disclosureNode`). The trigger is a two-member [toggle](#toggle) over the body's key. The [group](#group) drawings below show one closed and open: the open body's first row is led by `✕`, and each later row by a blank of the same width, so the rows read as one panel.

| Region | Click |
|---|---|
| The trigger | session key ← open member / `closed` |
| `✕` on the body's first row | session key ← `closed` |

- **Placement:** a body either drops below its trigger's row, or rises above the whole bar. Only the settings door rises. When it does, the trigger rises with it and becomes the body's close (the door shows `✖` instead of a `✕`).
- **Accordion:** triggers that share one key hold one open body between them: opening one closes the others. The settings tabs and rings work this way.
- **Colour:** an open trigger wears its band's state colour; the body sits on a plane of that hue, one band deeper per nesting level (`src/themes/decor.ts`, `bandFor`). The `✕` close is the trigger's own state colour (`src/render/disclosure-close.ts`).

### Group

Group sugar for a [disclosure](#disclosure-and-the--close) over a chunk of layout. The loader turns one declaration into the state, the cycle action, the trigger segment and the body.

```
 more ▸
```

```
 more ▾
 ✕  ◈ v2.1.0
    ⌗bar0a1b2
    § $0.39 (0 tokens)
    ☉ <$0.01 (0 tokens) 0%
```

Same at 80 and 200 columns.

| Region | Click |
|---|---|
| `more ▸` / `more ▾` | session `groups.more` ← `more` / `closed` |
| `✕` | session `groups.more` ← `closed` |

- **Use cases:** hiding secondary information; accordions (groups sharing a `key`); nested disclosure.
- **Where used:** author configs only. The bundled config declares no group.
- **Authored as:** `{ kind: "group", name, label, key?, open?, children }` in `root`. `src/config/loader/layout.ts` (`lowerGroup`, `synthesizeGroupDecls`).

### Menu

A trigger whose body is a [picker grid](#picker-grid) dropped below the row. The loader mints the menu's open-state and page variables per placement, so the author declares only the apply action.

`↕ asc ▸` in a row of opt-in segments, closed, then open, with the picker below and the current option (`asc`) in bold:

```
 ◔ ▰▰▰▰▰▰▰▰▱▱  ↕ asc ▸   ⧖ 6.8m ⧗ 16m + 512 - 88   ⚠ PR
```

```
 ◔ ▰▰▰▰▰▰▰▰▱▱  ↕ asc ▾   ⧖ 6.8m ⧗ 16m + 512 - 88   ⚠ PR
 ✕ asc desc
```

Same at 80 and 200 columns.

| Region | Click |
|---|---|
| The trigger | opens (and resets the page to 0) / closes |
| An option | applies it through the apply action; also closes when `closeOnPick` is set |
| `✕` | closes |
| `←` / `→` | previous / next page, shown only when there is one |

- **Use cases:** picking from any option domain: themes, styles, endcaps, presets, an inline list, the segments edit mode can add.
- **Where used:** edit mode's `✚` (over the [library](#library-pages)). Author configs.
- **Authored as:** `{{ menu "apply" "▸" "▾" }}`, or one static display (`"+"`). An optional trailing `(dict "closeOnPick" true "paged" false "key" "shared")`. `src/render/menu.ts` (`menuFuncs`); the minted keys are in `src/config/loader/menu-synth.ts`.

### Picker grid

The body a [menu](#menu) drops: `✕`, then a row of option cells that fits the width (`✕ asc desc` above). When the options do not fit, the row pages: `←` appears after the first page and `→` before the last, as in the [library pages](#library-pages) drawing. `{{ picker }}` can also be written by hand, but the authoring guide says not to (the page cursor and the reveal row then have to be wired by hand).

| Region | Click |
|---|---|
| An option | its apply action's effects |
| `←` / `→` | page cursor ± 1 |
| `✕` | closes (page cursor ← −1 for a hand-written picker) |

- **Colour:** an option over the theme domain is painted in that theme's own background and primary colour; an option over the style domain, in the base theme with that style applied. Other options wear their band's item colours, placed by their index in the whole domain, so paging does not recolour them. The current option is bold.
- **Authored as:** `{{ picker "apply" "page" closeOnPick paged }}`. `src/render/picker.ts` (`renderPicker`, `pickerFuncs`); option colours in `src/render/band-style.ts` (`optionItemStyle`).

### Library pages

A picker over a catalogue domain. Each group is a page, and each member is one row: its name padded to the page's widest name, then its description, cut to the width.

```
 ✕ location 1/6 →
 directory  The current directory, shortened fish-style — `~` under home, pr…
 tmux       The tmux session name; hidden when not inside tmux.
 host       user@host on a warning background, shown only over SSH.
```

At 200 columns the descriptions are cut later:

```
 ✕ ← git 2/6 →
 gitaculous  The git state: a summary (branch, ahead/behind, S/U/? flags) that the arrow at its right edge expands to every fact — repo, in-progress operation, sha, upstream ±, stash count, time s…
 gitPr       The pull request open for this branch, as a link; `⚠ PR` when the forge lookup failed.
```

| Region | Click |
|---|---|
| A row | applies that member (edit mode: inserts the segment at this `✚`) |
| `←` / `→` | previous / next page |
| `✕` | closes |

- **Where used:** edit mode's `✚` only. Its domain is the declared segments, grouped by each segment's own `group:` (`location`, `git`, `model & context`, `cost & limits`, `activity`, `session tools`, then `other` for a segment that declares none).
- **Authored as:** a domain that declares a library (`DomainLibrary` in `src/config/option-domain.ts`); laid out by `src/render/library.ts` (`libraryLayout`, at most 8 rows per page). A bare `{{ picker }}` refuses a catalogue domain; only a menu body lays one out.

### Carousel

A ring of options centred on the current value: neighbours in symmetric pairs, as many as fit the row, then `◀ CURRENT ▶`. It keeps no position of its own; its centre is whatever the setting currently is.

The theme ring at 80 columns, then at 200:

```
 ✕  textual-light ◀ tokyo-night ▶ atom-one-dark
```

```
 ✕  solarized-light svg-export textual-ansi textual-dark textual-light ◀ tokyo-night ▶ atom-one-dark atom-one-light catppuccin-frappe catppuccin-latte catppuccin-macchiato
```

Short domains fit whole at either width: style, endcaps, variation and colour depth, in that order. The last line is charset, whose two members leave no symmetric pair to show:

```
 ✕  bright inverted ◀ none ▶ vivid muted
 ✕  plain ◀ powerline ▶ capsule
 ✕  mono ◀ accent ▶ duo
 ✕  none ◀ truecolor ▶ 256
 ✕  ◀ unicode ▶
```

| Region | Click |
|---|---|
| `◀` / `▶` | applies the previous / next option |
| A neighbour's name | applies that option |
| The current name | applies the current option again |

- **Use cases:** every option-valued setting in the settings menu; a placement's `theme` in configure mode; the opt-in `themeSwitcher` segment (`◀ tokyo-night ▶`, capped at zero neighbours).
- **Width:** the ring is 51 cells at 80 columns and 175 at 200 for the theme domain. It takes whatever width the row allows.
- **Authored as:** `{{ carousel "apply" }}` or `{{ carousel "apply" 0 }}` over a `{ set, from }` action. `src/render/carousel.ts` (`renderCarousel`, `neighbourLevels`). Options are coloured as in the [picker grid](#picker-grid).

### Theme and layout previews

Read-only rows under a ring, showing what the current pick looks like. Neither has a click.

`{{ themePreview }}`, under the theme and style rings: sample cells of the current theme, each drawn by the function that draws that kind of cell on the bar (decoration tones, an open trigger and its plane, warning, error):

```
    ~/code  main  opus  42%  5m  $1.20   ▾ open  menu   warn  error
```

`{{ layoutPreview }}`, under the preset and variation rings: one block per segment of the current preset's rows, in that row's colours, labelled with the segment's name:

```
    menu  host  directory  gitaculous
    model  context  autocompact  block  weekly
```

- **Authored as:** `src/render/theme-preview.ts` (`themePreviewFuncs`), `src/render/layout-preview.ts` (`layoutPreviewFuncs`). Both fit the row: the theme preview drops trailing swatches, the layout preview shortens labels.

### Confirm step

Two clicks for an act that cannot be cleanly undone. The first click arms; the armed state shows the confirm label and a `✕`. The save cell, disarmed and armed:

```
  ✖    ◁    ▦ default ▸ ↺    💾 save 1 ↶ ⟲
```

```
  ✖    ◁    ▦ default ▸ ↺    💾 save 1 ↶ ⟲ reset all? ✕
```

The command tray, disarmed and armed:

```
    /compact /model /clear
```

```
    /compact /model /clear ✓ confirm ✕
```

| Region | Click |
|---|---|
| `⟲` / `/clear` (disarmed) | session `<key>.armed` ← `armed` |
| `reset all?` / `✓ confirm` | fires the act, and disarms |
| `✕` | session `<key>.armed` ← `disarmed` |

The door, `◁ back` and every tab click also disarm, so a confirm is never left armed in a menu that is closed.

- **Where used:** `⟲ reset all` in the save cell; `/clear` in the command tray.
- **Authored as:** `confirmStep` in `src/config/confirm-step.ts`.

### Setting control

The control a setting gets, chosen from its domain. The same generator serves the settings menu (for `globals`) and configure mode (for a placement's `settings`).

| Domain | Control | Example |
|---|---|---|
| `"bool"` | [Toggle](#toggle) | `☑ wrap ↺`, `☑ ahead/behind` |
| A range `{ min, max }` | [Stepper](#stepper) | `◀ padding 1 ▶ ↺`, `◀ warning at % 50 ▶` |
| A word list or option domain | [Carousel](#carousel); in the settings menu, behind a ring row | `🎨 tokyo-night ▸ ↺`, `theme … ◀ bar ▶ …` |

Every control writes a session draft. In the settings menu, every control also has a `↺`, which resets that setting at every layer (`reset-config`).

- **Authored as:** `settingControl` in `src/config/setting-control.ts`. Which tab a global setting appears in is the `PLACE` table in `src/config/settings-menu.ts`.

## The settings menu

`synthesizeSettingsMenu` (`src/config/settings-menu.ts`) puts this menu in every preset of every config. Its first cell, the door, leads the bar's first row.

### Door

```
 🍫  ⇄ bmf@mmu  ~/c/cc-candybar  ⎇ docs/ui-elements-inventory +1 ? ▸
 ✱ Opus 4.8  ◔ 48,000 (76%)  ⇲ auto −  ◱ 63% (2h 1m)  ◑ 21% (5d)
```

Clicking `🍫` opens the menu above the bar. The door rises with it as `✖`, in the theme's error colour, and the bar's rows stay as they were:

```
 ✖  ◁  ▦ default ▸ ↺
    ▾ ⚡ session  🎨 look  📐 layout  ⚙ config  🧰 tools
 ✕  ⎘ id ⎘ resume ↗ proj ↗ log ↗ repo ↗ config
    /compact /model /clear
 ⇄ bmf@mmu  ~/c/cc-candybar  ⎇ docs/ui-elements-inventory +1 ? ▸
 ✱ Opus 4.8  ◔ 48,000 (76%)  ⇲ auto −  ◱ 63% (2h 1m)  ◑ 21% (5d)
```

Same at 80 and 200 columns. The menu is two lines, then the open tab's body.

| Region | Click |
|---|---|
| `🍫` / `✖` | session `candybar.menu` ← `open` / `closed`. Closing also disarms every confirm, closes any open ring, and returns the tab to `session`, so the menu reopens at its top |
| `◁` | `back`: undoes the last navigating click (what was open, which tab). Drawn muted and inert while there is nothing to go back to |

- **Glyph:** `globals.menuGlyph` (default `🍫`). An author may place the `candybar.menu` segment elsewhere, but never under a `when` or inside a disclosure body: the menu is visible under every condition.

### Preset control and save cell

The first line's controls. On a fresh session:

```
 ✖  ◁  ▦ default ▸ ↺
```

With a draft (here, padding stepped to 2), the save cell appears; its parts show only while each has something to do:

```
  ✖    ◁    ▦ default ▸ ↺    💾 save 1 ↶ ⟲
```

| Region | Click |
|---|---|
| `▦ default ▸` | opens the preset ring (below) |
| `↺` | resets the preset pick at every layer |
| `💾 save N` | writes the N drafts to the config file; shown while N > 0 |
| `↶` / `↷` | undo / redo a settings change; shown while the history has a step |
| `⟲` | [confirm step](#confirm-step) for reset all: every control's `↺` in one click; shown while a reset would change something |

The preset ring, with the layout preview under it:

```
 ✖  ◁  ▦ default ▾ ↺
 ✕  git usage dense ◀ default ▶ compact verbose zen
     menu  host  directory  gitaculous
     model  context  autocompact  block  weekly
    ▾ ⚡ session  🎨 look  📐 layout  ⚙ config  🧰 tools
```

Picking `compact` changes the whole bar, including its padding, which the preset sets to 0:

```
✖◁▦ compact ▾ ↺💾 save 1 ↶ ⟲
✕usage dense default ◀ compact ▶ verbose zen git
  menu  directory  gitaculous  context
 ▾ ⚡ session🎨 look📐 layout⚙ config🧰 tools
```

On a preset the user authored, the ring's body also holds `🗑 delete <name>`.

### Tabs

```
    ▾ ⚡ session  🎨 look  📐 layout  ⚙ config  🧰 tools
```

One tab is open at a time; it leads with `▾`. A tab click writes `candybar.tab` and disarms the command tray's confirm; clicking the open tab closes it. The open tab's body drops below, led by `✕`.

**`⚡ session`**, the default:

```
 ✕  ⎘ id ⎘ resume ↗ proj ↗ log ↗ repo ↗ config
    /compact /model /clear
```

| Region | Click |
|---|---|
| `⎘ id` | copies the session id |
| `⎘ resume` | copies the shell command that resumes this session (`cd <project> && claude --resume <id>`, with `CLAUDE_CONFIG_DIR` when the session runs under one) |
| `↗ proj` / `↗ log` | opens the project directory / the transcript in VS Code |
| `↗ repo` | web link to the repository (shown when there is one) |
| `↗ config` | opens the config file the bar renders from in VS Code (shown when there is one) |
| `/compact` / `/model` | types the command into this session's Claude Code pane |
| `/clear` | [confirm step](#confirm-step), then types `/clear` |

These are the same trays the opt-in `toolbar` and `commands` segments draw (`src/config/quick-actions.ts`, `src/config/command-tray.ts`).

**`🎨 look`:**

```
 ✕  🎨 tokyo-night ▸ ↺  ◐ none ▸ ↺  ✦ powerline ▸ ↺  🎼 accent ▸ ↺
```

Each is a ring row: glyph, current value, `▸` to open its [carousel](#carousel), `↺` to reset. The rings share one accordion key, so one is open at a time. Open theme ring, at 80 columns:

```
 ✕  🎨 tokyo-night ▾ ↺  ◐ none ▸ ↺  ✦ powerline ▸ ↺  🎼 accent ▸ ↺
 ✕  textual-light ◀ tokyo-night ▶ atom-one-dark
     ~/code  main  opus  42%  5m  $1.20   ▾ open  menu   warn  error
```

The style ring also carries the theme preview; the variation ring carries the layout preview; endcaps carries none.

**`📐 layout`:**

```
 ✕  + preset  ✎ arrange  ☑ wrap ↺  ◀ padding 1 ▶ ↺
```

| Region | Click |
|---|---|
| `+ preset` | saves the active preset, with this session's settings, as `custom-N` in the config file, and switches to it |
| `✎ arrange` | enters [edit mode](#edit-mode); reads `✎ done` while in it |
| `☑ wrap` | toggles `autoWrap` |
| `◀ padding 1 ▶` | [stepper](#stepper) for padding |

**`⚙ config`:**

```
 ✕  🔣 unicode ▸ ↺  🌈 truecolor ▸ ↺  ☑ update notice ↺
```

Charset and colour depth are rings; update notice is a toggle.

**`🧰 tools`:**

```
 ✕  🩺 doctor
```

`🩺 doctor` runs every check, and one row per check appears under it. At 200 columns:

```
 ✕  🩺 doctor
    ✗ tmux truecolor — the client reported no tmux facts — re-run `cc-candybar install` to stage a current client
```

At 80 columns the row moves under an empty row and is still 113 cells wide:

```
 ✕  🩺 doctor

 ✗ tmux truecolor — the client reported no tmux facts — re-run `cc-candybar install` to stage a current client
```

A passing check reads `✓ <label>`. A failing check that can be fixed carries `[fix]`, which writes `~/.claude/settings.json` (`doctor-fix`). The checks are data in `src/doctor/checks.ts`; today there is one, `tmux truecolor`.

## Edit mode

`✎ arrange` turns the bar into an editor of the active preset's layout (`synthesizeEditChrome`, `src/config/edit-chrome.ts`). The seams become `|` (edit mode's own `endcaps: plain`), every placement shows its name, and a row of edit controls sits above the bar. From the menu, the menu stays open while arranging. With it closed, at 200 columns:

```
 ✓ done  |  ☐ live
 🍫  |  ✚  |  ✖ host ⚙️  |  ✚  |  ✖ directory ⚙️  |  ✚  |  ✖ gitaculous ⚙️  |  ✚
 ✚  |  ✖ model ⚙️  |  ✚  |  ✚  |  ✖ context ⚙️  |  ✚  |  ✖ ceiling ⚙️  |  ✚  |  ✖ autocompact ⚙️  |  ✚  |  ✖ cacheTimer ⚙️  |  ✚  |  ✖ block ⚙️  |  ✚  |  ✖ weekly ⚙️  |  ✚  |  ✖ activity ⚙️  |  ✚
 (?)
```

At 80 columns the rows wrap:

```
 ✓ done  |  ☐ live
 🍫  |  ✚  |  ✖ host ⚙️  |  ✚  |  ✖ directory ⚙️  |  ✚  |  ✖ gitaculous ⚙️
 ✚
 ✚  |  ✖ model ⚙️  |  ✚  |  ✚  |  ✖ context ⚙️  |  ✚  |  ✖ ceiling ⚙️  |  ✚
 ✖ autocompact ⚙️  |  ✚  |  ✖ cacheTimer ⚙️  |  ✚  |  ✖ block ⚙️  |  ✚
 ✖ weekly ⚙️  |  ✚  |  ✖ activity ⚙️  |  ✚  |  (?)
```

After a change (here, `✖` on host), the edit row grows:

```
 ✓ save  |  ↩ cancel  |  ↺ reset layout  |  ☐ live
 🍫  |  ✚  |  ✖ directory ⚙️  |  ✚  |  ✖ gitaculous ⚙️  |  ✚
```

| Region | Click |
|---|---|
| `✓ done` / `✓ save` | saves every unsaved setting (configure-mode drafts included) and leaves edit mode. Reads `✓ done` when there is nothing to save or cancel |
| `↩ cancel` | `rewind`: puts back every config-file change made since edit mode opened, as one undo step, and leaves edit mode. Shown only after a change |
| `↺ reset layout` | removes the config file's own layout for this preset, restoring the bundled one. Shown only when the file has one |
| `☐ live` / `☑ live` | shows each placement's live output instead of its name |
| `✖` (red, inside a placement's cell) | removes that placement: rewrites `presets.<name>.root` in the config file at once |
| `✚` (green, no fill) | opens the [library](#library-pages) at that position; becomes `✕` while open. Picking a row inserts that segment there |
| `⚙️` | enters [configure mode](#configure-mode) for that placement |
| `(?)` | opens the help body (below); becomes `✕` while open |

Layout changes are not drafts: each `✖` and `✚` pick writes the config file at once. Opening edit mode takes a savepoint, which is what `↩ cancel` returns to.

The `(?)` body:

```
 ✕  |  ✚ inserts  |  ✖ removes  |  ⚙️ configures  |  ↺ resets layout
```

`(?)` is the only help disclosure in the bar (`declareHelp`, `src/config/help.ts`).

## Configure mode

`⚙️` on a placement opens that placement's settings below its name, one [setting control](#setting-control) per setting. While a placement is configured, the bar shows live output rather than names, so a change is visible as it is made. Configuring `gitaculous`, at 80 columns:

```
 ✓ done  |  ☐ live
 🍫  |  ✚  |  ✖ ⇄ bmf@mmu ⚙️  |  ✚  |  ✖ ~/c/cc-candybar ⚙️  |  ✚
 ✖ gitaculous ⚙️  |  ✖ ⎇ docs/ui-elements-inventory +1 ? ▸ ⚙️  |  ✚
 ✕  |  ☑ ahead/behind
    |  ☑ dirty flags
    |  ☑ operation
    |  ☑ repo name
    |  ☑ commit hash
    |  ☑ stash
    |  ☑ upstream
    |  ☑ time since commit
    |  theme textual-light tokyo-night ◀ bar ▶ atom-one-dark atom-one-light
```

At 200 columns the theme ring is wider and sits under an empty row:

```
    |  ☑ time since commit

 theme solarized-light svg-export textual-ansi textual-dark textual-light tokyo-night ◀ bar ▶ atom-one-dark atom-one-light catppuccin-frappe catppuccin-latte catppuccin-macchiato catppuccin-mocha
```

Configuring `block`:

```
 ✕  |  ◀ warning at % 50 ▶
    |  ◀ error at % 80 ▶
    |  theme textual-light tokyo-night ◀ bar ▶ atom-one-dark atom-one-light
```

| Region | Click |
|---|---|
| A control | session `edit.draft.<preset>.<id>.<setting>` ← the new value; the placement renders it at once and `💾 save` counts it |
| `✕` | closes configure mode, back to arranging |
| Another `⚙️` | configures that placement instead (one at a time) |

- **Settings:** every placement has `theme` (`bar` follows the bar's theme; any installed theme pins this placement). Bundled segments declare more: `gitaculous` has eight toggles; `block` and `weekly` have warning and error thresholds; `session` and `today` have a budget and a warning threshold; `burnrate` has two time thresholds.
- **Saving:** `✓ save` writes each draft into the placement in the config file, turning a bare `"block"` into `{ seg: "block", settings: { … } }`.

## Bundled segments with clicks

From `src/config/default-dsl-config.ts`.

**`gitaculous`**, in the default first row. `▸` expands it to every git fact; `◂` collapses it (session `git-detail`, per session). Collapsed and expanded, at 200 columns:

```
 🍫  ⇄ bmf@mmu  ~/c/cc-candybar  ⎇ docs/ui-elements-inventory +1 ? ▸
```

```
 🍫  ⇄ bmf@mmu  ~/c/cc-candybar  (git) cc-candybar d664459 ? ⎇ docs/ui-elements-inventory [origin/main +1] (2 stashed) ◷ 38s ◂
```

At 80 columns the expanded form moves to its own row. Which facts each form shows are the placement's eight settings (see [configure mode](#configure-mode)).

**`autocompact`**, in the default second row. Each control types `/autocompact <tokens|auto>` into this session's Claude Code pane. With the window on `auto` it reads `⇲ auto −`, as in every drawing above; with a window set it reads `⇲ 400.0K − + ↺` (from the in-process render in `design-docs/settings-menu-map-render.mts`, whose payload sets a window).

`−` and `+` move the window by 100K, within 100K–1M and the model's context window. `↺` returns it to `auto`. A value the daemon cannot read shows `⇲ ⚠ <error>` on the error colour.

**`ceiling`**, beside `context`, shows memento's context ceiling. It is hidden when memento is not installed, which is why it is absent from the live drawings here. Its template draws `⌈ <ceiling> − + ∞`, then `↺` while this session has a value of its own. `−`/`+` move the ceiling by 100K, `∞` lifts it, `↺` drops the session's setting; all four call memento's own `ceiling` command. An unreadable ceiling layer shows `⌈ ⚠ <error> ↺` on the error colour.

**Opt-in segments.** These are in no bundled row; a config places them. Placed in one row, which wraps at 80 columns:

```
 ◀ tokyo-night ▶  ⎘ id ⎘ resume ↗ proj ↗ log ↗ repo ↗ config  /compact /model /clear
 ◔ ▰▰▰▰▰▰▰▰▱▱  ↕ asc ▸   ⧖ 6.8m ⧗ 16m + 512 - 88   ⚠ PR
```

`tokenSparkline` is in the same row: it drew nothing on the first render, and `⚡ ▁` after `/clear` from the second render on.

| Segment | Looks | Click |
|---|---|---|
| `themeSwitcher` | `◀ tokyo-night ▶` | each arrow applies the previous / next theme (session `theme`) |
| `toolbar` | `⎘ id ⎘ resume ↗ proj ↗ log ↗ repo ↗ config` | as in the `⚡ session` tab |
| `commands` | `/compact /model /clear` | as in the `⚡ session` tab |
| `gitPr` | `⇆ #N`, or `⚠ PR` when the lookup failed | `⇆ #N` is a web link to the pull request |

`tokenSparkline` (`⚡ ▁`), `metrics` (`⧖ 6.8m ⧗ 16m + 512 - 88`) and the gauge (`◔ ▰▰▰▰▰▰▰▰▱▱`) have no click; they are listed under [state-showing segments](#state-showing-segments). `↕ asc ▸` is the example [menu](#menu).

## State-showing segments

These have no click. They show a value by glyph or colour, and each is a place a picker's swatch or preview could draw on.

| Segment or function | Shows |
|---|---|
| `context` | `◔ 48,000 (76%)`; background ramps to warning, then error, as the context fills |
| `block`, `weekly` | `◱ 63% (2h 1m)`, `◑ 21% (5d)`; background steps to warning and error at the placement's thresholds |
| `burnrate` | time until the limit at the current rate; steps at the placement's thresholds |
| `cacheTimer` | `◴ 15m` / `cold`; text colour by `cascade` over the minutes left |
| `host` | `⇄ user@host` on the warning colour, only over SSH |
| `activity` | the slash command, the todo count (`☐ n/N`, `☑ n/N`), tools running (`⟳`) and done (`✓`) |
| `tokenSparkline` | `▁▂▃▄▅▆▇█` over recent token speeds |
| `{{ gauge }}` | one value against a maximum, drawn as cells (`▰▰▰▰▰▰▰▰▱▱`), each cell optionally coloured by a ramp. No bundled segment uses it |
| `{{ ramp }}`, `{{ cascade }}` | a colour or a word chosen by thresholds over a number; how the cells above change colour |

Every other bundled segment (`directory`, `model`, `version`, `sessionId`, `session`, `today`, `speed`, `tmux`) is plain text on its decoration colour.

## Diagnostic strip

Rows above the bar for errors (red), warnings (amber) and the update notice. Each line wraps at the client's width; the strip is capped at 20 rows (or the terminal's height), and a `↳` row closes it when it has something to open. `src/render/diagnostic-strip.ts`.

An invalid config, with a duplicate key as a second (warning) channel, at 80 columns:

```
⚠ Invalid config in
/var/folders/80/071_2pk11ms1qftgqxswr2p40000gn/T/ccb-bar-hvxkaD/config.json5
(1 issue):
  [line 1 • root.h] a container must have a "children" array of layout nodes,
got number
⚠
/var/folders/80/071_2pk11ms1qftgqxswr2p40000gn/T/ccb-bar-hvxkaD/config.json5:
1: duplicate key "h" — the settings menu cannot edit this file until it is
fixed
↳ open /var/folders/80/071_2pk11ms1qftgqxs…000gn/T/ccb-bar-hvxkaD/config.json5
 🍫  ~/c/cc-candybar  ⎇ docs/ui-elements-inventory +1 ? ▸
 ✱ Opus 4.8  ◔ 48,000 (76%)  ⇲ auto −  ◱ 63% (2h 1m)  ◑ 21% (5d)
```

| Region | Click |
|---|---|
| Any word of an error or warning | copies the whole message (`show-config-error` / `show-config-warning`) |
| `↳ open <path>` | `file://` link to the failing config file |
| `↳ N more rows · open full text` | `file://` link to the complete text, when the cap dropped rows |

The bar under a failing config is the bundled default, so the settings menu is still there.

**Update notice.** It shows when the code rendering the bar is older than the source checkout beside it, or than the latest release. That condition is not reproduced here; this is from `updateNotice` in `src/daemon/update-notice.ts`:

```
⬆ Newer source: 1.48.0 [abc1234]. You're on 1.47.0 [def5678]. [rebuild] [dismiss] [disable]
```

| Region | Click |
|---|---|
| The sentence | copies it |
| `[rebuild]` / `[upgrade]` | rebuilds the checkout, or installs the release; reads `[rebuilding…]` while it runs. A failure adds a row `rebuild failed: <reason>` |
| `[dismiss]` | hides it for this session, until something newer appears |
| `[disable]` | turns the notice off in the config file and the session |

**Failure glyph.** When the client cannot get a render at all, it prints one line with no link: `⚠ cc-candybar: protocol mismatch` (or `daemon rejected request`, `render failed`, `malformed daemon response`). `src/render/error-glyph.ts`.

## Click verbs

Every verb the daemon accepts, from `src/click/wire.ts`, and what emits it.

| Verb | Emitted by |
|---|---|
| `dispatch` | every rendered click: the wrapper around the list below |
| `set-state`, `step-state` | toggles, steppers, pickers, menus, carousels, disclosures, `✕`, `[dismiss]` |
| `set-config`, `step-config` | `persist` actions (author configs); `[disable]` |
| `reset-config` | every `↺`, `⟲ reset all`, `↺ reset layout` |
| `save` | `💾 save`, `✓ save` |
| `save-preset`, `delete-preset` | `+ preset`, `🗑 delete` |
| `apply-layout-op` | edit mode's `✖` and `✚` |
| `undo`, `redo`, `back`, `rewind` | `↶`, `↷`, `◁`, `↩ cancel` |
| `copy`, `open-vscode` | `⎘ id`, `⎘ resume`, `↗ proj`, `↗ log`, `↗ config` |
| `slash` | `/compact`, `/model`, `/clear`, autocompact's `−` `+` `↺` |
| `ceiling` | the ceiling segment's `−` `+` `∞` `↺` |
| `doctor-run`, `doctor-fix` | `🩺 doctor`, `[fix]` |
| `show-config-error`, `show-config-warning` | the diagnostic strip's words |
| `apply-update` | `[rebuild]` / `[upgrade]` |
| `toolbar-toggle` | nothing |
| `load-config` | nothing |

## Gaps and overlaps

Found while drawing the above. Each is for Brandon to decide; none is changed here.

1. **A two-value carousel hides its other value.** Neighbours come in symmetric pairs, so a domain of two shows none: the charset ring is `◀ unicode ▶`, and `ascii` appears nowhere until it is picked (`neighbourLevels` in `src/render/carousel.ts`).
2. **The doctor's result row does not fit 80 columns.** It is 113 cells, under an empty row; at 200 columns it sits on its own indented row with no empty row.
3. **Configure mode draws the configured placement twice.** The row shows `✖ gitaculous ⚙️` (its name label, which the settings hang from) and then `✖ ⎇ docs/… ▸ ⚙️` (its live cell), so one placement has two `✖` and two `⚙️`. The same happens for `block`. At 200 columns the theme control also moves under an empty row and loses the body's `|` lead.
4. **Two `✚` side by side.** Between `model` and `context`, and around `context`/`ceiling` and `autocompact`, edit mode draws adjacent `✚` with nothing between them, because `context` and `ceiling` are nested as one unit and the row has an insertion point on each side of the unit's boundary. With `☑ live` on, a placement that renders nothing (`ceiling`, without memento) leaves its two `✚` adjacent too.
5. **`✖` means two things on one screen.** In edit mode with the menu open, `✖` closes the menu (the door) and `✖` removes a segment, both visible at once. Bodies close with `✕`.
6. **Four ways to choose one value.** A [menu](#menu)'s grid (`✕ asc desc`), a [carousel](#carousel) (`◀ none ▶`), a ring row that opens a carousel (`◐ none ▸`), and [library pages](#library-pages). The settings menu uses the ring row and carousel; edit mode uses the menu and library; nothing bundled uses a bare menu over a plain list.
7. **No control names its field.** The settings rings and tabs are labelled by glyph (`🎨`, `◐`, `✦`, `🎼`, `🔣`, `🌈`), while configure mode labels controls with words (`theme`, `warning at %`). This is the proposal's state 1 complaint, and the two conventions differ today.
8. **`↺` always shows; `⟲` shows only when it would do something.** Every control's `↺` is drawn on a fresh session with nothing to reset (`▦ default ▸ ↺`), while the save cell's `⟲` hides until a reset would change something.
9. **Two confirm phrasings.** `⟲ reset all? ✕` and `/clear ✓ confirm ✕` are the same [confirm step](#confirm-step) with different confirm labels.
10. **Unused pieces.** The `toolbar-toggle` and `load-config` verbs are in the verb table but nothing emits them; `toolbar-toggle` writes a session key nothing reads. The bundled `copyDir` action is declared and never referenced. `{{ picker }}` written by hand and `{{ gauge }}` have no bundled caller (both are author-facing).
