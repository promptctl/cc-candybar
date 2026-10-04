# Proposal: pickers replace the carousel

Brandon's proposal, 2026-09-29, recorded as he wrote it. Read against `design-docs/UI-ELEMENTS.md` on 2026-10-04.

## Decision (2026-10-04, brandon-menu-ia-q30.jl1)

- **General picker: adopted** for every option-valued setting in the settings menu and in configure mode. The control is `label ◀ value ▶`: the arrows apply the previous and next value, and clicking the value opens state 3, a plain list of every choice under the row, paged to the width and closed by one `✕`. State 1 and state 2 are one line: the tab or configure body the control sits in is already the closed state, so a further click to reach the arrows would only add one. The field is named by the setting's label beside the arrows.
- **"Each theme name has the same colour and background as the rest of the UI": adopted.** In a list, every option shares one background. A theme or style name is written in that theme's colour, which stands in for the swatch until the swatch exists.
- **Theme picker: next.** The swatch, the two-row demo, `(random)`, swatch-only paging and folding style and variation into it are brandon-theme-swatch-8v9r. The carousel survives only as the `◀ value ▶` stepper and the opt-in `themeSwitcher` segment.

The carousel goes. "I don't like the carousel. it takes too much space and a carousel only works if you can keep it in one spot when items move. Let's transition from it to other types of pickers."

There are two pickers: a general-purpose one, and one for themes.

## General-purpose picker

A UI element for selecting a single value from multiple possible values. Preset is the example. It has three states.

**State 1: closed**

```
[Preset]
```

- Visible: the name of the field. "we currently don't have this and it SUCKS. super annoying"
- Interaction: clicking the picker opens it to state 2.

**State 2: open**

```
< CurrentPresetName >
```

- Visible: the current value.
- Interaction: clicking the name of the current preset expands to state 3. Clicking the arrows cycles to the next or previous value.

**State 3: expanded**

```
< CurrentPresetName >
X [Preset1] [Preset2] [Preset3] [Preset4] ...
```

- Visible: similar to state 2, except that the colour changes to show a menu is attached, and a menu below shows every item.
- Later, an item such as `[Preset1]` could carry buttons of its own. "for now let's go with this."

## Theme picker

Similar to the general picker, but designed to show the theme itself in a way that is usable and consistent. Below, `[=]` stands for a theme swatch. Its design comes later, "but something like '  ' w/ colors intended to demonstrate the theme".

**Everywhere the bar shows a theme name, it shows the theme's swatch beside it. The name loses its styling and the swatch carries the colour.** "this will vastly improve UX and looks."

**State 1: closed**

```
[Theme [=]] [⚙️]
```

- The label literally says `Theme`, and the swatch matches the current theme.
- Clicking it opens state 2.
- Clicking the gear opens the theme configuration menu, which is a separate menu.

**State 2: open**

```
[Done] [CurrentTheme [=]] [⚙️]
< ? > << [=] *[=]* [=] [=] [=] >>
[theme demo line 1]
[theme demo line 2]
```

Parentheses mark clickable buttons:

1. (prev) (random) (next) (prev page) (theme before the selected one) [selected theme] (selected + 1) (selected + 2) … (next page)
2. The selected theme's demo, line 1.
3. The selected theme's demo, line 2.

The currently selected theme is marked in some way. The menu contains swatches only: "We should spend some time designing these swatches."

This picker replaces every other theme picker.

Critical requirements:

- Each theme name has the same colour and background as the rest of the UI, unlike today.
- Each theme name has a theme swatch to show its colours instead.
- The theme picker has a two-row theme preview, so users can get a good look before choosing.

The theme configuration moves into the theme picker too: "bright/dim, etc, and the primary/secondary, etc", which today are the style and variation settings.
