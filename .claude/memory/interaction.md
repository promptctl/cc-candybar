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

A carousel names what it sets, never the value, because the value belongs to the list its label opens. It keeps no position of its own: its arrows step from the applied value. If no variable reads its key back, that's a render error, since the ring could never see its own writes.

## Disclosures

A disclosure's body hangs on its trigger, and one lowering builds every disclosure. The body's open state comes from the same state the trigger writes, so there's no separate `when` on the body to drift out of sync.

An open body leads its first row with a single ✕, and later rows lead with a blank of the same width. Each line knows whether it's its own row or belongs to a deeper band, so every row is led exactly once, by the innermost band.

Closing a disclosure closes everything open inside it, in the same batch. This happens where all of a verb's session writes pass, so ◁ back restores a closed menu along with what was open in it. Closing the menu also leaves edit mode.

A group is just another way to write a container with a toggle. Sibling groups that share a key form an accordion, since one key holds one open name. An ancestor and a descendant can't share a key, because one key can't hold both of them open.

## The settings menu

The menu's door appears in every preset root. It's declared once and referenced from each preset, so N presets don't mean N declarations. It's visible under every condition: by default it gets its own ungated row, and an authored placement under a gate or inside a body is a load error. It has no precondition. Anything it reads that the config doesn't declare is supplied from the payload inputs, merged under the config so the user's own declaration wins.

◁ back undoes navigation only, never a decision. Decisions include a setting, a dismissal, and an armed confirm, which is one click away from firing.

A destructive control's first click arms a confirm. The door and the tabs disarm it, so a confirm always fires in the same menu it was armed in.

Menus close themselves after a timeout counted from the session's last click. The close is the same journaled write the ✕ makes, so savepoints and back treat it like a click. A click that names no session (copy, open) doesn't restart the clock. An open menu marks an otherwise still frame as able to move, so the doctor asks for a one-second refresh while a menu is open. Without it, neither the closing flash nor the close would show until Claude Code's next event.

## Slash commands

A slash click types into the session's tmux pane. The daemon reads the pane first and refuses unless the pane shows the bare input box: a permission dialog would take the Enter as approval, and a held ctrl+s stash would get popped into the command. The keys go in one tmux call: ctrl+s (Claude Code restores the draft afterwards), then a bracketed paste, then Enter. Only lines the config declares get typed.

## Running a program

A run click runs only what the bar drew. The draw evaluates the program, its arguments and its environment, and the link carries the result, so the click delivers exactly what the glyph promised and evaluates nothing of its own. A click has no view to evaluate in, and values can move between the draw and the click.

The link is signed, because any web page can open a `cc-candybar://` link, and a link that runs a program must prove the daemon drew it. The key lives in the state directory and outlives restarts, so a link still in scrollback keeps working while its action is declared as it was drawn. The signature covers the declaration too, because a link drawn before an edit would otherwise run a program the config no longer declares. What the program is allowed to touch (its directory, the sources it refreshes) comes from the declaration the link names, never from the link.

The click is answered at once and the program runs after it. Its failure therefore can't be the click's error: it reaches the session's bar through the session's state when the program ends.

## A failed click's error

A failed click's error shows for a few seconds of reruns, and after that until an answer has actually carried it to a client. With no refresh interval, Claude Code asks only on events, so a time limit alone could expire the error before anyone sees it. It counts as delivered only once an answer carrying it has been flushed successfully.

## Copying a diagnostic

A diagnostic's copy click carries the message's key and the renderer that drew it, never its text, and the daemon reads the text from the frame that renderer last delivered when the click runs. The key alone is not enough: one message keeps its key while its text changes, and the statusline and a feed can show different frames of it. The texts are held per session rather than per view, because a frame stays on screen after a reload replaces the view it was drawn from. Every word cell of a line repeats its link, and terminals drop OSC 8 links past a couple of kilobytes, so a fix prompt carried in the link would multiply a frame's bytes and then silently stop clicking.
