# Settings menu map

The settings menu's structure, for brandon-menu-ia-q30.1ws. Implementation tickets are filed from this map once Brandon confirms it. Quotes are Brandon's words from the review on 2026-09-28.

## Structure

The menu opens above the bar and leaves the bar as it was: "Opening the candy menu (the top level menu) should show the menus ABOVE the existing bar rather than replacing it." Today the menu takes over the door's row.

The menu is two lines, then the body of the open tab. The first line holds the preset control and, when there is something to save or step, the save cell. The second holds the five tabs. One tab is open at a time.

```
✕  ▦ default ▸  💾 save 3 ↶ ↷ ⟲
✕  ⚡ session  🎨 look  📐 layout  ⚙ config  🧰 tools
✕  …the open tab's body…
❌  host  directory  gitaculous          ← the bar, unchanged
```

Every body placement today drops below its trigger or takes over its row (`placement: "drop" | "inline"`, `src/config/disclosure.ts`). Opening above is a third placement.

- **Preset** is top-level: "preset is top-level". It opens the preset menu with its layout preview below.
- **Tabs** stay as listed until Brandon changes them: "Keep them all until I tell you otherwise."
- **Save, undo, redo, reset all** follow the preset as one cell, `💾 save 3 ↶ ↷ ⟲`, shown only when there is something to save or step (brandon-save-undo-bwi.hpi, .jby, .wt5).

| Tab | Holds |
|---|---|
| `⚡ session` | `⎘ id`, `⎘ resume` (new), `↗ proj`, `↗ log`, `↗ repo`, `↗ config` (new, shown only when a config file exists); a second row of `/compact /clear /model` (xta.qhj) and the autocompact control (xta.e3p) |
| `🎨 look` | Four selectors: theme, style, variation, endcaps (below) |
| `📐 layout` | `+ preset` (bwi.o6u), `✎ arrange` (today's `✎ edit`, see Edit mode), `wrap: on/off`, `◀ padding ▶`. "this is just temporary until we figure out what to do it with"; padding "is probably also useless" |
| `⚙ config` | "all config options": the controls generated from the config schema (brandon-settings-coverage-g4p.zoj) |
| `🧰 tools` | `🩺 doctor` and its check rows (below) |

`📐` replaces `▦` on the layout tab because `▦` is the preset control's glyph.

## Edit mode

Today, clicking `✎ edit` closes the menu and leaves the bar in edit mode with no way out in sight. The only exit is to reopen the menu and click `✎ done`.

In edit mode, a row above the bar holds the way out, top left: "move the 'done' button to the upper left … ideally as a 'Save' and 'Cancel' type situation that lets users either persist or discard changes they made here."

```
✓ save 2  ↩ cancel  ↺ reset layout
🍫 | ⊕ | host ⊖ | ⊕ | directory ⊖ | ⊕ | gitaculous ⊖ | ⊕
```

- **Save** writes the layout changes to the config file and leaves edit mode. With no changes it reads `✓ done`, and cancel is hidden.
- **Cancel** discards the changes and leaves edit mode.
- **Layout changes become drafts.** Today each `+`/`-` click writes the config file at once. For cancel to discard anything, layout changes have to be session drafts, the same model brandon-save-undo-bwi.hpi gives settings.
- **`↺ reset layout`** is today's `↺ default customized`, renamed. It shows only when the config file has its own layout for the active preset, and clicking it restores the bundled layout. The old label didn't say that.

### Add and remove

Today each segment's `-` shares a cell with the next `+`, one joiner away from the segment it removes:

```
🍫  |  +  |  host  |  - +  |  directory  |  - +  |  gitaculous  |  - +
```

The remove button goes inside its segment's cell. Each add button is a cell of its own between segments. Brandon: "use symbols that are more clear what they're for and some colors that make it more obvious (maybe solid red for the 'remove' action) and blue or green for 'add'. Please do not use a background on the add/remove characters, just style the text itself."

- Remove is `⊖` in red. Add is `⊕` in green.
- The colour is the glyph's text colour only. `⊖` sits on its segment's own background. `⊕` gets no fill: it's drawn on the terminal's own background. Today every cell gets a background (`resolveSegmentColors`), so a cell with no fill is new.
- The row has as many cells and as much text as today's, so it measures the same: 72 cells at 80 columns.

## The look tab

```
look
◀ tokyo-night ▶  ◀ none ▶  ◀ accent ▶  ◀ powerline ▶
```

Each selector is one widget with two click regions. The arrows select the previous or next value, as the `themeSwitcher` segment does today. The name opens a menu. The selectors carry no label or glyph: "we won't actually see that in the menu".

The menu a name opens is "a regular menu, no carousel": the full row of choices. Each choice shows its effect in its text colour only: "Only the foreground should be in the themes colors, it looks like shit when the backgrounds are drawn differently, very messy." Every choice sits on the same menu background. That reverses what brandon-picker-31z shipped, where each theme option is drawn on its own theme's background.

## Renames

Every rename covers the label, the config key, the session key and the `.effective` variable: "Yes all renamed". There are no other users, so no compatibility shim. An old config that uses a key whose meaning moved has to fail with an error naming the new key, because `style` changes meaning and would otherwise load silently as the wrong setting.

| Today | Becomes |
|---|---|
| theme | theme |
| look (none, vivid, muted, dim, bright, inverted) | style |
| progression | variation |
| style (powerline, capsule, plain) | endcaps |

## Variation values

Brandon asked for four variations in brandon-theme-picker-bgw.7g6: "allow choosing between B, C, D, and current as 4 variants". Only three shipped.

| Name | Was | Rows wear |
|---|---|---|
| `accent` (default) | B, `secondary-accent` | secondary, accent |
| `duo` | current, `primary-secondary` | primary, secondary |
| `mono` | D, `primary` | primary |
| `alt` | C, not shipped | see below |

The variants page (`.git/8fp-decoration-variants.html`) describes C as "base changes per cell, hue changes every few cells". 7g6 dropped it, because a variation can only choose a hue per row, and with the hue per row C came out identical to current. To ship `alt`, the hue has to be able to change partway along a row, which today's colour model can't do. Two constraints sit beside this:

- Brandon rejected a hue change on every cell (8fp: neighbours alternating hue read as sports-team colours). C changes hue every few cells, not every cell.
- A variation can list at most two row steps today, because the row hue is chosen by binning each row's van der Corput placement (`Progression`, `src/themes/decor.ts`). A variation with three or more row steps would need rows to be chosen sequentially first.

## Removed from the menu

Charset and colour depth go: "you can just remove 'charset' and 'colordepth' completely. make users set them in the config file." Both stay as `globals` fields and lose their session halves and menu controls. `☐ persist?` and its `(?)` go too, replaced by Save.

## Doctor checks

Today the doctor has one check, tmux truecolor. "doctor has nothing to do with compatibility. we just haven't added any additional checks to it yet."

From Brandon:

- **Config is correct.** "no inconsistencies, no unused variables or actions or whatever". It loads with no warnings. No duplicate keys, no `.json`/`.json5` collision, no config file shadowed behind another in the search order. Nothing the user declared goes unused: no variable nothing reads, no action nothing clicks, no helper nothing calls, no user segment absent from every preset. Threshold knobs ascend.
- **URL handler works.** It is registered for `cc-candybar://`, the staged `url-handler.mjs` exists and matches the running version, and a probe URL opened by the daemon arrives back.
- **Nerd Font is set up and in use.** A terminal can't be asked for its font (unverified; this is my understanding). The check reads the font from the terminal's config file (kitty, WezTerm, Ghostty, Alacritty, iTerm) and falls back to a row of test glyphs the user marks ✓ or ✗.
- **Links are available and clickable.** The terminal supports OSC 8 links, and inside tmux, tmux passes them through.
- **Other terminal features work.** Truecolor (the existing check), a UTF-8 locale, and the client reporting its width.

Added by me, at Brandon's request to fill out the list:

- **Install is current.** The statusline command in `~/.claude/settings.json` points at the staged runtime, which exists and is executable. Its version matches the daemon's. It is the native client, not the Node fallback.
- **Daemon is healthy.** Exactly one daemon is running. Memory is well under the 512 MB limit. There are no crash reports since the last check.
- **Segments have their data.** `gitPr` is placed and `gh`/`glab` is installed and logged in. `block`/`weekly` are placed and the hook payload carries `rate_limits`. The ceiling widget is placed and memento is installed.
- **Session data is readable.** The transcript can be read.

## Widths at 80 columns

`pnpm exec tsx design-docs/settings-menu-map-render.mts` prints every number here. It renders today's menu through `renderDsl` and measures the proposed rows with a model that reproduces today's two widest rows exactly (103 and 150 cells). Widths are at padding 1, and each padding step adds two cells per cell.

| Row | Cells |
|---|---|
| Door line 1: preset / with save cell / with reset confirm | 20 / 38 / 49 |
| Door line 2: tabs / two tabs marked `•` | 62 / 66 |
| `⚡ session` links / commands | 50 / 52 |
| `🎨 look` / long names / all four drifted | 63 / 73 / 77 |
| `📐 layout` | 55 |
| `🧰 tools` | 17 |
| Edit mode's save row | 40 |

## Also recorded

- The drift marker is the reset. `↺` appears on a control only when it has a session draft or a config-file value, which are what the reset clears. A value the active preset pins shows none, since a reset could not move it. This narrows brandon-menu-ia-q30.nk8, which counts preset-set values as drift.
- `default_truncate_marker` is read by nothing, like `default_bg` and `default_fg` (brandon-config-349): `applySegmentLayout` defaults the marker to `…` (`src/template-engine/layout.ts:156`) and nothing passes the global to it.
- The bundled `copyDir` action is declared and clicked by nothing. Proposal: clicking `directory` copies the full path, which the fish-abbreviated text hides.
- Placed outside the menu: the context ceiling widget (xta.asv) and the lit widget (3xo.btb) are segments added from edit mode's library. Git expand (ixf.tl0) is the segment's own arrow. Configure mode (i4n.g64) is a `⚙` beside each cell while arranging.
