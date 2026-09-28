# Settings menu map

Proposal for brandon-menu-ia-q30.1ws. Nothing here is built yet; the implementation tickets are filed from this map once it is approved.

## The recommendation

Open the door onto one row of four tabs, one for each thing a person opens the menu to do: `⚡ session` to act on this session, `🎨 appearance` to change the colours and shape, `▦ layout` to change what the bar shows and how it fits, and `🖥 terminal` to match what the terminal can draw. One tab is open at a time. Save, undo, redo and reset-all share one cell at the end of that row, and it appears only when there is something to save or step.

The rows this replaces were grouped by frequency: the first row held whatever people click most, and everything else went behind `⚙ config`. That puts charset and colour depth, which a person sets once per terminal, beside the theme, which they try a dozen times. It also puts wrap and padding, which they adjust when the bar does not fit, one disclosure away from the preset switcher they reach for at the same moment. Grouping by intent fixes both. The person opening the menu already knows which of the four they want, so the first click picks the tab and the second does the thing.

It also makes the menu shorter. With the theme picker open, today's menu takes 7 lines above the status row at 80 columns, and the proposed one takes 4.

What goes, in one line each:

- `☐ persist?` and its `(?)` go, replaced by the Save button (brandon-save-undo-bwi.hpi).
- `⚙ config ▸` goes, and its eight controls are dealt out to the three setting tabs.
- `🧰 tools ▸` goes. It is a disclosure holding one button, and that button (`🩺 doctor`) checks tmux truecolor, a terminal question, so it moves to `🖥 terminal`.
- The `↺` beside every control goes until the setting differs from its default. At that point `↺` is the drift marker nk8 asks for and the reset wt5 asks for, as one glyph.

## How it renders

All widths are terminal cells measured with rich-js `cellLen` at padding 1, the widest bundled padding. Each cell adds its text, two padding cells and one seam, plus one cap per row. That model reproduces the rendered rows of today's menu to the cell (103 and 150 measured, 103 and 150 modelled). Powerline arrows are drawn as spaces below.

### Today, at 80 columns

Rendered from the bundled default, theme picker open:

```
❌  ⎘ id ↗ proj ↗ log ↗ repo  ☐ persist?  (?)  ▦ default ▸ ↺         68 ┐ one row, 103
⚙ config ▾  🧰 tools ▸  ✎ edit                                       36 ┘ cells, wraps
✕  🎨 tokyo-night ▾ ↺  ◐ none ▸ ↺  ✦ powerline ▸ ↺                    57 ┐
🎼 secondary-accent ▸ ↺  🔣 unicode ▸ ↺  🌈 truecolor ▸ ↺  wrap: on ↺  76 │ one row, 150
◀ padding 1 ▶ ↺                                                       19 ┘ cells, wraps
✕  textual-dark textual-light ◀ tokyo-night ▶ dark light              61
✕   ~/code  main  opus  42%  5m  $1.20   ▾ open  menu   warn  error   73
✱ Opus 4.8  ◔ 48,487 (24%)  ◴ 15m  ◱ 63% (2h 1m)  ◑ 21% (5d)         68
```

`⚙ config` and `🧰 tools` hold separate keys (`CONFIG_REF` and `TOOLS_REF`, `src/config/settings-menu.ts:143`), so both can be open at once and stack their rows.

### Proposed, door just opened

The first open shows the tabs and nothing else. After that, the door reopens on the tab that was open last, because the open tab is one session key.

```
❌  ⚡ session  🎨 appearance  ▦ layout  🖥 terminal                   59
✱ Opus 4.8  ◔ 48,487 (24%)  ◴ 15m  ◱ 63% (2h 1m)  ◑ 21% (5d)
```

With unsaved drafts, history to step, and settings off their defaults, the tab row grows a trailing cell. It trails so that the tabs never move when it appears, for the same reason `activity` trails the status row:

```
❌  ⚡ session  🎨 appearance •  ▦ layout •  🖥 terminal  💾 3 ↶ ↷ ⟲   76
```

`💾 3` saves three drafts. The word "save" costs five cells and would push this row to 81. `↶ ↷` show only while the history has a step in that direction. `⟲` resets every menu setting, and a first click turns it into `⟲ reset all?`, which a second click confirms. During that confirm the row is 87 cells and wraps at 80, the one moment it does. A `•` on a tab means something inside it differs from its default.

### `⚡ session`

```
✕  ⎘ id ⎘ resume ↗ proj ↗ log ↗ repo ↗ config                         50
✕  /compact  /clear  /model  <autocompact control>                  (xta)
```

The first row is today's quick-action tray plus two additions (see below). The second row arrives with brandon-context-ceiling-xta.qhj and .e3p. It is a row of its own because the two together measure 79 cells before the autocompact control is added.

### `🎨 appearance`

```
✕  🎨 tokyo-night ▸  ◐ none ▸  🎼 secondary-accent ▸  ✦ powerline ▸   75
```

With the theme picker open:

```
✕  🎨 tokyo-night ▾  ◐ none ▸  🎼 secondary-accent ▸  ✦ powerline ▸   75
✕  textual-dark textual-light ◀ tokyo-night ▶ dark light              61
✕   ~/code  main  opus  42%  5m  $1.20   ▾ open  menu   warn  error   73
```

With four settings drifted to long names, the row measures 92 cells and wraps once at 80:

```
✕  🎨 catppuccin-frappe ▸ ↺  ◐ inverted ▸ ↺  🎼 primary-secondary ▸ ↺  ✦ capsule ▸ ↺
```

I left that wrap in place. It is this tab's worst case with bundled names, not its usual state, and the fixes available (dropping `▸` from picker controls, or splitting colour from shape across two tabs) cost more than one extra line costs.

### `▦ layout`

```
✕  ▦ default ▸  + preset  ✎ arrange  wrap: on  ◀ padding 1 ▶          69
```

Drifted: `▦ compact ▸ ↺ … wrap: off ↺  ◀ padding 0 ▶ ↺`, 76 cells. `▦` opens today's preset ring with its `{{ layoutPreview }}` rows. `✎ arrange` is today's `✎ edit`: it enters edit mode and closes the menu in one click (`settings.edit`, `settings-menu.ts:602`).

### `🖥 terminal`

```
✕  🔣 unicode ▸  🌈 truecolor ▸  🩺 doctor                             48
✕  ✗ tmux truecolor — <reason> [fix]
```

The check rows appear under the controls once `🩺 doctor` has run, exactly as they do under `🧰 tools` today. The tab is named `terminal`, the word you objected to on the bar. It holds only what the terminal can draw now: the old drawer's directory palette pin is already gone (q30.42a), and every control in the tab answers "what can this terminal show".

## Every control, with its verdict

Frequency is a judgement of how often someone reaches for the control, not a measurement.

### In the door today

| Control | What it does | Reached for | Verdict | Reason |
|---|---|---|---|---|
| `🍫` / `❌` door | Opens the menu inline over the first row | every menu use | keep | The one fixed corner; glyph set by `globals.menuGlyph` |
| `⎘ id` | Copies the session id | occasionally | move → session | An action on this session, not a setting |
| `↗ proj` | Opens the project dir in VS Code | occasionally | move → session | As above |
| `↗ log` | Opens the transcript in VS Code | rarely | move → session | As above |
| `↗ repo` | Opens the repo's web page; absent for a local-only repo | occasionally | move → session | As above |
| `☐ persist?` | Chooses whether each click writes the session or the config file | every setting change | cut | Replaced by Save (bwi.hpi) |
| `(?)` beside persist | Explains persist? | once | cut | Goes with persist? |
| `▦ <preset> ▸` + ring + layout preview | Switches arrangement | often | move → layout | What the bar shows |
| `↺` on every control | Removes that key from the config file | rarely | keep, shown only when drifted | Becomes nk8's marker; wt5 widens it to the bundled default |
| `⚙ config ▸` | Opens the display settings | often | cut | Dissolved into the three setting tabs |
| `🧰 tools ▸` | Opens a body holding `🩺 doctor` | rarely | cut | A disclosure around one button costs a click and a row |
| `✎ edit` / `✎ done` | Enters or leaves edit mode | occasionally | rename `✎ arrange` → layout | Matches the arrange/configure split in brandon-segment-settings-i4n.g64 |

### Behind `⚙ config` and `🧰 tools` today

| Control | What it does | Reached for | Verdict | Reason |
|---|---|---|---|---|
| `🎨 theme` + ring + theme preview | Picks the palette | often | move → appearance | Colour |
| `◐ look` + ring + theme preview | Applies a theme adaptation (dim, vivid, inverted…) | sometimes | move → appearance | Colour |
| `✦ style` | Powerline, capsule or plain joins | sometimes | move → appearance | Shape |
| `🎼 progression` + layout preview | Which role each row wears | rarely | move → appearance | Colour |
| `🔣 charset` | Unicode or ASCII glyphs | once per terminal | move → terminal | A fact about the terminal |
| `🌈 colour depth` | truecolor, 256, ansi, none | once per terminal | move → terminal | A fact about the terminal |
| `wrap: on/off` | Auto-wrap a row at the width | when the bar does not fit | move → layout | Fit, adjusted beside the preset |
| `◀ padding ▶` | Spaces inside each cell | when the bar does not fit | move → layout | Fit; moving it also keeps appearance under 80 |
| `🩺 doctor` + check rows + `[fix]` | Runs the checks; its one check is tmux truecolor | rarely | move → terminal | Its only check is a colour-depth question |

### Edit mode

| Control | What it does | Verdict | Reason |
|---|---|---|---|
| `+` | Add menu: every declared, unplaced segment, as bare names | keep, becomes the library | brandon-menu-ia-q30.kpl adds descriptions and groups |
| `-` | Removes a placement | keep | |
| `↺ <preset> customized` | Deletes the file's root for this preset | keep | The only way back from a structural edit until global undo lands |
| `☐ live` | Swaps segment names for their live output | keep | |
| `(?)` | Explains `+` and `-` | keep | |

### On the bar itself

| Control | Where | Verdict | Reason |
|---|---|---|---|
| `toolbar` segment | Opt-in, not in the default rows | keep | The session tray's links for someone who wants them one click away |
| `themeSwitcher` segment `◀ theme ▶` | Opt-in | keep | Same, for the theme |
| `gitPr` link | Opt-in (`verbose` preset) | keep | |
| `copyDir` action | Declared in the bundled `actions`, clicked by nothing | place it on `directory` (addition 8) | Dead today |
| Carousel `✕` rows | Every open ring | keep | |

Not placed anywhere: the `globals` fields with no menu control today — `menuGlyph`, `updateNotice`, `default_separator`, `default_empty_value`, `default_truncate_marker`, `default_bg`, `default_fg`. `updateNotice` already has `[disable]` on the notice itself. `default_bg` and `default_fg` are read by nothing (brandon-config-349). When brandon-settings-coverage-g4p.zoj generates controls from the schema, each generated control lands in the tab of its intent, and its inventory decides which fields stay config-only.

## Additions, ranked

Ranked by how much each changes what a person can do from the bar. Filed tickets keep their ids; the three new ones are marked.

1. **Save, undo, redo, reset all** (brandon-save-undo-bwi.hpi, .jby, .wt5): the trailing `💾 3 ↶ ↷ ⟲` cell. Without it, a click in this menu can be neither reviewed nor taken back.
2. **Drift marker** (brandon-menu-ia-q30.nk8): `↺` on a control that differs from its default, and `•` on its tab. This shows someone where their bar has drifted, and the marker is also the reset.
3. **Tabs** (brandon-menu-tabs-wnu.qqz): the four tabs are one accordion key, and each body is a disclosure body led by `✕`, so closing a tab returns to the bare tab row. No new node kind.
4. **Command buttons** (brandon-context-ceiling-xta.qhj): `/compact /clear /model` on the session tab's second row. These are the commands people type most, one click from where they are already looking.
5. **Save as preset** (brandon-save-undo-bwi.o6u): `+ preset` on the layout tab, beside the preset ring it adds to.
6. **`⎘ resume`** (new): copies `claude --resume <session id>`. Resuming this session in another terminal is the most common reason to copy the id at all, and this saves typing the rest of the command.
7. **`↗ config`** (new): opens the config file the bar renders from, the same file a Save writes (`durableConfigPath`, `src/config/loader/discovery.ts`). Today the only path from the bar to that file is the error strip's link. After a Save, someone wants to see what was written.
8. **Directory click copies the full path** (new): the fish-abbreviated `~/c/c/src` hides the path it names, and clicking the text you just read is where you would look for it. It uses the `copyDir` action the bundled default already declares.
9. **Autocompact control** (brandon-context-ceiling-xta.e3p): the session tab's second row.
10. **Segment library** (brandon-menu-ia-q30.kpl): edit mode's `+`, reached through `✎ arrange`.
11. **Generated controls for globals** (brandon-settings-coverage-g4p.zoj): each lands in the tab of its intent, per the paragraph above the rankings.

## Placed outside the menu

These belong on the bar or in edit mode, and the map places them so that they don't compete with the tabs:

- Context ceiling widget (brandon-context-ceiling-xta.asv): a segment beside `context`, added from the library.
- Lit widget (brandon-lit-widget-3xo.btb): a segment, added from the library.
- Git expand/collapse (brandon-git-segment-ixf.tl0): the segment's own arrow.
- Configure mode (brandon-segment-settings-i4n.g64): a `⚙` beside each cell in arrange mode.
- More presets (brandon-presets-a3i.rcx): new members of the preset ring, with nothing to place.
- Custom theme builder (brandon-settings-panel-0ky, parked): a body under `🎨 appearance` when it is unparked.

## Tickets this map files once approved

- Move every kept control to its tab and delete `⚙ config` and `🧰 tools`, on the tab strip brandon-menu-tabs-wnu.qqz builds.
- `✎ edit` renamed `✎ arrange`.
- `⎘ resume` and `↗ config` in the session tray.
- Directory click copies the full path.

The Save, undo, reset, drift-marker, command-button and save-as-preset tickets already exist, and each takes its placement from this map.
