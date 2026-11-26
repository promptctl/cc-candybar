# Settings menu map

The settings menu's structure, for brandon-menu-ia-q30.1ws. Quotes are Brandon's words from his review on 2026-09-28. The implementation tickets are listed under Tickets at the end.

## Structure

The menu opens above the bar and leaves the bar as it was: "Opening the candy menu (the top level menu) should show the menus ABOVE the existing bar rather than replacing it."

The door opens two lines above the bar. Each tab opens its body directly below its own line. Both lines share one accordion, so selecting a second tab closes the first one and its nested pickers.

```
✖  ◁  🎨 look  📚 saves & presets  ✎ arrange
   ⚡ session  ⚙ config
host  directory  gitaculous
```

The save cell follows arrange. It shows `💾 save` and a count for pending drafts, undo and redo for available history, and `⟲` when resetting would change a draft or a saved setting. A fresh session with customized settings can show `⟲` alone.

| Tab | Controls in display order |
|---|---|
| 🎨 look | Theme picker, theme gear and endcaps on the first row. Effect and animation speed on the second row. Fade in/out on the third row. The gear expands below the first row with style, variation and shade. |
| 📚 saves & presets | Preset picker and `+ preset`. The picker previews the selected layout and offers delete for a user-created preset. |
| ⚡ session | Session ID and resume links, project, log, repository and config links where available, followed by the session commands available in the current host. |
| ⚙ config | Wrap, padding, 📺 renderer and menu timeout. Renderer opens the lane switches. Each has its own help and shows its feed activity when enabled. Save the switches to apply them to fresh sessions. |

The settings declaration assigns each control its place and row. CLI help and lane refusal messages use the same map. See the [interaction authoring reference](../docs/interaction-authoring.md).

## Edit mode

brandon-edit-mode-8ps (#251) put `✎ done` on a row of its own above the bar, drew each remove button inside its segment's cell, and gave each add button a cell of its own. What is left is save and cancel, and the glyphs and colours below. Brandon: "move the 'done' button to the upper left … ideally as a 'Save' and 'Cancel' type situation that lets users either persist or discard changes they made here."

```
✓ save  ↩ cancel  ↺ reset layout  ☐ live
🍫 | ✚ | ✖ host🔧 | ✚ | ✖ directory🔧 | ✚ | ✖ gitaculous🔧 | ✚
```

- **Save** commits the previewed settings and layout as one change, then leaves edit mode. With nothing to keep it reads `✓ done`, and cancel is hidden.
- **Cancel** discards the draft and leaves edit mode.
- **Undo and redo** step through the draft while editing. Other sessions see the committed config until Save succeeds.
- **`☐ live`** is on this row now, not at the end of the bar's last row. It is an edit-mode control like the other three.
- **`↺ reset layout`** is today's `↺ default customized`, renamed. It shows only when the config file has its own layout for the active preset, and clicking it restores the bundled layout. The old label didn't say that.

### Add and remove

Now:

```
🍫  |  ✚  |  ✖ host🔧  |  ✚  |  ✖ directory🔧  |  ✚  |  ✖ gitaculous🔧  |  ✚
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

The theme label opens the swatch row with previous, random, next and page controls. The active theme is bracketed, and two preview rows show it in use. The gear opens a separate row for style, variation and shade. Arrows step each selector, and the label opens its list.

```
🎨 theme ▀▀▀  ⚙  ◀ ✦ endcaps ▶
   ◀ ◐ style ▀▀▀ ▶  ◀ 🎼 variation ▶  ◀ 🔆 shade ▶
◀ ✨ effect ▶  ◀ speed ▶
☐ fade in/out
```

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

C, from the 8fp variants page, is "base changes per cell, hue changes every few cells". A variation carries a `run`: how many cells along a row wear one hue. The first three keep one hue per row; `alt` turns every three cells, and each row starts on its own step (the settings door counts as the first row's first cell). The hue never changes at every cell — a run is at least two cells by type: 8fp rejected neighbours alternating hue as sports-team colours.

## Removed from the menu

Charset and colour depth go: "you can just remove 'charset' and 'colordepth' completely. make users set them in the config file." Both stay as `globals` fields and lose their session halves and menu controls: their `SETTINGS` rows move to `UNCONTROLLED_GLOBALS`, or the generator puts them back. `☐ persist?` is already gone: Save replaced it in #256.

The original design recorded the measured terminal widths of its menu rows. [Historical width measurements](https://github.com/promptctl/cc-candybar/blob/2ea914d28b9d385ad72a58229f4e9d4ddb9aeff8/design-docs/SETTINGS-MENU-MAP.md#widths-at-80-columns)

## Also recorded

- The drift marker is the reset. `↺` appears on a control only when it has a session draft or a config-file value, which are what the reset clears. A value the active preset pins shows none, since a reset could not move it. This narrows brandon-menu-ia-q30.nk8, which counts preset-set values as drift.
- Clicking `directory` copies the full path, which the fish-abbreviated text hides, through the bundled `copyDir` action.
- Placed outside the menu: the lit widget (3xo.btb) is a segment added from edit mode's library. Git expand (ixf.tl0) is the segment's own arrow. Configure mode (i4n.g64) is a `🔧` beside each cell while arranging.

## Tickets

Under epic brandon-menu-ia-q30 unless noted, in this order:

1. **The menu opens above the bar.** A disclosure placement beside `drop`, replacing the row takeover (`inline`), and the door's two lines (preset and save cell, then tabs).
2. **Tabs** (brandon-menu-tabs-wnu.qqz, already filed): the tab strip is an accordion's triggers, each body holds what the Structure table lists, and `PLACE` names each setting's tab.
3. **Renames:** look → style, progression → variation, style → endcaps, and the variation values accent / duo / mono. Label, config key, session key and `.effective` variable, with the refusals Renames describes.
4. **The look tab:** four `◀ name ▶` selectors. The name opens a plain menu whose choices show their effect in text colour on one shared background.
5. **Charset and colour depth leave the menu** and lose their session halves; their `SETTINGS` rows move to `UNCONTROLLED_GLOBALS`.
6. **Session tab additions:** `⎘ resume` and `↗ config`.
7. **Edit mode save and cancel:** cancel discards the draft, `↺ reset layout` is renamed, and `☐ live` moves onto the save row.
8. **Edit mode glyphs:** `✖` in red and `✚` in green, text colour only, with `✚` drawn on no fill.
9. **The `alt` variation:** the hue changes every few cells partway along a row, which today's colour model cannot express.
10. **Clicking `directory` copies the full path.** The click is the bundled `copyDir` action, which nothing clicked before.

brandon-menu-ia-q30.nk8 narrows to the reset-only marker described under Also recorded. brandon-menu-ia-q30.kpl is unchanged.
