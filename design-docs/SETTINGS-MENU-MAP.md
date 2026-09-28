# Settings menu map

Proposal for brandon-menu-ia-q30.1ws. Nothing here is built yet; the implementation tickets are filed from this map once it is approved.

## The recommendation

Open the door onto one row of four tabs, one for each thing a person opens the menu to do: `⚡ session` to act on this session, `🎨 appearance` to change the colours and shape, `▦ layout` to change what the bar shows and how it fits, and `🧩 compat` to match what the terminal can draw. One tab is open at a time. Save, undo, redo and reset-all share one cell at the end of that row, and it appears only when there is something to save or step.

The rows this replaces were grouped by frequency: the first row held whatever people click most, and everything else went behind `⚙ config`. That puts charset and colour depth, which a person sets once per terminal, beside the theme, which they try a dozen times. It also puts wrap and padding, which they adjust when the bar does not fit, one disclosure away from the preset switcher they reach for at the same moment. Grouping by intent fixes both. The person opening the menu already knows which of the four they want, so the first click picks the tab and the second does the thing.

It also makes the menu shorter. With the theme picker open, today's menu takes 7 lines above the status row at 80 columns, and the proposed one takes 4.

What goes, in one line each:

- `☐ persist?` and its `(?)` go, replaced by the Save button (brandon-save-undo-bwi.hpi).
- `⚙ config ▸` goes, and its eight controls are dealt out to the three setting tabs.
- `🧰 tools ▸` goes. It is a disclosure holding one button, and that button (`🩺 doctor`) checks tmux truecolor, a colour-depth question, so it moves to `🧩 compat`.
- The `↺` beside every control goes until there is something for it to reset (see "The drift marker is the reset").

## How it renders

`pnpm exec tsx design-docs/settings-menu-map-render.mts` reproduces every width here. It renders today's menu through `renderDsl` with each disclosure open, at 80 and 200 columns, in the default and compact presets. It measures the proposed rows with a model: each cell is its text plus two padding cells plus one seam, plus one cap per row. The model reproduces today's two widest rows exactly (103 and 150 cells, rendered and modelled).

Widths are at padding 1, the bundled default's. Each padding step adds two cells per cell, and the script prints that growth per row. At padding 2 the appearance row is 85 cells and wraps at 80. The `compact` preset runs at padding 0, so its rows are narrower than every number below. Powerline arrows are drawn as spaces.

### Today, at 80 columns

The bundled default with the theme picker open:

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

### Proposed: the tab row

The first open shows the tabs and nothing else. After that, the door reopens on the tab that was open last, because the open tab is one session key.

```
❌  ⚡ session  🎨 appearance  ▦ layout  🧩 compat                     58
```

With unsaved drafts, history to step, and settings off their defaults, the tab row grows a trailing cell. It trails so that the tabs never move when it appears, for the same reason `activity` trails the status row:

```
❌  ⚡ session  🎨 appearance •  ▦ layout •  🧩 compat  💾 save 3 ↶ ↷ ⟲   80
```

`💾 save 3` writes three drafts, labelled as bwi.hpi specifies. `↶ ↷` show only while the history has a step in that direction. `⟲` resets every menu setting, and a first click turns it into `⟲ reset all?`, which a second click confirms. A `•` on a tab means something inside it can be reset. This row is exactly 80 cells with two tabs marked. A third `•`, or the reset confirm (91 cells), wraps it at 80. The alternative was dropping the word "save" from the button, and wrapping in that rare state costs less.

`🧩 compat` replaces the name you rejected for the old drawer. The tab holds charset, colour depth and the doctor, which are the settings a person changes to make the bar compatible with the terminal it is drawn in. `🧩` is a default-emoji glyph, so every terminal draws it two cells wide, as `cellLen` counts it. `🖥` has text presentation by default, and emoji fonts draw it wider than rich-js measures.

### `⚡ session`

```
✕  ⎘ id ⎘ resume ↗ proj ↗ log ↗ repo ↗ config                         50
✕  /compact  /clear  /model  ⏲ autocompact ▸                          52
```

The first row is today's quick-action tray plus `⎘ resume` and `↗ config` (additions 6 and 7). The second row arrives with brandon-context-ceiling-xta.qhj and .e3p. `/clear` asks for a second click as `/clear?` (53 cells). The autocompact control's label is e3p's to choose, and the one here is a stand-in of plausible size. Nothing in this tab is a setting, so it never carries `•`.

### `🎨 appearance`

```
✕  🎨 tokyo-night ▸  ◐ none ▸  🎼 secondary-accent ▸  ✦ powerline ▸   75
```

Each control opens today's ring below the row, unchanged. Measured at 80:

```
✕  textual-dark textual-light ◀ tokyo-night ▶ dark light              61   theme
✕   ~/code  main  opus  42%  5m  $1.20   ▾ open  menu   warn  error   73   └ preview
✕  bright inverted ◀ none ▶ vivid muted                               44   look
✕   ~/code  main  opus  42%  5m  $1.20   ▾ open  menu   warn  error   73   └ preview
✕  plain ◀ powerline ▶ capsule                                        35   style
✕  primary ◀ secondary-accent ▶ primary-secondary                     54   progression
✕   menu  host  directory  gitaculous                                 43   └ preview
✕   model  context  cacheTimer  block  weekly                         51
```

With four settings drifted to long names, the control row is 92 cells and wraps once at 80:

```
✕  🎨 catppuccin-frappe ▸ ↺  ◐ inverted ▸ ↺  🎼 primary-secondary ▸ ↺  ✦ capsule ▸ ↺
```

I left that wrap in place. It is this tab's worst case with bundled names, not its usual state, and the fixes available (dropping `▸` from picker controls, or splitting colour from shape across two tabs) cost more than one extra line.

### `▦ layout`

```
✕  ▦ default ▸  + preset  ✎ arrange  wrap: on  ◀ padding 1 ▶          69
✕  verbose ◀ default ▶ compact                                        35   preset
✕   menu  host  directory  gitaculous                                 43   └ preview
✕   model  context  cacheTimer  block  weekly                         51
```

With preset, wrap and padding all picked this session, the row reads `▦ verbose ▸ ↺  + preset  ✎ arrange  wrap: off ↺  ◀ padding 0 ▶ ↺`: 76 cells at padding 1, and 64 at the padding 0 it shows. `✎ arrange` is today's `✎ edit`: it enters edit mode and closes the menu in one click (`settings.edit`, `settings-menu.ts:602`). Edit mode itself doesn't change, and it renders as today, three lines at 80 (72, 74 and 64 cells).

### `🧩 compat`

```
✕  🔣 unicode  🌈 truecolor ▸  🩺 doctor                               47
✕  ✗ tmux truecolor — <reason> [fix]
```

`🔣` becomes a two-state toggle like `wrap`. Today it is a ring, and a two-member ring shows no neighbour, so it renders `✕  ◀ unicode ▶` and `ascii` never appears on screen. The colour-depth ring stays (`✕  none ◀ truecolor ▶ 256`, 30 cells). The check rows appear under the controls once `🩺 doctor` has run, as they do under `🧰 tools` today.

## The drift marker is the reset

nk8 asks for a marker on every control whose value differs from the bundled default, and wt5 asks for a per-setting reset. The map makes them one glyph, but only where the reset can act. `↺` appears when the setting has a session draft or a config-file value, which are the two things wt5's reset clears, and clicking it clears them. A value that the active preset pins shows no `↺`. The preset is where that value comes from, the preset control is where it is changed, and a reset could not move it: the `compact` preset's `padding: 0` survives any reset of the `padding` key. This narrows nk8, which counts preset-set values as drift. The narrowing is deliberate, because a marker that offers a reset that does nothing is worse than no marker.

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
| `↺` on every control | Removes that key from the config file | rarely | keep, shown only when it can act | See "The drift marker is the reset" |
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
| `🔣 charset` | Unicode or ASCII glyphs | once per terminal | move → compat, ring becomes toggle | Its ring hides its only alternative |
| `🌈 colour depth` | truecolor, 256, ansi, none | once per terminal | move → compat | A fact about the terminal |
| `wrap: on/off` | Auto-wrap a row at the width | when the bar does not fit | move → layout | Fit, adjusted beside the preset |
| `◀ padding ▶` | Spaces inside each cell | when the bar does not fit | move → layout | Fit; moving it also keeps appearance under 80 at padding 1 |
| `🩺 doctor` + check rows + `[fix]` | Runs the checks; its one check is tmux truecolor | rarely | move → compat | Its only check is a colour-depth question |

### Edit mode

| Control | What it does | Verdict | Reason |
|---|---|---|---|
| `+` | Add menu: every declared, unplaced segment, as bare names | keep, becomes the library | brandon-menu-ia-q30.kpl adds descriptions and groups |
| `-` | Removes a placement | keep | |
| `↺ <preset> customized` | Deletes the file's root for this preset | keep | The only way back from a structural edit on the bar until global undo lands |
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

Not placed anywhere: the `globals` fields with no menu control today — `menuGlyph`, `updateNotice`, `default_separator`, `default_empty_value`, `default_truncate_marker`, `default_bg`, `default_fg`. `updateNotice` already has `[disable]` on the notice itself. `default_bg` and `default_fg` are read by nothing (brandon-config-349), and neither is `default_truncate_marker`: `applySegmentLayout` defaults the marker to `…` (`src/template-engine/layout.ts:156`) and nothing passes the global to it. When brandon-settings-coverage-g4p.zoj generates controls from the schema, each generated control lands in the tab of its intent, and its inventory decides which fields stay config-only.

## Additions, ranked

Ranked by how much each changes what a person can do from the bar. Filed tickets keep their ids; the three new ones are marked.

1. **Save, undo, redo, reset all** (brandon-save-undo-bwi.hpi, .jby, .wt5): the trailing `💾 save 3 ↶ ↷ ⟲` cell. Without it, a click in this menu can be neither reviewed nor taken back.
2. **Drift marker** (brandon-menu-ia-q30.nk8): `↺` where a reset can act, and `•` on its tab, as set out above. It shows someone where their bar has drifted, one click from undoing it.
3. **Tabs** (brandon-menu-tabs-wnu.qqz): the four tabs are one accordion key, and each body is a disclosure body led by `✕`, so closing a tab returns to the bare tab row. No new node kind.
4. **Command buttons** (brandon-context-ceiling-xta.qhj): `/compact /clear /model` on the session tab's second row. These are the commands people type most, one click from where they are already looking.
5. **Save as preset** (brandon-save-undo-bwi.o6u): `+ preset` on the layout tab, beside the preset ring it adds to.
6. **`⎘ resume`** (new): copies `claude --resume <session id>`. Resuming this session in another terminal is the most common reason to copy the id at all, and this saves typing the rest of the command.
7. **`↗ config`** (new): opens the config file the bar renders from, and shows only when that file exists. A user with no config file renders the bundled default and has nothing to open, and the first Save creates the file. Today the only path from the bar to the file is the error strip's link. After a Save, someone wants to see what was written.
8. **Directory click copies the full path** (new): the fish-abbreviated `~/c/c/src` hides the path it names, and clicking the text you just read is where you would look for it. It uses the `copyDir` action the bundled default already declares.
9. **Autocompact control** (brandon-context-ceiling-xta.e3p): the session tab's second row.
10. **Segment library** (brandon-menu-ia-q30.kpl): edit mode's `+`, reached through `✎ arrange`.
11. **Generated controls for globals** (brandon-settings-coverage-g4p.zoj): each lands in the tab of its intent.

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
- `🔣 charset` becomes a toggle.
- `⎘ resume` and `↗ config` in the session tray.
- Directory click copies the full path.
- `default_truncate_marker` joins brandon-config-349 (a global read by nothing).

The Save, undo, reset, drift-marker, command-button and save-as-preset tickets already exist. Each takes its placement from this map, and nk8 takes its narrowed marker too.
