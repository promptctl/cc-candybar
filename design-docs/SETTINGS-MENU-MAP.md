# Settings menu map

The settings menu's structure, for brandon-menu-ia-q30.1ws. Quotes are Brandon's words from his review on 2026-09-28. The implementation tickets are listed under Tickets at the end.

## Structure

The menu opens above the bar and leaves the bar as it was: "Opening the candy menu (the top level menu) should show the menus ABOVE the existing bar rather than replacing it."

The menu is two lines, then the body of the open tab. The first line holds the preset control and, when there is something to save or step, the save cell. The second holds the five tabs. One tab is open at a time.

```
✖  ◁  ▦ default ▸  💾 save 3 ↶ ↷ ⟲
   ⚡ session  🎨 look  📐 layout  ⚙ config  🧰 tools
✕  …the open tab's body…
host  directory  gitaculous             ← the bar, less the door
```

A body drops below its trigger or rises above the whole bar (`placement: "drop" | "above"`, `src/config/disclosure.ts`); opening above replaced the menu's old takeover of the door's row. An `above` body's trigger rises with it: the door, wearing ✖, leads the menu's first line, followed by `◁` back, and the bar row closes up where it was.

- **Preset** is top-level: "preset is top-level". It opens the preset menu with its layout preview below.
- **Tabs** stay as listed until Brandon changes them: "Keep them all until I tell you otherwise."
- **Save, undo, redo, reset all** follow the preset as one cell, `💾 save 3 ↶ ↷ ⟲`. Each part shows on its own condition, as today: save when there are drafts, undo and redo when there is history, `⟲` when a reset would change something (a draft or a config-file value). A fresh session over a customized config file shows `⟲` alone (brandon-save-undo-bwi.hpi, .jby, .wt5).

| Tab | Holds |
|---|---|
| `⚡ session` | `⎘ id`, `⎘ resume`, `↗ proj`, `↗ log`, `↗ repo`, `↗ config` (shown only when a config file exists); a second row of `/compact /clear /model` (xta.qhj) and the autocompact control (xta.e3p) |
| `🎨 look` | Four selectors: theme, style, variation, endcaps (below) |
| `📐 layout` | `+ preset` (bwi.o6u), `✎ arrange` (today's `✎ edit`, see Edit mode), `wrap: on/off`, `◀ padding ▶`. "this is just temporary until we figure out what to do it with"; padding "is probably also useless" |
| `⚙ config` | "all config options": the controls generated from the config schema (brandon-settings-coverage-g4p.zoj) that no other tab holds. `PLACE` in `settings-menu.ts` names each setting's tab, keyed by every `SETTINGS` row, so a control lands in exactly one |
| `🧰 tools` | `🩺 doctor` and its check rows (below) |

`📐` replaces `▦` on the layout tab because `▦` is the preset control's glyph.

## Edit mode

brandon-edit-mode-8ps (#251) put `✎ done` on a row of its own above the bar, drew each remove button inside its segment's cell, and gave each add button a cell of its own. What is left is save and cancel, and the glyphs and colours below. Brandon: "move the 'done' button to the upper left … ideally as a 'Save' and 'Cancel' type situation that lets users either persist or discard changes they made here."

```
✓ save  ↩ cancel  ↺ reset layout  ☐ live
🍫 | ✚ | host ⚙✖ | ✚ | directory ⚙✖ | ✚ | gitaculous ⚙✖ | ✚
```

- **Save** writes the session's unsaved settings (a placement's configure-mode values among them; layout changes are already written) and leaves edit mode. With nothing to keep it reads `✓ done`, and cancel is hidden.
- **Cancel** discards the changes and leaves edit mode.
- **Layout changes are not drafts.** Each `+`/`-` click writes the config file at once and is one step of the session's undo history. Opening edit mode takes a savepoint recording what each target it goes on to change held then, and cancel puts those values back in one step, so there is no second copy of the layout: a per-session unsaved layout would need a compiled tree per session, and the render cache holds one per `(projectDir, cwd)`.
- **`☐ live`** is on this row now, not at the end of the bar's last row. It is an edit-mode control like the other three.
- **`↺ reset layout`** is today's `↺ default customized`, renamed. It shows only when the config file has its own layout for the active preset, and clicking it restores the bundled layout. The old label didn't say that.

### Add and remove

Now:

```
🍫  |  ✚  |  ✖ host⚙️  |  ✚  |  ✖ directory⚙️  |  ✚  |  ✖ gitaculous⚙️  |  ✚
```

The positions are what Brandon asked for. The glyphs and colours are not: "use symbols that are more clear what they're for and some colors that make it more obvious (maybe solid red for the 'remove' action) and blue or green for 'add'. Please do not use a background on the add/remove characters, just style the text itself."

- Remove is `✖` in red. Add is `✚` in green.
- The colour is the glyph's text colour only. `✖` sits on its segment's own background. `✚` gets no fill: it's drawn on the terminal's own background. A cell with no fill is `bg: "none"` (`NO_FILL`, `resolveSegmentColors`); every other cell still gets a background.
- The row keeps today's cells, at today's widths.

### The add menu is a library

The `✚` opens a library of the declared segments (brandon-menu-ia-q30.kpl), not a grid of bare names: one page per group (`location`, `git`, `model & context`, `cost & limits`, `activity`, `session tools`, then `other` for any segment that declares none), turned with `←`/`→`, and one row per segment, its name and its description cut to the row. The group is the segment's own `group:`, so a segment from any config appears with no wiring. A rendered sample of each segment was decided against: it would evaluate every segment's templates outside any placement.

```
✕ ← git 2/6 →
gitaculous  The git state: a summary (branch, ahead/behind, S/U/? flags) that the arrow at…
gitPr       The pull request open for this branch, as a link; `⚠ PR` when the forge lookup fai…
```

## The look tab

```
look
◀ tokyo-night ▶  ◀ none ▶  ◀ accent ▶  ◀ powerline ▶
```

Each selector is one widget with two click regions. The arrows select the previous or next value, as the `themeSwitcher` segment does today. The name opens a menu. The selectors carry no label or glyph: "we won't actually see that in the menu".

The menu a name opens is "a regular menu, no carousel": the full row of choices. Each choice shows its effect in its text colour only: "Only the foreground should be in the themes colors, it looks like shit when the backgrounds are drawn differently, very messy." Every choice sits on the same menu background. That reverses what brandon-picker-31z shipped, where each theme option is drawn on its own theme's background.

## Renames

Every rename covers the label, the config key, the session key and the `.effective` variable: "Yes all renamed". There are no other users, so no compatibility shim. `look` and `progression` are retired keys, refused with an error naming `style` and `variation`. `style` is still a key, so the rule for it is on the value: a look may not be named `powerline`, `capsule` or `plain`, and a `style` holding one of those fails with an error naming `endcaps`. A session pick of an endcap name under `style` names no look and falls through to the config, as any unknown pick does.

| Today | Becomes |
|---|---|
| theme | theme |
| look (none, vivid, muted, dim, bright, inverted) | style |
| progression | variation |
| style (powerline, capsule, plain) | endcaps |

## Variation values

Brandon asked for four variations in brandon-theme-picker-bgw.7g6: "allow choosing between B, C, D, and current as 4 variants".

| Name | Was | Rows wear |
|---|---|---|
| `accent` (default) | B, `secondary-accent` | secondary, accent |
| `duo` | current, `primary-secondary` | primary, secondary |
| `mono` | D, `primary` | primary |
| `alt` | C | secondary, accent, turning every three cells along the row |

C, from the 8fp variants page, is "base changes per cell, hue changes every few cells". A variation carries a `run`: how many cells along a row wear one hue. The first three keep one hue per row; `alt` turns after one cell per tone, and each row starts on its own step. The hue never changes at every cell: 8fp rejected neighbours alternating hue as sports-team colours.

## Removed from the menu

Charset and colour depth go: "you can just remove 'charset' and 'colordepth' completely. make users set them in the config file." Both stay as `globals` fields and lose their session halves and menu controls: their `SETTINGS` rows move to `UNCONTROLLED_GLOBALS`, or the generator puts them back. `☐ persist?` is already gone: Save replaced it in #256.

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

`pnpm exec tsx design-docs/settings-menu-map-render.mts` prints every number here. It renders today's menu through `renderDsl` and measures the proposed rows with a model that reproduces today's two widest rows exactly (139 and 182 cells, at 200 columns); the script fails if it stops. Widths are at padding 1, and each padding step adds two cells per cell.

| Row | Cells |
|---|---|
| Door line 1: preset / with save cell / with reset confirm | 19 / 37 / 48 |
| Door line 2: tabs (the open one led by `▾`) / two tabs marked `•` | 64 / 68 |
| `⚡ session` links / commands | 50 / 52 |
| `🎨 look` / long names / all four drifted | 63 / 73 / 77 |
| `📐 layout` | 55 |
| `🧰 tools` | 17 |
| Edit mode's save row | 49 |

## Also recorded

- The drift marker is the reset. `↺` appears on a control only when it has a session draft or a config-file value, which are what the reset clears. A value the active preset pins shows none, since a reset could not move it. This narrows brandon-menu-ia-q30.nk8, which counts preset-set values as drift.
- The bundled `copyDir` action is declared and clicked by nothing. Proposal: clicking `directory` copies the full path, which the fish-abbreviated text hides.
- Placed outside the menu: the context ceiling widget (xta.asv) and the lit widget (3xo.btb) are segments added from edit mode's library. Git expand (ixf.tl0) is the segment's own arrow. Configure mode (i4n.g64) is a `⚙` beside each cell while arranging.

## Tickets

Under epic brandon-menu-ia-q30 unless noted, in this order:

1. **The menu opens above the bar.** A disclosure placement beside `drop`, replacing the row takeover (`inline`), and the door's two lines (preset and save cell, then tabs).
2. **Five tabs** (brandon-menu-tabs-wnu.qqz, already filed): the tab strip is an accordion's triggers, each body holds what the Structure table lists, and `PLACE` names each setting's tab.
3. **Renames:** look → style, progression → variation, style → endcaps, and the variation values accent / duo / mono. Label, config key, session key and `.effective` variable, with the refusals Renames describes.
4. **The look tab:** four `◀ name ▶` selectors. The name opens a plain menu whose choices show their effect in text colour on one shared background.
5. **Charset and colour depth leave the menu** and lose their session halves; their `SETTINGS` rows move to `UNCONTROLLED_GLOBALS`.
6. **Session tab additions:** `⎘ resume` and `↗ config`.
7. **Edit mode save and cancel:** cancel puts back what a savepoint taken when edit mode opens recorded, `↺ reset layout` is renamed, and `☐ live` moves onto the save row.
8. **Edit mode glyphs:** `✖` in red and `✚` in green, text colour only, with `✚` drawn on no fill.
9. **The `alt` variation:** the hue changes every few cells partway along a row, which today's colour model cannot express.
10. **Doctor checks**, one per bullet in Doctor checks, under their own epic.
11. **Clicking `directory` copies the full path.** This replaces the unused `copyDir` action.

brandon-menu-ia-q30.nk8 narrows to the reset-only marker described under Also recorded. brandon-menu-ia-q30.kpl is unchanged.
