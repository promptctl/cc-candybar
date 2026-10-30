# Architecture: client, daemon, wire

## Two processes, one renderer

Claude Code spawns the client on every statusline tick. The client connects to the daemon's unix socket, sends the hook JSON and prints the answer. The daemon is the only renderer. The client has no render path of its own, on purpose: a second renderer is a second source of truth, and it drifts. [LAW:one-source-of-truth]

The shipped client is native (Rust) and handles only the render hot path. It hands every other subcommand to the Node entry. On a daemon miss it spawns a detached daemon and prints an empty line, so the next refresh finds the daemon running.

A one-shot Node subcommand folds its outcome into a plan (what goes to each stream, the exit code) and ends through one delivery that waits for both streams' write callbacks before exiting. A piped stdout flushes asynchronously on macOS, so an exit right after the write drops everything past the first 64 KiB the pipe buffered, and the loss is invisible on Linux, where pipes are synchronous. [LAW:single-enforcer]

## The wire is spelled twice

The protocol lives in TypeScript and is copied into the Rust client as literal constants: version, frame cap and header, timeouts, error codes, diagnostic styling, and the code points the sanitizer neutralizes. The protocol check compares every copied constant across the two runtimes, and a missing anchor counts as drift. Change a mirrored constant in both runtimes in one commit. When you add a mirrored constant, add a row to the check. The same check also covers the hint code both runtimes share, the vendored launcher's statusline push, and which subcommands only the native client knows.

## The daemon is detached: session facts come from the client

The daemon's environment belongs to whichever shell happened to spawn it, so the daemon never reads its own env for anything about a session. That covers the config path, Claude Code's config directory, the tmux pane and the terminal. The client inherits Claude Code's exact environment, so it observes those facts and sends them as hints on every render request. A click carries no hints, so it works from the hints recorded at the session's last render.

The temptation: the daemon's `process.env` has `CLAUDE_CONFIG_DIR` right there, and reading it works on your machine. But it answers for whichever session spawned the daemon and is wrong for every other session.

A hint has three wire states: absent (a client too old to report it), null (it doesn't apply, e.g. not in tmux), and a value. Keep the three apart. If absent collapses into null, an old client's silence reads as a fact.

The client makes a relative path in a hint absolute against its own cwd. The daemon accepts only absolute paths.

## Identity and lifetime

There is one daemon per user, guarded by a pid file in the state directory. The socket path comes from the UID under /tmp, not from the state directory, so overriding XDG_STATE_HOME does not isolate the socket. A separate env override isolates it for tests and dev.

Restarts are normal, and every cache rebuilds cold. There is no idle or age shutdown, because either one would interrupt an active session. The only hard limit is the memory backstop (daemon-memory.md). The daemon also ends itself when the bundle it runs from changes or disappears, so a rebuild takes effect without a manual restart.

A child the daemon launches dies with the daemon, however the daemon ends. A SIGKILL runs no cleanup in the dying process, so the end comes from a second process, the lifeline, which reads a pipe only the launcher holds and, at EOF, signals every child group still in flight. The daemon's own update is the one exception: it rewrites the bundle, and killing it would leave the bundle half-written, so it outlives the daemon. A restart for a changed bundle waits while the update runs, so the next daemon never boots from a half-written bundle and the update's verdict reaches the bar.

The update notice compares two content digests of the source tree: one baked into the bundle at build time and one recomputed from the tree beside it. It uses digests rather than mtimes because a branch switch rewrites mtimes on unchanged bytes. A published install has no source tree beside it, so it polls the registry instead and never shows a source warning.

## Logs and stats

Every render request writes exactly one render event, and every click request one click event. Fields are added stage by stage as the request goes through, so an absent field means the request stopped before that stage, and `-` means none. A session id is recorded only once it passes the session-id checkpoint, and a click's verb only once the daemon knows it, because nothing an untrusted request says is recorded as fact: a refused request's own words appear only in its problems. Any value a client could shape into something that parses as several fields (a session id, for example) is written as a JSON string. When a change introduces a new fact, put it on that event or on its source's refresh event. Counters go in the stats snapshot.

Each source logs its own failures, once per refresh, and the payload logs none of them, so each failure appears once. Every source records its refreshes in one ledger, which is what the stats and a feed's summary read. A refresh a request triggered writes no line of its own: it is a fact of that request's render event, because a line per source per request would rotate the log every few minutes.

The log never writes on the event loop. A synchronous write held every waiting client past its budget whenever the disk was slow, and each client that gave up was one more line. Lines still waiting when the process exits are written synchronously, so the death line lands. Anything reading the log, tests included, waits for the lines it expects rather than reading once.

Nothing watches the state directory itself, because the log writes there on every request and on macOS every write to a watched directory is a file event the OS has to deliver. A file the daemon must see edited (the repository answers, which a user may edit by hand) gets a folder of its own under it.

## Packaging and install

The npm package ships the bundle and a committed node shim. It has no lifecycle scripts, so it works the moment any package manager unpacks it. Per-platform optional packages carry the native binary. Install decides the fast path: it stages the native binary (or announces the shim where a platform has none) beside the bundle at a stable per-platform path, and writes that path into Claude Code's settings as the statusline command. In a source checkout the native binary stages at its own gitignored path, so the committed shim and the native build never fight over one file.

pnpm settings live in the workspace YAML, because pnpm 11 ignores the `pnpm` field of package.json.

On macOS, install builds a URL-handler app for the `cc-candybar://` scheme and copies its runtime to a stable path outside the pnpm store. A link click goes from the handler app to the CLI, and from the CLI to the daemon's click protocol.

The attach launcher for the statusline lane is a verbatim, vendored copy of cc-extra. A script copies it in and records the source commit. Don't edit it here: change cc-extra and vendor it again.
