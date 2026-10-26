# Frames, lanes, tmux

## Pushed frames

A subscription turns a connection into a stream of frames. Data and frames travel separately: render requests bring data, and frames are drawn from what the owners stored. A request's answer goes only to its own client and is never pushed, so every pushed frame was drawn by the feed.

A feed runs at 30 fps while its last frame moved in a pane someone can see, and at 1 fps when the frame is still or the pane is off screen. The daemon polls tmux for pane visibility only between the first feed opening and the last one closing.

The fps a frame shows is the feed's pace (1000 / its period), never a measurement. The number is drawn into the frame, so a measured value would make otherwise unchanged frames differ, and they would all get pushed.

A throw in a feed's frame step is logged as that feed's fault, never left as an unhandled rejection.

## Followers

The Node and native followers share their reconnect decisions through one fixture of cases, which both test suites assert. Only a daemon speaking a newer protocol ends a follower. A bad-request answer comes from an older daemon, which restarts on the new build, so the follower reconnects.

## Lane switches

A lane's switch is read at the moment it's needed, never copied onto a frame. A subscribe to a lane that's off is refused before any feed opens.

A lane is set up or torn down only by the session's own click that moved its switch, measured around the click (before the handler, after the commit) rather than inferred at a draw. A switch moved by anything else (another session's save, a hand edit, a restart, a cd) sets nothing up, because that would restart every idle Claude Code reading the file. One edge: the before reading is the config as this session's cache last loaded it, and the after reading follows the click's own reload, so another session's save that the watcher hasn't reloaded here yet counts as this click's move. The window is the watcher's debounce, and only the clicking session is set up, to match the bar its click left. A click on a bar from before a daemon restart has no request to set the lane up with yet, so it is owed to the session's next click or request, and settled against the switch as that event finds it: by then another session's save may have moved the switch back, and a setup from the click's reading would restart Claude Code for a lane the bar shows off.

The tmux status line is held at a request's arrival and a click's commit, never at a draw. Between requests nothing re-takes a status line that was released, because a re-take from a remembered switch would re-take one another session's save turned off.

While a lane that draws the bar somewhere else is on and actually followed, Claude Code's own statusline shows one handoff line instead of a second bar. Turning the switch on alone draws nothing.

## Relaunching Claude Code under the attach launcher

- End Claude Code with SIGTERM, not /exit. /exit removes a clean --worktree worktree and asks about a dirty one.
- Read the relaunch directory after Claude Code exits. While Claude Code runs, tmux reports Claude Code's directory instead of the shell's.
- Add --worktree when Claude Code ran in a worktree it created and the relaunch directory isn't inside it.
- Carry only the variables needed to find the session again. The rest stay the shell's. The line lands in shell history, so credentials never go on it.
- Use --session-id instead of --resume when the session has no transcript yet, because --resume would find no conversation.
- Refuse before the kill, not after, whenever the relaunch can't succeed. That includes: a draft, a stash, a turn in progress, a dialog or copy mode in the pane; an unknown flag; an answered session with no transcript persistence; a Claude Code build the launcher can't run (an npm install runs node cli.js); a PATH whose node the preload would refuse.
- The restart counts only if the session's statusline subscribes again within the patience window. If it doesn't, the line is shown for the user to type.

A Bun-compiled Claude Code honours BUN_OPTIONS. It doesn't honour BUN_INSPECT_PRELOAD or NODE_OPTIONS. BUN_INSPECT names a single socket, so two sessions can't share it, and BUN_INSPECT_CONNECT_TO dials out without holding the process. This was measured on one Claude Code release, so recheck it if attaching stops working. The preload execs node with the launcher in the same pid and removes itself from BUN_OPTIONS, so no Bun child process runs it again. When it can't attach, it refuses rather than start a stock session.

## The tmux status line

- tmux stores an array option whole at each level. A session-level status-format[1] blanks the global [0] (the window list), and unsetting indices leaves an empty array that still shadows the global one. So copy, write and restore the session's array whole.
- The restore compares against a record kept in tmux itself, so the next daemon puts back what a dead one left. Each record names the socket of the daemon that wrote it, and a daemon touches only its own records. A dev or test daemon on the same tmux server therefore leaves the real one's records alone.
- Recognise our mouse binding by the URL its command runs, not by its list-keys line. tmux pads that line's key column to the longest key in the table.
- A tmux spawn costs about 20 ms on macOS, so calls are async and serial per server. The shutdown restore is the exception and runs synchronously. Draws run under an if-shell guard, so a draw still in flight after a restore lands on nothing.
- A click from the tmux status line arrives through tmux, so it proves nothing about the URL handler or about terminal links.
