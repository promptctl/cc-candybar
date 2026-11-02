# tmux events

Status: design, nothing built. Tickets: `candybar-tmux-events-y457`.

## Owns

How candybar learns what tmux is showing, without asking on a timer: the control connection, the facts it produces, what the bar pane does while hidden, and the off-screen rate.

## Why

Two polls run today. The daemon asks every tmux server once a second, and each bar pane asks every 500 ms. A switched-to window waits up to that long for its first frame, and each ask spawns tmux, which costs about 20 ms on macOS.

tmux already knows when these things change, and a control-mode client is told.

## Design

### What the polls do today

Deleting a poll means every job it does has a new home.

| Job | Done today by | Moves to |
|---|---|---|
| Which panes are shown | Daemon poll, bar pane poll | Control connection |
| What each status row shows | Daemon poll | Control connection |
| Whether the bar pane is shown | Bar pane poll | Pushed over its feed |
| Which session the pane holds, which is how the bar pane follows `/clear` | Bar pane poll | Pushed over its feed |
| Whether the Claude Code pane has closed | Bar pane poll | Pushed over its feed |
| Whether the bar pane is zoomed, so a resize doesn't unzoom it | Bar pane poll | See [Zoom](#zoom) |

### One connection per tmux server

The connection uses `tmux-control-mode-js`. It exists for the same span the daemon's poll does: from the first feed opening on a server to the last closing. The socket comes from the client's `tmux` hint, as it does today, because the daemon's own environment says nothing about a session.

Visibility is a fact about tmux, so the connection belongs to Gather, which pushes the result to renderers. Until Gather exists it lives in today's daemon. Nothing here waits for the split.

### An event means "something changed"

A tmux notification triggers one re-read of panes and clients, sent over the connection and coalesced with any other in flight. The answer goes through the existing pure rule in `src/daemon/pane-visibility.ts`.

Events are never folded into state. A fold would be a second copy of tmux's rules that can drift, and each notification's payload would need its own handling. With a re-read there's one rule, and a missed detail in a payload can't matter.

### Losing the connection

A lost connection is what a failed ask is today: the server's panes count as shown, which costs frames and never freezes a bar. The next request naming that socket opens a new connection, and connecting is one more trigger for the same re-read. So there's no retry timer and no recovery path of its own.

A session that sends no requests stays at the moving rate until one arrives.

### The control client is a real client

- **It counts.** It raises `session_attached` on its session, and the visibility rule treats a control client as showing every window of that session. Both must exclude candybar's own client, or every window of that session reads as shown.
- **It needs a session.** It attaches to one that already exists. Creating a session of its own would keep the tmux server alive after the user's last session closes, and would show up in their session list.
- **Its session can end, or something can detach it.** Both are a lost connection.
- **Attaching fires the user's hooks,** by how hooks work. Observing this is listed under To probe.

### The hidden bar pane

Hidden, the bar pane stays subscribed. Handoff needs a subscriber, so dropping the subscription hands the bar back to Claude Code's statusline, and returning flashes it. A hidden pane draws at the off-screen rate.

### The off-screen rate

Off-screen becomes its own feed period of 5 s, on every surface. Today one period does two jobs: the off-screen rate and the longest gap for a visible bar, which is what refreshes an age or a clock. They separate, and the visible gap stays at 1 s.

A pane turning visible draws at once, because a period this long would otherwise show a frame up to 5 s old.

The rate readout rounds, so 0.2 fps shows as 0. That's a display issue and doesn't affect the rate.

### Zoom

Zoom is a separate concern. Its one use is the resize guard: a resize of a zoomed pane unzooms it. That guard must not be lost when the bar pane's poll goes, so its replacement lands first.

Until then a pane hidden by a zoomed neighbour counts as shown and keeps the full rate. That costs frames only.

### Events control mode doesn't deliver

Some of tmux's events never reach a control client, or reach it only for its own session. Zoom in another session is one. `tmux-control-mode-js` is taking this on as a general capability, covering every such event tmux has. candybar's own connection doesn't depend on it.

## Evidence

Run on tmux 3.7b, on isolated sockets. Scripts: `probes/p9.mjs`, `probes/p10.mjs`.

| Claim | Check | Result |
|---|---|---|
| Changes in another session are heard | Control client on A, changes in B | `%session-window-changed`, `%window-pane-changed`, `%client-session-changed` on attach and switch, `%client-detached` |
| Zoom in another session isn't heard | Same client, zoom and unzoom in B | Nothing |
| A control client counts as attached | `list-sessions`, `list-clients` | `attached=1`, `control=1` |
| A global hook can reach a control client | `set-hook -g window-zoomed` running `display-message -c <client>` | `%message` with the session, window and flag |
| A leftover hook is harmless | Same hook, client gone | Zoom still worked |

Limits: one tmux version. `refresh-client -B` subscriptions aren't used, because they're scoped to the attached session and tmux checks them on a 1 s timer.

## To probe

Without a poll, an event that doesn't arrive leaves visibility stale until the next one, so this list is what stands between the design and 100%.

- **Coverage.** Whether every change to the shown set produces a notification: `break-pane`, `join-pane`, `move-window`, `link-window`, pane and window close, grouped sessions.
- **The attach.** Whether connecting fires `client-attached` hooks, and which attach flags stop the client affecting window sizes or receiving pane output.
- **The library per server.** Its README describes one connection per session. Check it serves a whole server.
- **tmux versions.** The library needs 3.2 or later. Check what candybar supports and what happens below that.

## Done when

A window switched to shows its first frame with no timer involved, no tmux process is spawned on a schedule, `/clear` and a closed pane reach the bar pane, and returning to a hidden bar pane doesn't flash Claude Code's statusline.
