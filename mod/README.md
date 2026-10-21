# candybar-band

A Claude Code mod (2.1.299's function-hooks API) that draws the session's
candybar in the band above the prompt, menus included, at the frame rate the
daemon pushes (up to 30 a second while the bar moves) instead of the
statusline's one. Every `cc-candybar://` link is an OSC 8 span, so a click
reaches the daemon as a statusline click does.

Run it from a checkout built (`pnpm build`, which the daemon runs from) with the
native client staged (`just install-rust`); the
mod starts `<checkout>/bin/cc-candybar-native follow --lane band --session <id>`,
the checkout it sits in. Turning on `🧪 band (A)` installs it: the daemon adds
the checkout as a plugin marketplace (`.claude-plugin/marketplace.json` names
the mod `candybar-band`), installs `candybar-band@cc-candybar` — read in
place from `<checkout>/mod`, never copied — and types `/reload-plugins` into
the session. By hand, for one session:

```sh
claude --plugin-dir <checkout>/mod
```

`follow` subscribes to the daemon's frames for the session, drawn from the
data its own statusline client sends, and writes each message the daemon sends
as one JSON line (`mod/types/index.d.ts`): the daemon encodes the band's frames
as rows of styled runs, which the mod draws as `Text` runs and `Link`s. The
child relays them, at about 2 MB RSS. The band shows nothing until the session's
statusline has rendered once, and nothing while lane A's toggle is off: turn on
`🧪 band (A)` in the settings menu's `⚙ config › 🧪 toggles` (a draft until `💾 save`),
or set `globals.experimentalBand: true` in the config file. A line the band
cannot draw — the daemon from a different build than the mod — is said above
the band.

What it cannot do yet:

- Width. The bar is rendered at the statusline's width, the terminal's, so it
  is three cells wider than the band and its last cells are cut.
- `classic.SessionStart` hooks are passed over for a mod a person installs,
  and so is every classic hook where an organization manages Claude Code.
