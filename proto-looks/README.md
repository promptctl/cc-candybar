# Accent looks (brandon-menus-sjhy.4fi)

`accent-looks.html`: the bundled bar under 12 themes, closed and with its menus
open, across the candidate jumps, keystones and open-menu colours, beside the
bar as it ships. Every candidate is a row of `SHADES` or `VARIATIONS` in
`src/themes/decor.ts` (named `<keystone>-<open>`; the same rows the settings
menu marks 🧪 in the `🎼` and `🔆` lists), rendered through the bar's own
path under session picks; `axes.mjs` labels the rows the page compares and
names its themes.

Rebuild from the repo root:

    node --require ./scripts/version-stamp.cjs --import tsx proto-looks/render.ts
    node proto-looks/build.mjs

`out/` and the HTML are generated and not committed. `fonts.json` is a
113-glyph subset of JetBrainsMono Nerd Font Mono (SIL OFL 1.1), embedded so
the page draws the bar's glyphs on any machine.
