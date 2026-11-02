# Clicks

Status: design, nothing built.

## Owns

How a click travels from a surface to the renderer that drew it: the link form in [../contracts.md](../contracts.md), the minter, the URL handler, and routing in Gather. What a click does on arrival belongs to [events.md](events.md).

## Why

A link says what to do and for which session, but never who drew it. A click belongs to the renderer whose frame was clicked. A renderer's name in the link is what routes it, so Gather needs to know nothing about verbs or sessions.

This also works after a session moves to another renderer, and for links with no session, such as `copy` and `open-vscode`.

## Design

### The route

```
OSC 8 link → macOS → handler app → url-handle ─┐
tmux status range → click binding ─────────────┴→ Gather's socket
                     ↓
Gather finds the renderer among attached connections
                     ↓
renderer's event queue
```

Gather writes the click down that renderer's connection. A link routes by name and a tmux range by attach id. One with no live connection is refused.

### The handler changes

Clients keep the default socket, which is the main renderer's, so the Rust hot path doesn't change. The handler has to reach Gather instead, at a new fixed path. That's a real change to `url-handle` and the staged handler, and it ships through reinstall.

The URL needs no handler change to pass through: `open` on a `to/…` link reached the live daemon as verb `to`, unchanged. Parsing it is the change. `parseHandlerUrl` returns a typed address, and `statusLineClick`, `isBarLink` and `follow()` in `scripts/bar-web/index.html` update to match.

**Failure.** A refused click is invisible today: the daemon logged `unknown click verb: to`, and no window appeared. That's a `[LAW:no-silent-failure]` gap regardless of this work.

- Gather refused it: the link's session names a bar, so the refusal raises that session's `⚠`, on whichever renderer still follows it. This is the one place Gather reads past the name, which sits against routing that knows no sessions. Not settled: the alternative is that the handler reports every refusal itself, as a notification.
- Nothing answered: there's no bar to report on, so the handler shows a macOS notification itself. `do shell script` has no display path, so this changes `appleScriptSource`.

### One minter

`effectsUrl` is bound to the renderer. Everything that makes a `cc-candybar://` link goes through it:

| Link | Now |
|---|---|
| Actions, menus, pickers, carousels, close fragments | Already through it |
| Diagnostics, repo questions, update notices, handoff | Built with only a session id today, so each gets the minter. They live in the renderer |
| Config-authored | A template function mints in the renderer. `{{ link }}` with a literal `cc-candybar://` is refused at load |
| Doctor probes | Use the minter, so they also test the route through Gather |
| Install test URL | Removed |
| tmux `CLICK_URL` | Stays one fixed binding per tmux server. It isn't a drawn link: tmux sends a range, and the link it resolves to came from the minter |

The `{{ link }}` refusal makes `examples/demo-actions.json5` migrate, along with anything else writing literal links.

### One grammar

Removal candidates, since each leaves one URL form: direct verb URLs and bare `cc-candybar://<value>` copy, which `wire.ts` keeps for old scrollback. Removing them refuses those old links.

### tmux

The status row carries ranges, because a click there sends only a range name, and the link stays in the renderer that drew it. The binding is shared by every session on the tmux server, so the range id itself says which renderer drew the frame: see tmux status ranges in [../contracts.md](../contracts.md). That names the frame clicked, where a session option written by the current holder could name a newer renderer than the one on screen. Gather reads the attach id from the range, and the renderer runs `linkAt` on the rest. A status-line click carries a third URL form through the same route, so `parseHandlerUrl`'s address type covers it.

A click on an old frame either finds the same link or finds nothing. It can't reach a different link. After a restart it's refused until the next frame redraws the row.

**Why not `#[link=…]`.** tmux 3.8 draws real OSC 8 from a status format through this style. Raw OSC 8 or DCS passthrough in a format didn't work on 3.7b, where tmux dropped the ESC bytes. Tested on 3.8: a link of 256 bytes or more is dropped silently while its text still draws (250 worked), `,` and `]` break the style, and `%` must be doubled. Drawn links already reach 278 bytes, and human-readable links won't get shorter. Shortening links for this would give up human-readable links. Whether a plain click opens such a link with tmux `mouse on` was never tested.

The status row has no hover. tmux turns mouse moves into a key only over a pane, so nothing can restyle a range under the pointer. Hover belongs to the bar pane, whose program can request motion events.

### Signing

Links are signed with the renderer's own key, and verified by the renderer that drew them. The name isn't signed, and doesn't need to be.

The full survey is in [../inventory/frames.md](../inventory/frames.md), Task C.

## Evidence

`probes/p7.mts`: two isolated daemons, one dialled out to the other, 30 clicks.

| Claim | Result |
|---|---|
| A click reaches another process through the stable one | All delivered; applied in 0.5 ms median, 9.2 ms max |
| It stays there | Target went 2 → 4 rows and persisted its pick; the other's bar was byte-identical, with no pick |
| A missing target is loud | `renderer dev is not attached`; the router kept serving |

Limits: this used a whole daemon behind a bridge script, and the timing excludes the handler app's launch.

## To probe

- **Notification from the applet.** Whether it needs a permission grant, and whether it appears at all.
- **Handler update path.** How a staged handler is replaced on upgrade, and what a click does between a new Gather and an old handler.
- **Range id characters.** `range=user|…` has only carried hex here. Base 36 needs a check; hex still works, with counters that run out sooner.
- **Link session at routing time.** Whether `clickSessionOf` works on an addressed link, for raising a refusal on its bar.

## Done when

A click on a worktree renderer's link, through the installed handler, changes only that renderer. A click on a dead renderer's link shows on a bar, and one with Gather stopped shows a notification.
