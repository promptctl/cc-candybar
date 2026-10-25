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

A session view's payload is one computed over its declaration, the session's picks and the histories' depths (`src/daemon/session-source.ts`), and its inputs derive from it. A cache policy over the payload therefore reruns in the turn its fact moves (a request's arrival, a lane's landing, a click), never inside a draw. What moves with the instant (`today`, `feeds`, `drawing`) is each draw's own projection, listed in `DRAW_PROJECTIONS`. A selection's `.effective` is its slot's node, outside the payload, so a rule reading any `.effective` would read its own answer and is refused at load. A refresh that throws is stored as its lane's failure (`RefreshFaults`), or the lane would read as not answered forever.

## Templates

- A `when` hides its segment only when it renders the literal text "false". So a gate must render a boolean. An `or` over numbers that are all zero renders "0", and the segment then shows as an empty coloured cell.
- A missing field is an error, not empty text.
- Sprig's regex functions use ECMAScript regex syntax, not RE2.
- Parse once and evaluate many times, because parsing is the expensive step.

## Layout

- Padding is structural. Templates emit content only. Padding is applied where the cell is laid out, before sizing, so it fits inside a declared width.
- A fill cell can't be sized where it's authored, because the leftover width is a fact about the whole row. Instead, the cell declares its demand, and one place settles every demand. It measures the row through the same serializer that will draw it, rather than modelling the chrome. A row that already overflows hands out nothing. The demand is a typed field of the cell, so any code that rebuilds a cell carries it or fails to typecheck.
- Endcap shapes are rich-js's joiners. Chrome widths are measured through the joiner, never kept in a table.
- Colour depth has no "auto" setting. The daemon is detached, so detection would read the daemon's terminal, not the user's. A real auto would need a client hint.

## Failures draw; they don't throw

Nothing a config authors can make a render throw. A failing rule falls back to its slot's floor and warns. A failing placement draws ⚠. A container whose `when` throws hides its children and warns, naming them. Warnings go to the diagnostic strip and the render event. The check command handles warning kinds in an exhaustive switch, so a new kind is a compile error there until someone decides what it means.

The strip links to the full error text with a file:// URL. It can't depend on the `cc-candybar://` handler, since that handler may be what's broken.

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

A frame reports whether it moves, based on the cells it drew. The bundled loops move about one just-noticeable step per second, so at 30 fps most frames repeat their bytes and aren't sent.
