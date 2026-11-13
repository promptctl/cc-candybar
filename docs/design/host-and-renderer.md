# Proposal 3: the host and its renderers

**Status:** draft for review · **Replaces:** the process shape of Proposal 1 ([gather-and-renderer.md](gather-and-renderer.md)); §15 lists what of it stands · **Answers to:** [goals.md](goals.md) · **Ticket:** `candybar-gather-renderer-76bb.215`

## 1. Summary

One process, the **host**, is the bar's boundary with the world: every input enters through it and every effect leaves through it. It reads the world into each session's world state, receives client requests, clicks and timers, and performs effects. It calls **renderers**: any number of identical pieces of code that are each handed world state and events and answer each one with frames to present, effects to perform and the sources their state needs read. A renderer never touches the world, never reads a clock it was not handed, never starts a conversation, and never controls the host's lifetime. The split is functional core, imperative shell: the host is the shell, and each renderer is a functional core. There is one kind of renderer. Each runs in its own process, which the host starts from the bundle the renderer's name is bound to, and renderers differ only in values: a name, a bundle, a profile. The hard parts are keeping the host one job with internal parts rather than a god process, and keeping the round trip to a renderer inside the statusline's latency budget.

This is the shape real systems with the same problem use. §4 says which, and what each one teaches.

## 2. Intent

Each entry is what the design must achieve, with where the need was stated and the observation that would show the design fails it. A review checks the design against this table; a later reader checks the running system against it. An entry whose falsifier fires is a defect in the design, not in the code. The Why column is this design's reasoning; Brandon's own reasons, and which are inferred, are in goals.md.

| ID | Intent | Why, as this design reads it | Source | Falsified by |
|---|---|---|---|---|
| I-1 | A session's bar can be drawn by a worktree's code while every other session's bar keeps running on the code it already runs. | Most development happens on worktrees, and the bar is the thing being developed. | goals.md G-2 | Starting a renderer from one bundle needs another renderer stopped, or a session's bar draws code other than the bundle its renderer's name is bound to. |
| I-2 | Running a second renderer adds no second reader of the world. | A daemon may reserve about a gigabyte, and a naive second daemon duplicates disk reads and processes. | goals.md G-2, R-10 | With two renderers running, a session's transcript, repository or sources are read twice. |
| I-3 | The browser is a full surface for any user with the existing prerequisites. | It is the first of the two goals and the reason surfaces are a seam. | goals.md G-1, R-14 | Adding the browser surface needs a change to world state or to what a renderer decides, beyond drawing a frame for one more surface and the host's adapter for it. |
| I-4 | The world has exactly one owner. Everything that enters the system or leaves it passes through the host. | One owner is the only place an effect and the observation of its result can be ordered, validated and recorded. | goals.md R-8 | Any part of the bar other than the host reads a file, a socket, a clock or tmux, or performs an effect the host did not reply with. The client printing a failure and the forwarder showing a refusal relay the host's reply. |
| I-5 | Data goes one way around one loop. A renderer only answers the call it was given and never initiates a message. | A renderer that reaches upstream makes a second loop with no owner, and every new need becomes another upward message. | goals.md R-8 | A renderer sends anything that is not the answer to an input. |
| I-6 | Clicks are pure. A click, a timer and a future webhook are each an event; handling one is a state change plus effect descriptions. | Clicks that flip switches couple behaviour to timing; the source of a change must not matter. | goals.md R-7 | A verb's handler performs an effect itself, or a timer or click reaches state by a path other than an event. |
| I-7 | Draw writes nothing and reads nothing. | A draw that writes cannot be replayed, tested without mocks, or trusted to show only what happened. | goals.md R-11 | A replayed input stream shows a read, a write, a clock read or a spawn during a draw. |
| I-8 | There is no dev mode. Every renderer can perform every effect; a renderer differs from another only in values, and isolation is where it reads and writes, never what it may do. | A subset of behaviour is a toggle that the main bar never exercises, so it rots. | goals.md R-12 | What a renderer may have performed differs by its name, or any renderer has an allow-list of verbs or effects. Where a renderer reads and writes may differ by name; that is isolation. |
| I-9 | A click carries an address, and the address alone decides which renderer handles it. | Routing by state needs a table that has to survive restarts and can disagree with the frame. | goals.md R-9 | Delivering a click needs any lookup beyond the renderer name in the click. |
| I-10 | No absolute path is stored where a renderer's state lives; every path a renderer stores is relative to its profile. | A copied history must not be able to write the user's files. | goals.md R-13 | An absolute path in a renderer's stored state or undo history. |
| I-11 | Claude Code's request is answered with the frame of the renderer that session uses. | The client gets one answer, and it is the bar the session asked for. | goals.md R-9 | A session's statusline shows another renderer's frame. |
| I-12 | The payload a template reads carries every value it reads, and metrics, activity and session are in it. | A value that reaches a template outside the payload is a second path. | goals.md R-5 | A template reads a fact from anywhere but the payload. |
| I-13 | Nothing is decoded from rendered ANSI. | Decoding output to recover state inverts the pipeline. | goals.md R-1 | Any part reads a Frame back to learn what it said. |
| I-14 | The design is built from generally useful primitives, in data, under the laws. | Primitives with no consumer yet are how later work becomes cheap. | goals.md C-1, C-2, C-3 | A part exists only to serve one feature, or variability lives in a branch instead of a value; or a step's laws review finds a violation the step does not mark as an exception. |

## 3. Assumptions

Each must be true for the design to work. Each has a probe or measurement that would show it false, and none has been run yet.

| ID | Assumption | Falsified by |
|---|---|---|
| A-1 | The round trip from the host to a renderer's process costs the statusline little against today's daemon, which draws in the process that answers the client. | The request event's p99 `took`, over a day of real use, is higher than today's by more than 2 ms (a parameter). |
| A-2 | Everything a config load learns from the filesystem can be learned by the host first and handed in as one value: the layers' texts, their real directories, plugin folder listings, repository trust and the checkout. Today that discovery stats candidates, resolves real paths, lists plugin roots and walks `.git` before any text is read. | The loader, given the host's `ConfigSnapshot`, needs a fact about the filesystem the snapshot does not hold. |
| A-3 | No verb needs to read the world and write it in one atomic step that a patch's `test` cannot express. | A test that changes a verb's target between the renderer's read and its edit gets a wrong result instead of a refused edit. The doctor's fix, which re-probes at click time and then writes, is the first case to test. |
| A-4 | launchd can own the host's lifetime through socket activation at the socket path installed clients already dial, with the environment the host needs. | A probe: a user LaunchAgent with a `Sockets` entry at `/tmp/cc-candybar-<uid>/socket` does not start the host on the first connect, does not restart it after it exits, fails after a fresh boot has cleared `/tmp`, or starts a host that cannot find `node`, `tmux` or `git`. |
| A-5 | A renderer's output for one input, its stored state included, is small enough to cross a socket at animation rate, 30 inputs a second, without lag. | An animating session drops frames, or its inputs back up in its mailbox. |

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
                              (each in its own process, from the bundle
                               its name is bound to)
```

There are two kinds of thing and one direction of call. The host calls a renderer with one input at a time and awaits its output. The renderer depends on nothing; the host depends on the renderer interface. The one loop goes renderer, host, world, host, renderer, and the host owns every turn of it. [LAW:one-way-deps] [LAW:effects-at-boundaries]

## 6. Components

The host is one job, the bar's boundary with the world, done by parts that each have one. It holds no renderer logic: no part of it knows what a verb means, what a template says, or what a renderer's state is. [LAW:decomposition]

**Endpoint** (host, prototype)
- **Responsibility:** accepts every connection from outside: the Claude Code client, the URL handler's forwarder, and later the browser listener and webhooks.
- **Inputs and outputs:** client requests with their session context; URL frames. Out: each one as an event for the router, and each request's answer back to its client.

**Router** (host, prototype)
- **Responsibility:** turns each input into an event for the renderer it names, and keeps one mailbox per renderer.
- **Inputs and outputs:** a request names its renderer by the `renderer` field of its session context; a click by the `to/<name>` in its link. Out: one input at a time to each renderer, in arrival order per renderer. A request waits in the mailbox until its session's world state has no unread field the wait covers, up to the client's deadline, so a renderer's turn never waits. A session's `config` event is delivered before that session's request, so the subscriptions its draw needs are with the host, and their readings in the wait, before the request's turn.

**Collector** (host, production for what exists)
- **Responsibility:** reads the world into one complete world state per session, as Proposal 1 §12 specifies.
- **Inputs and outputs:** the locators of the sessions the host has seen, the union of every renderer's subscriptions, each judged as it arrives (§7), file and tmux events, its own periods. Out: a `world-state` event for each renderer that holds the session, newest-wins per session. One change to a session's world state costs one event and one turn in each renderer holding that session.

**Config discovery** (host, production for what exists)
- **Responsibility:** finds what a session's config is made of and hands it in as a `ConfigSnapshot`.
- **Inputs and outputs:** a session's directories and Claude Code config directory, from its session context; repository trust; file watches. Out: a `config` event whenever the snapshot changes.

**Effect interpreter** (host, prototype)
- **Responsibility:** carries out the effects a renderer returns and reports each outcome to it.
- **Inputs and outputs:** effects, in the order their turn returned them; it parses and validates each one, then hands a frame or a surface switch to that surface's adapter and an edit to the document editor, and does the rest itself. Out: `effect-done` events; for a `run` with `refreshes`, those sources held pending until the program exits and the collector has re-read them.

**Document editor** (host, production for what exists)
- **Responsibility:** applies a renderer's `edit` effects to the documents it was handed: a chain's own config layer and a session's Claude Code settings.
- **Inputs and outputs:** a document and a JSON Patch. It knows the document's syntax, JSON5 or JSON, and never its schema. It splices each value in place, an insert included, and keeps every other byte, comments included. Out: the patch applied whole or refused whole, with the text the document holds afterwards.

**Surface adapters** (host, production for what exists)
- **Responsibility:** one per surface: sets it up, shows the frames presented to it, reports its viewers, and tears it down.
- **Inputs and outputs:** `present` and `surface` effects from the interpreter. Out: `viewer` events. The tmux status options and binding, and the pane's split, kill and plugin install, live in their adapters.

**Supervisor** (host, prototype)
- **Responsibility:** starts, restarts and ends renderers, and hands each its start input.
- **Inputs and outputs:** a renderer name and bundle from the router; bundle changes; renderer exits. Out: a running renderer, or a loud failure naming the renderer and its bundle.

**Recorder** (host, prototype)
- **Responsibility:** writes a renderer's input stream to a file when asked, and writes every record a renderer returns to the log.

**Renderer** (prototype for the interface, production for the state machine and Draw as they exist)
- **Responsibility:** answers each input with what to present, what to do and what to read.
- **Inputs and outputs:** §7.
- **Inside:** Events → State machine → Draw. The state machine is the one writer of the renderer's state; Draw is a pure function of world state, renderer state, config and the instant it was handed.

## 7. Interfaces

### The renderer interface

```ts
// [LAW:one-type-per-behavior] One interface over two transports: a socket to
// the renderer's own process, and in-process for the commands that draw
// without a host (`check`, the demo) and for tests.
interface Renderer {
  answer(input: RendererInput): Promise<RendererOutput>;
}

type RendererInput =
  | { kind: "start"; start: Start; at: Instant }
  | { kind: "event"; event: Event; at: Instant };

// [LAW:one-source-of-truth] Complete, like a world state: a renderer that
// (re)starts holds everything it would hold had it never stopped, except the
// unsaved state its own process kept.
interface Start {
  readonly name: RendererName;
  readonly cause: "first" | "crashed" | "bundle-changed";
  readonly linkKey: LinkKey;
  readonly stored: StoredState;
  readonly sessions: readonly SessionSnapshot[];
}

interface SessionSnapshot {
  readonly session: SessionId;
  readonly worldState: WorldState;
  readonly config: ConfigSnapshot;
  readonly surfaces: readonly Surface[];   // the ones with viewers
}

type Event =
  | { kind: "request"; id: RequestId; session: SessionId; hook: ClaudeHookData; context: RendererContext }   // the session context a renderer reads; the environment stays in the host
  | { kind: "click"; click: VerifiedClick; arrival: ClickArrival }
  | { kind: "range"; server: TmuxServer; pane: PaneId; id: RangeId; arrival: ClickArrival }   // a tmux status-row click
  | { kind: "world-state"; worldState: WorldState }
  | { kind: "config"; session: SessionId; config: ConfigSnapshot }
  | { kind: "effect-done"; of: EffectId; outcome: Outcome<EffectResult> }
  | { kind: "due"; due: Scheduled }
  | { kind: "viewer"; session: SessionId; surface: Surface; on: boolean }
  | { kind: "retire"; session: SessionId };

interface RendererOutput {
  readonly effects: readonly Effect[];
  // [LAW:one-source-of-truth] Whole, replacing the last: what this renderer's
  // state needs read. The host diffs it; nothing is declared by message.
  readonly subscriptions: Subscriptions;
  // [LAW:one-source-of-truth] Whole, replacing the last: what this renderer
  // keeps across a restart. The host persists it under the profile and hands
  // it back in `start`; nothing is stored by message.
  readonly stored: StoredState;
  // [LAW:nothing-unseen] The turn's own record. A renderer writes no log;
  // the host writes this one.
  readonly record: TurnRecord;
}

interface Subscriptions {
  readonly sources: Readonly<Record<SessionId, readonly Subscription[]>>;
}

// Where a declaration came from is what repository trust is judged on.
interface Subscription {
  readonly decl: SourceDecl;
  readonly from: { kind: "bundled" } | { kind: "layer"; layer: LayerId } | { kind: "plugin"; plugin: PluginId };
}

// What the host's config discovery found for one session's directories: the
// imperative-shell half of today's load, as a value. Parse, merge and validate
// are the renderer's, in its functional core. The bundled layer ships in the renderer's own bundle.
// [LAW:types-are-the-program] Each layer carries only what its role can have.
// A LayerId is derived, never minted: the role plus a digest of the layer's
// real directory, so it names the same layer across restarts and sessions.
interface ConfigSnapshot {
  readonly chain: Chain;
  readonly plugins: readonly Plugin[];
  readonly checkout: CheckoutId | null;      // the session's repository, opaque
}

// An explicit target replaces the chain, as today, so it stands alone.
type Chain =
  | { kind: "explicit"; own: OwnLayer }
  | { kind: "layered"; own: OwnLayer; repo: readonly RepoLayer[] };   // project, then cwd

// The one layer of a chain a renderer may edit: the user's file or the explicit target.
interface OwnLayer {
  readonly layer: LayerId;
  readonly display: string;                  // the path, for messages only
  readonly text: string | null;              // null: not written yet
}

// An unapproved layer carries no text: it is not merged, and the bar asks its question.
type RepoLayer =
  | { layer: LayerId; role: "project" | "cwd"; display: string; trust: "approved"; text: string }
  | { layer: LayerId; role: "project" | "cwd"; display: string; trust: "refused" | "unasked" };

interface Plugin {
  readonly plugin: PluginId;                 // derived like a LayerId
  readonly origin: { kind: "data-root" } | { kind: "project"; layer: LayerId };   // a project's plugins come with its approval
  readonly name: string;
  readonly files: Readonly<Record<string, string>>;
}
```

- **Every input gets exactly one output, in order.** The host sends the next input to a renderer only after the last one's output arrived. That serialization is the state machine's turn, owned by the renderer's mailbox in the host. A turn is synchronous, and inputs are plain data. [LAW:no-ambient-temporal-coupling]
- **A multi-step act is a chain.** Each step is one effect, the chain's phase is state machine state, and the state machine returns the next step when the last one's `effect-done` arrives. `type-slash` is one step because its check and its act must not be separated. A pane's identity is one function of the pane, with no per-request stamp.
- **A request is answered by its `present` effect.** The statusline arm of `present` carries the request it answers, and only that arm does. A request whose output holds no such effect is answered with a failure naming the renderer, never with an empty bar. One mechanism delivers every frame to every surface. [LAW:one-type-per-behavior]
- **Time is handed in.** Every input carries `at`. A renderer asks to be woken with a `schedule` effect and is woken by a `due` event carrying the token it chose. Animation is a renderer scheduling its next frame.
- **The state a draw used to write is the state machine's.** Frame memory (on the tmux status row, the links its frame carried) and animation clocks are renderer state keyed by session and surface. The draw returns a frame and its memory as values; the state machine stores them. A frame drawn for a session reflects every event whose turn completed before the draw began, and no part of one whose turn has not. [LAW:effects-at-boundaries]
- **Subscriptions replace `follow`, `declare` and `key`.** The host knows every session's locator from the requests it receives. A source's key is evaluated by the renderer over its own store, as today, and its digest travels in `subscriptions`; two renderers subscribed to one digest share one run, and a new key is a new run served stale-while-revalidate: the old reading stands until the new one lands. That is still a loop from world state to keys to reads to world state, but it is the one loop and the host owns it, the way the Elm runtime owns subscriptions. A declaration has one canonical form: its environment names are a sorted set, every digest is taken over JSON with keys sorted at every level, and a session's subscriptions leave in digest order. So two declarations that mean one read are one run, and an output is the same bytes whatever order a config declares in.
- **The collector is the one checkpoint for reads.** A subscription asks the host to read a path or run a shell command, so the collector judges every declaration when it arrives: absolute paths, regex captures and the shell sources' minimum TTL with the loader's own specs, and repository trust by the layer or plugin a declaration came from. A refused declaration is a failed reading for that source, with the reason. The renderer's loader parses declarations and does not judge them. [LAW:single-enforcer]
- **A command runs in the variables it names, read from its session's environment.** The client sends the environment Claude Code gave it as part of the session context. A `shell` declaration names the environment variables its command reads, over a base set that is data in the bundled default. The collector parses a declaration and its session's environment into a run identity, which carries each named variable's value, and spawns the run with exactly those variables. So the identity holds everything the output depends on: sessions whose named values agree share one run, which is how the sessions of one directory cost one spawn, and no run sees a variable its declaration did not name. The `env` source reads the session's environment, and a `run` lays its program's `env` over it. The host keeps the environment with the session's locator, and no renderer input carries it: a renderer runs nothing, and an environment holds keys and tokens that a recording must never capture. The host's own environment is never a session's. [LAW:one-source-of-truth] (docs/design/per-directory-sources.md)
- **Repository trust guards against repository content, not against renderers.** The collector judges a declaration by the origin the renderer reports, which a repository's files cannot forge. A renderer is code the user installed or built.
- **Config arrives as discovery's result.** The host resolves a session's layers, real directories, plugin folders, repository trust and checkout, reads their texts, creates plugin storage folders, and hands the result in, again whenever a watched file changes. The renderer parses, merges, validates and compiles it and opens no file. A path appears only as display text for messages; a renderer names a file by the layer it was handed. [LAW:effects-at-boundaries]
- **Stored state is returned whole and arrives at start.** Session picks and drafts, settings history, the doctor's marks and every other durable state are the renderer's, returned whole in every output like its subscriptions. The host persists them under the renderer's profile and hands them back with `start`. Settings history holds patches, not file texts, and is bounded.
- **Clicks arrive verified.** Every link a renderer draws is signed, whatever it does: every link's arguments come from the URL, and any page can open one, so a forged copy link would put an attacker's command on the clipboard as surely as a forged run link would run one. The host checks a link's signature over its opaque tail with that renderer's link key before routing it, so an unsigned URL never reaches a renderer. The renderer decides what the click means. A tmux status-row click carries a range id instead of a signed tail, because tmux expands it from the row at the click; the router passes it to the named renderer as a `range` event, and the renderer resolves it against the links its frames carried. The id is the digest of a link that renderer signed, so resolving it is its verification, and an id it cannot resolve is the stale-frame row of §9. [LAW:single-enforcer]

### Effects

```ts
type Effect =
  | { kind: "present"; session: SessionId; surface: "statusline"; request: RequestId; frame: Frame }
  | { kind: "present"; session: SessionId; surface: PushedSurface; frame: Frame }
  | { kind: "edit"; document: Document; patch: JsonPatch }
  | { kind: "type-slash"; session: SessionId; line: SlashLine }
  | { kind: "run"; session: SessionId; program: Program; refreshes: readonly SourceId[] }
  | { kind: "restart-claude"; session: SessionId }
  | { kind: "surface"; session: SessionId; surface: PushedSurface; on: boolean }
  | { kind: "approve-repo"; layer: LayerId; answer: boolean }
  | { kind: "apply-update"; version: Version }
  | { kind: "open"; url: string }
  | { kind: "copy"; text: string }
  | { kind: "schedule"; at: Instant; due: Scheduled };

type Surface = "statusline" | PushedSurface;
type PushedSurface = "band" | "pane" | "tmux-status" | "browser";

// [LAW:types-are-the-program] A renderer names a document it was handed, never
// a path, so no stored effect or undo entry can hold an absolute path (R-13).
type Document =
  | { kind: "own-config"; layer: LayerId }              // a chain's own layer; no repository layer is editable
  | { kind: "claude-settings"; session: SessionId };    // the session's Claude Code settings, from its session context

// [LAW:domain-language] JSON Patch (RFC 6902) over JSON Pointer paths
// (RFC 6901), with no extension; applied whole or not at all.
type JsonPatch = readonly [PatchOp, ...PatchOp[]];
type PatchOp =
  | { op: "add"; path: JsonPointer; value: JsonValue }       // at an array index, an insert
  | { op: "replace"; path: JsonPointer; value: JsonValue }
  | { op: "remove"; path: JsonPointer }
  | { op: "test"; path: JsonPointer; value: JsonValue };

// Today's run action, with its directory named, never spelled.
interface Program {
  readonly argv: readonly [string, ...string[]];
  readonly env: Readonly<Record<string, string>>;   // laid over the session's environment
  readonly cwd: { kind: "layer"; layer: LayerId } | { kind: "plugin"; plugin: PluginId } | { kind: "user-home" };
}
```

`SlashLine` is a slash command and its arguments, already parsed by the grammar the bar uses today; `Scheduled` is a token the renderer chose and gets back.

- **Every effect names its operation.** There is no `tmux { args }` and no free-form command, because a raw command admits every command and the safety of a slash line or a run could not be expressed in it. A run link's program is the declaration its link signed, as today. [LAW:types-are-the-program]
- **Every edited document is named, never spelled.** An `own-config` is the layer the renderer was handed, wherever its file lives, so an explicit `--config` stays editable. `claude-settings` is reached only through a session the renderer holds. Undo stores these names, so a history copied to another renderer resolves only against what that renderer was handed.
- **A renderer edits a document in the document's vocabulary, never its bytes.** No effect writes a file. The renderer's bundle carries the config schema, so what a path means (a preset, a theme's default, a layout tree) is the renderer's, and so is every check that needs the merged chain. Save, a preset's save and delete, reset, edit mode, undo and redo are renderer verbs, and each click compiles to one patch: one transaction and one undo step. The document editor knows only the syntax (§6), so a worktree's renderer can change the schema with no install.
- **An edit's arithmetic is the renderer's.** A stepper starts a missing setting from the merged default and stops at a bound before it wraps, which needs the schema. The renderer computes each edit over the documents it holds with its own unanswered edits laid on top, which is what it already shows. The interpreter applies effects one at a time in order, so quick clicks each land on the value the last one left. Array indices are the renderer's to resolve, and an index found by content (a segment's id) is guarded by a `test` on that element.
- **Edits say what they expect with `test`.** A patch whose `test` fails is refused whole. That is how undo refuses a target someone else changed, how save cannot overwrite a hand edit made after its config was read, and how the doctor's fix applies only to the settings it diagnosed. RFC 6902 cannot test that a path is absent, so an `add` that must not overwrite (save adding a field, undo of a reset) is guarded by a `test` of its parent, which for a top-level key is the whole document, no coarser than a whole-file compare. A `test` fails only on a change the renderer did not make, and the patches that depended on the failed one are refused with it.
- **An edit's outcome carries the document.** An edit's `effect-done` holds the text the document holds afterwards, applied or refused. In that one turn the renderer takes the text into every session that holds the document and drops the edit from its unanswered ones, so no second input has to be ordered against it. A later `config` input with the same bytes changes nothing. A document's texts reach a renderer in the order the host read them.
- **`type-slash` checks, then acts.** The interpreter reads the pane and refuses unless it shows Claude Code's bare input box, then stashes, pastes and submits. Nothing in the bar can come between the check and the act, because the interpreter runs one effect at a time; the user can, in the gap between two tmux calls, as today.
- **`run` carries its refreshes.** The collector holds each named source pending from the run's start until the program exits and the source has been re-read. The host owns that order. A run's program runs in its session's environment (above).
- **Repository trust is the host's.** Which repositories may run commands is a security decision, so the host keeps the answers and resolves config by them; a click that answers the question returns `approve-repo` for the layer it asked about. [LAW:single-enforcer]
- **The interpreter is the one checkpoint for effects.** It parses each effect from the wire, refuses a target the renderer was not handed and a slash line that does not parse, and reports a refusal as a failed `effect-done`. A refusal is a fact the renderer holds for the bar like any other failed effect. Every renderer may ask for every effect; validation is about where, never what. [LAW:parse-dont-validate]
- **Everything the bar does today has a place.** The tmux status options and the status-line binding are part of the host turning the `tmux-status` surface on, and splitting or killing the bar pane, with the plugin install the pane's setup runs, part of turning `pane` on; each surface's setup lives in the host's adapter for that surface. Plugin storage folders are created by discovery. The doctor's probes are subscriptions to doctor sources, its verdicts the renderer's, its fixes an `edit` of Claude Code's settings tested against the values it diagnosed, and its marks book and the post-mortems read stored state. Its URL handler self-test is answered by the host and reaches no renderer. Applying an update is `apply-update`. The `env` source stays, reading the session's environment rather than the daemon's.
- **One verb is removed under goals.md R-4:** `load-config`, which points a session at a path a click supplies and so would store an absolute path (R-13). A session's explicit target, set when Claude Code starts, is how a session uses another file.

## 8. Addressing and lifetime

- **The host** listens at the socket installed clients already dial, `/tmp/cc-candybar-<uid>/socket`. launchd starts it on the first connect and restarts it when it exits (A-4). No client and no renderer starts the host, so no dependant chooses which code owns the world.
- **The host's bundle is a value the install sets.** The LaunchAgent names the bundle it runs, and installing from a bundle repoints it; the host exits when its bundle changes, as today's daemon does. Host code is tried from a worktree by installing it there, which moves every bar on the machine, as any change to the daemon does today. G-2 asks for the drawing to be iterated per session, and renderers give that.
- **The host's environment is recorded, not inherited.** launchd starts a process with a minimal `PATH`, so the install records the paths of the tools the host itself runs (`node`, `tmux`, `git`, `gh`) into the LaunchAgent. Everything a session runs uses that session's environment, which its client sends (§7).
- **What needs an install.** A new built-in field of world state, a change to how a source is read, a new effect or a new surface adapter is host code, tried by installing it.
- **A renderer** is named by the `renderer` field of the client's session context: its name from `CC_CANDYBAR_NAME`, absent meaning the default name `main`, and its bundle, the client's own. A session is moved to another renderer by starting Claude Code with other values (goals.md R-16). Only a Claude Code client's request binds a name to a bundle; no click, timer or later input names code.
- **Every renderer runs in its own process.** The supervisor starts one from the bound bundle on that name's first input, and restarts it after a crash or a bundle change on the next input. A name bound to one bundle refuses a second bundle loudly, naming both, until the first is retired. No name is bound by anything but a request, and no code treats a name or a binding as special. The in-process transport is the one `cc-candybar check`, the demo and tests use, since they draw through the same renderer with no host process.
- **A profile is a function of the name alone.** The default name's profile is today's XDG layout, so an installed bar keeps its files; any other name's is `<state root>/renderers/<name>/` with `state/`, `config/` and `cache/` beneath it. Its root is canonicalized once, where the profile is built, so no request reads the disk to compare spellings. Isolation is one value. [LAW:one-source-of-truth]
- **Clicks are isolated in the host, and the forwarder learns to be loud.** goals.md R-6 expects the URL handler to change for clicks to be isolated. Here the isolation is the host's: it verifies each link against its renderer's key and routes it by name, so the forwarder stays a pipe that passes the URL on unparsed and cannot be wrong about routing. Its change is that the host now replies to every URL, and the forwarder turns a refusal (a renderer the host does not know, one whose bundle is gone, a bad signature) into the macOS notification it already shows when the socket is unreachable, because a click with no bar to land on has only that place to be loud. Proposal 1's name-to-socket rule in Swift and its mirror in `check-protocol` are not needed.
- **Links keep `to/<name>`.** The name is the address, and the host routes by it. The tmux row's constant binding and `@cc-candybar-renderer` option stand as Proposal 1 §18 specifies. A range id is the digest of its signed URL, so it needs no counter, table, persisted state or binding key; the renderer resolves an id against the links in its frame memory, and two distinct URLs with one id in a frame are a loud `⚠` raised by that frame's encoder.

## 9. Error handling

| Condition | What the user sees | Who reports it |
|---|---|---|
| A renderer crashed or its bundle changed | The next input restarts it from a complete start; that session's bar carries a `⚠` naming the restart for the usual hold | The supervisor, through the start's `cause` |
| A renderer's bundle is gone | The request is answered with a failure naming the renderer and the missing bundle, which the client prints | The supervisor |
| An effect refused or failed | The bar's `⚠` carries the reason, held as a click's error is held today | The interpreter, through `effect-done` |
| A subscription refused | That source's cell draws its fallback; the `⚠` carries the reason | The collector, through the source's failed reading |
| A click the host refuses: unknown renderer, gone bundle, a signed link with a bad signature | A macOS notification naming the reason | The router, through the forwarder |
| A click on a stale frame | A held `⚠`: the link belongs to an older frame | The renderer that owns the frame |
| A source failed | That source's cell draws its fallback; the `⚠` carries the collector's diagnostic | The collector, through `worldState.diagnostics` |
| The host is down | The client's existing connect failure; launchd restarts the host | The client and launchd |
| A request's turn presented no statusline frame | A failure naming the renderer | The router |

Nothing falls back to another renderer or another data source, and nothing draws a value where a reading is missing. [LAW:no-silent-failure]

## 10. Observability

One wide event per unit of work, under one correlation id:

- **The host,** per input delivered: renderer, session, input kind, mailbox wait, the renderer's `took`, the effects returned and each outcome, and the world state's `seq` the renderer last held. Per world-state push and per source run, as Proposal 1 §21. Per renderer start and end, with its bundle.
- **A renderer** writes nothing. Its turn record (the event kind, the state revision it left, what it drew and what it settled for) is part of its output, and the host writes it beside the input's event.

A renderer's panel is the same whatever its name or bundle. Watching one is the whole of "dev mode". [LAW:nothing-unseen]

## 11. Testing

- **The seam test.** The recorder captures a renderer's whole input stream. Replaying it into a fresh renderer gives byte-identical outputs, frames, effects, subscriptions and records, with zero filesystem reads, zero clock reads and zero spawned processes over the entire run, not only over draws. This is the acceptance test for the split, and it holds forever. [LAW:verifiable-goals]
- **Renderer tests** feed inputs and assert outputs. They need no mocks, because the renderer has nothing to mock.
- **Host part tests** run each part over fake ports for the world.
- **The transport contract test.** The in-process and socket transports give identical outputs for one recorded stream.
- **The latency check** measures A-1 and A-5 from the host's own event, not from a benchmark.

## 12. Implementation plan

Each step leaves a working bar. From step 2 every renderer runs in its own process; `check`, the demo and tests use the in-process transport throughout.

1. **The seam in process** (done). Today's daemon divides into a host side and a renderer side behind `answer(input)`. Source runs and world-state assembly are host-side from this first cut.
2. **Renderers out of process, through an adapter.** The renderer's code moves into its own process, which the supervisor starts and restarts, over the socket transport; inputs and outputs become plain data. Every reach it still makes into the world or into host state, and every host fact it still reads in place, is an entry in one adapter, each a marked exception, and no other renderer code names a host part. In process, a reach across the seam is a function call nobody counts; out of process, it is an entry a later step must delete. *Done when* every frame is drawn in a renderer process, the host process holds no renderer state, and the adapter lists every remaining reach. It reports the latency check's reading (A-1).
3. **Every click verified.** Every link a renderer draws is signed, and the host verifies each click before any renderer sees it; the forwarder shows the host's refusal. *Done when* an unsigned or altered link, a copy link included, reaches no renderer and shows a notification.
4. **The mailbox.** A request waits in the host for its world state, so a renderer's turn never waits and its inputs never overlap.
5. **Effects returned, not performed, and the draw pure.** Each verb and timer returns effects: edits as patches, every other act as its own effect, time as `schedule` and `due`. Frame memory and animation clocks are state machine state. *Done when* the adapter holds no write, spawn, tmux call or clock.
6. **Config and stored state handed in.** Config discovery hands in a `ConfigSnapshot` (A-2); stored state is returned whole and handed back in `start`, under a profile derived from the name; `load-config` is removed. *Done when* the adapter holds no read and the renderer process opens no file.
7. **Subscriptions in each session's environment.** The client sends the environment in the session context, in both runtimes, and each run gets exactly the variables its declaration names.
8. **The recorder and the replay test** (§11), which delete the adapter. It comes after steps 2 to 7 because a replay can match the live run only once the renderer is a function of its inputs.
9. **A second name.** A client's name and bundle start a renderer of their own. *Done when* a renderer from a worktree's bundle draws one session while others draw the rest and no transcript is read twice (I-1, I-2).
10. **Clicks routed by name.** The host routes by `to/<name>`, and a tmux row's range ids are digests. *Done when* a click on one renderer's link changes only that renderer, and a click naming an unknown renderer shows a notification from the host's reply.
11. **The host under launchd** (A-4), once the probe passes.

## 13. Architecture decision records

| ID | Decision | Alternatives | Rationale | Reversible? | Cost to reverse |
|---|---|---|---|---|---|
| ADR-1 | One host owns every input and every effect. | Proposal 1: Gather reads, the renderer performs effects. | Proposal 1 reads the world on one side and writes it on the other, so no one orders an effect against the observation of its result, and the loop closes only through messages up to Gather. | Costly | Every effect path and the wire. |
| ADR-2 | A renderer only answers; subscriptions are part of its answer. | Proposal 1's `follow`, `declare` and `key` messages. | Upward messages are a second loop, `key` is a data cycle, and the design invited a new upward message for each new need. | Moderate | One wire. |
| ADR-3 | launchd owns the host's lifetime, and the install sets its bundle. | The client spawns the host from its own bundle; renderers spawn Gather (Proposal 1). If A-4 fails: the client starts the host from the bundle the install recorded, never the one beside it. | A process spawned by its dependants runs whichever bundle got there first, so a worktree's could own every session's world; and a renderer that starts or keeps alive the host it depends on puts lifetime upstream. | Cheap | One install step and one spawn path. |
| ADR-4 | Every renderer runs in its own process. | A renderer inside the host's process, which pays no hop. | goals.md R-10 puts Events → State machine → Draw in a process of its own; a renderer crash cannot take the world boundary down with it, as in Chrome; and every renderer runs the one path, so that path is exercised on every tick. The cost is a hop per input (A-1). | Cheap | A transport value; the in-process transport is already the one `check`, the demo and tests use. |
| ADR-5 | Effects are typed operations, and a document is edited by JSON Patch, with `test` for what an edit expects and the arithmetic in the renderer. | Proposal 1's `tmux { args }`, `launch { spec }` and unconditional `write-config-text`; a file's whole text with a precondition; host-side verbs that know the config schema; a relative-increment extension applied by the host. | A raw command admits every command. A file's text makes the renderer own syntax, location and byte preservation. Host verbs put the schema in two bundles, so a worktree could not change it without an install. A host-side increment needs the merged default and the stepper's wrap, which only the renderer has. | Moderate | Every effect site. |
| ADR-9 | A renderer's stored state is returned whole in its output. | A `store` effect per key. | Like subscriptions, a whole value has one owner and no message to lose or reorder; the host persists what differs. | Cheap | The output's one field. |
| ADR-10 | Renderers leave the host's process first, through an adapter that later steps empty. | Out of process last, once the renderer is pure. | In process, every reach across the seam is a call nobody sees, so the seam drifts while it is built. Out of process, each reach is a named entry, each step's done-when is entries deleted, and the boundary every later step conforms to exists from the start. | Moderate | One supervisor and one transport. |
| ADR-6 | A profile is derived from the name alone. | Proposal 1's name plus root from two variables. | Two values that must agree are two clocks. | Cheap | The path functions. |
| ADR-7 | The forwarder dials only the host. | Proposal 1: the forwarder computes a renderer's socket from the name. | The host verifies and routes, so isolation lives where the keys are (goals.md R-6, §8). The forwarder gains one change, showing the host's refusal, and none when naming changes. | Cheap | The forwarder. |
| ADR-8 | A shell run's identity carries the variables its declaration names, and the run is spawned with exactly those. | A digest of the session's whole environment in the identity. | No two sessions have one whole environment, so that identity never shares a run, and a cluster of sessions in one directory spawns once each. Named variables make the identity exactly what the output depends on. | Moderate | The declaration's schema and every config that relies on an unnamed variable. |

## 14. How this stands against the laws

| Law | How it holds | Where it bends |
|---|---|---|
| decomposition | The host's purpose is one sentence, the bar's boundary with the world, and each of its parts has one: accept, route, read world state, discover config, carry out effects, run a surface, supervise, record. A renderer's is "answer each input". | The host holds everything world-facing and is the part most likely to become a god process. Its parts must stay apart, and a part that learns a verb's meaning or a renderer's state has broken the boundary. Its parts meet only through interfaces, so one can move to its own process, as Chrome's services did. |
| effects-at-boundaries | The renderer is pure in the full sense: no I/O, no clock, no log. The host is the only edge. | — |
| one-way-deps | Host → renderer, launchd → host. Nothing points up. | Until step 8 deletes it, the renderer reaches the host through the adapter (§12); each entry is a marked exception, and every step deletes some. |
| no-ambient-temporal-coupling | The host owns every order: per-renderer input, effects within a turn, a run before its refresh, a schedule before its `due`. | — |
| single-enforcer | The collector judges every read a renderer subscribes to, the interpreter every effect, the host every signed link, the renderer that drew a row every range id on it; repository trust has one keeper. | — |
| types-are-the-program | Effects are typed operations; a document is edited by a standard patch that says what it expects; inputs and outputs are closed unions. | The wire loses types, so each side parses what it receives. That is one parser per direction at the one boundary, not a duplicate check. |
| one-source-of-truth | World state lives in the collector, renderer state in its renderer, durable state in the profile, returned whole by its renderer. | `subscriptions` make a loop from world state to keys to reads. It is the one loop and has one owner; it is not a second source. |
| dataflow-not-control-flow | Renderers differ by name and bundle, values the supervisor is handed, never a branch. | — |
| nothing-unseen | Every input, turn and effect lands on one event; the renderer's record is data. | — |
| no-silent-failure | Stale clicks, restarts, refused effects and missing bundles are all loud. | — |
| verifiable-goals | The replay test, the latency checks, and every falsifier in §2 and §3. | — |

## 15. What stands from Proposal 1

**Stands:** §1, total facts, here world state, with pending as a value (not its measured cost, which was one session's), with its seam test widened in §11; §4's split of the hook into instantaneous fields and a locator, except that the host keeps the locator itself; §6's home, here the profile, refined by ADR-6, with `load-config` removed and the `env` source kept on the session's environment (§7); §8, recording as a primitive, which now records renderer inputs; §12, `SessionFacts`, here `WorldState`; §16's ordering invariant and its move of frame memory and animation clocks into Apply's state, here the state machine's, both now in §7; §17's derived paths and `HomePath`, here `ProfilePath`, under ADR-6, without the per-name socket, which ADR-7 removes; §18's link grammar and constant tmux binding, written by the host's tmux-status adapter; §19's source digest, shared runs and the key change served stale-while-revalidate, now carried by subscriptions.

**Replaced:** §2 (Gather, here the collector, does only facts), §3 (Gather addressed by version), §5's performer, here the interpreter, §7 (how a session reaches a renderer), §9's table, §10 (order of work), §11 (its questions, answered by this draft or open in §17 here), §13 (the facts wire, deleted), §14 (the facts source, now the renderer transport), §15 (Gather's process, now the host's), §16's effects, §18's counter-minted range ids (now digests, §8), §19's `follow` and Gather's consistency guard (now the collector's judgement of each subscription, §7), §20, §21 and §22.

**Proposal 1's own claims this corrects:** a renderer was "a pure pipeline" while it performed every effect; every path a renderer used was "a pure function of the home" while config layers live in repositories; facts "flow one way" while the renderer sent the locator, declarations and keys up.

## 16. Backlog impact

The plan's steps are tickets in `candybar-host-renderer-x96a`, in plan order.

## 17. Open issues

| Item | Owner | Due |
|---|---|---|
| A-1 to A-5 are unmeasured. A-1 is read from step 2's own events; A-2 and A-4 decide steps 6 and 11. | — | Steps 2, 6 and 11 |
| Whether a renderer's unsaved state (open menus, armed confirms) should survive its restart. Today a daemon restart loses it. | — | — |
| How each renderer's memory is bounded once it is its own process. | — | Step 2 |
