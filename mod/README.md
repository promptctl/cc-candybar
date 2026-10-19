# candybar-band

A Claude Code mod (2.1.299's function-hooks API) that draws the session's
candybar in the band above the prompt, menus included, at the frame rate the
daemon pushes (up to 30 a second while the bar moves) instead of the
statusline's one. Every `cc-candybar://` link is an OSC 8 span, so a click
reaches the daemon as a statusline click does.

Run it from a built checkout (`pnpm build`); the mod starts
`node <checkout>/dist/index.mjs frames --lane band --session <id> --format band`, the
checkout it sits in:

```sh
claude --plugin-dir <checkout>/mod
```

`frames --session` subscribes to the daemon's frames for the session, drawn
from the data its own statusline client sends, and `--format band` writes each
as one JSON line of styled runs (`mod/types/index.d.ts`); the mod draws them as
`Text` runs and `Link`s. The band shows nothing until the session's statusline
has rendered once, and nothing while lane A's toggle is off: turn on
`🧪 band (A)` in the settings menu's `⚙ config` tab (a draft until `💾 save`),
or set `globals.experimentalBand: true` in the config file.

What it cannot do yet:

- Width. The bar is rendered at the statusline's width, the terminal's, so it
  is three cells wider than the band and its last cells are cut.
- `classic.SessionStart` hooks are passed over for a mod a person installs,
  and so is every classic hook where an organization manages Claude Code.
- Each session holds one `frames` child (~100 MB RSS).
