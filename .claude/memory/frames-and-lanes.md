# Frames, lanes, tmux

## Pushed frames

A subscription turns a connection into a stream of frames. Data and frames travel separately: render requests bring data, and frames are drawn from what the owners stored. A request's answer goes only to its own client and is never pushed, so every pushed frame was drawn by the feed.

The host owns who watches and what each subscriber was sent; the renderer owns when frames are drawn. The host hands the renderer every session's viewers whole, so a lost or reordered delta can never leave a feed open that nobody watches, and it compares each frame per subscriber, sending only what changed for that subscriber's lane.

A feed draws its next frame when the drawn frame next changes, no closer than 30 fps while its pane is on a screen and no further apart than 1 s, and at 1 fps while the pane is off screen. The 1 s tick is what refreshes a template reading the instant (an age, a clock), which stamps no change. The daemon polls tmux for pane visibility only between the first feed opening and the last one closing.

Every input carries two readings the host made as its mailbox slot came: the wall instant, which a frame shows, and a monotonic tick, which everything scheduled is measured on. A schedule kept on the wall would run backwards when the clock steps back, so a span is measured on the wall from the instant a frame was drawn for and added to that frame's tick. A frame due for a change is drawn for the change's instant when the reading falls a couple of milliseconds short of it: the wall reads whole milliseconds and a change lands at an exact instant, so a frame drawn for the reading would show the step before its change and be drawn twice.

The renderer reads no clock and sets no timer. Each output declares the one tick it next wants a turn at, the earliest of its feeds, idle menus and held work, and the host keeps one timer for it. A timer that fires before its tick waits out the rest rather than taking a turn, because Node starts a timer from the loop's cached time, so one armed late in a slow turn fires early by as long as that turn ran. A wake turn that fails holds the next one a second off, so a renderer that throws on every wake doesn't spin. A wake turn waits behind every input that arrives while it waits, because a click queued behind an idle close would land on menus the close had already shut.

Nothing that wakes a feed draws: a value its bar draws from moving, the session's state, a config reload, or a pane coming into view only brings its next frame forward, to a moving period after the last frame while its pane is shown and a still period while not. So no cause sets the draw rate, and an unseen feed woken every millisecond still draws once a second. A feed's first frame comes in a later turn than the one that opened it.

A view reports that its data moved from one reaction over everything it draws from, and a draw writes none of that: what a request said is recorded by its config turn, never by a frame. A draw that wrote what its view reacts to would wake its own feed and keep a still bar drawing at the moving rate.

A frame only finds its session's view; it never builds a cache entry or opens a view, because either is I/O on the frame path. Only an event opens one: a request, a reload's successor, or a click that moved the session's config. So an open feed pins its session in the render cache, and its entry is never evicted nor its view closed idle while the feed is open. The pin also wakes the feed when the session's own state changes, so the wake lives exactly as long as the feed. A feed whose session has no view waits until the event that opens one wakes it. A view whose opening threw leaves that error in its place, so an open feed draws the failure rather than freezing on the last bar it pushed.

The fps a frame shows is the feed's ceiling, `≤30` while its pane is shown and `≤1` while not, never a measurement or the gap to the next frame. The number is drawn into the frame, so a value that moved with a render's cost or the bar's own beat would make otherwise unchanged frames differ, and they would all get pushed. A bar Claude Code polls says `polled` rather than a rate, because request arrivals can't tell Claude Code's timer from its event redraws or from a daemon stall, and a count over a trailing second never reads below one.

The rate cell hangs on the menu's anchor, beside the door, because the anchor is the one position every bar is guaranteed. Placed in a preset's root instead, it would be missing from every preset and authored root that didn't name it.

A throw while taking an output's frames or switches is logged and shown on every bar, and never fails the turn that drew them: the turn's other effects already happened.

## Followers

The Node and native followers share their reconnect decisions through one fixture of cases, which both test suites assert. Only a daemon speaking a newer protocol ends a follower. A bad-request answer comes from an older daemon, which restarts on the new build, so the follower reconnects.

## Lane switches

A lane's switch is read where the config is, in the renderer, and every output declares each viewed session's switches, a turn that threw included, so the host's gate ends a lane switched off while the render throws. The host gates on the switches the last output declared: a subscribe to a lane that's off is refused at once, and a subscriber whose lane goes off is ended, told why. A session with no view yet has no switch to read, since only an event opens a view, so its subscriber is admitted and the switches its view opens with decide.

A lane is set up or torn down only by the session's own click that moved its switch, measured around the click (before the handler, after the commit) rather than inferred at a draw. A switch moved by anything else (another session's save, a hand edit, a restart, a cd) sets nothing up, because that would restart every idle Claude Code reading the file. One edge: the before reading is the config as this session's cache last loaded it, and the after reading follows the click's own reload, so another session's save that the watcher hasn't reloaded here yet counts as this click's move. The window is the watcher's debounce, and only the clicking session is set up, to match the bar its click left. A click on a bar from before a daemon restart has no request to set the lane up with yet, so it is owed to the session's next click or request, and settled against the switch as that event finds it: by then another session's save may have moved the switch back, and a setup from the click's reading would restart Claude Code for a lane the bar shows off.

The tmux status line is held by declaration: the renderer names the sessions whose row is on, and the host holds each at the pane its newest request reports and releases one no longer named. An act would make the renderer remember what it asked, and that memory drifts from the host's whenever the host releases a row on its own, an act is refused, or the renderer restarts. A row the host released on its own is held again only at the session's next request, so nothing between requests re-takes it.

While a lane that draws the bar somewhere else is on and actually followed, Claude Code's own statusline shows one small row instead of a second bar: a button that draws it back there, and the diagnostics indicator, so an error is seen even where the lane's bar isn't. Turning the switch on alone draws nothing.

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
- A tmux spawn costs about 20 ms on macOS, so calls are async and serial per server. Each tmux call is its own client, which reaches the server whenever it does, so the shutdown restore waits for the calls in flight before it puts anything back: a lay-out write landing after a restore lays the session out again with no daemon left. A killed daemon's last call can still land after the next daemon's restore, so draws run under an if-shell guard on the prior record and land on nothing.
- A click from the tmux status line arrives through tmux, so it proves nothing about the URL handler or about terminal links.
