# Frames, lanes, tmux

## Pushed frames

A subscription turns a connection into a stream of frames. Data and frames travel separately: render requests bring data, and frames are drawn from what the owners stored. A request's answer goes only to its own client and is never pushed, so every pushed frame was drawn by the feed.

The host owns who watches and what each subscriber was sent; the renderer owns when frames are drawn. The host hands the renderer every session's viewers whole, so a lost or reordered delta can never leave a feed open that nobody watches, and it compares each frame per subscriber, sending only what changed for that subscriber's lane.

While someone watches a session, the host can hand its latest encoded frame to a joining subscriber. Replacing a viewer with the same lane and visibility needs no additional draw after that handover. The last viewer leaving releases the frame. Missing bytes or a declined handover ask for a draw through the viewer declaration, including when a sole viewer's departure and replacement share one mailbox slot.

A feed draws its next frame when the drawn frame next changes, no closer than 30 fps while its pane is on a screen and no further apart than 1 s, and at 1 fps while the pane is off screen. The 1 s tick is what refreshes a template reading the instant (an age, a clock), which stamps no change. The daemon polls tmux for pane visibility only between the first feed opening and the last one closing.

Every input carries two readings the host made as its mailbox slot came: the wall instant, which a frame shows, and a monotonic tick, which everything scheduled is measured on. A schedule kept on the wall would run backwards when the clock steps back, so a span is measured on the wall from the instant a frame was drawn for and added to that frame's tick. A frame due for a change is drawn for the change's instant when the reading falls a couple of milliseconds short of it: the wall reads whole milliseconds and a change lands at an exact instant, so a frame drawn for the reading would show the step before its change and be drawn twice.

The renderer reads no clock and sets no timer. Each output declares the one tick it next wants a turn at, the earliest of its feeds, idle menus and held work, and the host keeps one timer for it. A timer that fires before its tick waits out the rest rather than taking a turn, because Node starts a timer from the loop's cached time, so one armed late in a slow turn fires early by as long as that turn ran. Each owner of a wake turn (held work, idle closes, each feed) fails alone and moves its own work on, so one session's failure never slows another's frames. Only a failed wake turn that still asks for a tick no later than its own holds the next a second off, because nothing moved on and it would be handed in again at once. A wake turn waits behind every input that arrives while it waits, because a click queued behind an idle close would land on menus the close had already shut.

Nothing that wakes a feed draws. A changed value, session state, config reload, or pane coming into view can bring an ordinary frame forward, to a moving period after the last frame while shown and a still period while unseen. An exception that escapes a feed turn sets a retry one still period later, which wakes leave in place. A failed presentation delivered to the pane still follows ordinary spacing so a corrective event can wake it. A feed's first frame comes in a later turn than the one that opened it.

A view reports that its data moved from one reaction over everything it draws from, and a draw writes none of that: what a request said is recorded by its context turn, never by a frame. A draw that wrote what its view reacts to would wake its own feed and keep a still bar drawing at the moving rate.

A frame only finds its session's view; it never builds a cache entry or opens a view, because either is I/O on the frame path. Only an event opens one: a request, a reload's successor, or a click that moved the session's config. So an open feed pins its session in the render cache, and its entry is never evicted nor its view closed idle while the feed is open. The pin also wakes the feed when the session's own state changes, so the wake lives exactly as long as the feed. A feed whose session has no view waits until the event that opens one wakes it. A view whose opening threw leaves that error in its place, so an open feed draws the failure rather than freezing on the last bar it pushed.

The fps a frame shows is the feed's ceiling, `≤30` while its pane is shown and `≤1` while not, never a measurement or the gap to the next frame. The number is drawn into the frame, so a value that moved with a render's cost or the bar's own beat would make otherwise unchanged frames differ, and they would all get pushed. A bar Claude Code polls says `polled` rather than a rate, because request arrivals can't tell Claude Code's timer from its event redraws or from a daemon stall, and a count over a trailing second never reads below one.

The rate cell hangs on the menu's anchor, beside the door, because the anchor is the one position every bar is guaranteed. Placed in a preset's root instead, it would be missing from every preset and authored root that didn't name it.

A throw while taking an output's frames or switches is logged and shown on every bar, and never fails the turn that drew them: the turn's other effects already happened.

Unanswered click and daemon-act diagnostics share one bounded text record. Short messages keep their order. At the limit the bar keeps recent details and can shorten one oversized message around its middle. The full error still follows its usual log path. Each joined record has its own acknowledgement revision, so equal visible text in the same instant can still identify separate arrivals.

## Followers

The Node and native followers share their reconnect decisions through one fixture of cases, which both test suites assert. Only a daemon speaking a newer protocol ends a follower. A bad-request answer comes from an older daemon, which restarts on the new build, so the follower reconnects.

## Lane switches

A renderer's lane declaration sets the desired pane policy. The host's latest accepted statusline request locates that session. A pane move or a temporary setup failure is reconciled from those requests even when the renderer's policy stays the same. Pane lanes are held by declaration and not by acts, because an act makes the renderer remember what it asked, and that memory drifts from the host's when the host releases a pane on its own.

A lane's switch is read where the config is, in the renderer, and every output declares each viewed session's switches, a turn that threw included, so the host's gate ends a lane switched off while the render throws. The host gates on the switches the last output declared: a subscribe to a lane that's off is refused at once, and a subscriber whose lane goes off is ended, told why. A session with no view yet has no switch to read, since only an event opens a view, so its subscriber is admitted and the switches its view opens with decide.

While a lane that draws the bar somewhere else is on and actually followed, Claude Code's own statusline shows one small row instead of a second bar: a button that draws it back there, and the diagnostics indicator, so an error is seen even where the lane's bar isn't. Turning the switch on alone draws nothing.

## The attach launcher

A Bun-compiled Claude Code honours BUN_OPTIONS. It doesn't honour BUN_INSPECT_PRELOAD or NODE_OPTIONS. BUN_INSPECT names a single socket, so two sessions can't share it, and BUN_INSPECT_CONNECT_TO dials out without holding the process. This was measured on one Claude Code release, so recheck it if attaching stops working. The preload execs node with the launcher in the same pid and removes itself from BUN_OPTIONS, so no Bun child process runs it again. When it can't attach, it refuses rather than start a stock session.
