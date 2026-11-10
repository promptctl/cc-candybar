# Goals

What Brandon set for this work: each entry states the intent and its reason in plain technical language, so a reader can tell when it applies. A reason marked *(inferred)* is the design's reading of why, not a reason Brandon gave; he can strike it. The design documents answer to this file and cite entries by ID. Change an entry only when Brandon restates the goal it records.

## The two goals

They are related and handled one at a time.

- **G-1. The browser is a fully supported surface for the bar,** for any user with today's prerequisites: an Apple Silicon Mac, tmux and Claude Code. Every modern browser renders truecolor.
- **G-2. A session's bar can run off a worktree.** The live bar may run off the main checkout, but most development happens on worktrees, and the bar is what is being developed. Each daemon may reserve about a gigabyte, so a naive second daemon would duplicate disk reads, processes and memory. The work may split the daemon into a part that gathers facts and a part that draws, so the drawing can be iterated alone.

## The constraints

- **C-1. Build from generally useful primitives.** A primitive is judged by its potential consumers, not its current ones: nothing can consume what does not exist, so having no consumer yet is expected and is no reason not to build it.
- **C-2. Variability is decided by data, not by inline checks.** Different paths exist, but a value selects between them; no conditional path is kept beside another to maintain.
- **C-3. The design conforms to the laws of code.** They are what has made the project work so far, so they decide over how today's code happens to work.

## Rulings

### Building and order

- **R-1. Nothing is decoded from rendered ANSI.** *(Inferred:* state flows forward into a frame, and recovering it from one inverts the pipeline.)
- **R-2. Conclusions are drawn from the supported API, not from Brandon's own config.** File and shell sources are the main way users get something into their bar, so they are the baseline a design is judged against.
- **R-3. No renderer but the ANSI one is built until the wire format is right,** because the other surfaces should then follow with little work of their own.
- **R-4. Features that don't serve the goals may be removed,** and reimplemented later in a form the laws allow. Removing the worst offenders is worth more than keeping them working.

### The payload

- **R-5. Metrics, activity and session are part of the payload.** The payload is where a template's data lives. *(Inferred:* a value that reaches the bar any other way is a second path to keep in step.)

### Clicks and effects

- **R-6. Clicks are isolated, and the URL handler may change substantially to make them so.** A design that leaves the handler untouched is suspect of hiding a real problem.
- **R-7. Handling a click is pure.** A click, a timer and a future webhook are each just a way something happens; which one it was does not matter. Handling one, including setting state or config, produces an event or a description of an effect for something downstream to perform. It never flips a switch directly, because that couples behaviour to timing.
- **R-8. One owner holds the world's inputs and side effects.** Data flows one way, so a renderer never sends a message upstream, and a renderer is not the owner of side-effecting click handlers.
- **R-9. A click carries an address that decides where it goes,** a renderer's name for example. Claude Code's request is answered by the renderer that session's client is talking to. *(Inferred:* an address in the click needs no routing table that could disagree with the frame or be lost on restart.)

### Draw and isolation

- **R-10. Gathering facts is one process, and Events → Apply → Draw runs in a separate process, or several.** This serves G-2: drawing can be iterated, restarted and multiplied without a second reader of the world.
- **R-11. Draw writes nothing; it only draws.** *(Inferred:* a draw that writes cannot be replayed or tested without mocks, and its frame may show something that did not happen.)
- **R-12. There is no dev renderer and no dev mode.** Every renderer draws and acts the same way. A worktree's renderer is isolated by where it reads and writes and is pointed to by a session's values; anything it shows that main does not comes from instrumentation, never from performing a subset of actions. An allow-list of verbs is a dev-mode toggle by another name, and the primitive is an isolated renderer.
- **R-13. No absolute path is stored in undo history;** every stored path sits under the renderer's isolated state directory. *(Inferred:* a history copied between renderers must not be able to write the user's files.)
- **R-14. No surface is secondary.** The statusline, the tmux row and the browser are peers. *(Inferred:* a surface ranked below another gets a branch that treats it differently.)

### Links

- **R-15. Links are minted, never written by hand.** A config gets a link from a template function in the renderer, because no user will plausibly write one; the doctor builds its links with the same minter. A link to test the install is not worth having.

### Sessions

- **R-16. Moving a session to another renderer may restart Claude Code.** Avoiding the restart was never a requirement.

### How designs are made

- **R-17. Decisions draw on how mature systems solved the same problem,** Apple's among them, *(Inferred:* their shape has been tested where ours has not.)
- **R-18. A spec states its intent so it can be reviewed and falsified later:** what each part is for, where the need came from, and the observation that would show the design fails it.

## Noted for later

- **N-1. A floating window attached to the iTerm2 window** is a surface Brandon wants to use eventually. Nothing here depends on it.
- **N-2. A richer surface than the ANSI bar,** the browser first, is a direction Brandon asked about. The design should not close it off.
