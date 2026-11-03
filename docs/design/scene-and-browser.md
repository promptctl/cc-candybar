# Proposal 2: The browser surface

The browser is where the bar stops being a row of terminal cells and becomes what it already is underneath: a set of named segments with values, states, colours, controls and motion. A terminal can only show that as styled runs fitted to a width. A browser can show the thing itself. So the strongest version of this idea is not a page that paints the terminal's frame in a `<pre>`; it is a surface that receives the bar's **Scene**, the structured output the draw produces before it is fitted to any width, and paints it with everything a browser has: real typography, hover, smooth motion at the display's refresh rate, real controls, drag, multiple sessions on one page, and a scrubber over time. The same page, fed a recording instead of a live renderer, is the public demo and the prototyping studio. One render path, one page, three uses.

That is the destination. The road to it starts with the drafts' plan, which is correct as far as it goes: the browser as one more surface of a renderer, painting Frames over a loopback WebSocket behind a token. That ships the live bar in a browser quickly and proves the transport, the security gate and the click path. The Scene is the second step on the same road, not a different road.

Everything here depends on Proposal 1 only for the recording primitive and the renderer's event queue; the browser does not wait for the process split.

## 1. What a browser is for

Three readers, one page.

**The user.** The bar beside Claude Code, in an iTerm2 browser pane under the session, in a floating panel, or in a tab on a second display. Fully supported for anyone with the current prerequisites; iTerm2 is a nice home for it, never a requirement. It must be at least as good as the terminal bar on day one, and then better: hover to see a value's source and age, click a real control instead of a cell, see the powerline joins move smoothly instead of at 30 frames a second over a pty.

**You, iterating.** The chrome-devtools loop from the 31 October session is the right instinct. A page connected to a worktree renderer, with a font-size slider, a config editor whose saves become `set-config` events, a time scrubber over a recorded session, and the renderer's instrument panel beside the bar. Every change is visible without a terminal in the loop.

**A stranger on the website.** A recorded session, real frames from a real Claude Code run, replayed in the page as the visitor scrolls, with a canned Claude Code transcript playing above it so they see the bar where it lives. No renderer in the browser, no WebContainers: the page replays data the renderer produced.

## 2. The shape

```
Draw ──Scene──▶ fit(width) ──Frame──▶ ansi / tmux / band encoders
          │
          └──▶ browser encoder ──WebSocket──▶ page
page ──event (click id, control value, visibility)──▶ renderer's event queue
```

Draw's output is a **Scene**: the bar as a tree of placements, each with its segment's identity, its evaluated text runs with resolved truecolor colours and the roles they came from, its controls (each a link id or a typed control with its current value and allowed values), its `when` outcome, its group and joiner structure, and the motion description attached to it. The Frame is `fit(scene, width)`: today's layout, wrapping, fill demands and endcaps, producing rows of runs. Terminal encoders consume the Frame as they do now. The browser encoder consumes the Scene. One draw, one tree, two shapes derived from it. [LAW:one-source-of-truth] [LAW:decomposition]

This is a refactor of the seam inside today's draw, not a new renderer. Today the draw evaluates templates into rich-js segments and immediately lays them into a strip; the Scene is the value that exists between those two steps and currently has no name. Giving it a type makes the browser possible and makes the layout a pure function anyone can test with a Scene fixture.

**Depth and width stop being problems.** A Frame is drawn for one depth because contrast floors read depth during the draw, and the drafts leave "depth per surface" unsolved. So depth stays an input to the draw, and a Scene is the draw's output at one depth: the terminal's Scene is drawn at the session's depth, exactly as the Frame is today, which is why terminal bytes do not change, and the browser's is drawn at truecolor, every browser's depth. A session whose surfaces differ in depth pays one draw per distinct depth; quantising a truecolor Scene afterwards would run the floors at the wrong depth and change the bytes. Width is the browser's own business: it lays the Scene out itself, reflowing to the pane, so a narrow pane wraps and a wide one spreads, and the renderer never hears about the browser's width. What the page needs for that is data in the Scene (each placement's fill demand, joiner and endcap), not a copy of `fit`'s algorithm; `fit` stays the terminal's layout and the one pure function a Scene fixture tests. The drafts' worry that a second width would redeclare the view for every subscriber disappears, because the browser declares no width.

## 3. Motion belongs to the surface that can do it

The terminal bar animates by the renderer drawing a new Frame up to thirty times a second and pushing bytes. That is the only way a pty can move. A browser can animate at its display's refresh rate from a description, and it has the same rich-js library the renderer uses, because rich-js is JavaScript.

So the Scene carries each effect as a description, which it already is in the renderer: the effect kind, its palette, its clock anchor and speed, the row it is confined to. The terminal path bakes that into frames in the renderer, as now. The browser path ships the description once and the page runs the same rich-js effect code against the same Scene on `requestAnimationFrame`. The colour math has one home, rich-js; the clock has one owner per surface; and a bar that is only moving sends nothing over the wire. The feed's 30 fps budget stops being spent on a surface that does not need it. [LAW:one-type-per-behavior] [LAW:effects-at-boundaries]

The one thing to hold: the page's animation clock is slaved to the renderer's. The Scene names the anchor instant and the speed; the page computes phase from its own clock offset against the renderer's, measured on the connection. A speed change in the renderer arrives as a new description with a new anchor and never jumps phase, which is the rule the renderer already keeps for the terminal.

## 4. Interaction is events, not links

Terminal clicks are OSC 8 links because that is the only thing a terminal can send back. The browser does not need the detour. The browser encoder replaces each link with an opaque id, as the drafts say, and the page sends the id back on `pointerdown`; the renderer resolves it against the last Scene it sent that page. That is the floor, and it makes every existing control work from day one.

Above the floor, a control in the Scene is typed: a toggle with its state, a stepper with its range and step, a picker with its options, a carousel with its list, a text setting with its value. The page renders each as a real HTML control, and a change arrives at the renderer as the same event the terminal's click would have produced, `set-state` or `set-config` with the same verb and value. The page never sees a signed URL, never composes a verb, and cannot produce an event the Scene did not offer. The settings menu, which today is drawn into the bar as rows of cells, becomes a panel of real controls in the browser from the same settings rows that drive the terminal menu, with no second description of what the settings are. [LAW:dataflow-not-control-flow] [LAW:single-enforcer]

Edit mode follows: dragging a segment to a new position is a `set-config` event moving a placement, the same event the terminal's edit mode produces with arrow cells. Configure mode is a form. Diagnostics are a list you can read without a viewer taking the bar's place.

Clicks that leave the renderer, `open` and `copy`, run on the Mac the renderer is on, as they do for every surface. A page on another machine, if that ever exists, gets a Scene whose `open` controls the renderer refuses, and the refusal is visible. Not a mode; a fact in the event's outcome.

## 5. One page, three inputs

The page takes a **source**: `{ kind: "live", url, token } | { kind: "recording", path } | { kind: "instrument", url, token }`. The live source is a renderer's WebSocket. The recording source is a file of what the browser encoder sends (Frames until the Scene exists, Scenes after), replayed against a clock the page owns, so a scrubber can drive it. Proposal 1's recording primitive records facts, the renderer's input, not this. A renderer fed a facts recording offline, with the browser encoder writing to a file instead of a socket, produces it. So the page runs no Draw: it replays what a renderer drew, and the committed facts recording is the source the page's recording is rebuilt from whenever the encoder's output changes. The instrument source is the same WebSocket asking for the renderer's wide events instead of Scenes. The page is one bundle for all three; what differs is data. [LAW:one-type-per-behavior]

**The demo site** is the page with a recording source and the scroll position as its clock. A recording captured alongside a `tmux pipe-pane` of the Claude Code pane gives the "visual Claude Code session running with canned data above the bar" that was asked for, honestly: it is a real session, replayed. The landscape and the main page link to each other and build from committed recordings in CI, which is the pipeline shape the Pages work settled on.

**The studio** is the page with a live source pointed at a worktree renderer under its own home, plus the instrument source beside it. The config editor saves through `set-config`; the renderer reloads; the Scene arrives. The chrome-devtools MCP drives the same page, so an agent iterates on the bar's look with a screenshot per change and no terminal.

**The dashboard** is the live source with a session list. A renderer exposes the sessions it holds; the page subscribes to any subset and lays them out. A page addressed by tmux socket and pane follows `/clear` the way the bar pane does, which the drafts cover and I keep.

## 6. Transport and security

The drafts' design here is right and I adopt it whole: an in-repo WebSocket on `node:http`'s `upgrade`, text frames only, because the bundle has no runtime dependencies and the URL handler runs without `node_modules`; bound to `127.0.0.1`; a 32-byte token exchanged for a one-time code carried in the URL fragment so `ps` never shows it; exact `Host` and `Origin` on every request and upgrade; CSP `default-src 'none'`; `no-store`; text through `textContent` only; the token never logged; the listener started only by the renderer that won the socket, with `{port, token}` in a 0600 file whose presence is the only thing that makes a renderer bind at all. The measured numbers hold: 30 fps of real frames at 0.22 ms of DOM work per frame and a 0.3 ms click round trip, and that was the mirror; the Scene sends less.

Two additions. The page is embedded in the bundle, so its version is the renderer's by construction. And the connection carries a protocol version in its first message, the Scene's, so a stale tab against a rebuilt worktree renderer reloads itself rather than painting garbage. [LAW:no-silent-failure]

## 7. Where the window lives is not architecture

A page can live in a tab, in iTerm2's browser pane under the Claude Code session, in a borderless WebKit panel, or on a website. None of these is a different surface; each is a way of putting the same URL on screen.

- **A tab**: `open <url>`. Day one.
- **iTerm2 browser pane**: split, set the Browser profile, load the URL after the welcome page. The Python API does it today in a 30-line script; reimplementing iTerm2's protobuf-over-AppleScript handshake in-app was judged not tiny by the one review that looked, and the user who has iTerm2 has Python. Ship the script as a recipe in the docs and a menu action that runs it when iTerm2 is detected from the client's terminal hint. iTerm2 stays optional.
- **The floating panel**: `probes/float.swift` worked and you liked it. It covered the input box because nothing tied it to the terminal window; following a window needs the Accessibility API. Worth a small helper app later; not on the critical path.

## 8. Order of work

1. **Mirror.** `browser` as a surface with a Frame encoder that replaces links with ids; the listener, its gate and the WebSocket; the embedded page painting runs; `pointerdown` clicks; `via: "browser"` in the click's arrival; the doctor check. This is the drafts' build order 1 to 6 and the open epic's six tickets. *Done when* a real session's bar paints in a tab, matches its Frame byte for byte through the encoder, every link kind works, a stale click finds nothing, and every refusal in the security list is a test.
2. **Recording source.** A renderer replays a facts recording offline into a recording of Frames; the page takes that recording and a clock; the scrubber; the demo site builds from committed recordings; the Claude Code pane capture alongside. *Done when* the public page replays a real session on scroll with no renderer behind it.
3. **Scene.** Name the value between template evaluation and layout; `fit` as a pure function from Scene and width to Frame; the Scene encoder; the page lays out the Scene itself. The demo site's recordings are rebuilt as Scenes from the same facts recordings. *Done when* terminal bytes are unchanged for every existing test and the page reflows to its pane width.
4. **Motion in the page.** Effects as descriptions in the Scene; rich-js effects in the page on the display clock, phase-locked to the renderer. *Done when* a sparkle bar in a tab sends no frames while only moving and matches the terminal's colours at any sampled instant.
5. **Typed controls.** Controls in the Scene; HTML controls in the page; events back; the settings panel from the settings rows; drag in edit mode. *Done when* every setting is reachable from the page and the terminal menu is unchanged.
6. **Instrument and dashboard.** The instrument source; the session list; multi-session layout. *Done when* a worktree renderer's events stream beside its bar and two sessions share a page.

Step 1 is weeks of work and gives you the live bar in a browser. Steps 2 and 3 are where the crown jewel is. Steps 4 to 6 are what makes it a jewel.

## 9. What I would ask you to decide

- **Scene as the browser's wire**, or Frame mirror only. Everything in §§2–5 depends on the Scene. I recommend it; it is the difference between a mirror and a surface, and it also gives the terminal path a tested pure layout for free.
- **Effects in the page.** §3 moves the per-frame colour tick for browser surfaces into the page using the same rich-js code. The alternative is to keep baking frames in the renderer at 30 fps for the browser too, which is simpler and worse. I recommend the page.
- **iTerm2 via the Python API as a recipe**, versus reimplementing the protocol subset in-app as was floated in session. I recommend the recipe: it is 30 lines, it is optional, and the in-app version was the one idea the review called not small.
