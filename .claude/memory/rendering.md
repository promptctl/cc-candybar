# Rendering

## One path

The daemon draws every bar. The check command, the demo and the tests call the same functions. The demo pushes a faked hook event through the daemon's own state, payload and render functions, so it has no payload of its own to drift. There is no parallel renderer and no fallback computation.

## One instant per render

The daemon samples each render's instant once and binds it to the template engine's single clock for the synchronous walk. Every time read in that render, from template functions to time variables, sees the same instant. A clock read outside a draw throws, and so does a clock read made while a MobX derivation is tracking.

Anything that reads the instant is a projection: it is evaluated on every read and never cached. The temptation is to make one a computed "to save the per-frame evaluation." A cached answer to "what time is it" is wrong by the next frame, and projections exist to make that bug unrepresentable.

The payload stores instants (epoch seconds), never values relative to now. Ages and ETAs are projections over those instants. If a shell or file source's cache key reads a projection, the load refuses it: a cache policy reruns its source when a stored value changes, and the instant is not a stored value. The compiler works out which templates read the instant, including indirect reads. A template that reaches the clock through a name it doesn't spell out (an index lookup, say) is refused when it draws.

## Parts

Every template a draw evaluates is a derived part of the view's store, and it is kept between frames unless it reads the instant. A frame over unchanged data evaluates only the parts that read the instant. Parts pass values to each other and compare them by value, so a neighbour that is a projection never wakes a kept part. Writing a draw fact (width, padding, preset, look) with an unchanged value wakes nothing.

## A draw writes no input

A session view's payload is derived from its declaration, the session's picks and the histories' depths, and its inputs derive from it, so a cache policy over the payload reruns in the turn its fact moves (a request's arrival, a lane's landing, a click), never inside a draw. What moves with the instant (`today`, `feeds`, `drawing`) cannot live in the payload, since it would change every frame, so each draw projects it for itself. A selection's `.effective` comes from its slot, outside the payload, so a rule reading any `.effective` would read its own answer, and the loader refuses it. A refresh that throws stores nothing of its own, so its failure is kept per session and lane; without that, the lane would read as not answered forever.

## Templates

- A `when` hides its segment only when it renders the literal text "false". So a gate must render a boolean. An `or` over numbers that are all zero renders "0", and the segment then shows as an empty coloured cell.
- A missing field is an error, not empty text. A document with nothing to read is a missing field too, never an error of its own, so one gate (`hasKey`) hides what reads it until its source writes.
- Sprig's regex functions use ECMAScript regex syntax, not RE2.
- Parse once and evaluate many times, because parsing is the expensive step.

## Layout

- Padding is structural. Templates emit content only. Padding is applied where the cell is laid out, before sizing, so it fits inside a declared width.
- A fill cell can't be sized where it's authored, because the leftover width is a fact about the whole row. Instead, the cell declares its demand, and one place settles every demand. It measures the row through the same draw that will write it, rather than modelling the chrome. A row that already overflows hands out nothing. The demand is a typed field of the cell, so any code that rebuilds a cell carries it or fails to typecheck.
- Endcap shapes are rich-js's joiners. Chrome widths are measured through the joiner, never kept in a table.
- Colour depth has no "auto" setting. The daemon is detached, so detection would read the daemon's terminal, not the user's. A real auto would need a client hint.

## Failures draw; they don't throw

Nothing a config authors can make a render throw. A failing rule falls back to its slot's floor and warns. A failing placement draws ⚠. A placement of a segment nothing declares is dropped at load and reported as an error against the file that wrote it, so one bad name costs one cell, not the whole bar, and owns no placement id (two of one typo are two drops, not a duplicate); the check command and the demo still refuse it, since the author has to fix it. A container whose `when` throws hides its children and warns, naming them. Warnings go to the bar's diagnostics and the render event. The check command handles warning kinds in an exhaustive switch, so a new kind is a compile error there until someone decides what it means.

## Diagnostics

Every error, warning, notice and question reaches the screen one way: an indicator in the settings door's own cell, and a viewer that takes the body's place and shows one message whole. The indicator lives in the door's cell because the door is the one position every bar is guaranteed, so no layout can leave it out. While a lane draws the bar elsewhere, the statusline is the handoff line with the same indicator after it, because the statusline is where a person looks when the lane's bar is out of view; its click opens the one viewer, which the statusline then draws, and no message text is ever drawn twice.

The list is built once per draw, before the draw, and the indicator and the viewer read that one value, so they can't disagree within a frame. A render warning is known only after the walk, so a draw counts the warnings recorded from earlier frames. Each renderer (a request's answer, the feed's frames) keeps its own record, because they draw at different widths and roots and one shared record would flip with whichever drew last; the session's list is every renderer's records together, in one fixed order, so a viewer opened on one surface finds its message on the other. Every frame records its warnings, compared by value, because a fault can start or stop while nothing else about the frame moves (a refresh that begins failing, a rule that reads the clock). A moved record is shown by its renderer's next frame and never wakes a feed: the indicator's own cells can change what a frame warns, so a frame that woke on its own warnings could wake itself forever. A renderer's own record stands until its next frame replaces it, even across a reload or resize: emptied first, a warning still met would look gone for one frame, and an open viewer on it would close and reopen. Another renderer's record counts only while drawn from the same config, since that renderer may have stopped drawing. A record names its config by a generation, never holds it, so it can't keep a retired config alive.

The viewer's clicks write a message's identity, never a position: a list that shifts under an open viewer would show another message at the same position. The identity is the severity and what the message is about, named by its producer (its source, and the file or repository it concerns), never its text: a load error's issue count and an update's added failure line change while it stays the same message. The viewer closes once its message leaves the list. It is bounded by the terminal's rows and by the shortest surface showing it (a feed's one frame reaches every lane, and the tmux status line shows five rows), its header measured as drawn, and pages within a message whose key names every page.

The indicator and viewer depend on the `cc-candybar://` handler, and that is accepted: a broken handler breaks every click on the bar, the doctor probes and reports it, and `cc-candybar check` prints a config's errors and warnings in full without it. A `file://` fallback on the bar would be a second path for the same text.

## Effects

- An effect's clock is per session and kept only in memory, so a restart starts every effect at zero.
- rich-js reuses a frame's settled colour shares only when it gets the same effect object, so effect objects are kept per row across renders. Rows are identified by place, band and position among rows of that kind, so a menu opening over a bar row leaves that row's motion where it was.
- A placement with its own effect is drawn confined: the loop gets the whole row's cells but paints only that placement's items. Confining narrows the extent a loop uses to place itself, so without this a placement at a row's edge would shift the bar's effect on every other cell.
- Animation speed changes the slope of an animation clock anchored at the last drawn frame. So a speed change never jumps phase, and a render that throws doesn't move the clock. Real-time readouts (the lane spinner, the menu-timeout flash) stay on the wall clock.

## Transitions

- A placement that stops drawing is never evaluated again, because the payload that hides it is often one its template fails on. While it dissolves, it replays its own last rows with links removed.
- Two frames are compared only when they were drawn from the same source: the same loaded config object, preset, width and session-state revision. So a first render, a resize, any state write (a menu opening, say) and a reload fade nothing in.
- A frame's record is kept only after the frame is drawn, so a render that throws leaves the last good frame to compare against.

## Motion

A frame reports when it next changes, read off what it drew: its cells' holds, and the holds told to the draw by animations that draw no cell of their own, such as a colour that steps. Every animation in a frame is placed on the host clock, so those holds are wall seconds whatever drew them. A part that counts on the session's animation clock runs on the session timeline, and the closing flash, which counts down to a real close, runs on the host clock at rate 1. An effect is never wrapped in an outer timeline run: the effect wrapper answers "changes now" and only its own render stamps its exact hold, so a wrapper built on it would make every effect row, the flash and a colourless effect included, claim continuous motion.

The flash is one animation over the whole idle period, dark until it begins, so a frame says when the flash starts. A frame that only appeared would leave its start unannounced.
