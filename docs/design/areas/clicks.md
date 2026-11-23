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
OSC 8 link → macOS → handler app (raw link) ───┐
url-handle, run by hand ───────────────────────┴→ Gather's socket
                     ↓
Gather finds the renderer among attached connections
                     ↓
renderer's event queue
```

Gather writes the click down that renderer's connection. A link routes by name. One with no live connection is refused.

### The handler changes

Clients keep the default socket, which is the main renderer's, so the Rust hot path doesn't change. The handler app knows only the socket path and one frame, so moving it to Gather's path is a change to that one path, and it ships through reinstall.

The URL needs no handler change to pass through: `open` on a `to/…` link reached the live daemon as verb `to`, unchanged. Parsing it is the change. `parseHandlerUrl` returns a typed address, and `statusLineClick`, `isBarLink` and `follow()` in `scripts/bar-web/index.html` update to match.

**Failure.** A refused click is invisible today: the daemon logged `unknown click verb: to`, and no window appeared. That's a `[LAW:no-silent-failure]` gap regardless of this work.

- Gather refused it: the link's session names a bar, so the refusal raises that session's `⚠`, on whichever renderer still follows it. This is the one place Gather reads past the name, which sits against routing that knows no sessions. Not settled: the alternative is that the handler reports every refusal itself, as a notification.
- Nothing answered: there's no bar to report on, so the handler shows a macOS notification itself. `do shell script` has no display path, so this changes `appleScriptSource`.

### One minter

`effectsUrl` is bound to the renderer. Everything that makes a `cc-candybar://` link goes through it:

| Link | Now |
|---|---|
| Actions, menus, pickers, carousels, close fragments | Already through it |
| Diagnostics, repo questions, handoff | Built with only a session id today, so each gets the minter. They live in the renderer |
| Config-authored | A template function mints in the renderer. `{{ link }}` with a literal `cc-candybar://` is refused at load |
| Doctor probes | Use the minter, so they also test the route through Gather |
| Install test URL | Removed |

The `{{ link }}` refusal makes `examples/demo-actions.json5` migrate, along with anything else writing literal links.

### One grammar

Removal candidates, since each leaves one URL form: direct verb URLs and bare `cc-candybar://<value>` copy, which `wire.ts` keeps for old scrollback. Removing them refuses those old links.

### tmux

The tmux status row carries no ranges, and nothing writes a click binding for it; the daemon removes the binding an older version wrote (`src/daemon/retired-tmux-status.ts`). A drawn link reaches the daemon through the handler app, or by hand through `url-handle`.

### Signing

The host signs each bar link over its whole text and opens each click before a renderer sees it (`src/click/link-signer.ts`).

The full survey is in [../inventory/frames.md](../inventory/frames.md).

## Evidence

`probes/p7.mts`: two isolated daemons, one dialled out to the other, 30 clicks.

| Claim | Result |
|---|---|
| A click reaches another process through the stable one | All delivered; applied in 0.5 ms median, 9.2 ms max |
| It stays there | Target went 2 → 4 rows and persisted its pick; the other's bar was byte-identical, with no pick |
| A missing target is loud | `renderer dev is not attached`; the router kept serving |

Limits: this used a whole daemon behind a bridge script, and the timing excludes the handler app's launch.

## To probe

- **Notification from the handler app.** Whether it needs a permission grant, and whether it appears at all.
- **Handler update path.** How a staged handler is replaced on upgrade, and what a click does between a new Gather and an old handler.
- **Link session at routing time.** Whether `clickSessionOf` works on an addressed link, for raising a refusal on its bar.

## Done when

A click on a worktree renderer's link, through the installed handler, changes only that renderer. A click on a dead renderer's link shows on a bar, and one with Gather stopped shows a notification.

## Pane acts

The host serializes slash input and bar-pane reconciliation by tmux socket and pane ID. Both check shutdown when they reach the head of that queue. An act refused there never reads or changes the pane.
