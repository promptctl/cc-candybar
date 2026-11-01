# Frames, lanes, tmux

## Pushed frames

A subscription turns a connection into a stream of frames. Data and frames travel separately: render requests bring data, and frames are drawn from what the owners stored. A request's answer goes only to its own client and is never pushed, so every pushed frame was drawn by the feed.

A feed draws its next frame when the drawn frame next changes, no closer than 30 fps while its pane is on a screen and no further apart than 1 s, and at 1 fps while the pane is off screen. The 1 s tick is what refreshes a template reading the instant (an age, a clock), which stamps no change. The daemon polls tmux for pane visibility only between the first feed opening and the last one closing.

A frame is drawn for the instant its timer was set for, kept within a couple of milliseconds of the wall clock. The wall reading is truncated to the millisecond and Node timers fire early against it, and a change lands at an exact instant, so a frame drawn for the wall reading would show the step before its change and be drawn twice. Nothing carries from one frame's instant to the next, so a wall clock stepped back is followed at once rather than drawn ahead of.

A feed has one timer, and nothing that wakes it draws: a value its bar draws from moving, the session's state, a config reload, or a pane coming into view only brings that timer forward, to a moving period after the last frame started while its pane is shown and a still period while not. So no cause sets the draw rate, and an unseen feed woken every millisecond still draws once a second. A frame is never drawn in the turn that woke it, so a subscribe draws nothing in its caller's turn. A click that awaits gives up the loop, so a frame may show its writes before its journal commits; the undo step stays whole.

A view reports that its data moved from one reaction over everything it draws from, and a draw writes none of that. A frame is drawn in one synchronous turn and opens nothing, so a wake while it draws can only be the draw's own, and it is coalesced into that frame, which already reads what moved. Drawing again for it would let a draw set its own next frame.

A frame only finds its session's view; it never builds a cache entry or opens a view, because either is I/O on the frame path. Only an event opens one: a request, a reload's successor, or a click that moved the session's config. So an open feed pins its session in the render cache, and its entry is never evicted nor its view closed idle while the feed is open. A feed whose session has no view waits until the event that opens one wakes it. A view whose opening threw leaves that error in its place, so an open feed draws the failure rather than freezing on the last bar it pushed.

The fps a frame shows is the feed's ceiling, `≤30` while its pane is shown and `≤1` while not, never a measurement or the gap to the next frame. The number is drawn into the frame, so a value that moved with a render's cost or the bar's own beat would make otherwise unchanged frames differ, and they would all get pushed. A bar Claude Code polls says `polled` rather than a rate, because request arrivals can't tell Claude Code's timer from its event redraws or from a daemon stall, and a count over a trailing second never reads below one.

The rate cell hangs on the menu's anchor, beside the door, because the anchor is the one position every bar is guaranteed. Placed in a preset's root instead, it would be missing from every preset and authored root that didn't name it.

A throw in a feed's frame step is logged as that feed's fault, never left as an unhandled rejection.

## Followers

The Node and native followers share their reconnect decisions through one fixture of cases, which both test suites assert. Only a daemon speaking a newer protocol ends a follower. A bad-request answer comes from an older daemon, which restarts on the new build, so the follower reconnects.

## Lane switches

A lane's switch is read at the moment it's needed, never copied onto a frame. A subscribe to a lane that's off is refused before any feed opens, once the session has a view. A session with no view yet has no switch to read, since only an event opens a view, so its feed opens and its first frame decides.

A lane is set up or torn down only by the session's own click that moved its switch, measured around the click (before the handler, after the commit) rather than inferred at a draw. A switch moved by anything else (another session's save, a hand edit, a restart, a cd) sets nothing up, because that would restart every idle Claude Code reading the file. One edge: the before reading is the config as this session's cache last loaded it, and the after reading follows the click's own reload, so another session's save that the watcher hasn't reloaded here yet counts as this click's move. The window is the watcher's debounce, and only the clicking session is set up, to match the bar its click left. A click on a bar from before a daemon restart has no request to set the lane up with yet, so it is owed to the session's next click or request, and settled against the switch as that event finds it: by then another session's save may have moved the switch back, and a setup from the click's reading would restart Claude Code for a lane the bar shows off.

The tmux status line is held at a request's arrival and a click's commit, never at a draw. Between requests nothing re-takes a status line that was released, because a re-take from a remembered switch would re-take one another session's save turned off.

While a lane that draws the bar somewhere else is on and actually followed, Claude Code's own statusline shows one small row instead of a second bar: a button that draws it back there, and the error indicator, so an error is seen even where the lane's bar isn't. Turning the switch on alone draws nothing.

The tmux status line is switched by the renderer, a setting every session the config renders shares. A session outside tmux has no status line to take, so it draws in Claude Code's while the setting still says tmux, and nothing writes the setting for it. Its control is offered only inside tmux, and reset-all resets it only where it is drawn: a reset clicked outside tmux would turn tmux off for every tmux session.

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
