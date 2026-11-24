# Interaction: actions, menus, controls

To author a config, use docs/interaction-authoring.md. Its examples are tested against the loader. The settings menu's map is design-docs/SETTINGS-MENU-MAP.md.

## Actions are joined to regions by name

A clickable region in a template and the effect of clicking it are separate declarations, joined by an action name. There's no widget type. You can change a button's glyph without touching its behaviour, and point an action somewhere else without touching the template.

Only `set` writes session state, so only `set` derives a gate. Each `set` carries its value source as literal data, so the writable keys and values can be listed straight from the config. That derived gate is the only authority: a template can name an action, but it can't sneak in an ungated write. Each gate belongs to the clicking session's config, so if two configs declare one key differently, each gates its own sessions.

A cycle writes the absolute successor, computed at render time. The glyph shows the current state, so the click must deliver exactly the change the glyph promised. A stepper writes a relative nudge instead, because rapid clicks have to add up.

In a multi-action click, the first action is its face: it provides the display and the current-state mark. The actions after it can't bind a template value, since only the first is bound to a display. The dispatcher joins adjacent session writes into one all-or-nothing batch, and adjacent resets into one file write, whatever produced them.

A menu's trigger text is always authored, never added by the runtime, and binding none is a load error. That way only one place decides the glyph.

## Pickers and options

A picker is a pure render helper over actions that are already gated. Paged or not is one value (a finite or an infinite width), not a mode.

An option from a colour-valued domain shows its name plus a swatch of what picking it would apply, and the swatch carries the colour. Option cells are drawn content, so pages are measured by drawn width and the click covers every run. Adjacent runs with the same URL read as one link, because the writer closes and reopens OSC 8 at every colour change.

The add-segment library shows each segment's description rather than a rendered sample. Rendering a segment needs a placement's scope (settings, drafts, gates), and the library doesn't have one.

A carousel names what it sets, never the value, because the value belongs to the list its label opens. It keeps no position of its own, and if no variable reads its key back that's a render error, since the ring could never be centred.

A stepping link carries its step and never the option it lands on. That covers a carousel's or swatches row's ◀ ▶, the swatches `?`, and a picker's page arrows. A terminal keeps the link it found when the mouse last moved, so a link that wrote the draw's neighbour would repeat that write on every click after the first. The click reads where the key stands and lands the step. The ring is the declared action's own option domain, resolved over the clicking session's config, never the key's gate list: the gate merges every action writing the key, and a baseline key such as the theme carries no list at all. The ring starts from the value the bar wears (the fold behind `.effective`), not what one layer's file declares. A swatches step also turns the page holding where it landed, so that page is derived in the handler that resolves the landing: a persist write lands a turn later, and a second effect reading the key would turn to the old value's page. The drawn page layout rides in the link as runs of pages, since only the draw knows where the width broke the pages. A `do` whose other members write the drawn option cannot be stepped, since they would write another option than the one the step reaches.

## Disclosures

A disclosure's body hangs on its trigger, and one lowering builds every disclosure. The body's open state comes from the same state the trigger writes, so there's no separate `when` on the body to drift out of sync.

An open body leads its first row with a single ✕, and later rows lead with a blank of the same width. Each line knows whether it's its own row or belongs to a deeper band, so every row is led exactly once, by the innermost band.

Closing a disclosure closes everything open inside it, in the same batch. This happens where all of a verb's session writes pass, so ◁ back restores a closed menu along with what was open in it. Closing the menu also leaves edit mode.

State a placement owns, a menu's open state and an unsaved setting alike, is filed under the preset whose tree holds it, its id and its segment together. An id is unique only inside one preset's tree, and a kept id can come to name another segment whose menus and settings share names, so any less hands one placement's open menu or draft to another. Each of the three leads with a letter, because a key is read in templates as a field path and a name there cannot lead with a digit, which a preset or id may.

A menu's state key is spelled injectively, and no key is a dot-path prefix of another: a placement's menu and an author's shared key take different leads, because a closing folds every key under the one it closes, and two spellings that meet or nest would share or fold each other's state. A menu edit mode hosts carries edit's namespace, so it lives and dies with the edit. An author's accordion key is spelled into a menu key of its own, so the load refuses one only where that key would be the bar's: in edit's namespace, or a settings menu accordion. A raw key an author writes (a state key, a `set` target, a group's key) is the session key itself, so any in a reserved namespace is refused. The refusal covers the namespaces the code mints keys under. A key the bundled config authors (a confirm's armed state, say) is shared with the user's config like any other authored key, and a setting's key is guarded by the setting's owner, not by this check.

A group is just another way to write a container with a toggle. Sibling groups that share a key form an accordion, since one key holds one open name. An ancestor and a descendant can't share a key, because one key can't hold both of them open.

## The settings menu

The menu's door appears in every preset root. It's declared once and referenced from each preset, so N presets don't mean N declarations. It's visible under every condition: by default it gets its own ungated row, and an authored placement under a gate or inside a body is a load error. It has no precondition. What it reads is the payload's: the merge gives those values the last word over every layer, so a file's own declaration of one changes nothing and is a warning, since refusing would cost the file every other line for one redundant one.

◁ back undoes navigation only, never a decision. Decisions include a setting, a dismissal, and an armed confirm, which is one click away from firing.

A destructive control's first click arms a confirm. The door and the tabs disarm it, so a confirm always fires in the same menu it was armed in.

Menus close themselves after a timeout counted from the session's last click. The close is the same journaled write the ✕ makes, so savepoints and back treat it like a click. A click that names no session (copy, open) doesn't restart the clock. Nothing sets `statusLine.refreshInterval`; the user owns it. Without a one-second value in Claude Code's settings, the statusline redraws only when Claude Code asks, so neither the closing flash nor the close shows until its next event.

## Gestures, hover and the click mode

A region's plain click is its action's own effects. Its other gestures are bound by the action's `on:`, each naming another declared action, and the host publishes one signed link per gesture. The click wire carries no gesture: a pane press is admitted by the same signature check as a statusline click, so a forged or altered link, or a press on a cell no region covers, runs nothing. The pane's hit map travels only in the pane lane's answer, because the statusline's bytes never read it and carrying it there would cost every tick.

Hover is a value the draw reads, the action under the pointer, and is never stored while a pane owns the pointer: the pane's facts end with its subscription, so a stored value would outlive the pane that reported it. The pane that spoke last owns the pointer, by opening its stream or by reporting, because the pointer is wherever the user last moved it: a report is never refused for coming from the pane that was not last, and a stream that reconnects speaks once without holding the pointer from the pane the user is in. When it leaves, the pane that spoke before it owns again with what that pane last said, so ownership is derived from who follows and never held in a slot of its own. A pane is told only what tmux delivers to it, and tmux's own default binding takes alt+right for its pane menu, so the pane does not claim it; tmux sends no motion to a pane the pointer has left, so hover is the last region the pane saw, and a frame that replaces the hit map does not move it, because a hover that re-read the pointer on every frame would re-hover whenever a hover changed the layout.

The click mode is how a surface that delivers only the plain click reaches the other bindings. It is session state, but its own kind of key: Back must not restore a mode, an edit must not hold it aside, and undo must not step it. A cell is drawn once and shown by every lane, so no cell reads the mode or the surface: each region carries what a click means in every mode, and one step after the draw picks each link by the mode in force, which is the session's unless the surface of the pane that owns the pointer (a link's, with none) delivers that mode's gesture itself. Only one lane shows a frame with regions, because the statusline shows the handoff line while a pane draws the bar. That is what lets one config draw on a pane with a working mouse and on the statusline, and it keeps every action cell out of the per-draw projections, which would re-evaluate each of them every frame. A link no action names (a menu's own rows, a picker's option) is not a region and is the same in every mode. On a surface that cannot see the pointer move, hover mode reads the region a click last made hovered from the session, and stepping the mode puts it away, so a hover left behind never returns when the mode comes round again.

The controls that end the mode (the toggle, the door, the diagnostics indicator) work in every mode because each binds itself under every mode's gesture in its own data. An exemption in the draw would be a second list of controls to keep in step with the first. A mode left on counts as open state for the idle clock, so the period that closes menus also returns the mode to the plain click.

## Slash commands

A slash click types into the session's tmux pane. The daemon reads the pane first and refuses unless the pane shows the bare input box: a permission dialog would take the Enter as approval, and a held ctrl+s stash would get popped into the command. The keys go in one tmux call: ctrl+s (Claude Code restores the draft afterwards), then a bracketed paste, then Enter. Only lines the config declares get typed. Whatever acts in one pane (a slash line, a bar pane split) goes one at a time in the order asked, because each reads the pane before it types and two at once would both find the bare input box.

## Running a program

A run click runs only what the bar drew. The draw evaluates the program, its arguments and its environment, and the link carries the result, so the click delivers exactly what the glyph promised and evaluates nothing of its own. A click has no view to evaluate in, and values can move between the draw and the click.

The host signs every `cc-candybar://` link it publishes, because any web page can ask the handler to open one. The signature proves publication, which applies to authored links too. For generated runs the host also signs the evaluated arguments, environment and declaration, so the publication signature alone cannot authorize a run. When the click arrives the host keeps that evidence for the turn and sends the renderer the action name and a reference within the turn. The resulting launch uses the captured arguments and environment after the host checks the declared run. The key lives in the state directory and outlives restarts, so a link still in scrollback works while its action is declared as drawn. The declaration also supplies the working directory and which sources to refresh.

The click is answered at once and the program runs after it. Its failure therefore can't be the click's error: it reaches the session's bar through the session's state when the program ends.

## A failed click's error

A failed click's error shows for a few seconds of reruns, and after that until an answer has actually carried it to a client. A launch blocked by its rate limit uses that same warning because the click accepted by the URL handler may still fail when its effects settle. With no refresh interval, Claude Code asks only on events, so a time limit alone could expire the error before anyone sees it. It counts as delivered only once an answer carrying it has been flushed successfully. The same hold rule serves every event-shaped error, such as a launched program's pipe cut or failing after its launch, each with its own hold length, so two errors can never disagree on when an event stops showing. A launched program's pipe event is the daemon's, held per what it met rather than joined with others, and counted while held so a flood moves no bar: one session's answer carrying it is what makes it seen, and the launcher keeps none of it. A failure that comes while the last is still owed joins it rather than replacing it, because a click's own failure and the failure of the run it started arrive apart and both must be seen. An act's failure with no session to show it on, or whose renderer has ended, is the daemon's, held on every bar like a pipe event.

## Copying a diagnostic

A diagnostic's copy click carries the message's key and the renderer that drew it, never its text, and the daemon reads the text from the frame that renderer last delivered when the click runs. The key alone is not enough: one message keeps its key while its text changes, and the statusline and a feed can show different frames of it. The texts are held per session rather than per view, because a frame stays on screen after a reload replaces the view it was drawn from. Every word cell of a line repeats its link, and terminals drop OSC 8 links past a couple of kilobytes, so a fix prompt carried in the link would multiply a frame's bytes and then silently stop clicking.
