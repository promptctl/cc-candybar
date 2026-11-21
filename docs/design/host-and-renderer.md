# Proposal 3: the host and its renderers

**Status:** draft for review · **Replaces:** the process shape of Proposal 1 ([gather-and-renderer.md](gather-and-renderer.md)); §15 lists what of it stands · **Answers to:** [goals.md](goals.md) · **Ticket:** `candybar-gather-renderer-76bb.215`

## 1. Summary

One process, the **host**, is the bar's boundary with the world: every input enters through it and every effect leaves through it. It reads the world into each session's world state, receives client requests, clicks and timers, and performs effects. It calls **renderers**: any number of identical pieces of code that are each handed world state and events and answer each one with frames to present, effects to perform and the sources their state needs read. A renderer never touches the world, never reads a clock it was not handed, never starts a conversation, and never controls the host's lifetime. The split is functional core, imperative shell: the host is the shell, and each renderer is a functional core. Every renderer runs in its own process, which the host starts from the bundle its name is bound to. There is one kind of renderer: a renderer is a name bound to a bundle, and renderers differ only in values. The hard parts are keeping the host one job with internal parts rather than a god process, and keeping the round trip to a renderer inside the statusline's latency budget.

This is the shape real systems with the same problem use. §4 says which, and what each one teaches.

## 2. Intent

Each entry is what the design must achieve, with where the need was stated and the observation that would show the design fails it. A review checks the design against this table; a later reader checks the running system against it. An entry whose falsifier fires is a defect in the design, not in the code. The Why column is this design's reasoning; Brandon's own reasons, and which are inferred, are in goals.md.

| ID | Intent | Why, as this design reads it | Source | Falsified by |
|---|---|---|---|---|
| I-1 | A session's bar can be drawn by a worktree's code while every other session's bar keeps its own. | Most development happens on worktrees, and the bar is the thing being developed. | goals.md G-2 | Drawing one session from a worktree's code needs another renderer stopped, or a session draws code its client did not name. |
| I-2 | Running a second renderer adds no second reader of the world. | A daemon may reserve about a gigabyte, and a naive second daemon duplicates disk reads and processes. | goals.md G-2, R-10 | With two renderers running, a session's transcript, repository or sources are read twice. |
| I-3 | The browser is a full surface for any user with the existing prerequisites. | It is the first of the two goals and the reason surfaces are a seam. | goals.md G-1, R-14 | Adding the browser surface needs a change to world state or to what a renderer decides, beyond drawing a frame for one more surface and the host's adapter for it. |
| I-4 | The world has exactly one owner. Everything that enters the system or leaves it passes through the host. | One owner is the only place an effect and the observation of its result can be ordered, validated and recorded. | goals.md R-8 | Any part of the bar other than the host reads a file, a socket, a clock or tmux, or performs an effect the host did not reply with. The client printing a failure and the forwarder showing a refusal relay the host's reply. |
| I-5 | Data goes one way around one loop. A renderer only answers the call it was given and never initiates a message. | A renderer that reaches upstream makes a second loop with no owner, and every new need becomes another upward message. | goals.md R-8 | A renderer sends anything that is not the answer to an input. |
| I-6 | Clicks are pure. A click, a timer and a future webhook are each an event; handling one is a state change plus effect descriptions. | Clicks that flip switches couple behaviour to timing; the source of a change must not matter. | goals.md R-7 | A verb's handler performs an effect itself, or a timer or click reaches state by a path other than an event. |
| I-7 | Draw writes nothing and reads nothing. | A draw that writes cannot be replayed, tested without mocks, or trusted to show only what happened. | goals.md R-11 | A replayed input stream shows a read, a write, a clock read or a spawn during a draw. |
| I-8 | There is no dev mode. Every renderer can perform every effect; a renderer differs from another only in values, and isolation is where it reads and writes, never what it may do. | A subset of behaviour is a toggle that the main bar never exercises, so it rots. | goals.md R-12 | What a renderer may have performed differs by its name, or any renderer has an allow-list of verbs or effects. Where a renderer reads and writes may differ by name; that is isolation. |
| I-9 | A click carries an address, and the address alone decides which renderer handles it. | Routing by state needs a table that has to survive restarts and can disagree with the frame. | goals.md R-9 | Delivering a click needs any lookup beyond the renderer name in the click. |
| I-10 | A renderer stores no path, and `ProfilePath` is the host's alone. | A copied history must not be able to write the user's files. | goals.md R-13 | A path in a renderer's stored state or undo history. |
| I-11 | Claude Code's request is answered with the frame of the renderer that session uses. | The client gets one answer, and it is the bar the session asked for. | goals.md R-9 | A session's statusline shows another renderer's frame. |
| I-12 | The payload a template reads carries every value it reads, and metrics, activity and session are in it. | A value that reaches a template outside the payload is a second path. | goals.md R-5 | A template reads a fact from anywhere but the payload. |
| I-13 | Nothing is decoded from rendered ANSI. | Decoding output to recover state inverts the pipeline. | goals.md R-1 | A state decision depends on decoding ANSI. |
| I-14 | The design is built from generally useful primitives, in data, under the laws. | Primitives with no consumer yet are how later work becomes cheap. | goals.md C-1, C-2, C-3 | A part exists only to serve one feature, or variability lives in a branch instead of a value; or a step's laws review finds a violation the step does not mark as an exception. |

## 3. Assumptions

Each must be true for the design to work. Each has a probe or measurement that would show it false. §17 records what each has shown so far.

| ID | Assumption | Falsified by |
|---|---|---|
| A-1 | The round trip from the host to a renderer's process costs the statusline little against today's daemon, which draws in the process that answers the client. | The request event's p99 `took`, over a day of real use, is higher than today's by more than 2 ms (a parameter). |
| A-2 | Everything a config load learns from the filesystem can be learned by the host first and handed in as one value: the layers' texts, their real directories, plugin folder listings, repository trust and the checkout. Today that discovery stats candidates, resolves real paths, lists plugin roots and walks `.git` before any text is read. | The loader, given the host's `ConfigSnapshot`, needs a fact about the filesystem the snapshot does not hold. |
| A-3 | No verb needs to read the world and write it in one atomic step that a `change`, guarded by the values it read, cannot express. | A test that changes a verb's target between the renderer's read and its `change` gets a wrong result instead of a refused change. |
| A-4 | launchd can own the host's lifetime through socket activation at the socket path installed clients already dial, with the environment the host needs. | A probe: a user LaunchAgent with a `Sockets` entry at `/tmp/cc-candybar-<uid>/socket` does not start the host on the first connect, does not restart it after it exits, fails after a fresh boot has cleared `/tmp`, or starts a host that cannot find `node`, `tmux` or `git`. |
| A-5 | A renderer's output for one input is small enough to cross a socket at animation rate, 30 inputs a second, without lag. | An animating session drops frames, or its inputs back up in its mailbox. |

## 4. Precedents

From general knowledge of each system; the details are not checked against current documentation.

| System | Host | What it calls | What it teaches here |
|---|---|---|---|
| Chrome | The browser process owns the network, disk, cookies, windows and all OS input. | Sandboxed renderer processes, one per site. Input is routed to the right renderer by frame. A renderer asks for a fetch or a storage write over IPC, and the browser process validates the request before doing it. | One host owns the world. A renderer asks and never acts. The host is the single place requests are validated. The host spawns renderers, never the reverse. And the warning: Chrome's browser process became the god process, and Chrome later moved its network stack, storage and audio out into service processes. The host here starts as one process whose parts meet only through interfaces, so a part can leave it the same way. |
| WidgetKit | The system owns the widget's surface, when it renders, its refresh budget and taps. | The app's widget extension, which is invoked and returns a timeline: values paired with the times to show them. An interactive button is bound to an App Intent; on a tap the system runs the intent's `perform()`, then reloads the timeline. | Code that knows the domain is not the process that owns the world. "Perform, then refresh" is sequenced by one owner, which is what `run … refreshes` needs. |
| launchd and XPC | launchd owns process lifetime. | Services addressed by name, started on demand when something connects. | A client never spawns the thing it depends on, and an address is a name. |
| The Elm architecture | The runtime. | `update`, which is pure and returns the new model and commands; subscriptions, a function of the model the runtime reads. | Effects are returned, not performed. What to listen to is derived from state and owned by the runtime. |
| Audio plugin hosts | The DAW owns devices, buffers and the clock. | A plugin's render callback, called with a buffer and a time. | The callee is handed time; it never reads a clock. |

## 5. Architecture

```
            launchd (owns the host's lifetime)
                       │
                       ▼
 Claude Code client ─┐ ┌───────────────────── host ─────────────────────┐
 URL handler ────────┼▶│ Endpoint ─▶ Router ─▶ per-renderer mailbox      │
 tmux, files, ───────┘ │ Collector (world state) ────────▲    │          │
 timers                │ Interpreter ◀── effects ────────┼────┘          │
                       │ Supervisor ── starts, ends ─────┘               │
                       └──────────────┬──────────────▲───────────────────┘
                                      │ input        │ output
                                      ▼              │ (frames to present,
                              renderer: Events ─▶ State machine ─▶ Draw
                              (each in its own process, started from the
                               bundle its name is bound to)
```

There are two kinds of thing and one direction of call. The host calls a renderer with one input at a time and awaits its output. The renderer depends on nothing; the host depends on the renderer interface. The one loop goes renderer, host, world, host, renderer, and the host owns every turn of it. [LAW:one-way-deps] [LAW:effects-at-boundaries]

## 6. Components

The host is one job, the bar's boundary with the world, done by parts that each have one. It holds no renderer logic: no part of it knows what a verb means, what a template says, or what a renderer's state is. [LAW:decomposition]

**Endpoint** (host, prototype)
- **Responsibility:** accepts every connection from outside: the Claude Code client, the URL handler's forwarder, and later the browser listener and webhooks.
- **Inputs and outputs:** client requests with their session context; URL frames. Out: each one as an event for the router, and each request's answer back to its client.

**Router** (host, prototype)
- **Responsibility:** turns each input into an event for the renderer it names, and keeps one mailbox per renderer.
- **Inputs and outputs:** a request names its renderer by the `renderer` field of its session context; a click by the `to/<name>` in its link. Out: one input at a time to each renderer. Ordinary inputs retain their arrival order. A renderer start can lead the waiting inputs, and a scheduled turn gets a slot after at most eight ordinary slots while it waits. A request waits in the host between its session's `context` turn and its own, until its session's world state has no unread field the wait covers, up to the client's deadline, so a renderer's turn never waits. The wait holds no place in the mailbox: other inputs go ahead of it, and a retire that drops a run it waits on ends the wait on that run. The `context` turn comes first so that the subscriptions the draw needs are with the host, and their readings in the wait, before the request's turn; an origin it names first has its `config` turn in that slot. If preparing that origin fails, the host answers the original client before waiting for sources. A new context can retry a snapshot that failed to reach the renderer. On success, the host retains the original request ID and encoding across the source wait and settles the request's one present when its client takes or declines the reply.

**Collector** (host, production for what exists)
- **Responsibility:** reads the world into one complete world state per session, as Proposal 1 §12 specifies.
- **Inputs and outputs:** the locators of the sessions the host has seen, the union of every renderer's subscriptions, each judged as it arrives (§7), file and tmux events, its own periods. Out: a `world-state` event for each renderer that holds the session, newest-wins per session. One change to a session's world state costs one event and one turn in each renderer holding that session.

**Config discovery** (host, production for what exists)
- **Responsibility:** finds what the config at an origin is made of and hands it in as a `ConfigSnapshot`.
- **Inputs and outputs:** the origins the renderers' subscriptions name; repository trust; file watches over what each discovery read. Out: a `config` event for an origin when it is first named and whenever its snapshot changes.
- Config watches gather changed origins in the same watcher window. Their discovery shares each physical file read, then sends changed snapshots to the renderers that hold them. A failed origin keeps its previous snapshot so it can be retried while successful observations are still delivered.
- Checkout labels share the host's bounded filesystem observations for one second, keyed by paths after resolving directory aliases. Repository admission uses a fresh discovery batch, which can refresh the observations used for display.
- Config and plugin definition text is reused across discovery batches when the opened file has the same identity and revision. The host lists every installed plugin root and opens the highest-precedence definition for each name. A config can also name a definition by path. Discovery chooses and authorizes each origin's layers and resolves paths against the authored layer.
- When discovery reads a regular file that the host then polls, the first sweep compares the path with the opened file's revision. Deletion between the read and watch acquisition then refreshes the held snapshot.

**Effect interpreter** (host, prototype)
- **Responsibility:** carries out the effects a renderer returns and reports each outcome to it.
- **Inputs and outputs:** effects, in the order their turn returned them; it parses and validates each one, then hands a frame or a surface switch to that surface's adapter and does the rest itself. Out: `effect-done` events; for a `run` with `refreshes`, those sources held pending until the program exits and the collector has re-read them.

**Surface adapters** (host, production for what exists)
- **Responsibility:** one per surface: sets it up, shows the frames presented to it, reports its viewers, and tears it down.
- **Inputs and outputs:** `present` and `surface` effects from the interpreter. Out: `viewer` events. The tmux adapter opens and closes the bar pane from effective display settings.

**Supervisor** (host, prototype)
- **Responsibility:** starts, restarts and ends renderers, and hands each its start input.
- **Inputs and outputs:** a renderer name and bundle from the router; bundle changes; renderer exits. Out: a running renderer, or a loud failure naming the renderer and its bundle.

**Recorder** (host, prototype)
- **Responsibility:** writes a renderer's input stream to a file when asked, and writes every record a renderer returns to the log.

**Renderer** (prototype for the interface, production for the state machine and Draw as they exist)
- **Responsibility:** answers each input with what to present, what to do and what to read.
- **Inputs and outputs:** §7.
- **Inside:** Events → State machine → Draw. The state machine is the one writer of the renderer's state; Draw is a pure function of world state, renderer state, config and the instant it was handed.

A live session has one renderer record containing its current context and its latest world document. Only a context turn opens that record. World updates apply during its lifetime, and retirement ends it along with any waiting work. When config arrives, a waiting view or click uses the session's current origin and context. A statusline request draws from that same record and returns its present in its own turn.

A draw returns frame observations and the daemon events its diagnostics show. A completed statusline reply or pane write acknowledges the corresponding event at the host, even if the renderer has since restarted. Cached feed frames keep their event identities. Equal bytes can reuse a confirmed write for the same occurrences. The host compares each acknowledged occurrence with the latest event from its owner.

The renderer's `effect-done` records accepted layout, cells and diagnostics by surface, with one motion and menu baseline per session. An older completion can fill its surface without changing newer session motion. View replacement and feed closure retire the matching presentation targets, so their pending receipts can settle without restoring the old layout. The successor view can still serve the copy text from a frame that remains visible.

An open pane feed keeps its config entry pinned when its view fails to open. A successful changed config delivery can reopen the view using the session's current context. Frame ticks read the ready view or show its opening error.

## 7. Interfaces

### The renderer interface

The in-process and child-process transports use the same renderer contract. The host constructs each renderer with resolved locations, its memory limit and stored values. Construction can succeed or refuse and can produce diagnostics in either case. The host keeps the session environment and the link-signing key. [Renderer contract](../../src/renderer-interface/interface.ts)

The first event is `start`. It carries the live session contexts, their world states, their viewers, and config snapshots by origin. A replacement can receive the authorized revision its predecessor selected alongside the latest observation. Subsequent inputs deliver requests, admitted clicks, world or config changes, scheduled draws, viewer changes, effect completions and session retirement. Inspection and shutdown use the same mailbox and turn clock.

Every completed event returns its outcome, frames, effects, record, store writes, subscriptions, next wake and any diagnostics. A failed turn can still have writes or effects from work it completed. The `stats`, `debug`, `close-journal` and `close-views` events add a typed reply to the same result on success. The host accepts the reply for the event it sent. Private wire v13 carries the host’s resolved locale and time zone at boot. Each input and its answer share a sequence number. The renderer transport measures the turn with its own monotonic clock. The host measures the round trip, reports the time beyond the turn as transport overhead, and performs the effects. The host records an interrupted input when a worker exits before answering.

```ts
interface Subscriptions {
  readonly sources: Readonly<Record<SessionId, readonly Subscription[]>>;
  // Managed storage folders named by retained configs, including idle configs.
  readonly managedFolders: readonly string[];
  // The lanes each viewed session switches on. The host gates subscribers on
  // them and reconciles the tmux bar pane for each session with a pane target.
  readonly lanes: Readonly<Record<SessionId, LaneSwitches>>;
  // The origins whose config the renderer holds: each live session's, and
  // each a parked event waits on. The host discovers an origin as it is first
  // named, follows its files while it is named, and lets it go when it is not.
  readonly configs: readonly RenderOrigin[];
  // Authored revisions this renderer successfully retained at those origins.
  readonly configSelections: readonly ConfigSelection[];
}

// Where a declaration came from is what repository trust is judged on. A layer
// or plugin is named within the snapshot of the origin it is declared at.
interface Subscription {
  readonly decl: SourceDecl;
  readonly from: { kind: "bundled" } | { kind: "layer"; role: LayerRole } | { kind: "plugin"; plugin: PluginRef };
}

// Where a config is discovered: the project directory, the working directory,
// and the file `--config` names, if any. Every session at one origin shares
// its snapshot.
interface RenderOrigin {
  readonly projectDir: string | null;
  readonly cwd: string;
  readonly configFile: string | null;
}

// What the host's config discovery found at one origin: the imperative-shell
// half of today's load, as a value. Parse, merge and validate are the
// renderer's, in its functional core. The bundled layer ships in the
// renderer's own bundle.
// [LAW:types-are-the-program] It holds every fact a load learns from the
// filesystem (A-2), so the renderer never asks the disk for one.
interface ConfigSnapshot {
  readonly chain: readonly Layer[];          // lowest precedence first; every layer in it is writable
  readonly repo: RepoQuestion | null;        // null: the origin's directories hold nothing to ask about
  readonly plugins: readonly PluginFile[];   // installed and the approved repository's, one per scope and name
  readonly strays: readonly Stray[];         // loose files in a plugin root, each dropped naming where it belongs
  readonly checkout: Checkout | null;        // the root a plugin's `data.checkout` resolves against, or a read failure named in notices
  readonly notices: readonly string[];       // what discovery found wrong: a shadowed file, an unlistable root
  readonly watch: string | null;             // what the config's watch cannot hear, or null
}

// A chain is user, project, local. The file `--config` names is the user layer,
// and it replaces the chain, as today, so the chain is that one layer. A
// repository's layers are in the chain only once it is approved.
// A role names one layer within its origin's snapshot.
type LayerRole = "user" | "project" | "local";

interface Layer {
  readonly role: LayerRole;
  // Where the layer lives: messages, the directory its `run` actions start in,
  // and the menu's link to the file. A write names the role, never this.
  readonly path: string;
  readonly content:
    | { readonly kind: "text"; readonly text: string }
    | { readonly kind: "absent" }                               // not written yet: a write creates it
    | { readonly kind: "unreadable"; readonly error: string };  // maybe there, and not read: no layer of the merge, a notice, and no write
  // The definitions the layer's `plugins` list names, by each entry as written.
  // Discovery reads that one key, as a preprocessor reads its includes.
  readonly listed: Readonly<Record<string, PluginFile>>;
}

// The one repository an origin's directories belong to. Project and local
// share its answer, kept under `dir`: a linked worktree's main checkout.
interface RepoQuestion {
  readonly dir: string;
  readonly standing: "approved" | "declined" | "awaiting" | "unread";
  readonly unproven: string | null;          // why the directory's worktree link could not be proven
}

interface PluginFile {
  readonly scope: "plugins" | "repo";        // installed, or the repository's, which come with its approval
  readonly path: string;                     // the definition: its identity, its messages, its `data` path's base
  readonly definition:
    | { readonly kind: "text"; readonly text: string; readonly dir: string }   // dir: its folder's real path
    | { readonly kind: "unreadable"; readonly error: string };
}

interface Checkout { readonly root: string; readonly git: boolean }

// A loose file carries the scope of the root it sits in, so an unnamed drop
// answers only for names in its own scope.
interface Stray { readonly path: string; readonly scope: PluginFile["scope"] }

// Scope and name name a plugin within its origin's snapshot.
type PluginRef = { readonly scope: PluginFile["scope"]; readonly name: string };
```

- **Every input gets exactly one output.** The host sends the next input to a renderer only after the last one's output arrived. That serialization is the state machine's turn, owned by the renderer's mailbox in the host. A turn is synchronous, and inputs are plain data. [LAW:no-ambient-temporal-coupling]
- **A multi-step act is a chain.** Each step is one effect, the chain's phase is state machine state, and the state machine returns the next step when the last one's `effect-done` arrives. `type-slash` is one step because its check and its act must not be separated. A pane's identity is one function of the pane, with no per-request stamp.
- **A request is answered by its `present` effect.** The statusline arm of `present` carries the request it answers, and only that arm does. A request whose output holds no such effect is answered with a failure naming the renderer, never with an empty bar. One mechanism delivers every frame to every surface. [LAW:one-type-per-behavior]
- **Time is handed in.** Every input carries `at` and `tick`, read by the host as the input's slot comes. A renderer reads no clock and sets no timer: every output declares the tick it next wants a turn at, and the host hands in a `due` when it comes. A renderer's due turn runs the work it held for that tick, closes idle menus, and draws its feeds' frames. It leaves a session’s menus open while that session has an admitted click waiting to land or a click parked on its config. The wake summary reports the longest mailbox wait separately from turn time. Animation is a renderer declaring its next frame's tick.
- **One-off draws need a recipient.** The host still delivers the session context from a statusline hook that lost its client, so a pane or another render can use the newest shared observations. Only a live recipient needs a source wait or a one-off draw. The host checks the connection and reply deadline before scheduling the draw and again at mailbox admission. The source wait leaves the existing draw reserve. An older client with no stated deadline can still take its reply until the connection backstop.
- **The state a draw used to write is the state machine's.** Animation clocks are renderer state keyed by session and surface. The draw returns a frame and its memory as values; the state machine stores them. A frame drawn for a session reflects every event whose turn completed before the draw began, and no part of one whose turn has not. [LAW:effects-at-boundaries]
- **Subscriptions replace `follow`, `declare` and `key`.** The host knows every session's locator from the requests it receives. A source's key is evaluated by the renderer over its own store, as today, and its digest travels in `subscriptions`; two renderers subscribed to one digest share one run, and a new key is a new run served stale-while-revalidate: the old reading stands until the new one lands. That is still a loop from world state to keys to reads to world state, but it is the one loop and the host owns it, the way the Elm runtime owns subscriptions. A declaration has one canonical form: its environment names are a sorted set, every digest is taken over JSON with keys sorted at every level, and a session's subscriptions leave in digest order. So two declarations that mean one read are one run, and an output is the same bytes whatever order a config declares in.
- **The collector is the one checkpoint for reads.** A subscription asks the host to read a path or run a shell command, so the collector judges every declaration when it arrives: absolute paths, regex captures and the shell sources' minimum TTL with the loader's own specs, and repository trust by the layer or plugin a declaration came from. A refused declaration is a failed reading for that source, with the reason. The renderer's loader parses declarations and does not judge them. [LAW:single-enforcer]
- **A command runs in the variables it names, read from its session's environment.** The client sends the environment Claude Code gave it as part of the session context. A `shell` declaration names the environment variables its command reads, over a base set that is data in the bundled default. The collector parses a declaration and its session's environment into a run identity, which carries each named variable's value, and spawns the run with exactly those variables. So the identity holds everything the output depends on: sessions whose named values agree share one run, which is how the sessions of one directory cost one spawn, and no run sees a variable its declaration did not name. The `env` source reads the session's environment, and a `run` lays its program's `env` over it. The host keeps the environment with the session's locator, and no renderer input carries it: a renderer runs nothing, and an environment holds keys and tokens that a recording must never capture. The host's own environment is never a session's. [LAW:one-source-of-truth] (docs/design/per-directory-sources.md)
- **Repository trust guards against repository content, not against renderers.** The collector judges a declaration by the origin the renderer reports, which a repository's files cannot forge. A renderer is code the user installed or built.
- **Config arrives as discovery's result, by origin.** A snapshot is a fact about an origin, shared by every session there, so it is keyed by origin end to end and never rides a session's turn. The renderer names the origins it needs in its subscriptions: each live session's, and each a parked event waits on. The host's config discovery resolves an origin's layers, real directories, plugin folders, repository trust and checkout, reads their texts and the definitions each layer lists, and hands the result in as a `config` event when the origin is first named, in the slot of the turn that named it, and again whenever a watched file moves it. That event is made as its slot comes, from the snapshot discovery holds then. The renderer parses, merges, validates and compiles it and opens no file, and a reload whose load inputs did not move keeps the state it serves. A path appears only as display text for messages; a renderer names a file by its origin and role. [LAW:effects-at-boundaries]
  Each renderer's declarations replace its own held origins. Renderers naming the same origin share one snapshot and watch, and the host releases both when the last renderer lets the origin go. A process restart keeps the previous declaration until the replacement successfully completes its start turn. A landed write updates the shared snapshot, reloads the writer in its current slot when it still holds the origin, and queues a reload for every other holder.

  The renderer keeps one delivery outcome for each retained origin. Pending config parks the context or click that needs it. A rejected delivery supplies the same failure to requests and clicks and makes live views read-only with that diagnostic. A live view can keep drawing its last working config during an authored error while the project decision still permits that build. After approval is withdrawn, live and replacement renderers both select the permitted fallback and keep the current diagnostic. A bundled fallback follows the plugins in current discovery. When those inputs stay equivalent, it reuses the same compiled state. A later successful delivery restores edit availability when the authored config loads. Releasing the origin also releases its delivery outcome.

  One approval covers the project across sessions, installed and worktree renderers, config edits and daemon restarts. Layered discovery follows the repository answer files it consulted. A repository can contribute plugin files even when its renderer has no question to display. The host watches the current answer file and, while it is missing, the older file directly under the state directory. The next explicit decision carries the older contents forward when needed and archives the superseded file beside its former name as `repo-configs.json.migrated-<id>`. Discovery never consults this backup. Both changes commit with any config edits from the click. Removing the current entry resets the project. An unreadable current file produces a diagnostic. All renderers share the file revisions and polling, and `--config-only` uses neither answer file. The same approval admits reads and writes for both project layers and opens repository plugin definitions. The host reports a directory-listing failure once even when the project has no config file. Repairing the directory follows the existing decision.

  The host reads equivalent spellings of a stored directory as one project, including a trailing separator. If an exact entry exists, it supplies the decision older versions used. Conflicting aliases without an exact entry make the file unreadable. A changed decision writes the resolved spelling. Reading the file leaves its bytes intact.

- **An event waits in the renderer for its origin's config.** An ordinary `context` or a click for an idle session can arrive before its origin’s first config. The renderer parks that event and declares the origin. At `start`, the host offers the config snapshots alongside the live contexts, so the replacement opens them in that turn. The `config` turn replays them in arrival order, so their effects are its output, in the original slot, and a click's answer still covers what it did. A request never waits there: its session is live from its opening.
- **Stored state arrives at start.** The host reads settings history and session picks from the renderer’s profile and supplies those values in the boot message. Each subsequent turn returns its collected store writes to the host.
- **Clicks arrive verified.** The host signs Candybar links when publishing request and feed frames. It verifies that signature before routing each click. The renderer decides what the click means. [LAW:single-enforcer]
- **A link means the same thing on every draw.** A stepper's link carries its step, never the value it will produce, so its URL is the same before and after a click. A terminal that keeps the link it found when the mouse last moved still sends the right click, and five clicks without moving the mouse land five steps.

### Effects

```ts
type Effect =
  | { kind: "present"; session: SessionId; surface: "statusline"; request: RequestId; frame: Frame }
  | { kind: "present"; session: SessionId; surface: PushedSurface; frame: Frame }
  | { kind: "change"; target: FileTarget; changes: readonly Change[] }
  | { kind: "store"; store: StoreName; key: string; value: JsonValue | null }
  | { kind: "type-slash"; session: SessionId; pane: Pane; line: SlashLine }
  | { kind: "run"; session: SessionId; program: Program; refreshes: readonly SourceId[] }
  | { kind: "approve-repo"; session: SessionId; origin: RenderOrigin; dir: string; answer: "approved" | "declined" }   // dir: the one its signed link asked about
  | { kind: "open"; session: SessionId | null; url: string }
  | { kind: "copy"; session: SessionId | null; text: string };

type Surface = "statusline" | PushedSurface;
type PushedSurface = "statusline" | "pane"; // a browser is future work

// [LAW:types-are-the-program] A renderer names a document it was handed, never
// a path, so no stored effect or undo entry can hold a path (R-13).
type FileTarget =
  | { kind: "layer"; origin: RenderOrigin; role: LayerRole }   // any layer of a subscribed origin's chain
  | { kind: "claude-settings"; session: SessionId };    // the session's Claude Code settings, from its session context

// A value crosses as JSON5 text, so a copied row keeps its comments and an
// inline placement stays inline. The empty address is the document.
type Change =
  | { op: "replace"; at: Address; text: Json5Text; read: Read }
  | { op: "insert"; at: Address; text: Json5Text; precedes: string | null }   // the setting is absent; it goes before `precedes`, or last
  | { op: "remove"; at: Address; read: Read };

type Read =
  | { kind: "value"; text: Json5Text }   // agrees with any text of the same value
  | { kind: "file"; text: string }       // the whole document, byte for byte
  | { kind: "absent" };

// Today's run action, with its directory named, never spelled.
interface Program {
  readonly argv: readonly [string, ...string[]];
  readonly env: Readonly<Record<string, string>>;   // laid over the session's environment
  readonly cwd: { kind: "layer"; role: LayerRole } | { kind: "plugin"; plugin: PluginRef } | { kind: "user-home" };
}
```

`Address` is a setting's place inside its document, the keys and indexes from the document's root. `StoreName` is one name per durable store the profile holds; `SlashLine` is a slash command and its arguments, already parsed by the grammar the bar uses today; `Pane` is a tmux pane and its server, from the client hints the renderer holds for the session.

- **An act carries where it goes.** A slash line, a restart and a surface name the pane they act in, from the client hints the renderer holds for the session, so an act after a daemon restart goes where the bar the user clicked was drawn. A session that reported no pane is refused by the renderer, with the hints' own reason, and no act is sent. The band's install is the exception, because it needs no pane: it carries the session's tmux facts as reported, and only its `/reload-plugins` is refused outside tmux. The host decides nothing about where an act goes.
- **A turn's acts follow its landing.** Every act in a turn is performed only once the turn's changes and its trust-book answers have landed, in the order the turn returned them. A turn with no changes lands at once, and the daemon's close is one more landing outcome, `closing`, so no act starts once the close has begun, and each settles `closing`. An act whose changes were refused or failed is `skipped`, holding no error of its own, since the changes' outcome already says why. An act over in its turn (copy, open, a slash line, an update) is settled before the click is answered; a run, a restart and a surface outlive the click, and their `effect-done` arrives when they end. An act's failure shows on its session's bar, joining a click error no answer has carried yet. One with no session, or whose renderer has ended, shows on every bar as the daemon's.
- **Every effect names its operation.** There is no `tmux { args }` and no free-form command, because a raw command admits every command and the safety of a slash line or a run could not be expressed in it. A run link's program is the declaration its link signed, as today. [LAW:types-are-the-program]
- **Every write target is named, never spelled.** A `layer` is named by an origin the renderer subscribes and its role in that origin's chain; the interpreter refuses an origin discovery does not hold. `claude-settings` is reached through a session the renderer holds. Durable state is written by `store`, so no target names a file under the profile. Undo stores these names, so a history copied to another renderer resolves only against what that renderer was handed.
- **Which layer a write goes to is a value.** Every action that writes config names its target: a role, or `ask`, which offers the session's approved layers. The bundled config sets today's behaviour: steppers, persist actions and edit mode write the user layer, and save asks. Changing a default is a config edit. Undo writes to the layer its step wrote.
- **Save asks which layer.** It offers the layers of the session's chain:
  - **user:** the profile's config file, or the file `--config` names. With `--config-only`, the user layer is the only one.
  - **project:** the project's checked-in `.cc-candybar` file.
  - **local:** `.cc-candybar.local` beside the project's file, holding one person's settings for that project.

  Local merges above project, so a local value wins over the shared one. When the interpreter creates a local file, it adds the file to the repository's exclude file (`git rev-parse --git-path info/exclude`, which every worktree of the repository shares), so git never shows it. The local layer loads under the project layer's approval, because a clone can commit a file by that name.
- **A config write is a `change`, and the renderer decides what it means.** It decides from the schema in its own bundle: a step's arithmetic, which settings a reset clears, where a layout insert goes. It returns plain changes, each `at` a setting's address inside the document its target names. The host never knows the schema, so a renderer can add a setting without a host install. A host-side verb, such as save a preset or step, would put the schema in the host.
- **The host checks current settings before it writes.** It opens the destination and uses discovery's shared text when the physical revision matches. It reads a changed revision through that descriptor. A missing file can be created. An unreadable file fails the write. The host compares each setting to the renderer's `read` value, keeps unrelated edits and comments, and refuses the whole change if a setting it touches has moved. Edits through different directory aliases compose on the same directory entry. Separate hardlink names have separate entries.
- **A turn that changes a config layer ends after its batch settles.** Config discovery is the one writer of every `ConfigSnapshot`. It reobserves the files the batch published or could not restore and notifies their subscribed origins. The writer receives each moved origin's `config` in the click's own mailbox slot before `effect-done`. Other writers reach discovery through the watcher. The per-setting `read` guard checks a click against the file as it stands and names a changed setting when it refuses a write. Every change settles with the same batch outcome. Discovery represents read failures as notices or unreadable layers and definitions.
- **A click applies its consequences after its file batch succeeds.** If a publication fails, the host attempts to put each earlier file back in reverse order. A complete restore needs no immediate targeted discovery. The regular poll may still observe a changed file revision. A failed batch reports its error on the `⚠` and leaves the draft available. A successful batch applies its history step and any saved picks in the click's mailbox slot.
- **`type-slash` checks, then acts.** The interpreter reads the pane and refuses unless it shows Claude Code's bare input box, then stashes, pastes and submits, in one effect. Slash typing and bar-pane changes for the same pane run through its serial queue. The user can still come between the check and the act, in the gap between two tmux calls, as today.
- **`run` carries its refreshes.** The collector holds each named source pending from the run's start until the program exits and the source has been re-read. The host owns that order. A run's program runs in its session's environment (above).
- **Repository trust is the host's.** Which repositories may run commands is a security decision, so the host keeps the answers and resolves config by them; a click that answers the question returns `approve-repo` for the directory its signed link asked about, at its origin, and the interpreter refuses it unless that is still the origin's repository, so an origin whose repository moved since the draw cannot approve a directory the user never saw. The answer lands with the turn's config changes, its book rewritten and put back with theirs, so a click whose changes are refused records no answer. [LAW:single-enforcer]
- **The interpreter is the one checkpoint for effects.** It parses each effect from the wire, refuses a target the renderer was not handed and a slash line that does not parse, and reports a refusal as a failed `effect-done`. A refusal is a fact the renderer holds for the bar like any other failed effect. Every renderer may ask for every effect; validation is about where, never what. [LAW:parse-dont-validate]
- **Managed plugin storage is shared.** A renderer declares which sources its compiled configs use. The host admits folders from that renderer's current or retained config discoveries and lets a still-declared folder finish serving an in-flight draw. Its storage owner provisions each admitted folder, shares one watch across renderers, and releases it when the last demand leaves. Session reads require the declaring renderer's own admitted folder. A fresh config observation can retry affected folders even when the config text stays the same.
- **Everything the bar does today has a place.** During upgrades the host restores any old tmux status options it still owns. The host reconciles the tmux bar pane from its pane's current session and effective display settings. Configuration changes can arrive through a click or a file reload. The pushed Claude Code statusline uses a manual launcher, and its checkbox gates the resulting feed. The `env` source reads the session's environment rather than the daemon's.
- **One verb is removed under goals.md R-4:** `load-config`, which points a session at a path a click supplies and so would store an absolute path (R-13). The file `--config` names, set when Claude Code starts, is how a session uses another file.

## 8. Addressing and lifetime

- **The host** listens at the socket installed clients already dial, `/tmp/cc-candybar-<uid>/socket`. Ordinary Claude Code statusline ticks currently activate and recover it. Other clients and renderers connect to the available host. A future launchd owner (A-4) must preserve that ordinary statusline cold-start path.
- **The host's bundle is a value the install sets.** The LaunchAgent names the bundle it runs, and installing from a bundle repoints it; the host exits when its bundle changes, as today's daemon does. Host code is tried from a worktree by installing it there, which moves every bar on the machine, as any change to the daemon does today. G-2 asks for the drawing to be iterated per session, and renderers give that.
- **Renderer startup checks the private wire version.** The host advertises it in `boot` and the renderer declares its own in `started`. Both sides require a match before the worker can take inputs. Separate worktree builds can share a host when they speak that version. The daemon still uses its bundle identity for binary currency.
- **Diagnostic lines belong to their answers.** The private renderer wire carries lines from completed turns, including answers with a classified failure. The host writes them in order at their original level before landing the turn. Construction diagnostics travel with the compatible `started` or `refused` boot answer. The supervisor writes them before its boot record, and the in-process transport writes them before accepting inputs. A malformed diagnostic batch is reported and discarded while the rest of the answer remains usable. A rejected transport input carries its failure without a completed turn. When a worker dies, the supervisor identifies any input it sent and whose answer never arrived. Lines held inside that abandoned turn cannot be recovered.
- **Subscription updates belong to the child connection.** On the private wire the first completed output includes the whole declaration, even when empty. Later outputs omit an unchanged declaration and still carry each wake, frame, effect and store write. A change replaces the whole per-renderer declaration. The in-process renderer and child link both hand the host the same declaration identity while it holds, so static draws repeat neither source aggregation nor config following.
- **The host's environment is recorded, not inherited.** launchd starts a process with a minimal `PATH`, so the install records the paths of the tools the host itself runs (`node`, `tmux`, `git`, `gh`) into the LaunchAgent. Everything a session runs uses that session's environment, which its client sends (§7).
- **Renderer startup.** The host resolves home and XDG config and data locations once. At each worker start it supplies those locations, the current stored values for the renderer, and the memory limit. The in-process and subprocess transports both construct the renderer from that data. The renderer process supplies its transport clock and reports readiness before its first numbered turn. A replacement validates its startup data before reporting ready.
- **What needs an install.** A new built-in field of world state, a change to how a source is read, a new effect or a new surface adapter is host code, tried by installing it.
- **A renderer** is named by the `renderer` field of the client's session context: its name from `CC_CANDYBAR_NAME`, absent meaning the default name, `main`, and its bundle, the client's own. A session is moved to another renderer by starting Claude Code with other values (goals.md R-16). Only a Claude Code client's request binds a name to a bundle; no click, timer or later input names code.
- **Every renderer runs in its own process.** The supervisor starts one as the host arms, from the bound bundle, and speaks the renderer interface to it as JSON lines over its stdio. The boot line carries the shared renderer inputs and the private wire version. A worker reports an incompatible version to its supervisor, which puts the reason on the bar. Its life is one state, `starting → live → down → starting`: an input while it starts waits for the start and goes after the start's own, and an input while it is down fails as `down` at once, counted and said once at the next start, so a dead renderer spawns nothing per request. A renderer that ended is started again after a backoff that doubles while each ends within a minute of its start or before its boot answered, up to a minute, and is none after one that lived. A name bound to one bundle refuses a second bundle loudly, naming both, until the first is retired. The site and tests use the in-process transport to draw through the same renderer interface.
- **A start is complete.** A replacement renderer receives one `start` turn with the context and latest stamp of every live session and the viewers of every watched session. The host keeps its existing config holds, follows the origins of the preceding declaration and the live contexts, and offers each current shared snapshot once. The renderer installs those snapshots before opening its pinned sessions and reconstructs retained config entries that have no active session. Each committed entry declares the digest it actually selected, so the host can retain that shared observation when a later authored input fails. The replacement reconstructs an older selected snapshot only while current discovery still admits its project authority, then applies the latest input normally. This preserves the last good bar and the latest diagnostic. A successful start replaces the preceding declaration whole, so a source or folder both declare stays held. During restart backoff the host keeps the last accepted declaration for that renderer name. Daemon shutdown releases all watches. A failed preflight, transport or start keeps the preceding declaration, selections and config deliveries. The host lands the turn's collected effects and store writes, and restores previous config demand before releasing the slot. Only a successful start lets subsequent inputs publish a new declaration.
- **Receipts belong to the worker that issued them.** Each renderer connection maps effects and drawn pane frames into one host receipt sequence across worker restarts. On completion the host sends the issuing worker its original ID. A late completion for an ended worker cannot settle work in its replacement. Filesystem watches and managed folders have their own lifetime under the host's shared subscription cache.
- **A renderer that stops answering is ended.** The supervisor pings a live renderer every ten seconds, answered outside any turn; one owed an answer for a minute, which is well above a compile or a reload of every entry, is ended as hung and started again. A boot is judged by the same minute.
- **The memory limit is the host's whole.** The backstop charges the host and its renderer together: on macOS one `footprint` call over both pids, on Linux the two RSS readings, the renderer's from its latest ping. A breach writes each process's attribution, then the renderer's heap snapshot, then the host's, and the host exits as today. Daemon-stats reports each process's share beside the total.
- **A profile is a function of the name alone.** The default name's profile is today's XDG layout, so an installed bar keeps its files; any other name is `<state root>/renderers/<name>/` with `state/`, `config/` and `cache/` beneath it. Its root is canonicalized once, where the profile is built, so no request reads the disk to compare spellings. Isolation is one value. [LAW:one-source-of-truth]
- **Click admission resolves a session once.** The host sends an ordered list of decoded steps with a single session identity and its held context. Legacy links that only copy text or open a path can omit the session. A session click applies its steps in one renderer journal and returns external acts as effects.
- **Disclosure close carries its drawn arguments.** The renderer sends a typed state write in its frame. The host publishes it through the same signed terminal URL codec used for existing controls and template links. Published frames still carry URL strings.
- **Repository decisions are authenticated by the host.** A question draws the session, repository and proposed answer as data. The host signs those fields when it publishes a link and verifies the same proof before it sends a typed answer. Previously issued links use that same proof. The existing trust-book write checks the session's repository.
- **Run actions carry the draw's arguments and environment.** The host signs the captured run data in the terminal link and keeps its evidence in the click turn. The renderer receives a typed action with a capture index and supplies the current declaration and contextual sources. The host checks the legacy proof before the process can start or outlive its click, then uses the captured evaluation with the session's environment. The signing key stays in the host.
- **An issued action remains usable across redraws.** Its captured arguments travel with the link. Run actions still require the declaration's existing proof, and repository decisions still require the session's repository.
- **Clicks are isolated in the host, and the forwarder learns to be loud.** goals.md R-6 expects the URL handler to change for clicks to be isolated. Here the isolation is the host's: it verifies each link with the host's key and resolves its session before delivery, so the forwarder stays a pipe that passes the URL on unparsed and cannot be wrong about routing. Its change is that the host now replies to every URL, and the forwarder turns a refusal (a renderer the host does not know, one whose bundle is gone, a bad signature) into the macOS notification it already shows when the socket is unreachable, because a click with no bar to land on has only that place to be loud. Proposal 1's name-to-socket rule in Swift and its mirror in `check-protocol` are not needed.
- **The link names the renderer that drew it.** Statusline replies and tmux pane frames use the same publisher. It signs the generated destination, renderer name and session together. Both click deliveries verify that signature and send the typed action to the named renderer, even if the session later moved. Legacy signed links still go to the primary renderer. The forwarder reports when the host lacks the issuing renderer's bundle. A future browser presentation can use the same typed targets and session identity.

## 9. Error handling

| Condition | What the user sees | Who reports it |
|---|---|---|
| A renderer crashed or its bundle changed | The supervisor restarts it from a complete start after its backoff. Its unsaved state (open menus, armed confirms) does not survive, as today, and every bar carries a `⚠` naming how it ended and saying so, held as a launcher's pipe event is: for the hold, and past it until an answer has carried it | The supervisor, through the daemon's world state |
| A renderer stopped answering | It is ended and restarted as one that crashed, the `⚠` saying it stopped answering | The supervisor's ping |
| An input while no renderer is live | A failure naming the renderer and how it ended, which the client prints; a click's reply says the same | The supervisor |
| The host and its renderer together pass the memory limit | A post-mortem of both processes, and the host restarts as today | The memory backstop |
| A renderer's bundle is gone | The request is answered with a failure naming the renderer and the missing bundle, which the client prints | The supervisor |
| An effect refused or failed | The bar's `⚠` carries the reason, held as a click's error is held today | The interpreter, through `effect-done` |
| A subscription refused | That source's cell draws its fallback; the `⚠` carries the reason | The collector, through the source's failed reading |
| A click the host refuses: unknown renderer, gone bundle, a signed link with a bad signature | A macOS notification naming the reason | The router, through the forwarder |
| A source failed | That source's cell draws its fallback; the `⚠` carries the collector's diagnostic | The collector, through `worldState.diagnostics` |
| The host is down | The client's existing connect failure; launchd restarts the host | The client and launchd |
| A request's turn presented no statusline frame | A failure naming the renderer | The router |

Nothing falls back to another renderer or another data source, and nothing draws a value where a reading is missing. [LAW:no-silent-failure]

## 10. Observability

One wide event per unit of work, under one correlation id:

- **The host,** per input delivered: renderer, session, input kind, mailbox wait, the renderer's `took`, the effects returned and each outcome, and the world state's `seq` the renderer last held. Per world-state push and per source run, as Proposal 1 §21. Per renderer start and end, with its bundle.
- **A renderer** writes nothing. Its turn record (the event kind, the state revision it left, what it drew and what it settled for) is part of its output, and the host writes it beside the input's event.
- **A turn's first failure determines its outcome.** Each store contributes its writes independently. A failed subscription collection keeps the previous declaration while the wake still moves. Any pruning owed by an offered config resumes on the next successful collection. The host reports later failures alongside the first and takes the writes this turn collected before it serves the next input.

`daemon-stats` reports the number of operations waiting for config, presents awaiting their effect result, and deferrals waiting for their tick under `rendererTurns`.

Every renderer's panel is the same, because there is one kind of renderer. Watching one is the whole of "dev mode". [LAW:nothing-unseen]

## 11. Testing

- The production build follows runtime imports from the renderer process entry, including its transport, core, shared modules and packages. It fails if an import reaches the Node filesystem or the bundler cannot account for a module in that graph. The host owns the transcript reader and its cache. The renderer combines the supplied context and metrics with the hook values reported by Claude Code.
- **The seam test.** The recording starts with a worker's construction and pairs each subsequent renderer input with its answer in order. Offline replay gives each input to a fresh renderer and compares frames, effects, records, store writes, subscriptions, wake, replies, failures and diagnostics. Host-side execution, elapsed transport time, PIDs and host receipt names stay outside the recording. The replay core needs no filesystem reads, clock reads or process launches. The CLI reads the recording at the boundary. [LAW:verifiable-goals]
- **Renderer tests** feed inputs and assert outputs. They need no mocks, because the renderer has nothing to mock.
- **Host part tests** run each part over fake ports for the world.
- **The transport contract test.** The in-process and socket transports give identical outputs for one recorded stream.
- **The latency check** measures A-1 and A-5 from the host's own event, not from a benchmark.

### Recording an installed renderer

`cc-candybar record start <file> [--renderer NAME]` asks the running daemon to capture one generation. The client resolves the path from its working directory. An existing renderer is replaced between turns so its build and startup inputs serve as the first entry. Its navigation history and unsaved edit drafts reset. Saved state goes into the new worker's construction input. Unbound names are armed for their next start. The daemon continues serving the other renderers from the same shared caches.

`cc-candybar record stop [--renderer NAME]` publishes the complete file without overwriting a destination. An orderly daemon shutdown also finishes a complete capture. A failed recording or an unexpected worker exit leaves the target unpublished. Both commands default to `CC_CANDYBAR_NAME`, then `main`.

Recording preserves the original accepted data. The host refuses a capture containing a declared `env` value, a run action’s environment overlay, or process output derived from a session environment. It marks that output when the host binds the environment to a run. The mark follows shell observations and action stderr through a restart. Raw session environments stay with the host. A saved file contains project config, paths and displayed data and should be treated as private.

`cc-candybar replay <file> [--frames]` recomputes each reply without executing its effects. Use the same build as the recorded renderer. The private wire version checks compatibility between the host and worker. Replay also depends on the worker's drawing and state transition logic. A turn mismatch names the turn and field path and exits unsuccessfully. With `--frames`, the CLI publishes JSON lines for statusline presents, pane draws and distinct statusline handoffs only after verifying the terminal entry and the entire file. Its verification summary then goes to stderr. Frame exports over 32 MiB fail without emitting frames. Summary mode verifies incrementally without retaining frames.

## 12. Implementation plan

Each step leaves a working bar. The renderer leaves the host's process first, through one adapter, and each later step deletes the adapter's entries (ADR-9).

1. **The seam in process.** Today's daemon divides into a host side and a renderer side behind `answer(input)`. Source runs and world-state assembly are host-side from this first cut, so later steps move only what the renderer itself does. *Done when* every request and click passes through `answer` and the bar draws as it did.
2. **The renderer out of process, through an adapter.** The supervisor runs the renderer in its own process through the socket transport. Every reach it still makes into a host part, such as a verb starting a run or the draw reading a feed's follow, is an entry in one adapter. A file the renderer still opens itself is not an entry. The step that removes it (config, stored state, the acts) also adds the rule that keeps it out, so the work left is listed once. *Done when* the bar draws from the renderer's process and the adapter lists every reach that remains. It reports the latency check's reading (A-1, A-5).
3. **Signed links.** The host signs each Candybar link it publishes and verifies it when a click arrives, because any web page can open a link.
4. **Effects returned, not performed, and the draw pure.** Every verb and timer returns effects; the interpreter runs them. The draw writes nothing: frame memory and animation clocks are state machine state. *Done when* no renderer-side code writes, starts a process, calls tmux or reads a clock, and the adapter's entries for those are deleted.
5. **The profile, config and stored state handed in.** The profile is derived from the renderer's name with its root canonicalized once (`load-config` is already gone). The host reads the config chain and the profile's stores and hands them in. *Done when* the renderer side opens no file (A-2), and a renderer started under a second name writes only under its own profile.
6. **Subscriptions.** The collector runs sources from the renderers' subscriptions, each in its session's environment, which the client now sends in the session context, in both runtimes; `declare` and `key` are deleted. *Done when* sessions that declare one source share one run when the variables it names agree, a session whose named variable differs gets its own, and a key change is served stale-while-revalidate.
7. **The adapter deleted, and the replay test** (§11). A small replay checks a request, a click, a scheduled draw and a config reload as the adapter shrinks. The complete recorder captures every input and compares every result after the remaining callbacks move into the protocol.
8. **A second renderer.** *Done when* a worktree's renderer draws one session while the others draw theirs, and no transcript is read twice (I-1, I-2).
9. **Clicks routed by the host.** The forwarder dials the host, and the host routes each click by the renderer its link names. *Done when* a click on a worktree's link changes only that renderer, and a click naming an unknown renderer shows a notification from the host's reply.
10. **The host under launchd** (A-4), once the probe passes.

## 13. Architecture decision records

| ID | Decision | Alternatives | Rationale | Reversible? | Cost to reverse |
|---|---|---|---|---|---|
| ADR-1 | One host owns every input and every effect. | Proposal 1: Gather reads, the renderer performs effects. | Proposal 1 reads the world on one side and writes it on the other, so no one orders an effect against the observation of its result, and the loop closes only through messages up to Gather. | Costly | Every effect path and the wire. |
| ADR-2 | A renderer only answers; subscriptions are part of its answer. | Proposal 1's `follow`, `declare` and `key` messages. | Upward messages are a second loop, `key` is a data cycle, and the design invited a new upward message for each new need. | Moderate | One wire. |
| ADR-3 | launchd owns the host's lifetime, and the install sets its bundle. | The client spawns the host from its own bundle; renderers spawn Gather (Proposal 1). If A-4 fails: the client starts the host from the bundle the install recorded, never the one beside it. | A process spawned by its dependants runs whichever bundle got there first, so a worktree's could serve the main bar; and a renderer that starts or keeps alive the host it depends on puts lifetime upstream. | Cheap | One install step and one spawn path. |
| ADR-4 | Every renderer runs in its own process. | A renderer inside the host's process, which pays no hop. | goals.md R-10 puts Events → State machine → Draw in a process of its own; a renderer crash cannot take the world boundary down with it, as in Chrome; and there is one kind of renderer, so the path every renderer runs is exercised on every tick. The cost is a hop per input (A-1). | Cheap | The in-process transport already lets tests draw through `Renderer.answer`. |
| ADR-5 | Effects are typed operations, and a config write is a `change` guarded by the value it read at each setting. | Proposal 1's `tmux { args }`, `launch { spec }` and unconditional `write-config-text`; a whole-file guard. | A raw command admits every command; an unconditional write overwrites what undo must refuse to; a whole-file guard fails on every unrelated write to a file many sessions share. | Moderate | Every effect site. |
| ADR-6 | A profile is derived from the name alone. | Proposal 1's name plus root from two variables. | Two values that must agree are two clocks. | Cheap | The path functions. |
| ADR-7 | The forwarder dials only the host. | Proposal 1: the forwarder computes a renderer's socket from the name. | The host verifies and routes, so isolation lives where the keys are (goals.md R-6, §8). The forwarder gains one change, showing the host's refusal, and none when naming changes. | Cheap | The forwarder. |
| ADR-8 | A shell run's identity carries the variables its declaration names, and the run is spawned with exactly those. | A digest of the session's whole environment in the identity. | No two sessions have one whole environment, so that identity never shares a run, and a cluster of sessions in one directory spawns once each. Named variables make the identity exactly what the output depends on. | Moderate | The declaration's schema and every config that relies on an unnamed variable. |
| ADR-9 | The renderer leaves the host's process first, and every reach it still makes into the host is an entry in one adapter. Each later step deletes entries until the adapter is gone. | Keep the renderer in process until every reach is data or an effect, then move it. | In process, a reach across the seam is a function call nobody counts, so nothing shows the seam is complete. Out of process, a reach is an entry a step must delete, and the adapter's list is the work left. | Cheap | The order of the steps; the in-process transport stays. |

## 14. How this stands against the laws

| Law | How it holds | Where it bends |
|---|---|---|
| decomposition | The host's purpose is one sentence, the bar's boundary with the world, and each of its parts has one: accept, route, read world state, discover config, carry out effects, run a surface, supervise, record. A renderer's is "answer each input". | The host holds everything world-facing and is the part most likely to become a god process. Its parts must stay apart, and a part that learns a verb's meaning or a renderer's state has broken the boundary. Its parts meet only through interfaces, so one can move to its own process, as Chrome's services did. |
| effects-at-boundaries | The renderer is pure in the full sense: no I/O, no clock, no log. The host is the only edge. | — |
| one-way-deps | Host → renderer, launchd → host. Nothing points up. | — |
| no-ambient-temporal-coupling | The host owns every order: per-renderer input, effects within a turn, a run before its refresh, a declared wake before its `due`. Every schedule is measured on ticks, which never run back. | — |
| single-enforcer | The collector judges every read a renderer subscribes to, the interpreter every effect, the host every signed link; repository trust has one keeper. | — |
| types-are-the-program | Effects are typed operations; a config write is a `change` guarded per setting; inputs and outputs are closed unions. | The wire loses types, so each side parses what it receives. That is one parser per direction at the one boundary, not a duplicate check. |
| one-source-of-truth | World state lives in the collector, renderer state in its renderer, durable state in the profile's files, written only by effects. | `subscriptions` make a loop from world state to keys to reads. It is the one loop and has one owner; it is not a second source. |
| dataflow-not-control-flow | Renderers differ by name and bundle, values the supervisor is handed, never a branch. | — |
| nothing-unseen | Every input, turn and effect lands on one event; the renderer's record is data. | — |
| no-silent-failure | Malformed clicks, restarts, refused effects and missing bundles are reported. | — |
| verifiable-goals | The replay test, the latency checks, and every falsifier in §2 and §3. | — |

## 15. What stands from Proposal 1

**Stands:** §1, total facts, here world state, with pending as a value (not its measured cost, which was one session's), with its seam test widened in §11; §4's split of the hook into instantaneous fields and a locator, except that the host keeps the locator itself; §6's home, here the profile, refined by ADR-6, with `load-config` removed and the `env` source kept on the session's environment (§7); §8, recording as a primitive, which now records renderer inputs; §12, `SessionFacts`, here `WorldState`; §16's ordering invariant and its move of frame memory and animation clocks into Apply's state, here the state machine's, both now in §7; §17's derived paths and `HomePath`, here `ProfilePath`, under ADR-6, without the per-name socket, which ADR-7 removes; §18's link grammar and constant tmux binding, written by the host's tmux-status adapter; §19's source digest, shared runs and the key change served stale-while-revalidate, now carried by subscriptions.

**Replaced:** §2 (Gather, here the collector, does only facts), §3 (Gather addressed by version), §5's performer, here the interpreter, §7 (how a session reaches a renderer), §9's table, §10 (order of work), §11 (its questions, answered by this draft or open in §17 here), §13 (the facts wire, deleted), §14 (the facts source, now the renderer transport), §15 (Gather's process, now the host's), §16's effects, §18's retired tmux status ranges, §19's `follow` and Gather's consistency guard (now the collector's judgement of each subscription, §7), §20, §21 and §22.

**Proposal 1's own claims this corrects:** a renderer was "a pure pipeline" while it performed every effect; every path a renderer used was "a pure function of the home" while config layers live in repositories; facts "flow one way" while the renderer sent the locator, declarations and keys up.

## 16. Backlog impact

The steps are the tickets under the epic `candybar-host-renderer-x96a`, in its rank order.

## 17. Open issues

| Item | Owner | Due |
|---|---|---|
| A-1 falls at 60 fps: the renderer served its turns concurrently on one thread, so a statusline request's turn shared the thread with the feed's frame draws. The mailbox gives each turn the renderer alone, so a request waits only for the input ahead of it; A-1 is read again at 60 fps. | `5gb` | Before a moving rate above 30 fps ships |
| A-3 is untested. | `8ts`'s refused-fix test tests A-3. | Before the step that relies on it |

**A-2 fell as first written and stands as revised.** Listing every fact today's load learns from the filesystem found six the first snapshot could not carry: the definitions a layer's `plugins` list names, a plugin folder's real path (the `run` directory and storage base), a checkout root a `data.checkout` path resolves against, a layer's path for its `run` actions, discovery's own notices, and the repository question (the directory answered under, whether anything asks, an unproven worktree link). The snapshot in §7 holds each, and a unit test loads and draws a session from a hand-built snapshot with the file system refused.

**A-1 stands at 30 fps and falls at 60.** Every reading is the render event's `took` in real use, compared with the in-process daemon's p50 4 ms, p99 11 ms over 18,548 requests.

- At 30 fps, out of process, over about 30,000 requests: p50 3 ms, p99 6 ms. The hop to the renderer is p50 1 ms, p99 3 ms.
- At 60 fps, over 21,863 requests: p50 8 ms, p99 30 ms, which is 19 ms over the baseline's p99. The draw itself is unchanged at p50 3 ms, p99 5 ms. The hop grew to p50 4 ms, p99 16 ms, because one animating feed keeps the renderer busy at 60 frames a second.

**A-5's falsifier names no tolerance, and read strictly it falls at both rates: frames fall short of the rate.** Every reading is the feed's own summary for a session animating in its pane. Each frame falls due a period after the instant the last was drawn for, so a late frame delays the ones after it, and the rate falls short by the frames' lateness.

- At 30 fps, each minute drew 29.2 to 29.4 frames a second, 2 to 3% short, with a mean draw of 9 ms and no failures.
- At 60 fps, over 89,134 frames in 26 minutes: 57.1 frames a second, 5% short, and no failures. Of the frames drawn, lateness from falling due to being drawn was p50 6.0 ms, p99 13.3 ms, p99.9 34.4 ms, with a standard deviation of 3.0 ms, and the draw's p99 was 12.4 ms. These readings understate any frame that fell due while the one before it was still drawing: lateness was then counted from when that frame's timer was set, not from when it fell due. A frame's lateness now counts from when it fell due.

**A-4 falls as written and stands once `dbf` builds three conditions:** without them, launchd's host cannot find tmux, and after a boot it cannot write beside its socket. The probe was a user LaunchAgent with a `Sockets` entry at a path beside the installed socket, so the live daemon was untouched. It started its program on the first connect, started it again after it exited, and recreated the socket when the agent loaded with its directory missing, as after a boot.

1. The host cannot check in with launchd itself, because node has no call for it. A native launcher calls `launch_activate_socket`, clears the descriptor's close-on-exec flag (launchd sets it, and `dup2` onto the same number keeps it), and execs node, which listens on the inherited descriptor.
2. launchd's PATH is `/usr/bin:/bin:/usr/sbin:/sbin`, where tmux is not found. The agent's `EnvironmentVariables` carries the PATH the host needs, and the agent names node by absolute path.
3. launchd creates a missing socket directory owned by root, mode 755. The host can write nothing else into it, so the lease, the daemon records and every other file the host keeps beside the socket today move to a directory the host owns.
