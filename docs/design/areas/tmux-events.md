# tmux events

The daemon's observer reads the panes and clients of a server when tmux reports a change. The socket in a session's client hint selects the server. Interested consumers of the same server share its observation. A server that disappears supplies a reason and unknown visibility. Its panes count as shown until another request can establish a fresh observation.

## Reading the server

An unattended guardian runs ordinary tmux command clients. It uses an existing server, adds no session or attachment, requests no pane output and has no window reservation lease. A private Unix socket ties it to the host. Host death closes that socket, so the surviving guardian can release its registrations. The host can perform the same release if the guardian dies, including before the first snapshot. A simultaneous uncatchable termination of both processes can leave their entries on the live server.

The guardian discovers available hooks and existing local overrides on the addressed server. It adds sparse integer entries with tmux's set-if-absent operation. A new local override or an edit to the observed hooks causes rediscovery. Global, session, window and pane scopes retain their own inheritance. During release, one tmux command checks that an entry still holds this observer's exact command before removing it. A user's replacement survives release. Every mutation is bound to the server generation. The floating window separately owns its named-event guardian and the authority to release its inset reservation.

One clean-to-dirty transition signals a private classic wait channel. Repeated changes share the pending wake. A single tmux command queue clears the dirty bit and reads server identity, all pane memberships, attached clients and the ending server identity. A changed hook table during that work obliges another pass. A result dirtied during the read is discarded before publication. While clean, one unattached command blocks in wait-for. No scheduled metadata request runs. Output is bounded by the same launcher as other tmux commands. Server failure, rejected metadata commands and waiter death end this observation.

Each pane row carries its session, attachment count, current-window flag, zoom, active pane, effective mouse option, process ID and tty. Linked windows and grouped sessions can produce several rows for the same physical pane. Each client reports its session and control-mode flag. A real third-party control client contributes to visibility. A gone server and an existing detached server produce distinct results.

## Compatibility evidence

The packaged adapter was exercised on private tmux 3.7b and 3.8a servers. Both support the classic wait channel, numeric hook arrays and format-expanded native commands used here. The 3.8 named wait and client-closed hook used by the floating window are absent on 3.7b. A global pane-exited hook wakes a quiet source exit on 3.7b. External zoom through resize-pane wakes via after-resize-pane there. Both versions expose the changed mouse option to after-set-option.

The process contract in test/daemon-boots/process/tmux-server-observer.test.ts covers the following observations.

- Two consumers' independently owned adapters can coexist and release only their own entries. A new local override remains effective for its user and is discovered while observation is live.
- A quiet source exits, selection and zoom change in a separate session, and break, join, link, unlink and move change the observed session memberships. Ordinary terminal attachment and a separate control client's attachment and detachment preserve their true client flags.
- Changing visibility while a completed server read is withheld discards that old result. A private producer writes 3,000 terminal lines while the observer sees only metadata; a later event verifies it is still receiving changes.
- The observer starts no tmux commands across multiple former polling intervals. Killing the host, the guardian during initial installation, or the blocked waiter leaves the server's user hooks and attachments intact. A new server at the same socket starts a new observation.

## Pane delivery

tmux supplies physical placement, visibility and loss. Claude's own process record supplies the session after a genuine /clear. A pane surface keeps its subscriber while hidden so returning to its window can deliver a frame without a full Claude Code statusline flash. A resize must recheck zoom at the effect. Numeric off-screen cadence and floating-window reservation cleanup retain their own owners.
