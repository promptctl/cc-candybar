# Proposal 3: the host and its renderers

**Status:** draft for review · **Replaces:** the process shape of Proposal 1 ([gather-and-renderer.md](gather-and-renderer.md)); §15 lists what of it stands · **Answers to:** [goals.md](goals.md) · **Ticket:** `candybar-gather-renderer-76bb.215`

## 1. Summary

One process, the **host**, is the bar's boundary with the world: every input enters through it and every effect leaves through it. It reads the world into facts, receives client requests, clicks and timers, and performs effects. It calls **renderers**: any number of identical pieces of code that are each handed facts and events and answer each one with frames to present, effects to perform and the sources their state needs read. A renderer never touches the world, never reads a clock it was not handed, never starts a conversation, and never controls the host's lifetime. Every renderer runs in its own process, which the host starts: the main renderer from the host's bundle, a worktree's from the worktree's. The hard parts are keeping the host one job with internal parts rather than a god process, and keeping the round trip to a renderer inside the statusline's latency budget.

This is the shape real systems with the same problem use. §4 says which, and what each one teaches.

## 2. Intent

Each entry is what the design must achieve, with where the need was stated and the observation that would show the design fails it. A review checks the design against this table; a later reader checks the running system against it. An entry whose falsifier fires is a defect in the design, not in the code.

| ID | Intent | Why | Source | Falsified by |
|---|---|---|---|---|
| I-1 | A session's bar can be drawn by a worktree's code while the main bar keeps running on the main checkout's. | Most development happens on worktrees, and the bar is the thing being developed. | goals.md, *The two goals* | A worktree renderer needs the main renderer stopped, or a main bar draws a worktree's code. |
| I-2 | Running a worktree renderer adds no second reader of the world. | A daemon may reserve about a gigabyte, and a naive second daemon duplicates disk reads and processes. | goals.md, *The two goals* | With a worktree renderer running, a session's transcript, repository or sources are read twice. |
| I-3 | The browser is a full surface for any user with the existing prerequisites. | It is the first of the two goals and the reason surfaces are a seam. | goals.md, *The two goals* | Adding the browser surface needs a change to the host's inputs or to a renderer's decisions, not only a new surface. |
| I-4 | The world has exactly one owner. Everything that enters the system or leaves it passes through the host. | One owner is the only place an effect and the observation of its result can be ordered, validated and recorded. | goals.md, *On the world boundary* | Any part of the bar other than the host reads a file, a socket, a clock or tmux, or writes, launches or signals anything. The Claude Code client and the URL handler's forwarder are not exceptions: each only relays what it was handed to the host. |
| I-5 | Data goes one way around one loop. A renderer only answers the call it was given; it never initiates a message, and it never starts, stops or keeps alive the host. | A renderer that reaches upstream makes a second loop with no owner, and every new need becomes another upward message. | goals.md, *On the world boundary* | A renderer sends anything that is not the answer to an input, or a renderer's start or exit starts or ends the host. |
| I-6 | Clicks are pure. A click, a timer and a future webhook are each an event; handling one is a state change plus effect descriptions. | Clicks that flip switches couple behaviour to timing; the source of a change must not matter. | goals.md, *On what clicks are* | A verb's handler performs an effect itself, or a timer or click reaches state by a path other than an event. |
| I-7 | Draw writes nothing and reads nothing. | A draw that writes cannot be replayed, tested without mocks, or trusted to show only what happened. | goals.md, *On Draw* | A replayed input stream shows a read, a write, a clock read or a spawn during a draw. |
| I-8 | There is no dev mode. Every renderer can perform every effect; a renderer differs from another only in values, and isolation is where it reads and writes, never what it may do. | A subset of behaviour is a toggle that the main bar never exercises, so it rots. | goals.md, *On there being no dev renderer*, *On what the primitive is* | An allow-list of verbs or effects per renderer, or a branch on whether a renderer is main. |
| I-9 | A click carries an address, and the address alone decides which renderer handles it. | Routing by state needs a table that has to survive restarts and can disagree with the frame. | goals.md, *On the shape* | Delivering a click needs any lookup beyond the renderer name in the click. |
| I-10 | No absolute path is stored where a renderer's state lives; every path a renderer stores is relative to its home. | A copied history must not be able to write the user's files. | goals.md, *On paths* | An absolute path in a renderer's stored state or undo history. |
| I-11 | Claude Code's request is answered with the frame of the renderer that session uses. | The client gets one answer, and it is the bar the session asked for. | goals.md, *On the shape* | A session's statusline shows another renderer's frame. |
| I-12 | The payload a template reads carries every value it reads, and metrics, activity and session are in it. | A value that reaches a template outside the payload is a second path. | goals.md, *On the payload* | A template reads a fact from anywhere but the payload. |
| I-13 | Nothing is decoded from rendered ANSI. | Decoding output to recover state inverts the pipeline. | goals.md, *On how the goals are built* | Any part reads a Frame back to learn what it said. |
| I-14 | The design is built from generally useful primitives, in data, under the laws. | Primitives with no consumer yet are how later work becomes cheap. | goals.md, *The constraints* | A part exists only to serve one feature, or variability lives in a branch instead of a value. |

## 3. Assumptions

Each must be true for the design to work. Each has a probe or measurement that would show it false, and none has been run yet.

| ID | Assumption | Falsified by |
|---|---|---|
| A-1 | The round trip from the host to a renderer's process costs the statusline little against today's daemon, which draws in the process that answers the client. | The request event's p99 `took`, over a day of real use, is higher than today's by more than 2 ms (a parameter). |
| A-2 | Everything a renderer's config load reads can be gathered by the host before the load and handed in. | The loader, given the host's config bundle, reaches for a file the bundle does not hold. Plugin folders and repository plugins are the likely cases. |
| A-3 | No verb needs to read the world and write it in one atomic step that a guarded write cannot express. | A verb whose correctness depends on a read and a write landing together, where an expected-before guard on the write is not enough. |
| A-4 | launchd can own the host's lifetime through socket activation at the socket path installed clients already dial. | A probe: a user LaunchAgent with a `Sockets` entry at `/tmp/cc-candybar-<uid>/socket` does not start the host on the first connect, or does not restart it after it exits. |
| A-5 | A renderer's output for one input is small enough to cross a socket at animation rate, 30 inputs a second, without lag. | An animating session drops frames, or its inputs queue behind each other in the host. |

## 4. Precedents

From general knowledge of each system; the details are not checked against current documentation.

| System | Host | What it calls | What it teaches here |
|---|---|---|---|
| Chrome | The browser process owns the network, disk, cookies, windows and all OS input. | Sandboxed renderer processes, one per site. Input is routed to the right renderer by frame. A renderer asks for a fetch or a storage write over IPC, and the browser process validates the request before doing it. | One host owns the world. A renderer asks and never acts. The host is the single place requests are validated. The host spawns renderers, never the reverse. |
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
 URL handler ────────┼▶│ Endpoint ─▶ Router ─▶ per-renderer input queue  │
 tmux, files, ───────┘ │ Gather (facts) ─────────────────▲    │          │
 timers                │ Performer ◀── effects ──────────┼────┘          │
                       │ Supervisor ── starts, ends ─────┘               │
                       └──────────────┬──────────────▲───────────────────┘
                                      │ input        │ output
                                      ▼              │ (frames to present,
                              renderer: Events ─▶ Apply ─▶ Draw
                              (each in its own process: main from the host's
                               bundle, a worktree's from its own)
```

There are two kinds of thing and one direction of call. The host calls a renderer with one input at a time and awaits its output. The renderer depends on nothing; the host depends on the renderer interface. The one loop goes renderer, host, world, host, renderer, and the host owns every turn of it. [LAW:one-way-deps] [LAW:effects-at-boundaries]

## 6. Components

The host is one job, the bar's boundary with the world, done by parts that each have one. It holds no renderer logic: no part of it knows what a verb means, what a template says, or what a renderer's state is. [LAW:decomposition]

**Endpoint** (host, prototype)
- **Responsibility:** accepts every connection from outside: the Claude Code client, the URL handler's forwarder, and later the browser listener and webhooks.
- **Inputs and outputs:** client requests with their hints; URL frames. Out: each one as an event for the router, and each request's answer back to its client.

**Router** (host, prototype)
- **Responsibility:** turns each input into an event for the renderer it names, and keeps one queue per renderer.
- **Inputs and outputs:** a request names its renderer by the client's `renderer` hint; a click by the `to/<name>` in its link. Out: one input at a time to each renderer, in arrival order per renderer.

**Gather** (host, production for what exists)
- **Responsibility:** reads the world into one total facts document per session, as Proposal 1 §12 specifies, and runs the sources renderers want.
- **Inputs and outputs:** the locators of the sessions the host has seen, the union of every renderer's wants, file and tmux events, its own periods. Out: a `facts` event for each renderer that holds the session, newest-wins per session.

**Performer** (host, prototype)
- **Responsibility:** parses and validates every effect a renderer returns, performs it, and reports its outcome as an event to that renderer.
- **Inputs and outputs:** effects, in the order their turn returned them. Out: `effect-done` events; for a `launch` with `refreshes`, those sources held pending until the program exits and Gather has re-read them.

**Supervisor** (host, prototype)
- **Responsibility:** starts, restarts and ends renderers, and hands each its start input.
- **Inputs and outputs:** a renderer name and bundle from the router; bundle changes; renderer exits. Out: a running renderer, or a loud failure naming the renderer and its bundle.

**Recorder** (host, prototype)
- **Responsibility:** writes a renderer's input stream to a file when asked, and writes every record a renderer returns to the log.

**Renderer** (prototype for the interface, production for Apply and Draw as they exist)
- **Responsibility:** answers each input with what to present, what to do and what to read.
- **Inputs and outputs:** §7.
- **Inside:** Events → Apply → Draw. Apply is the one writer of the renderer's state; Draw is a pure function of facts, state, config and the instant it was handed.

## 7. Interfaces

### The renderer interface

```ts
// [LAW:one-type-per-behavior] One interface whether the renderer runs in the
// host's process or its own; the transport is a value the supervisor chose.
interface Renderer {
  answer(input: RendererInput): Promise<RendererOutput>;
}

type RendererInput =
  | { kind: "start"; name: RendererName; cause: StartCause; linkKey: LinkKey; stored: StoredState; at: Instant }
  | { kind: "event"; event: Event; at: Instant };

type Event =
  | { kind: "request"; id: RequestId; session: SessionId; hook: ClaudeHookData; hints: ClientHints }
  | { kind: "click"; click: VerifiedClick; arrival: ClickArrival }
  | { kind: "facts"; facts: SessionFacts }
  | { kind: "config"; chain: ChainId; bundle: ConfigBundle }
  | { kind: "effect-done"; of: EffectId; outcome: Outcome<EffectResult> }
  | { kind: "due"; due: Scheduled }
  | { kind: "subscriber"; session: SessionId; surface: Surface; on: boolean }
  | { kind: "retire"; session: SessionId };

interface RendererOutput {
  readonly effects: readonly Effect[];
  // [LAW:one-source-of-truth] Whole, replacing the last: what this renderer's
  // state needs read. The host diffs it; nothing is declared by message.
  readonly wants: Wants;
  // [LAW:nothing-unseen] The turn's own record. A renderer writes no log;
  // the host writes this one.
  readonly record: TurnRecord;
}

interface Wants {
  readonly sources: Readonly<Record<SessionId, readonly SourceDecl[]>>;
}
```

- **Every input gets exactly one output, in order.** The host sends the next input to a renderer only after the last one's output arrived. That serialization is Apply's turn, owned by the host's queue. [LAW:no-ambient-temporal-coupling]
- **A request is answered by a `present` effect.** The renderer's frame for Claude Code's statusline is `present { surface: statusline, request: id }` in that request's output. A request whose output holds no such effect is answered with a failure naming the renderer, never with an empty bar. One mechanism delivers every frame to every surface. [LAW:one-type-per-behavior]
- **Time is handed in.** Every input carries `at`. A renderer that wants to be woken asks with a `schedule` effect and is woken by a `due` event. Animation is a renderer scheduling its next frame.
- **Wants replace `follow`, `declare` and `key`.** The host knows every session's locator from the requests it receives itself. A source's key is evaluated by the renderer over its own store, as today, and its digest travels in `wants`. That is still a loop from facts to keys to reads to facts, but it is the one loop and the host owns it, the way the Elm runtime owns subscriptions. A renderer never sends a want; it states them in its answer.
- **Config arrives as a bundle.** The host resolves the chain for a session's directories, reads every file the load needs, and hands the texts in as a `config` event, again whenever a watched file changes. The renderer parses, validates and compiles them. It reads no file. Error messages name each file by its path, which arrives as display text and is never stored. [LAW:effects-at-boundaries]
- **Stored state arrives at start.** Settings history, session picks and every other durable store are read by the host from the renderer's home and handed in with `start`. They change only by `store` effects.
- **Clicks arrive verified.** The host checks a link's signature over its opaque tail with that renderer's link key before routing it, so an unsigned URL never reaches a renderer. The renderer decides what the click means. [LAW:single-enforcer]

### Effects

```ts
type Effect =
  | { kind: "present"; session: SessionId; surface: Surface; frame: Frame; request?: RequestId }
  | { kind: "write-file"; path: HomePath; text: string | null; expect: Expected }
  | { kind: "store"; store: StoreName; key: string; value: JsonValue | null }
  | { kind: "type-slash"; session: SessionId; line: SlashLine }
  | { kind: "launch"; session: SessionId; program: Program; refreshes: readonly SourceId[] }
  | { kind: "restart-claude"; session: SessionId }
  | { kind: "probe"; session: SessionId; check: CheckId }
  | { kind: "surface"; session: SessionId; surface: Surface; on: boolean }
  | { kind: "approve-repo"; dir: RepoDir; answer: boolean }
  | { kind: "open"; url: string }
  | { kind: "copy"; text: string }
  | { kind: "schedule"; at: Instant; due: Scheduled };

type Expected = { kind: "text"; text: string } | { kind: "absent" };
```

- **Every effect names its operation.** There is no `tmux { args }` and no free-form launch spec, because a raw command admits every command, and the safety of a slash line or a run link could not be expressed in it. [LAW:types-are-the-program]
- **Writes are guarded.** `write-file` lands only if the file still reads as `expect`; otherwise it fails with what the file holds now. That is how undo refuses a target someone else changed, and how save cannot overwrite a hand edit made after its config was read.
- **`type-slash` carries its own check.** The performer reads the pane and refuses unless it shows Claude Code's bare input box, then stashes, pastes and submits in one tmux call. The check and the act are one effect, so nothing can come between them.
- **`launch` carries its refreshes.** Gather holds each named source pending from the launch until the program exits and the source has been re-read. The host owns that order.
- **Repository trust is the host's.** Which repositories may run commands is a security decision, so the host keeps the answers and resolves config chains by them; a click that answers the question returns `approve-repo`. [LAW:single-enforcer]
- **The performer is the one checkpoint for effects.** It parses each effect from the wire, refuses any path outside the renderer's home and any slash line that does not parse, and reports a refusal as a failed `effect-done`. A refusal is a fact the renderer holds for the bar like any other failed effect. Every renderer may ask for every effect; validation is about where, never what. [LAW:parse-dont-validate]

## 8. Addressing and lifetime

- **The host** listens at the socket installed clients already dial, `/tmp/cc-candybar-<uid>/socket`. launchd starts it on the first connect and restarts it when it exits (A-4). No client and no renderer ever starts the host, so the host always runs the installed bundle, and a worktree can never put its code under the main bar. If A-4 fails, the client starts the host from the bundle path the install recorded, never from the bundle beside itself.
- **A renderer** is named by the client's `renderer` hint: its name from `CC_CANDYBAR_NAME`, absent meaning `main`, and its bundle, the client's own. A session is moved to another renderer by starting Claude Code with other values, which the rulings accept.
- **Every renderer runs in its own process,** `main` included. The supervisor starts one from the named bundle on that name's first input, `main` from the host's own bundle, and restarts it after a crash or a bundle change on the next input. A name held by one bundle refuses a second bundle loudly until the first is retired. The in-process transport exists for tests, which build a renderer and a host in one process.
- **A home is a function of the name alone.** `main` is today's XDG layout; any other name is `<state root>/renderers/<name>/` with `state/`, `config/` and `cache/` beneath it. Isolation is one value. [LAW:one-source-of-truth]
- **The forwarder dials one socket,** the host's. It parses no name and computes no path; the host routes. That makes Proposal 1's name-to-socket rule in Swift and its mirror in `check-protocol` unnecessary.
- **Links keep `to/<name>`.** The name is the address, and the host routes by it. The tmux row's constant binding and `@cc-candybar-renderer` option stand as Proposal 1 §18 specifies; the renderer resolves a range id against its own frame memory, which is part of its state.

## 9. Error handling

| Condition | What the user sees | Who reports it |
|---|---|---|
| A renderer crashed or its bundle changed | The next input restarts it from stored state; that session's bar carries a `⚠` naming the restart for the usual hold | The supervisor, through the start input's `cause` |
| A renderer's bundle is gone | The request is answered with a failure naming the renderer and the missing bundle, which the client prints | The supervisor |
| An effect refused or failed | The bar's `⚠` carries the reason, held as a click's error is held today | The performer, through `effect-done` |
| A click names a renderer the host does not know | A macOS notification naming it, because there is no bar to draw it on | The router |
| A click on a stale frame | A held `⚠`: the link belongs to an older frame | The renderer that owns the frame |
| A source failed | That source's cell draws its fallback; the `⚠` carries Gather's diagnostic | Gather, through `facts.diagnostics` |
| The host is down | The client's existing connect failure; launchd restarts the host | The client and launchd |
| A request's turn presented no statusline frame | A failure naming the renderer | The router |

Nothing falls back to another renderer or another data source, and nothing draws a value where a fact is missing. [LAW:no-silent-failure]

## 10. Observability

One wide event per unit of work, under one correlation id:

- **The host,** per input delivered: renderer, session, input kind, queue wait, the renderer's `took`, the effects returned and each outcome, and the facts `seq` the renderer last held. Per facts push and per source run, as Proposal 1 §21. Per renderer start and end, with its bundle.
- **A renderer** writes nothing. Its turn record (the event kind, the state revision it left, what it drew and what it settled for) is part of its output, and the host writes it beside the input's event.

A renderer's panel is the same whether it is main or a worktree's. Watching one is the whole of "dev mode". [LAW:nothing-unseen]

## 11. Testing

- **The seam test.** The recorder captures a renderer's whole input stream. Replaying it into a fresh renderer gives byte-identical outputs, frames, effects, wants and records, with zero filesystem reads, zero clock reads and zero spawned processes over the entire run, not only over draws. This is the acceptance test for the split, and it holds forever. [LAW:verifiable-goals]
- **Renderer tests** feed inputs and assert outputs. They need no mocks, because the renderer has nothing to mock.
- **Host part tests** run each part over fake ports for the world.
- **The transport contract test.** The in-process and socket transports give identical outputs for one recorded stream.
- **The latency check** measures A-1 and A-5 from the host's own event, not from a benchmark.

## 12. Implementation plan

Each step leaves a working bar, and every step is inside one process, over the in-process transport, until step 6.

1. **The seam in process.** Today's daemon divides into a host side and a renderer side behind `answer(input)`, with only the main renderer. *Done when* every request and click passes through `answer` and the renderer side's I/O counters read zero over a recorded stream.
2. **Effects returned, not performed.** Every verb and timer returns effects; the performer runs them. *Done when* no renderer-side code calls a write, a launch, tmux or a clock.
3. **Config and stored state handed in.** The host reads the config chain and the home's stores and hands them in. *Done when* the renderer side opens no file (A-2).
4. **Wants.** Gather runs sources from the renderers' wants; `declare` and `key` are deleted. *Done when* two configs that declare one source share one run, and a key change starts a new run with no pending flash.
5. **The recorder and the replay test** (§11).
6. **Renderers out of process.** The supervisor runs every renderer, `main` included, from its bundle through the socket transport. *Done when* a worktree renderer draws one session while main draws the others, no transcript is read twice (I-1, I-2), and A-1 holds.
7. **The host under launchd** (A-4), once the probe passes.
8. **Clicks routed by the host.** The forwarder dials the host; the host verifies and routes. *Done when* a click on a worktree's link changes only that renderer, and a click naming an unknown renderer shows a notification.

## 13. Architecture decision records

| ID | Decision | Alternatives | Rationale | Reversible? | Cost to reverse |
|---|---|---|---|---|---|
| ADR-1 | One host owns every input and every effect. | Proposal 1: Gather reads, the renderer performs effects. | Proposal 1 reads the world on one side and writes it on the other, so no one orders an effect against the observation of its result, and the loop closes only through messages up to Gather. | Costly | Every effect path and the wire. |
| ADR-2 | A renderer only answers; wants are part of its answer. | Proposal 1's `follow`, `declare` and `key` messages. | Upward messages are a second loop, `key` is a data cycle, and the design invited a new upward message for each new need. | Moderate | One wire. |
| ADR-3 | launchd owns the host's lifetime. | The client spawns the host from its own bundle; renderers spawn Gather (Proposal 1). | A process spawned by its dependants runs whichever bundle got there first; a worktree's could serve the main bar. | Cheap | One install step and one spawn path. |
| ADR-4 | Every renderer, main included, runs in its own process. | The main renderer inside the host's process, which pays no hop. | The rulings put Events → Apply → Draw in a process of its own; a renderer crash cannot take the world boundary down with it, as in Chrome; and main runs the same path as every worktree renderer, so that path is exercised on every tick. The cost is a hop per input (A-1). | Cheap | A transport value; the in-process transport exists for tests. |
| ADR-5 | Effects are typed operations, and writes carry an expected-before guard. | Proposal 1's `tmux { args }`, `launch { spec }` and unguarded `write-config-text`. | A raw command admits every command; an unguarded write overwrites what undo must refuse to. | Moderate | Every effect site. |
| ADR-6 | A home is derived from the name alone. | Proposal 1's name plus root from two variables. | Two values that must agree are two clocks. | Cheap | The path functions. |
| ADR-7 | The forwarder dials only the host. | Proposal 1: the forwarder computes a renderer's socket from the name. | The host routes; the installed forwarder never changes again when naming does. | Cheap | The forwarder. |

## 14. How this stands against the laws

| Law | How it holds | Where it bends |
|---|---|---|
| decomposition | The host's purpose is one sentence, the bar's boundary with the world, and each of its parts has one. A renderer's is "answer each input". | The host holds everything world-facing and is the part most likely to become a god process. Its parts must stay apart, and a part that learns a verb's meaning or a renderer's state has broken the boundary. |
| effects-at-boundaries | The renderer is pure in the full sense: no I/O, no clock, no log. The host is the only edge. | — |
| one-way-deps | Host → renderer, launchd → host. Nothing points up. | — |
| no-ambient-temporal-coupling | The host owns every order: per-renderer input, effects within a turn, launch before refresh, a schedule before its `due`. | — |
| single-enforcer | The performer validates every effect; the host verifies every link and holds repository trust. | — |
| types-are-the-program | Effects are typed operations; writes are guarded; inputs and outputs are closed unions. | The wire loses types, so each side parses what it receives. That is one parser per direction at the one boundary, not a duplicate check. |
| one-source-of-truth | Facts live in Gather, renderer state in its renderer, durable state in the home's files, written only by effects. | `wants` makes a loop from facts to keys to reads. It is the one loop and has one owner; it is not a second source. |
| dataflow-not-control-flow | Main and a worktree renderer differ by name and bundle, values the supervisor is handed, never a branch. | — |
| nothing-unseen | Every input, turn and effect lands on one event; the renderer's record is data. | — |
| no-silent-failure | Stale clicks, restarts, refused effects and missing bundles are all loud. | — |
| verifiable-goals | The replay test, the latency checks, and every falsifier in §2 and §3. | — |

## 15. What stands from Proposal 1

**Stands:** §1, total facts with pending as a value, with its seam test widened in §11; §4's split of the hook into instantaneous fields and a locator, except that the host keeps the locator itself; §6's home, refined by ADR-6; §8, recording as a primitive, which now records renderer inputs; §12, `SessionFacts`; §17's derived paths and `HomePath`, under ADR-6, without the per-name socket, which ADR-7 removes; §18's link grammar, constant tmux binding and range ids.

**Replaced:** §2 (Gather does only facts), §3 (Gather addressed by version), §5's performer, §7 (how a session reaches a renderer), §9's table, §10 (order of work), §11 (its questions, answered by this draft or open in §17 here), §13 (the facts wire, deleted), §14 (the facts source, now the renderer transport), §15 (Gather's process, now the host's), §16's effects, §19's `follow`, §20, §21 and §22.

**Proposal 1's own claims this corrects:** a renderer was "a pure pipeline" while it performed every effect; every path a renderer used was "a pure function of the home" while config layers live in repositories; facts "flow one way" while the renderer sent the locator, declarations and keys up.

## 16. Backlog impact

The open tickets this changes, under `candybar-skeleton-wj0c`:

- **`yb3`** (in review) and **`zhh`** stand unchanged. A hook-free facts document and Gather triggering its own reads are both part of this shape.
- **`r00`** (the Facts interface) becomes step 1: the renderer interface in process.
- **`0bg`** (Apply) becomes step 2. Apply stays the renderer's one writer; the performer moves to the host.
- **`xos`** (Draw pure) stands.
- **`52g`** (Deliver) becomes the `present` effect.
- **`v6k`** (Click) becomes step 8 plus the click event.
- **`jkw`** (Gather out of process) is replaced by step 6, a renderer out of process. Gather never leaves the host.

`candybar-gather-renderer-76bb`'s 68 open children were written against Proposal 1 and need a regroom once this is accepted. Nothing is regroomed before then.

## 17. Open issues

| Item | Owner | Due |
|---|---|---|
| A-1 to A-5 are unmeasured. A-2 and A-4 decide steps 3 and 7; A-1 decides whether step 6 ships. | — | Before steps 3, 6 and 7 |
| How the host's own code is iterated from a worktree. The host always runs the installed bundle. | — | — |
| Whether a renderer's unsaved state (open menus, armed confirms) should survive its restart. Today a daemon restart loses it. | — | — |
| How each renderer's memory is bounded once a worktree renderer is its own process. | — | Before step 6 |
