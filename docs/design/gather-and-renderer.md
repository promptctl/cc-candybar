# Proposal 1: Gather and Renderer

The daemon becomes two kinds of process. **Gather** is one process per user that reads the world and publishes, per session, one total document of facts. A **Renderer** is any number of identical processes, each a pure pipeline from facts, events and config to a drawn bar, each addressed by a name, each owning its own surfaces and its own state. A Claude Code session reaches a renderer; a renderer reaches Gather; a click reaches the renderer that drew it, by name, with nothing in between. Running a session's bar off a worktree is then not a feature: it is a second renderer with a different bundle and a different home, and it costs the machine one more drawing process and no more reading.

The drafts in `docs/design/` get most of this right. This proposal takes their shape and removes three things that make the seams rough: Gather routing clicks, the renderer forwarding hook data up to Gather, and Gather's build being "whichever renderer started it". It adds one thing the goal needs and the drafts leave out: a recorded facts stream as a first-class input to a renderer. Everything below is the architecture I would defend; where it departs from the drafts or from something said in a session, it says so. Part I is the shape; Part II (§12 onward) sets each seam to the detail a ticket can be pulled against, with every chosen value named as a parameter.

## 1. The seam is facts, and the facts are total

The joint between the two halves is the one the goal names: what is true about a session, versus how it is drawn. Gather owns the first and nothing of the second. [LAW:decomposition]

`SessionFacts` is one plain JSON document per session: every built-in fact (session, metrics, activity, context, git, PR, today's sums, usage speed, tmux visibility), every declared `shell` and `file` source's reading, and Gather's own diagnostics for that session. It is total: every field always exists, and a fact that is not yet known is a typed `pending` value, never a missing key and never an identity-compared sentinel. A renderer that has a document can draw; a renderer that has no document draws the all-pending bar. There is no "wants" negotiation, no closure of which fields a config reads, and the code that computes one today (`wantsOf`, `buildNeededPrefixes`, `sourcesRead`, the `closure` parameters) is deleted. The measured cost of totality is about 150 bytes per payload and 1 ms per built-in, which is the price of having one shape. [LAW:dataflow-not-control-flow] [LAW:types-are-the-program]

Two sources must stop blocking the first bar before totality lands, exactly as the gather draft says: `today` draws pending and lands through its reaction, and the PR fact leaves the first-request wait and gets a concurrency cap and backoff. Without that, totality makes every first bar pay for a scan and a network call that nothing on the bar may read.

**The test that defines the seam.** A renderer given a recorded `SessionFacts` stream and no Gather draws byte-identical bars with zero filesystem reads and zero spawned processes. The counters are armed from the end of load, after the config and link key are read, and cover every draw after it; a read inside a draw is a failure, and there is no allow-list. This is not a nice-to-have; it is the acceptance test for the split, and it is cheap to hold forever because the inventory already has a probe that counts disk and process calls during draws. [LAW:verifiable-goals]

## 2. Gather does only facts

The drafts give Gather a second job: it is the fixed address the URL handler reaches, and it routes each click down the connection of the renderer named in the link. That is an "and" in Gather's purpose sentence, and it is there for one reason, that a link needs a stable address and the drafts assumed only a long-lived process could be one.

A name is an address. A renderer's name is unique on the machine because the socket it listens on is unique, and the socket path is a pure function of the name (§17: `socket` for `main`, whose path installed clients already dial; `<name>.sock` for every other name), in the directory that holds today's socket. The URL handler parses `cc-candybar://to/<name>/…`, computes the socket, and dials it with the rest of the URL untouched. A tmux status range carries a link id, and the tmux session whose row the renderer draws carries the renderer's name as an option the renderer set; the one click binding reads both. Gather never sees a click, never learns a verb, and never holds a table of attached renderers. The attach-id counter that had to survive Gather's restarts, so a stale status line could not match a new link, is gone as Gather's state: the row names its renderer and the link id is one the renderer minted, so the only counter left is the renderer's own (§18), and both facts are the renderer's. [LAW:decomposition] [LAW:one-source-of-truth]

A click on a dead renderer's link fails at `connect`. That is the loud failure the drafts wanted and could not get cleanly: the handler shows a macOS notification naming the renderer, because there is no bar to show it on. A click on a stale frame of a live renderer resolves the link id against that renderer's last drawn frame for that surface and finds nothing or the same link, never a different one. [LAW:no-silent-failure]

Links stay signed by the renderer's own key, verified by the renderer that drew them. The name is not signed and does not need to be: it only chooses which process verifies.

## 3. Gather is addressed by its protocol version

The drafts admit the problem: Gather runs from whichever bundle started it, which may be a worktree's, and a renderer speaking another protocol version is refused loudly. That leaves the live bar's facts in the hands of whatever worktree happened to start first, and makes a contract change a coordination problem across every renderer.

Put the version in the address. Gather listens at `<runtime dir>/cc-candybar/gather.v<N>.sock`, where `N` is the facts protocol's major version, a constant in the bundle. A renderer dials the Gather for its own `N`, and starts one from its own bundle if none is listening, under the same lease and spawn lock that guard a daemon start today. Two bundles with the same `N` share one Gather because they agree on the contract by definition; two bundles with different `N` run two Gathers and never meet. A mismatch is unrepresentable, so there is nothing to refuse. [LAW:types-are-the-program] [LAW:no-ambient-temporal-coupling]

The residual risk is real and should be stated: a worktree that keeps `N` but changes Gather's behaviour can serve wrong facts to the main bar if it starts Gather first. Today's rule that a daemon ends when its bundle changes applies to Gather, so a rebuild ends it and the next renderer restarts it, which bounds the exposure to one build. A worktree changing Gather's behaviour bumps `N` or accepts that bound. The restart itself costs every bar on the machine a beat of pending while the next renderer brings Gather back. That is an annoyance, and the ruling is that an annoyance never buys a branch in the core: there is no "main renderer prefers its own Gather" rule and no pin to the installed build, because each is a mode.

Gather's own lifetime is the lifetime of its last renderer plus an idle grace, so a machine with no bar running has no Gather, and `candybar doctor` reports it as a fact rather than a fault.

## 4. Facts flow one way, and the hook stays in the renderer

The drafts have the renderer forward each request's hook data up to Gather, which lands it back in the facts. That is a back-edge: the renderer's own input makes a round trip to come home.

Split the hook along its real joint. The hook carries two kinds of thing: facts that are instantaneous and arrive with every request (model, cost, context window, the workspace's current directory as of this tick), and a locator that tells anyone where to read more (transcript path, session id, cwd, tmux socket and pane, config directory). The renderer keeps the first kind as its own input, composed into the payload at draw time as today. It sends Gather only the second kind, once, as `follow { session, locator }`, and again only when the locator changes. Gather reads the transcript, the repository, the usage files and tmux from the locator and publishes facts. Nothing flows up that did not have to. [LAW:one-way-deps]

The renderer also sends `declare { session, sources }`: the identities of the `shell` and `file` sources its loaded config wants, as digests of what Gather needs to run them (kind, command or path, cwd, parse, normalised policy, and the hash of the current key value). Two renderers whose configs differ only in a default or a template share one run. The renderer evaluates `key` and `depends_on`, which are pure functions of its own store, and sends the key value; Gather runs read and parse, because torn-write settling, dedupe and failure text all need the parsed outcome. This is the gather draft's division and it is right.

On the wire from Gather: `facts { session, facts }` pushed on change, and nothing else. Tmux visibility is a fact about the sessions on a tmux server and travels inside `SessionFacts`, not as a separate message kind.

## 5. A renderer is Events → Apply → Draw

Inside a renderer, three stages and one direction.

**Events** is a queue of plain data. Every source of change puts an event on it and does nothing else: a client request (`request`), a click (`click` with its verb and value and where it arrived from), a timer (`idle-close`, `tick`), a config file watcher (`config-changed` with a path relative to the home), a facts push (`facts`), a surface asking to be turned on or off (`surface-requested`). The union is closed and exhaustive, and a new source of change is a new variant, not a new path. [LAW:dataflow-not-control-flow]

**Apply** is the one writer: the only code that mutates the renderer's state or asks for an effect, and it runs one event at a time in one turn. This is a narrowing of what exists, not a rewrite: `JournalTurns` already serializes clicks and the idle close through one turn, and `journaled` is already the consumer; what changes is that every other writer the code has grown (the render path, the timers, the lane setups) is routed through the same turn as an event, and `journaled`'s inference goes (§16). State is the renderer's whole mutable world: session views, settings and their history, navigation, menu idle, surface setup. Effects are descriptions, not actions: write this config text to this relative path, restart this Claude Code pid, run `pbcopy` with this text, open this URL, send this frame to this surface. One performer at the edge executes them in order and reports each result back as an event, so a failed effect is a fact the next draw can show. `set-state` and `set-config` become pure by construction: they are events, and Apply's handling of them is a state transition plus an effect description. The `journaled` measurement that inferred a surface change from a before-and-after diff goes; the intent arrives as `surface-requested`. [LAW:effects-at-boundaries] [LAW:no-ambient-temporal-coupling]

**Draw** is a pure function from facts, state, config and an instant to a drawn bar. It writes nothing, reads no clock but the instant it was handed, and performs no I/O. Today's draw is already most of this; what the split adds is that nothing it reads is behind a cache that itself reads the disk, because the disk is in another process.

Timers are event sources, not special paths. A surface click that restarts Claude Code does what its button says, in every renderer, because isolation is where a renderer reads and writes, never what it may do. The drafts say this and I agree with it completely: a list of allowed verbs would be a dev-mode toggle wearing a security costume.

Every applied event emits one wide event, with the renderer's name, the session, the event kind, the effects it produced and their outcomes, and the draw it caused, under one correlation id. That is the renderer's instrument panel, and it is the same panel on every renderer. "Dev mode" is a renderer you happen to be looking at the panel of. [LAW:nothing-unseen]

## 6. Isolation is one value

The drafts list a renderer's distinguishing values as five independent things set from four places: name derived from the socket or stated at start, socket from one environment variable, state root from another, config home from a third, bundle from the statusline command's path. Four knobs that must agree are four clocks.

A renderer has one identity: its **home**, a record `{ name, root }`. Every path a renderer uses is a pure function of the home: the socket, the state directory, the config directory, the link key, the browser listener's state file, the log. The main renderer's home is the one whose root maps onto today's XDG layout, so nothing moves for existing users; an isolated renderer's home is a directory with the same layout beneath it. There are two constructors and one type. [LAW:one-source-of-truth] [LAW:types-are-the-program]

No absolute path is stored anywhere a renderer writes. Undo history, `render-origin`, `config-override` and any snapshot hold paths relative to the home's root, so an isolated renderer given a copy of the user's config cannot be made to write the user's config, because the sentence cannot be formed. A renderer's state starts from values, never from a copied history. The bundle is the one value not derived from the home, because it is the code that reads the home; the client spawns the bundle beside it on a daemon miss, as today.

Two verbs exist only to leave the home and should go: `load-config`, which points a session at any absolute path, and the `env` source, which reads the spawning shell's environment and calls it a session fact. `file` and `shell` are the expansion points, and both are reachable from inside a home. [LAW:polishing-by-subtraction]

## 7. A session reaches a renderer by starting with its values

Claude Code is started with the renderer's home in its environment (`CC_CANDYBAR_HOME` and `CC_CANDYBAR_NAME`, §17) and a statusline command pointing at that renderer's bundle; the client derives the socket from the home, dials it, the renderer answers, and nothing selects. A session on a worktree's renderer is a session started that way, and moving a session is restarting Claude Code with other values. The restart is an annoyance, and the ruling is that an annoyance buys no branch in the core: there is no route table, no splice at the socket edge, no session-to-renderer map in anyone's state. The isolated renderer is the primitive, and pointing a session at it is a value the session starts with. [LAW:dataflow-not-control-flow] [LAW:no-mode-explosion]

The dev loop this gives: open a worktree, start its renderer under its own home, start a Claude Code session pointed at it, and watch that bar redraw from the worktree's code. The binary watch ends the worktree's renderer on rebuild and the next request restarts it, so saving a file is the whole iteration. Gather is untouched throughout, because drawing is all that changed. Iterating on the draw without a live session at all is the recording's job, in §8.

## 8. Recording is a primitive

Gather's facts stream for a session is a sequence of `facts` messages with timestamps. Writing that sequence to a file is a recording. A renderer's facts input is a union: `{ kind: "gather", address } | { kind: "recording", path, clock }`. The recording player replays the pushes against a clock the renderer is handed, so a replayed session draws exactly what the live one drew, at any speed, with no Gather, no disk and no network. [LAW:one-type-per-behavior]

This one primitive pays for itself four times. It is the seam test from §1. It is the fixture for every draw test that today boots a daemon, which the layered test plan is trying to stop doing. It is how a bug on someone else's machine becomes reproducible: record ten seconds, attach the file. And it is the source the browser proposal's demo site and prototyping studio are built from (a renderer draws a recording offline into what the page replays), which is why it is here and not there. The recording is also what the facts protocol version guards: a recording names its `N`.

## 9. What stays, what moves, what goes

From the state today's daemon builds, the drafts' table holds and I would not relitigate it: sources, watchers, refresh ledger, plugin storage and the tmux control connection go to Gather; session state, histories, effects, warnings, menu idle, link signer, feeds, surfaces and doctor stores stay in the renderer; the render cache splits, with config, compile and views staying and source registries moving. The honest statement is that today's daemon is already a renderer with a Gather inside it, and the work is mostly drawing a line and moving the reading side across it.

Cut, because each is a second path or a dev-mode toggle in disguise: `journaled`'s inference; `load-config`; the `env` source; direct verb URLs and bare `cc-candybar://<value>` links; the install test URL; the attach-id table and its state file; hook forwarding. Keep, because it is the point: every effect a click can perform, in every renderer.

Memory divides across two Node runtimes, each with its baseline. The renderer's cost is the compile and each session's variable store, which stay per renderer; Gather's cost is transcripts, scans and the usage index, which are now paid once however many renderers run. Measured on today's daemon, Gather's part is the minority of a session's cost, because a session's source values live in the variable store that drawing keeps (§15, Memory).

## 10. Order of work

Each step leaves a working bar, because the transport between the halves is a value and the first transport is in-process.

1. **Facts as a type.** Define `SessionFacts`, total, with `pending` as a value. Make today's daemon build it from its existing providers and compose the payload from it. Delete the wants closure. Land the `today` and PR unblocking first. *Done when* the all-pending bar draws, every built-in is in every payload, and the bar is byte-identical for a config that read everything before.
2. **The seam test.** A facts source union with `recording`. Record a real session; replay it into the daemon with the disk and process counters armed over the draws after load (§1). *Done when* the replay draws identical bytes and both counters read zero.
3. **One home.** The home record and its path functions; relative paths in every store; `load-config` and `env` removed. *Done when* two renderers under two homes run every durable verb and neither home's files mention the other.
4. **Events and Apply.** The closed event union, `JournalTurns` as the one queue, the effect performer; every outside writer routed through the turn; `journaled`'s lane measurement deleted; `FrameMemory` moved out of the draw. *Done when* no writer exists outside Apply and a test proves a frame never draws a half-applied event.
5. **Gather out of process.** The facts transport gains `socket`; Gather listens at its versioned address; a renderer starts one on a miss. *Done when* killing Gather, a renderer, or both, in any order, returns to a working bar with no manual step.
6. **Names on links.** The minter writes `to/<name>`; the handler and the tmux click binding dial by name; a dead renderer shows a notification. *Done when* a click on a worktree renderer's link changes only that renderer and a click on a dead one is visible.

Steps 1 to 4 are the real work and are inside one process. Step 5 is a transport. Step 6 is what the user sees.

## 11. What I would ask you to decide

- **The version-addressed Gather's residual risk** in §3: accept the one-build exposure, or require that only the main renderer's bundle may start a Gather. I recommend accepting it; the alternative is a mode.
- **Two Node baselines.** Decided: Gather is a Node process. A second Node process is unacceptable only if its idle charge passes a tenth of the daemon's limit (102 MB), or if the state both processes would hold passes a tenth of the daemon's charge at 100 sessions. Measured on today's daemon it is about 55 to 65 MB idle, and the state both would hold is about 5% (`pnpm load-gate` for the charge at each population, `scripts/capture-heap.ts`, macOS only, for the heap and the differential between configs). A Rust Gather stays a separate proposal that nothing here waits on.

---

# Part II: the seams, specified

Part I is the shape. This part sets every seam to the point where a ticket can be pulled against it. Where a value had to be chosen (a timeout, a width, a grace), it is chosen here and said to be a parameter, so a later change is a value change and not a design change. Code names are given where the code already has the thing.

## 12. `SessionFacts`

One document per session. Every field exists on every document. A field that is not yet known is a `Reading` in the pending arm; a field that was read and found nothing is `absent`; a field whose read failed carries its reason. The existing structural `Reading<T>` in `src/utils/reading.ts` is already this shape minus the promise; the wire form drops the promise and keeps the discriminator. The identity-compared `PENDING` singleton in `src/utils/outcome.ts` is retired, and every site that compares or defaults on it switches to `kind === "pending"`. Today that is nine files (`grep PENDING src`): the variable store and sources, the payload, the usage store, the render cache, the transcript fold and the autocompact and cache providers, as well as `outcome.ts` itself. A site left on identity would read a deserialised pending as a value and draw a default with a `last_error`. [LAW:types-are-the-program] [LAW:one-source-of-truth]

```ts
type Fact<T> =
  | { kind: "pending"; why: "unread" | "superseded" }
  | { kind: "ok"; value: T; at: Instant }
  | { kind: "absent"; at: Instant }
  | { kind: "failed"; reason: string; failedAt: "read" | "parse"; at: Instant };

interface SessionFacts {
  readonly v: number;                       // facts protocol major, the N in §3
  readonly session: SessionId;
  readonly seq: number;                     // per session, monotonic, Gather's
  readonly builtins: {
    readonly session: Fact<SessionUsage>;   // today's SessionUsageStore session fact
    readonly today: Fact<DaySums>;          // the day Gather is in; the renderer re-cuts at its instant
    readonly speed: Fact<Speed>;
    readonly context: Fact<ContextFacts>;
    readonly metrics: Fact<MetricsFacts>;
    readonly activity: Fact<ActivityFacts>;
    readonly cache: Fact<CacheExpiry>;
    readonly autocompact: Fact<AutoCompact>;
    readonly git: Fact<GitFacts>;           // branch, dirty, ahead/behind, remotes, committedAt
    readonly pr: Fact<PullRequest>;         // its own fact, because its cost is its own
    readonly tmux: Fact<TmuxFacts>;         // session name for the pane, and the server's shown set
    readonly host: Fact<HostFacts>;         // name, user
  };
  readonly sources: Readonly<Record<SourceId, Fact<SourceValue>>>;  // declared shell/file/plugin
  readonly update: Fact<UpdateNotice>;      // the release check; a Gather fact because it reads the network
  readonly diagnostics: readonly FactsDiagnostic[];  // Gather's own faults for this session
}
```

What stays out, because it is the renderer's: the hook's instantaneous fields (model, cost, context window, cwd as of the tick), client hints (width, depth, terminal, ssh), settings and their history depth, picks, config facts, `feeds`, `drawing`, the menu. The payload a template reads is `payloadOf(facts, hook, hints, rendererState)` and is composed in the renderer, as today. `block` and `weekly` come from the hook and never cross.

Totality means the wants closure goes: `wantsOf`, `buildNeededPrefixes`, `neededPrefixesByPreset`, `anyPathStartsWith`, `sourcesRead`, `segmentInputPaths`, `gitOptionsFromClosure` (becomes one constant set), the `closure` parameter on `declareLanes`/`refreshPayload`/`readLanes`/`projectPayload`, `prFactOf`'s `readsPr`, and the preset reaction in `openView`. `doctor/data-needs.ts` keeps its own config walk, because it answers a different question (what this config would read), not what Gather runs.

**Size.** A document measured about 2.7 KB with every built-in on. Full documents, not deltas: a delta protocol is a second representation of the same state with its own reconciliation bugs, and 2.7 KB at the rate facts move is nothing. [LAW:one-source-of-truth]

**Totality's bound.** `declare` already exists for sources, so a built-in that later proves too costly to read for every session moves from `builtins` to a declared source: one field moves across the type, both sides recompile, `v` bumps. The reverse move is the same edit. Totality is therefore a default, not a commitment.

## 13. The facts wire

One connection per renderer, dialled by the renderer, held open. Messages are newline-delimited JSON, one object per line, the same framing the client wire uses. The renderer sends:

```ts
type ToGather =
  | { kind: "hello"; v: number; renderer: RendererName }
  | { kind: "follow"; session: SessionId; locator: Locator }
  | { kind: "unfollow"; session: SessionId }
  | { kind: "declare"; session: SessionId; sources: readonly SourceDecl[] }   // the whole set, replacing the last
  | { kind: "key"; session: SessionId; source: SourceId; keyHash: string };
```

Gather sends only `{ kind: "facts"; facts: SessionFacts }`, one per change, and `{ kind: "hello"; v }` once. There is no acknowledgement in either direction. `hello` with a different `v` cannot happen (§3 puts `v` in the socket path) and is treated as a bug: Gather closes the connection and logs it.

**Push semantics.** Gather holds the current document per followed session and pushes the whole document when any field changes by value. Per connection, delivery is newest-wins per session: if the socket is not draining, a newer document for the same session replaces the queued one. `newestWins` in `src/utils/newest-wins.ts` is this behaviour keyed by socket; it gains a key. A renderer that misses intermediate documents has missed nothing, because each document is total. [LAW:dataflow-not-control-flow]

**Follow set.** Gather reads for a session while at least one renderer follows it. The last `unfollow`, or the close of the last following connection, retires the session's readers after the same idle period a view has today. A renderer follows every session it holds a view for and unfollows when the view is retired.

**Reconnect.** The connection's close is the fact that the other side has gone. A renderer whose connection closes marks every built-in of every session `pending(unread)` and redials with the daemon's existing backoff (`spawn.backoff` rules), spawning Gather on a refused connect (§15). It re-sends `follow` and `declare` for every session on reconnect, because Gather's state was its connection's. Gather losing a renderer drops that renderer's follows.

## 14. The facts source

A renderer's facts come from one of three places, and the type says which:

```ts
type FactsSource =
  | { kind: "gather"; socket: string }                 // §13
  | { kind: "recording"; path: string; clock: Timekeeper }
  | { kind: "inprocess"; gather: Gather };             // the same Gather object, no socket
```

`inprocess` is the first transport and stays forever: it is how today's single daemon runs after step 1 and how tests build a renderer over a real Gather with fake ports. The three are one interface, `Facts`, with `follow`, `unfollow`, `declare`, `key` and an `onFacts` subscription, so nothing above it knows which it has. [LAW:one-type-per-behavior]

A **recording** is a file of lines `{ at: Instant, facts: SessionFacts }`, written by Gather when asked (`cc-candybar record <session> <path>`, or a renderer's `--record`), closed by the writer. The player replays each document when the handed clock reaches its `at`, relative to the first. A replay under a held clock is a replay at any speed. A recording names its `v`, and a player handed a recording with another `v` refuses it loudly.

## 15. Gather's process

- **Address.** `<runtime dir>/gather.v<N>.sock`, where `<runtime dir>` is `/tmp/cc-candybar-<uid>/`, the directory the socket lives in today, under the same owner and mode checks `ensureSocketParentSafe` applies now. `N` is `FACTS_PROTOCOL_MAJOR`, one constant in `src/daemon/protocol.ts`, mirrored into `scripts/check-protocol.mjs` and nowhere else; the Rust client and the Swift forwarder never dial Gather.
- **Start.** A renderer that gets a refused connect takes the spawn lock beside the Gather socket (the daemon's own `spawn.lock` rules, keyed by socket) and runs `node <its own bundle> gather`, detached, then dials again with the existing backoff. Two renderers racing start one Gather because the lock is one.
- **Lease.** `<gather socket>.lease`, the daemon's `LeaseRecord` and `arbitrateSocket` reused as they are; `binPath` names the bundle it runs.
- **End.** Gather exits when its bundle changes (the daemon's `binaryWatch`, same 60 s stat), when its memory backstop fires, or when it has had no connected renderer for the idle grace. The grace is 120 s, a parameter. There is no idle shutdown for renderers, as today, and nothing here adds one.
- **Population.** The fork-bomb registry gains Gather as a second population with its own ceiling of 2 (one live, one starting), a parameter. The breaker's `isolated` flag, derived today from whether `CC_CANDYBAR_SOCKET` is set, is derived from the home instead: a renderer is isolated when its name is not `main`. The guarantee it carries stays, because it is the point of the breaker: the main renderer is never denied, however many worktree renderers are registered, and a Gather start is counted against Gather's ceiling alone, never the renderers'. No second flag and no new mode; the same distinction read from the one place that now states identity. [LAW:one-source-of-truth]
- **Memory.** Gather gets its own `limits` with `GATHER_RSS_LIMIT_MB` = 448. The renderer's `RENDERER_RSS_LIMIT_MB` = 896 replaces `DEFAULT_RSS_LIMIT_MB`, its mirror in the Rust client and its pin in `check-protocol` in the one change that starts the renderer as its own process. Gather's is the charge at 100 sessions (167 MB) times the headroom the single daemon's default already carries (about 2.6), rounded up to 64 MB, so a leak trips its backstop while it is still a leak. The renderer's charge (331 MB) times the same headroom gives 861, but its render cache sets the binding rule, and 896 is that rule rounded up to 64 MB. The ceiling falls by about a tenth and not by what moved out, because the cache must hold the 100 sessions: the cache's budget is three quarters of the limit less its 64 MB reserve, and the 100 sessions account for 587 MB of it, so no limit under 868 MB serves them. The cache's per-entry and per-view costs are measured again when a view's contents change, and these two values move with them. Each process writes its own heap snapshots and post-mortems under its own log.

## 16. Events and Apply, concretely

Apply is a narrowing of what exists, not a rewrite. `JournalTurns` already serializes clicks and the idle close through one daemon-wide turn; it becomes the queue, and its consumer, today's `journaled`, becomes Apply. The change is in what is allowed to reach a writer without passing through it, which today is most things and afterwards is nothing.

```ts
type Event =
  | { kind: "request"; session: SessionId; hook: ClaudeHookData; hints: ClientHints; width: number }
  | { kind: "click"; verb: Verb; args: readonly string[]; arrival: ClickArrival; session: SessionId | null }
  | { kind: "facts"; facts: SessionFacts }
  | { kind: "config-changed"; file: HomePath }
  | { kind: "surface-requested"; session: SessionId; surface: Surface; on: boolean }
  | { kind: "menu-idle"; session: SessionId }
  | { kind: "effect-done"; of: EventId; effect: Effect; outcome: Outcome<void> }
  | { kind: "subscriber"; session: SessionId; surface: Surface; on: boolean }
  | { kind: "retire"; session: SessionId };
```

The union is closed; adding a source of change adds an arm, and the exhaustive switch in Apply is the compile error that says where. The writers the survey found outside any handler each become an arm or an effect: the render path's writes of `render-origin` and `client-hints` happen in the `request` arm; `Runs.ended` and `LaneSetups.sync` holding a click error become `effect-done`; `MenuIdle`'s timer emits `menu-idle`; the config watcher emits `config-changed`; `updateWatch.act`, `tmuxStatusLines`' option writes and `managedStorage`'s folder writes are effects Apply emits and the performer runs. The lane-switch measurement in `journaled` is deleted; a surface change is `surface-requested`, produced by the click arm when the verb is a surface switch and by the request arm when a session's declared surfaces change.

**Effects** are data: `write-config-text { file: HomePath; text: string | null }`, `restart-claude { pid }`, `open { url }`, `copy { text }`, `tmux { args }`, `launch { spec }`, `write-store { store; key; value }`. One performer runs them in order and emits `effect-done` for each. `foldEffects`' rule stands: every effect runs, errors are collected, and a session error is held for the bar.

**The ordering invariant,** stated so a test can hold it: a frame drawn for a session reflects every event for that session whose Apply turn completed before the draw began, and no part of an event whose turn has not completed. A click's reply is sent after its turn completes. The feed's wake stays a MobX reaction on the session's revision, which fires inside the turn's action and schedules the draw after it, as today; what changes is that nothing writes the revision outside a turn, so the reaction cannot see a half-applied event.

**Draw writes nothing.** `FrameMemory`, the one thing a draw writes today, moves into Apply's state keyed by `(session, surface)`: the draw returns the frame and its memory as values, and the `request`/feed path stores them. Effect clocks (`SessionEffects`) are read by the draw and advanced by the same path. Then the draw is a function and the recording test in §1 can hold it to zero writes as well as zero I/O.

## 17. The home

```ts
interface RendererHome { readonly name: RendererName; readonly root: string }
type RendererName = string;  // [a-z0-9][a-z0-9-]*, at most 32 characters, a parameter, set well under macOS's 104-byte socket path limit: `/tmp/cc-candybar-<uid>/` plus 32 characters plus `.sock` fits with room for any uid
```

Derived, each a pure function of the home and nothing else: `socket(home)`, `stateDir(home)`, `configDir(home)`, `cacheDir(home)`, `linkKey(home)`, `log(home)`, `leasePath(home)`, `browserListenerFile(home)`. The main renderer's home is `{ name: "main", root: <today's XDG layout> }`, and its derivations return exactly today's paths, including the socket at `/tmp/cc-candybar-<uid>/socket`, so the Rust client, the Swift forwarder and every installed user see no change. Any other home has `root` as a directory with `state/`, `config/`, `cache/` beneath it and its socket at `/tmp/cc-candybar-<uid>/<name>.sock`. So the socket is one function of the name, `socketFile(name)`: `socket` when the name is `main`, `<name>.sock` otherwise. It is spelled in TypeScript and in the Swift forwarder and mirrored in `check-protocol`, because the forwarder computes it from a URL alone; the Rust client dials `main` only. `main` names the main home and no other, and a second home started under that name finds the socket held and is refused by the lease. [LAW:one-source-of-truth]

The home is built once at the process edge (`processWorld` in `src/host.ts` already reads the environment once) from two inputs: `CC_CANDYBAR_HOME=<root>` and `CC_CANDYBAR_NAME=<name>`, absent meaning main. `CC_CANDYBAR_SOCKET`, `XDG_STATE_HOME`, `XDG_CONFIG_HOME` and `XDG_CACHE_HOME` as isolation knobs go; `prepareIsolatedDaemonEnv` sets the two. The fork-bomb registry dir override stays, because it is the breaker's test seam and not an identity. The 1.x pin is respected: a user who set none of the old variables sees nothing change, and `CC_CANDYBAR_SOCKET` is read for one release and warned on, then removed.

**`HomePath`** is a path relative to `root`, a branded string, and the only path type a store may hold. `render-origin`, `config-override`, the `file` changes in settings history, `repo-configs.json`'s keys, the tmux binding's `owner`, and the bar-pane command's socket all become derivations from the home or `HomePath`s under it. The bundle path is the exception Part I §6 names: the lease's `binPath` and the bundle inside the tmux binding's and bar-pane's commands name the running code, which lives in a worktree or the package store and not under any home, so they stay absolute and are the only absolute paths a renderer writes. Snapshots in settings history hold text, never a path to it. `loadConfig`'s `startsWith("/")` check inverts into the type: a verb cannot receive an absolute path. [LAW:parse-dont-validate]

## 18. Names on links and the tmux range

A link is `cc-candybar://to/<name>/dispatch/<signed tail>`; `to/<name>` is the only new grammar, and the two old ones (direct verb, bare copy) are removed with it. `parseHandlerUrl` returns `{ to: RendererName; click: Click }` and nothing without a name parses. The Swift forwarder parses exactly one thing, the name: it rejects any string that fails the name rule in §17 before it forms a path, because the URL is whatever a web page chose to open; it computes the socket with `socketFile` from §17, dials, and writes the whole URL through as it does today. It knows no verb and no home, because the socket directory is fixed, so a change to anything after the name never touches the installed forwarder. `check-protocol` gains the name rule and nothing else.

The tmux status row carries two facts, each written by the renderer that owns the row. The range id is `ccb` + a link id, a base36 number the renderer mints from a counter persisted in the home's state, no digest, so two links never share an id; today's `ccb` plus 12 hex digits of a URL digest can collide. A link keeps its id for as long as the renderer holds its session and surface, so a row tmux has not yet refreshed still resolves after the renderer has drawn newer frames (a row is pushed up to 30 times a second while an effect runs); the table is keyed by the link's content, so a re-draw of the same link reuses its id and per-frame animation mints nothing new, and it is capped at 256 entries per session and surface (a parameter), oldest evicted, and dropped at `retire`. An evicted id finds nothing, as any stale id does. Only the counter outlives the process, so a restarted renderer never reissues an id a stale row still carries. The renderer's name is a user option on the tmux session whose row it draws (`@cc-candybar-renderer`), set and restored beside the status options the daemon already sets on that session. The binding on the tmux server is one `MouseDown1Status` binding whose text is a constant, `cc-candybar://to/#{@cc-candybar-renderer}/range/<server>/#{pane}/#{q:mouse_status_range}`, expanded by tmux at the click as the binding's formats are expanded today; two renderers on one server write the same text and do not fight. The renderer resolves the id against the last frame it drew for that status line (`linkAt`, as today) and a stale id finds nothing. A session whose row the renderer never drew, or whose option was not restored, expands the binding to an empty name; the forwarder's name rule rejects it and the handler's notification says the click named no renderer, so the empty case is the same loud failure as a dead renderer and needs no branch. Nothing about the name is shaped by the range, so the name's length is the socket path's business alone.

The four URL builders outside the minter: the doctor probe mints through it with a `probe` verb; the install test URL is removed; config-authored links are a template function that mints, and a literal `cc-candybar://` in a template is a load error; the tmux `CLICK_URL` is the range form above and is built where the binding is written, which is the renderer that owns the status line.

## 19. The locator and the source digest

```ts
interface Locator {
  readonly transcriptPath: string;   // from the hook
  readonly cwd: string;              // from the hook
  readonly projectDir: string;       // the repo root the renderer resolved
  readonly claudeConfigDir: string;  // from hints
  readonly tmux: TmuxHint | null;    // socket and pane, from hints
}
```

Everything Gather reads for a session it reads from these. The renderer sends `follow` on the first request for a session and again only when the locator changes by value.

A source's identity is `digest(kind, command | [path, readMode], cwd, parserId, normalisedPolicy, keyHash)`. `default`, `default_empty_value` and the key template are out, because they are the renderer's. Two renderers declaring the same digest share one run; a `key` message with a new hash is a new identity and a new run, with the previous reading standing in the document until the new run's reading replaces it, so a key change draws no pending flash. The fact type needs no arm for that: the old `ok` fact is simply not overwritten yet. `shellReader` gains a timeout of 10 s, a parameter; a source past it is `failed(read, "timed out")`. The repo gate stays in the renderer's load, and Gather re-validates absolute paths, regex captures and the shell floor with the loader's own specs on `declare`, as a consistency guard.

## 20. Failure, as seen from the bar

| Condition | What the user sees | Who reports it |
|---|---|---|
| Gather unreachable | Built-ins draw pending; `⚠` carries "facts: gather unreachable, restarting" | The renderer, from its connection state |
| Gather restarted (worktree rebuild) | A beat of pending, then facts return | Nothing; this is the accepted annoyance |
| Renderer down | The client spawns it, as today | The client |
| Click on a dead renderer | macOS notification naming the renderer | The forwarder (`candybar-daemon-health-ajx0.c3x`) |
| Click on a stale frame | Nothing happens, by design | The renderer logs the miss |
| Source failed in Gather | That source's cell draws its fallback; `⚠` carries Gather's diagnostic | Gather, through `facts.diagnostics`, merged by the renderer's `collectDiagnostics` |
| Protocol major mismatch | Cannot occur; two Gathers run | nobody, which is the point |
| Gather crash loop | The breaker refuses the third start in its window; `⚠` says so | The renderer, when its spawn is refused |

Nothing here falls back to a second data source, and nothing draws a value where a fact is missing. [LAW:no-silent-failure]

## 21. The record

One wide event per unit of work, in each process, under one correlation id:

- **Gather**: per facts push: `{ event: "facts", session, seq, changed: [field], bytes, followers, took }`; per source run: `{ event: "source", digest, kind, outcome, took, sharedBy }`; per connection open and close with the renderer's name.
- **Renderer**: today's `requestEvent` line gains `factsSeq` (the `seq` of the document it drew from) and `rendererName`; the click line gains `effects: [{kind, outcome}]` and `revision`; a new `apply` line per event with its kind, the effects it produced and the revision it left.

A recording's lines carry `seq`, so a frame in a bug report can be traced to the document it drew from. The record is the panel; a renderer whose panel you are watching is the whole of "dev mode". [LAW:nothing-unseen]

## 22. The rule every decision was checked against

A design we cannot change later without replacing it is the wrong design. Each decision below names the move that changes it, and every move is local: a value, a function, a type arm, or a version bump. Where this check failed on a first draft, the design was changed, and the two places are marked.

| Decision | The move that changes it later |
|---|---|
| Gather is a separate process | Point the facts source at `inprocess`; the source union is the seam and the in-process arm never leaves (§14) |
| Facts are total | Move a field from `builtins` to a declared source, or back (§12) |
| Full documents, not deltas | A new down-message kind under a bumped `v`; `v` is in the document, the socket path and every recording (§3, §13, §14) |
| Which side a fact lives on | Move the field across the type; the compiler lists every consumer (§12) |
| One Gather per user | The address is one derivation; a renderer pointed elsewhere is a different `socket` value (§14, §15) |
| Newline-JSON on a unix socket | Behind the `Facts` interface; nothing above it knows the framing (§14) |
| What a renderer tells Gather | A new `ToGather` arm; Gather re-receives it on reconnect by the same rule as `follow` (§13) |
| What changes a renderer's state | A new `Event` arm; the exhaustive switch names every place (§16) |
| What an effect may do | A new `Effect` arm and a performer case (§16) |
| The home's layout | The path functions; `main` is one constructor over them (§17) |
| What a renderer needs to find a session | A `Locator` field; `follow` re-sends on change by value (§19) |
| What identifies a source run | A term in the digest (§19) |
| The link grammar after the name | The TS parser only; the forwarder reads the name and passes the tail through. *Changed by this check*: the first draft had the forwarder parse the verb (§18) |
| A renderer's name | At most 32 characters (§17), a bound derived from the socket path limit in that one place. *Changed by this check*: the first draft bound names to six characters so the tmux range id could carry them; the row's tmux option carries the name instead (§17, §18) |
| Every timeout, grace, ceiling and width | A parameter named where it is chosen (§15, §19) |
| Gather's language | The wire is the contract; a Rust Gather speaks the same `v` at the same address (§11) |

## 23. What is still a question

- **The Gather restart beat.** Accepted as an annoyance by ruling. If it turns out to be more than a beat in practice (a cold `today` scan is 1.7 s), the answer is a faster first scan, not a mode.
