# Config: resolution, the file as store, settings

## Resolution

Config locations form a chain, lowest precedence first: the XDG file, then cwd, then project. Each layer merges over the ones below it and is validated together with them, so an error names its own file. An explicit path replaces the chain and is the only layer. The config-path env var is read by the client and sent as a hint (architecture.md).

Only ENOENT counts as absent. A location a stat can't see past, such as an unsearchable directory or a symlink loop, is reported and the search continues. An explicit path that doesn't exist renders the bundled default under a warning, never a silently empty config.

When `.json5` and `.json` sit side by side, `.json5` wins and the shadowed file gets a warning.

A cwd or project layer, and a repository's own plugin folder, load only once the user has approved that directory in the bar. A config can run commands, so a cloned repository asks once, as Claude Code does for a project's MCP servers. The answer is kept by repository directory, not by content, so editing the files never asks again, and a linked worktree answers under its main worktree's counterpart, so a new worktree never asks. The link is proven from the repository's side (the worktree is registered in the common git dir, and git's back-pointer there names this checkout's own `.git`), because a `.git` file is the gated directory's own claim and an untrusted directory can forge one or symlink another checkout's. A directory whose link can't be proven answers for itself. An answer still kept under a worktree's own path stands while its repository has none, because the user gave it; one that disagrees with its repository's asks again rather than losing silently, and answering supersedes it. An entry whose directory is gone stays, because a missing directory proves nothing about which repository it was in. The gate sits inside the one resolution every load shares (the render, `check`, the durable writer, the demo), and the plugin listing takes only an approved project as a stamped type, so a new load path can't list a repository's plugins without consulting the answer. The answers live in the state directory, beside the link key that signs the question's clicks.

A repository's plugins, from its plugin folder or listed by its own config, sit in their own namespace beside installed ones, because a repo folder named like an installed plugin would otherwise replace it for every session in that repo and break the user's placements of it. A config's plugins are the repository's when the chain found the file at the project or working directory, never by the file's name, because an explicit config can carry a repository's file name. Within one namespace the nearer root still wins, and a name missing from one namespace is never looked up in the other. A definition names itself scope-free and the loader binds that name to its namespace at load, because one file loads from a repository and, once installed, from the user's root. A config file declares nothing under a plugin root except retuning a plugin's segment by field, because a name there shadows a plugin's; a segment, action or helper named just the root sits beside them, but a variable of that name shadows the payload's sources.

A placement under a plugin namespace the session doesn't render is data, like a false `when`, because a home config places a repository's cells for every repository it is used in. Only a placement under a plugin that does render, naming a segment it lacks, is broken state; its error names the definition that won and what it declares, since that is what the fix needs. Presence is judged against the chain's own plugins, a repository's included: judging against installed ones alone would make a typo in a repo cell vanish silently.

User files merge over the bundled default by name. Segments and presets merge by name and then by field, so a user declares only what differs. Root rows merge by name, and a whole tree replaces every row.

A layer adds a cell to a row it doesn't own by anchoring on a placement id, because that address means the same thing whether the row below was written as a rows map or as a whole tree. The loader places every layer's cells once, into the config's root and into the tree of each preset that restages, before any check or synthesis walks a tree, because a preset's whole tree replaces the config's root: cells applied to the root alone vanish under it, and clash with a preset that already places them. The merged config keeps no cells to place, because a later pass that placed them again would bring back a cell the load dropped. For the same reason every restaging preset then carries the tree it was judged as, whole: a rows map left as written merges again over the root that now holds the cells, and renders a tree no placement judged. A missing anchor is a warning, not an error, so a repository's guess about a user's layout can't break their bar; so is any issue only a cell brings, found by judging the chain again without cells and then taking them one at a time, so the warning names the insert entry rather than whatever key the check happened to report. It warns only for a root or preset a config file writes: the bundled ones lack most anchors by design, so its miss is like a false `when`, and warning there would put a standing ⚠ on every bar a repository adds to. An inserted cell carries the file that placed it, so edit mode offers it no click: it is an insert entry, and clicks rewrite only roots, even in the user's own file.

JSON5 tolerates duplicate keys (the last one wins), but the file editor refuses the whole document. So loading runs the editor's own scanner and warns. With one detector, the warning and the refusal can't disagree.

## Names never nest

No variable is declared under another. The draw lands a read on the first declared name it reaches and the load's walks on the longest, so the two agree only when nothing nests. The check runs over the names after every synthesis pass, because synthesized names are built from authored ones: a user variable `theme` is refused because the settings menu declares `theme.effective`, and a new synthesis that derives names from authored input can make a config that loaded stop loading.

## The config file is the durable store

There's no daemon-side overrides layer. A click that persists something edits the user's config file in place: it splices one value span and keeps every other byte, comments included. The daemon reloads through the same watcher a hand edit trips. A value written by the menu looks the same as a hand-edited one.

When file events resume after a span the daemon couldn't vouch for, every entry reloads, whatever its own watch heard, because an edit made during the span may never have been heard. A reload of unchanged inputs keeps its state, so only an entry whose files changed rebuilds, and the catch-up needs no throttle.

A config file is watched through its directory by name, never by its own inode, because a write-then-rename replaces the inode and leaves an inode watch deaf with nothing to say so. A config file that is a symlink, like any linked path the daemon watches (a `watch_file` source's too), is watched in every directory its chain of file links passes through, by the name each hop has there, because each directory reports only its own children: re-pointing any link in the chain appears in that link's directory, and a write, which lands in the last target, appears in its. A linked directory on the way is not a hop: the watch sits in its canonical directory, so a write there is heard, and re-pointing the directory link itself is not.

On Linux a directory watch binds the directory's inode, so a config directory removed and made again at its path (a dotfiles re-stow) is deaf to the watch opened on the one before. A file watch's key therefore names each directory's identity as well as its path. A watched directory's own removal or replacement is reported under the directory's own name (a rename on Linux, a change on macOS), and a name filter lets that name through when the folder at the path is no longer the one the watch bound, so the watch is derived again and rebinds. The handle itself then moves onto the folder made again, because every later event naming the directory is judged against the folder the handle bound, and a stale one would let each such event through. The same name with the folder unchanged is not let through: macOS reports one whenever a child comes or goes, and so does a chmod, so letting it through would reload the config on every write beside it. A derive that finds a directory briefly gone keeps the watch it holds rather than trade it for one the OS refuses. A strict ancestor renamed away and another tree put at its path reports nothing to the handle; the period that judges every directory watch catches that (data-sources.md).

A click writes to the session's home file: the explicit path if there is one, else the user's XDG file, which is created on first write. It never writes a project or cwd layer, because that's somebody's repository.

Every write first loads and validates the text it's about to write, and refuses it if it wouldn't load. It also refuses a change that a layer above the home would hide, and names that layer.

Precedence, lowest to highest: bundled default < file < active preset < session pick < edit-mode staging.

## Settings are rows

Every globals field is one row of the fields table. The schema, the resolved globals, the menu control, the option domain, the payload field and the save format all derive from that row. A new setting is a row, the code that uses its value, and its tests. Controls are generated from the row's domain. A field no control fits is text-only. A field only the file sets has no control and no session pick; colour depth is one of these.

## Drafts, save, reset

A draft is derived, never flagged. It's a setting whose session value differs from what the file resolves to under the preset the save will land in. Save recomputes the drafts at click time against the config the session renders with, so it writes exactly what the button counted.

Save writes, reloads, then releases the picks, all in one handler. So no render draws the old file without the picks, a refused write keeps every draft, and a released session follows later changes to the file instead of pinning over them.

Reset deletes the setting at every layer: the globals, every bundled preset's globals, and every theme's default. A preset the user wrote keeps its pinned value, because that pin is the user's own content.

## Undo, and edit mode

Undo and redo work one step per click. A journal around every verb handler records each step, storing the whole file before and after for every file written. A step whose target no longer reads as it left it (after a hand edit, or another session's write) is refused loudly, and every change to that target drops off the stacks.

Edit mode's save and cancel are that history and nothing more. Layout clicks are already written to the file, so entering edit mode takes a savepoint, and cancel applies the net change backwards as one step. A target someone else changed in the meantime is kept, never overwritten. Undo and redo can't bring cancelled edits back. The savepoint is taken and released at the one place every click's writes pass, so any control that enters or leaves edit mode needs no bookkeeping of its own. There's no per-session unsaved layout, because the render cache holds one compiled tree per project and cwd, not per session.

## Placements

A segment declaration is a definition. Each node in a layout is a placement, identified by its id or, failing that, the segment name. Per-instance state is keyed on that id.

- A removal target or an anchor is a placement id, and it's checked only at click time. A load-time check would reject the config its own click wrote.
- An insertion mints its id at click time, over the rendered tree.
- Configuring is a level inside arranging and is held in its own key, so configuring two placements at once can't be represented, and leaving edit mode by any control clears it.
- No variable may live under `settings`, because that name holds the placement's settings.
- Every placement has a theme setting and an effect setting without declaring them, and a segment that declares either is an error.
- If a helper reads a setting, the segment that calls it must declare that setting.
