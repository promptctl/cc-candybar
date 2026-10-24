# Accent looks (brandon-menus-sjhy.4fi)

`accent-looks.html`: the bundled bar under 12 themes, closed and with its menus
open, across the candidate jumps, keystones and open-menu colours — beside the
bar as it ships today. Every candidate is a row of `SHADES` or `VARIATIONS` in
`src/themes/decor.ts` on this branch (named `<keystone>-<open>`), rendered
through the bar's own path under session picks; `axes.mjs` names the rows the
page compares.

Rebuild from this worktree's root. The today strip renders from a checkout of
the pristine commit (c51bf9e3) with this folder's `render.ts` copied beside its
`src/`:

    V=$(node -e 'const K=["door","start","end","ends"],O=["primary","secondary","alternate"];console.log(K.flatMap(k=>O.map(o=>`${k}-${o}`)).join(","))')
    node --require ./scripts/version-stamp.cjs --import tsx proto-looks/render.ts \
      --out proto-looks/out/new.json --variations "$V" --shades middle,wide,widest,pair,pair-wide
    (cd <pristine checkout> && node --require ./scripts/version-stamp.cjs --import tsx proto-render.ts \
      --out <this folder>/out/today.json --variations accent --shades middle)
    node proto-looks/build.mjs

`out/` and the HTML are generated and not committed.
