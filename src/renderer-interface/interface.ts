// The renderer interface (docs/design/host-and-renderer.md §7): the host hands
// a renderer inputs, and the renderer answers each with the effects it asks
// the host to perform, what it needs read, and the record of its turn.
//
// [LAW:one-way-deps] The host depends on this module and the renderer
// implements it. It sits in the shared zone (scripts/import-zones.mjs), so what
// it imports is the vocabulary both sides speak (the session context, the
// world state, the frame, the instant) and the failure shape with the
// converter a renderer reports through (`rendererFailureOf`), so a thrown value
// crosses as the same data whichever side threw it. The host's own converter
// (`failureOf`) classifies the same way and renders the detail differently:
// it keeps the native stack, and the renderer's answer leaves it out.
// The renderer's portion of the stats reply is a module below both
// (./renderer-stats), which the host's stats snapshot embeds.
// [LAW:types-are-the-program] The unions hold only the arms something produces
// and something consumes; each later step adds its own.

import type { SessionId } from "../daemon/foundations/session-id";
import type { AdmittedClick } from "../click/wire";
import {
  rendererFailureOf,
  type Failure,
} from "../daemon/foundations/verb-error";
import type { ClickArrival } from "./click-arrival";
import type { Run } from "../facts/source-identity";
import type { SourceId, WorldState } from "../facts/world-state";
import type { WireFrame } from "../render/frame";
import type { Awaiting } from "../facts/awaited";
import type { Readings, Tick } from "../utils/instant";
import type { Field } from "../utils/logfmt";
import type { LogLine } from "../utils/logger";
import type { DaemonEvent } from "../utils/event-hold";
import type { CheckedRenderRequest, SessionContext } from "./request-context";
import type { RendererStats } from "./renderer-stats";
import type {
  DebugSnapshot,
  DebugWhat,
} from "../daemon/foundations/debug-types";
import type { Crosses } from "./crosses";
import type { Lane, LaneSwitches } from "../config/lanes";
import type { Delivered } from "../click/gesture";
import type { Change } from "../config/config-changes";
import type { TmuxHint } from "../tmux-hint";
import type { SlashLine } from "../claude-input/slash-line";
import type { RepoAnswer } from "../config/loader/repo-gate";
import type { RenderOrigin } from "../config-hint";
import type { LayerRole } from "../config/layer-role";
import type { ConfigSnapshot } from "../config/config-snapshot";
import type { Locations } from "../config/loader/chain-places";
import type { StoredState, StoreWrite } from "./stored-state";
import type { RegionalSettings } from "../utils/region.js";

// [LAW:one-source-of-truth] Every renderer starts from locations the host
// resolved and the stored values it holds at the moment the renderer starts.
export interface RendererBoot {
  readonly stored: StoredState;
  readonly locations: Locations;
  readonly region: RegionalSettings;
  readonly memoryLimitBytes: number;
}

export type RendererConstruction = RendererDiagnostics &
  (
    | { readonly kind: "built"; readonly renderer: Renderer }
    | { readonly kind: "refused"; readonly failure: Failure }
  );

// Which request a statusline frame answers: the host's count of the requests
// of every kind it accepted, in arrival order, so renders' ids have gaps.
declare const REQUEST_ID: unique symbol;
export type RequestId = number & { readonly [REQUEST_ID]: true };

// An effect's name, minted by the renderer that returned it, which its
// `effect-done` carries back.
declare const EFFECT_ID: unique symbol;
export type EffectId = number & { readonly [EFFECT_ID]: true };

// [LAW:one-type-per-behavior] The in-process and child-process transports
// both take the same ordinary input and answer with the same data.
export interface Renderer {
  answer(input: EventInput): Promise<RendererOutput>;
}

// A completed answer whose transport timing failed has no duration.
export type Timed<O> = O & { readonly turnMs: number | null };

export interface TimedRenderer {
  answer(input: EventInput): Promise<Timed<RendererOutput>>;
}

// [LAW:single-enforcer] The one measure of a turn, around the renderer's
// answer, on the monotonic clock of the process it runs in.
export function timed(
  renderer: Renderer,
  monotonic: () => number,
  warn: (message: string) => void,
): TimedRenderer {
  return {
    answer: async (input) => {
      const from = monotonic();
      const output = await renderer.answer(input);
      try {
        return { ...output, turnMs: Math.round(monotonic() - from) };
      } catch (thrown) {
        // [LAW:effects-at-boundaries] Timing is transport telemetry. Its
        // failure leaves the completed renderer answer intact for replay.
        warn(
          `renderer turn timing failed: ${rendererFailureOf(thrown).detail}`,
        );
        return { ...output, turnMs: null };
      }
    },
  };
}

// [LAW:effects-at-boundaries] Every input carries the host's two readings,
// made as its slot in the mailbox comes (`Readings`): the renderer reads no
// clock.
export interface EventInput extends Readings {
  readonly kind: "event";
  readonly event: Event;
}

// [LAW:one-source-of-truth] The same event session is held while the turn
// runs and named in the host's records, even if its worker never answers.
export function sessionOfEvent(event: Event): SessionId | null {
  switch (event.kind) {
    case "context":
    case "request":
      return event.context.hookData.session_id;
    case "world-state":
      return event.worldState.session;
    case "click":
      return event.click.scope === "session" ? event.click.session : null;
    case "retire":
    case "effect-done":
      return event.session;
    case "stats":
    case "debug":
    case "close-journal":
    case "close-views":
    case "start":
    case "config":
    case "viewers":
    case "due":
      return null;
  }
}

// A session's context as its newest request names it, and the world state read
// at that request's keys.
export interface SessionConfig {
  readonly context: CheckedRenderRequest;
  readonly worldState: WorldState;
}

// [LAW:types-are-the-program] A command expects a reply of its own kind.
// A notification carries no command reply.
export type Command =
  | { readonly kind: "stats" }
  | { readonly kind: "debug"; readonly what: DebugWhat }
  | { readonly kind: "close-journal" }
  | { readonly kind: "close-views" };

export type CommandReply =
  | { readonly kind: "stats"; readonly stats: RendererStats }
  | { readonly kind: "debug"; readonly snapshot: DebugSnapshot }
  | { readonly kind: "close-journal" }
  | { readonly kind: "close-views" };

export type ReplyTo<K extends Command["kind"]> = Extract<
  CommandReply,
  { readonly kind: K }
>;

// [LAW:single-enforcer] Both ends classify commands from this exhaustive
// set. A new command kind must be recognized on both sides of the transport.
const COMMAND_KINDS = {
  stats: true,
  debug: true,
  "close-journal": true,
  "close-views": true,
} satisfies Record<Command["kind"], true>;

export function isCommand(event: Event): event is Command {
  return Object.hasOwn(COMMAND_KINDS, event.kind);
}

// [LAW:types-are-the-program] Every input and output of a turn is plain data.
export const INPUTS_CROSS: Crosses<EventInput> = true;
export const OUTPUTS_CROSS: Crosses<RendererOutput> = true;

export type Event = Command | Notification;

export type Notification =
  | {
      // A renderer's start: every live session's context, as `context` hands
      // one in, in one turn, so the start's output names everything the
      // renderer serves and the host releases nothing it still holds for one.
      readonly kind: "start";
      // Who watches each session's frames as the start is made, taken
      // before the sessions are opened: a watched session's feed holds its
      // view before the view opens.
      readonly viewers: Viewers;
      readonly sessions: readonly SessionConfig[];
      // The host's current shared snapshots, once per origin. Retained
      // origins can outlive their last session and reopen their cached state.
      readonly configs: ReadonlyArray<{
        readonly origin: RenderOrigin;
        readonly config: ConfigSnapshot;
        // A committed cache entry: reconstruct from this previously selected
        // observed input, or from the current observation offered above.
        readonly retained?: "current" | ConfigSnapshot;
      }>;
    }
  | {
      // A request's opening turn, delivered ahead of it: the session's
      // context as its newest request names it. Its turn opens the session's
      // view, so the output names what the view reads before the request
      // waits on it. It carries no config: that is its origin's, which the
      // renderer subscribes (`Subscriptions.configs`).
      readonly kind: "context";
      readonly context: CheckedRenderRequest;
      // [LAW:one-source-of-truth] The world state read at this context's own
      // keys: a session's context and its world state reach the renderer as
      // one value, so a renderer never holds a context beside a document read
      // at another request's keys.
      readonly worldState: WorldState;
    }
  | {
      // [LAW:one-source-of-truth] What discovery found at `origin`, which the
      // renderer's subscriptions name: a fact about the origin, shared by
      // every session there. Handed in when the origin is first named, in the
      // slot of the turn that named it, and again whenever it moves.
      readonly kind: "config";
      readonly origin: RenderOrigin;
      readonly config: ConfigSnapshot;
    }
  | {
      // A request of a session whose `context` came before it, delivered once
      // its wait on the session's world state has ended in the host: the
      // turn draws at once, from the world state the renderer holds.
      readonly kind: "request";
      readonly id: RequestId;
      readonly context: CheckedRenderRequest;
    }
  | {
      // A session's world state moved since the one the renderer holds: read
      // at the keys of the newest `context` the host delivered for it.
      readonly kind: "world-state";
      readonly worldState: WorldState;
    }
  | {
      // The host ended the session: the renderer lets go of what it holds
      // of it, and its document goes however the turn ends, answered or
      // threw, so the host's next record for the session starts again at
      // seq 1.
      readonly kind: "retire";
      readonly session: SessionId;
    }
  | {
      readonly kind: "effect-done";
      // The session of the effect it reports on: none for an act no session
      // asked for.
      readonly session: SessionId | null;
      readonly of: EffectId;
      readonly outcome: EffectOutcome;
    }
  | {
      // A click admitted by the host, with its decoded arguments.
      readonly kind: "click";
      readonly click: AdmittedClick;
      readonly arrival: ClickArrival;
      // A scoped click's context, once the host has heard from its session.
      readonly context: SessionContext | null;
    }
  | {
      // Who watches each session's frames now, whole: a feed opens for a
      // session that gained its first viewer and closes for one that lost
      // its last.
      readonly kind: "viewers";
      readonly viewers: Viewers;
    }
  | {
      // The tick the renderer last declared (`RendererDeclaration.wake`) has
      // come: what is due by the turn's tick runs in it.
      readonly kind: "due";
      // An admitted click postpones only its session's idle close. Omitted
      // by older hosts and direct callers when no click hold is supplied.
      readonly pendingClicks?: readonly SessionId[];
    };

// [LAW:one-source-of-truth] Who watches one session's frames, as the host
// derives it from its own sources: each lane's subscribers and whether any of
// them draws the bar now, and
// whether the session's pane is on a screen.
export interface SessionViewers {
  readonly lanes: Readonly<Partial<Record<Lane, LaneViewers>>>;
  readonly shown: boolean;
  // The host's draw demand revision. A new viewer the host could not hand a
  // frame still needs one when the counts read as they did. The v8 wire name
  // remains `joined`; renderers only compare its value for changes.
  readonly joined: number;
}

// [LAW:one-source-of-truth] What the pane that owns a session's pane lane says
// of its pointer: the gestures its terminal delivers, and the action the
// pointer last stood on (null: none). It lives as long as the owner's
// subscription and is never session state.
export interface PanePointer {
  readonly gestures: readonly Delivered[];
  readonly hover: string | null;
}

export interface LaneViewers {
  readonly subscribers: number;
  readonly drawing: boolean;
  // Only the pane lane has an owner, and only while one is subscribed.
  readonly pointer?: PanePointer;
}

// Every session someone watches, whole: a session absent has no viewer.
export type Viewers = Readonly<Record<SessionId, SessionViewers>>;

// [LAW:one-source-of-truth] The lanes that follow a session and draw it now:
// the one derivation from its viewers, which the renderer hands the bar to
// and the host's lane edge waits on.
export function followingOf(viewers: SessionViewers | undefined): Set<Lane> {
  const following = new Set<Lane>();
  for (const [lane, seen] of Object.entries(viewers?.lanes ?? {}))
    if (seen.drawing) following.add(lane as Lane);
  return following;
}

export type EffectOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "failed"; readonly reason: string }
  // Refused before it acted: a change to a setting that moved since the
  // renderer read it, so nothing made over that reading can land; or an act
  // the world it acts in would not take (a pane not at its prompt).
  | { readonly kind: "refused"; readonly reason: string }
  // The daemon's close began before it acted, or cut it off: no failure of
  // its own, so no bar holds it.
  | { readonly kind: "closing"; readonly reason: string }
  // An act not performed because its turn's changes did not land: their own
  // outcome says why, so no bar holds it a second time.
  | { readonly kind: "skipped"; readonly reason: string };

// [LAW:one-type-per-behavior] A request's answer and a publication to a
// subscriber are two behaviors, so they have two types: a statusline frame
// returns as the present of the request it answers, and a frame a feed draws
// for a subscriber leaves as `RendererOutput.frames`, which the host publishes.
export interface Present {
  readonly kind: "present";
  readonly id: EffectId;
  readonly session: SessionId;
  readonly surface: "statusline";
  readonly request: RequestId;
  // Read through `parseFrame`: its Infinity crosses as null.
  readonly frame: WireFrame;
  readonly displayedEvents?: readonly DaemonEvent[];
  // [LAW:single-enforcer] What the draw says the frame still owes, about the
  // world state it drew from: the host waits for a later world state to be
  // stamped (`Collector.moved`) while it is owed, and for nothing else.
  readonly awaiting: Awaiting;
}

// [LAW:one-type-per-behavior] Every config write is a `change`: the changes
// that take one file from what the renderer read to what it wrote, which the
// host applies to the file as it stands. A turn's changes land together or
// not at all, and each is settled with that one outcome.
// [LAW:single-enforcer] A config layer is named by its origin and its role in
// that origin's chain, never by a path: which file that is is discovery's to
// say, so a renderer cannot name a file the origin's chain does not hold.
export interface ConfigChange {
  readonly kind: "change";
  readonly id: EffectId;
  readonly session: SessionId;
  readonly target: ChangeTarget;
  readonly changes: readonly Change[];
}

export interface ChangeTarget {
  readonly kind: "layer";
  readonly origin: RenderOrigin;
  readonly role: LayerRole;
}

// A source a run makes stale: its full name, for the run's line, and the
// storage folder its file is in.
export interface RunRefresh {
  readonly name: string;
  readonly folder: string;
}

// [LAW:types-are-the-program] What a click asks done in the
// world, each named by its operation and carrying exactly what that operation
// needs: no free-form command, so the safety of a slash line or a run is the
// type's. An act's session is the bar its failure shows on; a copy or an open
// a click names no session for has none.
export type Act = { readonly id: EffectId } & (
  | {
      readonly kind: "copy";
      readonly session: SessionId | null;
      readonly text: string;
    }
  | {
      // A file opened in the user's editor: which program opens it is the
      // host's.
      readonly kind: "open";
      readonly session: SessionId | null;
      readonly target: string;
    }
  | {
      // [LAW:single-enforcer] Checked and typed in one step: the pane is read
      // and refused unless it shows the bare input box, then the line goes in.
      readonly kind: "type-slash";
      readonly session: SessionId;
      readonly pane: TmuxHint;
      readonly line: SlashLine;
    }
  | {
      // A program the bar drew, run in its session's environment; each source
      // it refreshes reads pending from its start until it has exited and the
      // source is read again.
      readonly kind: "run";
      readonly session: SessionId;
      readonly action: string;
      // [LAW:effects-at-boundaries] The host checks the turn's captured
      // evidence against this declaration before it decodes the arguments.
      readonly declaration: string;
      readonly capture: number;
      readonly cwd: string;
      readonly refreshes: readonly RunRefresh[];
    }
  | {
      // The answer to a repository's question, which lands with the turn's
      // changes: the trust book is the host's. `dir` is the one its signed
      // link asked about, which must still be `origin`'s repository.
      readonly kind: "approve-repo";
      readonly session: SessionId;
      readonly origin: RenderOrigin;
      readonly dir: string;
      readonly answer: RepoAnswer;
    }
);

// An act as its turn asks it, before the renderer names it.
export type ActRequest = Unnamed<Act>;
type Unnamed<A> = A extends unknown ? Omit<A, "id"> : never;

export type Effect = Present | ConfigChange | Act;

// [LAW:nothing-unseen] What a turn learned, in the order it learned it, which
// the host writes beside the input's event.
export type TurnRecord = readonly Field[];

export interface RendererDiagnostics {
  // [LAW:nothing-unseen] Boot and completed answers carry diagnostic lines
  // in order, including typed failures. Silence carries no payload.
  readonly diagnostics?: readonly [LogLine, ...LogLine[]];
}

// [LAW:types-are-the-program] A source the renderer's state needs read for
// one session: a plugin source, at its storage folder, named by the variable
// that reads it; a `shell` or `file` run, named by its digest; or an
// environment variable.
export type Subscription =
  | {
      readonly kind: "plugin";
      readonly source: SourceId;
      readonly folder: string;
    }
  | { readonly kind: "run"; readonly run: Run }
  // A variable an `env` source reads, from the session's environment, which
  // the host holds and hands in as that one variable's value.
  | { readonly kind: "env"; readonly name: string };

// [LAW:types-are-the-program] A committed cache entry's selected input. A
// fallback entry keeps its origin but has no successful authored revision.
export interface ConfigSelection {
  readonly origin: RenderOrigin;
  readonly digest: string | null;
}

// [LAW:one-source-of-truth] Whole, replacing the last: what every session the
// renderer holds needs read and which lanes its settings switch on. A session
// absent from it needs nothing read. An unchanged declaration keeps its identity.
// [LAW:types-are-the-program] Keyed by session, so no session is listed twice,
// and a record, so it crosses a process as it is: a session absent is a key
// absent, never one holding `undefined`, which JSON does not carry.
export interface Subscriptions {
  readonly sources: Readonly<Record<SessionId, readonly Subscription[]>>;
  // Each managed folder declared by a retained config, even between sessions.
  // Its address came from the host's plugin discovery.
  readonly managedFolders: readonly string[];
  // The lanes each session with an open view switches on, as it draws them:
  // the host gates every subscriber by its lane, and reconciles the tmux bar
  // pane of each session from its `pane` switch, in the pane its newest
  // request reports. A session with no view has no switch to read.
  readonly lanes: Readonly<Record<SessionId, LaneSwitches>>;
  // The origins whose config the renderer holds: each live session's, and
  // each a parked event waits on. The host discovers an origin as it is
  // first named, follows its files while it is named, and lets it go when it
  // is not.
  readonly configs: readonly RenderOrigin[];
  readonly configSelections: readonly ConfigSelection[];
}

interface RendererDeclaration extends RendererDiagnostics {
  readonly subscriptions: Subscriptions;
  // [LAW:no-ambient-temporal-coupling] The host keeps one timer to this tick
  // and hands it in as a `due`. It can move while all subscriptions stand.
  readonly wake: Tick | null;
  readonly stored: readonly StoreWrite[];
}

// [LAW:types-are-the-program] A feed's draw has one bar. A handoff stands
// in for it only in Claude Code's statusline. A failed draw carries its
// reason to whichever presentation publishes it.
export type FeedFrame<Body = WireFrame> =
  | {
      readonly kind: "drawn";
      readonly receipt: EffectId;
      readonly bar: Body;
      readonly handoff: Body | null;
      // The bar and its statusline handoff share the draw's diagnostics.
      readonly displayedEvents?: readonly DaemonEvent[];
    }
  | { readonly kind: "failed"; readonly message: string };

// A frame a feed drew, for the session's subscribers.
// [LAW:decomposition] Every frame a feed draws is pushed: whether one changed
// is the host's to judge, per subscriber, against what that one was sent.
export interface PushedFrame {
  readonly session: SessionId;
  // Read through `parseFrame`: Infinity crosses as null.
  readonly frame: FeedFrame;
}

export type TurnFinalizer =
  | StoreWrite["store"]
  | "subscriptions"
  | "wake"
  | "release-subscriptions";

interface FinalizationFailure {
  readonly stage: TurnFinalizer;
  readonly failure: Failure;
}

// [LAW:no-silent-failure] Keep the turn's first failure as its outcome and
// carry every subsequent failed finalizer alongside it.
export interface TurnFailure {
  readonly kind: "threw";
  readonly failure: Failure;
  readonly secondary?: readonly [FinalizationFailure, ...FinalizationFailure[]];
}

// How a turn ended, a turn that threw included: its failure as data, a class
// crossing no process. Either way it carries the record it reached and the
// effects its acts made, so a click that wrote and then failed still lands
// what it wrote.
export type TurnOutcome = {
  readonly record: TurnRecord;
  readonly effects: readonly Effect[];
} & (
  | { readonly kind: "answered"; readonly reply?: CommandReply }
  | TurnFailure
);

// [LAW:no-silent-failure] Every turn answers, so `answer` never rejects. Its
// output names the open views' subscriptions as they stand after it, however
// it ended: an act can land before its turn throws (a click that committed
// and followed its view), and its view is read all the same. Its frames are
// those its feeds drew in it.
// [LAW:one-source-of-truth] Its stored writes are what the turn moved of the
// renderer's stores, which the host's copy takes before any later input: a
// write answers nothing, so it is no effect, and no `effect-done` comes back.
export type RendererOutput = TurnOutcome &
  RendererDeclaration & {
    readonly frames: readonly PushedFrame[];
  };
