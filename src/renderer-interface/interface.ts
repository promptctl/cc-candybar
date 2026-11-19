// The renderer interface (docs/design/host-and-renderer.md §7): the host hands
// a renderer inputs, and the renderer answers each with the effects it asks
// the host to perform, what it needs read, and the record of its turn.
//
// [LAW:one-way-deps] The host depends on this module and the renderer
// implements it; it imports only types, the vocabulary both sides speak: the
// session context, the world state, the frame, the instant.
// [LAW:types-are-the-program] The unions hold only the arms something produces
// and something consumes; each later step adds its own.

import type { SessionId } from "../daemon/foundations/session-id";
import type { AdmittedClick } from "../click/wire";
import type { Failure } from "../daemon/foundations/verb-error";
import type { ClickArrival } from "./click-arrival";
import type { Run } from "../facts/source-identity";
import type { SourceId, WorldState } from "../facts/world-state";
import type { WireFrame } from "../render/frame";
import type { Readings, Tick } from "../utils/instant";
import type { Field } from "../utils/logfmt";
import type { CheckedRenderRequest, SessionContext } from "./request-context";
import type { AdapterPush, AdapterReply } from "./adapter";
import type { Crosses } from "./crosses";
import type { Lane, LaneSwitches } from "../config/lanes";
import type { Change } from "../config/config-changes";
import type { TmuxHint } from "../tmux-hint";
import type { SlashLine } from "../claude-input/slash-line";
import type { RepoAnswer } from "../config/loader/repo-gate";
import type { RenderOrigin } from "../config-hint";
import type { LayerRole } from "../config/layer-role";
import type { ConfigSnapshot } from "../config/config-snapshot";
import type { Locations } from "../config/loader/chain-places";
import type { StoredState, StoreWrite } from "./stored-state";

// [LAW:one-source-of-truth] Every renderer starts from locations the host
// resolved and the stored values it holds at the moment the renderer starts.
export interface RendererBoot {
  readonly stored: StoredState;
  readonly locations: Locations;
  readonly memoryLimitBytes: number;
}

// Which request a statusline frame answers: the host's count of the requests
// of every kind it accepted, in arrival order, so renders' ids have gaps.
declare const REQUEST_ID: unique symbol;
export type RequestId = number & { readonly [REQUEST_ID]: true };

// An effect's name, minted by the renderer that returned it, which its
// `effect-done` carries back.
declare const EFFECT_ID: unique symbol;
export type EffectId = number & { readonly [EFFECT_ID]: true };

// [LAW:one-type-per-behavior] One interface over every transport: in process,
// or lines to the renderer's own process. Each kind of input answers with its
// own output, so an input pays only for what it is.
export interface Answering<E, A> {
  answer(input: EventInput): Promise<E>;
  answer(input: AdapterInput): Promise<A>;
}

// What a renderer implements: every input answered by its output.
export type Renderer = Answering<RendererOutput, AdapterOutput>;

// An output as its transport hands it to the host, with how long the turn
// took, measured around `answer` on the clock of the process it ran in: the
// renderer reads none, and the host tells the hop's cost from the turn's.
export type Timed<O> = O & { readonly turnMs: number };

// What the host holds of a renderer: its answers, each timed by its transport.
export type TimedRenderer = Answering<
  Timed<RendererOutput>,
  Timed<AdapterOutput>
>;

export type RendererInput = EventInput | AdapterInput;

// [LAW:single-enforcer] The one dispatch from an input to the answer of its
// kind, which every renderer and every transport is built by. Each arm is
// typed by its own input and output, so an arm answering the other kind's
// output fails the build, which an overload's body does not.
export function rendererOf<E, A>(arms: {
  readonly event: (input: EventInput) => Promise<E>;
  readonly adapter: (input: AdapterInput) => Promise<A>;
}): Answering<E, A> {
  function answer(input: EventInput): Promise<E>;
  function answer(input: AdapterInput): Promise<A>;
  function answer(input: RendererInput): Promise<E | A> {
    return input.kind === "event" ? arms.event(input) : arms.adapter(input);
  }
  return { answer };
}

// [LAW:single-enforcer] The one measure of a turn, around the renderer's
// `answer`, on the monotonic clock of the process it runs in.
export function timed(
  renderer: Renderer,
  monotonic: () => number,
): TimedRenderer {
  const time = async <O>(answer: () => Promise<O>): Promise<Timed<O>> => {
    const from = monotonic();
    const output = await answer();
    return { ...output, turnMs: Math.round(monotonic() - from) };
  };
  return rendererOf({
    event: (input) => time(() => renderer.answer(input)),
    adapter: (input) => time(() => renderer.answer(input)),
  });
}

// [LAW:effects-at-boundaries] Every input carries the host's two readings,
// made as its slot in the mailbox comes (`Readings`): the renderer reads no
// clock.
export interface EventInput extends Readings {
  readonly kind: "event";
  readonly event: Event;
}

// A session's context as its newest request names it, and the world state read
// at that request's keys.
export interface SessionConfig {
  readonly context: CheckedRenderRequest;
  readonly worldState: WorldState;
}

// [LAW:effects-at-boundaries] exception: a reach of the host's into the
// renderer that is not yet an event, listed in the adapter
// (src/renderer-interface/adapter.ts). A push opens no view and names no
// session's subscriptions, so it carries none of an event's turn: its output
// is its reply alone.
export interface AdapterInput extends Readings {
  readonly kind: "adapter";
  readonly push: AdapterPush;
}

// [LAW:no-silent-failure] A push's turn answers its reply, of its push's own
// kind, or how it threw, as data; and either way what the renderer needs read
// and when it next wants a turn, as they stand after it: a push moves state
// too (a close ends the views).
export type AdapterOutput = (
  | { readonly kind: "replied"; readonly reply: AdapterReply }
  | { readonly kind: "threw"; readonly failure: Failure }
) & {
  readonly subscriptions: Subscriptions;
  readonly stored: readonly StoreWrite[];
};

// [LAW:types-are-the-program] Every input and output of a turn is plain data:
// the build fails on one a process could not carry.
export const INPUTS_CROSS: Crosses<RendererInput> = true;
export const OUTPUTS_CROSS: Crosses<RendererOutput | AdapterOutput> = true;

export type Event =
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
      // The tick the renderer last declared (`Subscriptions.wake`) has
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
  // Where the latest of its subscribers came among every subscriber the host
  // has taken: one that joins is owed a frame even when the counts read as
  // they did, as when one leaves and another takes its place.
  readonly joined: number;
}

export interface LaneViewers {
  readonly subscribers: number;
  readonly drawing: boolean;
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

// [LAW:one-type-per-behavior] Every frame reaches its surface by `present`;
// the statusline's arm carries the request it answers.
export interface Present {
  readonly kind: "present";
  readonly id: EffectId;
  readonly session: SessionId;
  readonly surface: "statusline";
  readonly request: RequestId;
  // Read through `parseFrame`: its Infinity crosses as null.
  readonly frame: WireFrame;
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

// [LAW:one-source-of-truth] Whole, replacing the last: what every session the
// renderer holds needs read, which lanes its settings switch on, and when the
// renderer next wants a turn. The host diffs it; nothing is declared by
// message, so nothing has to remember what it asked. A session absent from it
// needs nothing read.
// [LAW:types-are-the-program] Keyed by session, so no session is listed twice,
// and a record, so it crosses a process as it is: a session absent is a key
// absent, never one holding `undefined`, which JSON does not carry.
export interface Subscriptions {
  readonly sources: Readonly<Record<SessionId, readonly Subscription[]>>;
  // The lanes each session with an open view switches on, as it draws them:
  // the host gates every subscriber by its lane, and holds the tmux status
  // line row of each session whose switch is on, in the pane its newest
  // request reports. A session with no view has no switch to read.
  readonly lanes: Readonly<Record<SessionId, LaneSwitches>>;
  // The origins whose config the renderer holds: each live session's, and
  // each a parked event waits on. The host discovers an origin as it is
  // first named, follows its files while it is named, and lets it go when it
  // is not.
  readonly configs: readonly RenderOrigin[];
  // [LAW:no-ambient-temporal-coupling] The tick the renderer next wants a
  // turn at, derived from its own state as each turn ends: the host keeps one
  // timer to it and hands it in as a `due`. Null while nothing is due.
  readonly wake: Tick | null;
}

// [LAW:types-are-the-program] A feed's draw has one bar. A handoff stands
// in for it only in Claude Code's statusline. A failed draw carries its
// reason to whichever presentation publishes it.
export type FeedFrame<Body = WireFrame> =
  | {
      readonly kind: "drawn";
      readonly bar: Body;
      readonly handoff: Body | null;
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

// How a turn ended, a turn that threw included: its failure as data, a class
// crossing no process. Either way it carries the record it reached and the
// effects its acts made, so a click that wrote and then failed still lands
// what it wrote.
export type TurnOutcome = {
  readonly record: TurnRecord;
  readonly effects: readonly Effect[];
} & (
  | { readonly kind: "answered" }
  | { readonly kind: "threw"; readonly failure: Failure }
);

// [LAW:no-silent-failure] Every turn answers, so `answer` never rejects. Its
// output names the open views' subscriptions as they stand after it, however
// it ended: an act can land before its turn throws (a click that committed
// and followed its view), and its view is read all the same. Its frames are
// those its feeds drew in it.
// [LAW:one-source-of-truth] Its stored writes are what the turn moved of the
// renderer's stores, which the host's copy takes before any later input: a
// write answers nothing, so it is no effect, and no `effect-done` comes back.
export type RendererOutput = TurnOutcome & {
  readonly subscriptions: Subscriptions;
  readonly frames: readonly PushedFrame[];
  readonly stored: readonly StoreWrite[];
};
