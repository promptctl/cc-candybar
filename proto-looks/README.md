# Accent looks (brandon-menus-sjhy.4fi)

`accent-looks.html`: the bundled bar under 12 themes, closed and with its menus
open, across the candidate jumps, keystones and open-menu colours, beside the
bar as it ships. Every candidate is a row of `SHADES` or `VARIATIONS` in
`src/themes/decor.ts` (named `<keystone>-<open>`; the same rows the settings
menu offers under the theme's ⚙ › 🧪 trials), rendered through the bar's own
path under session picks; `axes.mjs` names the rows the page compares.

Rebuild from the repo root:

    R="node --require ./scripts/version-stamp.cjs --import tsx proto-looks/render.ts"
    V=$(node -e 'const K=["door","start","end","ends"],O=["primary","secondary","alternate"];console.log(K.flatMap(k=>O.map(o=>`${k}-${o}`)).join(","))')
    $R --out proto-looks/out/new.json --variations "$V" --shades middle,wide,widest,pair,pair-wide
    $R --out proto-looks/out/today.json --variations accent --shades middle
    node proto-looks/build.mjs

`out/` and the HTML are generated and not committed.
